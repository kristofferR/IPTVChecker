import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChannelResult,
  ScanConfig,
  ScanErrorPayload,
  ScanEvent,
  ScanProgress,
  ScanSummary,
} from "../lib/types";
import { cancelScan, pauseScan, resetScan, resumeScan, startScan } from "../lib/tauri";
import { logger } from "../lib/logger";
import {
  pendingScanErrorMessageForRun,
  runScopedScanErrorMessage,
} from "../lib/scanErrorEvents";
import {
  applyResultBatch,
  isRunScopedEventForActiveRun,
} from "./useScan.helpers";

export type ScanState = "idle" | "scanning" | "paused" | "complete" | "cancelled";
interface ScanTelemetry {
  throughputChannelsPerSecond: number | null;
  etaSeconds: number | null;
}

const EMPTY_TELEMETRY: ScanTelemetry = {
  throughputChannelsPerSecond: null,
  etaSeconds: null,
};

interface RunClockState {
  runId: string;
  startedAtMs: number;
  pausedAtMs: number | null;
  accumulatedPausedMs: number;
}

export function useScan() {
  const [results, setResults] = useState<(ChannelResult | null)[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<ScanTelemetry>(EMPTY_TELEMETRY);

  // Batch incoming results with requestAnimationFrame
  const pendingResults = useRef<ChannelResult[]>([]);
  const rafId = useRef<number | null>(null);
  const eventCount = useRef(0);
  const activeRunId = useRef<string | null>(null);
  const pendingScanError = useRef<ScanEvent<ScanErrorPayload> | null>(null);
  const runClock = useRef<RunClockState | null>(null);

  // Reset backend scan state on mount (handles app restart with stale flag)
  useEffect(() => {
    resetScan().catch(() => {});
  }, []);

  const flushResults = useCallback(() => {
    if (pendingResults.current.length > 0) {
      const batch = pendingResults.current;
      pendingResults.current = [];
      setResults((prev) => {
        const updated = applyResultBatch(prev, batch);
        const nonNull = updated.filter((r) => r != null).length;
        logger.debug(
          `[useScan] flush: batch=${batch.length}, total array=${updated.length}, non-null=${nonNull}`,
        );
        return updated;
      });
    }
    rafId.current = null;
  }, []);

  const queueResult = useCallback(
    (result: ChannelResult) => {
      eventCount.current += 1;
      if (eventCount.current <= 5 || eventCount.current % 50 === 0) {
        logger.debug(
          `[useScan] event #${eventCount.current}: index=${result.index} name="${result.name}" status=${result.status}`,
        );
      }
      pendingResults.current.push(result);
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(flushResults);
      }
    },
    [flushResults],
  );

  const applyScanError = useCallback((message: string) => {
    setError(message);
    setScanState("idle");
    setTelemetry(EMPTY_TELEMETRY);
    activeRunId.current = null;
    runClock.current = null;
  }, []);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    const setup = async () => {
      logger.debug("[useScan] Setting up event listeners");

      unlisteners.push(
        await listen<ScanEvent<ChannelResult>>("scan://channel-result", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          queueResult(event.payload.payload);
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanProgress>>("scan://progress", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          const nextProgress = event.payload.payload;
          setProgress(nextProgress);

          const now = performance.now();
          const activeRun = runClock.current;
          if (!activeRun || activeRun.runId !== event.payload.run_id) {
            return;
          }

          const pausedNowMs =
            activeRun.pausedAtMs == null ? 0 : now - activeRun.pausedAtMs;
          const activeElapsedMs = Math.max(
            0,
            now - activeRun.startedAtMs - activeRun.accumulatedPausedMs - pausedNowMs,
          );
          const activeElapsedSeconds = activeElapsedMs / 1000;

          if (nextProgress.completed < 2 || activeElapsedSeconds < 1) {
            setTelemetry(EMPTY_TELEMETRY);
            return;
          }

          const throughput = nextProgress.completed / activeElapsedSeconds;
          if (!Number.isFinite(throughput) || throughput <= 0) {
            setTelemetry(EMPTY_TELEMETRY);
            return;
          }

          const remaining = Math.max(0, nextProgress.total - nextProgress.completed);
          const etaSeconds = remaining > 0 ? remaining / throughput : 0;
          setTelemetry({
            throughputChannelsPerSecond: throughput,
            etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null,
          });
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanSummary>>("scan://complete", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          logger.debug("[useScan] scan://complete received", event.payload);
          setSummary(event.payload.payload);
          setScanState("complete");
          setTelemetry(EMPTY_TELEMETRY);
          pendingScanError.current = null;
          activeRunId.current = null;
          runClock.current = null;
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanSummary>>("scan://cancelled", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          logger.debug("[useScan] scan://cancelled received", event.payload);
          setSummary(event.payload.payload);
          setScanState("cancelled");
          setTelemetry(EMPTY_TELEMETRY);
          pendingScanError.current = null;
          activeRunId.current = null;
          runClock.current = null;
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<null>>("scan://paused", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          const activeRun = runClock.current;
          if (activeRun && activeRun.runId === event.payload.run_id) {
            activeRun.pausedAtMs = performance.now();
          }
          setScanState("paused");
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<null>>("scan://resumed", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          const now = performance.now();
          const activeRun = runClock.current;
          if (
            activeRun &&
            activeRun.runId === event.payload.run_id &&
            activeRun.pausedAtMs != null
          ) {
            activeRun.accumulatedPausedMs += now - activeRun.pausedAtMs;
            activeRun.pausedAtMs = null;
          }
          setScanState("scanning");
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanErrorPayload>>("scan://error", (event) => {
          logger.debug("[useScan] scan://error received", event.payload);

          const message = runScopedScanErrorMessage(
            activeRunId.current,
            event.payload,
          );
          if (message) {
            pendingScanError.current = null;
            applyScanError(message);
            return;
          }

          if (!activeRunId.current) {
            pendingScanError.current = event.payload;
          }
        }),
      );

      logger.debug("[useScan] All event listeners registered");
    };

    setup();

    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [queueResult, applyScanError]);

  const start = useCallback(
    async (
      config: ScanConfig,
      totalChannels: number,
      selectedIndices: number[] = [],
    ) => {
      logger.debug(`[useScan] start: totalChannels=${totalChannels}`, config);
      const selectedSet =
        selectedIndices.length > 0 ? new Set(selectedIndices) : null;

      // Reset existing results back to pending status for channels being scanned.
      setResults((prev) => {
        const targetLength = prev.length > 0 ? prev.length : totalChannels;

        if (targetLength > 0 && prev.some((r) => r != null)) {
          const updated = new Array(targetLength).fill(null);

          for (let i = 0; i < targetLength; i += 1) {
            const existing = prev[i] ?? null;
            if (!existing) continue;

            updated[i] =
              selectedSet && !selectedSet.has(existing.index)
                ? existing
                : {
                    ...existing,
                    status: "pending" as const,
                    codec: null,
                    resolution: null,
                    width: null,
                    height: null,
                    fps: null,
                    latency_ms: null,
                    video_bitrate: null,
                    audio_bitrate: null,
                    audio_codec: null,
                    audio_only: false,
                    screenshot_path: null,
                    label_mismatches: [],
                    low_framerate: false,
                    error_message: null,
                    stream_url: null,
                    retry_count: null,
                    error_reason: null,
                  };
          }

          return updated;
        }

        return new Array(targetLength).fill(null);
      });
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("scanning");
      setTelemetry(EMPTY_TELEMETRY);
      pendingResults.current = [];
      eventCount.current = 0;
      activeRunId.current = null;
      pendingScanError.current = null;
      runClock.current = null;

      try {
        const runId = await startScan(config);
        activeRunId.current = runId;
        runClock.current = {
          runId,
          startedAtMs: performance.now(),
          pausedAtMs: null,
          accumulatedPausedMs: 0,
        };
        logger.debug(`[useScan] startScan IPC returned run_id=${runId}`);
        const pendingMessage = pendingScanErrorMessageForRun(
          pendingScanError.current,
          runId,
        );
        if (pendingMessage) {
          pendingScanError.current = null;
          applyScanError(pendingMessage);
        }
      } catch (err) {
        logger.error("[useScan] startScan IPC error:", err);
        pendingScanError.current = null;
        setError(String(err));
        setScanState("idle");
        setTelemetry(EMPTY_TELEMETRY);
        activeRunId.current = null;
        runClock.current = null;
      }
    },
    [applyScanError],
  );

  const cancel = useCallback(async () => {
    try {
      await cancelScan();
    } catch {
      // ignore
    }
  }, []);

  const pause = useCallback(async () => {
    try {
      await pauseScan();
    } catch {
      // ignore
    }
  }, []);

  const resume = useCallback(async () => {
    try {
      await resumeScan();
    } catch {
      // ignore
    }
  }, []);

  const initFromPlaylist = useCallback(
    async (channels: { index: number; playlist: string; name: string; group: string; url: string; extinf_line: string; metadata_lines: string[] }[]) => {
      // Cancel any running scan and reset backend state
      await resetScan().catch(() => {});

      const maxIndex = channels.reduce(
        (max, channel) => Math.max(max, channel.index),
        -1,
      );
      const pending = new Array<ChannelResult | null>(maxIndex + 1).fill(null);
      for (const ch of channels) {
        pending[ch.index] = {
          index: ch.index,
          playlist: ch.playlist,
          name: ch.name,
          group: ch.group,
          url: ch.url,
          status: "pending" as const,
          codec: null,
          resolution: null,
          width: null,
          height: null,
          fps: null,
          latency_ms: null,
          video_bitrate: null,
          audio_bitrate: null,
          audio_codec: null,
          audio_only: false,
          screenshot_path: null,
          label_mismatches: [],
          low_framerate: false,
          error_message: null,
          channel_id: ch.url.split("/").pop()?.replace(".ts", "") ?? "Unknown",
          extinf_line: ch.extinf_line,
          metadata_lines: ch.metadata_lines,
          stream_url: null,
          retry_count: null,
          error_reason: null,
        };
      }
      logger.debug(`[useScan] initFromPlaylist: ${pending.length} channels`);
      setResults(pending);
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("idle");
      setTelemetry(EMPTY_TELEMETRY);
      pendingResults.current = [];
      eventCount.current = 0;
      activeRunId.current = null;
      pendingScanError.current = null;
      runClock.current = null;
    },
    [],
  );

  return {
    results,
    progress,
    summary,
    scanState,
    error,
    telemetry,
    start,
    cancel,
    pause,
    resume,
    initFromPlaylist,
  };
}
