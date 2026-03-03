import type { ScanProgress } from "../lib/types";

export function ProgressBar({ progress }: { progress: ScanProgress | null }) {
  if (!progress) return null;

  const percent =
    progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;

  return (
    <div className="px-4 py-2 border-t border-border-app bg-panel-subtle">
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
      </div>
    </div>
  );
}
