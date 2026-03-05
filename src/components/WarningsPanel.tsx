import { memo } from "react";
import { AlertTriangle } from "lucide-react";

interface WarningsPanelProps {
  lowFpsCount: number;
  mislabeledCount: number;
  duplicateCount: number;
}

export const WarningsPanel = memo(function WarningsPanel({
  lowFpsCount,
  mislabeledCount,
  duplicateCount,
}: WarningsPanelProps) {
  if (lowFpsCount === 0 && mislabeledCount === 0 && duplicateCount === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-4 px-4 py-2 text-[13px] border-t border-border-app bg-orange-500/5">
      {lowFpsCount > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {lowFpsCount} low fps
        </span>
      )}
      {mislabeledCount > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {mislabeledCount} mislabeled
        </span>
      )}
      {duplicateCount > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {duplicateCount} duplicates found
        </span>
      )}
    </div>
  );
});
