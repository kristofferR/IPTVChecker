import type { StateCreator } from "zustand";
import type { AppStore, ArchiveSlice } from "../types";

export const createArchiveSlice: StateCreator<AppStore, [], [], ArchiveSlice> = (set) => ({
  archiveProbes: {},
  archiveProbeGeneration: 0,
  archiveGuideTestRunning: false,
  epgLoadSummary: null,
  archiveVerifyRun: null,
  verifyCatchupAfterScan: false,
  archiveDownloads: {},

  setArchiveProbe: (generation, index, entry) =>
    set((state) => {
      if (state.archiveProbeGeneration !== generation) {
        return state;
      }
      return { archiveProbes: { ...state.archiveProbes, [index]: entry } };
    }),
  setArchiveGuideTestRunning: (archiveGuideTestRunning) => set({ archiveGuideTestRunning }),
  setEpgLoadSummary: (epgLoadSummary) => set({ epgLoadSummary }),
  setArchiveVerifyRun: (archiveVerifyRun) => set({ archiveVerifyRun }),
  setVerifyCatchupAfterScan: (verifyCatchupAfterScan) => set({ verifyCatchupAfterScan }),
  upsertArchiveDownload: (download) =>
    set((state) => ({
      archiveDownloads: { ...state.archiveDownloads, [download.id]: download },
    })),
  patchArchiveDownload: (id, patch) =>
    set((state) => {
      const current = state.archiveDownloads[id];
      if (!current) return state;
      return { archiveDownloads: { ...state.archiveDownloads, [id]: { ...current, ...patch } } };
    }),
  removeArchiveDownload: (id) =>
    set((state) => {
      if (!(id in state.archiveDownloads)) return state;
      const { [id]: _removed, ...rest } = state.archiveDownloads;
      return { archiveDownloads: rest };
    }),
  clearArchiveProbes: () =>
    set((state) => ({
      archiveProbes: {},
      archiveProbeGeneration: state.archiveProbeGeneration + 1,
      epgLoadSummary: null,
    })),
});
