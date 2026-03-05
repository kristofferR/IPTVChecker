import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChannelResult,
  ScanConfig,
  ScanErrorPayload,
  ScanEvent,
  ScanProgress,
  ScanResultBatchPayload,
  ScanSummary,
} from "../lib/types";
import { cancelScan, pauseScan, resetScan, resumeScan, startScan } from "../lib/tauri";
import { logger } from "../lib/logger";
import { findDuplicateChannelIndices } from "../lib/duplicates";
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

interface ScanUiMetrics {
  presentCount: number;
  lowFpsCount: number;
  mislabeledCount: number;
}

const EMPTY_TELEMETRY: ScanTelemetry = {
  throughputChannelsPerSecond: null,
  etaSeconds: null,
};

const EMPTY_UI_METRICS: ScanUiMetrics = {
  presentCount: 0,
  lowFpsCount: 0,
  mislabeledCount: 0,
};

/** Number of recent completions used for rolling throughput average. */
const SLIDING_WINDOW_SIZE = 20;
/** Minimum completions before showing speed/ETA (avoids noisy early values). */
const MIN_SAMPLES_FOR_TELEMETRY = 5;
/** Only refresh the telemetry display this often (ms) to prevent flicker. */
const TELEMETRY_THROTTLE_MS = 2000;

interface RunClockState {
  runId: string;
  startedAtMs: number;
  pausedAtMs: number | null;
  accumulatedPausedMs: number;
}

function buildFlatResultsAndMetrics(
  source: (ChannelResult | null)[],
): {
  flatResults: ChannelResult[];
  indexToFlatPos: Map<number, number>;
  metrics: ScanUiMetrics;
} {
  const flatResults: ChannelResult[] = [];
  const indexToFlatPos = new Map<number, number>();
  let lowFpsCount = 0;
  let mislabeledCount = 0;

  for (const result of source) {
    if (!result) continue;
    indexToFlatPos.set(result.index, flatResults.length);
    flatResults.push(result);
    if (result.low_framerate) {
      lowFpsCount += 1;
    }
    if (result.label_mismatches.length > 0) {
      mislabeledCount += 1;
    }
  }

  return {
    flatResults,
    indexToFlatPos,
    metrics: {
      presentCount: flatResults.length,
      lowFpsCount,
      mislabeledCount,
    },
  };
}

export function useScan() {
  const [results, setResults] = useState<(ChannelResult | null)[]>([]);
  const [flatResults, setFlatResults] = useState<ChannelResult[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<ScanTelemetry>(EMPTY_TELEMETRY);
  const [uiMetrics, setUiMetrics] = useState<ScanUiMetrics>(EMPTY_UI_METRICS);
  const [duplicateIndices, setDuplicateIndices] = useState<Set<number>>(
    () => new Set(),
  );
  const [screenshotsPaused, setScreenshotsPaused] = useState(false);

  // Batch incoming results with requestAnimationFrame
  const pendingResults = useRef<ChannelResult[]>([]);
  const resultsRef = useRef<(ChannelResult | null)[]>([]);
  const indexToFlatPosRef = useRef<Map<number, number>>(new Map());
  const rafId = useRef<number | null>(null);
  const eventCount = useRef(0);
  const activeRunId = useRef<string | null>(null);
  const pendingScanError = useRef<ScanEvent<ScanErrorPayload> | null>(null);
  const runClock = useRef<RunClockState | null>(null);
  /** Active-elapsed-ms timestamp for each channel completion (sliding window source). */
  const completionActiveMs = useRef<number[]>([]);
  /** Wall-clock time of last telemetry state update (for throttle). */
  const lastTelemetryUpdateMs = useRef(0);
  /** Set immediately on cancel click; suppresses incoming results during drain. */
  const cancelling = useRef(false);
  const presentCountRef = useRef(0);
  const lowFpsCountRef = useRef(0);
  const mislabeledCountRef = useRef(0);

  // Reset backend scan state on mount (handles app restart with stale flag)
  useEffect(() => {
    resetScan().catch(() => {});
  }, []);

  const flushResults = useCallback(() => {
    if (pendingResults.current.length > 0) {
      const batch = pendingResults.current;
      pendingResults.current = [];
      const previous = resultsRef.current;
      const updated = applyResultBatch(previous, batch);
      resultsRef.current = updated;
      setResults(updated);

      let presentCount = presentCountRef.current;
      let lowFpsCount = lowFpsCountRef.current;
      let mislabeledCount = mislabeledCountRef.current;
      let metricsChanged = false;
      setFlatResults((prevFlat) => {
        let nextFlat = prevFlat;
        let flatChanged = false;

        for (const result of batch) {
          const previousResult = previous[result.index];
          if (!previousResult) {
            presentCount += 1;
            metricsChanged = true;
          }

          const previousLowFps = previousResult?.low_framerate ?? false;
          if (previousLowFps !== result.low_framerate) {
            lowFpsCount += result.low_framerate ? 1 : -1;
            metricsChanged = true;
          }

          const previousMislabeled =
            (previousResult?.label_mismatches.length ?? 0) > 0;
          const nextMislabeled = result.label_mismatches.length > 0;
          if (previousMislabeled !== nextMislabeled) {
            mislabeledCount += nextMislabeled ? 1 : -1;
            metricsChanged = true;
          }

          const flatPos = indexToFlatPosRef.current.get(result.index);
          if (flatPos == null) {
            if (nextFlat === prevFlat) {
              nextFlat = [...prevFlat];
            }
            indexToFlatPosRef.current.set(result.index, nextFlat.length);
            nextFlat.push(result);
            flatChanged = true;
          } else if (nextFlat[flatPos] !== result) {
            if (nextFlat === prevFlat) {
              nextFlat = [...prevFlat];
            }
            nextFlat[flatPos] = result;
            flatChanged = true;
          }
        }

        if (metricsChanged) {
          presentCountRef.current = presentCount;
          lowFpsCountRef.current = lowFpsCount;
          mislabeledCountRef.current = mislabeledCount;
          setUiMetrics({
            presentCount,
            lowFpsCount,
            mislabeledCount,
          });
        }

        logger.debug(
          `[useScan] flush: batch=${batch.length}, total array=${updated.length}, non-null=${presentCount}`,
        );

        return flatChanged ? nextFlat : prevFlat;
      });
    }
    rafId.current = null;
  }, []);

  const queueResults = useCallback(
    (incoming: ChannelResult[]) => {
      if (incoming.length === 0) return;
      eventCount.current += incoming.length;
      if (eventCount.current <= 5 || eventCount.current % 50 === 0) {
        const last = incoming[incoming.length - 1];
        logger.debug(
          `[useScan] events total=${eventCount.current}: +${incoming.length}, latest index=${last.index} status=${last.status}`,
        );
      }
      pendingResults.current.push(...incoming);
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(flushResults);
      }
    },
    [flushResults],
  );

  const queueResult = useCallback(
    (result: ChannelResult) => {
      queueResults([result]);
    },
    [queueResults],
  );

  const recordCompletions = useCallback((count: number) => {
    if (count <= 0) return;
    const clock = runClock.current;
    if (!clock) return;
    const pauseMs =
      clock.pausedAtMs != null ? performance.now() - clock.pausedAtMs : 0;
    const activeMs =
      performance.now() -
      clock.startedAtMs -
      clock.accumulatedPausedMs -
      pauseMs;
    for (let i = 0; i < count; i += 1) {
      completionActiveMs.current.push(activeMs);
    }
  }, []);

  const handleProgressUpdate = useCallback((nextProgress: ScanProgress) => {
    setProgress(nextProgress);

    // Throttle telemetry updates to avoid flicker (issue #79)
    const now = performance.now();
    if (
      now - lastTelemetryUpdateMs.current < TELEMETRY_THROTTLE_MS &&
      lastTelemetryUpdateMs.current > 0
    ) {
      return;
    }

    // Sliding-window throughput: use last N completion timestamps
    const samples = completionActiveMs.current;
    if (samples.length < MIN_SAMPLES_FOR_TELEMETRY) {
      setTelemetry(EMPTY_TELEMETRY);
      return;
    }

    const windowStart = Math.max(0, samples.length - SLIDING_WINDOW_SIZE);
    const firstMs = samples[windowStart];
    const lastMs = samples[samples.length - 1];
    const windowDurationSec = (lastMs - firstMs) / 1000;
    const windowCount = samples.length - 1 - windowStart;

    if (windowDurationSec <= 0 || windowCount <= 0) {
      setTelemetry(EMPTY_TELEMETRY);
      return;
    }

    const throughput = windowCount / windowDurationSec;
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
    lastTelemetryUpdateMs.current = now;
  }, []);

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
        await listen<ScanEvent<ScanResultBatchPayload>>(
          "scan://channel-results-batch",
          (event) => {
            if (
              cancelling.current ||
              !isRunScopedEventForActiveRun(
                activeRunId.current,
                event.payload.run_id,
              )
            ) {
              return;
            }

            const payload = event.payload.payload;
            queueResults(payload.items);
            recordCompletions(payload.items.length);
            handleProgressUpdate(payload.progress);
          },
        ),
      );

      unlisteners.push(
        await listen<ScanEvent<ChannelResult>>("scan://channel-result", (event) => {
          if (
            cancelling.current ||
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          queueResult(event.payload.payload);
          recordCompletions(1);
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanProgress>>("scan://progress", (event) => {
          if (
            cancelling.current ||
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          handleProgressUpdate(event.payload.payload);
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
          cancelling.current = false;
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

      unlisteners.push(
        await listen<ScanEvent<null>>("scan://screenshots-paused", (event) => {
          if (isRunScopedEventForActiveRun(activeRunId.current, event.payload.run_id)) {
            logger.debug("[useScan] scan://screenshots-paused received");
            setScreenshotsPaused(true);
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
  }, [
    queueResult,
    queueResults,
    applyScanError,
    recordCompletions,
    handleProgressUpdate,
  ]);

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
      const previous = resultsRef.current;
      const targetLength = previous.length > 0 ? previous.length : totalChannels;
      const updated = new Array<ChannelResult | null>(targetLength).fill(null);

      if (targetLength > 0 && previous.some((r) => r != null)) {
        for (let i = 0; i < targetLength; i += 1) {
          const existing = previous[i] ?? null;
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
      }

      const rebuilt = buildFlatResultsAndMetrics(updated);
      resultsRef.current = updated;
      indexToFlatPosRef.current = rebuilt.indexToFlatPos;
      presentCountRef.current = rebuilt.metrics.presentCount;
      lowFpsCountRef.current = rebuilt.metrics.lowFpsCount;
      mislabeledCountRef.current = rebuilt.metrics.mislabeledCount;

      setResults(updated);
      setFlatResults(rebuilt.flatResults);
      setUiMetrics(rebuilt.metrics);
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("scanning");
      setTelemetry(EMPTY_TELEMETRY);
      setScreenshotsPaused(false);
      pendingResults.current = [];
      eventCount.current = 0;
      activeRunId.current = null;
      pendingScanError.current = null;
      runClock.current = null;
      cancelling.current = false;
      completionActiveMs.current = [];
      lastTelemetryUpdateMs.current = 0;

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
    // Suppress incoming results immediately so in-flight completions
    // don't burst into the UI while the backend drains (issue #81).
    cancelling.current = true;
    pendingResults.current = [];
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
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
          channel_id: ch.url.split("/").pop()?.replace(".ts", "") || "Unknown",
          extinf_line: ch.extinf_line,
          metadata_lines: ch.metadata_lines,
          stream_url: null,
          retry_count: null,
          error_reason: null,
        };
      }
      const rebuilt = buildFlatResultsAndMetrics(pending);
      const duplicates = findDuplicateChannelIndices(pending);

      logger.debug(`[useScan] initFromPlaylist: ${pending.length} channels`);
      resultsRef.current = pending;
      indexToFlatPosRef.current = rebuilt.indexToFlatPos;
      presentCountRef.current = rebuilt.metrics.presentCount;
      lowFpsCountRef.current = rebuilt.metrics.lowFpsCount;
      mislabeledCountRef.current = rebuilt.metrics.mislabeledCount;
      setResults(pending);
      setFlatResults(rebuilt.flatResults);
      setUiMetrics(rebuilt.metrics);
      setDuplicateIndices(duplicates);
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
      completionActiveMs.current = [];
      lastTelemetryUpdateMs.current = 0;
    },
    [],
  );

  return {
    results,
    flatResults,
    uiMetrics,
    duplicateIndices,
    progress,
    summary,
    scanState,
    error,
    telemetry,
    screenshotsPaused,
    start,
    cancel,
    pause,
    resume,
    initFromPlaylist,
  };
}
