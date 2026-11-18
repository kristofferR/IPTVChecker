import type { StateCreator } from "zustand";
import type { AppStore, SelectionSlice } from "../types";

export const createSelectionSlice: StateCreator<AppStore, [], [], SelectionSlice> = (set) => ({
  selectedChannel: null,
  selectedChannelIndices: [],
  selectedRowCount: 0,

  setSelectedChannel: (selectedChannel) => set({ selectedChannel }),
  setSelectedChannelIndices: (selectedChannelIndices, selectedRowCount) =>
    set({ selectedChannelIndices, selectedRowCount }),
});
