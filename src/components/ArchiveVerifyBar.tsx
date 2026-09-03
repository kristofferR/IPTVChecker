import { memo, useEffect, useState } from "react";
import { cancelArchiveVerification } from "../lib/archiveVerifyRun";
import { useAppStore } from "../store";

function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
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
  const etaS = perMinute != null && perMinute > 0 ? ((run.total - run.done) / perMinute) * 60 : null;
  const telemetry =
    perMinute == null
      ? "Measuring speed…"
      : `${perMinute >= 10 ? Math.round(perMinute) : perMinute.toFixed(1)} ch/min · ~${formatEta(
          etaS ?? 0,
        )} remaining`;

  return (
    <div className="px-4 py-2 border-t border-border-app bg-panel-subtle glass-material">
      <div className="flex items-center gap-3 text-[12px]">
        <span className="shrink-0 font-medium text-violet-300">
          Verifying catch-up{run.mode === "quick" ? "" : " · full"}
        </span>
        <div className="flex-1 h-2.5 bg-btn rounded-full overflow-hidden">
          <div
            className="h-full bg-violet-500 rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-text-secondary tabular-nums whitespace-nowrap">
          {run.done}/{run.total} ({percent}%)
        </span>
        <span className="flex shrink-0 items-center gap-2 tabular-nums whitespace-nowrap">
          <span className="text-green-400">✓ {run.real} real</span>
          <span className="text-red-400">✕ {run.fake} fake</span>
          {run.mode === "full" && <span className="text-amber-400">⚠ {run.shallower} shallower</span>}
        </span>
        <button
          type="button"
          onClick={cancelArchiveVerification}
          className="shrink-0 rounded-md border border-border-app bg-btn px-2 py-0.5 text-[11px] text-text-primary hover:bg-btn-hover transition-colors"
        >
          Cancel
        </button>
      </div>
      <div className="mt-1 text-[11px] text-text-tertiary tabular-nums">{telemetry}</div>
    </div>
  );
});
