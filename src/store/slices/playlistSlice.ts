import type { StateCreator } from "zustand";
import type { AppStore, PlaylistSlice } from "../types";

export const createPlaylistSlice: StateCreator<AppStore, [], [], PlaylistSlice> = (set) => ({
  playlist: null,
  playlistLoading: false,
  playlistOpenError: null,
  recentPlaylists: [],

  setPlaylist: (playlist) => set({ playlist }),
  setPlaylistLoading: (playlistLoading) => set({ playlistLoading }),
  setPlaylistOpenError: (playlistOpenError) => set({ playlistOpenError }),
  setRecentPlaylists: (recentPlaylists) => set({ recentPlaylists }),
});
