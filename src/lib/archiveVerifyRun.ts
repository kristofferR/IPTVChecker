import { useAppStore } from "../store";
import { hasArchive } from "./archive";
import { isArchiveDownloadRunning } from "./archiveDownload";
import {
  type ArchiveVerifyMode,
  archiveVerdict,
  verifyChannelArchive,
} from "./archiveVerification";
import { isSingleConnectionPlaylist } from "./playback";
import { isScanActive } from "./scanState";
import type { ChannelResult } from "./types";

export interface ArchiveVerifyRun {
  running: boolean;
  mode: ArchiveVerifyMode;
  done: number;
  total: number;
  real: number;
  shallower: number;
  fake: number;
  /** Wall-clock start, for throughput and ETA. */
  startedAtMs: number;
}

const VERIFY_MODE_STORAGE_KEY = "catchup-verify-mode";

export function readArchiveVerifyMode(): ArchiveVerifyMode {
  try {
    return localStorage.getItem(VERIFY_MODE_STORAGE_KEY) === "full" ? "full" : "quick";
  } catch {
    return "quick";
  }
}

export function storeArchiveVerifyMode(mode: ArchiveVerifyMode): void {
  try {
    localStorage.setItem(VERIFY_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference only; nothing to recover.
  }
}

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
      isArchiveDownloadRunning(state.archiveDownloads) ||
      Object.values(state.archiveProbes).some((entry) => entry.running)) &&
    isSingleConnectionPlaylist(state.playlist)
  );
}

/** Verify every catch-up channel in the loaded playlist. */
export function verifyAllArchives(mode: ArchiveVerifyMode = readArchiveVerifyMode()): Promise<void> {
  return verifyArchives(useAppStore.getState().flatResults, mode);
}

/**
 * Verify the catch-up channels among `candidates` sequentially (provider
 * connection limits), keeping a live tally in the store.
 */
export async function verifyArchives(
  candidates: ChannelResult[],
  mode: ArchiveVerifyMode = readArchiveVerifyMode(),
): Promise<void> {
  const initialState = useAppStore.getState();
  const playlist = initialState.playlist;
  const generation = initialState.archiveProbeGeneration;
  const singleConnection = isSingleConnectionPlaylist(playlist);
  if (
    bulkRunActive ||
    isScanActive(initialState.scanState) ||
    initialState.archiveGuideTestRunning ||
    Object.values(initialState.archiveProbes).some((entry) => entry.running) ||
    (isArchiveDownloadRunning(initialState.archiveDownloads) && singleConnection) ||
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
  const targets = candidates.filter(hasArchive);
  if (targets.length === 0) {
    return;
  }
  bulkRunActive = true;
  bulkCancelRequested = false;
  const abortController = new AbortController();
  bulkAbortController = abortController;
  const unsubscribeGeneration = useAppStore.subscribe((state, previousState) => {
    if (
      state.archiveProbeGeneration !== generation &&
      state.archiveProbeGeneration !== previousState.archiveProbeGeneration
    ) {
      abortController.abort();
    }
  });
  const run: ArchiveVerifyRun = {
    running: true,
    mode,
    done: 0,
    total: targets.length,
    real: 0,
    shallower: 0,
    fake: 0,
    startedAtMs: Date.now(),
  };
  const publish = () => useAppStore.getState().setArchiveVerifyRun({ ...run });
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
  publish();
  try {
    for (const target of targets) {
      if (shouldCancel()) {
        break;
      }
      const entry = await verifyChannelArchive(
        target,
        (update) => {
          useAppStore.getState().setArchiveProbe(generation, target.index, update);
        },
        shouldCancel,
        abortController.signal,
        mode,
      );
      if (shouldCancel()) break;
      run.done += 1;
      switch (archiveVerdict(target, entry)) {
        case "verified":
          run.real += 1;
          break;
        case "shallower":
          run.shallower += 1;
          break;
        case "fake":
          run.fake += 1;
          break;
        default:
          break;
      }
      publish();
    }
  } finally {
    unsubscribeGeneration();
    useAppStore.getState().setArchiveVerifyRun(null);
    bulkRunActive = false;
    if (bulkAbortController === abortController) {
      bulkAbortController = null;
    }
  }
}
