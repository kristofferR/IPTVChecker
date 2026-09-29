import { useEffect, useRef } from "react";
import { isDispatcharrPreview } from "../lib/dispatcharr";
import { errorToString } from "../lib/errors";
import { logger } from "../lib/logger";
import { dispatcharrPushStreamStats } from "../lib/tauri";
import type { ChannelResult } from "../lib/types";
import { useAppStore } from "../store";

/** When enabled in settings, write probe results into Dispatcharr's stream
 *  stats once a scan of a Dispatcharr source completes. */
export function useDispatcharrStatsPush() {
  const scanState = useAppStore((s) => s.scanState);
  const previousScanState = useRef(scanState);
  // Result objects from before the scan: only rows the scan replaced are
  // pushed, so a partial rescan does not re-date older results.
  const resultsBeforeScan = useRef<ReadonlySet<ChannelResult>>(new Set());

  useEffect(() => {
    if (scanState === "scanning" && previousScanState.current !== "scanning") {
      const before = useAppStore.getState().flatResults;
      if (previousScanState.current !== "paused") resultsBeforeScan.current = new Set(before);
    }
    const finished = scanState === "complete" && previousScanState.current !== "complete";
    previousScanState.current = scanState;
    const state = useAppStore.getState();
    const sourceIdentity = state.playlist?.source_identity;
    if (
      !finished ||
      !state.settings.dispatcharr_write_stats ||
      !sourceIdentity ||
      !isDispatcharrPreview(state.playlist)
    ) {
      return;
    }
    const scanned = state.flatResults.filter((result) => !resultsBeforeScan.current.has(result));
    resultsBeforeScan.current = new Set();
    void dispatcharrPushStreamStats(sourceIdentity, scanned)
      .then((report) => {
        const store = useAppStore.getState();
        if (report.rejected) {
          store.setMenuInfo(
            "Dispatcharr did not keep the probe results. This Dispatcharr version may not accept them.",
            "warn",
          );
        } else if (report.failed.length > 0) {
          store.setMenuInfo(
            `Wrote probe results for ${report.updated.length} streams to Dispatcharr; ${report.failed.length} failed.`,
            "warn",
          );
        } else if (report.updated.length > 0) {
          store.setMenuInfo(
            `Wrote probe results for ${report.updated.length} streams to Dispatcharr.`,
          );
        }
      })
      .catch((error) => {
        logger.warn("[Dispatcharr] Writing probe results failed:", errorToString(error));
        useAppStore
          .getState()
          .setMenuInfo(
            `Could not write probe results to Dispatcharr: ${errorToString(error)}`,
            "warn",
          );
      });
  }, [scanState]);
}
