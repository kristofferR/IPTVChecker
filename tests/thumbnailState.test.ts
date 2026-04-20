import { describe, expect, it } from "bun:test";
import { toPendingChannelResult } from "../src/lib/channelResults";
import { getThumbnailDisplayState } from "../src/lib/thumbnailState";
import type { Channel, ChannelResult } from "../src/lib/types";

function makeChannel(index = 1): Channel {
  return {
    index,
    playlist: "fixture.m3u8",
    name: `Channel ${index}`,
    group: "News",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: `https://example.com/live/${index}.ts`,
    content_type: "live",
    extinf_line: `#EXTINF:-1,Channel ${index}`,
    metadata_lines: [],
  };
}

function makeResult(overrides: Partial<ChannelResult> = {}): ChannelResult {
  return {
    ...toPendingChannelResult(makeChannel()),
    status: "alive",
    ...overrides,
  };
}

describe("thumbnail display state", () => {
  it("shows capture-failed state when a screenshot error reason is present", () => {
    const state = getThumbnailDisplayState({
      result: makeResult({ screenshot_error_reason: "ffmpeg exited with 1" }),
      screenshotUrl: null,
      screenshotLoading: false,
      screenshotLoadError: false,
      screenshotsEnabled: true,
      scanState: "complete",
    });

    expect(state.showCaptureError).toBe(true);
    expect(state.showNoThumbnailCaptured).toBe(false);
    expect(state.screenshotErrorReason).toBe("ffmpeg exited with 1");
  });

  it("shows no-thumbnail state only when no screenshot path or capture error exists", () => {
    const state = getThumbnailDisplayState({
      result: makeResult({
        screenshot_path: null,
        screenshot_error_reason: null,
      }),
      screenshotUrl: null,
      screenshotLoading: false,
      screenshotLoadError: false,
      screenshotsEnabled: true,
      scanState: "complete",
    });

    expect(state.showCaptureError).toBe(false);
    expect(state.showNoThumbnailCaptured).toBe(true);
  });
});
