import type { ChannelResult } from "../lib/types";
import { AlertTriangle } from "lucide-react";

interface WarningsPanelProps {
  results: (ChannelResult | null)[];
}

export function WarningsPanel({ results }: WarningsPanelProps) {
  const nonNull = results.filter((r): r is ChannelResult => r != null);
  const lowFps = nonNull.filter((r) => r.low_framerate);
  const mislabeled = nonNull.filter((r) => r.label_mismatches.length > 0);

  if (lowFps.length === 0 && mislabeled.length === 0) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-2 text-[13px] border-t border-border-app bg-orange-500/5">
      {lowFps.length > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {lowFps.length} low fps
        </span>
      )}
      {mislabeled.length > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {mislabeled.length} mislabeled
        </span>
      )}
    </div>
  );
}
