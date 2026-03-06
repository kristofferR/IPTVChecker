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
    const res = result.fps
      ? `${result.resolution}${result.fps}`
      : result.resolution;
    parts.push(res);
  }
  if (result.codec && result.codec !== "Unknown") {
    parts.push(result.codec);
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
  if (result.audio_bitrate && result.audio_codec && result.audio_codec !== "Unknown") {
    return `${result.audio_bitrate} kbps ${result.audio_codec}`;
  }
  return "—";
}
