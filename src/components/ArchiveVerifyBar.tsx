import { memo, useEffect, useState } from "react";
import { formatCount, getFormatLocale, t } from "../i18n";
import { cancelArchiveVerification } from "../lib/archiveVerifyRun";
import { useAppStore } from "../store";

function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = formatCount(Math.floor((total % 3600) / 60));
  if (hours > 0) return t("archive.verifyBar.etaHours", { hours: formatCount(hours), minutes });
  if (total >= 60) {
    return t("archive.verifyBar.etaMinutes", { minutes, seconds: formatCount(total % 60) });
  }
  return t("archive.verifyBar.etaSeconds", { seconds: formatCount(total) });
}

function formatRate(perMinute: number): string {
  const digits = perMinute >= 10 ? 0 : 1;
  return new Intl.NumberFormat(getFormatLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(perMinute);
}

/** Progress row for a catch-up verification run, in the scan bar's slot. */
export const ArchiveVerifyBar = memo(function ArchiveVerifyBar() {
  const run = useAppStore((s) => s.archiveVerifyRun);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run]);
  if (!run) return null;

  const percent = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const elapsedS = Math.max(1, (nowMs - run.startedAtMs) / 1000);
  const perMinute = run.done > 0 ? (run.done / elapsedS) * 60 : null;
  const etaS =
    perMinute != null && perMinute > 0 ? ((run.total - run.done) / perMinute) * 60 : null;
  const telemetry =
    perMinute == null
      ? t("archive.verifyBar.measuringSpeed")
      : t("archive.verifyBar.telemetry", {
          rate: formatRate(perMinute),
          eta: formatEta(etaS ?? 0),
        });
  const percentLabel = new Intl.NumberFormat(getFormatLocale(), { style: "percent" }).format(
    percent / 100,
  );

  return (
    <div className="px-4 py-2 border-t border-border-app bg-panel-subtle glass-material">
      <div className="flex items-center gap-3 text-[12px]">
        <span className="shrink-0 font-medium text-violet-300">
          {run.mode === "quick" ? t("archive.verifyBar.quick") : t("archive.verifyBar.full")}
        </span>
        <div className="flex-1 h-2.5 bg-btn rounded-full overflow-hidden">
          <div
            className="h-full bg-violet-500 rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-text-secondary tabular-nums whitespace-nowrap">
          {t("archive.verifyBar.progress", {
            done: formatCount(run.done),
            total: formatCount(run.total),
            percent: percentLabel,
          })}
        </span>
        <span className="flex shrink-0 items-center gap-2 tabular-nums whitespace-nowrap">
          <span className="text-green-400">
            ✓ {t("archive.verifyBar.real", { count: run.real })}
          </span>
          <span className="text-red-400">✕ {t("archive.verifyBar.fake", { count: run.fake })}</span>
          {run.mode === "full" && (
            <span className="text-amber-400">
              ⚠ {t("archive.verifyBar.shallower", { count: run.shallower })}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={cancelArchiveVerification}
          className="shrink-0 rounded-md border border-border-app bg-btn px-2 py-0.5 text-[11px] text-text-primary hover:bg-btn-hover transition-colors"
        >
          {t("common.cancel")}
        </button>
      </div>
      <div className="mt-1 text-[11px] text-text-tertiary tabular-nums">{telemetry}</div>
    </div>
  );
});
