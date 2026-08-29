// Runtime playback monitor extracted from useStreamPlayer. It is a plain
// factory over (video element, hls/mpegts instances, mutable refs, callbacks)
// that wires stall detection, live-buffer resync, latency trimming, and the
// watchdog interval, and returns a cleanup function that tears all of it down.

import { logger } from "./logger";
import {
  type BufferedTimeRange,
  bufferedSecondsAhead,
  chooseLiveBufferPlaybackRate,
  findLiveBufferResyncTarget,
  findLiveLatencyCatchUpTarget,
  getHlsFatalRecoveryAction,
  getNextPlaybackRecoveryAttempt,
  type HlsErrorPayload,
  MIN_PROGRESS_DELTA_SECS,
  type PlaybackRecoveryIssue,
  type PlayerState,
  readMediaErrorMessage,
  recordPlaybackRecoveryAttempt,
  shouldSuspendPlaybackWatchdog,
} from "./playback";
import type { ChannelResult } from "./types";

const PLAYBACK_STALL_GRACE_MS = 15_000;
const PLAYBACK_NO_PROGRESS_STALL_MS = 20_000;
const PLAYBACK_WATCHDOG_POLL_MS = 1_000;
const HLS_BUFFER_STALLED_ERROR = "bufferStalledError";
const HLS_FATAL_RECOVERY_MAX_ATTEMPTS = 2;
const HLS_FATAL_RECOVERY_WINDOW_MS = 30_000;
const LIVE_RESYNC_COOLDOWN_MS = 3_000;
const LIVE_RESYNC_WAIT_CONFIRM_MS = 750;
const LIVE_RESYNC_SILENT_STALL_MS = 3_000;

export interface MpegtsPlayer {
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
    audioChannelCount?: number;
    fps?: number;
    videoDataRate?: number;
    audioDataRate?: number;
  };
}

type HlsInstance = import("hls.js").default;

/** Mutable ref cell, structurally compatible with React's useRef result. */
interface MutableRef<T> {
  current: T;
}

export interface RuntimeMonitorParams {
  result: ChannelResult;
  sessionId: number;
  videoElement: HTMLVideoElement;
  hlsInstanceRef: MutableRef<HlsInstance | null>;
  mpegtsPlayerRef: MutableRef<MpegtsPlayer | null>;
  isPausedRef: MutableRef<boolean>;
  playerStateRef: MutableRef<PlayerState>;
  playbackSessionIdRef: MutableRef<number>;
  hasStartedPlayingRef: MutableRef<boolean>;
  /** Invoked at most once when the monitor decides recovery is needed. */
  onRuntimeIssue: (issue: PlaybackRecoveryIssue, reason: string) => void;
}

export function createRuntimeMonitor(params: RuntimeMonitorParams): () => void {
  const {
    result,
    sessionId,
    videoElement,
    hlsInstanceRef,
    mpegtsPlayerRef,
    isPausedRef,
    playerStateRef,
    playbackSessionIdRef,
    hasStartedPlayingRef,
    onRuntimeIssue,
  } = params;

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
    logger.warn(`[Player] Skipping ${(target - from).toFixed(2)}s buffered timestamp gap`);
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
    logger.warn(`[Player] Trimming ${(target - from).toFixed(1)}s accumulated live latency`);
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

  const triggerRuntimeIssue = (issue: PlaybackRecoveryIssue, reason: string) => {
    if (closed || playbackSessionIdRef.current !== sessionId || !hasStartedPlayingRef.current) {
      return;
    }
    closed = true;
    onRuntimeIssue(issue, reason);
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
      if (!closed && !isPausedRef.current && videoElement.paused && !videoElement.ended) {
        void videoElement.play().catch(() => {});
      }
    }, 100);
  });
  addHandler(videoElement, "error", () => {
    const reason = readMediaErrorMessage(videoElement.error) ?? "Media error during playback";
    triggerRuntimeIssue("media_error", reason);
  });
  addHandler(videoElement, "ended", () => {
    triggerRuntimeIssue(
      "ended",
      result.content_type === "live" ? "Live stream ended unexpectedly" : "Playback ended",
    );
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
    const onMpegtsError = (errorType?: unknown, errorDetail?: unknown, info?: unknown) => {
      const segments = [errorType, errorDetail, info].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
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
    if (shouldSuspendPlaybackWatchdog(document.visibilityState)) {
      monitor.lastProgressAt = performance.now();
      monitor.stallStartedAt = null;
      return;
    }
    if (playerStateRef.current !== "playing") {
      return;
    }
    if (isPausedRef.current || videoElement.paused || videoElement.seeking || videoElement.ended) {
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
      if (now - monitor.stallStartedAt >= LIVE_RESYNC_WAIT_CONFIRM_MS && tryLiveBufferResync()) {
        return;
      }
      if (now - monitor.stallStartedAt >= PLAYBACK_STALL_GRACE_MS) {
        triggerRuntimeIssue("watchdog_stall", "Stream stalled during playback");
      }
      return;
    }

    const noProgressDuration = now - monitor.lastProgressAt;
    if (noProgressDuration >= LIVE_RESYNC_SILENT_STALL_MS && tryLiveBufferResync()) {
      return;
    }

    if (noProgressDuration >= PLAYBACK_NO_PROGRESS_STALL_MS) {
      triggerRuntimeIssue("watchdog_stall", "Playback stopped progressing");
    }
  }, PLAYBACK_WATCHDOG_POLL_MS);

  return () => {
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
}
