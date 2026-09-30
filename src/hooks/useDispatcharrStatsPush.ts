import { useEffect } from "react";
import { dispatcharrTarget, isDispatcharrPreview } from "../lib/dispatcharr";
import { errorToString } from "../lib/errors";
import { logger } from "../lib/logger";
import { dispatcharrPushStreamStats } from "../lib/tauri";
import type { ChannelResult, DispatcharrTarget } from "../lib/types";
import { useAppStore } from "../store";

// Pushes run one after another, so an older scan's results never land after
// a newer one's.
let pushQueue: Promise<void> = Promise.resolve();

/** When enabled in settings, write probe results into Dispatcharr's stream
 *  stats once a scan of a Dispatcharr source completes. */
export function useDispatcharrStatsPush() {
  useEffect(() => {
    // A store subscription sees every scan state change synchronously; an
    // effect could miss a short rescan's "scanning" and push stale rows.
    let previous = useAppStore.getState().scanState;
    // Result objects from before the scan: only rows the scan replaced are
    // pushed, so a partial rescan does not re-date older results.
    let before: ReadonlySet<ChannelResult> = new Set();
    return useAppStore.subscribe((state) => {
      const { scanState } = state;
      if (scanState === previous) return;
      const was = previous;
      previous = scanState;
      if (scanState === "scanning" && was !== "paused") {
        before = new Set(state.flatResults);
        return;
      }
      if (scanState !== "complete") return;
      const target = dispatcharrTarget(state.playlist);
      if (
        !state.settings.dispatcharr_write_stats ||
        !target ||
        !isDispatcharrPreview(state.playlist)
      ) {
        return;
      }
      const scanned = state.flatResults.filter((result) => !before.has(result));
      before = new Set();
      pushQueue = pushQueue.then(() => pushStats(target, scanned));
    });
  }, []);
}

async function pushStats(target: DispatcharrTarget, scanned: ChannelResult[]): Promise<void> {
  try {
    const report = await dispatcharrPushStreamStats(target, scanned);
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
      store.setMenuInfo(`Wrote probe results for ${report.updated.length} streams to Dispatcharr.`);
    }
  } catch (error) {
    logger.warn("[Dispatcharr] Writing probe results failed:", errorToString(error));
    useAppStore
      .getState()
      .setMenuInfo(`Could not write probe results to Dispatcharr: ${errorToString(error)}`, "warn");
  }
}
