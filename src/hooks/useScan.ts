import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChannelResult,
  ScanConfig,
  ScanProgress,
  ScanSummary,
} from "../lib/types";
import { cancelScan, resetScan, startScan } from "../lib/tauri";

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
        console.log(`[useScan] flush: batch=${batch.length}, total array=${updated.length}, non-null=${nonNull}`);
        return updated;
      });
    }
    rafId.current = null;
  }, []);

  const queueResult = useCallback(
    (result: ChannelResult) => {
      eventCount.current += 1;
      if (eventCount.current <= 5 || eventCount.current % 50 === 0) {
        console.log(`[useScan] event #${eventCount.current}: index=${result.index} name="${result.name}" status=${result.status}`);
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
      console.log("[useScan] Setting up event listeners");

      unlisteners.push(
        await listen<ChannelResult>("scan://channel-result", (event) => {
          queueResult(event.payload);
        }),
      );

      unlisteners.push(
        await listen<ScanProgress>("scan://progress", (event) => {
          setProgress(event.payload);
        }),
      );

      unlisteners.push(
        await listen<ScanSummary>("scan://complete", (event) => {
          console.log("[useScan] scan://complete received", event.payload);
          setSummary(event.payload);
          setScanState("complete");
        }),
      );

      unlisteners.push(
        await listen("scan://cancelled", () => {
          console.log("[useScan] scan://cancelled received");
          setScanState("cancelled");
        }),
      );

      unlisteners.push(
        await listen<string>("scan://error", (event) => {
          console.log("[useScan] scan://error received", event.payload);
          setError(event.payload);
          setScanState("idle");
        }),
      );

      console.log("[useScan] All event listeners registered");
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
    async (config: ScanConfig, totalChannels: number) => {
      console.log(`[useScan] start: totalChannels=${totalChannels}`, config);
      // Reset existing results back to pending status instead of nulling them out
      setResults((prev) => {
        if (prev.length === totalChannels && prev.some((r) => r != null)) {
          return prev.map((r) =>
            r
              ? { ...r, status: "pending" as const, codec: null, resolution: null, width: null, height: null, fps: null, video_bitrate: null, audio_bitrate: null, audio_codec: null, screenshot_path: null, label_mismatches: [], low_framerate: false, error_message: null, stream_url: null }
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

      try {
        await startScan(config);
        console.log("[useScan] startScan IPC returned OK");
      } catch (err) {
        console.error("[useScan] startScan IPC error:", err);
        setError(String(err));
        setScanState("idle");
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
      console.log(`[useScan] initFromPlaylist: ${pending.length} channels`);
      setResults(pending);
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("idle");
      pendingResults.current = [];
      eventCount.current = 0;
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
