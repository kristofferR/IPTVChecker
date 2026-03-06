import { describe, expect, it } from "bun:test";
import {
  getChannelErrorReason,
  getChannelIdFromUrl,
  resetChannelResultForRescan,
  toPendingChannelResult,
} from "../src/lib/channelResults";
import type { Channel, ChannelResult } from "../src/lib/types";

function makeChannel(url: string): Channel {
  return {
    index: 7,
    playlist: "fixture.m3u8",
    name: "Channel",
    group: "Group",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url,
    content_type: "live",
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
  };
}

function makeResult(): ChannelResult {
  return {
    ...toPendingChannelResult(makeChannel("https://example.com/live/123.ts")),
    status: "dead",
    codec: "h264",
    resolution: "1080p",
    width: 1920,
    height: 1080,
    fps: 30,
    latency_ms: 450,
    video_bitrate: "5000",
    audio_bitrate: "192",
    audio_codec: "aac",
    audio_only: true,
    screenshot_path: "/tmp/shot.png",
    label_mismatches: ["Group mismatch"],
    low_framerate: true,
    error_message: "Dead stream",
    stream_url: "https://cdn.example.com/live/123.m3u8",
    retry_count: 2,
    error_reason: "Timeout",
    last_error_reason: "Legacy",
    drm_system: "Widevine",
  };
}

describe("channelResults helpers", () => {
  it("matches backend channel ID extraction behavior", () => {
    expect(getChannelIdFromUrl("http://example.com/live/123.ts")).toBe("123");
    expect(getChannelIdFromUrl("http://example.com/live/stream")).toBe("stream");
    expect(getChannelIdFromUrl("")).toBe("Unknown");
    expect(getChannelIdFromUrl("http://example.com/live/")).toBe("Unknown");
  });

  it("creates pending channel results with backend-aligned IDs", () => {
    const pending = toPendingChannelResult(
      makeChannel("https://example.com/live/channel-42.ts"),
    );

    expect(pending.channel_id).toBe("channel-42");
    expect(pending.status).toBe("pending");
    expect(pending.codec).toBeNull();
    expect(pending.error_reason).toBeNull();
    expect(pending.last_error_reason).toBeNull();
    expect(pending.drm_system).toBeNull();
  });

  it("resets scanned results back to a clean pending state", () => {
    const reset = resetChannelResultForRescan(makeResult());

    expect(reset.status).toBe("pending");
    expect(reset.codec).toBeNull();
    expect(reset.audio_only).toBe(false);
    expect(reset.screenshot_path).toBeNull();
    expect(reset.label_mismatches).toEqual([]);
    expect(reset.retry_count).toBeNull();
    expect(reset.error_reason).toBeNull();
    expect(reset.last_error_reason).toBeNull();
    expect(reset.drm_system).toBeNull();
    expect(reset.channel_id).toBe("123");
  });

  it("prefers trimmed error_reason and falls back to legacy last_error_reason", () => {
    expect(getChannelErrorReason({ error_reason: " Timeout ", last_error_reason: "Legacy" })).toBe(
      "Timeout",
    );
    expect(getChannelErrorReason({ error_reason: " ", last_error_reason: " Legacy " })).toBe(
      "Legacy",
    );
    expect(getChannelErrorReason({ error_reason: null, last_error_reason: null })).toBeNull();
  });
});
