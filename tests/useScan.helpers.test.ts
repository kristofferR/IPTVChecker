import { describe, expect, it } from "bun:test";
import {
  applyResultUpdates,
  type ScanResultCollections,
} from "../src/hooks/useScan.helpers";
import type { ChannelResult } from "../src/lib/types";

function buildResult(
  index: number,
  overrides: Partial<ChannelResult> = {},
): ChannelResult {
  return {
    index,
    playlist: "sample",
    name: `Channel ${index}`,
    group: "News",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: `http://example.com/${index}.m3u8`,
    content_type: "live",
    status: "pending",
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
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: `channel-${index}`,
    extinf_line: `#EXTINF:-1,Channel ${index}`,
    metadata_lines: [],
    stream_url: null,
    ...overrides,
  };
}

describe("useScan sparse result collections", () => {
  it("updates sparse lookup entries without requiring dense arrays", () => {
    const initialA = buildResult(8);
    const initialB = buildResult(107, { status: "alive" });
    const previous: ScanResultCollections = {
      resultsByIndex: {
        [initialA.index]: initialA,
        [initialB.index]: initialB,
      },
      flatResults: [initialA, initialB],
      indexToFlatPos: new Map([
        [initialA.index, 0],
        [initialB.index, 1],
      ]),
      metrics: {
        presentCount: 2,
        lowFpsCount: 0,
        mislabeledCount: 0,
      },
    };

    const updatedA = buildResult(8, {
      status: "dead",
      low_framerate: true,
      label_mismatches: ["codec"],
    });
    const addedC = buildResult(3005, { status: "alive" });
    const next = applyResultUpdates(previous, [updatedA, addedC]);

    expect(next.resultsByIndex[8]?.status).toBe("dead");
    expect(next.resultsByIndex[3005]?.status).toBe("alive");
    expect(next.flatResults.map((result) => result.index)).toEqual([8, 107, 3005]);
    expect(next.indexToFlatPos.get(3005)).toBe(2);
    expect(next.metrics.presentCount).toBe(3);
    expect(next.metrics.lowFpsCount).toBe(1);
    expect(next.metrics.mislabeledCount).toBe(1);
  });
});
