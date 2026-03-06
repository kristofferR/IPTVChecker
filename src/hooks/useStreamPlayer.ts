import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelResult } from "../lib/types";

type PlayerState = "idle" | "loading" | "playing" | "error";
type StreamType = "hls" | "mpegts" | "unknown";

export interface UseStreamPlayerReturn {
  playerState: PlayerState;
  errorMessage: string | null;
  volume: number;
  muted: boolean;
  isPaused: boolean;
  activeChannelIndex: number | null;
  videoElement: HTMLVideoElement;
  play: (result: ChannelResult) => void;
  stop: () => void;
  togglePause: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
}

function classifyStream(url: string): StreamType {
  const lower = url.toLowerCase();
  if (lower.includes(".m3u8") || lower.includes("/hls/")) return "hls";
  if (lower.endsWith(".ts") || (lower.includes("/live/") && !lower.includes(".m3u8"))) return "mpegts";
  return "unknown";
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

  const hlsInstanceRef = useRef<import("hls.js").default | null>(null);
  const mpegtsPlayerRef = useRef<{ destroy(): void; attachMediaElement(el: HTMLMediaElement): void; load(): void } | null>(null);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackAbortRef = useRef<AbortController | null>(null);

  const clearLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    const abortController = playbackAbortRef.current;
    playbackAbortRef.current = null;
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    clearLoadingTimer();
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
  }, [clearLoadingTimer, videoElement]);

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
    (url: string, signal: AbortSignal): Promise<boolean> => {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }

        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          videoElement.removeEventListener("canplay", onCanPlay);
          videoElement.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onCanPlay = () => {
          finish(true);
        };
        const onError = () => {
          videoElement.removeAttribute("src");
          videoElement.load();
          finish(false);
        };
        const onAbort = () => {
          finish(false);
        };

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
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });
        hlsInstanceRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          finish(true);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            hls.destroy();
            hlsInstanceRef.current = null;
            finish(false);
          }
        });
        const onAbort = () => {
          hls.destroy();
          if (hlsInstanceRef.current === hls) {
            hlsInstanceRef.current = null;
          }
          finish(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });

        hls.loadSource(url);
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

      // Always use the original URL for playback — stream_url may be a resolved
      // segment URL (e.g. a .ts segment from HLS manifest traversal) rather than
      // the top-level playlist entry point.
      const url = result.url;
      const streamType = classifyStream(url);

      const currentResult = result;
      loadingTimerRef.current = setTimeout(() => {
        if (!isCurrentPlayback()) {
          return;
        }
        cleanup();
        setPlayerState("idle");
        setActiveChannelIndex(null);
        onPlaybackFailedRef.current?.(currentResult);
      }, LOADING_TIMEOUT_MS);

      // 1. Try native playback first
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
        return;
      }

      // 2. Try hls.js for HLS or unknown streams
      if (streamType === "hls" || streamType === "unknown") {
        const hlsOk = await tryHlsPlayback(url, abortController.signal);
        if (!isCurrentPlayback()) {
          return;
        }
        if (hlsOk) {
          clearLoadingTimer();
          try { await videoElement.play(); } catch {}
          if (!isCurrentPlayback()) {
            return;
          }
          setPlayerState("playing");
          return;
        }
      }

      // 3. Try mpegts.js for MPEG-TS or unknown streams
      if (streamType === "mpegts" || streamType === "unknown") {
        const mpegtsOk = await tryMpegtsPlayback(url, abortController.signal);
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
          return;
        }
      }

      // All methods failed — fall back to scanning
      clearLoadingTimer();
      if (!isCurrentPlayback()) {
        return;
      }
      setPlayerState("idle");
      setActiveChannelIndex(null);
      onPlaybackFailedRef.current?.(result);
    },
    [
      cleanup,
      clearLoadingTimer,
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
    play,
    stop,
    togglePause,
    setVolume,
    toggleMute,
  };
}
