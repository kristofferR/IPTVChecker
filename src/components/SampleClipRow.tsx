import { CircleDot, ExternalLink, FolderOpen, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatCount, t, tRich } from "../i18n";
import { getSampleClipActions } from "../lib/sampleClip";
import { getSampleClipPreviewUrl, openMediaArtifact, revealMediaArtifact } from "../lib/tauri";
import type { ChannelResult } from "../lib/types";

const iconButtonClass =
  "p-1 rounded text-text-secondary hover:text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-40 disabled:pointer-events-none";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fills once over the recording length. Not looped, so nothing keeps
 * repainting after the capture ends. */
function CaptureProgress({ durationSecs }: { durationSecs: number }) {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setStarted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="h-[3px] w-28 overflow-hidden rounded-full bg-border-app">
      <div
        className="h-full rounded-full bg-red-500"
        style={{ width: started ? "95%" : "0%", transition: `width ${durationSecs}s linear` }}
      />
    </div>
  );
}

interface SampleClipRowProps {
  result: ChannelResult;
  scanActive: boolean;
  durationSecs: number;
  onCapture: (result: ChannelResult) => Promise<void>;
}

export function SampleClipRow({ result, scanActive, durationSecs, onCapture }: SampleClipRowProps) {
  const [capturing, setCapturing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const autoStartPendingRef = useRef(false);
  const clipPath = result.sample_clip_path ?? null;
  const actions = getSampleClipActions(result, { capturing, scanActive, previewFailed });

  // A new capture replaces the clip, so any open preview refers to a stale file.
  useEffect(() => {
    setPreviewing(false);
    setPreviewFailed(false);
  }, [clipPath]);

  // Resolve the local preview URL only once play is clicked.
  useEffect(() => {
    if (!previewing || !clipPath) return;
    let cancelled = false;
    getSampleClipPreviewUrl(clipPath)
      .then((url) => {
        if (!cancelled) setPreviewUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
      setPreviewUrl(null);
    };
  }, [previewing, clipPath]);

  // WebKitGTK stalls a media source assigned before the element is attached
  // or played before it can play, so assign it once mounted and start from
  // onCanPlay. Playback only ever follows the play click.
  useEffect(() => {
    const video = videoRef.current;
    if (!previewUrl || !video) return;
    autoStartPendingRef.current = true;
    video.src = previewUrl;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }, [previewUrl]);

  if (!actions.visible) return null;

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const handleCapture = () =>
    run(async () => {
      setCapturing(true);
      try {
        await onCapture(result);
      } finally {
        setCapturing(false);
      }
    });

  const duration = formatCount(durationSecs);
  const captureTitle = scanActive
    ? t("player.panel.scanInProgress")
    : t("player.sample.captureTitle", { duration });
  const showPreview = previewing && actions.canPreview;

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-2 text-[12px]">
      {showPreview && previewUrl && (
        // biome-ignore lint/a11y/useMediaCaption: stream-copied clips carry no caption track.
        <video
          ref={videoRef}
          // Native media controls keep their left-to-right timeline.
          dir="ltr"
          controls
          playsInline
          onCanPlay={(event) => {
            if (!autoStartPendingRef.current) return;
            autoStartPendingRef.current = false;
            void event.currentTarget.play().catch(() => {});
          }}
          onError={() => setPreviewFailed(true)}
          className="w-full aspect-video rounded-lg border border-border-app bg-black"
        />
      )}

      <div className="flex min-h-7 items-center justify-between gap-2">
        {capturing ? (
          <>
            <span className="text-text-tertiary">{t("player.sample.recording", { duration })}</span>
            <CaptureProgress durationSecs={durationSecs} />
          </>
        ) : clipPath ? (
          <>
            <span
              className="whitespace-nowrap"
              title={
                result.sample_clip_format === "ts" ? t("player.sample.tsExternalOnly") : undefined
              }
            >
              {tRich("player.sample.label", {
                format: (
                  <span dir="ltr" className="text-text-tertiary">
                    {result.sample_clip_format?.toUpperCase() ?? ""}
                  </span>
                ),
              })}
            </span>
            <span className="flex items-center gap-0.5">
              {actions.canPreview && (
                <button
                  type="button"
                  onClick={() => setPreviewing((value) => !value)}
                  className={iconButtonClass}
                  aria-label={previewing ? t("player.sample.stop") : t("player.sample.play")}
                  title={previewing ? t("player.sample.stop") : t("player.sample.play")}
                >
                  {previewing ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => run(() => openMediaArtifact(clipPath))}
                className={iconButtonClass}
                aria-label={t("player.sample.openExternalLabel")}
                title={t("player.panel.openInExternalPlayer")}
              >
                <ExternalLink className="h-3.5 w-3.5 rtl:-scale-x-100" />
              </button>
              <button
                type="button"
                onClick={() => run(() => revealMediaArtifact(clipPath))}
                className={iconButtonClass}
                aria-label={t("player.sample.showInFolderLabel")}
                title={t("player.sample.showInFolder")}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleCapture}
                disabled={!actions.canCapture}
                className={iconButtonClass}
                aria-label={t("player.sample.captureAgain")}
                title={captureTitle}
              >
                <CircleDot className="h-3.5 w-3.5" />
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="text-text-tertiary">{t("player.sample.none")}</span>
            <button
              type="button"
              onClick={handleCapture}
              disabled={!actions.canCapture}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-text-secondary hover:text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
              title={captureTitle}
            >
              <CircleDot className="h-3.5 w-3.5" />
              {t("player.sample.capture", { duration })}
            </button>
          </>
        )}
      </div>

      {previewFailed && (
        <p className="text-[11px] text-text-tertiary">{t("player.sample.previewUnavailable")}</p>
      )}
      <p role="alert" className="text-[11px] text-red-300 break-words empty:hidden">
        {error}
      </p>
      <span role="status" className="sr-only">
        {capturing
          ? t("player.sample.recordingStatus", { count: durationSecs })
          : previewFailed
            ? t("player.sample.previewUnavailableStatus")
            : ""}
      </span>
    </div>
  );
}
