import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Cast,
  LoaderCircle,
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { UseAirPlayResult } from "../hooks/useAirPlay";
import type { UseChromecastResult } from "../hooks/useChromecast";
import type { AirPlayMediaRequest, CastMediaRequest } from "../lib/types";
import { isAirPlaySessionActive, isCastSessionActive } from "../lib/cast";
import { CastMenu } from "./CastMenu";

interface StreamPlayerProps {
  playerState: "idle" | "loading" | "playing" | "error";
  errorMessage: string | null;
  isPaused: boolean;
  isRecovering: boolean;
  recoveryAttempt: number | null;
  recoveryMessage: string | null;
  volume: number;
  muted: boolean;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  castRequest?: CastMediaRequest | null;
  /**
   * When the player renders in a narrow context (e.g. the sidebar), set this
   * so the cast button + corner badge are skipped — the parent renders the
   * cast UI inline below the player instead.
   */
  compact?: boolean;
  /**
   * Shared chromecast hook from the parent. Required for the in-overlay cast
   * picker and the "Casting to ..." badge to render. When omitted, no cast
   * UI is shown regardless of `castRequest`.
   */
  chromecast?: UseChromecastResult;
  /**
   * Optional shared AirPlay hook (macOS only). When provided and `available`
   * is true, the in-overlay menu also offers an AirPlay button.
   */
  airplay?: UseAirPlayResult;
  airplayRequest?: AirPlayMediaRequest;
  onTogglePause: () => void;
  onStop: () => void;
  onSetVolume: (v: number) => void;
  onToggleMute: () => void;
  onOpenExternal: () => void;
  onRetry: () => void;
  onFullscreen?: () => void;
  onPip?: () => void;
}

export function StreamPlayer({
  playerState,
  errorMessage,
  isPaused,
  isRecovering,
  recoveryAttempt,
  recoveryMessage,
  volume,
  muted,
  containerRef,
  castRequest,
  compact = false,
  chromecast,
  airplay,
  airplayRequest,
  onTogglePause,
  onStop,
  onSetVolume,
  onToggleMute,
  onOpenExternal,
  onRetry,
  onFullscreen,
  onPip,
}: StreamPlayerProps) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [castMenuPinned, setCastMenuPinned] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCastUi = !compact && !!castRequest && !!chromecast;
  const isCasting = isCastSessionActive(chromecast?.session ?? null);
  const isAirPlaying = isAirPlaySessionActive(airplay?.session ?? null);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    // Don't auto-hide while the cast picker is open — the user may still be
    // reading the device list when the timer would otherwise fire.
    if (castMenuPinned) return;
    if (playerState === "playing" && !isPaused) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, [playerState, isPaused, castMenuPinned]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (castMenuPinned) {
      setControlsVisible(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      return;
    }
    if (playerState === "playing" && !isPaused) {
      scheduleHide();
    } else {
      setControlsVisible(true);
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [playerState, isPaused, scheduleHide, castMenuPinned]);

  const handleCastStart = useCallback(() => {
    // Fully stop the local player (don't just pause). Most IPTV upstreams
    // enforce a single-connection limit — a paused player still holds its
    // upstream slot, which causes the server to kick the cast pipeline's
    // ffmpeg every few seconds. Each reconnect introduces a DTS jump that
    // the Chromecast HLS player can't recover from cleanly, so the cast
    // session goes idle/error within seconds.
    onStop();
  }, [onStop]);

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video overflow-hidden rounded-lg border border-border-app bg-black"
      onMouseMove={showControls}
      onMouseEnter={showControls}
    >
      {/* Video element is appended here by ThumbnailPanel */}

      {showCastUi && isCasting && chromecast?.session && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-600/85 text-white text-[11px] font-medium shadow-md backdrop-blur-sm">
          <Cast className="w-3 h-3" />
          <span className="truncate max-w-[180px]">
            Casting to {chromecast.session.deviceName}
          </span>
        </div>
      )}
      {showCastUi && !isCasting && isAirPlaying && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-600/85 text-white text-[11px] font-medium shadow-md backdrop-blur-sm">
          <Cast className="w-3 h-3" />
          <span className="truncate max-w-[180px]">
            {airplay?.session?.externalPlaybackActive
              ? "AirPlaying to receiver"
              : "AirPlay window open"}
          </span>
        </div>
      )}

      {/* Loading overlay */}
      {playerState === "loading" && (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center gap-2 ${
            isRecovering ? "bg-amber-950/65" : "bg-black/60"
          }`}
        >
          <LoaderCircle className="h-6 w-6 animate-spin text-white" />
          <span className="text-[12px] font-medium text-white/85">
            {isRecovering ? recoveryMessage ?? "Reconnecting..." : "Connecting..."}
          </span>
          {isRecovering && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-100/85">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                Trying a clean reconnect{recoveryAttempt ? ` (${recoveryAttempt}/2)` : ""}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error overlay */}
      {playerState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-4 text-center">
          <p className="text-[12px] text-red-300 font-medium leading-relaxed max-w-[90%]">
            {errorMessage || "Playback failed"}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onOpenExternal}
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              Open External
            </button>
          </div>
        </div>
      )}

      {/* Controls overlay */}
      {playerState === "playing" && (
        <div
          className={`absolute inset-x-0 bottom-0 flex items-center gap-2 px-2.5 py-2 bg-gradient-to-t from-black/70 to-transparent transition-opacity duration-200 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <button
            type="button"
            onClick={onTogglePause}
            className="p-1 text-white hover:text-white/80 transition-colors"
            title={isPaused ? "Play" : "Pause"}
          >
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onStop}
            className="p-1 text-white hover:text-white/80 transition-colors"
            title="Stop"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            className="p-1 text-white hover:text-white/80 transition-colors ml-auto"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => {
              onSetVolume(Number.parseFloat(e.target.value));
              if (muted) onToggleMute();
            }}
            className="w-16 h-1 accent-white cursor-pointer"
            title={`Volume: ${Math.round((muted ? 0 : volume) * 100)}%`}
          />
          {showCastUi && castRequest && chromecast && (
            <CastMenu
              chromecast={chromecast}
              castRequest={castRequest}
              airplay={airplay}
              airplayRequest={airplayRequest}
              mode="popover"
              onCastStart={handleCastStart}
              onAirPlayStart={handleCastStart}
              onOpenChange={setCastMenuPinned}
            />
          )}
          {onPip && (
            <button
              type="button"
              onClick={onPip}
              className="p-1 text-white hover:text-white/80 transition-colors ml-1"
              title="Picture-in-Picture"
            >
              <PictureInPicture2 className="w-4 h-4" />
            </button>
          )}
          {onFullscreen && (
            <button
              type="button"
              onClick={onFullscreen}
              className="p-1 text-white hover:text-white/80 transition-colors ml-1"
              title="Fullscreen"
            >
              <Maximize className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
