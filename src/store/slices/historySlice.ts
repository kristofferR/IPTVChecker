import type { StateCreator } from "zustand";
import type { AppStore, HistorySlice } from "../types";

export const createHistorySlice: StateCreator<AppStore, [], [], HistorySlice> = (set) => ({
  showHistory: false,
  historyEntries: [],
  historyLoading: false,
  historyError: null,
  historyClearing: false,

  setShowHistory: (showHistory) => set({ showHistory }),
  setHistoryEntries: (historyEntries) => set({ historyEntries }),
  setHistoryLoading: (historyLoading) => set({ historyLoading }),
  setHistoryError: (historyError) => set({ historyError }),
  setHistoryClearing: (historyClearing) => set({ historyClearing }),
});
