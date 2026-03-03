import { describe, expect, it } from "bun:test";
import { filterResults } from "../src/lib/filters";
import type { ChannelResult, ChannelStatus } from "../src/lib/types";

function makeResult(
  index: number,
  options: {
    name: string;
    playlist: string;
    group: string;
    status: ChannelStatus;
    audioOnly?: boolean;
  },
): ChannelResult {
  return {
    index,
    playlist: options.playlist,
    name: options.name,
    group: options.group,
    url: `https://example.com/${index}.m3u8`,
    status: options.status,
    codec: null,
    resolution: null,
    width: null,
    height: null,
    fps: null,
    latency_ms: null,
    video_bitrate: null,
    audio_bitrate: null,
    audio_codec: null,
    audio_only: options.audioOnly ?? false,
    screenshot_path: null,
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: `id-${index}`,
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
    stream_url: null,
    retry_count: null,
    last_error_reason: null,
  };
}

describe("filterResults", () => {
  const results = [
    makeResult(0, {
      name: "Sports HD",
      playlist: "Primary",
      group: "Sports",
      status: "alive",
    }),
    makeResult(1, {
      name: "Cinema One",
      playlist: "Movies",
      group: "Entertainment",
      status: "dead",
    }),
    makeResult(2, {
      name: "Sports Backup",
      playlist: "Primary",
      group: "Sports",
      status: "geoblocked_confirmed",
      audioOnly: true,
    }),
  ];

  it("filters by search across name, playlist, and group", () => {
    expect(filterResults(results, "sports", "all", "all").map((r) => r.index)).toEqual(
      [0, 2],
    );
    expect(filterResults(results, "movies", "all", "all").map((r) => r.index)).toEqual(
      [1],
    );
    expect(
      filterResults(results, "entertainment", "all", "all").map((r) => r.index),
    ).toEqual([1]);
  });

  it("filters by group and status including geoblocked umbrella", () => {
    expect(filterResults(results, "", "Sports", "all").map((r) => r.index)).toEqual([0, 2]);
    expect(filterResults(results, "", "all", "dead").map((r) => r.index)).toEqual([1]);
    expect(filterResults(results, "", "all", "geoblocked").map((r) => r.index)).toEqual(
      [2],
    );
  });

  it("supports duplicates status filter using duplicateIndices set", () => {
    const duplicateSet = new Set<number>([1, 2]);
    expect(
      filterResults(results, "", "all", "duplicates", duplicateSet).map((r) => r.index),
    ).toEqual([1, 2]);
  });

  it("supports audio-only status filter", () => {
    expect(filterResults(results, "", "all", "audio_only").map((r) => r.index)).toEqual(
      [2],
    );
  });
});
