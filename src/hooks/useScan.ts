import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChannelResult,
  ScanConfig,
  ScanEvent,
  ScanProgress,
  ScanSummary,
} from "../lib/types";
import { cancelScan, resetScan, startScan } from "../lib/tauri";
import { logger } from "../lib/logger";

export type ScanState = "idle" | "scanning" | "complete" | "cancelled";

export function useScan() {
  const [results, setResults] = useState<ChannelResult[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Batch incoming results with requestAnimationFrame
  const pendingResults = useRef<ChannelResult[]>([]);
  const rafId = useRef<number | null>(null);
  const eventCount = useRef(0);
  const activeRunId = useRef<string | null>(null);

  // Reset backend scan state on mount (handles app restart with stale flag)
  useEffect(() => {
    resetScan().catch(() => {});
  }, []);

  const flushResults = useCallback(() => {
    if (pendingResults.current.length > 0) {
      const batch = pendingResults.current;
      pendingResults.current = [];
      setResults((prev) => {
        const updated = [...prev];
        for (const result of batch) {
          updated[result.index] = result;
        }
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

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    const setup = async () => {
      logger.debug("[useScan] Setting up event listeners");

      unlisteners.push(
        await listen<ScanEvent<ChannelResult>>("scan://channel-result", (event) => {
          if (!activeRunId.current || event.payload.run_id !== activeRunId.current) {
            return;
          }
          queueResult(event.payload.payload);
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanProgress>>("scan://progress", (event) => {
          if (!activeRunId.current || event.payload.run_id !== activeRunId.current) {
            return;
          }
          setProgress(event.payload.payload);
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<ScanSummary>>("scan://complete", (event) => {
          if (!activeRunId.current || event.payload.run_id !== activeRunId.current) {
            return;
          }
          logger.debug("[useScan] scan://complete received", event.payload);
          setSummary(event.payload.payload);
          setScanState("complete");
          activeRunId.current = null;
        }),
      );

      unlisteners.push(
        await listen<ScanEvent<null>>("scan://cancelled", (event) => {
          if (!activeRunId.current || event.payload.run_id !== activeRunId.current) {
            return;
          }
          logger.debug("[useScan] scan://cancelled received");
          setScanState("cancelled");
          activeRunId.current = null;
        }),
      );

      unlisteners.push(
        await listen<string>("scan://error", (event) => {
          logger.debug("[useScan] scan://error received", event.payload);
          setError(event.payload);
          setScanState("idle");
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
  }, [queueResult]);

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
        if (prev.length === totalChannels && prev.some((r) => r != null)) {
          return prev.map((r) =>
            r
              ? selectedSet && !selectedSet.has(r.index)
                ? r
                : {
                    ...r,
                    status: "pending" as const,
                    codec: null,
                    resolution: null,
                    width: null,
                    height: null,
                    fps: null,
                    video_bitrate: null,
                    audio_bitrate: null,
                    audio_codec: null,
                    screenshot_path: null,
                    label_mismatches: [],
                    low_framerate: false,
                    error_message: null,
                    stream_url: null,
                  }
              : r,
          );
        }
        return new Array(totalChannels).fill(null);
      });
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("scanning");
      pendingResults.current = [];
      eventCount.current = 0;
      activeRunId.current = null;

      try {
        const runId = await startScan(config);
        activeRunId.current = runId;
        logger.debug(`[useScan] startScan IPC returned run_id=${runId}`);
      } catch (err) {
        logger.error("[useScan] startScan IPC error:", err);
        setError(String(err));
        setScanState("idle");
        activeRunId.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    try {
      await cancelScan();
    } catch {
      // ignore
    }
  }, []);

  const initFromPlaylist = useCallback(
    async (channels: { index: number; name: string; group: string; url: string; extinf_line: string; metadata_lines: string[] }[]) => {
      // Cancel any running scan and reset backend state
      await resetScan().catch(() => {});

      const pending: ChannelResult[] = channels.map((ch) => ({
        index: ch.index,
        name: ch.name,
        group: ch.group,
        url: ch.url,
        status: "pending" as const,
        codec: null,
        resolution: null,
        width: null,
        height: null,
        fps: null,
        video_bitrate: null,
        audio_bitrate: null,
        audio_codec: null,
        screenshot_path: null,
        label_mismatches: [],
        low_framerate: false,
        error_message: null,
        channel_id: ch.url.split("/").pop()?.replace(".ts", "") ?? "Unknown",
        extinf_line: ch.extinf_line,
        metadata_lines: ch.metadata_lines,
        stream_url: null,
      }));
      logger.debug(`[useScan] initFromPlaylist: ${pending.length} channels`);
      setResults(pending);
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("idle");
      pendingResults.current = [];
      eventCount.current = 0;
      activeRunId.current = null;
    },
    [],
  );

  return {
    results,
    progress,
    summary,
    scanState,
    error,
    start,
    cancel,
    initFromPlaylist,
  };
}
