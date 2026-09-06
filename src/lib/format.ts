import type { ChannelResult, ChannelStatus } from "./types";

const STATUS_METADATA: Record<
  ChannelStatus,
  {
    label: string;
    color: string;
    background: string;
    icon: string;
    dot: string;
  }
> = {
  alive: {
    label: "Alive",
    color: "text-green-400",
    background: "bg-green-500/10 text-green-400 border-green-500/20",
    icon: "✓",
    dot: "bg-green-500",
  },
  drm: {
    label: "DRM",
    color: "text-cyan-400",
    background: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
    icon: "⚿",
    dot: "bg-cyan-500",
  },
  dead: {
    label: "Dead",
    color: "text-red-400",
    background: "bg-red-500/10 text-red-400 border-red-500/20",
    icon: "✕",
    dot: "bg-red-500",
  },
  placeholder: {
    label: "Placeholder",
    color: "text-orange-400",
    background: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    icon: "▪",
    dot: "bg-orange-500",
  },
  geoblocked: {
    label: "Geoblocked",
    color: "text-yellow-400",
    background: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    icon: "🔒",
    dot: "bg-yellow-500",
  },
  geoblocked_confirmed: {
    label: "Geoblocked (Confirmed)",
    color: "text-yellow-400",
    background: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    icon: "🔒",
    dot: "bg-yellow-500",
  },
  geoblocked_unconfirmed: {
    label: "Geoblocked (Unconfirmed)",
    color: "text-yellow-400",
    background: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    icon: "🔒",
    dot: "bg-yellow-500",
  },
  checking: {
    label: "Checking...",
    color: "text-blue-400",
    background: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    icon: "⟳",
    dot: "bg-blue-500",
  },
  pending: {
    label: "Pending",
    color: "text-text-tertiary",
    background: "bg-zinc-500/10 text-text-tertiary border-zinc-500/20",
    icon: "·",
    dot: "bg-zinc-400",
  },
};

export function statusLabel(status: ChannelStatus): string {
  return STATUS_METADATA[status].label;
}

export function statusColor(status: ChannelStatus): string {
  return STATUS_METADATA[status].color;
}

export function statusBgColor(status: ChannelStatus): string {
  return STATUS_METADATA[status].background;
}

export function statusIcon(status: ChannelStatus): string {
  return STATUS_METADATA[status].icon;
}

export function formatVideoInfo(result: ChannelResult): string {
  const parts: string[] = [];
  if (result.resolution && result.resolution !== "Unknown") {
    const res = result.fps ? `${result.resolution}${result.fps}` : result.resolution;
    parts.push(res);
  }
  if (result.codec && result.codec !== "Unknown") {
    parts.push(result.codec);
  }
  if (result.hdr_format) {
    parts.push(result.hdr_format);
  }
  const base = parts.length > 0 ? parts.join(" ") : "—";
  if (
    result.video_bitrate &&
    result.video_bitrate !== "Unknown" &&
    result.video_bitrate !== "N/A"
  ) {
    return `${base} (${result.video_bitrate})`;
  }
  return base;
}

export function statusDotColor(status: ChannelStatus): string {
  return STATUS_METADATA[status].dot;
}

export function formatAudioInfo(result: ChannelResult): string {
  const parts: string[] = [];
  if (result.audio_bitrate) {
    parts.push(`${result.audio_bitrate} kbps`);
  }
  if (result.audio_codec && result.audio_codec !== "Unknown") {
    parts.push(result.audio_codec);
  }
  if (result.audio_channel_layout) {
    parts.push(result.audio_channel_layout);
  }
  return parts.length > 0 ? parts.join(" ") : "—";
}

export function resolveResolutionLabel(width: number, height: number): string {
  if (width >= 3840 && height >= 2160) return "4K";
  if (width >= 1920 && height >= 1080) return "1080p";
  if (width >= 1280 && height >= 720) return "720p";
  if (width >= 854 && height >= 480) return "480p";
  return "SD";
}

const CODEC_MAP: [RegExp, string][] = [
  [/^avc1/i, "H264"],
  [/^h\.?264$/i, "H264"],
  [/^hvc1/i, "HEVC"],
  [/^hev/i, "HEVC"],
  [/^hevc$/i, "HEVC"],
  [/^vp0?9/i, "VP9"],
  [/^vp0?8/i, "VP8"],
  [/^av01/i, "AV1"],
  [/^mp4a/i, "AAC"],
  [/^aac$/i, "AAC"],
  [/^opus$/i, "Opus"],
  [/^mp3$/i, "MP3"],
  [/^flac$/i, "FLAC"],
  [/^vorbis$/i, "Vorbis"],
  [/^ac-?3/i, "AC3"],
  [/^ec-?3/i, "EAC3"],
  [/^e-?ac-?3/i, "EAC3"],
];

export function normalizeCodecName(raw: string): string {
  for (const [pattern, name] of CODEC_MAP) {
    if (pattern.test(raw)) return name;
  }
  return raw.toUpperCase();
}

/** Human-readable byte count, e.g. "12.3 MB". */
export function formatBytes(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = totalBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
