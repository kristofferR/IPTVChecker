import { memo } from "react";
import { formatCount, getFormatLocale, t } from "../i18n";
import { isScanActive } from "../lib/scanState";
import { useAppStore } from "../store";

function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) return t("toolbar.progress.etaHours", { hours, minutes });
  if (minutes > 0) return t("toolbar.progress.etaMinutes", { minutes, seconds: secs });
  return t("toolbar.progress.etaSeconds", { seconds: secs });
}

export const ProgressBar = memo(function ProgressBar() {
  const progress = useAppStore((s) => s.progress);
  const scanState = useAppStore((s) => s.scanState);
  const throughputChannelsPerSecond = useAppStore((s) => s.telemetry.throughputChannelsPerSecond);
  const etaSeconds = useAppStore((s) => s.telemetry.etaSeconds);
  if (!progress) return null;

  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  const showTelemetry = isScanActive(scanState);

  let telemetryLabel: string | null = null;
  if (showTelemetry) {
    if (scanState === "paused") {
      telemetryLabel = "—";
    } else if (scanState === "cancelling") {
      telemetryLabel = t("toolbar.progress.stoppingScan");
    } else if (throughputChannelsPerSecond == null) {
      telemetryLabel = t("toolbar.progress.calculatingSpeed");
    } else {
      const chPerMin = throughputChannelsPerSecond * 60;
      const fractionDigits = chPerMin >= 10 ? 0 : 1;
      const rate = new Intl.NumberFormat(getFormatLocale(), {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(chPerMin);
      telemetryLabel = t("toolbar.progress.telemetry", { rate, eta: formatEta(etaSeconds) });
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
          {t("toolbar.progress.counter", {
            completed: formatCount(progress.completed),
            total: formatCount(progress.total),
            percent: formatCount(percent),
          })}
        </span>
        {scanState === "paused" && (
          <span className="text-[12px] text-yellow-400 font-medium uppercase tracking-[0.04em]">
            {t("toolbar.progress.paused")}
          </span>
        )}
        {scanState === "cancelling" && (
          <span className="text-[12px] text-orange-400 font-medium uppercase tracking-[0.04em]">
            {t("toolbar.progress.stopping")}
          </span>
        )}
      </div>
      {telemetryLabel != null && (
        <div className="mt-1 text-[11px] text-text-tertiary tabular-nums">{telemetryLabel}</div>
      )}
    </div>
  );
});
