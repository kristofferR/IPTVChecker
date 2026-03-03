import { useState, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppSettings,
  ChannelResult,
  PlaylistPreview,
  ScanConfig,
} from "./lib/types";
import { openPlaylist, checkFfmpegAvailable } from "./lib/tauri";
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
import { AlertTriangle } from "lucide-react";

export default function App() {
  const [playlist, setPlaylist] = useState<PlaylistPreview | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedChannel, setSelectedChannel] = useState<ChannelResult | null>(
    null,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [ffmpegWarning, setFfmpegWarning] = useState(false);

  const { settings, save: saveSettings } = useSettings();
  const {
    results,
    progress,
    summary,
    scanState,
    error,
    start,
    cancel,
    reset,
  } = useScan();

  // Check ffmpeg on mount
  useEffect(() => {
    checkFfmpegAvailable().then(([ffmpeg, ffprobe]) => {
      if (!ffmpeg || !ffprobe) {
        setFfmpegWarning(true);
      }
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "o") {
        e.preventDefault();
        handleOpen();
      }
      if (e.key === "Escape") {
        if (showSettings) setShowSettings(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showSettings]);

  const handleOpen = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [
        { name: "M3U Playlists", extensions: ["m3u", "m3u8"] },
      ],
      directory: false,
    });
    if (path) {
      const preview = await openPlaylist(path as string);
      setPlaylist(preview);
      reset();
      setSearch("");
      setGroupFilter("all");
      setStatusFilter("all");
      setSelectedChannel(null);
      // Update window title
      getCurrentWindow().setTitle(`IPTV Checker - ${preview.file_name}`);
    }
  }, [reset]);

  const handleStartScan = useCallback(async () => {
    if (!playlist) return;

    const config: ScanConfig = {
      file_path: playlist.file_path,
      group_filter: groupFilter !== "all" ? groupFilter : null,
      channel_search: null,
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

    await start(config, playlist.total_channels);
  }, [playlist, settings, groupFilter, start]);

  const handleSelectChannel = useCallback((result: ChannelResult) => {
    setSelectedChannel(result);
  }, []);

  const completedResults = results.filter(
    (r): r is ChannelResult => r !== null,
  );

  const screenshotUrl = selectedChannel?.screenshot_path
    ? convertFileSrc(selectedChannel.screenshot_path)
    : null;

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100">
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
      />

      {ffmpegWarning && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-400 text-xs">
          <AlertTriangle className="w-4 h-4" />
          ffmpeg/ffprobe not found. Screenshots and media info will be disabled.
        </div>
      )}

      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
          {error}
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
              selectedIndex={selectedChannel?.index ?? null}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600">
              <div className="text-center">
                <p className="text-lg font-medium mb-2">
                  No playlist loaded
                </p>
                <p className="text-sm">
                  Click Open or press{" "}
                  <kbd className="px-1.5 py-0.5 bg-zinc-800 rounded text-xs border border-zinc-700">
                    Cmd+O
                  </kbd>{" "}
                  to load an M3U playlist
                </p>
              </div>
            </div>
          )}
        </div>

        {selectedChannel && (
          <div className="w-72 border-l border-zinc-700 bg-zinc-800/30">
            <ThumbnailPanel
              result={selectedChannel}
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
    </div>
  );
}
