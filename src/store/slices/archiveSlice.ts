import type { StateCreator } from "zustand";
import type { AppStore, ArchiveSlice } from "../types";

export const createArchiveSlice: StateCreator<AppStore, [], [], ArchiveSlice> = (set) => ({
  archiveProbes: {},

  setArchiveProbe: (index, entry) =>
    set((state) => ({ archiveProbes: { ...state.archiveProbes, [index]: entry } })),
  clearArchiveProbes: () => set({ archiveProbes: {} }),
});
