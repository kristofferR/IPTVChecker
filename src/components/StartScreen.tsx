import { FolderOpen, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { formatCount, getFormatLocale, type MessageKey, t, tRich } from "../i18n";
import { translateReason } from "../i18n/reasons";
import { recentTitle, recentValueLabel } from "../lib/recentPlaylists";
import { savedPlaylistSecondaryLabel } from "../lib/savedPlaylists";
import type { PlaylistLoadProgress, RecentPlaylistEntry, SavedPlaylistEntry } from "../lib/types";

const START_SCREEN_RECENT_LIMIT = 5;
const START_SCREEN_SAVED_LIMIT = 8;

const LOAD_STAGE_KEYS = {
  Connecting: "start.loading.connecting",
  Downloading: "start.loading.downloading",
  Saving: "start.loading.saving",
  Parsing: "start.loading.parsing",
  Processing: "start.loading.processing",
} as const satisfies Record<PlaylistLoadProgress["stage"], MessageKey>;

function formatMegabytes(bytes: number): string {
  return new Intl.NumberFormat(getFormatLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / (1024 * 1024));
}

interface StartScreenProps {
  playlistLoading: boolean;
  playlistLoadProgress: PlaylistLoadProgress | null;
  /** Platform modifier key label ("Cmd" or "Ctrl") for the shortcut hint. */
  modKey: string;
  recentPlaylists: RecentPlaylistEntry[];
  savedPlaylists: SavedPlaylistEntry[];
  onOpen: () => void;
  onOpenFolder: () => void;
  onOpenUrl: () => void;
  onOpenXtream: () => void;
  onOpenDispatcharr: () => void;
  onManageSavedPlaylists: () => void;
  onOpenSaved: (id: string) => void;
  onOpenRecent: (entry: RecentPlaylistEntry) => void;
  onClearRecent: () => void | Promise<void>;
}

/** Empty-state screen shown when no playlist is loaded: open actions,
 *  load progress while a source is loading, and recent/saved playlist lists. */
export function StartScreen({
  playlistLoading,
  playlistLoadProgress,
  modKey,
  recentPlaylists,
  savedPlaylists,
  onOpen,
  onOpenFolder,
  onOpenUrl,
  onOpenXtream,
  onOpenDispatcharr,
  onManageSavedPlaylists,
  onOpenSaved,
  onOpenRecent,
  onClearRecent,
}: StartScreenProps) {
  const startScreenRecentPlaylists = useMemo(
    () => recentPlaylists.slice(0, START_SCREEN_RECENT_LIMIT),
    [recentPlaylists],
  );
  const startScreenSavedPlaylists = useMemo(
    () => savedPlaylists.slice(0, START_SCREEN_SAVED_LIMIT),
    [savedPlaylists],
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden native-scroll text-text-tertiary">
      <div className="min-h-full flex flex-col items-center justify-center text-center px-4 py-6">
        {playlistLoading ? (
          <div className="select-none">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-blue-500" />
            <p className="text-lg font-medium">
              {t(
                playlistLoadProgress
                  ? LOAD_STAGE_KEYS[playlistLoadProgress.stage]
                  : "start.loading.loading",
              )}
            </p>
            {(playlistLoadProgress?.stage === "Connecting" ||
              playlistLoadProgress?.stage === "Saving") && (
              <p className="text-sm mt-1 text-text-quaternary">
                {translateReason(playlistLoadProgress.detail)}
              </p>
            )}
            {playlistLoadProgress?.stage === "Downloading" && (
              <p className="text-sm mt-1 tabular-nums">
                {t("start.downloadedSize", {
                  size: formatMegabytes(playlistLoadProgress.bytes_downloaded),
                })}
                {playlistLoadProgress.elapsed_secs > 0 && (
                  <span className="ml-2 text-text-quaternary">
                    {t("start.downloadSpeed", {
                      speed: formatMegabytes(
                        playlistLoadProgress.bytes_downloaded / playlistLoadProgress.elapsed_secs,
                      ),
                    })}
                  </span>
                )}
              </p>
            )}
            {playlistLoadProgress?.stage === "Parsing" && (
              <div className="text-sm mt-1 tabular-nums">
                <p>{t("start.entriesFound", { count: playlistLoadProgress.channels_found })}</p>
                <p className="text-text-quaternary">
                  {t("common.channels", { count: playlistLoadProgress.live_found })}
                  <span className="mx-2">•</span>
                  {t("start.vodCount", {
                    count: playlistLoadProgress.movie_found + playlistLoadProgress.series_found,
                  })}
                  {(playlistLoadProgress.movie_found > 0 ||
                    playlistLoadProgress.series_found > 0) && (
                    <span className="ml-2">
                      {t("start.vodBreakdown", {
                        movies: formatCount(playlistLoadProgress.movie_found),
                        series: formatCount(playlistLoadProgress.series_found),
                      })}
                    </span>
                  )}
                </p>
              </div>
            )}
            {playlistLoadProgress?.stage === "Processing" && (
              <p className="text-sm mt-1 text-text-quaternary">
                {translateReason(playlistLoadProgress.detail)}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center">
              <div className="select-none pt-3">
                <p className="text-lg font-medium mb-2">{t("start.noPlaylist")}</p>
                <p className="text-[15px] mb-4">
                  {tRich("start.openHint", {
                    shortcut: (
                      <kbd className="px-2 py-0.5 bg-input rounded text-[13px] border border-border-app">
                        {modKey}+O
                      </kbd>
                    ),
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={onOpen}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/25 transition-colors"
                  type="button"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t("start.openFile")}
                </button>
                <button
                  onClick={onOpenFolder}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t("start.openFolder")}
                </button>
                <button
                  onClick={onOpenUrl}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  {t("start.addUrl")}
                </button>
                <button
                  onClick={onOpenXtream}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  {t("start.addXtream")}
                </button>
                <button
                  onClick={onOpenDispatcharr}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  {t("start.addDispatcharr")}
                </button>
              </div>
            </div>

            <div className="mt-6 w-full max-w-xl text-left">
              {startScreenSavedPlaylists.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[12px] uppercase tracking-[0.08em] text-text-tertiary">
                      {t("start.savedPlaylists")}
                    </p>
                    <button
                      onClick={onManageSavedPlaylists}
                      className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
                      type="button"
                    >
                      {t("start.manageSaved")}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {startScreenSavedPlaylists.map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => onOpenSaved(entry.id)}
                        className="w-full text-left px-3 py-2 rounded-lg border border-border-subtle hover:border-border-app hover:bg-panel-subtle transition-colors"
                        type="button"
                        title={savedPlaylistSecondaryLabel(entry)}
                      >
                        <span className="text-[13px] text-text-primary block truncate">
                          {entry.display_name}
                        </span>
                        <span className="text-[11px] text-text-tertiary block truncate mt-0.5">
                          {savedPlaylistSecondaryLabel(entry)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {startScreenRecentPlaylists.length > 0 && (
                <div className={startScreenSavedPlaylists.length > 0 ? "mt-6" : ""}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[12px] uppercase tracking-[0.08em] text-text-tertiary">
                      {t("start.openRecent")}
                    </p>
                    <button
                      onClick={() => {
                        void onClearRecent();
                      }}
                      className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
                      type="button"
                    >
                      {t("start.clearRecent")}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {startScreenRecentPlaylists.map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.value}`}
                        onClick={() => onOpenRecent(entry)}
                        className="w-full text-left px-3 py-2 rounded-lg border border-border-subtle hover:border-border-app hover:bg-panel-subtle transition-colors"
                        type="button"
                        title={recentTitle(entry)}
                      >
                        <span className="text-[13px] text-text-primary block truncate">
                          {entry.label}
                        </span>
                        <span className="text-[11px] text-text-tertiary block truncate mt-0.5">
                          {recentValueLabel(entry)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
