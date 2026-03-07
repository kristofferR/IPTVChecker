import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Maximize, Pause, PictureInPicture2, Play, Square, Volume2, VolumeX } from "lucide-react";

interface StreamPlayerProps {
  playerState: "idle" | "loading" | "playing" | "error";
  errorMessage: string | null;
  isPaused: boolean;
  volume: number;
  muted: boolean;
  containerRef?: React.RefObject<HTMLDivElement | null>;
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
  volume,
  muted,
  containerRef,
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
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video overflow-hidden rounded-lg border border-border-app bg-black"
      onMouseMove={showControls}
      onMouseEnter={showControls}
    >
      {/* Video element is appended here by ThumbnailPanel */}

      {/* Loading overlay */}
      {playerState === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60">
          <LoaderCircle className="h-6 w-6 animate-spin text-white" />
          <span className="text-[12px] text-white/80 font-medium">Connecting...</span>
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
