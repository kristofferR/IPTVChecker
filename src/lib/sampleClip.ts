import type { ChannelResult, SampleClip } from "./types";

export const MIN_SAMPLE_CLIP_DURATION_SECS = 5;
export const MAX_SAMPLE_CLIP_DURATION_SECS = 10;

export function clampSampleClipDuration(value: number): number {
  if (!Number.isFinite(value)) return MIN_SAMPLE_CLIP_DURATION_SECS;
  return Math.min(
    MAX_SAMPLE_CLIP_DURATION_SECS,
    Math.max(MIN_SAMPLE_CLIP_DURATION_SECS, Math.round(value)),
  );
}

export function withSampleClip(result: ChannelResult, clip: SampleClip): ChannelResult {
  return { ...result, sample_clip_path: clip.path, sample_clip_format: clip.format };
}

export interface SampleClipActionState {
  capturing: boolean;
  scanActive: boolean;
  previewFailed: boolean;
}

/** Which sample clip controls the sidebar offers for a channel. Capturing
 * needs a live stream; a saved clip stays openable even if inline preview
 * fails or the channel has since gone down. Webviews cannot play raw
 * MPEG-TS, so those clips are external-only. */
export function getSampleClipActions(
  result: Pick<ChannelResult, "status" | "sample_clip_path" | "sample_clip_format">,
  { capturing, scanActive, previewFailed }: SampleClipActionState,
) {
  const hasClip = !!result.sample_clip_path;
  const alive = result.status === "alive";
  return {
    visible: alive || hasClip,
    canCapture: alive && !capturing && !scanActive,
    canPreview: hasClip && result.sample_clip_format !== "ts" && !previewFailed,
    canOpen: hasClip,
  };
}
