import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelResult, ContentType } from "../lib/types";
import { normalizeCodecName, resolveResolutionLabel } from "../lib/format";
import { logger } from "../lib/logger";
import { toProxyUrl } from "../lib/proxyUrl";
import { getStreamingProxyPort } from "../lib/tauri";

type PlayerState = "idle" | "loading" | "playing" | "error";
export type StreamType = "hls" | "mpegts" | "unknown";
export type PlaybackStartMode = "manual" | "recovery";
type PlaybackRecoveryIssue =
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

export interface UseStreamPlayerReturn {
  playerState: PlayerState;
  errorMessage: string | null;
  volume: number;
  muted: boolean;
  isPaused: boolean;
  isRecovering: boolean;
  recoveryAttempt: number | null;
  recoveryMessage: string | null;
  activeChannelIndex: number | null;
  videoElement: HTMLVideoElement;
  streamMetadata: StreamMetadata | null;
  play: (result: ChannelResult) => void;
  stop: () => void;
  togglePause: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
}

interface UseStreamPlayerOptions {
  onPlaybackFailed?: (result: ChannelResult) => void;
}

interface PlaybackRecoveryDecisionInput {
  issue: PlaybackRecoveryIssue;
  recoveryTimestamps: number[];
  now: number;
  isPaused: boolean;
  contentType: ContentType;
  maxAttempts?: number;
  windowMs?: number;
}

interface HlsErrorPayload {
  fatal?: boolean;
  type?: string;
  details?: string;
}

export type HlsFatalRecoveryAction = "restart_network" | "recover_media" | "reconnect";

interface MpegtsPlayer {
  destroy(): void;
  attachMediaElement(el: HTMLMediaElement): void;
  load(): void;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  mediaInfo?: {
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    hasVideo?: boolean;
    hasAudio?: boolean;
    fps?: number;
    videoDataRate?: number;
    audioDataRate?: number;
  };
}

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

export function supportsNativeHlsPlayback(
  mediaElement: Pick<HTMLMediaElement, "canPlayType">,
): boolean {
  return [
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
  ].some((mimeType) => mediaElement.canPlayType(mimeType) !== "");
}

function readStoredVolume(): number {
  try {
    const v = localStorage.getItem("player-volume");
    if (v !== null) {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    }
  } catch {}
  return 0.75;
}

function readStoredMuted(): boolean {
  try {
    return localStorage.getItem("player-muted") === "true";
  } catch {}
  return false;
}

function createVideoElement(): HTMLVideoElement {
  const el = document.createElement("video");
  el.playsInline = true;
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.objectFit = "contain";
  el.style.background = "black";
  el.style.display = "block";
  return el;
}

function readMediaErrorMessage(mediaErr: MediaError | null): string | null {
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
const LOADING_TIMEOUT_MS = 15_000;
const NATIVE_HLS_TIMEOUT_MS = 4_000;
const PLAYBACK_RECOVERY_DELAY_MS = 900;
const PLAYBACK_STALL_GRACE_MS = 15_000;
const PLAYBACK_NO_PROGRESS_STALL_MS = 20_000;
const PLAYBACK_WATCHDOG_POLL_MS = 1_000;
const MIN_PROGRESS_DELTA_SECS = 0.05;
const HLS_BUFFER_STALLED_ERROR = "bufferStalledError";
const HLS_FATAL_RECOVERY_MAX_ATTEMPTS = 2;
const HLS_FATAL_RECOVERY_WINDOW_MS = 30_000;
const LIVE_RESYNC_MIN_SEEK_SECS = 1;
const LIVE_RESYNC_MAX_SEEK_SECS = 3;
const LIVE_RESYNC_MAX_JUMP_SECS = 30;
const LIVE_RESYNC_COOLDOWN_MS = 3_000;
const LIVE_RESYNC_WAIT_CONFIRM_MS = 750;
const LIVE_RESYNC_SILENT_STALL_MS = 3_000;
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

function bufferedSecondsAhead(currentTime: number, ranges: BufferedTimeRange[]): number {
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

type StartPlaybackAttempt = (
  result: ChannelResult,
  sessionId: number,
  startMode: PlaybackStartMode,
  recoveryAttempt: number,
) => Promise<void>;

export function useStreamPlayer(options?: UseStreamPlayerOptions): UseStreamPlayerReturn {
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  if (!videoElRef.current) {
    videoElRef.current = createVideoElement();
  }
  const videoElement = videoElRef.current;

  const onPlaybackFailedRef = useRef(options?.onPlaybackFailed);
  onPlaybackFailedRef.current = options?.onPlaybackFailed;

  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(readStoredVolume);
  const [muted, setMuted] = useState(readStoredMuted);
  const [isPaused, setIsPaused] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState<number | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [activeChannelIndex, setActiveChannelIndex] = useState<number | null>(null);
  const [streamMetadata, setStreamMetadata] = useState<StreamMetadata | null>(null);

  const lastErrorRef = useRef<string | null>(null);
  const playerStateRef = useRef<PlayerState>("idle");
  const isPausedRef = useRef(false);
  const hlsInstanceRef = useRef<import("hls.js").default | null>(null);
  const mpegtsPlayerRef = useRef<MpegtsPlayer | null>(null);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackAbortRef = useRef<AbortController | null>(null);
  const metadataCleanupRef = useRef<(() => void) | null>(null);
  const runtimeMonitorCleanupRef = useRef<(() => void) | null>(null);
  const currentChannelRef = useRef<ChannelResult | null>(null);
  const recoveryTimestampsRef = useRef<number[]>([]);
  const hasStartedPlayingRef = useRef(false);
  const playbackSessionIdRef = useRef(0);
  const startPlaybackAttemptRef = useRef<StartPlaybackAttempt | null>(null);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  const clearLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const cleanupMetadataListeners = useCallback(() => {
    metadataCleanupRef.current?.();
    metadataCleanupRef.current = null;
  }, []);

  const cleanupRuntimeMonitor = useCallback(() => {
    runtimeMonitorCleanupRef.current?.();
    runtimeMonitorCleanupRef.current = null;
  }, []);

  const resetRecoveryUi = useCallback(() => {
    setIsRecovering(false);
    setRecoveryAttempt(null);
    setRecoveryMessage(null);
  }, []);

  const showRecoveryUi = useCallback((attempt: number) => {
    setIsRecovering(true);
    setRecoveryAttempt(attempt);
    setRecoveryMessage(formatPlaybackRecoveryMessage(attempt));
  }, []);

  const collectMetadata = useCallback(() => {
    // IPTV streams rarely exceed 50 Mbps even at 4K HDR.
    // Player bandwidth estimates can be wildly inflated (1000+ Mbps) during
    // initial buffering or when codec detection fails - discard those.
    const MAX_REASONABLE_KBPS = 100_000;

    const formatBitrateKbps = (kbps: number): string | null => {
      if (kbps <= 0 || kbps > MAX_REASONABLE_KBPS) return null;
      return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
    };

    const meta: StreamMetadata = {
      width: null,
      height: null,
      resolution: null,
      codec: null,
      fps: null,
      videoBitrate: null,
      audioCodec: null,
      audioBitrate: null,
      audioOnly: false,
    };

    const hls = hlsInstanceRef.current;
    if (hls) {
      const levelIdx = hls.currentLevel >= 0 ? hls.currentLevel : (hls.levels?.length ? 0 : -1);
      const level = levelIdx >= 0 ? hls.levels?.[levelIdx] : undefined;
      if (level) {
        if (level.width && level.height) {
          meta.width = level.width;
          meta.height = level.height;
          meta.resolution = resolveResolutionLabel(level.width, level.height);
        }
        if (level.videoCodec) meta.codec = normalizeCodecName(level.videoCodec);
        if (level.audioCodec) meta.audioCodec = normalizeCodecName(level.audioCodec);
        if (level.bitrate) {
          meta.videoBitrate = formatBitrateKbps(Math.round(level.bitrate / 1000));
        } else if (hls.bandwidthEstimate && Number.isFinite(hls.bandwidthEstimate)) {
          meta.videoBitrate = formatBitrateKbps(Math.round(hls.bandwidthEstimate / 1000));
        }
        if ((level as { frameRate?: number }).frameRate) {
          meta.fps = Math.round((level as { frameRate: number }).frameRate);
        }
      }
    }

    const mpegtsPlayer = mpegtsPlayerRef.current;
    if (mpegtsPlayer?.mediaInfo) {
      const info = mpegtsPlayer.mediaInfo;
      if (!meta.width && info.width && info.height) {
        meta.width = info.width;
        meta.height = info.height;
        meta.resolution = resolveResolutionLabel(info.width, info.height);
      }
      if (!meta.codec && info.videoCodec) meta.codec = normalizeCodecName(info.videoCodec);
      if (!meta.audioCodec && info.audioCodec) meta.audioCodec = normalizeCodecName(info.audioCodec);
      if (!meta.fps && info.fps) meta.fps = Math.round(info.fps);
      if (!meta.videoBitrate && info.videoDataRate) {
        meta.videoBitrate = formatBitrateKbps(Math.round(info.videoDataRate));
      }
      if (!meta.audioBitrate && info.audioDataRate) {
        meta.audioBitrate = String(Math.round(info.audioDataRate));
      }
      if (info.hasAudio && !info.hasVideo) meta.audioOnly = true;
    }

    if (!meta.width && videoElement.videoWidth && videoElement.videoHeight) {
      meta.width = videoElement.videoWidth;
      meta.height = videoElement.videoHeight;
      meta.resolution = resolveResolutionLabel(videoElement.videoWidth, videoElement.videoHeight);
    }

    if (meta.width || meta.codec || meta.audioCodec) {
      setStreamMetadata((previous) =>
        areStreamMetadataEqual(previous, meta) ? previous : meta,
      );
    }
  }, [videoElement]);

  const setupMetadataListeners = useCallback(() => {
    cleanupMetadataListeners();

    const handlers: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];
    const addHandler = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler);
      handlers.push({ target, event, handler });
    };

    addHandler(videoElement, "loadedmetadata", () => collectMetadata());
    addHandler(videoElement, "playing", () => collectMetadata());
    addHandler(videoElement, "resize", () => collectMetadata());

    const libCleanups: Array<() => void> = [];

    const hls = hlsInstanceRef.current;
    if (hls) {
      const hlsHandler = () => collectMetadata();
      const hlsEvents = hls as unknown as {
        on(event: string, handler: () => void): void;
        off(event: string, handler: () => void): void;
      };
      hlsEvents.on("hlsLevelSwitched", hlsHandler);
      hlsEvents.on("hlsManifestParsed", hlsHandler);
      libCleanups.push(() => {
        try {
          hlsEvents.off("hlsLevelSwitched", hlsHandler);
          hlsEvents.off("hlsManifestParsed", hlsHandler);
        } catch {}
      });
    }

    const mpegts = mpegtsPlayerRef.current;
    if (mpegts?.on && mpegts.off) {
      const mpegtsHandler = () => collectMetadata();
      mpegts.on("media_info", mpegtsHandler);
      libCleanups.push(() => {
        try {
          mpegts.off?.("media_info", mpegtsHandler);
        } catch {}
      });
    }

    metadataCleanupRef.current = () => {
      for (const h of handlers) h.target.removeEventListener(h.event, h.handler);
      for (const fn of libCleanups) fn();
    };

    collectMetadata();
  }, [videoElement, collectMetadata, cleanupMetadataListeners]);

  const cleanup = useCallback(() => {
    const abortController = playbackAbortRef.current;
    playbackAbortRef.current = null;
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    clearLoadingTimer();
    cleanupRuntimeMonitor();
    cleanupMetadataListeners();
    setStreamMetadata(null);
    if (hlsInstanceRef.current) {
      hlsInstanceRef.current.destroy();
      hlsInstanceRef.current = null;
    }
    if (mpegtsPlayerRef.current) {
      mpegtsPlayerRef.current.destroy();
      mpegtsPlayerRef.current = null;
    }
    videoElement.pause();
    videoElement.removeAttribute("src");
    videoElement.load();
  }, [clearLoadingTimer, cleanupRuntimeMonitor, cleanupMetadataListeners, videoElement]);

  const applyVolume = useCallback(() => {
    videoElement.volume = volume;
    videoElement.muted = muted;
  }, [videoElement, volume, muted]);

  useEffect(() => {
    applyVolume();
  }, [applyVolume]);

  useEffect(() => {
    try {
      localStorage.setItem("player-volume", String(volume));
    } catch {}
  }, [volume]);

  useEffect(() => {
    try {
      localStorage.setItem("player-muted", String(muted));
    } catch {}
  }, [muted]);

  const finalizePlaybackFailure = useCallback(
    (result: ChannelResult, reason: string, notifyBackend: boolean) => {
      cleanup();
      clearRecoveryTimer();
      resetRecoveryUi();
      hasStartedPlayingRef.current = false;
      recoveryTimestampsRef.current = [];
      logger.error("[Player] Playback failed for channel", result.name, "-", reason);
      setPlayerState("error");
      setErrorMessage(reason);
      setIsPaused(false);
      setActiveChannelIndex(null);
      if (notifyBackend) {
        onPlaybackFailedRef.current?.(result);
      }
    },
    [cleanup, clearRecoveryTimer, resetRecoveryUi],
  );

  const attemptRecoveryOrFail = useCallback(
    (
      result: ChannelResult,
      sessionId: number,
      issue: PlaybackRecoveryIssue,
      reason: string,
    ) => {
      const now = Date.now();
      const decision = decidePlaybackRecovery({
        issue,
        recoveryTimestamps: recoveryTimestampsRef.current,
        now,
        isPaused: isPausedRef.current,
        contentType: result.content_type,
      });

      if (decision.kind === "ignore") {
        logger.info("[Player] Ignoring playback interruption for", result.name, "-", reason);
        return;
      }

      if (decision.kind === "fail") {
        finalizePlaybackFailure(result, reason, true);
        return;
      }

      logger.warn(
        "[Player] Scheduling clean reconnect for",
        result.name,
        `(${decision.nextAttempt}/${MAX_PLAYBACK_RECOVERY_ATTEMPTS})`,
        "-",
        reason,
      );

      clearRecoveryTimer();
      cleanup();
      currentChannelRef.current = result;
      recoveryTimestampsRef.current = recordPlaybackRecoveryAttempt(
        recoveryTimestampsRef.current,
        now,
      );
      hasStartedPlayingRef.current = false;
      showRecoveryUi(decision.nextAttempt);
      setPlayerState("loading");
      setErrorMessage(null);
      setIsPaused(false);
      setActiveChannelIndex(result.index);

      recoveryTimerRef.current = setTimeout(() => {
        if (playbackSessionIdRef.current !== sessionId) {
          return;
        }
        const startAttempt = startPlaybackAttemptRef.current;
        if (!startAttempt) {
          return;
        }
        void startAttempt(result, sessionId, "recovery", decision.nextAttempt);
      }, PLAYBACK_RECOVERY_DELAY_MS);
    },
    [cleanup, clearRecoveryTimer, finalizePlaybackFailure, showRecoveryUi],
  );

  const setupRuntimeMonitor = useCallback(
    (result: ChannelResult, sessionId: number) => {
      cleanupRuntimeMonitor();

      let closed = false;
      const monitor = {
        lastProgressAt: performance.now(),
        lastCurrentTime: videoElement.currentTime,
        stallStartedAt: null as number | null,
        lastResyncAt: Number.NEGATIVE_INFINITY,
      };
      let resyncTimer: ReturnType<typeof setTimeout> | null = null;
      let hlsFatalRecoveryTimestamps: number[] = [];

      const handlers: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];
      const addHandler = (target: EventTarget, event: string, handler: EventListener) => {
        target.addEventListener(event, handler);
        handlers.push({ target, event, handler });
      };

      const markProgress = () => {
        if (closed) return;
        const now = performance.now();
        const currentTime = videoElement.currentTime;
        if (currentTime > monitor.lastCurrentTime + MIN_PROGRESS_DELTA_SECS) {
          monitor.lastCurrentTime = currentTime;
          monitor.stallStartedAt = null;
        }
        monitor.lastProgressAt = now;
      };

      const markPotentialStall = () => {
        if (closed || isPausedRef.current || videoElement.paused) {
          return;
        }
        if (monitor.stallStartedAt === null) {
          monitor.stallStartedAt = performance.now();
        }
      };

      const tryLiveBufferResync = () => {
        if (
          closed ||
          !mpegtsPlayerRef.current ||
          isPausedRef.current ||
          videoElement.paused ||
          performance.now() - monitor.lastResyncAt < LIVE_RESYNC_COOLDOWN_MS
        ) {
          return false;
        }

        const ranges: BufferedTimeRange[] = [];
        for (let index = 0; index < videoElement.buffered.length; index += 1) {
          ranges.push({
            start: videoElement.buffered.start(index),
            end: videoElement.buffered.end(index),
          });
        }
        const from = videoElement.currentTime;
        const target = findLiveBufferResyncTarget(from, ranges);
        if (target === null || target <= from + MIN_PROGRESS_DELTA_SECS) {
          return false;
        }

        monitor.lastResyncAt = performance.now();
        monitor.lastCurrentTime = target;
        monitor.lastProgressAt = monitor.lastResyncAt;
        monitor.stallStartedAt = null;
        logger.warn(
          `[Player] Skipping ${(target - from).toFixed(2)}s buffered timestamp gap`,
        );
        videoElement.currentTime = target;
        void videoElement.play().catch(() => {});
        return true;
      };

      const adjustLiveBufferPlaybackRate = () => {
        if (!mpegtsPlayerRef.current) return;
        const ranges: BufferedTimeRange[] = [];
        for (let index = 0; index < videoElement.buffered.length; index += 1) {
          ranges.push({
            start: videoElement.buffered.start(index),
            end: videoElement.buffered.end(index),
          });
        }
        const bufferedAhead = bufferedSecondsAhead(videoElement.currentTime, ranges);
        const nextRate = chooseLiveBufferPlaybackRate(videoElement.playbackRate, bufferedAhead);
        if (Math.abs(videoElement.playbackRate - nextRate) < 0.001) return;
        videoElement.playbackRate = nextRate;
        logger.info(
          nextRate < 1
            ? `[Player] Slowing live playback to ${nextRate.toFixed(2)}x to rebuild buffer`
            : nextRate > 1
              ? `[Player] Increasing live playback to ${nextRate.toFixed(2)}x to reduce latency`
            : "[Player] Restored live playback to 1.00x",
        );
      };

      const trimExcessiveLiveLatency = () => {
        if (!mpegtsPlayerRef.current || videoElement.buffered.length === 0) return false;
        const ranges: BufferedTimeRange[] = [];
        for (let index = 0; index < videoElement.buffered.length; index += 1) {
          ranges.push({
            start: videoElement.buffered.start(index),
            end: videoElement.buffered.end(index),
          });
        }
        const from = videoElement.currentTime;
        const target = findLiveLatencyCatchUpTarget(from, ranges);
        if (target === null) return false;

        const now = performance.now();
        monitor.lastResyncAt = now;
        monitor.lastCurrentTime = target;
        monitor.lastProgressAt = now;
        monitor.stallStartedAt = null;
        logger.warn(
          `[Player] Trimming ${(target - from).toFixed(1)}s accumulated live latency`,
        );
        videoElement.currentTime = target;
        void videoElement.play().catch(() => {});
        return true;
      };

      const clearResyncTimer = () => {
        if (!resyncTimer) return;
        clearTimeout(resyncTimer);
        resyncTimer = null;
      };

      const scheduleLiveBufferResync = () => {
        markPotentialStall();
        if (resyncTimer) return;
        resyncTimer = setTimeout(() => {
          resyncTimer = null;
          tryLiveBufferResync();
        }, LIVE_RESYNC_WAIT_CONFIRM_MS);
      };

      const triggerRuntimeIssue = (
        issue: PlaybackRecoveryIssue,
        reason: string,
      ) => {
        if (closed || playbackSessionIdRef.current !== sessionId || !hasStartedPlayingRef.current) {
          return;
        }
        closed = true;
        attemptRecoveryOrFail(result, sessionId, issue, reason);
      };

      addHandler(videoElement, "playing", () => {
        clearResyncTimer();
        hlsFatalRecoveryTimestamps = [];
        monitor.lastProgressAt = performance.now();
        monitor.lastCurrentTime = videoElement.currentTime;
        monitor.stallStartedAt = null;
      });
      addHandler(videoElement, "timeupdate", () => {
        markProgress();
      });
      addHandler(videoElement, "canplay", () => {
        clearResyncTimer();
        hlsFatalRecoveryTimestamps = [];
        markProgress();
        monitor.stallStartedAt = null;
      });
      addHandler(videoElement, "waiting", () => {
        scheduleLiveBufferResync();
      });
      addHandler(videoElement, "stalled", () => {
        scheduleLiveBufferResync();
      });
      addHandler(videoElement, "pause", () => {
        if (closed || isPausedRef.current || videoElement.ended) return;
        logger.warn("[Player] Resuming an unexpected media pause");
        window.setTimeout(() => {
          if (
            !closed &&
            !isPausedRef.current &&
            videoElement.paused &&
            !videoElement.ended
          ) {
            void videoElement.play().catch(() => {});
          }
        }, 100);
      });
      addHandler(videoElement, "error", () => {
        const reason = readMediaErrorMessage(videoElement.error) ?? "Media error during playback";
        triggerRuntimeIssue("media_error", reason);
      });
      addHandler(videoElement, "ended", () => {
        if (result.content_type !== "live") {
          return;
        }
        triggerRuntimeIssue("ended", "Live stream ended unexpectedly");
      });

      const libCleanups: Array<() => void> = [];

      const hls = hlsInstanceRef.current;
      if (hls) {
        const hlsEvents = hls as unknown as {
          on(event: string, handler: (...args: unknown[]) => void): void;
          off(event: string, handler: (...args: unknown[]) => void): void;
        };
        const onHlsError = (...args: unknown[]) => {
          const data = args[1] as HlsErrorPayload | undefined;
          if (!data) {
            return;
          }
          if (data.details === HLS_BUFFER_STALLED_ERROR) {
            markPotentialStall();
          }
          if (data.fatal) {
            const detail = data.details ?? "fatal hls.js error";
            const type = data.type ?? "hls.js";
            const recoveryAction = getHlsFatalRecoveryAction(data.type);
            if (recoveryAction !== "reconnect") {
              const now = performance.now();
              const attempt = getNextPlaybackRecoveryAttempt(
                hlsFatalRecoveryTimestamps,
                now,
                HLS_FATAL_RECOVERY_MAX_ATTEMPTS,
                HLS_FATAL_RECOVERY_WINDOW_MS,
              );
              if (attempt === null) {
                triggerRuntimeIssue(
                  "library_error",
                  `${type}: repeated fatal recovery failed (${detail})`,
                );
                return;
              }
              hlsFatalRecoveryTimestamps = recordPlaybackRecoveryAttempt(
                hlsFatalRecoveryTimestamps,
                now,
                HLS_FATAL_RECOVERY_WINDOW_MS,
              );
            }
            if (recoveryAction === "restart_network") {
              logger.warn("[Player] Restarting hls.js network loading after", detail);
              hls.startLoad(-1);
              markPotentialStall();
              return;
            }
            if (recoveryAction === "recover_media") {
              logger.warn("[Player] Recovering hls.js media pipeline after", detail);
              hls.recoverMediaError();
              markPotentialStall();
              return;
            }
            triggerRuntimeIssue("library_error", `${type}: ${detail}`);
          }
        };
        const onHlsStallResolved = () => {
          hlsFatalRecoveryTimestamps = [];
          markProgress();
          monitor.stallStartedAt = null;
        };
        hlsEvents.on("hlsError", onHlsError);
        hlsEvents.on("hlsStallResolved", onHlsStallResolved);
        libCleanups.push(() => {
          try {
            hlsEvents.off("hlsError", onHlsError);
            hlsEvents.off("hlsStallResolved", onHlsStallResolved);
          } catch {}
        });
      }

      const mpegtsPlayer = mpegtsPlayerRef.current;
      if (mpegtsPlayer?.on && mpegtsPlayer.off) {
        const onMpegtsError = (
          errorType?: unknown,
          errorDetail?: unknown,
          info?: unknown,
        ) => {
          const segments = [errorType, errorDetail, info]
            .filter((value): value is string => typeof value === "string" && value.length > 0);
          const detail = segments.join(": ") || "mpegts.js runtime error";
          triggerRuntimeIssue("library_error", detail);
        };
        mpegtsPlayer.on("error", onMpegtsError);
        libCleanups.push(() => {
          try {
            mpegtsPlayer.off?.("error", onMpegtsError);
          } catch {}
        });
      }

      const watchdog = setInterval(() => {
        if (closed || playbackSessionIdRef.current !== sessionId) {
          return;
        }
        if (playerStateRef.current !== "playing") {
          return;
        }
        if (
          isPausedRef.current ||
          videoElement.paused ||
          videoElement.seeking ||
          videoElement.ended
        ) {
          return;
        }

        const now = performance.now();
        if (trimExcessiveLiveLatency()) {
          return;
        }
        adjustLiveBufferPlaybackRate();
        const currentTime = videoElement.currentTime;
        if (currentTime > monitor.lastCurrentTime + MIN_PROGRESS_DELTA_SECS) {
          monitor.lastCurrentTime = currentTime;
          monitor.lastProgressAt = now;
          monitor.stallStartedAt = null;
          return;
        }

        if (monitor.stallStartedAt !== null) {
          if (
            now - monitor.stallStartedAt >= LIVE_RESYNC_WAIT_CONFIRM_MS &&
            tryLiveBufferResync()
          ) {
            return;
          }
          if (now - monitor.stallStartedAt >= PLAYBACK_STALL_GRACE_MS) {
            triggerRuntimeIssue("watchdog_stall", "Stream stalled during playback");
          }
          return;
        }

        const noProgressDuration = now - monitor.lastProgressAt;
        if (
          noProgressDuration >= LIVE_RESYNC_SILENT_STALL_MS &&
          tryLiveBufferResync()
        ) {
          return;
        }

        if (noProgressDuration >= PLAYBACK_NO_PROGRESS_STALL_MS) {
          triggerRuntimeIssue("watchdog_stall", "Playback stopped progressing");
        }
      }, PLAYBACK_WATCHDOG_POLL_MS);

      runtimeMonitorCleanupRef.current = () => {
        closed = true;
        clearInterval(watchdog);
        clearResyncTimer();
        videoElement.playbackRate = 1;
        for (const h of handlers) {
          h.target.removeEventListener(h.event, h.handler);
        }
        for (const fn of libCleanups) {
          fn();
        }
      };
    },
    [attemptRecoveryOrFail, cleanupRuntimeMonitor, videoElement],
  );

  const tryNativePlayback = useCallback(
    (url: string, signal: AbortSignal, timeoutMs?: number): Promise<boolean> => {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onCanPlay = () => {
          finish(true);
        };
        const onError = () => {
          lastErrorRef.current = readMediaErrorMessage(videoElement.error);
          videoElement.removeAttribute("src");
          videoElement.load();
          finish(false);
        };
        const onAbort = () => {
          videoElement.removeAttribute("src");
          videoElement.load();
          finish(false);
        };

        if (timeoutMs != null) {
          timer = setTimeout(() => {
            videoElement.removeAttribute("src");
            videoElement.load();
            finish(false);
          }, timeoutMs);
        }

        videoElement.addEventListener("canplay", onCanPlay, { once: true });
        videoElement.addEventListener("error", onError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        videoElement.src = url;
        applyVolume();
        videoElement.load();
      });
    },
    [videoElement, applyVolume],
  );

  const tryHlsPlayback = useCallback(
    async (url: string, signal: AbortSignal): Promise<boolean> => {
      const { default: Hls } = await import("hls.js");
      if (signal.aborted || !Hls.isSupported()) return false;

      return new Promise((resolve) => {
        let settled = false;
        const hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });
        hlsInstanceRef.current = hls;

        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onVideoError);
          signal.removeEventListener("abort", onAbort);
          hls.off(Hls.Events.ERROR, onHlsError);
          resolve(value);
        };
        const destroyPlayer = () => {
          hls.destroy();
          if (hlsInstanceRef.current === hls) {
            hlsInstanceRef.current = null;
          }
        };
        const onCanPlay = () => finish(true);
        const onVideoError = () => {
          lastErrorRef.current = readMediaErrorMessage(videoElement.error);
          destroyPlayer();
          finish(false);
        };
        const onHlsError = (_event: unknown, data: HlsErrorPayload) => {
          if (data.fatal) {
            const detail = data.details ?? "fatal hls.js error";
            const type = data.type ?? "hls.js";
            lastErrorRef.current = `${type}: ${detail}`;
            destroyPlayer();
            finish(false);
          }
        };
        const onAbort = () => {
          destroyPlayer();
          finish(false);
        };

        videoElement.addEventListener("canplay", onCanPlay, { once: true });
        videoElement.addEventListener("error", onVideoError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        hls.on(Hls.Events.ERROR, onHlsError);

        hls.loadSource(toProxyUrl(url));
        hls.attachMedia(videoElement);
        applyVolume();
      });
    },
    [videoElement, applyVolume],
  );

  const tryMpegtsPlayback = useCallback(
    async (url: string, signal: AbortSignal): Promise<boolean> => {
      const mpegtsModule = await import("mpegts.js");
      const mpegts = mpegtsModule.default;
      if (signal.aborted || !mpegts.isSupported()) return false;

      return new Promise((resolve) => {
        let settled = false;
        const player = mpegts.createPlayer(
          {
            type: "mpegts",
            url,
            isLive: true,
          },
          {
            // Trade a small amount of live latency for enough network cushion
            // to ride out the jitter common on IPTV provider connections.
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 1024 * 1024,
            lazyLoad: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 120,
            autoCleanupMinBackwardDuration: 60,
          },
        ) as unknown as MpegtsPlayer;
        mpegtsPlayerRef.current = player;

        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
          player.off?.("error", onPlayerError);
          resolve(value);
        };
        const onCanPlay = () => {
          finish(true);
        };
        const onError = () => {
          lastErrorRef.current = readMediaErrorMessage(videoElement.error);
          player.destroy();
          if (mpegtsPlayerRef.current === player) {
            mpegtsPlayerRef.current = null;
          }
          finish(false);
        };
        const onPlayerError = (
          errorType?: unknown,
          errorDetail?: unknown,
          info?: unknown,
        ) => {
          const segments = [errorType, errorDetail, info]
            .filter((value): value is string => typeof value === "string" && value.length > 0);
          lastErrorRef.current = segments.join(": ") || "mpegts.js error";
          player.destroy();
          if (mpegtsPlayerRef.current === player) {
            mpegtsPlayerRef.current = null;
          }
          finish(false);
        };
        const onAbort = () => {
          player.destroy();
          if (mpegtsPlayerRef.current === player) {
            mpegtsPlayerRef.current = null;
          }
          finish(false);
        };

        videoElement.addEventListener("canplay", onCanPlay, { once: true });
        videoElement.addEventListener("error", onError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        player.on?.("error", onPlayerError);

        player.attachMediaElement(videoElement);
        player.load();
        applyVolume();
      });
    },
    [videoElement, applyVolume],
  );

  const startPlaybackAttempt = useCallback<StartPlaybackAttempt>(
    async (
      result: ChannelResult,
      sessionId: number,
      startMode: PlaybackStartMode,
      recoveryAttemptCount: number,
    ) => {
      const previousChannelIndex = currentChannelRef.current?.index ?? null;
      cleanup();
      currentChannelRef.current = result;
      hasStartedPlayingRef.current = false;
      if (shouldResetPlaybackRecoveryAttempts(
        startMode,
        previousChannelIndex,
        result.index,
      )) {
        recoveryTimestampsRef.current = [];
      }

      const abortController = new AbortController();
      playbackAbortRef.current = abortController;

      const isCurrentPlayback = () =>
        playbackSessionIdRef.current === sessionId &&
        playbackAbortRef.current === abortController &&
        !abortController.signal.aborted;

      setPlayerState("loading");
      setErrorMessage(null);
      setIsPaused(false);
      setActiveChannelIndex(result.index);
      if (recoveryAttemptCount > 0) {
        showRecoveryUi(recoveryAttemptCount);
      } else {
        resetRecoveryUi();
      }
      lastErrorRef.current = null;

      const failCurrentAttempt = (fallbackReason: string) => {
        if (!isCurrentPlayback()) {
          return;
        }
        const reason = lastErrorRef.current ?? fallbackReason;
        if (startMode === "recovery") {
          attemptRecoveryOrFail(result, sessionId, "startup_failure", reason);
          return;
        }
        finalizePlaybackFailure(result, reason, true);
      };

      const handleSuccessfulStart = async (): Promise<boolean> => {
        clearLoadingTimer();
        try {
          await videoElement.play();
        } catch {}
        if (!isCurrentPlayback()) {
          return false;
        }
        hasStartedPlayingRef.current = true;
        setPlayerState("playing");
        setErrorMessage(null);
        setIsPaused(false);
        resetRecoveryUi();
        setupMetadataListeners();
        setupRuntimeMonitor(result, sessionId);
        return true;
      };

      loadingTimerRef.current = setTimeout(() => {
        if (!isCurrentPlayback()) {
          return;
        }
        logger.warn("[Player] Connection timed out for channel", result.name);
        failCurrentAttempt("Connection timed out");
      }, LOADING_TIMEOUT_MS);

      const url = result.url;
      const streamType = classifyStream(url);
      const preferNativeHls = streamType === "hls" && supportsNativeHlsPlayback(videoElement);

      if (preferNativeHls) {
        const nativeOk = await tryNativePlayback(url, abortController.signal, NATIVE_HLS_TIMEOUT_MS);
        if (!isCurrentPlayback()) {
          return;
        }
        if (nativeOk && await handleSuccessfulStart()) {
          return;
        }
      }

      if (streamType === "hls") {
        logger.info("[Player] Trying hls.js via proxy for", result.name);
        const hlsOk = await tryHlsPlayback(url, abortController.signal);
        if (!isCurrentPlayback()) {
          return;
        }
        if (hlsOk) {
          logger.info("[Player] Playing via hls.js proxy:", result.name);
          if (await handleSuccessfulStart()) {
            return;
          }
        }
      }

      if (streamType !== "hls") {
        const xtreamHlsUrl = tryConvertToXtreamHls(url);
        if (xtreamHlsUrl) {
          logger.info("[Player] Trying Xtream HLS conversion for", result.name);
          const hlsOk = await tryHlsPlayback(xtreamHlsUrl, abortController.signal);
          if (!isCurrentPlayback()) {
            return;
          }
          if (hlsOk) {
            logger.info("[Player] Playing via Xtream HLS conversion:", result.name);
            if (await handleSuccessfulStart()) {
              return;
            }
          }
          logger.info("[Player] Xtream HLS conversion failed, trying streaming proxy");
        }
      }

      if (streamType === "mpegts" || streamType === "unknown") {
        let proxyPort = 0;
        try {
          proxyPort = await getStreamingProxyPort();
        } catch {
          logger.warn("[Player] Could not get streaming proxy port");
        }
        const playbackUrl = proxyPort > 0
          ? toStreamingProxyUrl(
              url,
              proxyPort,
              result.content_type === "live",
              result.content_type === "live",
            )
          : url;
        if (proxyPort > 0) {
          logger.info("[Player] Trying mpegts.js via streaming proxy for", result.name);
        } else {
          logger.info("[Player] Trying mpegts.js (raw URL) for", result.name);
        }
        const mpegtsOk = await tryMpegtsPlayback(playbackUrl, abortController.signal);
        if (!isCurrentPlayback()) {
          return;
        }
        if (mpegtsOk && await handleSuccessfulStart()) {
          return;
        }
      }

      const nativeOk = await tryNativePlayback(url, abortController.signal);
      if (!isCurrentPlayback()) {
        return;
      }
      if (nativeOk && await handleSuccessfulStart()) {
        return;
      }

      clearLoadingTimer();
      failCurrentAttempt("Unable to play stream");
    },
    [
      attemptRecoveryOrFail,
      cleanup,
      clearLoadingTimer,
      finalizePlaybackFailure,
      resetRecoveryUi,
      setupMetadataListeners,
      setupRuntimeMonitor,
      showRecoveryUi,
      tryHlsPlayback,
      tryMpegtsPlayback,
      tryNativePlayback,
      videoElement,
    ],
  );
  startPlaybackAttemptRef.current = startPlaybackAttempt;

  useEffect(() => {
    return () => {
      clearRecoveryTimer();
      cleanup();
    };
  }, [cleanup, clearRecoveryTimer]);

  const play = useCallback((result: ChannelResult) => {
    playbackSessionIdRef.current += 1;
    isPausedRef.current = false;
    const sessionId = playbackSessionIdRef.current;
    clearRecoveryTimer();
    currentChannelRef.current = result;
    recoveryTimestampsRef.current = [];
    hasStartedPlayingRef.current = false;
    resetRecoveryUi();
    void startPlaybackAttempt(result, sessionId, "manual", 0);
  }, [clearRecoveryTimer, resetRecoveryUi, startPlaybackAttempt]);

  const stop = useCallback(() => {
    playbackSessionIdRef.current += 1;
    isPausedRef.current = false;
    clearRecoveryTimer();
    currentChannelRef.current = null;
    recoveryTimestampsRef.current = [];
    hasStartedPlayingRef.current = false;
    resetRecoveryUi();
    cleanup();
    setPlayerState("idle");
    setErrorMessage(null);
    setIsPaused(false);
    setActiveChannelIndex(null);
  }, [cleanup, clearRecoveryTimer, resetRecoveryUi]);

  const togglePause = useCallback(() => {
    if (videoElement.paused) {
      isPausedRef.current = false;
      videoElement.play().catch(() => {});
      setIsPaused(false);
    } else {
      isPausedRef.current = true;
      videoElement.pause();
      setIsPaused(true);
    }
  }, [videoElement]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => !prev);
  }, []);

  return {
    playerState,
    errorMessage,
    volume,
    muted,
    isPaused,
    isRecovering,
    recoveryAttempt,
    recoveryMessage,
    activeChannelIndex,
    videoElement,
    streamMetadata,
    play,
    stop,
    togglePause,
    setVolume,
    toggleMute,
  };
}
