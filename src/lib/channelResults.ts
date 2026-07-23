import type { Channel, ChannelResult } from "./types";

function pendingScanFields() {
  return {
    status: "pending" as const,
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
    stream_url: null,
    retry_count: null,
    error_reason: null,
    drm_system: null,
  };
}

// Keep frontend pending-result IDs aligned with the backend parser.
export function getChannelIdFromUrl(url: string): string {
  if (url.length === 0) {
    return "Unknown";
  }

  const segment = url.split("/").at(-1) ?? "Unknown";
  if (segment.length === 0) {
    return "Unknown";
  }

  return segment.replace(".ts", "");
}

export function getChannelErrorReason(
  result: Pick<ChannelResult, "error_reason">,
): string | null {
  return result.error_reason?.trim() || null;
}

export function getScreenshotErrorReason(
  result: Pick<ChannelResult, "screenshot_error_reason">,
): string | null {
  return result.screenshot_error_reason?.trim() || null;
}

export function toCommandChannelResult(result: ChannelResult): ChannelResult {
  return {
    ...result,
    error_reason: result.error_reason ?? null,
  };
}

export function toPendingChannelResult(channel: Channel): ChannelResult {
  return {
    ...channel,
    ...pendingScanFields(),
    channel_id: getChannelIdFromUrl(channel.url),
  };
}

export function resetChannelResultForRescan(
  result: ChannelResult,
): ChannelResult {
  return {
    ...result,
    ...pendingScanFields(),
  };
}
