import type { StateCreator } from "zustand";
import type { AppStore, ArchiveSlice } from "../types";

export const createArchiveSlice: StateCreator<AppStore, [], [], ArchiveSlice> = (set) => ({
  archiveProbes: {},
  archiveGuideTestRunning: false,
  epgLoadSummary: null,
  archiveVerifyRun: null,
  verifyCatchupAfterScan: false,

  setArchiveProbe: (index, entry) =>
    set((state) => ({ archiveProbes: { ...state.archiveProbes, [index]: entry } })),
  setArchiveGuideTestRunning: (archiveGuideTestRunning) => set({ archiveGuideTestRunning }),
  setEpgLoadSummary: (epgLoadSummary) => set({ epgLoadSummary }),
  setArchiveVerifyRun: (archiveVerifyRun) => set({ archiveVerifyRun }),
  setVerifyCatchupAfterScan: (verifyCatchupAfterScan) => set({ verifyCatchupAfterScan }),
  clearArchiveProbes: () => set({ archiveProbes: {}, epgLoadSummary: null }),
});
