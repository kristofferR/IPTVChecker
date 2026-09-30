import { describe, expect, it } from "bun:test";
import { resetChannelResultForRescan, toPendingChannelResult } from "../src/lib/channelResults";
import {
  clampSampleClipDuration,
  getSampleClipActions,
  withSampleClip,
} from "../src/lib/sampleClip";
import type { ChannelResult } from "../src/lib/types";
import { DEFAULT_SETTINGS } from "../src/store/slices/settingsSlice";

function makeResult(overrides: Partial<ChannelResult> = {}): ChannelResult {
  return {
    ...toPendingChannelResult({
      index: 3,
      playlist: "fixture.m3u8",
      name: "Channel 3",
      group: "News",
      language: null,
      tvg_id: null,
      tvg_name: null,
      tvg_logo: null,
      tvg_chno: null,
      url: "https://example.com/live/3.ts",
      content_type: "live",
      extinf_line: "#EXTINF:-1,Channel 3",
      metadata_lines: [],
    }),
    status: "alive",
    ...overrides,
  };
}

const idle = { capturing: false, scanActive: false, previewFailed: false };

describe("sample clip settings", () => {
  it("keeps auto-capture off with a five second default", () => {
    expect(DEFAULT_SETTINGS.auto_capture_sample_clips).toBe(false);
    expect(DEFAULT_SETTINGS.sample_clip_duration_secs).toBe(5);
  });

  it("clamps durations to five through ten seconds", () => {
    expect(clampSampleClipDuration(2)).toBe(5);
    expect(clampSampleClipDuration(7.4)).toBe(7);
    expect(clampSampleClipDuration(30)).toBe(10);
    expect(clampSampleClipDuration(Number.NaN)).toBe(5);
  });
});

describe("sample clip state", () => {
  it("records a manual capture on the result and clears it on rescan", () => {
    const captured = withSampleClip(makeResult(), {
      path: "/cache/4-Channel-3.mp4",
      format: "mp4",
    });
    expect(captured.sample_clip_path).toBe("/cache/4-Channel-3.mp4");
    expect(captured.sample_clip_format).toBe("mp4");

    const rescanned = resetChannelResultForRescan(captured);
    expect(rescanned.sample_clip_path).toBeNull();
    expect(rescanned.sample_clip_format).toBeNull();
  });

  it("offers capture only for alive channels outside a scan", () => {
    expect(getSampleClipActions(makeResult(), idle).canCapture).toBe(true);
    expect(getSampleClipActions(makeResult({ status: "dead" }), idle).visible).toBe(false);
    expect(getSampleClipActions(makeResult(), { ...idle, scanActive: true }).canCapture).toBe(
      false,
    );
    expect(getSampleClipActions(makeResult(), { ...idle, capturing: true }).canCapture).toBe(false);
  });

  it("keeps open and reveal when inline preview fails", () => {
    const result = makeResult({ sample_clip_path: "/cache/clip.mp4", sample_clip_format: "mp4" });
    const actions = getSampleClipActions(result, { ...idle, previewFailed: true });
    expect(actions.canPreview).toBe(false);
    expect(actions.canOpen).toBe(true);
  });

  it("plays MPEG-TS clips externally only", () => {
    const result = makeResult({ sample_clip_path: "/cache/clip.ts", sample_clip_format: "ts" });
    const actions = getSampleClipActions(result, idle);
    expect(actions.canPreview).toBe(false);
    expect(actions.canOpen).toBe(true);
  });

  it("keeps a saved clip reachable after the channel goes down", () => {
    const result = makeResult({ status: "dead", sample_clip_path: "/cache/clip.mp4" });
    const actions = getSampleClipActions(result, idle);
    expect(actions.visible).toBe(true);
    expect(actions.canCapture).toBe(false);
    expect(actions.canOpen).toBe(true);
  });
});
