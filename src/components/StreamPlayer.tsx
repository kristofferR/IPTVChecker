import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Cast,
  LoaderCircle,
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useChromecast } from "../hooks/useChromecast";
import type { CastMediaRequest, ChromecastDevice } from "../lib/types";

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
  const [castMenuOpen, setCastMenuOpen] = useState(false);
  const [castStarting, setCastStarting] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const castMenuRef = useRef<HTMLDivElement>(null);

  const chromecast = useChromecast();
  const castSupported = !!castRequest;
  const isCasting =
    !!chromecast.session &&
    chromecast.session.state !== "stopped" &&
    chromecast.session.state !== "error";

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (playerState === "playing" && !isPaused) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, [playerState, isPaused]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (playerState === "playing" && !isPaused) {
      scheduleHide();
    } else {
      setControlsVisible(true);
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [playerState, isPaused, scheduleHide]);

  useEffect(() => {
    if (!castMenuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!castMenuRef.current) return;
      if (!castMenuRef.current.contains(event.target as Node)) {
        setCastMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [castMenuOpen]);

  const openCastMenu = useCallback(() => {
    setCastMenuOpen(true);
    void chromecast.refreshDevices();
  }, [chromecast]);

  const handleCastDevice = useCallback(
    async (device: ChromecastDevice) => {
      if (!castRequest) return;
      setCastStarting(true);
      try {
        await chromecast.cast(device, castRequest);
        setCastMenuOpen(false);
        if (!isPaused) onTogglePause();
      } catch {
        // error surfaces via chromecast.error; keep menu open so user sees it
      } finally {
        setCastStarting(false);
      }
    },
    [castRequest, chromecast, isPaused, onTogglePause],
  );

  const handleStopCast = useCallback(async () => {
    try {
      await chromecast.stop();
    } finally {
      setCastMenuOpen(false);
    }
  }, [chromecast]);

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video overflow-hidden rounded-lg border border-border-app bg-black"
      onMouseMove={showControls}
      onMouseEnter={showControls}
    >
      {/* Video element is appended here by ThumbnailPanel */}

      {isCasting && chromecast.session && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-600/85 text-white text-[11px] font-medium shadow-md backdrop-blur-sm">
          <Cast className="w-3 h-3" />
          <span className="truncate max-w-[180px]">
            Casting to {chromecast.session.deviceName}
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
          {castSupported && (
            <div ref={castMenuRef} className="relative ml-1">
              <button
                type="button"
                onClick={() => (castMenuOpen ? setCastMenuOpen(false) : openCastMenu())}
                className={`p-1 transition-colors ${
                  isCasting ? "text-blue-300 hover:text-blue-200" : "text-white hover:text-white/80"
                }`}
                title={isCasting ? `Casting to ${chromecast.session?.deviceName ?? "device"}` : "Cast"}
              >
                <Cast className="w-4 h-4" />
              </button>
              {castMenuOpen && (
                <div className="absolute bottom-full right-0 mb-2 w-64 rounded-md border border-white/10 bg-black/90 backdrop-blur-sm shadow-xl text-white text-[12px] z-10">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                    <span className="font-medium">
                      {isCasting ? "Casting" : "Cast to device"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void chromecast.refreshDevices()}
                      disabled={chromecast.discovering}
                      className="p-1 text-white/70 hover:text-white disabled:opacity-50"
                      title="Refresh devices"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${chromecast.discovering ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  {isCasting && chromecast.session && (
                    <div className="px-3 py-2 border-b border-white/10">
                      <div className="text-white/85">{chromecast.session.deviceName}</div>
                      <div className="text-[11px] text-white/55 capitalize">{chromecast.session.state}</div>
                      <button
                        type="button"
                        onClick={() => void handleStopCast()}
                        className="mt-2 w-full px-2 py-1 text-[11px] font-medium rounded bg-red-600/80 hover:bg-red-600 transition-colors"
                      >
                        Stop casting
                      </button>
                    </div>
                  )}
                  <div className="max-h-64 overflow-y-auto">
                    {chromecast.devices.length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-white/55 text-center">
                        {chromecast.discovering ? "Searching for devices..." : "No devices found"}
                      </div>
                    ) : (
                      chromecast.devices.map((device) => {
                        const isActive = chromecast.session?.deviceId === device.id && isCasting;
                        return (
                          <button
                            key={device.id}
                            type="button"
                            onClick={() => void handleCastDevice(device)}
                            disabled={castStarting || isActive}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-left"
                          >
                            <Cast className="w-3.5 h-3.5 shrink-0 text-white/70" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate">{device.friendlyName}</div>
                              {device.model && (
                                <div className="text-[10px] text-white/45 truncate">{device.model}</div>
                              )}
                            </div>
                            {isActive && <span className="text-[10px] text-blue-300">Active</span>}
                          </button>
                        );
                      })
                    )}
                  </div>
                  {chromecast.error && (
                    <div className="px-3 py-2 border-t border-white/10 text-[11px] text-red-300">
                      {chromecast.error}
                    </div>
                  )}
                </div>
              )}
            </div>
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
