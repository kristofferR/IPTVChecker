import { memo, startTransition, type ReactNode } from "react";
import {
  SFCheckmarkCircleFill,
  SFXmarkCircleFill,
  SFLockFill,
  SFShieldFill,
  SFListNumber,
  SFExclamationTriangleFill,
  SFTagFill,
  SFDocOnDocFill,
  SFPhotoFill,
} from "./SFSymbols";
import { useAppStore } from "../store";


function Pill({
  icon,
  label,
  color,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const colorMap: Record<string, { base: string; active: string }> = {
    neutral: {
      base: "text-text-secondary bg-btn/60",
      active: "text-text-primary bg-btn ring-1 ring-text-secondary",
    },
    green: {
      base: "text-green-400 bg-green-400/10",
      active: "text-green-300 bg-green-400/25 ring-1 ring-green-400/50",
    },
    red: {
      base: "text-red-400 bg-red-400/10",
      active: "text-red-300 bg-red-400/25 ring-1 ring-red-400/50",
    },
    yellow: {
      base: "text-yellow-400 bg-yellow-400/10",
      active: "text-yellow-300 bg-yellow-400/25 ring-1 ring-yellow-400/50",
    },
    cyan: {
      base: "text-cyan-400 bg-cyan-400/10",
      active: "text-cyan-300 bg-cyan-400/25 ring-1 ring-cyan-400/50",
    },
    blue: {
      base: "text-blue-400 bg-blue-400/10",
      active: "text-blue-300 bg-blue-400/25 ring-1 ring-blue-400/50",
    },
    orange: {
      base: "text-orange-400 bg-orange-400/10",
      active: "text-orange-300 bg-orange-400/25 ring-1 ring-orange-400/50",
    },
  };

  const colors = colorMap[color] ?? colorMap.neutral;
  const clickable = onClick != null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] tabular-nums select-none transition-colors ${
        active ? colors.active : colors.base
      } ${clickable ? "cursor-pointer hover:brightness-125" : "cursor-default"}`}
    >
      {icon}
      {label}
    </button>
  );
}

const iconSize = "w-3 h-3";

export const StatsPanel = memo(function StatsPanel() {
  const progress = useAppStore((s) => s.progress);
  const summary = useAppStore((s) => s.summary);
  const totalChannels = useAppStore(
    (s) => s.playlist?.total_channels ?? 0,
  );
  const scanState = useAppStore((s) => s.scanState);
  const lowFpsCount = useAppStore((s) => s.uiMetrics.lowFpsCount);
  const mislabeledCount = useAppStore((s) => s.uiMetrics.mislabeledCount);
  const duplicateCount = useAppStore((s) => s.duplicateIndices.size);
  const statusFilter = useAppStore((s) => s.statusFilter);
  const setStatusFilter = useAppStore((s) => s.setStatusFilter);
  const toggleReportPanel = useAppStore((s) => s.toggleReportPanel);
  const stats = summary ?? progress;
  const effectiveLowFpsCount = summary?.low_framerate ?? lowFpsCount;
  const effectiveMislabeledCount = summary?.mislabeled ?? mislabeledCount;
  const showRightStatus =
    scanState === "cancelling" ||
    scanState === "paused" ||
    effectiveLowFpsCount > 0 ||
    effectiveMislabeledCount > 0 ||
    duplicateCount > 0;

  function handleStatusChange(value: string) {
    startTransition(() => setStatusFilter(value));
  }

  function toggleFilter(value: string) {
    handleStatusChange(statusFilter === value ? "all" : value);
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border-app bg-panel-subtle glass-material select-none">
      <Pill
        icon={<SFListNumber className={iconSize} />}
        label={`${totalChannels} total`}
        color="neutral"
        active={statusFilter === "all"}
        onClick={() => handleStatusChange("all")}
      />
      {stats && (
        <>
          <Pill
            icon={<SFCheckmarkCircleFill className={iconSize} />}
            label={String(stats.alive)}
            color="green"
            active={statusFilter === "alive"}
            onClick={() => toggleFilter("alive")}
          />
          {stats.drm > 0 && (
            <Pill
              icon={<SFShieldFill className={iconSize} />}
              label={String(stats.drm)}
              color="cyan"
              active={statusFilter === "drm"}
              onClick={() => toggleFilter("drm")}
            />
          )}
          <Pill
            icon={<SFXmarkCircleFill className={iconSize} />}
            label={String(stats.dead)}
            color="red"
            active={statusFilter === "dead"}
            onClick={() => toggleFilter("dead")}
          />
          <Pill
            icon={<SFLockFill className={iconSize} />}
            label={String(stats.geoblocked)}
            color="yellow"
            active={statusFilter === "geoblocked"}
            onClick={() => toggleFilter("geoblocked")}
          />
          {stats.placeholder > 0 && (
            <Pill
              icon={<SFPhotoFill className={iconSize} />}
              label={String(stats.placeholder)}
              color="orange"
              active={statusFilter === "placeholder"}
              onClick={() => toggleFilter("placeholder")}
            />
          )}
        </>
      )}
      {summary?.playlist_score && (
        <Pill
          icon={null}
          label={`Score ${summary.playlist_score.overall.toFixed(1)}/10`}
          color="blue"
          onClick={toggleReportPanel}
        />
      )}
      {showRightStatus && (
        <div className="ml-auto flex items-center gap-2">
          {scanState === "paused" && (
            <span className="text-[12px] text-yellow-400 font-medium uppercase tracking-[0.04em]">
              Paused
            </span>
          )}
          {scanState === "cancelling" && (
            <span className="text-[12px] text-orange-400 font-medium uppercase tracking-[0.04em]">
              Stopping
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
              active={statusFilter === "mislabeled"}
              onClick={() => toggleFilter("mislabeled")}
            />
          )}
          {duplicateCount > 0 && (
            <Pill
              icon={<SFDocOnDocFill className={iconSize} />}
              label={`${duplicateCount} duplicates`}
              color="orange"
              active={statusFilter === "duplicates"}
              onClick={() => toggleFilter("duplicates")}
            />
          )}
        </div>
      )}
    </div>
  );
});
