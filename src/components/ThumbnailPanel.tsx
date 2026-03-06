import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, ImageOff, LoaderCircle, Play, X } from "lucide-react";
import type { ChannelResult } from "../lib/types";
import { formatAudioInfo, formatVideoInfo, statusLabel } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface ThumbnailPanelProps {
  result: ChannelResult | null;
  screenshotUrl: string | null;
  screenshotLoading: boolean;
  screenshotLoadError: boolean;
  screenshotsEnabled: boolean;
  scanState: "idle" | "scanning" | "paused" | "complete" | "cancelled";
  lightboxOpen: boolean;
  onLightboxChange: (open: boolean) => void;
  onPlayChannel?: (result: ChannelResult) => void;
}

export function ThumbnailPanel({
  result,
  screenshotUrl,
  screenshotLoading,
  screenshotLoadError,
  screenshotsEnabled,
  scanState,
  lightboxOpen,
  onLightboxChange,
  onPlayChannel,
}: ThumbnailPanelProps) {
  const [lightboxRendered, setLightboxRendered] = useState(false);
  const [lightboxVisible, setLightboxVisible] = useState(false);
  const [resolvedUrlCopied, setResolvedUrlCopied] = useState(false);

  const closeLightbox = useCallback(() => {
    onLightboxChange(false);
  }, [onLightboxChange]);

  const openLightbox = useCallback(() => {
    if (!screenshotUrl) return;
    onLightboxChange(true);
  }, [screenshotUrl, onLightboxChange]);

  // Sync with external lightbox state (e.g. space key toggle)
  useEffect(() => {
    if (lightboxOpen) {
      setLightboxRendered(true);
      requestAnimationFrame(() => setLightboxVisible(true));
    } else {
      setLightboxVisible(false);
    }
  }, [lightboxOpen]);

  useEffect(() => {
    if (!lightboxRendered) return;
    if (lightboxVisible) return;
    const timer = setTimeout(() => setLightboxRendered(false), 180);
    return () => clearTimeout(timer);
  }, [lightboxRendered, lightboxVisible]);

  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary text-[12px]">
        Select a channel to view details
      </div>
    );
  }

  const retryCount = result.retry_count ?? 0;
  const lastErrorReason =
    result.error_reason?.trim() ||
    result.last_error_reason?.trim() ||
    null;
  const resolvedUrl = result.stream_url?.trim() || null;
  const showResolvedUrl = !!resolvedUrl && resolvedUrl !== result.url;
  const scanActive = scanState === "scanning" || scanState === "paused";
  const waitingForScanResult =
    scanActive && (result.status === "pending" || result.status === "checking");
  const showUnscannedPlaceholder =
    !scanActive && (result.status === "pending" || result.status === "checking");
  const loadingStoredScreenshot =
    screenshotLoading || (!!result.screenshot_path && !screenshotUrl && !screenshotLoadError);
  const showLoadingPlaceholder = screenshotsEnabled && (waitingForScanResult || loadingStoredScreenshot);
  const showScreenshotError =
    screenshotsEnabled &&
    !showLoadingPlaceholder &&
    !screenshotUrl &&
    !!result.screenshot_path &&
    screenshotLoadError;
  const showDrmPlaceholder = result.status === "drm" && !screenshotUrl;
  const showNoThumbnailCaptured =
    screenshotsEnabled &&
    !showLoadingPlaceholder &&
    !screenshotUrl &&
    result.status === "alive" &&
    !result.screenshot_path;
  const showScreenshotsDisabled =
    !screenshotsEnabled &&
    result.status === "alive" &&
    !screenshotUrl;
  const mediaFrameClass = "relative w-full aspect-video overflow-hidden rounded-lg border border-border-app";
  const lightboxPlaceholderClass =
    "w-[400px] max-w-[88vw] aspect-video rounded-xl border border-white/15 bg-black/60 shadow-[0_35px_90px_rgba(0,0,0,0.55),0_5px_18px_rgba(0,0,0,0.28)]";

  const handleCopyResolvedUrl = useCallback(async () => {
    if (!resolvedUrl) return;
    try {
      await navigator.clipboard.writeText(resolvedUrl);
      setResolvedUrlCopied(true);
    } catch {
      setResolvedUrlCopied(false);
    }
  }, [resolvedUrl]);

  useEffect(() => {
    if (!resolvedUrlCopied) return;
    const timer = window.setTimeout(() => setResolvedUrlCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [resolvedUrlCopied]);

  useEffect(() => {
    setResolvedUrlCopied(false);
  }, [result.index, result.stream_url, result.url]);

  return (
    <div className="native-scroll flex flex-col gap-3 p-4 overflow-y-auto select-none">
      <div className="flex items-center gap-2">
        <StatusBadge status={result.status} />
        <h3 className="text-[14px] font-semibold truncate flex-1">{result.name}</h3>
        {onPlayChannel && (
          <button
            type="button"
            onClick={() => onPlayChannel(result)}
            className="shrink-0 flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-colors"
            title="Open in player"
          >
            <Play className="w-3.5 h-3.5 ml-0.5" />
          </button>
        )}
      </div>

      {screenshotUrl ? (
        <button
          type="button"
          onClick={openLightbox}
          className={`${mediaFrameClass} bg-black cursor-zoom-in group`}
        >
          <img
            src={screenshotUrl}
            alt={result.name}
            className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.015]"
          />
          <div className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] text-white/90 bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            Click to enlarge
          </div>
        </button>
      ) : showLoadingPlaceholder ? (
        <div className={`${mediaFrameClass} bg-panel-subtle isolate`}>
          <div className="absolute inset-0 rounded-[inherit] animate-pulse bg-gradient-to-br from-panel to-panel-subtle" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-secondary">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            <span className="text-[11px] font-medium">
              {waitingForScanResult ? "Waiting for scan result..." : "Loading thumbnail..."}
            </span>
          </div>
        </div>
      ) : showScreenshotError ? (
        <div className="flex w-full aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 text-center">
          <ImageOff className="h-9 w-9 text-red-300/90" strokeWidth={1.75} />
          <p className="text-[12px] font-medium text-red-200">Thumbnail unavailable</p>
          <p className="text-[11px] text-red-200/80">
            {lastErrorReason ? `Capture failed: ${lastErrorReason}` : "Capture timed out or decode failed."}
          </p>
        </div>
      ) : showDrmPlaceholder ? (
        <div className="flex w-full aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 text-center">
          <CircleHelp className="h-8 w-8 text-cyan-300/90" strokeWidth={1.75} />
          <p className="text-[12px] font-medium text-cyan-200">DRM-protected stream</p>
          <p className="text-[11px] text-cyan-200/80">
            {result.drm_system ? `Detected system: ${result.drm_system}` : "Detected encrypted playback requirements."}
          </p>
        </div>
      ) : showNoThumbnailCaptured ? (
        <div className="flex w-full aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-border-subtle bg-panel-subtle px-3 text-center">
          <CircleHelp className="h-8 w-8 text-text-tertiary" strokeWidth={1.75} />
          <p className="text-[12px] font-medium text-text-secondary">No thumbnail captured</p>
          <p className="text-[11px] text-text-tertiary">This channel scanned successfully, but no frame was saved.</p>
        </div>
      ) : showUnscannedPlaceholder ? (
        <div className="flex w-full aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-border-subtle bg-panel-subtle px-3 text-center">
          <CircleHelp className="h-8 w-8 text-text-tertiary" strokeWidth={1.75} />
          <p className="text-[12px] font-medium text-text-secondary">Unscanned</p>
          <p className="text-[11px] text-text-tertiary">Start a scan to capture this thumbnail.</p>
        </div>
      ) : showScreenshotsDisabled ? (
        <div className="flex w-full aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-border-subtle bg-panel-subtle px-3 text-center">
          <CircleHelp className="h-8 w-8 text-text-tertiary" strokeWidth={1.75} />
          <p className="text-[12px] font-medium text-text-secondary">Screenshots disabled</p>
          <p className="text-[11px] text-text-tertiary">Enable screenshots in Settings to capture thumbnails.</p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <span className="text-text-tertiary">Status</span>
          <p className="font-medium text-[12px]">{statusLabel(result.status)}</p>
        </div>
        <div>
          <span className="text-text-tertiary">Group</span>
          <p className="font-medium text-[12px]">{result.group}</p>
        </div>
        {result.status === "alive" && (
          <>
            <div>
              <span className="text-text-tertiary">Video</span>
              <p className="font-medium text-[12px]">{formatVideoInfo(result)}</p>
            </div>
            <div>
              <span className="text-text-tertiary">Audio</span>
              <p className="font-medium text-[12px]">{formatAudioInfo(result)}</p>
            </div>
            {result.resolution && (
              <div>
                <span className="text-text-tertiary">Resolution</span>
                <p className="font-medium text-[12px]">
                  {result.width}x{result.height}
                </p>
              </div>
            )}
            {result.fps && (
              <div>
                <span className="text-text-tertiary">Frame Rate</span>
                <p className="font-medium text-[12px]">{result.fps} fps</p>
              </div>
            )}
          </>
        )}
      </div>

      {result.status === "drm" && (
        <div className="p-2 rounded bg-cyan-500/10 border border-cyan-500/20">
          <p className="text-[12px] font-medium text-cyan-300">DRM Detection</p>
          <p className="text-[11px] text-cyan-200/90 mt-1">
            System: {result.drm_system ?? "Encrypted stream"}
          </p>
        </div>
      )}

      {result.label_mismatches.length > 0 && (
        <div className="p-2 rounded bg-orange-500/10 border border-orange-500/20">
          <p className="text-[12px] font-medium text-orange-400">Label Mismatch</p>
          {result.label_mismatches.map((m, i) => (
            <p key={i} className="text-[11px] text-orange-300">
              {m}
            </p>
          ))}
        </div>
      )}

      {result.low_framerate && (
        <div className="p-2 rounded bg-orange-500/10 border border-orange-500/20">
          <p className="text-[11px] text-orange-400">
            Low framerate: {result.fps} fps
          </p>
        </div>
      )}

      {(retryCount > 0 || lastErrorReason) && (
        <div className="p-2 rounded bg-panel-subtle border border-border-subtle">
          <p className="text-[12px] font-medium text-text-primary">Diagnostics</p>
          {retryCount > 0 && (
            <p className="text-[11px] text-text-secondary mt-1">
              Retries used: {retryCount}
            </p>
          )}
          {lastErrorReason && (
            <p className="text-[11px] text-text-secondary mt-1 break-words">
              Last error: {lastErrorReason}
            </p>
          )}
        </div>
      )}

      {showResolvedUrl && (
        <div className="p-2 rounded bg-panel-subtle border border-border-subtle">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] font-medium text-text-primary">Resolved URL</p>
            <button
              type="button"
              onClick={handleCopyResolvedUrl}
              className="macos-btn px-2 py-1 text-[11px] bg-btn hover:bg-btn-hover rounded-md"
            >
              {resolvedUrlCopied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[11px] text-text-secondary mt-1 break-all">{resolvedUrl}</p>
        </div>
      )}

      {lightboxRendered && createPortal(
        <div
          className={`fixed inset-0 z-[80] flex items-center justify-center px-6 py-10 transition-all duration-200 ${
            lightboxVisible ? "bg-black/70 opacity-100" : "bg-black/0 opacity-0"
          }`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeLightbox();
            }
          }}
        >
          <button
            type="button"
            onClick={closeLightbox}
            className="absolute top-5 right-5 p-2 rounded-full bg-black/35 text-white hover:bg-black/55 transition-colors"
            aria-label="Close image preview"
          >
            <X className="w-5 h-5" />
          </button>
          <div
            className={`max-h-full max-w-full flex flex-col items-center gap-3 transition-all duration-200 ${
              lightboxVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"
            }`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 className="text-white text-[15px] font-semibold truncate max-w-[88vw] text-center drop-shadow-lg">
              {result.name}
            </h2>
            {screenshotUrl ? (
              <img
                src={screenshotUrl}
                alt={result.name}
                className="block max-h-[84vh] max-w-[88vw] rounded-xl border border-white/15 shadow-[0_35px_90px_rgba(0,0,0,0.55),0_5px_18px_rgba(0,0,0,0.28)]"
              />
            ) : result.screenshot_path ? (
              <div className={lightboxPlaceholderClass} />
            ) : (
              <div className={`flex flex-col items-center justify-center gap-2 ${lightboxPlaceholderClass}`}>
                {result.status === "pending" || result.status === "checking" ? (
                  <>
                    <CircleHelp className="w-24 h-24 text-white/40" strokeWidth={1.5} />
                    <span className="text-white/50 text-[14px] font-medium">Unscanned</span>
                  </>
                ) : (
                  <X className="w-24 h-24 text-red-500/80" strokeWidth={2.5} />
                )}
              </div>
            )}
            {result.status === "alive" && (result.resolution || result.fps || result.video_bitrate || result.audio_bitrate) && (
              <div className="flex items-center justify-center gap-2 mt-2">
                {result.resolution && result.resolution !== "Unknown" && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] text-white/80 bg-white/10 backdrop-blur-sm">{result.width}x{result.height}</span>
                )}
                {result.fps && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] text-white/80 bg-white/10 backdrop-blur-sm">{result.fps} fps</span>
                )}
                {result.video_bitrate && result.video_bitrate !== "Unknown" && result.video_bitrate !== "N/A" && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] text-white/80 bg-white/10 backdrop-blur-sm">{result.video_bitrate}</span>
                )}
                {result.audio_bitrate && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] text-white/80 bg-white/10 backdrop-blur-sm">{result.audio_bitrate} kbps audio</span>
                )}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
