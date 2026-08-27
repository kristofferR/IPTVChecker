import { describe, expect, it } from "bun:test";
import {
  getChannelErrorReason,
  getChannelIdFromUrl,
  getLabelMismatches,
  getScreenshotErrorReason,
  mergeSuccessfulPlaybackResult,
  resetChannelResultForRescan,
  toCommandChannelResult,
  toPendingChannelResult,
} from "../src/lib/channelResults";
import type { StreamMetadata } from "../src/lib/playback";
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
    hdr_format: "HDR10",
    video_bitrate: "5000",
    audio_bitrate: "192",
    audio_codec: "aac",
    audio_channel_layout: "5.1",
    audio_only: true,
    screenshot_path: "/tmp/shot.png",
    screenshot_error_reason: null,
    label_mismatches: ["Group mismatch"],
    low_framerate: true,
    error_message: "Dead stream",
    stream_url: "https://cdn.example.com/live/123.m3u8",
    retry_count: 2,
    error_reason: "Timeout",
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
    const pending = toPendingChannelResult(makeChannel("https://example.com/live/channel-42.ts"));

    expect(pending.channel_id).toBe("channel-42");
    expect(pending.status).toBe("pending");
    expect(pending.codec).toBeNull();
    expect(pending.error_reason).toBeNull();
    expect(pending.drm_system).toBeNull();
  });

  it("promotes a successfully played pending channel and merges player metadata", () => {
    const pending = toPendingChannelResult(makeChannel("https://example.com/live/channel-42.ts"));
    const metadata: StreamMetadata = {
      width: 1920,
      height: 1080,
      resolution: "1080p",
      codec: "H264",
      fps: 22,
      latencyMs: 840,
      hdrFormat: "HDR10",
      videoBitrate: "5.0 Mbps",
      audioCodec: "AAC",
      audioBitrate: "192",
      audioChannelLayout: "6 ch",
      audioOnly: false,
    };

    const played = mergeSuccessfulPlaybackResult(pending, metadata, 23);

    expect(played).toMatchObject({
      status: "alive",
      width: 1920,
      height: 1080,
      resolution: "1080p",
      codec: "H264",
      fps: 22,
      latency_ms: 840,
      hdr_format: "HDR10",
      video_bitrate: "5.0 Mbps",
      audio_codec: "AAC",
      audio_bitrate: "192",
      audio_channel_layout: "6 ch",
      low_framerate: true,
    });
  });

  it("marks successful playback alive even when the player exposes no metadata", () => {
    const pending = toPendingChannelResult(makeChannel("https://example.com/live/channel-42.ts"));

    expect(mergeSuccessfulPlaybackResult(pending, null, 23).status).toBe("alive");
  });

  it("retains audio-only information discovered during playback", () => {
    const pending = toPendingChannelResult(makeChannel("https://example.com/live/radio.ts"));
    const metadata: StreamMetadata = {
      width: null,
      height: null,
      resolution: null,
      codec: null,
      fps: null,
      latencyMs: 420,
      hdrFormat: null,
      videoBitrate: null,
      audioCodec: "AAC",
      audioBitrate: "128",
      audioChannelLayout: "Stereo",
      audioOnly: true,
    };

    expect(mergeSuccessfulPlaybackResult(pending, metadata, 23)).toMatchObject({
      status: "alive",
      latency_ms: 420,
      audio_codec: "AAC",
      audio_bitrate: "128",
      audio_channel_layout: "Stereo",
      audio_only: true,
    });
  });

  it("keeps richer scan metadata when playback reports different values", () => {
    const scanned = { ...makeResult(), status: "alive" as const };
    const metadata: StreamMetadata = {
      width: 1280,
      height: 720,
      resolution: "720p",
      codec: "HEVC",
      fps: 25,
      latencyMs: 310,
      hdrFormat: null,
      videoBitrate: "2.5 Mbps",
      audioCodec: "AC3",
      audioBitrate: "128",
      audioChannelLayout: "Stereo",
      audioOnly: false,
    };

    expect(mergeSuccessfulPlaybackResult(scanned, metadata, 23)).toBe(scanned);
  });

  it("derives the same quality-label mismatches as backend scans", () => {
    expect(getLabelMismatches("Sports HD", "480p")).toEqual(["Expected 720p or 1080p, got 480p"]);
    expect(getLabelMismatches("Shahd Channel", "480p")).toEqual([]);
    expect(getLabelMismatches("Movie ᵁᴴᴰ ³⁸⁴⁰ᴾ", "1080p")).toEqual(["Expected 4K, got 1080p"]);
  });

  it("resets scanned results back to a clean pending state", () => {
    const reset = resetChannelResultForRescan(makeResult());

    expect(reset.status).toBe("pending");
    expect(reset.codec).toBeNull();
    expect(reset.hdr_format).toBeNull();
    expect(reset.audio_channel_layout).toBeNull();
    expect(reset.audio_only).toBe(false);
    expect(reset.screenshot_path).toBeNull();
    expect(reset.screenshot_error_reason).toBeNull();
    expect(reset.label_mismatches).toEqual([]);
    expect(reset.retry_count).toBeNull();
    expect(reset.error_reason).toBeNull();
    expect(reset.drm_system).toBeNull();
    expect(reset.channel_id).toBe("123");
  });

  it("returns a trimmed error_reason or null", () => {
    expect(getChannelErrorReason({ error_reason: " Timeout " })).toBe("Timeout");
    expect(getChannelErrorReason({ error_reason: " " })).toBeNull();
    expect(getChannelErrorReason({ error_reason: null })).toBeNull();
  });

  it("returns a trimmed screenshot error reason when present", () => {
    expect(getScreenshotErrorReason({ screenshot_error_reason: " ffmpeg exited with 1 " })).toBe(
      "ffmpeg exited with 1",
    );
    expect(getScreenshotErrorReason({ screenshot_error_reason: null })).toBeNull();
  });

  it("normalizes an absent error reason to null for backend commands", () => {
    const current = toCommandChannelResult(makeResult());
    expect(current.error_reason).toBe("Timeout");

    const missing = toCommandChannelResult({
      ...makeResult(),
      error_reason: undefined,
    });
    expect(missing.error_reason).toBeNull();
  });
});
