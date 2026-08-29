import type { StateCreator } from "zustand";
import type { AppStore, ArchiveSlice } from "../types";

export const createArchiveSlice: StateCreator<AppStore, [], [], ArchiveSlice> = (set) => ({
  archiveProbes: {},
  epgLoadSummary: null,

  setArchiveProbe: (index, entry) =>
    set((state) => ({ archiveProbes: { ...state.archiveProbes, [index]: entry } })),
  setEpgLoadSummary: (epgLoadSummary) => set({ epgLoadSummary }),
  clearArchiveProbes: () => set({ archiveProbes: {}, epgLoadSummary: null }),
});
