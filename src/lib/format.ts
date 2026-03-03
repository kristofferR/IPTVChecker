import type { ChannelResult, ChannelStatus } from "./types";

export function statusLabel(status: ChannelStatus): string {
  switch (status) {
    case "alive":
      return "Alive";
    case "dead":
      return "Dead";
    case "geoblocked":
      return "Geoblocked";
    case "geoblocked_confirmed":
      return "Geoblocked (Confirmed)";
    case "geoblocked_unconfirmed":
      return "Geoblocked (Unconfirmed)";
    case "checking":
      return "Checking...";
    case "pending":
      return "Pending";
  }
}

export function statusColor(status: ChannelStatus): string {
  switch (status) {
    case "alive":
      return "text-green-400";
    case "dead":
      return "text-red-400";
    case "geoblocked":
    case "geoblocked_confirmed":
    case "geoblocked_unconfirmed":
      return "text-yellow-400";
    case "checking":
      return "text-blue-400";
    case "pending":
      return "text-zinc-500";
  }
}

export function statusBgColor(status: ChannelStatus): string {
  switch (status) {
    case "alive":
      return "bg-green-500/10 text-green-400 border-green-500/20";
    case "dead":
      return "bg-red-500/10 text-red-400 border-red-500/20";
    case "geoblocked":
    case "geoblocked_confirmed":
    case "geoblocked_unconfirmed":
      return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
    case "checking":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    case "pending":
      return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
  }
}

export function statusIcon(status: ChannelStatus): string {
  switch (status) {
    case "alive":
      return "✓";
    case "dead":
      return "✕";
    case "geoblocked":
    case "geoblocked_confirmed":
    case "geoblocked_unconfirmed":
      return "🔒";
    case "checking":
      return "⟳";
    case "pending":
      return "·";
  }
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

export function formatAudioInfo(result: ChannelResult): string {
  if (result.audio_bitrate && result.audio_codec && result.audio_codec !== "Unknown") {
    return `${result.audio_bitrate} kbps ${result.audio_codec}`;
  }
  return "—";
}
