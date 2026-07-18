// Pure playback policy shared by useStreamPlayer and the runtime monitor:
// URL classification, Xtream HLS conversion, streaming-proxy URL builders,
// recovery-window math, and live-buffer resync/rate policy. Keep this module
// free of React and player-instance side effects so it stays unit-testable.
import type { ContentType } from "./types";

export type PlayerState = "idle" | "loading" | "playing" | "error";
export type StreamType = "hls" | "mpegts" | "unknown";
export type PlaybackStartMode = "manual" | "recovery";
export type PlaybackRecoveryIssue =
  | "startup_failure"
  | "media_error"
  | "library_error"
  | "watchdog_stall"
  | "ended";

interface PlaybackRecoveryDecisionRetry {
  kind: "retry";
  nextAttempt: number;
}

interface PlaybackRecoveryDecisionFail {
  kind: "fail";
}

interface PlaybackRecoveryDecisionIgnore {
  kind: "ignore";
}

export type PlaybackRecoveryDecision =
  | PlaybackRecoveryDecisionRetry
  | PlaybackRecoveryDecisionFail
  | PlaybackRecoveryDecisionIgnore;

export interface StreamMetadata {
  width: number | null;
  height: number | null;
  resolution: string | null;
  codec: string | null;
  fps: number | null;
  videoBitrate: string | null;
  audioCodec: string | null;
  audioBitrate: string | null;
  audioOnly: boolean;
}

export function areStreamMetadataEqual(
  left: StreamMetadata | null,
  right: StreamMetadata | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.resolution === right.resolution &&
    left.codec === right.codec &&
    left.fps === right.fps &&
    left.videoBitrate === right.videoBitrate &&
    left.audioCodec === right.audioCodec &&
    left.audioBitrate === right.audioBitrate &&
    left.audioOnly === right.audioOnly
  );
}

export interface PlaybackRecoveryDecisionInput {
  issue: PlaybackRecoveryIssue;
  recoveryTimestamps: number[];
  now: number;
  isPaused: boolean;
  contentType: ContentType;
  maxAttempts?: number;
  windowMs?: number;
}

export interface HlsErrorPayload {
  fatal?: boolean;
  type?: string;
  details?: string;
}

export type HlsFatalRecoveryAction = "restart_network" | "recover_media" | "reconnect";

function stripUrlDecorations(url: string): string {
  return url.toLowerCase().split("#", 1)[0]?.split("?", 1)[0] ?? url.toLowerCase();
}

export function classifyStream(url: string): StreamType {
  const lower = url.toLowerCase();
  const clean = stripUrlDecorations(url);
  if (lower.includes(".m3u8") || clean.endsWith(".m3u8") || lower.includes("/hls/")) return "hls";
  if (
    clean.endsWith(".ts") ||
    clean.endsWith(".m2ts") ||
    clean.endsWith(".mpegts") ||
    clean.endsWith(".m4s") ||
    (lower.includes("/live/") && !lower.includes(".m3u8"))
  ) {
    return "mpegts";
  }
  return "unknown";
}

/**
 * Convert the common Xtream live URL forms to their HLS equivalent.
 * Providers frequently return `/live/user/pass/id.ts`; treating that as a
 * generic MPEG-TS endpoint can let a bursty response fill WebView's MSE quota.
 */
export function tryConvertToXtreamHls(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  const firstSegment = segments[0]?.toLowerCase();
  const offset = firstSegment === "live" ? 1 : 0;
  if (segments.length - offset !== 3) return null;

  const user = segments[offset];
  const password = segments[offset + 1];
  const streamPart = segments[offset + 2];
  const streamMatch = streamPart?.match(/^(\d+)(?:\.(?:ts|m2ts|mpegts))?$/i);
  if (!user || !password || !streamMatch) return null;

  parsed.pathname = `/live/${user}/${password}/${streamMatch[1]}.m3u8`;
  return parsed.toString();
}

function toStreamingProxyUrl(
  url: string,
  port: number,
  reconnect: boolean,
  remux: boolean,
): string {
  const reconnectParam = reconnect ? "&reconnect=1" : "";
  const remuxParam = remux ? "&remux=1" : "";
  return `http://127.0.0.1:${port}/stream?url=${encodeURIComponent(url)}${reconnectParam}${remuxParam}`;
}

export function getMpegtsPlaybackUrls(
  url: string,
  proxyPort: number,
  isLive: boolean,
): string[] {
  if (proxyPort <= 0) {
    return [url];
  }

  const proxyUrl = toStreamingProxyUrl(url, proxyPort, isLive, false);
  return isLive
    ? [toStreamingProxyUrl(url, proxyPort, true, true), proxyUrl]
    : [proxyUrl];
}

export function shouldSuspendPlaybackWatchdog(
  visibilityState: DocumentVisibilityState,
): boolean {
  return visibilityState === "hidden";
}

export function supportsNativeHlsPlayback(
  mediaElement: Pick<HTMLMediaElement, "canPlayType">,
): boolean {
  return [
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
  ].some((mimeType) => mediaElement.canPlayType(mimeType) !== "");
}

export function readMediaErrorMessage(mediaErr: MediaError | null): string | null {
  if (!mediaErr) return null;
  const codeMap: Record<number, string> = {
    1: "Playback aborted",
    2: "Network error",
    3: "Decode error",
    4: "Format not supported",
  };
  return codeMap[mediaErr.code] ?? mediaErr.message ?? "Unknown media error";
}

export const MAX_PLAYBACK_RECOVERY_ATTEMPTS = 5;
export const PLAYBACK_RECOVERY_WINDOW_MS = 2 * 60_000;
export const MIN_PROGRESS_DELTA_SECS = 0.05;
const LIVE_RESYNC_MIN_SEEK_SECS = 1;
const LIVE_RESYNC_MAX_SEEK_SECS = 3;
const LIVE_RESYNC_MAX_JUMP_SECS = 30;
const LIVE_BUFFER_SLOWDOWN_THRESHOLD_SECS = 12;
const LIVE_BUFFER_RECOVERED_THRESHOLD_SECS = 20;
const LIVE_BUFFER_RECOVERY_RATE = 0.97;
const LIVE_BUFFER_CATCHUP_THRESHOLD_SECS = 30;
const LIVE_BUFFER_CATCHUP_RATE = 1.08;
const LIVE_BUFFER_MAX_LATENCY_SECS = 60;
const LIVE_BUFFER_TARGET_LATENCY_SECS = 20;

export interface BufferedTimeRange {
  start: number;
  end: number;
}

export function chooseLiveBufferPlaybackRate(
  currentRate: number,
  bufferedAhead: number,
): number {
  if (!Number.isFinite(bufferedAhead)) return 1;
  if (currentRate < 1) {
    return bufferedAhead < LIVE_BUFFER_RECOVERED_THRESHOLD_SECS
      ? LIVE_BUFFER_RECOVERY_RATE
      : 1;
  }
  if (currentRate > 1) {
    return bufferedAhead > LIVE_BUFFER_RECOVERED_THRESHOLD_SECS
      ? LIVE_BUFFER_CATCHUP_RATE
      : 1;
  }
  if (bufferedAhead > LIVE_BUFFER_CATCHUP_THRESHOLD_SECS) {
    return LIVE_BUFFER_CATCHUP_RATE;
  }
  return bufferedAhead < LIVE_BUFFER_SLOWDOWN_THRESHOLD_SECS
    ? LIVE_BUFFER_RECOVERY_RATE
    : 1;
}

export function bufferedSecondsAhead(
  currentTime: number,
  ranges: BufferedTimeRange[],
): number {
  const currentRange = ranges.find(
    (range) => currentTime >= range.start && currentTime < range.end,
  );
  return currentRange ? Math.max(0, currentRange.end - currentTime) : 0;
}

export function findLiveLatencyCatchUpTarget(
  currentTime: number,
  ranges: BufferedTimeRange[],
  maxLatency = LIVE_BUFFER_MAX_LATENCY_SECS,
  targetLatency = LIVE_BUFFER_TARGET_LATENCY_SECS,
): number | null {
  if (!Number.isFinite(currentTime)) return null;
  const currentRange = ranges.find(
    (range) => currentTime >= range.start && currentTime < range.end,
  );
  if (!currentRange || currentRange.end - currentTime <= maxLatency) {
    return null;
  }
  const target = Math.max(
    currentRange.start + MIN_PROGRESS_DELTA_SECS,
    currentRange.end - targetLatency,
  );
  return target > currentTime + MIN_PROGRESS_DELTA_SECS ? target : null;
}

/**
 * Choose a safe point already buffered by MSE when a live stream stops at a
 * timestamp/keyframe discontinuity. Some IPTV MPEG-TS sources keep delivering
 * data while leaving the playhead on an undecodable boundary; rebuilding the
 * whole player loses far more video than moving to the next buffered keyframe.
 */
export function findLiveBufferResyncTarget(
  currentTime: number,
  ranges: BufferedTimeRange[],
  maxJump = LIVE_RESYNC_MAX_JUMP_SECS,
): number | null {
  if (!Number.isFinite(currentTime) || ranges.length === 0) return null;

  for (const range of ranges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
      continue;
    }

    if (range.start > currentTime + MIN_PROGRESS_DELTA_SECS) {
      const gap = range.start - currentTime;
      if (gap > maxJump) return null;
      return Math.min(range.end - 0.01, range.start + MIN_PROGRESS_DELTA_SECS);
    }

    if (
      currentTime >= range.start - MIN_PROGRESS_DELTA_SECS &&
      currentTime < range.end - MIN_PROGRESS_DELTA_SECS
    ) {
      const availableAdvance = range.end - currentTime - MIN_PROGRESS_DELTA_SECS;
      const advance = Math.min(
        LIVE_RESYNC_MAX_SEEK_SECS,
        maxJump,
        Math.max(LIVE_RESYNC_MIN_SEEK_SECS, availableAdvance),
      );
      const target = Math.min(range.end - MIN_PROGRESS_DELTA_SECS, currentTime + advance);
      return target > currentTime + MIN_PROGRESS_DELTA_SECS ? target : null;
    }
  }

  return null;
}

export function getHlsFatalRecoveryAction(type?: string): HlsFatalRecoveryAction {
  if (type === "networkError") return "restart_network";
  if (type === "mediaError") return "recover_media";
  return "reconnect";
}

export function getNextPlaybackRecoveryAttempt(
  recoveryTimestamps: number[],
  now: number,
  maxAttempts = MAX_PLAYBACK_RECOVERY_ATTEMPTS,
  windowMs = PLAYBACK_RECOVERY_WINDOW_MS,
): number | null {
  const nextAttempt =
    prunePlaybackRecoveryHistory(recoveryTimestamps, now, windowMs).length + 1;
  return nextAttempt <= maxAttempts ? nextAttempt : null;
}

export function prunePlaybackRecoveryHistory(
  recoveryTimestamps: number[],
  now: number,
  windowMs = PLAYBACK_RECOVERY_WINDOW_MS,
): number[] {
  return recoveryTimestamps.filter((timestamp) => now - timestamp < windowMs);
}

export function recordPlaybackRecoveryAttempt(
  recoveryTimestamps: number[],
  now: number,
  windowMs = PLAYBACK_RECOVERY_WINDOW_MS,
): number[] {
  return [...prunePlaybackRecoveryHistory(recoveryTimestamps, now, windowMs), now];
}

export function shouldResetPlaybackRecoveryAttempts(
  startMode: PlaybackStartMode,
  previousChannelIndex: number | null,
  nextChannelIndex: number,
): boolean {
  return startMode === "manual" || previousChannelIndex !== nextChannelIndex;
}

export function formatPlaybackRecoveryMessage(
  attempt: number,
  maxAttempts = MAX_PLAYBACK_RECOVERY_ATTEMPTS,
): string {
  return `Stream interrupted. Reconnecting (${attempt}/${maxAttempts})...`;
}

export function decidePlaybackRecovery(
  input: PlaybackRecoveryDecisionInput,
): PlaybackRecoveryDecision {
  if (input.isPaused) {
    return { kind: "ignore" };
  }
  if (input.issue === "ended" && input.contentType !== "live") {
    return { kind: "ignore" };
  }
  const nextAttempt = getNextPlaybackRecoveryAttempt(
    input.recoveryTimestamps,
    input.now,
    input.maxAttempts,
    input.windowMs,
  );
  if (nextAttempt === null) {
    return { kind: "fail" };
  }
  return {
    kind: "retry",
    nextAttempt,
  };
}
