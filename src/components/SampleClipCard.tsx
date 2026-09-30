import { useEffect, useRef, useState } from "react";
import { getSampleClipActions } from "../lib/sampleClip";
import { getSampleClipPreviewUrl, openMediaArtifact, revealMediaArtifact } from "../lib/tauri";
import type { ChannelResult } from "../lib/types";

const buttonClass =
  "macos-btn px-2 py-1 text-[11px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-40 disabled:pointer-events-none";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SampleClipCardProps {
  result: ChannelResult;
  scanActive: boolean;
  durationSecs: number;
  onCapture: (result: ChannelResult) => Promise<void>;
}

export function SampleClipCard({
  result,
  scanActive,
  durationSecs,
  onCapture,
}: SampleClipCardProps) {
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

  // Resolve the local preview URL only once Play Sample is clicked.
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
  // onCanPlay. Playback only ever follows the Play Sample click.
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

  return (
    <div className="p-2 rounded bg-panel-subtle border border-border-subtle">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-text-primary">Sample Clip</p>
        {result.sample_clip_format && (
          <span className="text-[11px] text-text-tertiary">
            {result.sample_clip_format.toUpperCase()}
          </span>
        )}
      </div>

      {previewing && actions.canPreview && !previewUrl && (
        <p className="text-[11px] text-text-secondary mt-1">Loading preview...</p>
      )}
      {previewing && previewUrl && actions.canPreview && (
        // biome-ignore lint/a11y/useMediaCaption: stream-copied clips carry no caption track.
        <video
          ref={videoRef}
          controls
          playsInline
          onCanPlay={(event) => {
            if (!autoStartPendingRef.current) return;
            autoStartPendingRef.current = false;
            void event.currentTarget.play().catch(() => {});
          }}
          onError={() => setPreviewFailed(true)}
          className="mt-2 w-full aspect-video rounded bg-black"
        />
      )}

      {previewFailed && (
        <p className="text-[11px] text-text-secondary mt-1">
          Preview unavailable in app. Use Open or Reveal.
        </p>
      )}
      {error && <p className="text-[11px] text-red-300 mt-1 break-words">{error}</p>}

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <button
          type="button"
          onClick={handleCapture}
          disabled={!actions.canCapture}
          className={buttonClass}
          title={scanActive ? "Scan in progress" : `Record ${durationSecs}s without re-encoding`}
        >
          {capturing ? `Capturing ${durationSecs}s...` : "Capture Sample"}
        </button>
        {clipPath && actions.canPreview && (
          <button
            type="button"
            onClick={() => setPreviewing((value) => !value)}
            className={buttonClass}
          >
            {previewing ? "Close Preview" : "Play Sample"}
          </button>
        )}
        {clipPath && actions.canOpen && (
          <>
            <button
              type="button"
              onClick={() => run(() => openMediaArtifact(clipPath))}
              className={buttonClass}
              title="Open in external player"
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => run(() => revealMediaArtifact(clipPath))}
              className={buttonClass}
              title="Show in file manager"
            >
              Reveal
            </button>
          </>
        )}
      </div>
    </div>
  );
}
