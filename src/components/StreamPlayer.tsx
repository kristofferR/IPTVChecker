import {
  AlertTriangle,
  Cast,
  History,
  LoaderCircle,
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UseChromecastResult } from "../hooks/useChromecast";
import { type ArchiveSession, MAX_PLAYBACK_RECOVERY_ATTEMPTS } from "../hooks/useStreamPlayer";
import { formatCount, getFormatLocale, t, tRich } from "../i18n";
import { isCastSessionActive } from "../lib/cast";
import type { CastMediaRequest } from "../lib/types";
import { CastMenu, type CastStartHandler } from "./CastMenu";

function formatArchiveClock(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString(getFormatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBehindLive(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0
    ? t("player.behindLiveHours", { hours: formatCount(hours), minutes: formatCount(minutes) })
    : t("player.behindLiveMinutes", { minutes: formatCount(minutes) });
}

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
  /** Active catch-up session; enables the archive badge, seek bar, GO LIVE. */
  archiveSession?: ArchiveSession | null;
  /** Needed to poll the playback position for the archive seek bar. */
  videoElement?: HTMLVideoElement;
  onSeekArchive?: (epochS: number) => void;
  onGoLive?: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  onCastStart?: CastStartHandler;
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
  archiveSession,
  videoElement,
  onSeekArchive,
  onGoLive,
  onTogglePause,
  onStop,
  onCastStart,
  onSetVolume,
  onToggleMute,
  onOpenExternal,
  onRetry,
  onFullscreen,
  onPip,
}: StreamPlayerProps) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [castMenuPinned, setCastMenuPinned] = useState(false);
  const [archivePositionS, setArchivePositionS] = useState(0);
  const [archiveScrubEpochS, setArchiveScrubEpochS] = useState<number | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCastUi = !compact && !!castRequest && !!chromecast;
  const isCasting = isCastSessionActive(chromecast?.session ?? null);

  useEffect(() => {
    setArchivePositionS(0);
    setArchiveScrubEpochS(null);
    if (!archiveSession || !videoElement || playerState !== "playing") {
      return;
    }
    const tick = () => setArchivePositionS(videoElement.currentTime);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [archiveSession, videoElement, playerState]);

  const archiveCurrentEpochS = archiveSession
    ? archiveSession.startEpochS + archivePositionS
    : null;

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
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
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
    if (onCastStart) {
      return onCastStart();
    }
    onStop();
    return undefined;
  }, [onCastStart, onStop]);

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video overflow-hidden rounded-lg border border-border-app bg-black"
      onMouseMove={showControls}
      onMouseEnter={showControls}
    >
      {/* Video element is appended here by ThumbnailPanel */}

      {archiveSession && playerState !== "error" && archiveCurrentEpochS != null && (
        <div className="absolute top-2 start-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-violet-600/85 text-white text-[11px] font-medium shadow-md backdrop-blur-sm">
          <History className="w-3 h-3 rtl:-scale-x-100" />
          <span className="truncate max-w-[200px]">
            {archiveSession.title != null ? (
              <bdi>{archiveSession.title}</bdi>
            ) : (
              formatArchiveClock(archiveCurrentEpochS)
            )}
            {archiveSession.title
              ? ""
              : ` · ${formatBehindLive(Date.now() / 1000 - archiveCurrentEpochS)}`}
          </span>
        </div>
      )}

      {archiveSession && playerState !== "error" && onGoLive && (
        <button
          type="button"
          onClick={onGoLive}
          className="absolute top-2 end-2 px-2 py-0.5 rounded border border-white/40 bg-black/45 text-[10px] font-semibold text-white hover:bg-black/70 transition-colors"
        >
          {t("player.goLive")}
        </button>
      )}

      {showCastUi && isCasting && chromecast?.session && (
        <div className="absolute top-2 start-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-600/85 text-white text-[11px] font-medium shadow-md backdrop-blur-sm">
          <Cast className="w-3 h-3" />
          <span className="truncate max-w-[180px]">
            {tRich("cast.castingTo", { device: <bdi>{chromecast.session.deviceName}</bdi> })}
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
            {isRecovering ? (recoveryMessage ?? t("player.reconnecting")) : t("player.connecting")}
          </span>
          {isRecovering && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-100/85">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {recoveryAttempt
                  ? t("player.cleanReconnectAttempt", {
                      attempt: formatCount(recoveryAttempt),
                      maxAttempts: formatCount(MAX_PLAYBACK_RECOVERY_ATTEMPTS),
                    })
                  : t("player.cleanReconnect")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error overlay */}
      {playerState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-4 text-center">
          <p className="text-[12px] text-red-300 font-medium leading-relaxed max-w-[90%]">
            {errorMessage || t("player.playbackFailed")}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              {t("common.retry")}
            </button>
            <button
              type="button"
              onClick={onOpenExternal}
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {t("player.openExternal")}
            </button>
          </div>
        </div>
      )}

      {/* Controls overlay */}
      {playerState === "playing" && (
        <div
          className={`absolute inset-x-0 bottom-0 flex flex-col gap-1 px-2.5 py-2 bg-gradient-to-t from-black/70 to-transparent transition-opacity duration-200 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          {archiveSession && onSeekArchive && archiveCurrentEpochS != null && (
            // Media timelines run left to right in every locale.
            <input
              type="range"
              dir="ltr"
              min={archiveSession.windowStartEpochS}
              max={archiveSession.windowEndEpochS}
              step={10}
              value={Math.round(archiveScrubEpochS ?? archiveCurrentEpochS)}
              onChange={(e) => setArchiveScrubEpochS(Number.parseInt(e.target.value, 10))}
              onPointerUp={() => {
                if (archiveScrubEpochS != null) {
                  onSeekArchive(archiveScrubEpochS);
                  setArchiveScrubEpochS(null);
                }
              }}
              onKeyUp={(e) => {
                if (
                  [
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "ArrowUp",
                    "End",
                    "Home",
                    "PageDown",
                    "PageUp",
                  ].includes(e.key) &&
                  archiveScrubEpochS != null
                ) {
                  onSeekArchive(archiveScrubEpochS);
                  setArchiveScrubEpochS(null);
                }
              }}
              className="w-full h-1 accent-violet-400 cursor-pointer"
              title={formatArchiveClock(archiveScrubEpochS ?? archiveCurrentEpochS)}
            />
          )}
          <div dir="ltr" className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTogglePause}
              className="p-1 text-white hover:text-white/80 transition-colors"
              title={isPaused ? t("player.play") : t("player.pause")}
            >
              {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onStop}
              className="p-1 text-white hover:text-white/80 transition-colors"
              title={t("player.stop")}
            >
              <Square className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleMute}
              className="p-1 text-white hover:text-white/80 transition-colors ms-auto"
              title={muted ? t("player.unmute") : t("player.mute")}
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              dir="ltr"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => {
                onSetVolume(Number.parseFloat(e.target.value));
                if (muted) onToggleMute();
              }}
              className="w-16 h-1 accent-white cursor-pointer"
              title={t("player.volume", {
                percent: new Intl.NumberFormat(getFormatLocale(), {
                  style: "percent",
                  maximumFractionDigits: 0,
                }).format(muted ? 0 : volume),
              })}
            />
            {showCastUi && castRequest && chromecast && (
              <CastMenu
                chromecast={chromecast}
                castRequest={castRequest}
                mode="popover"
                onCastStart={handleCastStart}
                onOpenChange={setCastMenuPinned}
              />
            )}
            {onPip && (
              <button
                type="button"
                onClick={onPip}
                className="p-1 text-white hover:text-white/80 transition-colors ms-1"
                title={t("player.pictureInPicture")}
              >
                <PictureInPicture2 className="w-4 h-4" />
              </button>
            )}
            {onFullscreen && (
              <button
                type="button"
                onClick={onFullscreen}
                className="p-1 text-white hover:text-white/80 transition-colors ms-1"
                title={t("player.fullscreen")}
              >
                <Maximize className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
