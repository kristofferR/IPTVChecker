import { FolderOpen, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { recentTitle, recentValueLabel } from "../lib/recentPlaylists";
import { savedPlaylistSecondaryLabel } from "../lib/savedPlaylists";
import type { PlaylistLoadProgress, RecentPlaylistEntry, SavedPlaylistEntry } from "../lib/types";

const START_SCREEN_RECENT_LIMIT = 5;
const START_SCREEN_SAVED_LIMIT = 8;

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
              {playlistLoadProgress?.stage === "Connecting"
                ? "Connecting…"
                : playlistLoadProgress?.stage === "Downloading"
                  ? "Downloading playlist…"
                  : playlistLoadProgress?.stage === "Saving"
                    ? "Saving to cache…"
                    : playlistLoadProgress?.stage === "Parsing"
                      ? "Parsing playlist…"
                      : playlistLoadProgress?.stage === "Processing"
                        ? "Processing…"
                        : "Loading playlist…"}
            </p>
            {(playlistLoadProgress?.stage === "Connecting" ||
              playlistLoadProgress?.stage === "Saving") && (
              <p className="text-sm mt-1 text-text-quaternary">{playlistLoadProgress.detail}</p>
            )}
            {playlistLoadProgress?.stage === "Downloading" && (
              <p className="text-sm mt-1 tabular-nums">
                {(playlistLoadProgress.bytes_downloaded / (1024 * 1024)).toFixed(1)} MB
                {playlistLoadProgress.elapsed_secs > 0 && (
                  <span className="ml-2 text-text-quaternary">
                    {(
                      playlistLoadProgress.bytes_downloaded /
                      playlistLoadProgress.elapsed_secs /
                      (1024 * 1024)
                    ).toFixed(1)}{" "}
                    MB/s
                  </span>
                )}
              </p>
            )}
            {playlistLoadProgress?.stage === "Parsing" && (
              <div className="text-sm mt-1 tabular-nums">
                <p>{playlistLoadProgress.channels_found.toLocaleString()} entries found</p>
                <p className="text-text-quaternary">
                  {playlistLoadProgress.live_found.toLocaleString()} channels
                  <span className="mx-2">•</span>
                  {(
                    playlistLoadProgress.movie_found + playlistLoadProgress.series_found
                  ).toLocaleString()}{" "}
                  VOD
                  {(playlistLoadProgress.movie_found > 0 ||
                    playlistLoadProgress.series_found > 0) && (
                    <span className="ml-2">
                      ({playlistLoadProgress.movie_found.toLocaleString()} movies,{" "}
                      {playlistLoadProgress.series_found.toLocaleString()} series)
                    </span>
                  )}
                </p>
              </div>
            )}
            {playlistLoadProgress?.stage === "Processing" && (
              <p className="text-sm mt-1 text-text-quaternary">{playlistLoadProgress.detail}</p>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center">
              <div className="select-none pt-3">
                <p className="text-lg font-medium mb-2">No playlist loaded</p>
                <p className="text-[15px] mb-4">
                  Click Open or press{" "}
                  <kbd className="px-2 py-0.5 bg-input rounded text-[13px] border border-border-app">
                    {modKey}+O
                  </kbd>{" "}
                  to load an M3U playlist
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={onOpen}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/25 transition-colors"
                  type="button"
                >
                  <FolderOpen className="w-4 h-4" />
                  Open File
                </button>
                <button
                  onClick={onOpenFolder}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  <FolderOpen className="w-4 h-4" />
                  Open Folder
                </button>
                <button
                  onClick={onOpenUrl}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  Add URL
                </button>
                <button
                  onClick={onOpenXtream}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                  type="button"
                >
                  Add Xtream
                </button>
              </div>
            </div>

            <div className="mt-6 w-full max-w-xl text-left">
              {startScreenSavedPlaylists.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[12px] uppercase tracking-[0.08em] text-text-tertiary">
                      Saved Playlists
                    </p>
                    <button
                      onClick={onManageSavedPlaylists}
                      className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
                      type="button"
                    >
                      Manage…
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
                      Open Recent
                    </p>
                    <button
                      onClick={() => {
                        void onClearRecent();
                      }}
                      className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
                      type="button"
                    >
                      Clear
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
