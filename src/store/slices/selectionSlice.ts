import type { StateCreator } from "zustand";
import type { AppStore, SelectionSlice } from "../types";

export const createSelectionSlice: StateCreator<AppStore, [], [], SelectionSlice> = (set) => ({
  selectedChannel: null,
  selectedChannelIndices: [],

  setSelectedChannel: (selectedChannel) => set({ selectedChannel }),
  setSelectedChannelIndices: (selectedChannelIndices) => set({ selectedChannelIndices }),
});
