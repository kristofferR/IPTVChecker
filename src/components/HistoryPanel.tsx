import { Clock3, RefreshCw, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { getFormatLocale, t } from "../i18n";
import type { ScanHistoryItem } from "../lib/types";

interface HistoryPanelProps {
  playlistName: string;
  entries: ScanHistoryItem[];
  loading: boolean;
  error: string | null;
  clearing: boolean;
  onRefresh: () => void;
  onClear: () => void;
  onClose: () => void;
}

function formatScope(entry: ScanHistoryItem): string {
  const parts: string[] = [];
  if (entry.group_filter) {
    parts.push(t("history.scope.group", { group: entry.group_filter }));
  }
  if (entry.channel_search) {
    parts.push(t("history.scope.regex", { regex: entry.channel_search }));
  }
  if (entry.selected_count > 0) {
    parts.push(t("history.scope.selected", { count: entry.selected_count }));
  }
  return parts.length > 0 ? parts.join(" | ") : t("history.scope.fullPlaylist");
}

export default function HistoryPanel({
  playlistName,
  entries,
  loading,
  error,
  clearing,
  onRefresh,
  onClear,
  onClose,
}: HistoryPanelProps) {
  const hasEntries = entries.length > 0;
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.scanned_at_epoch_ms - a.scanned_at_epoch_ms),
    [entries],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={t("history.dialogLabel")}
    >
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[44rem] max-w-[96vw] border-l border-border-app bg-overlay backdrop-blur-xl flex flex-col">
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-border-app">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              {t("history.title")}
            </p>
            <h2 className="text-[17px] font-semibold">
              {playlistName || t("history.currentPlaylist")}
            </h2>
            <p className="text-[12px] text-text-secondary mt-1">{t("history.description")}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={t("history.closePanel")}
            className="p-1.5 hover:bg-btn-hover rounded-md transition-colors"
            type="button"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border-app bg-panel-subtle">
          <div className="text-[12px] text-text-secondary">
            {loading ? t("history.loading") : t("history.scansSaved", { count: entries.length })}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={loading}
              className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
              type="button"
            >
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" />
                {t("history.refresh")}
              </span>
            </button>
            <button
              onClick={onClear}
              disabled={!hasEntries || clearing}
              className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-red-500/15 text-red-300 hover:bg-red-500/25 rounded-md disabled:opacity-50 disabled:pointer-events-none"
              type="button"
            >
              <span className="inline-flex items-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" />
                {clearing ? t("history.clearing") : t("history.clearHistory")}
              </span>
            </button>
          </div>
        </div>

        <div className="native-scroll flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
              {error}
            </div>
          )}

          {!loading && sortedEntries.length === 0 && !error && (
            <div className="rounded-xl border border-border-app bg-panel-subtle px-4 py-5 text-[13px] text-text-secondary">
              {t("history.empty")}
            </div>
          )}

          {sortedEntries.map((entry) => {
            const when = new Date(entry.scanned_at_epoch_ms).toLocaleString(getFormatLocale());
            return (
              <article
                key={entry.id}
                className="rounded-xl border border-border-app bg-panel-subtle p-3.5"
              >
                <div className="flex items-center gap-2 text-[12px] text-text-tertiary mb-2">
                  <Clock3 className="w-3.5 h-3.5" />
                  <span>{when}</span>
                </div>

                <p className="text-[12px] text-text-secondary mb-2">{formatScope(entry)}</p>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <span className="text-text-secondary">
                    {t("history.summary.total", { count: entry.summary.total })}
                  </span>
                  <span className="text-green-400">
                    {t("history.summary.alive", { count: entry.summary.alive })}
                  </span>
                  <span className="text-cyan-400">
                    {t("history.summary.drm", { count: entry.summary.drm })}
                  </span>
                  <span className="text-red-400">
                    {t("history.summary.dead", { count: entry.summary.dead })}
                  </span>
                  <span className="text-yellow-400">
                    {t("history.summary.geoblocked", { count: entry.summary.geoblocked })}
                  </span>
                </div>

                {entry.diff ? (
                  <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-[12px]">
                    <div className="rounded-md bg-panel px-2 py-1">
                      {t("history.diff.gained", { count: entry.diff.channels_gained })}
                    </div>
                    <div className="rounded-md bg-panel px-2 py-1">
                      {t("history.diff.lost", { count: entry.diff.channels_lost })}
                    </div>
                    <div className="rounded-md bg-panel px-2 py-1">
                      {t("history.diff.changed", { count: entry.diff.status_changed })}
                    </div>
                    <div className="rounded-md bg-panel px-2 py-1 text-green-400">
                      {t("history.diff.up", { count: entry.diff.became_alive })}
                    </div>
                    <div className="rounded-md bg-panel px-2 py-1 text-red-400">
                      {t("history.diff.down", { count: entry.diff.became_dead })}
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-[12px] text-text-tertiary">
                    {t("history.noComparableScan")}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
