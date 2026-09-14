import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { describeArchiveFailure, resolveArchivePlayback } from "../lib/archive";
import {
  archiveChannelKey,
  prefersArchiveRemux,
  rememberArchiveRemux,
} from "../lib/archivePlaybackPreference";
import { normalizeCodecName, resolveResolutionLabel } from "../lib/format";
import { logger } from "../lib/logger";
import {
  areStreamMetadataEqual,
  classifyStream,
  decidePlaybackRecovery,
  formatPlaybackRecoveryMessage,
  getArchiveFallbackRoutes,
  getMpegtsPlaybackRoutes,
  type HlsErrorPayload,
  hasPresentedVideoFrame,
  isHlsManifestRejection,
  isHlsMediaRejection,
  MAX_PLAYBACK_RECOVERY_ATTEMPTS,
  type PlaybackRecoveryIssue,
  type PlaybackStartMode,
  type PlayerState,
  readMediaErrorMessage,
  recordPlaybackRecoveryAttempt,
  resolveAudioChannelLayout,
  resolveHlsHdrFormat,
  type StreamMetadata,
  shouldResetPlaybackRecoveryAttempts,
  supportsNativeHlsPlayback,
  tryConvertToXtreamHls,
} from "../lib/playback";
import { observePlayback, type PlaybackObserver } from "../lib/playbackObserver";
import { confirmPlaybackStarted } from "../lib/playbackStartup";
import {
  type PlaybackEndReason,
  type PlaybackEventKind,
  PlaybackRecorder,
  playbackTelemetry,
} from "../lib/playbackTelemetry";
import { toProxyUrl } from "../lib/proxyUrl";
import { createRuntimeMonitor, type MpegtsPlayer } from "../lib/runtimeMonitor";
import { getStreamingProxyPort, startLocalPlayback, stopLocalPlayback } from "../lib/tauri";
import type { ChannelResult } from "../lib/types";
import { canUseBlobWorkers } from "../lib/workerSupport";
import { useAppStore } from "../store";

// Re-exported for components (e.g. StreamPlayer) that read the recovery cap
// alongside the hook. The implementation lives in lib/playback.
export { MAX_PLAYBACK_RECOVERY_ATTEMPTS } from "../lib/playback";

/** Active catch-up playback: which channel, where in its archive, and the
 * seekable window. Present only while playing an archive URL. */
export interface ArchiveSession {
  baseResult: ChannelResult;
  /** Exact synthetic URL currently loaded by the player. */
  url: string;
  /** Where the current archive URL starts, epoch seconds. */
  startEpochS: number;
  /** Earliest seekable point (programme start or the picked time). */
  windowStartEpochS: number;
  /** Latest seekable point (programme end, clamped to launch time). */
  windowEndEpochS: number;
  title: string | null;
}

export interface ArchivePlayOptions {
  startEpochS: number;
  /** Programme end; defaults to now (watch from start up to live edge). */
  endEpochS?: number;
  title?: string;
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
  archiveSession: ArchiveSession | null;
  setArchiveSession: (session: ArchiveSession | null) => void;
  resumeArchive: (session: ArchiveSession) => void;
  play: (result: ChannelResult) => void;
  retry: (result: ChannelResult) => void;
  playArchive: (result: ChannelResult, options: ArchivePlayOptions) => void;
  seekArchive: (toEpochS: number) => void;
  goLive: () => void;
  stop: (options?: { preserveArchiveSession?: boolean }) => void;
  togglePause: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
}

interface UseStreamPlayerOptions {
  onPlaybackFailed?: (result: ChannelResult, affectsChannelHealth: boolean) => void;
  onPlaybackFinished?: (result: ChannelResult) => void;
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

// Bound each route independently so one broken route cannot block fallbacks,
// while allowing slow IPTV providers enough time to produce the first frame.
const PLAYBACK_ROUTE_TIMEOUT_MS = 15_000;
// Replay has a local compatibility route available: don't spend the full live
// startup budget waiting for a provider manifest WebKit cannot play.
const ARCHIVE_NATIVE_TIMEOUT_MS = 3_000;
const MPEGTS_PLAYBACK_ROUTE_TIMEOUT_MS = 25_000;
const LOADING_TIMEOUT_MS = 90_000;
const PLAYBACK_RECOVERY_DELAY_MS = 900;

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
  const onPlaybackFinishedRef = useRef(options?.onPlaybackFinished);

  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(readStoredVolume);
  const [muted, setMuted] = useState(readStoredMuted);
  const audioSettingsRef = useRef({ volume, muted });
  useLayoutEffect(() => {
    audioSettingsRef.current = { volume, muted };
  }, [volume, muted]);
  const nativeVideoPrerollRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState<number | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [activeChannelIndex, setActiveChannelIndex] = useState<number | null>(null);
  const [streamMetadata, setStreamMetadata] = useState<StreamMetadata | null>(null);
  const [archiveSession, setArchiveSessionState] = useState<ArchiveSession | null>(null);
  const archiveSessionRef = useRef<ArchiveSession | null>(null);
  const setArchiveSession = useCallback((session: ArchiveSession | null) => {
    archiveSessionRef.current = session;
    setArchiveSessionState(session);
  }, []);

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
  const playbackStartedAtRef = useRef<number | null>(null);
  const startupLatencyMsRef = useRef<number | null>(null);
  const playbackSessionIdRef = useRef(0);
  const telemetryRef = useRef<PlaybackRecorder | null>(null);
  const telemetryObserverRef = useRef<PlaybackObserver | null>(null);
  const telemetryAttemptRef = useRef(0);
  const finishTelemetry = useCallback((reason: PlaybackEndReason) => {
    telemetryObserverRef.current?.close();
    telemetryObserverRef.current = null;
    playbackTelemetry.finish(reason);
    telemetryRef.current = null;
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{
      session_id: string;
      attempt: number;
      counters: Partial<Record<PlaybackEventKind, number>>;
    }>("playback://transport", ({ payload }) => {
      playbackTelemetry.transport(payload.session_id, payload.attempt, payload.counters);
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const startPlaybackAttemptRef = useRef<StartPlaybackAttempt | null>(null);

  useEffect(() => {
    onPlaybackFailedRef.current = options?.onPlaybackFailed;
    onPlaybackFinishedRef.current = options?.onPlaybackFinished;
  }, [options?.onPlaybackFailed, options?.onPlaybackFinished]);

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
      latencyMs: startupLatencyMsRef.current,
      hdrFormat: null,
      videoBitrate: null,
      audioCodec: null,
      audioBitrate: null,
      audioChannelLayout: null,
      audioOnly: false,
    };

    const hls = hlsInstanceRef.current;
    if (hls) {
      const levelIdx = hls.currentLevel >= 0 ? hls.currentLevel : hls.levels?.length ? 0 : -1;
      const level = levelIdx >= 0 ? hls.levels?.[levelIdx] : undefined;
      if (level) {
        if (level.width && level.height) {
          meta.width = level.width;
          meta.height = level.height;
          meta.resolution = resolveResolutionLabel(level.width, level.height);
        }
        if (level.videoCodec) meta.codec = normalizeCodecName(level.videoCodec);
        meta.hdrFormat = resolveHlsHdrFormat(level.videoRange, level.videoCodec);
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

      const audioTrack = hls.audioTracks?.[hls.audioTrack];
      if (audioTrack?.channels) {
        meta.audioChannelLayout = resolveAudioChannelLayout(audioTrack.channels);
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
      if (!meta.audioCodec && info.audioCodec)
        meta.audioCodec = normalizeCodecName(info.audioCodec);
      if (!meta.fps && info.fps) meta.fps = Math.round(info.fps);
      if (!meta.videoBitrate && info.videoDataRate) {
        meta.videoBitrate = formatBitrateKbps(Math.round(info.videoDataRate));
      }
      if (!meta.audioBitrate && info.audioDataRate) {
        meta.audioBitrate = String(Math.round(info.audioDataRate));
      }
      if (!meta.audioChannelLayout && info.audioChannelCount) {
        meta.audioChannelLayout = resolveAudioChannelLayout(info.audioChannelCount);
      }
      if (info.hasAudio && !info.hasVideo) meta.audioOnly = true;
    }

    if (!meta.width && videoElement.videoWidth && videoElement.videoHeight) {
      meta.width = videoElement.videoWidth;
      meta.height = videoElement.videoHeight;
      meta.resolution = resolveResolutionLabel(videoElement.videoWidth, videoElement.videoHeight);
    }

    if (
      meta.width ||
      meta.codec ||
      meta.hdrFormat ||
      meta.audioCodec ||
      meta.audioChannelLayout ||
      meta.audioOnly
    ) {
      setStreamMetadata((previous) => (areStreamMetadataEqual(previous, meta) ? previous : meta));
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
    telemetryObserverRef.current?.closeRoute();
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

  const stop = useCallback(
    (options?: { preserveArchiveSession?: boolean }) => {
      finishTelemetry("stopped");
      playbackSessionIdRef.current += 1;
      isPausedRef.current = false;
      clearRecoveryTimer();
      currentChannelRef.current = null;
      recoveryTimestampsRef.current = [];
      hasStartedPlayingRef.current = false;
      playbackStartedAtRef.current = null;
      startupLatencyMsRef.current = null;
      resetRecoveryUi();
      cleanup();
      setPlayerState("idle");
      setErrorMessage(null);
      setIsPaused(false);
      setActiveChannelIndex(null);
      if (!options?.preserveArchiveSession) {
        setArchiveSession(null);
      }
    },
    [cleanup, clearRecoveryTimer, resetRecoveryUi, finishTelemetry],
  );

  const applyVolume = useCallback(() => {
    videoElement.volume = audioSettingsRef.current.volume;
    videoElement.muted = nativeVideoPrerollRef.current || audioSettingsRef.current.muted;
  }, [videoElement]);

  useEffect(() => {
    applyVolume();
  }, [applyVolume, volume, muted]);

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
      telemetryRef.current?.event("player_failure", reason);
      finishTelemetry("failed");
      cleanup();
      clearRecoveryTimer();
      resetRecoveryUi();
      hasStartedPlayingRef.current = false;
      recoveryTimestampsRef.current = [];
      logger.error("[Player] Playback failed for channel", result.name, "-", reason);
      setPlayerState("error");
      // Archive failures are usually "the provider stored nothing for that
      // time", not network faults; say so instead of surfacing hls.js codes.
      setErrorMessage(archiveSessionRef.current ? describeArchiveFailure(reason) : reason);
      setIsPaused(false);
      setActiveChannelIndex(null);
      // A failed archive URL says nothing about the live channel's health, so
      // let the caller distinguish it from a live channel failure.
      onPlaybackFailedRef.current?.(result, notifyBackend && !archiveSessionRef.current);
    },
    [cleanup, clearRecoveryTimer, resetRecoveryUi, finishTelemetry],
  );

  const attemptRecoveryOrFail = useCallback(
    (result: ChannelResult, sessionId: number, issue: PlaybackRecoveryIssue, reason: string) => {
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

      if (decision.kind === "finish") {
        logger.info("[Player] Playback finished for", result.name);
        finishTelemetry("finished");
        onPlaybackFinishedRef.current?.(result);
        stop();
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

      telemetryRef.current?.event("reconnect", issue);
      let recoveryResult = result;
      const archiveSession = archiveSessionRef.current;
      const elapsedS = Math.floor(videoElement.currentTime);
      if (archiveSession && elapsedS > 0) {
        const nowEpochS = Math.floor(now / 1000);
        const latestStartEpochS = Math.min(archiveSession.windowEndEpochS, nowEpochS) - 1;
        const requestedStartEpochS = Math.max(
          archiveSession.windowStartEpochS,
          Math.min(archiveSession.startEpochS + elapsedS, latestStartEpochS),
        );
        const playback = resolveArchivePlayback(
          archiveSession.baseResult,
          {
            startEpochS: requestedStartEpochS,
            endEpochS: archiveSession.windowEndEpochS,
          },
          nowEpochS,
        );
        if (playback) {
          setArchiveSession({
            ...archiveSession,
            url: playback.url,
            startEpochS: playback.startEpochS,
          });
          recoveryResult = {
            ...archiveSession.baseResult,
            url: playback.url,
            content_type: "movie",
            stream_url: null,
          };
        }
      }

      clearRecoveryTimer();
      cleanup();
      currentChannelRef.current = recoveryResult;
      recoveryTimestampsRef.current = recordPlaybackRecoveryAttempt(
        recoveryTimestampsRef.current,
        now,
      );
      hasStartedPlayingRef.current = false;
      showRecoveryUi(decision.nextAttempt);
      setPlayerState("loading");
      setErrorMessage(null);
      setIsPaused(false);
      setActiveChannelIndex(recoveryResult.index);

      recoveryTimerRef.current = setTimeout(() => {
        if (playbackSessionIdRef.current !== sessionId) {
          return;
        }
        const startAttempt = startPlaybackAttemptRef.current;
        if (!startAttempt) {
          return;
        }
        void startAttempt(recoveryResult, sessionId, "recovery", decision.nextAttempt);
      }, PLAYBACK_RECOVERY_DELAY_MS);
    },
    [
      cleanup,
      clearRecoveryTimer,
      finalizePlaybackFailure,
      finishTelemetry,
      setArchiveSession,
      showRecoveryUi,
      stop,
      videoElement,
    ],
  );

  const setupRuntimeMonitor = useCallback(
    (result: ChannelResult, sessionId: number) => {
      cleanupRuntimeMonitor();
      runtimeMonitorCleanupRef.current = createRuntimeMonitor({
        result,
        sessionId,
        videoElement,
        hlsInstanceRef,
        mpegtsPlayerRef,
        isPausedRef,
        playerStateRef,
        playbackSessionIdRef,
        hasStartedPlayingRef,
        onTelemetry: (kind, detail, seconds) => telemetryRef.current?.event(kind, detail, seconds),
        onRuntimeIssue: (issue, reason) => attemptRecoveryOrFail(result, sessionId, issue, reason),
      });
    },
    [attemptRecoveryOrFail, cleanupRuntimeMonitor, videoElement],
  );

  const tryNativePlayback = useCallback(
    (
      url: string,
      signal: AbortSignal,
      timeoutMs = PLAYBACK_ROUTE_TIMEOUT_MS,
      audioOnly = false,
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let frameTimer: ReturnType<typeof setInterval> | null = null;
        let frameRequest: number | null = null;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          if (!value && !signal.aborted) {
            telemetryObserverRef.current?.failure(lastErrorRef.current ?? "Native playback failed");
          }
          if (timer) clearTimeout(timer);
          if (frameTimer) clearInterval(frameTimer);
          if (frameRequest !== null) videoElement.cancelVideoFrameCallback(frameRequest);
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
          nativeVideoPrerollRef.current = false;
          applyVolume();
          resolve(value);
        };
        const onCanPlay = () => {
          // Native HLS can advance audio while dropping every video frame.
          // Start playback before accepting it so the MSE fallback still runs.
          if (audioOnly) {
            finish(true);
            return;
          }
          const startedAt = performance.now();
          if (videoElement.requestVideoFrameCallback) {
            frameRequest = videoElement.requestVideoFrameCallback(() => finish(true));
          }
          void videoElement.play().catch(() => {});
          frameTimer = setInterval(() => {
            if (
              videoElement.videoWidth > 0 &&
              (document.visibilityState === "hidden" ||
                (!videoElement.requestVideoFrameCallback &&
                  (!videoElement.getVideoPlaybackQuality ||
                    hasPresentedVideoFrame(videoElement.getVideoPlaybackQuality()))))
            ) {
              finish(true);
            } else if (videoElement.videoWidth === 0 && performance.now() - startedAt >= 2_000) {
              // Missing video can fall back quickly. A recognized video track
              // may still be buffering, so allow the full route startup budget.
              lastErrorRef.current = "Native playback did not expose a video track";
              finish(false);
              videoElement.pause();
              videoElement.removeAttribute("src");
              videoElement.load();
            }
          }, 100);
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
            lastErrorRef.current = "Native playback timed out";
            videoElement.removeAttribute("src");
            videoElement.load();
            finish(false);
          }, timeoutMs);
        }

        videoElement.addEventListener("canplay", onCanPlay, { once: true });
        videoElement.addEventListener("error", onError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        telemetryAttemptRef.current++;
        telemetryObserverRef.current?.route("native", classifyStream(url));
        // WebKit can drop every interlaced frame when its audio clock starts
        // first. Preroll video silently, then restore the user's audio settings.
        nativeVideoPrerollRef.current = !audioOnly;
        videoElement.src = url;
        applyVolume();
        videoElement.load();
      });
    },
    [videoElement, applyVolume],
  );

  const tryRemuxedArchive = useCallback(
    async (url: string, signal: AbortSignal, audioOnly: boolean): Promise<boolean> => {
      const requestId = crypto.randomUUID();
      const stopProxy = () => {
        void stopLocalPlayback(requestId).catch(() => {});
      };
      signal.addEventListener("abort", stopProxy, { once: true });
      let playing = false;
      try {
        if (signal.aborted) return false;
        const localUrl = await startLocalPlayback(url, requestId);
        if (signal.aborted) return false;
        playing = await tryNativePlayback(localUrl, signal, PLAYBACK_ROUTE_TIMEOUT_MS, audioOnly);
        return playing;
      } catch (error) {
        lastErrorRef.current = error instanceof Error ? error.message : "Archive remux failed";
        if (!signal.aborted) {
          telemetryObserverRef.current?.route("native", "archive remux startup");
          telemetryObserverRef.current?.failure(lastErrorRef.current);
        }
        return false;
      } finally {
        if (!playing) {
          signal.removeEventListener("abort", stopProxy);
          // Also handles a cancellation that arrived before the start command
          // registered its backend session.
          stopProxy();
        }
      }
    },
    [tryNativePlayback],
  );

  const tryHlsPlayback = useCallback(
    async (
      url: string,
      signal: AbortSignal,
      timeoutMs = PLAYBACK_ROUTE_TIMEOUT_MS,
    ): Promise<boolean> => {
      if (signal.aborted) return false;
      telemetryObserverRef.current?.route("hls.js");
      try {
        const { default: Hls } = await import("hls.js");
        if (signal.aborted) return false;
        if (!Hls.isSupported()) {
          lastErrorRef.current = "hls.js is not supported by this WebView";
          telemetryObserverRef.current?.failure(lastErrorRef.current);
          return false;
        }

        return await new Promise<boolean>((resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | null = null;
          const hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
          });
          telemetryAttemptRef.current++;
          telemetryObserverRef.current?.hls(hls, Hls.Events);
          hlsInstanceRef.current = hls;
          let cancelStartup: (() => void) | undefined;
          let detectedAudioOnly = currentChannelRef.current?.audio_only ?? false;
          hls.on(Hls.Events.BUFFER_CODECS, (_event, tracks) => {
            if (tracks.video || tracks.audiovideo) detectedAudioOnly = false;
            else if (tracks.audio?.id === "main") detectedAudioOnly = true;
          });

          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            cancelStartup?.();
            videoElement.removeEventListener("canplay", onCanPlay);
            videoElement.removeEventListener("error", onVideoError);
            signal.removeEventListener("abort", onAbort);
            hls.off(Hls.Events.ERROR, onHlsError);
            resolve(value);
          };
          const destroyPlayer = () => {
            telemetryObserverRef.current?.closeRoute();
            if (hlsInstanceRef.current === hls) {
              hlsInstanceRef.current = null;
            }
            hls.destroy();
          };
          const fail = (reason?: string) => {
            if (settled) return;
            if (reason) {
              lastErrorRef.current = reason;
            }
            if (!signal.aborted)
              telemetryObserverRef.current?.failure(reason ?? "HLS playback failed");
            finish(false);
            destroyPlayer();
          };
          const onCanPlay = () => {
            cancelStartup = confirmPlaybackStarted(
              videoElement,
              () => detectedAudioOnly,
              () => finish(true),
              fail,
            );
          };
          const onVideoError = () => {
            fail(readMediaErrorMessage(videoElement.error) ?? "HLS media error");
          };
          const onHlsError = (_event: unknown, data: HlsErrorPayload) => {
            if (data.fatal) {
              const detail = data.details ?? "fatal hls.js error";
              const type = data.type ?? "hls.js";
              fail(`${type}: ${detail}`);
            }
          };
          const onAbort = () => {
            fail();
          };

          try {
            timer = setTimeout(() => {
              fail("HLS playback timed out");
            }, timeoutMs);
            videoElement.addEventListener("canplay", onCanPlay, { once: true });
            videoElement.addEventListener("error", onVideoError, { once: true });
            signal.addEventListener("abort", onAbort, { once: true });
            hls.on(Hls.Events.ERROR, onHlsError);
            hls.loadSource(toProxyUrl(url));
            hls.attachMedia(videoElement);
            applyVolume();
          } catch (error) {
            fail(error instanceof Error ? error.message : "Could not initialize HLS playback");
          }
        });
      } catch (error) {
        lastErrorRef.current =
          error instanceof Error ? error.message : "Could not initialize HLS playback";
        if (!signal.aborted) telemetryObserverRef.current?.failure(lastErrorRef.current);
        return false;
      }
    },
    [videoElement, applyVolume],
  );

  const tryMpegtsPlayback = useCallback(
    async (
      url: string,
      signal: AbortSignal,
      isLive: boolean,
      timeoutMs = MPEGTS_PLAYBACK_ROUTE_TIMEOUT_MS,
    ): Promise<boolean> => {
      if (signal.aborted) return false;
      try {
        telemetryObserverRef.current?.route(
          "mpegts.js",
          new URL(url).searchParams.get("remux") === "1" ? "remux" : "direct",
        );
        const [mpegtsModule, enableWorker] = await Promise.all([
          import("mpegts.js"),
          canUseBlobWorkers(),
        ]);
        const mpegts = mpegtsModule.default;
        if (signal.aborted) return false;
        if (!mpegts.isSupported()) {
          lastErrorRef.current = "mpegts.js is not supported by this WebView";
          telemetryObserverRef.current?.failure(lastErrorRef.current);
          return false;
        }

        return await new Promise<boolean>((resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | null = null;
          const player = mpegts.createPlayer(
            {
              type: "mpegts",
              url: (() => {
                const target = new URL(url);
                const recorder = telemetryRef.current;
                if (recorder && target.hostname === "127.0.0.1" && target.pathname === "/stream") {
                  recorder.enableTransport();
                  target.searchParams.set("session", recorder.id);
                  target.searchParams.set("attempt", String(++telemetryAttemptRef.current));
                }
                return target.toString();
              })(),
              isLive,
            },
            {
              // Trade a small amount of live latency for enough network cushion
              // to ride out the jitter common on IPTV provider connections.
              enableWorker,
              enableStashBuffer: true,
              stashInitialSize: 1024 * 1024,
              lazyLoad: false,
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 120,
              autoCleanupMinBackwardDuration: 60,
            },
          ) as unknown as MpegtsPlayer;
          telemetryObserverRef.current?.mpegts(player);
          mpegtsPlayerRef.current = player;
          let cancelStartup: (() => void) | undefined;

          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            cancelStartup?.();
            videoElement.removeEventListener("canplay", onCanPlay);
            videoElement.removeEventListener("error", onError);
            signal.removeEventListener("abort", onAbort);
            player.off?.("error", onPlayerError);
            resolve(value);
          };
          const destroyPlayer = () => {
            // mpegts.js cannot remove listeners after destroy() nulls its
            // engine. Detach diagnostics before disposing a failed route.
            telemetryObserverRef.current?.closeRoute();
            if (mpegtsPlayerRef.current === player) {
              mpegtsPlayerRef.current = null;
            }
            player.destroy();
          };
          const fail = (reason?: string) => {
            if (settled) return;
            if (reason) {
              lastErrorRef.current = reason;
            }
            if (!signal.aborted)
              telemetryObserverRef.current?.failure(reason ?? "MPEG-TS playback failed");
            finish(false);
            destroyPlayer();
          };
          const onCanPlay = () => {
            cancelStartup = confirmPlaybackStarted(
              videoElement,
              () => {
                const info = player.mediaInfo;
                return info?.hasVideo === false && info.hasAudio === true
                  ? true
                  : info?.hasVideo === true
                    ? false
                    : (currentChannelRef.current?.audio_only ?? false);
              },
              () => finish(true),
              fail,
            );
          };
          const onError = () => {
            fail(readMediaErrorMessage(videoElement.error) ?? "MPEG-TS media error");
          };
          const onPlayerError = (errorType?: unknown, errorDetail?: unknown, info?: unknown) => {
            const segments = [errorType, errorDetail, info].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
            fail(segments.join(": ") || "mpegts.js error");
          };
          const onAbort = () => {
            fail();
          };

          try {
            timer = setTimeout(() => {
              fail("Stream startup timed out");
            }, timeoutMs);
            videoElement.addEventListener("canplay", onCanPlay, { once: true });
            videoElement.addEventListener("error", onError, { once: true });
            signal.addEventListener("abort", onAbort, { once: true });
            player.on?.("error", onPlayerError);
            if (telemetryObserverRef.current)
              telemetryObserverRef.current.attachMpegts(() =>
                player.attachMediaElement(videoElement),
              );
            else player.attachMediaElement(videoElement);
            player.load();
            applyVolume();
          } catch (error) {
            fail(error instanceof Error ? error.message : "Could not initialize MPEG-TS playback");
          }
        });
      } catch (error) {
        lastErrorRef.current =
          error instanceof Error ? error.message : "Could not initialize MPEG-TS playback";
        if (!signal.aborted) telemetryObserverRef.current?.failure(lastErrorRef.current);
        return false;
      }
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
      if (shouldResetPlaybackRecoveryAttempts(startMode, previousChannelIndex, result.index)) {
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
        if (startMode === "manual" && playbackStartedAtRef.current != null) {
          startupLatencyMsRef.current = Math.max(
            0,
            Math.round(performance.now() - playbackStartedAtRef.current),
          );
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
        telemetryObserverRef.current?.failure("Connection timed out");
        failCurrentAttempt("Connection timed out");
      }, LOADING_TIMEOUT_MS);

      const url = result.url;
      const streamType = classifyStream(url);
      const preferNativeHls = streamType === "hls" && supportsNativeHlsPlayback(videoElement);
      const xtreamHlsUrl = streamType === "hls" ? null : tryConvertToXtreamHls(url);
      const tryXtreamHlsRoute = async (): Promise<boolean> => {
        if (!xtreamHlsUrl) return false;

        // Converted playlist URLs need the same native-first routing as
        // explicit HLS URLs. WebKit can decode interlaced TS through native
        // HLS even when the MSE-based engines reject those video samples.
        if (supportsNativeHlsPlayback(videoElement)) {
          logger.info("[Player] Trying native Xtream HLS for", result.name);
          lastErrorRef.current = null;
          const nativeOk = await tryNativePlayback(
            xtreamHlsUrl,
            abortController.signal,
            PLAYBACK_ROUTE_TIMEOUT_MS,
            result.audio_only,
          );
          if (!isCurrentPlayback()) return false;
          if (nativeOk && (await handleSuccessfulStart())) {
            logger.info("[Player] Playing via native Xtream HLS:", result.name);
            return true;
          }
        }

        logger.info(
          startMode === "recovery"
            ? "[Player] Trying Xtream HLS recovery route for"
            : "[Player] Trying Xtream HLS route for",
          result.name,
        );
        lastErrorRef.current = null;
        const hlsOk = await tryHlsPlayback(xtreamHlsUrl, abortController.signal);
        if (!isCurrentPlayback() || !hlsOk) {
          return false;
        }
        logger.info("[Player] Playing via Xtream HLS:", result.name);
        return handleSuccessfulStart();
      };

      if (preferNativeHls) {
        const archive = archiveSessionRef.current;
        const channelKey = archive
          ? await archiveChannelKey(archive.baseResult.url).catch(() => null)
          : null;
        if (!isCurrentPlayback()) return;
        const remuxFirst = channelKey !== null && prefersArchiveRemux(channelKey);
        const tryArchiveRemux = async (): Promise<boolean> => {
          logger.info("[Player] Trying native HLS archive remux for", result.name);
          const remuxOk = await tryRemuxedArchive(url, abortController.signal, result.audio_only);
          if (!isCurrentPlayback()) return false;
          if (remuxOk && (await handleSuccessfulStart())) {
            if (channelKey !== null) rememberArchiveRemux(channelKey, true);
            logger.info("[Player] Playing via native HLS archive remux:", result.name);
            return true;
          }
          if (isCurrentPlayback() && channelKey !== null) rememberArchiveRemux(channelKey, false);
          return false;
        };
        if (remuxFirst) {
          if (await tryArchiveRemux()) return;
          if (!isCurrentPlayback()) return;
        }
        logger.info("[Player] Trying native HLS for", result.name);
        lastErrorRef.current = null;
        const nativeOk = await tryNativePlayback(
          url,
          abortController.signal,
          archive ? ARCHIVE_NATIVE_TIMEOUT_MS : PLAYBACK_ROUTE_TIMEOUT_MS,
          result.audio_only,
        );
        if (!isCurrentPlayback()) {
          return;
        }
        if (nativeOk && (await handleSuccessfulStart())) {
          logger.info("[Player] Playing via native HLS:", result.name);
          return;
        }
        logger.info(
          "[Player] Native HLS did not start for",
          result.name,
          "-",
          lastErrorRef.current ?? "no media error reported",
        );
        if (archive && !remuxFirst) {
          if (await tryArchiveRemux()) return;
          if (!isCurrentPlayback()) return;
        }
      }

      // A playlist URL that answers with raw media (timeshift `.m3u8` redirecting
      // to `.ts`) is rejected by the proxy up front; hls.js then reports a
      // manifest error, and the MPEG-TS routes below take over.
      let hlsManifestRejected = false;
      if (streamType === "hls") {
        logger.info("[Player] Trying hls.js via proxy for", result.name);
        lastErrorRef.current = null;
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
        hlsManifestRejected = isHlsManifestRejection(lastErrorRef.current);
        if (hlsManifestRejected) {
          logger.info(
            "[Player] Playlist URL served raw media; trying MPEG-TS routes for",
            result.name,
          );
        } else if (result.content_type !== "live" && isHlsMediaRejection(lastErrorRef.current)) {
          // Catch-up media hls.js cannot play (HEVC in TS): raw timeshift
          // stream via mpegts.js, then an ffmpeg remux of the playlist.
          let proxyPort = 0;
          try {
            proxyPort = await getStreamingProxyPort();
          } catch {
            logger.warn("[Player] Could not get streaming proxy port");
          }
          for (const route of getArchiveFallbackRoutes(url, proxyPort)) {
            logger.info(
              route.kind === "remux"
                ? "[Player] Trying ffmpeg remux of the archive playlist for"
                : "[Player] Trying raw timeshift stream via mpegts.js for",
              result.name,
            );
            lastErrorRef.current = null;
            const mpegtsOk = await tryMpegtsPlayback(route.url, abortController.signal, false);
            if (!isCurrentPlayback()) {
              return;
            }
            if (mpegtsOk && (await handleSuccessfulStart())) {
              return;
            }
          }
        }
      }

      // Xtream HLS is the WebView-native path and normally starts quickly.
      // Try it before two independently bounded MPEG-TS routes can consume
      // their full startup timeouts.
      if (await tryXtreamHlsRoute()) {
        return;
      }
      if (!isCurrentPlayback()) {
        return;
      }

      if (streamType === "mpegts" || streamType === "unknown" || hlsManifestRejected) {
        const isLive = result.content_type === "live";
        let proxyPort = 0;
        try {
          proxyPort = await getStreamingProxyPort();
        } catch {
          logger.warn("[Player] Could not get streaming proxy port");
        }
        const playbackRoutes = getMpegtsPlaybackRoutes(
          url,
          proxyPort,
          isLive,
          startMode === "recovery",
        );
        for (const route of playbackRoutes) {
          logger.info(
            route.kind === "remux"
              ? "[Player] Trying normalized MPEG-TS remux for"
              : proxyPort > 0
                ? "[Player] Trying mpegts.js via streaming proxy for"
                : "[Player] Trying mpegts.js (raw URL) for",
            result.name,
          );
          lastErrorRef.current = null;
          const mpegtsOk = await tryMpegtsPlayback(route.url, abortController.signal, isLive);
          if (!isCurrentPlayback()) {
            return;
          }
          if (mpegtsOk && (await handleSuccessfulStart())) {
            return;
          }
        }
      }

      if (streamType !== "hls" || hlsManifestRejected) {
        lastErrorRef.current = null;
        const nativeOk = await tryNativePlayback(
          url,
          abortController.signal,
          PLAYBACK_ROUTE_TIMEOUT_MS,
          result.audio_only,
        );
        if (!isCurrentPlayback()) {
          return;
        }
        if (nativeOk && (await handleSuccessfulStart())) {
          return;
        }
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
      tryRemuxedArchive,
      videoElement,
    ],
  );
  startPlaybackAttemptRef.current = startPlaybackAttempt;

  useEffect(() => {
    return () => {
      finishTelemetry("unmounted");
      clearRecoveryTimer();
      cleanup();
    };
  }, [cleanup, clearRecoveryTimer, finishTelemetry]);

  const beginPlayback = useCallback(
    (result: ChannelResult) => {
      finishTelemetry("switched");
      const state = useAppStore.getState();
      const recorder = new PlaybackRecorder({
        id: crypto.randomUUID(),
        channelIndex: result.index,
        channelName: result.name,
        mode: archiveSessionRef.current
          ? "archive"
          : result.content_type === "live"
            ? "live"
            : "vod",
        streamType: classifyStream(result.url),
        platform: state.platform,
        appVersion: state.appVersion,
      });
      telemetryRef.current = recorder;
      telemetryAttemptRef.current = 0;
      playbackTelemetry.start(recorder);
      telemetryObserverRef.current = observePlayback(
        videoElement,
        recorder,
        () => isPausedRef.current,
      );
      playbackSessionIdRef.current += 1;
      isPausedRef.current = false;
      const sessionId = playbackSessionIdRef.current;
      clearRecoveryTimer();
      currentChannelRef.current = result;
      recoveryTimestampsRef.current = [];
      hasStartedPlayingRef.current = false;
      playbackStartedAtRef.current = performance.now();
      startupLatencyMsRef.current = null;
      resetRecoveryUi();
      void startPlaybackAttempt(result, sessionId, "manual", 0);
    },
    [clearRecoveryTimer, resetRecoveryUi, startPlaybackAttempt, finishTelemetry, videoElement],
  );

  const play = useCallback(
    (result: ChannelResult) => {
      setArchiveSession(null);
      beginPlayback(result);
    },
    [beginPlayback],
  );

  const retry = useCallback(
    (result: ChannelResult) => {
      const session = archiveSessionRef.current;
      const currentChannel = currentChannelRef.current;
      if (session && currentChannel && session.baseResult.index === result.index) {
        beginPlayback(currentChannel);
        return;
      }
      setArchiveSession(null);
      beginPlayback(result);
    },
    [beginPlayback],
  );

  const playArchive = useCallback(
    (result: ChannelResult, options: ArchivePlayOptions) => {
      const playback = resolveArchivePlayback(result, options);
      if (!playback) {
        return;
      }
      setArchiveSession({
        baseResult: result,
        url: playback.url,
        startEpochS: playback.startEpochS,
        windowStartEpochS: playback.startEpochS,
        windowEndEpochS: playback.windowEndEpochS,
        title: options.title ?? null,
      });
      // The archive URL rides through the normal route/recovery pipeline as a
      // synthetic channel; it is not live, so MPEG-TS routes get a VOD hint.
      beginPlayback({ ...result, url: playback.url, content_type: "movie", stream_url: null });
    },
    [beginPlayback],
  );

  const resumeArchive = useCallback(
    (session: ArchiveSession) => {
      setArchiveSession(session);
      beginPlayback({
        ...session.baseResult,
        url: session.url,
        content_type: "movie",
        stream_url: null,
      });
    },
    [beginPlayback],
  );

  const seekArchive = useCallback(
    (toEpochS: number) => {
      const session = archiveSessionRef.current;
      if (!session) {
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const latestSeekable = Math.min(session.windowEndEpochS, now) - 10;
      const clamped = Math.max(
        session.windowStartEpochS,
        Math.min(Math.floor(toEpochS), latestSeekable),
      );
      const playback = resolveArchivePlayback(
        session.baseResult,
        { startEpochS: clamped, endEpochS: session.windowEndEpochS },
        now,
      );
      if (!playback) {
        return;
      }
      setArchiveSession({
        ...session,
        url: playback.url,
        startEpochS: playback.startEpochS,
      });
      beginPlayback({
        ...session.baseResult,
        url: playback.url,
        content_type: "movie",
        stream_url: null,
      });
    },
    [beginPlayback],
  );

  const goLive = useCallback(() => {
    const session = archiveSessionRef.current;
    if (!session) {
      return;
    }
    setArchiveSession(null);
    beginPlayback(session.baseResult);
  }, [beginPlayback]);

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
    archiveSession,
    setArchiveSession,
    resumeArchive,
    play,
    retry,
    playArchive,
    seekArchive,
    goLive,
    stop,
    togglePause,
    setVolume,
    toggleMute,
  };
}
