import type { StateCreator } from "zustand";
import type { AppStore, PlayerSlice } from "../types";

export const createPlayerSlice: StateCreator<AppStore, [], [], PlayerSlice> = (set) => ({
  playIntentActive: false,
  pendingPlaybackChannel: null,

  setPlayIntentActive: (playIntentActive) => set({ playIntentActive }),
  setPendingPlaybackChannel: (pendingPlaybackChannel) => set({ pendingPlaybackChannel }),
});
