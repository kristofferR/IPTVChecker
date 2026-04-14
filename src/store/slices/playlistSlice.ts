import type { StateCreator } from "zustand";
import type { AppStore, PlaylistSlice } from "../types";

export const createPlaylistSlice: StateCreator<AppStore, [], [], PlaylistSlice> = (set) => ({
  playlist: null,
  cachedSourcePreview: null,
  playlistLoading: false,
  playlistLoadProgress: null,
  playlistOpenError: null,
  recentPlaylists: [],
  savedPlaylists: [],
  currentSourceDescriptor: null,
  lastAppliedSourceFilter: "",

  setPlaylist: (playlist) => set({ playlist }),
  setCachedSourcePreview: (cachedSourcePreview) => set({ cachedSourcePreview }),
  setPlaylistLoading: (playlistLoading) => set({ playlistLoading }),
  setPlaylistLoadProgress: (playlistLoadProgress) => set({ playlistLoadProgress }),
  setPlaylistOpenError: (playlistOpenError) => set({ playlistOpenError }),
  setRecentPlaylists: (recentPlaylists) => set({ recentPlaylists }),
  setSavedPlaylists: (savedPlaylists) => set({ savedPlaylists }),
  setCurrentSourceDescriptor: (currentSourceDescriptor) => set({ currentSourceDescriptor }),
  setLastAppliedSourceFilter: (lastAppliedSourceFilter) => set({ lastAppliedSourceFilter }),
});
