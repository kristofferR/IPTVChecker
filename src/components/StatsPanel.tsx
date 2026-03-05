import { memo, type ReactNode } from "react";
import type { ScanProgress, ScanSummary } from "../lib/types";
import type { ScanState } from "../hooks/useScan";
import {
  SFCheckmarkCircleFill,
  SFXmarkCircleFill,
  SFLockFill,
  SFShieldFill,
  SFListNumber,
  SFExclamationTriangleFill,
  SFTagFill,
  SFDocOnDocFill,
} from "./SFSymbols";

interface StatsPanelProps {
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  totalChannels: number;
  scanState: ScanState;
  lowFpsCount: number;
  mislabeledCount: number;
  duplicateCount: number;
}

function Pill({
  icon,
  label,
  color,
}: {
  icon: ReactNode;
  label: string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    neutral: "text-text-secondary bg-btn/60",
    green: "text-green-400 bg-green-400/10",
    red: "text-red-400 bg-red-400/10",
    yellow: "text-yellow-400 bg-yellow-400/10",
    cyan: "text-cyan-400 bg-cyan-400/10",
    blue: "text-blue-400 bg-blue-400/10",
    orange: "text-orange-400 bg-orange-400/10",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] tabular-nums ${colorMap[color] ?? colorMap.neutral}`}
    >
      {icon}
      {label}
    </span>
  );
}

const iconSize = "w-3 h-3";

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
    <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border-app bg-panel-subtle glass-material">
      <Pill
        icon={<SFListNumber className={iconSize} />}
        label={`${totalChannels} total`}
        color="neutral"
      />
      {stats && (
        <>
          <Pill
            icon={<SFCheckmarkCircleFill className={iconSize} />}
            label={String(stats.alive)}
            color="green"
          />
          {stats.drm > 0 && (
            <Pill
              icon={<SFShieldFill className={iconSize} />}
              label={String(stats.drm)}
              color="cyan"
            />
          )}
          <Pill
            icon={<SFXmarkCircleFill className={iconSize} />}
            label={String(stats.dead)}
            color="red"
          />
          <Pill
            icon={<SFLockFill className={iconSize} />}
            label={String(stats.geoblocked)}
            color="yellow"
          />
        </>
      )}
      {summary?.playlist_score && (
        <Pill
          icon={null}
          label={`Score ${summary.playlist_score.overall.toFixed(1)}/10`}
          color="blue"
        />
      )}
      {showRightStatus && (
        <div className="ml-auto flex items-center gap-2">
          {scanState === "paused" && (
            <span className="text-[12px] text-yellow-400 font-medium uppercase tracking-[0.04em]">
              Paused
            </span>
          )}
          {effectiveLowFpsCount > 0 && (
            <Pill
              icon={<SFExclamationTriangleFill className={iconSize} />}
              label={`${effectiveLowFpsCount} low fps`}
              color="orange"
            />
          )}
          {effectiveMislabeledCount > 0 && (
            <Pill
              icon={<SFTagFill className={iconSize} />}
              label={`${effectiveMislabeledCount} mislabeled`}
              color="orange"
            />
          )}
          {duplicateCount > 0 && (
            <Pill
              icon={<SFDocOnDocFill className={iconSize} />}
              label={`${duplicateCount} duplicates`}
              color="orange"
            />
          )}
        </div>
      )}
    </div>
  );
});
