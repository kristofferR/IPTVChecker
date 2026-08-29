import { useAppStore } from "../store";
import { hasArchive } from "./archive";
import { verifyChannelArchive } from "./archiveVerification";
import { isSingleConnectionPlaylist } from "./playback";
import { isScanActive } from "./scanState";

let bulkRunActive = false;
let bulkCancelRequested = false;
let bulkAbortController: AbortController | null = null;

export function cancelArchiveVerification(): void {
  bulkCancelRequested = true;
  bulkAbortController?.abort();
}

export function isArchiveVerificationBlockingPlayback(): boolean {
  const state = useAppStore.getState();
  return (
    (state.archiveVerifyRun != null ||
      state.archiveGuideTestRunning ||
      Object.values(state.archiveProbes).some((entry) => entry.running)) &&
    isSingleConnectionPlaylist(state.playlist)
  );
}

/** Verify every catch-up channel sequentially, with progress in the store. */
export async function verifyAllArchives(): Promise<void> {
  const initialState = useAppStore.getState();
  const playlist = initialState.playlist;
  const generation = initialState.archiveProbeGeneration;
  const singleConnection = isSingleConnectionPlaylist(playlist);
  if (
    bulkRunActive ||
    isScanActive(initialState.scanState) ||
    initialState.archiveGuideTestRunning ||
    Object.values(initialState.archiveProbes).some((entry) => entry.running) ||
    ((initialState.playIntentActive || initialState.castActive) && singleConnection)
  ) {
    return;
  }
  if (
    initialState.externalPlaybackActive &&
    singleConnection &&
    !window.confirm("Close the external player before verifying catch-up. Continue?")
  ) {
    return;
  }
  initialState.setVerifyCatchupAfterScan(false);
  if (singleConnection) {
    initialState.setExternalPlaybackActive(false);
  }
  const targets = initialState.flatResults.filter(hasArchive);
  if (targets.length === 0) {
    return;
  }
  bulkRunActive = true;
  bulkCancelRequested = false;
  const abortController = new AbortController();
  bulkAbortController = abortController;
  const setProgress = (done: number) =>
    useAppStore.getState().setArchiveVerifyRun({ running: true, done, total: targets.length });
  const shouldCancel = () => {
    const state = useAppStore.getState();
    return (
      bulkCancelRequested ||
      state.archiveProbeGeneration !== generation ||
      isScanActive(state.scanState) ||
      ((state.playIntentActive || state.castActive || state.externalPlaybackActive) &&
        singleConnection)
    );
  };
  setProgress(0);
  try {
    let done = 0;
    for (const target of targets) {
      if (shouldCancel()) {
        break;
      }
      await verifyChannelArchive(
        target,
        (entry) => {
          useAppStore.getState().setArchiveProbe(generation, target.index, entry);
        },
        shouldCancel,
        abortController.signal,
      );
      if (shouldCancel()) break;
      done += 1;
      setProgress(done);
    }
  } finally {
    useAppStore.getState().setArchiveVerifyRun(null);
    bulkRunActive = false;
    if (bulkAbortController === abortController) {
      bulkAbortController = null;
    }
  }
}
