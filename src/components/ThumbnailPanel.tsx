import type { ChannelResult } from "../lib/types";
import { formatAudioInfo, formatVideoInfo, statusLabel } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface ThumbnailPanelProps {
  result: ChannelResult | null;
  screenshotUrl: string | null;
}

export function ThumbnailPanel({ result, screenshotUrl }: ThumbnailPanelProps) {
  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
        Select a channel to view details
      </div>
    );
  }

  return (
    <div className="native-scroll flex flex-col gap-3 p-4 overflow-y-auto">
      <div className="flex items-center gap-2">
        <StatusBadge status={result.status} />
        <h3 className="text-sm font-semibold truncate">{result.name}</h3>
      </div>

      {screenshotUrl && (
        <div className="rounded-lg overflow-hidden border border-border-app bg-black">
          <img
            src={screenshotUrl}
            alt={result.name}
            className="w-full h-auto"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-text-tertiary">Status</span>
          <p className="font-medium">{statusLabel(result.status)}</p>
        </div>
        <div>
          <span className="text-text-tertiary">Group</span>
          <p className="font-medium">{result.group}</p>
        </div>
        {result.status === "alive" && (
          <>
            <div>
              <span className="text-text-tertiary">Video</span>
              <p className="font-medium">{formatVideoInfo(result)}</p>
            </div>
            <div>
              <span className="text-text-tertiary">Audio</span>
              <p className="font-medium">{formatAudioInfo(result)}</p>
            </div>
            {result.resolution && (
              <div>
                <span className="text-text-tertiary">Resolution</span>
                <p className="font-medium">
                  {result.width}x{result.height}
                </p>
              </div>
            )}
            {result.fps && (
              <div>
                <span className="text-text-tertiary">Frame Rate</span>
                <p className="font-medium">{result.fps} fps</p>
              </div>
            )}
          </>
        )}
      </div>

      {result.label_mismatches.length > 0 && (
        <div className="p-2 rounded bg-orange-500/10 border border-orange-500/20">
          <p className="text-xs font-medium text-orange-400">Label Mismatch</p>
          {result.label_mismatches.map((m, i) => (
            <p key={i} className="text-xs text-orange-300">
              {m}
            </p>
          ))}
        </div>
      )}

      {result.low_framerate && (
        <div className="p-2 rounded bg-orange-500/10 border border-orange-500/20">
          <p className="text-xs text-orange-400">
            Low framerate: {result.fps} fps
          </p>
        </div>
      )}
    </div>
  );
}
