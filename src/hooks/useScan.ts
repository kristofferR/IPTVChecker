import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChannelResult,
  ScanConfig,
  ScanProgress,
  ScanSummary,
} from "../lib/types";
import { cancelScan, startScan } from "../lib/tauri";

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

  const flushResults = useCallback(() => {
    if (pendingResults.current.length > 0) {
      const batch = pendingResults.current;
      pendingResults.current = [];
      setResults((prev) => {
        const updated = [...prev];
        for (const result of batch) {
          updated[result.index] = result;
        }
        return updated;
      });
    }
    rafId.current = null;
  }, []);

  const queueResult = useCallback(
    (result: ChannelResult) => {
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
          setSummary(event.payload);
          setScanState("complete");
        }),
      );

      unlisteners.push(
        await listen("scan://cancelled", () => {
          setScanState("cancelled");
        }),
      );

      unlisteners.push(
        await listen<string>("scan://error", (event) => {
          setError(event.payload);
          setScanState("idle");
        }),
      );
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
      setResults(new Array(totalChannels).fill(null));
      setProgress(null);
      setSummary(null);
      setError(null);
      setScanState("scanning");
      pendingResults.current = [];

      try {
        await startScan(config);
      } catch (err) {
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

  const reset = useCallback(() => {
    setResults([]);
    setProgress(null);
    setSummary(null);
    setError(null);
    setScanState("idle");
  }, []);

  return {
    results,
    progress,
    summary,
    scanState,
    error,
    start,
    cancel,
    reset,
  };
}
