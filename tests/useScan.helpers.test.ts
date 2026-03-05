import { describe, expect, it } from "bun:test";
import {
  applyResultBatch,
  isRunScopedEventForActiveRun,
} from "../src/hooks/useScan.helpers";
import type { ChannelResult } from "../src/lib/types";

function makeResult(index: number, name = `Channel ${index}`): ChannelResult {
  return {
    index,
    playlist: "fixture.m3u8",
    name,
    group: "Group",
    language: null,
    url: `https://example.com/${index}.m3u8`,
    content_type: "live",
    status: "alive",
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
    retry_count: null,
    error_reason: null,
  };
}

describe("useScan helpers", () => {
  it("matches only events for the active run", () => {
    expect(isRunScopedEventForActiveRun("run-a", "run-a")).toBe(true);
    expect(isRunScopedEventForActiveRun("run-a", "run-b")).toBe(false);
    expect(isRunScopedEventForActiveRun(null, "run-a")).toBe(false);
  });

  it("applies batched channel results by index", () => {
    const previous: (ChannelResult | null)[] = [makeResult(0), null, makeResult(2)];
    const batch = [makeResult(1, "Updated 1"), makeResult(2, "Updated 2")];

    const updated = applyResultBatch(previous, batch);

    expect(updated[0]?.name).toBe("Channel 0");
    expect(updated[1]?.name).toBe("Updated 1");
    expect(updated[2]?.name).toBe("Updated 2");
    expect(updated).not.toBe(previous);
  });
});
