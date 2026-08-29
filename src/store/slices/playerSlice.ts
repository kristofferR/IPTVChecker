import type { StateCreator } from "zustand";
import type { AppStore, PlayerSlice } from "../types";

export const createPlayerSlice: StateCreator<AppStore, [], [], PlayerSlice> = (set) => ({
  playIntentActive: false,
  castActive: false,
  pendingPlaybackChannel: null,

  setPlayIntentActive: (playIntentActive) => set({ playIntentActive }),
  setCastActive: (castActive) => set({ castActive }),
  setPendingPlaybackChannel: (pendingPlaybackChannel) => set({ pendingPlaybackChannel }),
});
