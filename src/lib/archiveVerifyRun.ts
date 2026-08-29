import { useAppStore } from "../store";
import { hasArchive } from "./archive";
import { verifyChannelArchive } from "./archiveVerification";

let bulkRunActive = false;
let bulkCancelRequested = false;

export function cancelArchiveVerification(): void {
  bulkCancelRequested = true;
}

/** Verify every catch-up channel sequentially, with progress in the store. */
export async function verifyAllArchives(): Promise<void> {
  if (bulkRunActive) {
    return;
  }
  const targets = useAppStore.getState().flatResults.filter(hasArchive);
  if (targets.length === 0) {
    return;
  }
  bulkRunActive = true;
  bulkCancelRequested = false;
  const setProgress = (done: number) =>
    useAppStore.getState().setArchiveVerifyRun({ running: true, done, total: targets.length });
  setProgress(0);
  try {
    let done = 0;
    for (const target of targets) {
      if (bulkCancelRequested) {
        break;
      }
      await verifyChannelArchive(target, (entry) =>
        useAppStore.getState().setArchiveProbe(target.index, entry),
      );
      done += 1;
      setProgress(done);
    }
  } finally {
    useAppStore.getState().setArchiveVerifyRun(null);
    bulkRunActive = false;
  }
}
