import { describe, expect, it } from "bun:test";
import { sortResults } from "../src/lib/filters";
import type { ChannelResult } from "../src/lib/types";

function makeResult(
  index: number,
  videoBitrate: string | null,
  audioBitrate: string | null,
): ChannelResult {
  return {
    index,
    playlist: "fixture.m3u8",
    name: `Channel ${index}`,
    group: "Group",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: `https://example.com/${index}.m3u8`,
    content_type: "live",
    status: "alive",
    codec: null,
    resolution: null,
    width: null,
    height: null,
    fps: null,
    latency_ms: null,
    hdr_format: null,
    video_bitrate: videoBitrate,
    audio_bitrate: audioBitrate,
    audio_codec: null,
    audio_channel_layout: null,
    audio_only: false,
    screenshot_path: null,
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: `id-${index}`,
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
    stream_url: null,
    retry_count: null,
    error_reason: null,
    last_error_reason: null,
    drm_system: null,
  };
}

describe("sortResults bitrate/audio determinism", () => {
  const sample = [
    makeResult(0, "1200", "192"),
    makeResult(1, "800 kbps", "128 kbps"),
    makeResult(2, null, null),
    makeResult(3, "N/A", "Unknown"),
    makeResult(4, "malformed", "oops"),
  ];

  it("sorts bitrate ascending with invalid/missing values last and deterministic tie-breaks", () => {
    const sorted = sortResults(sample, "bitrate", "asc");
    expect(sorted.map((result) => result.index)).toEqual([1, 0, 2, 3, 4]);
  });

  it("sorts bitrate descending with invalid/missing values last and deterministic tie-breaks", () => {
    const sorted = sortResults(sample, "bitrate", "desc");
    expect(sorted.map((result) => result.index)).toEqual([0, 1, 4, 3, 2]);
  });

  it("sorts audio deterministically for malformed and missing values", () => {
    const sorted = sortResults(sample, "audio", "asc");
    expect(sorted.map((result) => result.index)).toEqual([1, 0, 2, 3, 4]);
  });

  it("sorts audio layouts by channel count", () => {
    const withLayouts: ChannelResult[] = [
      { ...makeResult(10, null, null), audio_channel_layout: "7.1" },
      { ...makeResult(11, null, null), audio_channel_layout: "5.1" },
      { ...makeResult(12, null, null), audio_channel_layout: null },
      { ...makeResult(13, null, null), audio_channel_layout: "6 ch" },
    ];

    const sorted = sortResults(withLayouts, "audio_layout", "asc");
    expect(sorted.map((result) => result.index)).toEqual([11, 13, 10, 12]);
  });
});
