import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelResult } from "../lib/types";
import { normalizeCodecName, resolveResolutionLabel } from "../lib/format";
import { logger } from "../lib/logger";
import { toProxyUrl } from "../lib/proxyUrl";
import { getStreamingProxyPort } from "../lib/tauri";

type PlayerState = "idle" | "loading" | "playing" | "error";
export type StreamType = "hls" | "mpegts" | "unknown";

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

export interface UseStreamPlayerReturn {
  playerState: PlayerState;
  errorMessage: string | null;
  volume: number;
  muted: boolean;
  isPaused: boolean;
  activeChannelIndex: number | null;
  videoElement: HTMLVideoElement;
  streamMetadata: StreamMetadata | null;
  play: (result: ChannelResult) => void;
  stop: () => void;
  togglePause: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
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
 * Try to convert an Xtream MPEG-TS URL to HLS format.
 * Xtream pattern: http://host:port/username/password/stream_id
 * HLS variant:    http://host:port/live/username/password/stream_id.m3u8
 */
function tryConvertToXtreamHls(url: string): string | null {
  const match = url.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) return null;
  const [, origin, user, pass, id] = match;
  return `${origin}/live/${user}/${pass}/${id}.m3u8`;
}

function toStreamingProxyUrl(url: string, port: number): string {
  return `http://127.0.0.1:${port}/stream?url=${encodeURIComponent(url)}`;
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

const LOADING_TIMEOUT_MS = 15_000;
const NATIVE_HLS_TIMEOUT_MS = 4_000;

interface UseStreamPlayerOptions {
  onPlaybackFailed?: (result: ChannelResult) => void;
}

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
  const [activeChannelIndex, setActiveChannelIndex] = useState<number | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const [streamMetadata, setStreamMetadata] = useState<StreamMetadata | null>(null);

  const hlsInstanceRef = useRef<import("hls.js").default | null>(null);
  const mpegtsPlayerRef = useRef<{ destroy(): void; attachMediaElement(el: HTMLMediaElement): void; load(): void } | null>(null);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackAbortRef = useRef<AbortController | null>(null);
  const metadataCleanupRef = useRef<(() => void) | null>(null);

  const clearLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
  }, []);

  const cleanupMetadataListeners = useCallback(() => {
    metadataCleanupRef.current?.();
    metadataCleanupRef.current = null;
  }, []);

  const collectMetadata = useCallback(() => {
    const meta: StreamMetadata = {
      width: null, height: null, resolution: null,
      codec: null, fps: null, videoBitrate: null,
      audioCodec: null, audioBitrate: null, audioOnly: false,
    };

    // 1. HLS.js — richest data
    const hls = hlsInstanceRef.current;
    if (hls) {
      // currentLevel can be -1 in auto mode before a level is selected
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
          const kbps = Math.round(level.bitrate / 1000);
          meta.videoBitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
        } else if (hls.bandwidthEstimate && Number.isFinite(hls.bandwidthEstimate)) {
          const kbps = Math.round(hls.bandwidthEstimate / 1000);
          meta.videoBitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
        }
        if ((level as { frameRate?: number }).frameRate) {
          meta.fps = Math.round((level as { frameRate: number }).frameRate);
        }
      }
    }

    // 2. mpegts.js
    const mpegtsPlayer = mpegtsPlayerRef.current;
    if (mpegtsPlayer && "mediaInfo" in mpegtsPlayer) {
      const info = (mpegtsPlayer as { mediaInfo?: {
        videoCodec?: string; audioCodec?: string;
        width?: number; height?: number;
        hasVideo?: boolean; hasAudio?: boolean;
        fps?: number; videoDataRate?: number; audioDataRate?: number;
      } }).mediaInfo;
      if (info) {
        if (!meta.width && info.width && info.height) {
          meta.width = info.width;
          meta.height = info.height;
          meta.resolution = resolveResolutionLabel(info.width, info.height);
        }
        if (!meta.codec && info.videoCodec) meta.codec = normalizeCodecName(info.videoCodec);
        if (!meta.audioCodec && info.audioCodec) meta.audioCodec = normalizeCodecName(info.audioCodec);
        if (!meta.fps && info.fps) meta.fps = Math.round(info.fps);
        if (!meta.videoBitrate && info.videoDataRate) {
          const kbps = Math.round(info.videoDataRate);
          meta.videoBitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
        }
        if (!meta.audioBitrate && info.audioDataRate) {
          meta.audioBitrate = String(Math.round(info.audioDataRate));
        }
        if (info.hasAudio && !info.hasVideo) meta.audioOnly = true;
      }
    }

    // 3. HTMLVideoElement fallback
    if (!meta.width && videoElement.videoWidth && videoElement.videoHeight) {
      meta.width = videoElement.videoWidth;
      meta.height = videoElement.videoHeight;
      meta.resolution = resolveResolutionLabel(videoElement.videoWidth, videoElement.videoHeight);
    }

    // Only set if we got at least some data
    if (meta.width || meta.codec || meta.audioCodec) {
      setStreamMetadata(meta);
    }
  }, [videoElement]);

  const setupMetadataListeners = useCallback(() => {
    cleanupMetadataListeners();

    const handlers: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];
    const addHandler = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler);
      handlers.push({ target, event, handler });
    };

    // Listen for metadata-related events on the video element.
    // loadedmetadata may have already fired by the time we set up listeners,
    // so also listen on playing/resize as fallbacks.
    addHandler(videoElement, "loadedmetadata", () => collectMetadata());
    addHandler(videoElement, "playing", () => collectMetadata());
    addHandler(videoElement, "resize", () => collectMetadata());

    // Library-specific event listeners for richer metadata
    type LibCleanup = () => void;
    const libCleanups: LibCleanup[] = [];

    // HLS.js: listen to LEVEL_SWITCHED for quality level data
    const hls = hlsInstanceRef.current;
    if (hls) {
      const hlsHandler = () => collectMetadata();
      const hlsAny = hls as unknown as {
        on(event: string, handler: () => void): void;
        off(event: string, handler: () => void): void;
      };
      hlsAny.on("hlsLevelSwitched", hlsHandler);
      hlsAny.on("hlsManifestParsed", hlsHandler);
      hlsAny.on("hlsFragLoaded", hlsHandler);
      libCleanups.push(() => {
        try {
          hlsAny.off("hlsLevelSwitched", hlsHandler);
          hlsAny.off("hlsManifestParsed", hlsHandler);
          hlsAny.off("hlsFragLoaded", hlsHandler);
        } catch {}
      });
    }

    // mpegts.js: listen to MEDIA_INFO and STATISTICS_INFO for codec/fps/bitrate
    const mpegts = mpegtsPlayerRef.current;
    if (mpegts && "on" in mpegts) {
      const mpegtsHandler = () => collectMetadata();
      const mpegtsAny = mpegts as unknown as {
        on(event: string, handler: () => void): void;
        off(event: string, handler: () => void): void;
      };
      // mpegts.js event names from PlayerEvents
      mpegtsAny.on("media_info", mpegtsHandler);
      mpegtsAny.on("statistics_info", mpegtsHandler);
      libCleanups.push(() => {
        try {
          mpegtsAny.off("media_info", mpegtsHandler);
          mpegtsAny.off("statistics_info", mpegtsHandler);
        } catch {}
      });
    }

    metadataCleanupRef.current = () => {
      for (const h of handlers) h.target.removeEventListener(h.event, h.handler);
      for (const fn of libCleanups) fn();
    };

    // Collect immediately in case metadata is already available
    collectMetadata();
  }, [videoElement, collectMetadata, cleanupMetadataListeners]);

  const cleanup = useCallback(() => {
    const abortController = playbackAbortRef.current;
    playbackAbortRef.current = null;
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    clearLoadingTimer();
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
  }, [clearLoadingTimer, cleanupMetadataListeners, videoElement]);

  const applyVolume = useCallback(() => {
    videoElement.volume = volume;
    videoElement.muted = muted;
  }, [videoElement, volume, muted]);

  useEffect(() => {
    applyVolume();
  }, [applyVolume]);

  useEffect(() => {
    try { localStorage.setItem("player-volume", String(volume)); } catch {}
  }, [volume]);

  useEffect(() => {
    try { localStorage.setItem("player-muted", String(muted)); } catch {}
  }, [muted]);

  useEffect(() => cleanup, [cleanup]);

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
          const mediaErr = videoElement.error;
          if (mediaErr) {
            const codeMap: Record<number, string> = {
              1: "Playback aborted",
              2: "Network error",
              3: "Decode error",
              4: "Format not supported",
            };
            lastErrorRef.current =
              codeMap[mediaErr.code] ?? mediaErr.message ?? "Unknown media error";
          }
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
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onVideoError);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const destroyPlayer = () => {
          hls.destroy();
          if (hlsInstanceRef.current === hls) {
            hlsInstanceRef.current = null;
          }
        };
        const hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });
        hlsInstanceRef.current = hls;

        const onCanPlay = () => finish(true);
        const onVideoError = () => {
          const mediaErr = videoElement.error;
          if (mediaErr) {
            const codeMap: Record<number, string> = {
              1: "Playback aborted",
              2: "Network error",
              3: "Decode error",
              4: "Format not supported",
            };
            lastErrorRef.current =
              codeMap[mediaErr.code] ?? mediaErr.message ?? "Unknown media error";
          }
          destroyPlayer();
          finish(false);
        };
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            lastErrorRef.current = `${data.type}: ${data.details}`;
            destroyPlayer();
            finish(false);
          }
        });
        const onAbort = () => {
          destroyPlayer();
          finish(false);
        };
        videoElement.addEventListener("canplay", onCanPlay, { once: true });
        videoElement.addEventListener("error", onVideoError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });

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
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const player = mpegts.createPlayer({
          type: "mpegts",
          url,
          isLive: true,
        });
        mpegtsPlayerRef.current = player;

        const onCanPlay = () => {
          finish(true);
        };
        const onError = () => {
          const mediaErr = videoElement.error;
          if (mediaErr) {
            const codeMap: Record<number, string> = {
              1: "Playback aborted",
              2: "Network error",
              3: "Decode error",
              4: "Format not supported",
            };
            lastErrorRef.current =
              codeMap[mediaErr.code] ?? mediaErr.message ?? "Unknown media error";
          }
          player.destroy();
          mpegtsPlayerRef.current = null;
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

        player.attachMediaElement(videoElement);
        player.load();
        applyVolume();
      });
    },
    [videoElement, applyVolume],
  );

  const play = useCallback(
    async (result: ChannelResult) => {
      cleanup();
      const abortController = new AbortController();
      playbackAbortRef.current = abortController;
      const isCurrentPlayback = () =>
        playbackAbortRef.current === abortController &&
        !abortController.signal.aborted;

      setPlayerState("loading");
      setErrorMessage(null);
      setIsPaused(false);
      setActiveChannelIndex(result.index);
      lastErrorRef.current = null;

      // Always use the original URL for playback — stream_url may be a resolved
      // segment URL (e.g. a .ts segment from HLS manifest traversal) rather than
      // the top-level playlist entry point.
      const url = result.url;
      const streamType = classifyStream(url);
      const preferNativeHls = streamType === "hls" && supportsNativeHlsPlayback(videoElement);

      const currentResult = result;
      loadingTimerRef.current = setTimeout(() => {
        if (!isCurrentPlayback()) {
          return;
        }
        cleanup();
        logger.warn("[Player] Connection timed out for channel", currentResult.name);
        setPlayerState("error");
        setErrorMessage("Connection timed out");
        setActiveChannelIndex(null);
        onPlaybackFailedRef.current?.(currentResult);
      }, LOADING_TIMEOUT_MS);

      if (preferNativeHls) {
        const nativeOk = await tryNativePlayback(url, abortController.signal, NATIVE_HLS_TIMEOUT_MS);
        if (!isCurrentPlayback()) {
          return;
        }
        if (nativeOk) {
          clearLoadingTimer();
          try { await videoElement.play(); } catch {}
          if (!isCurrentPlayback()) {
            return;
          }
          setPlayerState("playing");
          setupMetadataListeners();
          return;
        }
      }

      // 1. For HLS streams, try hls.js directly with proxy
      if (streamType === "hls") {
        logger.info("[Player] Trying hls.js via proxy for", result.name);
        const hlsOk = await tryHlsPlayback(url, abortController.signal);
        if (!isCurrentPlayback()) {
          return;
        }
        if (hlsOk) {
          logger.info("[Player] Playing via hls.js proxy:", result.name);
          clearLoadingTimer();
          try { await videoElement.play(); } catch {}
          if (!isCurrentPlayback()) {
            return;
          }
          setPlayerState("playing");
          setupMetadataListeners();
          return;
        }
      }

      // 2. For non-HLS streams, try Xtream HLS conversion first (most reliable
      //    for single-provider Xtream playlists — avoids infinite MPEG-TS buffering)
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
            clearLoadingTimer();
            try { await videoElement.play(); } catch {}
            if (!isCurrentPlayback()) {
              return;
            }
            setPlayerState("playing");
            setupMetadataListeners();
            return;
          }
          logger.info("[Player] Xtream HLS conversion failed, trying streaming proxy");
        }
      }

      // 3. Try mpegts.js via localhost streaming proxy for MPEG-TS or unknown streams
      if (streamType === "mpegts" || streamType === "unknown") {
        let proxyPort = 0;
        try {
          proxyPort = await getStreamingProxyPort();
        } catch {
          logger.warn("[Player] Could not get streaming proxy port");
        }
        const playbackUrl = proxyPort > 0 ? toStreamingProxyUrl(url, proxyPort) : url;
        if (proxyPort > 0) {
          logger.info("[Player] Trying mpegts.js via streaming proxy for", result.name);
        } else {
          logger.info("[Player] Trying mpegts.js (raw URL) for", result.name);
        }
        const mpegtsOk = await tryMpegtsPlayback(playbackUrl, abortController.signal);
        if (!isCurrentPlayback()) {
          return;
        }
        if (mpegtsOk) {
          clearLoadingTimer();
          try { await videoElement.play(); } catch {}
          if (!isCurrentPlayback()) {
            return;
          }
          setPlayerState("playing");
          setupMetadataListeners();
          return;
        }
      }

      // 4. Final native playback fallback — handles formats the libraries can't
      // and gives slow-starting native HLS one untimed retry after the short probe.
      const nativeOk = await tryNativePlayback(url, abortController.signal);
      if (!isCurrentPlayback()) {
        return;
      }
      if (nativeOk) {
        clearLoadingTimer();
        try { await videoElement.play(); } catch {}
        if (!isCurrentPlayback()) {
          return;
        }
        setPlayerState("playing");
        setupMetadataListeners();
        return;
      }

      // All methods failed
      clearLoadingTimer();
      if (!isCurrentPlayback()) {
        return;
      }
      const reason = lastErrorRef.current ?? "Unable to play stream";
      logger.error("[Player] Playback failed for channel", result.name, "-", reason);
      setPlayerState("error");
      setErrorMessage(reason);
      setActiveChannelIndex(null);
      onPlaybackFailedRef.current?.(result);
    },
    [
      cleanup,
      clearLoadingTimer,
      setupMetadataListeners,
      tryNativePlayback,
      tryHlsPlayback,
      tryMpegtsPlayback,
      videoElement,
    ],
  );

  const stop = useCallback(() => {
    cleanup();
    setPlayerState("idle");
    setErrorMessage(null);
    setIsPaused(false);
    setActiveChannelIndex(null);
  }, [cleanup]);

  const togglePause = useCallback(() => {
    if (videoElement.paused) {
      videoElement.play().catch(() => {});
      setIsPaused(false);
    } else {
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
