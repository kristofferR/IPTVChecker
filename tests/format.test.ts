import { describe, expect, it } from "bun:test";
import {
  formatAudioInfo,
  formatVideoInfo,
  statusBgColor,
  statusDotColor,
  statusIcon,
  statusLabel,
} from "../src/lib/format";
import type { ChannelResult } from "../src/lib/types";

function makeResult(
  overrides: Partial<ChannelResult> = {},
): ChannelResult {
  return {
    index: 0,
    playlist: "fixture.m3u8",
    name: "Channel",
    group: "Group",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: "https://example.com/live/0.m3u8",
    content_type: "live",
    status: "alive",
    codec: null,
    resolution: null,
    width: null,
    height: null,
    fps: null,
    latency_ms: null,
    hdr_format: null,
    video_bitrate: null,
    audio_bitrate: null,
    audio_codec: null,
    audio_channel_layout: null,
    audio_only: false,
    screenshot_path: null,
    screenshot_error_reason: null,
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: "0",
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
    stream_url: null,
    retry_count: null,
    error_reason: null,
    last_error_reason: null,
    drm_system: null,
    ...overrides,
  };
}

describe("format helpers", () => {
  it("returns consistent metadata for status helpers", () => {
    expect(statusLabel("geoblocked_confirmed")).toBe("Geoblocked (Confirmed)");
    expect(statusDotColor("drm")).toBe("bg-cyan-500");
    expect(statusBgColor("pending")).toContain("bg-zinc-500/10");
    expect(statusIcon("dead")).toBe("✕");
  });

  it("formats video info from resolution, fps, codec, HDR, and bitrate", () => {
    expect(
      formatVideoInfo(
        makeResult({
          resolution: "1080p",
          fps: 60,
          codec: "h264",
          hdr_format: "HDR10",
          video_bitrate: "5000 kbps",
        }),
      ),
    ).toBe("1080p60 h264 HDR10 (5000 kbps)");
  });

  it("formats audio info from any known bitrate, codec, or layout metadata", () => {
    expect(
      formatAudioInfo(
        makeResult({
          audio_bitrate: "192",
          audio_codec: "aac",
          audio_channel_layout: "5.1",
        }),
      ),
    ).toBe("192 kbps aac 5.1");
    expect(formatAudioInfo(makeResult({ audio_bitrate: "192", audio_codec: "Unknown" }))).toBe(
      "192 kbps",
    );
    expect(formatAudioInfo(makeResult({ audio_channel_layout: "7.1" }))).toBe("7.1");
  });
});
