import type { StateCreator } from "zustand";
import type { AppStore, PlayerSlice } from "../types";

export const createPlayerSlice: StateCreator<AppStore, [], [], PlayerSlice> = (set) => ({
  playIntentActive: false,
  castActive: false,
  externalPlaybackActive: false,
  pendingPlaybackChannel: null,
  sampleCaptureActive: false,

  setPlayIntentActive: (playIntentActive) => set({ playIntentActive }),
  setCastActive: (castActive) => set({ castActive }),
  setExternalPlaybackActive: (externalPlaybackActive) => set({ externalPlaybackActive }),
  setPendingPlaybackChannel: (pendingPlaybackChannel) => set({ pendingPlaybackChannel }),
  setSampleCaptureActive: (sampleCaptureActive) => set({ sampleCaptureActive }),
});
