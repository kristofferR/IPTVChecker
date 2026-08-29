import type { StateCreator } from "zustand";
import type { AppStore, ArchiveSlice } from "../types";

export const createArchiveSlice: StateCreator<AppStore, [], [], ArchiveSlice> = (set) => ({
  archiveProbes: {},
  archiveProbeGeneration: 0,
  archiveGuideTestRunning: false,
  epgLoadSummary: null,
  archiveVerifyRun: null,
  verifyCatchupAfterScan: false,

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
  clearArchiveProbes: () =>
    set((state) => ({
      archiveProbes: {},
      archiveProbeGeneration: state.archiveProbeGeneration + 1,
      epgLoadSummary: null,
    })),
});
