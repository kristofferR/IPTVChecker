import type {
  CastMediaRequest,
  CastSession,
  CastStreamKind,
  ChannelResult,
} from "./types";

export function detectStreamKind(url: string): CastStreamKind {
  // Strip query/fragment from a path-like string before checking the extension,
  // so URLs like ".../stream.ts?token=..." still classify as MPEG-TS.
  const stripQuery = (s: string) => s.split(/[?#]/, 1)[0].toLowerCase();
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".ts")) return "mpeg_ts";
  } catch {
    const path = stripQuery(url);
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".ts")) return "mpeg_ts";
  }
  return "other";
}

export function buildCastRequest(channel: ChannelResult): CastMediaRequest {
  const url = channel.stream_url?.trim() || channel.url;
  return {
    originalUrl: url,
    channelName: channel.name || null,
    channelLogo: channel.tvg_logo || null,
    streamKind: detectStreamKind(url),
  };
}

export function isCastSessionActive(
  session: CastSession | null,
): session is CastSession {
  return !!session && session.state !== "stopped" && session.state !== "error";
}
