import type { ScanProgress, ScanSummary } from "../lib/types";

interface StatsPanelProps {
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  totalChannels: number;
}

export function StatsPanel({
  progress,
  summary,
  totalChannels,
}: StatsPanelProps) {
  const stats = summary ?? progress;

  return (
    <div className="flex items-center gap-4 px-4 py-2 text-[13px] border-t border-border-app bg-panel-subtle">
      <span className="text-text-secondary">
        {totalChannels} total
      </span>
      {stats && (
        <>
          <span className="text-green-400">
            {stats.alive} ✓
          </span>
          <span className="text-red-400">
            {stats.dead} ✕
          </span>
          <span className="text-yellow-400">
            {stats.geoblocked} 🔒
          </span>
        </>
      )}
      {summary && (
        <>
          {summary.low_framerate > 0 && (
            <span className="text-orange-400">
              ⚠ {summary.low_framerate} low fps
            </span>
          )}
          {summary.mislabeled > 0 && (
            <span className="text-orange-400">
              ⚠ {summary.mislabeled} mislabeled
            </span>
          )}
        </>
      )}
    </div>
  );
}
