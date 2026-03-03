import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ChannelResult,
  PlaylistPreview,
  ScanConfig,
} from "./lib/types";
import {
  openPlaylist,
  checkFfmpegAvailable,
  readScreenshot,
  openChannelInPlayer,
} from "./lib/tauri";
import { useScan } from "./hooks/useScan";
import { useSettings } from "./hooks/useSettings";
import { Toolbar } from "./components/Toolbar";
import { FilterBar } from "./components/FilterBar";
import { ChannelTable } from "./components/ChannelTable";
import { ThumbnailPanel } from "./components/ThumbnailPanel";
import { StatsPanel } from "./components/StatsPanel";
import { WarningsPanel } from "./components/WarningsPanel";
import { ProgressBar } from "./components/ProgressBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { AlertTriangle, FolderOpen, Info, X } from "lucide-react";
import { detectPlatform } from "./lib/platform";

function errorToString(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function formatPlaylistOpenError(err: unknown): string {
  const raw = errorToString(err).replace(/^error:\s*/i, "").trim();
  if (!raw || raw === "[object Object]") {
    return "Failed to open playlist. Please verify the file path and playlist format.";
  }
  return raw.toLowerCase().startsWith("failed to open playlist")
    ? raw
    : `Failed to open playlist: ${raw}`;
}

export default function App() {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const modKey = isMac ? "Cmd" : "Ctrl";

  const [playlist, setPlaylist] = useState<PlaylistPreview | null>(null);
  const [search, setSearch] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedChannel, setSelectedChannel] = useState<ChannelResult | null>(
    null,
  );
  const [selectedChannelIndices, setSelectedChannelIndices] = useState<number[]>(
    [],
  );
  const [showSettings, setShowSettings] = useState(false);
  const [ffmpegWarning, setFfmpegWarning] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playlistOpenError, setPlaylistOpenError] = useState<string | null>(
    null,
  );
  const [pendingPlaybackChannel, setPendingPlaybackChannel] =
    useState<ChannelResult | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [menuInfo, setMenuInfo] = useState<string | null>(null);
  const [menuExportRequest, setMenuExportRequest] = useState<{
    id: number;
    action: "csv" | "split" | "renamed";
  } | null>(null);

  const { settings, save: saveSettings } = useSettings();
  const {
    results,
    progress,
    summary,
    scanState,
    error,
    start,
    cancel,
    initFromPlaylist,
  } = useScan();

  // Detect platform and set data attribute for theme
  useEffect(() => {
    detectPlatform()
      .then((p) => {
        document.documentElement.dataset.platform = p;
      })
      .catch(() => {
        // Keep startup platform hint when plugin-os isn't available yet.
      });
  }, []);

  // Check ffmpeg on mount
  useEffect(() => {
    checkFfmpegAvailable().then(([ffmpeg, ffprobe]) => {
      if (!ffmpeg || !ffprobe) {
        setFfmpegWarning(true);
      }
    });
  }, []);

  // Auto-dismiss error banner after 10 seconds
  useEffect(() => {
    if (error) {
      setErrorDismissed(false);
      const timer = setTimeout(() => setErrorDismissed(true), 10000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    if (!playbackError) return;
    const timer = setTimeout(() => setPlaybackError(null), 10000);
    return () => clearTimeout(timer);
  }, [playbackError]);

  useEffect(() => {
    if (!playlistOpenError) return;
    const timer = setTimeout(() => setPlaylistOpenError(null), 10000);
    return () => clearTimeout(timer);
  }, [playlistOpenError]);

  useEffect(() => {
    if (!menuInfo) return;
    const timer = setTimeout(() => setMenuInfo(null), 8000);
    return () => clearTimeout(timer);
  }, [menuInfo]);

  const handleOpen = useCallback(async () => {
    setPlaylistOpenError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [
          { name: "M3U Playlists", extensions: ["m3u", "m3u8"] },
        ],
        directory: false,
      });
      if (!path) return;

      const selectedPath = Array.isArray(path) ? path[0] : path;
      if (!selectedPath) return;

      const searchTrimmed = channelSearch.trim() || undefined;
      console.log(`[App] Opening playlist: ${selectedPath}, channelSearch: "${searchTrimmed ?? ""}"`);
      const preview = await openPlaylist(selectedPath, undefined, searchTrimmed);
      console.log(`[App] Playlist loaded: ${preview.file_name}, channels=${preview.total_channels}, groups=${preview.groups.length}`, preview.groups);
      setPlaylist(preview);
      initFromPlaylist(preview.channels);
      setSearch("");
      setGroupFilter("all");
      setStatusFilter("all");
      setPlaylistOpenError(null);
      setSelectedChannel(null);
      setSelectedChannelIndices([]);
      setPendingPlaybackChannel(null);
    } catch (err) {
      console.error("[App] Failed to open playlist", err);
      setPlaylistOpenError(formatPlaylistOpenError(err));
      // Keep app interaction predictable after a failed open attempt.
      setSelectedChannel(null);
      setSelectedChannelIndices([]);
      setPendingPlaybackChannel(null);
    }
  }, [initFromPlaylist, channelSearch]);

  // Keyboard shortcuts
  const showSettingsRef = useRef(showSettings);
  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  const pendingPlaybackRef = useRef<ChannelResult | null>(pendingPlaybackChannel);
  useEffect(() => {
    pendingPlaybackRef.current = pendingPlaybackChannel;
  }, [pendingPlaybackChannel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        handleOpen();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        setShowSettings((s) => !s);
      }
      if (e.key === "Escape") {
        if (pendingPlaybackRef.current) {
          setPendingPlaybackChannel(null);
          return;
        }
        if (showSettingsRef.current) setShowSettings(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleOpen]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [data-allow-native-context]",
        )
      ) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  const startScanWithSelection = useCallback(async (selection: number[]) => {
    if (!playlist) return;

    const config: ScanConfig = {
      file_path: playlist.file_path,
      group_filter: groupFilter !== "all" ? groupFilter : null,
      channel_search: channelSearch.trim() || null,
      selected_indices: selection.length > 0 ? selection : null,
      timeout: settings.timeout,
      extended_timeout: settings.extended_timeout,
      concurrency: settings.concurrency,
      retries: settings.retries,
      user_agent: settings.user_agent,
      skip_screenshots: settings.skip_screenshots,
      profile_bitrate: settings.profile_bitrate,
      proxy_file: settings.proxy_file,
      test_geoblock: settings.test_geoblock,
      screenshots_dir: settings.screenshots_dir,
    };

    await start(config, playlist.total_channels, selection);
  }, [playlist, settings, groupFilter, channelSearch, start]);

  const handleStartScan = useCallback(async () => {
    await startScanWithSelection(selectedChannelIndices);
  }, [selectedChannelIndices, startScanWithSelection]);

  const handleScanSelected = useCallback(
    (indices: number[]) => {
      void startScanWithSelection(indices);
    },
    [startScanWithSelection],
  );

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    const queueExport = (action: "csv" | "split" | "renamed") => {
      setMenuExportRequest((prev) => ({
        id: (prev?.id ?? 0) + 1,
        action,
      }));
    };

    const setup = async () => {
      unlisten.push(
        await listen("menu://open-playlist", () => {
          void handleOpen();
        }),
      );
      unlisten.push(
        await listen("menu://export-csv", () => queueExport("csv")),
      );
      unlisten.push(
        await listen("menu://export-split", () => queueExport("split")),
      );
      unlisten.push(
        await listen("menu://export-renamed", () => queueExport("renamed")),
      );
      unlisten.push(
        await listen("menu://toggle-sidebar", () =>
          setSidebarHidden((hidden) => !hidden),
        ),
      );
      unlisten.push(
        await listen("menu://clear-filters", () => {
          setSearch("");
          setChannelSearch("");
          setGroupFilter("all");
          setStatusFilter("all");
        }),
      );
      unlisten.push(
        await listen("menu://start-scan", () => {
          void handleStartScan();
        }),
      );
      unlisten.push(
        await listen("menu://stop-scan", () => {
          void cancel();
        }),
      );
      unlisten.push(
        await listen("menu://open-settings", () => setShowSettings(true)),
      );
      unlisten.push(
        await listen("menu://check-updates", () =>
          setMenuInfo("Update checking is not configured yet."),
        ),
      );
    };

    void setup();
    return () => {
      for (const off of unlisten) {
        off();
      }
    };
  }, [cancel, handleOpen, handleStartScan]);

  const handleSelectChannel = useCallback((result: ChannelResult) => {
    setSelectedChannel(result);
  }, []);

  const launchChannelInPlayer = useCallback(async (result: ChannelResult) => {
    try {
      await openChannelInPlayer({
        extinf_line: result.extinf_line,
        metadata_lines: result.metadata_lines,
        url: result.url,
      });
    } catch (err) {
      setPlaybackError(String(err));
    }
  }, []);

  const handleOpenChannel = useCallback(
    (result: ChannelResult) => {
      if (scanState === "scanning") {
        setPendingPlaybackChannel(result);
        return;
      }
      void launchChannelInPlayer(result);
    },
    [scanState, launchChannelInPlayer],
  );

  const handleProceedPlayback = useCallback(() => {
    if (!pendingPlaybackChannel) return;
    const channel = pendingPlaybackChannel;
    setPendingPlaybackChannel(null);
    void launchChannelInPlayer(channel);
  }, [pendingPlaybackChannel, launchChannelInPlayer]);

  const completedResults = results.filter(
    (r): r is ChannelResult => r != null,
  );

  // Keep sidebar in sync with live scan results
  const liveSelectedChannel =
    selectedChannel != null
      ? (results[selectedChannel.index] ?? selectedChannel)
      : null;

  // Load screenshot via custom Tauri command (bypasses fs/asset scope issues)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const screenshotPathRef = useRef<string | null>(null);
  useEffect(() => {
    const path = liveSelectedChannel?.screenshot_path?.trim() || null;
    if (path === screenshotPathRef.current) return;
    screenshotPathRef.current = path;

    if (!path) {
      setScreenshotUrl(null);
      return;
    }

    let stale = false;
    readScreenshot(path)
      .then((dataUrl) => {
        if (!stale) setScreenshotUrl(dataUrl);
      })
      .catch(() => {
        if (!stale) setScreenshotUrl(null);
      });
    return () => {
      stale = true;
    };
  }, [liveSelectedChannel?.screenshot_path]);

  return (
    <div className="flex flex-col h-screen bg-surface">
      <Toolbar
        onOpen={handleOpen}
        onStartScan={handleStartScan}
        onStopScan={cancel}
        onOpenSettings={() => setShowSettings(true)}
        scanState={scanState}
        hasPlaylist={playlist !== null}
        results={completedResults}
        playlistName={playlist?.file_name ?? ""}
        playlistPath={playlist?.file_path ?? ""}
        selectedCount={selectedChannelIndices.length}
        menuExportRequest={menuExportRequest}
      />

      {ffmpegWarning && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-400 text-[13px]">
          <AlertTriangle className="w-4 h-4" />
          ffmpeg/ffprobe not found. Screenshots and media info will be disabled.
        </div>
      )}

      {error && !errorDismissed && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setErrorDismissed(true)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {playbackError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{playbackError}</span>
          <button
            onClick={() => setPlaybackError(null)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {playlistOpenError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{playlistOpenError}</span>
          <button
            onClick={() => setPlaylistOpenError(null)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {menuInfo && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-500/10 border-b border-blue-500/20 text-blue-400 text-[13px]">
          <Info className="w-4 h-4" />
          <span className="flex-1">{menuInfo}</span>
          <button
            onClick={() => setMenuInfo(null)}
            className="p-1 hover:bg-blue-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        groups={playlist?.groups ?? []}
        groupFilter={groupFilter}
        onGroupChange={setGroupFilter}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        channelSearch={channelSearch}
        onChannelSearchChange={setChannelSearch}
        scanState={scanState}
      />

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          {playlist ? (
            <ChannelTable
              results={results}
              search={search}
              groupFilter={groupFilter}
              statusFilter={statusFilter}
              onSelectChannel={handleSelectChannel}
              onOpenChannel={handleOpenChannel}
              onSelectionChange={setSelectedChannelIndices}
              onScanSelected={handleScanSelected}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-tertiary">
              <div className="text-center px-4">
                <p className="text-lg font-medium mb-2">
                  No playlist loaded
                </p>
                <p className="text-[15px] mb-4">
                  Click Open or press{" "}
                  <kbd className="px-2 py-0.5 bg-input rounded text-[13px] border border-border-app">
                    {modKey}+O
                  </kbd>{" "}
                  to load an M3U playlist
                </p>
                <button
                  onClick={handleOpen}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/25 transition-colors"
                  type="button"
                >
                  <FolderOpen className="w-4 h-4" />
                  Open File
                </button>
              </div>
            </div>
          )}
        </div>

        {liveSelectedChannel && !sidebarHidden && (
          <div className="w-72 border-l border-border-app bg-panel-muted">
            <ThumbnailPanel
              result={liveSelectedChannel}
              screenshotUrl={screenshotUrl}
            />
          </div>
        )}
      </div>

      <WarningsPanel results={results} />
      <StatsPanel
        progress={progress}
        summary={summary}
        totalChannels={playlist?.total_channels ?? 0}
      />
      <ProgressBar progress={progress} />

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {pendingPlaybackChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-xl rounded-xl border border-border-app bg-overlay p-5 shadow-2xl">
            <h2 className="text-[16px] font-semibold mb-2">
              Scan currently running
            </h2>
            <p className="text-[14px] text-text-secondary leading-relaxed">
              A scan is currently running. Playing a channel while scanning may
              interfere with the scan or cause playback issues if the server&apos;s
              max connection limit is exceeded.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingPlaybackChannel(null)}
                className="macos-btn px-3 py-2 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={handleProceedPlayback}
                className="macos-btn macos-btn-primary px-3 py-2 min-h-9 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 rounded-md"
                type="button"
              >
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
