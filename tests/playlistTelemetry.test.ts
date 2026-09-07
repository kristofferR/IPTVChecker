import { afterEach, describe, expect, test } from "bun:test";
import { PlaybackRecorder, playbackTelemetry } from "../src/lib/playbackTelemetry";
import type { PlaylistPreview } from "../src/lib/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    length: 0,
    clear() {},
    getItem: () => null,
    key: () => null,
    removeItem() {},
    setItem() {},
  } satisfies Storage,
});
const { useAppStore } = await import("../src/store");

const preview: PlaylistPreview = {
  file_path: "/cache/provider.m3u8",
  file_name: "Provider",
  source_identity: "url:provider",
  saved_playlist_id: null,
  server_location: null,
  single_provider: true,
  xtream_max_connections: 1,
  xtream_account_info: null,
  total_channels: 0,
  live_count: 0,
  movie_count: 0,
  series_count: 0,
  groups: [],
  epg_sources: [],
  epg_sources_by_playlist: {},
  channels: [],
};

function startSession() {
  const recorder = new PlaybackRecorder({
    id: "playlist-session",
    channelIndex: 1,
    channelName: "News",
    mode: "live",
    streamType: "hls",
    appVersion: "test",
    platform: "linux",
  });
  playbackTelemetry.start(recorder);
  return recorder;
}

afterEach(() => {
  useAppStore.getState().setPlaylist(null);
  playbackTelemetry.clear();
});

describe("playlist playback diagnostics", () => {
  test("metadata and visibility updates preserve the active recorder and completed summary", () => {
    const { setPlaylist } = useAppStore.getState();
    setPlaylist(preview);
    const recorder = startSession();
    setPlaylist({ ...preview, file_name: "Renamed", saved_playlist_id: "saved-1" });
    setPlaylist({ ...preview, channels: [], groups: ["Live"] });
    setPlaylist({ ...preview, file_path: "/cache/refreshed.m3u8" });
    expect(recorder.ended).toBe(false);
    recorder.firstFrame();
    playbackTelemetry.publish();
    expect(playbackTelemetry.get(1)?.summary.firstFrameMs).toBeNumber();
    playbackTelemetry.finish("stopped");
    const completed = playbackTelemetry.get(1);
    setPlaylist({ ...preview, file_name: "Renamed again" });
    expect(playbackTelemetry.get(1)).toBe(completed);
  });

  test("changing source clears diagnostics even when the cache path stays the same", () => {
    const { setPlaylist } = useAppStore.getState();
    setPlaylist(preview);
    const recorder = startSession();
    setPlaylist({ ...preview, source_identity: "url:other-provider" });
    expect(recorder.ended).toBe(true);
    expect(playbackTelemetry.get(1)).toBeNull();
  });

  test("local playlists use the file path and closing the playlist clears diagnostics", () => {
    const { setPlaylist } = useAppStore.getState();
    const local = { ...preview, source_identity: null };
    setPlaylist(local);
    const recorder = startSession();
    setPlaylist({ ...local, file_name: "Local rename" });
    expect(recorder.ended).toBe(false);
    setPlaylist({ ...local, file_path: "/other.m3u8" });
    expect(recorder.ended).toBe(true);
    expect(playbackTelemetry.get(1)).toBeNull();
    const next = startSession();
    setPlaylist(null);
    expect(next.ended).toBe(true);
    expect(playbackTelemetry.getSummaries()).toHaveLength(0);
  });
});
