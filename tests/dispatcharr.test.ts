import { describe, expect, it } from "bun:test";
import {
  groupResultsByDispatcharrChannel,
  normalizeDispatcharrServer,
  parseDispatcharrIds,
} from "../src/lib/dispatcharr";
import type { ChannelResult } from "../src/lib/types";

function extinf(channel: number, stream: number, order: number, count: number, name: string) {
  return `#EXTINF:-1 group-title="News" x-dispatcharr-channel-id="${channel}" x-dispatcharr-stream-id="${stream}" x-dispatcharr-stream-order="${order}" x-dispatcharr-stream-count="${count}" x-dispatcharr-account="Provider \\"A\\"",${name}`;
}

function makeResult(index: number, extinfLine: string, name: string): ChannelResult {
  return {
    index,
    playlist: "fixture.m3u8",
    name,
    group: "News",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: `http://provider.example/live/${index}.ts`,
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
    channel_id: String(index),
    extinf_line: extinfLine,
    metadata_lines: [],
    stream_url: null,
    retry_count: null,
    error_reason: null,
    drm_system: null,
  };
}

describe("dispatcharr helpers", () => {
  it("parses embedded IDs and unescapes attribute values", () => {
    expect(parseDispatcharrIds(extinf(10, 101, 1, 3, "News One [2/3] Feed B"))).toEqual({
      channelId: 10,
      streamId: 101,
      streamOrder: 1,
      streamCount: 3,
      channelUuid: null,
      account: 'Provider "A"',
    });
    expect(parseDispatcharrIds('#EXTINF:-1 tvg-id="a",Plain')).toBeNull();
  });

  it("groups rows by channel in failover order and strips the stream suffix", () => {
    const groups = groupResultsByDispatcharrChannel([
      makeResult(0, extinf(10, 102, 1, 2, "News One [2/2] Feed B"), "News One [2/2] Feed B"),
      makeResult(1, extinf(20, 201, 0, 1, "Sports 2"), "Sports 2"),
      makeResult(2, extinf(10, 101, 0, 2, "News One [1/2] Feed A"), "News One [1/2] Feed A"),
      makeResult(3, "#EXTINF:-1,Plain", "Plain"),
    ]);
    expect(groups.map((group) => [group.channelId, group.name])).toEqual([
      [10, "News One"],
      [20, "Sports 2"],
    ]);
    expect(groups[0].streams.map((entry) => entry.ref.streamId)).toEqual([101, 102]);
  });

  it("reduces pasted Dispatcharr links to the server, keeping a path prefix", () => {
    expect(normalizeDispatcharrServer("http://dvr.example:9191/proxy/ts/stream/abc")).toBe(
      "http://dvr.example:9191",
    );
    expect(normalizeDispatcharrServer("https://example.com/dispatcharr/output/m3u?x=1")).toBe(
      "https://example.com/dispatcharr",
    );
    expect(normalizeDispatcharrServer("ftp://example.com")).toBeNull();
  });
});
