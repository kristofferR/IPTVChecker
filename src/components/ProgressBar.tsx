import { memo } from "react";
import type { ScanProgress } from "../lib/types";
import type { ScanState } from "../hooks/useScan";

function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

interface ProgressBarProps {
  progress: ScanProgress | null;
  scanState: ScanState;
  throughputChannelsPerSecond: number | null;
  etaSeconds: number | null;
}

export const ProgressBar = memo(function ProgressBar({
  progress,
  scanState,
  throughputChannelsPerSecond,
  etaSeconds,
}: ProgressBarProps) {
  if (!progress) return null;

  const percent =
    progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;

  const showTelemetry = scanState === "scanning" || scanState === "paused";

  let telemetryLabel: string | null = null;
  if (showTelemetry) {
    if (scanState === "paused") {
      telemetryLabel = "—";
    } else if (throughputChannelsPerSecond == null) {
      telemetryLabel = "Calculating speed…";
    } else {
      const chPerMin = throughputChannelsPerSecond * 60;
      const throughputDisplay =
        chPerMin >= 10
          ? `${Math.round(chPerMin)} ch/min`
          : `${chPerMin.toFixed(1)} ch/min`;
      telemetryLabel = `${throughputDisplay} · ~${formatEta(etaSeconds)} remaining`;
    }
  }

  return (
    <div className="px-4 py-2 border-t border-border-app bg-panel-subtle glass-material">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2.5 bg-btn rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-[12px] text-text-secondary tabular-nums whitespace-nowrap">
          {progress.completed}/{progress.total} ({percent}%)
        </span>
        {scanState === "paused" && (
          <span className="text-[12px] text-yellow-400 font-medium uppercase tracking-[0.04em]">
            Paused
          </span>
        )}
      </div>
      {telemetryLabel != null && (
        <div className="mt-1 text-[11px] text-text-tertiary tabular-nums">
          {telemetryLabel}
        </div>
      )}
    </div>
  );
});
