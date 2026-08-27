import type { StreamMetadata } from "./playback";
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

export function getChannelErrorReason(result: Pick<ChannelResult, "error_reason">): string | null {
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

export function getLabelMismatches(channelName: string, resolution: string): string[] {
  const normalizedName = channelName.normalize("NFKC").toLowerCase();

  if (normalizedName.includes("4k") || normalizedName.includes("uhd")) {
    return resolution === "4K" ? [] : [`Expected 4K, got ${resolution}`];
  }
  if (normalizedName.includes("1080p") || normalizedName.includes("fhd")) {
    return resolution === "1080p" ? [] : [`Expected 1080p, got ${resolution}`];
  }
  if (/(^|[^a-z0-9])hd([^a-z0-9]|$)/.test(normalizedName)) {
    return resolution === "1080p" || resolution === "720p"
      ? []
      : [`Expected 720p or 1080p, got ${resolution}`];
  }
  return resolution === "4K" ? ["4K channel not labeled as such"] : [];
}

/** Apply facts established by successful in-app playback without replacing
 * richer values from a previous backend scan. */
export function mergeSuccessfulPlaybackResult(
  result: ChannelResult,
  metadata: StreamMetadata | null,
  lowFpsThreshold: number,
): ChannelResult {
  let changed = result.status !== "alive";
  const updated: ChannelResult = changed ? { ...result, status: "alive" } : { ...result };

  if (!metadata) return changed ? updated : result;

  const mergeMissing = <Key extends keyof ChannelResult>(
    key: Key,
    value: ChannelResult[Key] | null,
  ) => {
    if (value != null && result[key] == null) {
      updated[key] = value;
      changed = true;
    }
  };

  mergeMissing("width", metadata.width);
  mergeMissing("height", metadata.height);
  mergeMissing("resolution", metadata.resolution);
  mergeMissing("codec", metadata.codec);
  mergeMissing("fps", metadata.fps);
  mergeMissing("latency_ms", metadata.latencyMs);
  mergeMissing("hdr_format", metadata.hdrFormat);
  mergeMissing("video_bitrate", metadata.videoBitrate);
  mergeMissing("audio_codec", metadata.audioCodec);
  mergeMissing("audio_bitrate", metadata.audioBitrate);
  mergeMissing("audio_channel_layout", metadata.audioChannelLayout);

  if (metadata.audioOnly && !result.audio_only) {
    updated.audio_only = true;
    changed = true;
  }

  if (result.fps == null && metadata.fps != null) {
    updated.low_framerate = metadata.fps <= lowFpsThreshold;
  }
  if (result.resolution == null && metadata.resolution && result.label_mismatches.length === 0) {
    const labelMismatches = getLabelMismatches(result.name, metadata.resolution);
    if (labelMismatches.length > 0) {
      updated.label_mismatches = labelMismatches;
    }
  }

  return changed ? updated : result;
}

export function resetChannelResultForRescan(result: ChannelResult): ChannelResult {
  return {
    ...result,
    ...pendingScanFields(),
  };
}
