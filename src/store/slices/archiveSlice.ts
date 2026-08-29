import type { StateCreator } from "zustand";
import type { AppStore, ArchiveSlice } from "../types";

export const createArchiveSlice: StateCreator<AppStore, [], [], ArchiveSlice> = (set) => ({
  archiveProbes: {},
  epgLoadSummary: null,
  archiveVerifyRun: null,
  verifyCatchupAfterScan: false,

  setArchiveProbe: (index, entry) =>
    set((state) => ({ archiveProbes: { ...state.archiveProbes, [index]: entry } })),
  setEpgLoadSummary: (epgLoadSummary) => set({ epgLoadSummary }),
  setArchiveVerifyRun: (archiveVerifyRun) => set({ archiveVerifyRun }),
  setVerifyCatchupAfterScan: (verifyCatchupAfterScan) => set({ verifyCatchupAfterScan }),
  clearArchiveProbes: () => set({ archiveProbes: {}, epgLoadSummary: null }),
});
