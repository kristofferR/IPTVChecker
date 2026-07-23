import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  Channel,
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
import {
  getChannelIdFromUrl,
  resetChannelResultForRescan,
  toPendingChannelResult,
} from "../lib/channelResults";
import { findDuplicateChannelIndicesChunked } from "../lib/duplicates";
import {
  pendingScanErrorMessageForRun,
  runScopedScanErrorMessage,
} from "../lib/scanErrorEvents";
import {
  applyResultUpdates,
  isRunScopedEventForActiveRun,
  type ScanUiMetrics,
} from "./useScan.helpers";
import { useAppStore } from "../store";
import { EMPTY_TELEMETRY } from "../store/slices/scanSlice";
import type { ScanResultLookup } from "../store/types";

export type { ScanState } from "../lib/scanState";

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
  source: ChannelResult[],
): {
  resultsByIndex: ScanResultLookup;
  flatResults: ChannelResult[];
  indexToFlatPos: Map<number, number>;
  metrics: ScanUiMetrics;
} {
  const resultsByIndex: ScanResultLookup = {};
  const flatResults: ChannelResult[] = [];
  const indexToFlatPos = new Map<number, number>();
  let lowFpsCount = 0;
  let mislabeledCount = 0;

  for (const result of source) {
    resultsByIndex[result.index] = result;
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
    resultsByIndex,
    flatResults,
    indexToFlatPos,
    metrics: {
      presentCount: flatResults.length,
      lowFpsCount,
      mislabeledCount,
    },
  };
}

function mergeChannelIntoResult(
  channel: Channel,
  existing: ChannelResult,
): ChannelResult {
  return {
    ...existing,
    ...channel,
    channel_id: getChannelIdFromUrl(channel.url),
  };
}

// Helper to access store setters without subscribing to re-renders.
// All writes inside callbacks use this instead of destructuring from useAppStore().
const getStore = () => useAppStore.getState();

export function useScan() {
  // Batch incoming results with requestAnimationFrame
  const pendingResults = useRef<ChannelResult[]>([]);
  const resultsRef = useRef<ScanResultLookup>({});
  const flatResultsRef = useRef<ChannelResult[]>([]);
  const indexToFlatPosRef = useRef<Map<number, number>>(new Map());
  const uiMetricsRef = useRef<ScanUiMetrics>(EMPTY_UI_METRICS);
  const rafId = useRef<number | null>(null);
  const eventCount = useRef(0);
  const activeRunId = useRef<string | null>(null);
  const pendingScanError = useRef<ScanEvent<ScanErrorPayload> | null>(null);
  const runClock = useRef<RunClockState | null>(null);
  const duplicateComputeVersion = useRef(0);
  /** Active-elapsed-ms timestamp for each channel completion (sliding window source). */
  const completionActiveMs = useRef<number[]>([]);
  /** Wall-clock time of last telemetry state update (for throttle). */
  const lastTelemetryUpdateMs = useRef(0);
  /** Set immediately on cancel click; suppresses incoming results during drain. */
  const cancelling = useRef(false);

  // Reset backend scan state on mount (handles app restart with stale flag)
  useEffect(() => {
    resetScan().catch(() => {});
  }, []);

  const commitCollections = useCallback(
    (next: {
      resultsByIndex: ScanResultLookup;
      flatResults: ChannelResult[];
      indexToFlatPos: Map<number, number>;
      metrics: ScanUiMetrics;
    }) => {
      resultsRef.current = next.resultsByIndex;
      flatResultsRef.current = next.flatResults;
      indexToFlatPosRef.current = next.indexToFlatPos;
      uiMetricsRef.current = next.metrics;

      getStore().applyScanCollections({
        results: next.resultsByIndex,
        flatResults: next.flatResults,
        uiMetrics: next.metrics,
      });
    },
    [],
  );

  const flushResults = useCallback(() => {
    if (pendingResults.current.length > 0) {
      const batch = pendingResults.current;
      pendingResults.current = [];
      const next = applyResultUpdates(
        {
          resultsByIndex: resultsRef.current,
          flatResults: flatResultsRef.current,
          indexToFlatPos: indexToFlatPosRef.current,
          metrics: uiMetricsRef.current,
        },
        batch,
      );

      commitCollections(next);

      logger.debug(
        `[useScan] flush: batch=${batch.length}, tracked=${next.metrics.presentCount}, non-null=${next.metrics.presentCount}`,
      );
    }
    rafId.current = null;
  }, [commitCollections]);

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
    const s = getStore();

    // Throttle telemetry updates to avoid flicker (issue #79)
    const now = performance.now();
    if (
      now - lastTelemetryUpdateMs.current < TELEMETRY_THROTTLE_MS &&
      lastTelemetryUpdateMs.current > 0
    ) {
      s.applyScanRuntime({ progress: nextProgress });
      return;
    }

    // Sliding-window throughput: use last N completion timestamps
    const samples = completionActiveMs.current;
    if (samples.length < MIN_SAMPLES_FOR_TELEMETRY) {
      s.applyScanRuntime({
        progress: nextProgress,
        telemetry: EMPTY_TELEMETRY,
      });
      return;
    }

    const windowStart = Math.max(0, samples.length - SLIDING_WINDOW_SIZE);
    const firstMs = samples[windowStart];
    const lastMs = samples[samples.length - 1];
    const windowDurationSec = (lastMs - firstMs) / 1000;
    const windowCount = samples.length - 1 - windowStart;

    if (windowDurationSec <= 0 || windowCount <= 0) {
      s.applyScanRuntime({
        progress: nextProgress,
        telemetry: EMPTY_TELEMETRY,
      });
      return;
    }

    const throughput = windowCount / windowDurationSec;
    if (!Number.isFinite(throughput) || throughput <= 0) {
      s.applyScanRuntime({
        progress: nextProgress,
        telemetry: EMPTY_TELEMETRY,
      });
      return;
    }

    const remaining = Math.max(0, nextProgress.total - nextProgress.completed);
    const etaSeconds = remaining > 0 ? remaining / throughput : 0;
    s.applyScanRuntime({
      progress: nextProgress,
      telemetry: {
        throughputChannelsPerSecond: throughput,
        etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null,
      },
    });
    lastTelemetryUpdateMs.current = now;
  }, []);

  const applyScanError = useCallback((message: string) => {
    getStore().applyScanRuntime({
      scanError: message,
      scanState: "idle",
      telemetry: EMPTY_TELEMETRY,
    });
    activeRunId.current = null;
    runClock.current = null;
  }, []);

  useEffect(() => {
    // Register all listeners in parallel and guard against cleanup running
    // mid-registration (e.g. StrictMode remount) — sequential `await listen()`
    // with synchronous cleanup orphans listeners that resolve after cleanup.
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    const setup = async () => {
      logger.debug("[useScan] Setting up event listeners");

      const registered = await Promise.all([
        listen<ScanEvent<ScanResultBatchPayload>>(
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
        listen<ScanEvent<ChannelResult>>("scan://channel-result", (event) => {
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
        listen<ScanEvent<ScanProgress>>("scan://progress", (event) => {
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
        listen<ScanEvent<ScanSummary>>("scan://complete", (event) => {
          if (
            !isRunScopedEventForActiveRun(
              activeRunId.current,
              event.payload.run_id,
            )
          ) {
            return;
          }
          logger.debug("[useScan] scan://complete received", event.payload);
          getStore().applyScanRuntime({
            summary: event.payload.payload,
            scanState: "complete",
            telemetry: EMPTY_TELEMETRY,
          });
          pendingScanError.current = null;
          activeRunId.current = null;
          runClock.current = null;
        }),
        listen<ScanEvent<ScanSummary>>("scan://cancelled", (event) => {
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
          getStore().applyScanRuntime({
            summary: event.payload.payload,
            scanState: "cancelled",
            telemetry: EMPTY_TELEMETRY,
          });
          pendingScanError.current = null;
          activeRunId.current = null;
          runClock.current = null;
        }),
        listen<ScanEvent<null>>("scan://paused", (event) => {
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
          getStore().applyScanRuntime({ scanState: "paused" });
        }),
        listen<ScanEvent<null>>("scan://resumed", (event) => {
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
          getStore().applyScanRuntime({ scanState: "scanning" });
        }),
        listen<ScanEvent<ScanErrorPayload>>("scan://error", (event) => {
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
        listen<ScanEvent<null>>("scan://screenshots-paused", (event) => {
          if (isRunScopedEventForActiveRun(activeRunId.current, event.payload.run_id)) {
            logger.debug("[useScan] scan://screenshots-paused received");
            getStore().applyScanRuntime({ screenshotsPaused: true });
          }
        }),
        listen<ScanEvent<null>>("scan://network-paused", (event) => {
          if (isRunScopedEventForActiveRun(activeRunId.current, event.payload.run_id)) {
            logger.debug("[useScan] scan://network-paused received");
            getStore().applyScanRuntime({ networkPaused: true });
          }
        }),
        listen<ScanEvent<null>>("scan://network-resumed", (event) => {
          if (isRunScopedEventForActiveRun(activeRunId.current, event.payload.run_id)) {
            logger.debug("[useScan] scan://network-resumed received");
            getStore().applyScanRuntime({ networkPaused: false });
          }
        }),
      ]);

      if (cancelled) {
        for (const off of registered) {
          off();
        }
        return;
      }
      unlisteners.push(...registered);

      logger.debug("[useScan] All event listeners registered");
    };

    setup();

    return () => {
      cancelled = true;
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
      const initialTotal =
        selectedIndices.length > 0 ? selectedIndices.length : totalChannels;

      // Reset existing results back to pending status for channels being scanned.
      const updated = flatResultsRef.current.map((existing) =>
        selectedSet && !selectedSet.has(existing.index)
          ? existing
          : resetChannelResultForRescan(existing),
      );
      const rebuilt = buildFlatResultsAndMetrics(updated);
      commitCollections({
        resultsByIndex: rebuilt.resultsByIndex,
        flatResults: rebuilt.flatResults,
        indexToFlatPos: rebuilt.indexToFlatPos,
        metrics: rebuilt.metrics,
      });
      getStore().applyScanRuntime({
        progress: {
          completed: 0,
          total: Math.max(0, initialTotal),
          alive: 0,
          dead: 0,
          placeholder: 0,
          geoblocked: 0,
          drm: 0,
        },
        summary: null,
        scanError: null,
        scanState: "scanning",
        telemetry: EMPTY_TELEMETRY,
        screenshotsPaused: false,
        networkPaused: false,
      });
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
        getStore().applyScanRuntime({
          scanError: String(err),
          progress: null,
          scanState: "idle",
          telemetry: EMPTY_TELEMETRY,
        });
        activeRunId.current = null;
        runClock.current = null;
      }
    },
    [applyScanError, commitCollections],
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
    // Reflect stopped state in the UI immediately (issue #148).
    // The backend scan://cancelled event will still arrive later to
    // deliver the summary and clean up activeRunId.
    getStore().applyScanRuntime({
      scanState: "cancelling",
      telemetry: EMPTY_TELEMETRY,
    });
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

  const syncFromPlaylist = useCallback(
    async (
      channels: Channel[],
      preserveExistingResults = false,
      shouldApply: () => boolean = () => true,
    ) => {
      const syncStartedAt = performance.now();
      const duplicateVersion = duplicateComputeVersion.current + 1;
      duplicateComputeVersion.current = duplicateVersion;

      // Cancel any running scan and reset backend state
      await resetScan().catch(() => {});
      if (!shouldApply()) {
        return false;
      }

      const synced = channels.map((channel) => {
        const existing = resultsRef.current[channel.index];
        if (preserveExistingResults && existing) {
          return mergeChannelIntoResult(channel, existing);
        }
        return toPendingChannelResult(channel);
      });
      const rebuildStartedAt = performance.now();
      const rebuilt = buildFlatResultsAndMetrics(synced);
      const rebuildMs = performance.now() - rebuildStartedAt;

      logger.debug(
        `[useScan] syncFromPlaylist: ${synced.length} channels, preserveExistingResults=${preserveExistingResults}, rebuild=${rebuildMs.toFixed(1)}ms`,
      );
      commitCollections({
        resultsByIndex: rebuilt.resultsByIndex,
        flatResults: rebuilt.flatResults,
        indexToFlatPos: rebuilt.indexToFlatPos,
        metrics: rebuilt.metrics,
      });
      getStore().applyScanRuntime({
        duplicateIndices: new Set(),
        progress: null,
        summary: null,
        scanError: null,
        scanState: "idle",
        telemetry: EMPTY_TELEMETRY,
        screenshotsPaused: false,
        networkPaused: false,
      });
      pendingResults.current = [];
      eventCount.current = 0;
      activeRunId.current = null;
      pendingScanError.current = null;
      runClock.current = null;
      completionActiveMs.current = [];
      lastTelemetryUpdateMs.current = 0;

      const duplicateStartedAt = performance.now();
      void findDuplicateChannelIndicesChunked(channels, {
        batchSize: 2000,
        shouldCancel: () => duplicateComputeVersion.current !== duplicateVersion,
      }).then((duplicates) => {
        if (
          duplicates == null ||
          duplicateComputeVersion.current !== duplicateVersion
        ) {
          return;
        }

        getStore().applyScanRuntime({ duplicateIndices: duplicates });
        logger.debug(
          `[useScan] duplicate scan complete: ${duplicates.size} flagged indices in ${(performance.now() - duplicateStartedAt).toFixed(1)}ms`,
        );
      });

      logger.info(
        `[useScan] playlist sync complete: ${channels.length} channels ready in ${(performance.now() - syncStartedAt).toFixed(1)}ms`,
      );
      return true;
    },
    [commitCollections],
  );

  const initFromPlaylist = useCallback(
    async (channels: Channel[], shouldApply?: () => boolean) => {
      return syncFromPlaylist(channels, false, shouldApply);
    },
    [syncFromPlaylist],
  );

  const updateResult = useCallback((result: ChannelResult) => {
    const next = applyResultUpdates(
      {
        resultsByIndex: resultsRef.current,
        flatResults: flatResultsRef.current,
        indexToFlatPos: indexToFlatPosRef.current,
        metrics: uiMetricsRef.current,
      },
      [result],
    );

    commitCollections(next);
  }, [commitCollections]);

  return {
    start,
    cancel,
    pause,
    resume,
    initFromPlaylist,
    syncFromPlaylist,
    updateResult,
  };
}
