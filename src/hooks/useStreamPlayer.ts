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

const LOADING_TIMEOUT_MS = 15_000;

export function useStreamPlayer(
  videoRef: React.RefObject<HTMLVideoElement | null>,
): UseStreamPlayerReturn {
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(readStoredVolume);
  const [muted, setMuted] = useState(readStoredMuted);
  const [isPaused, setIsPaused] = useState(false);
  const [activeChannelIndex, setActiveChannelIndex] = useState<number | null>(null);

  const hlsInstanceRef = useRef<import("hls.js").default | null>(null);
  const mpegtsPlayerRef = useRef<{ destroy(): void; attachMediaElement(el: HTMLMediaElement): void; load(): void } | null>(null);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    if (hlsInstanceRef.current) {
      hlsInstanceRef.current.destroy();
      hlsInstanceRef.current = null;
    }
    if (mpegtsPlayerRef.current) {
      mpegtsPlayerRef.current.destroy();
      mpegtsPlayerRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, [videoRef]);

  const applyVolume = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [videoRef, volume, muted]);

  useEffect(() => {
    applyVolume();
  }, [applyVolume]);

  useEffect(() => {
    try { localStorage.setItem("player-volume", String(volume)); } catch {}
  }, [volume]);

  useEffect(() => {
    try { localStorage.setItem("player-muted", String(muted)); } catch {}
  }, [muted]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const tryNativePlayback = useCallback(
    (url: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const video = videoRef.current;
        if (!video) { resolve(false); return; }

        const onCanPlay = () => {
          video.removeEventListener("canplay", onCanPlay);
          video.removeEventListener("error", onError);
          resolve(true);
        };
        const onError = () => {
          video.removeEventListener("canplay", onCanPlay);
          video.removeEventListener("error", onError);
          video.removeAttribute("src");
          video.load();
          resolve(false);
        };

        video.addEventListener("canplay", onCanPlay, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.src = url;
        applyVolume();
        video.load();
      });
    },
    [videoRef, applyVolume],
  );

  const tryHlsPlayback = useCallback(
    async (url: string): Promise<boolean> => {
      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) return false;

      return new Promise((resolve) => {
        const video = videoRef.current;
        if (!video) { resolve(false); return; }

        const hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });
        hlsInstanceRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          resolve(true);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            hls.destroy();
            hlsInstanceRef.current = null;
            resolve(false);
          }
        });

        hls.loadSource(url);
        hls.attachMedia(video);
        applyVolume();
      });
    },
    [videoRef, applyVolume],
  );

  const tryMpegtsPlayback = useCallback(
    async (url: string): Promise<boolean> => {
      const mpegtsModule = await import("mpegts.js");
      const mpegts = mpegtsModule.default;
      if (!mpegts.isSupported()) return false;

      return new Promise((resolve) => {
        const video = videoRef.current;
        if (!video) { resolve(false); return; }

        const player = mpegts.createPlayer({
          type: "mpegts",
          url,
          isLive: true,
        });
        mpegtsPlayerRef.current = player;

        const onCanPlay = () => {
          video.removeEventListener("canplay", onCanPlay);
          video.removeEventListener("error", onError);
          resolve(true);
        };
        const onError = () => {
          video.removeEventListener("canplay", onCanPlay);
          video.removeEventListener("error", onError);
          player.destroy();
          mpegtsPlayerRef.current = null;
          resolve(false);
        };

        video.addEventListener("canplay", onCanPlay, { once: true });
        video.addEventListener("error", onError, { once: true });

        player.attachMediaElement(video);
        player.load();
        applyVolume();
      });
    },
    [videoRef, applyVolume],
  );

  const play = useCallback(
    async (result: ChannelResult) => {
      cleanup();
      setPlayerState("loading");
      setErrorMessage(null);
      setIsPaused(false);
      setActiveChannelIndex(result.index);

      // Always use the original URL for playback — stream_url may be a resolved
      // segment URL (e.g. a .ts segment from HLS manifest traversal) rather than
      // the top-level playlist entry point.
      const url = result.url;
      const streamType = classifyStream(url);

      loadingTimerRef.current = setTimeout(() => {
        cleanup();
        setPlayerState("error");
        setErrorMessage("Connection timed out after 15 seconds.");
      }, LOADING_TIMEOUT_MS);

      // 1. Try native playback first
      const nativeOk = await tryNativePlayback(url);
      if (nativeOk) {
        if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
        const video = videoRef.current;
        if (video) {
          try { await video.play(); } catch {}
        }
        setPlayerState("playing");
        return;
      }

      // 2. Try hls.js for HLS or unknown streams
      if (streamType === "hls" || streamType === "unknown") {
        const hlsOk = await tryHlsPlayback(url);
        if (hlsOk) {
          if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
          const video = videoRef.current;
          if (video) {
            try { await video.play(); } catch {}
          }
          setPlayerState("playing");
          return;
        }
      }

      // 3. Try mpegts.js for MPEG-TS or unknown streams
      if (streamType === "mpegts" || streamType === "unknown") {
        const mpegtsOk = await tryMpegtsPlayback(url);
        if (mpegtsOk) {
          if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
          const video = videoRef.current;
          if (video) {
            try { await video.play(); } catch {}
          }
          setPlayerState("playing");
          return;
        }
      }

      // All methods failed
      if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
      setPlayerState("error");
      setErrorMessage(
        "Unable to play this stream in-app. The server may block browser playback (CORS). Try the external player instead.",
      );
    },
    [cleanup, tryNativePlayback, tryHlsPlayback, tryMpegtsPlayback, videoRef],
  );

  const stop = useCallback(() => {
    cleanup();
    setPlayerState("idle");
    setErrorMessage(null);
    setIsPaused(false);
    setActiveChannelIndex(null);
  }, [cleanup]);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setIsPaused(false);
    } else {
      video.pause();
      setIsPaused(true);
    }
  }, [videoRef]);

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
    play,
    stop,
    togglePause,
    setVolume,
    toggleMute,
  };
}
