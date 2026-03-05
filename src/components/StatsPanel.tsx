import { memo } from "react";
import type { ScanProgress, ScanSummary } from "../lib/types";
import type { ScanState } from "../hooks/useScan";

interface StatsPanelProps {
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  totalChannels: number;
  scanState: ScanState;
  lowFpsCount: number;
  mislabeledCount: number;
  duplicateCount: number;
}

export const StatsPanel = memo(function StatsPanel({
  progress,
  summary,
  totalChannels,
  scanState,
  lowFpsCount,
  mislabeledCount,
  duplicateCount,
}: StatsPanelProps) {
  const stats = summary ?? progress;
  const effectiveLowFpsCount = summary?.low_framerate ?? lowFpsCount;
  const effectiveMislabeledCount = summary?.mislabeled ?? mislabeledCount;
  const showRightStatus =
    scanState === "paused" ||
    effectiveLowFpsCount > 0 ||
    effectiveMislabeledCount > 0 ||
    duplicateCount > 0;

  return (
    <div className="flex items-center gap-4 px-4 py-2 text-[13px] border-t border-border-app bg-panel-subtle glass-material">
      <span className="text-text-secondary">
        {totalChannels} total
      </span>
      {stats && (
        <>
          <span className="text-green-400">
            {stats.alive} ✓
          </span>
          {stats.drm > 0 && (
            <span className="text-cyan-400">
              {stats.drm} ⚿
            </span>
          )}
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
          {summary.playlist_score && (
            <span className="text-blue-400">
              Score {summary.playlist_score.overall.toFixed(1)}/10
            </span>
          )}
        </>
      )}
      {showRightStatus && (
        <div className="ml-auto flex items-center gap-4">
          {scanState === "paused" && (
            <span className="text-yellow-400 font-medium uppercase tracking-[0.04em]">
              Paused
            </span>
          )}
          {effectiveLowFpsCount > 0 && (
            <span className="text-orange-400">
              ⚠ {effectiveLowFpsCount} low fps
            </span>
          )}
          {effectiveMislabeledCount > 0 && (
            <span className="text-orange-400">
              ✕ {effectiveMislabeledCount} mislabeled
            </span>
          )}
          {duplicateCount > 0 && (
            <span className="text-orange-400">
              ⚠ {duplicateCount} duplicates
            </span>
          )}
        </div>
      )}
    </div>
  );
});
