import { describe, expect, it } from "bun:test";
import { findDuplicateChannelIndices } from "../src/lib/duplicates";
import type { ChannelResult } from "../src/lib/types";

function makeResult(index: number, url: string): ChannelResult {
  return {
    index,
    playlist: "fixture.m3u",
    name: `Channel ${index}`,
    group: "Group",
    url,
    status: "pending",
    codec: null,
    resolution: null,
    width: null,
    height: null,
    fps: null,
    latency_ms: null,
    video_bitrate: null,
    audio_bitrate: null,
    audio_codec: null,
    audio_only: false,
    screenshot_path: null,
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: `id-${index}`,
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
    stream_url: null,
  };
}

describe("findDuplicateChannelIndices", () => {
  it("matches duplicates across default ports, hash, query order, and trailing slash", () => {
    const results = [
      makeResult(0, "HTTP://Example.com:80/live/stream.m3u8/?b=2&a=1#section"),
      makeResult(1, "http://example.com/live/stream.m3u8?a=1&b=2"),
      makeResult(2, "https://example.com/live/stream.m3u8?a=1&b=2"),
    ];

    expect(Array.from(findDuplicateChannelIndices(results)).sort((a, b) => a - b)).toEqual([
      0,
      1,
    ]);
  });

  it("normalizes unreserved percent encoding in path and query", () => {
    const results = [
      makeResult(0, "https://cdn.example.com/%7Euser/live%41.m3u8?token=%7eabc"),
      makeResult(1, "https://cdn.example.com/~user/liveA.m3u8?token=~abc"),
    ];

    expect(Array.from(findDuplicateChannelIndices(results))).toEqual([0, 1]);
  });

  it("keeps reserved encoding differences distinct", () => {
    const results = [
      makeResult(0, "https://example.com/channel%2Fhd.m3u8"),
      makeResult(1, "https://example.com/channel/hd.m3u8"),
    ];

    expect(findDuplicateChannelIndices(results).size).toBe(0);
  });

  it("still detects duplicates for trimmed non-URL strings", () => {
    const results = [makeResult(0, " not a url "), makeResult(1, "not a url")];

    expect(Array.from(findDuplicateChannelIndices(results))).toEqual([0, 1]);
  });
});
