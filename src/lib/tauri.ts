import { invoke } from "@tauri-apps/api/core";
import { toCommandChannelResult } from "./channelResults";
import type {
  AppSettings,
  CastMediaRequest,
  CastSession,
  ChannelResult,
  ChromecastDevice,
  PlaylistPreview,
  RecentPlaylistEntry,
  RecentPlaylistKind,
  RenamePlaylistSourceInput,
  SavedPlaylistDraft,
  SavedPlaylistEntry,
  SavedPlaylistUpsertResult,
  ScanConfig,
  ScanHistoryItem,
  ScanPresetCollection,
  ScanPresetConfig,
  ScreenshotCacheStats,
  StalkerOpenRequest,
  UpdateCheckResult,
  UpdateInstallMode,
  XtreamOpenRequest,
  XtreamServerTestReport,
} from "./types";

function toCommandChannelResults(results: ChannelResult[]) {
  return results.map(toCommandChannelResult);
}

export async function openPlaylist(
  path: string,
  groupFilter?: string,
  channelSearch?: string,
): Promise<PlaylistPreview> {
  return invoke("open_playlist", {
    path,
    groupFilter: groupFilter ?? null,
    channelSearch: channelSearch ?? null,
  });
}

export async function openPlaylistUrl(
  url: string,
  groupFilter?: string,
  channelSearch?: string,
): Promise<PlaylistPreview> {
  return invoke("open_playlist_url", {
    url,
    groupFilter: groupFilter ?? null,
    channelSearch: channelSearch ?? null,
  });
}

export async function openPlaylistXtream(
  source: XtreamOpenRequest,
  groupFilter?: string,
  channelSearch?: string,
): Promise<PlaylistPreview> {
  return invoke("open_playlist_xtream", {
    source,
    groupFilter: groupFilter ?? null,
    channelSearch: channelSearch ?? null,
  });
}

export async function openPlaylistStalker(
  source: StalkerOpenRequest,
  groupFilter?: string,
  channelSearch?: string,
): Promise<PlaylistPreview> {
  return invoke("open_playlist_stalker", {
    source,
    groupFilter: groupFilter ?? null,
    channelSearch: channelSearch ?? null,
  });
}

export async function startScan(config: ScanConfig): Promise<string> {
  return invoke("start_scan", { config });
}

export async function cancelScan(): Promise<void> {
  return invoke("cancel_scan");
}

export async function pauseScan(): Promise<void> {
  return invoke("pause_scan");
}

export async function resumeScan(): Promise<void> {
  return invoke("resume_scan");
}

export async function resetScan(): Promise<void> {
  return invoke("reset_scan");
}

export async function quickCheckChannel(channel: ChannelResult): Promise<ChannelResult> {
  return invoke("quick_check_channel", { channel: toCommandChannelResult(channel) });
}

export async function exportCsv(
  results: ChannelResult[],
  path: string,
  playlistName: string,
  includeLatency: boolean,
): Promise<void> {
  return invoke("export_csv", {
    results: toCommandChannelResults(results),
    path,
    playlistName,
    includeLatency,
  });
}

export async function exportSplit(results: ChannelResult[], basePath: string): Promise<void> {
  return invoke("export_split", {
    results: toCommandChannelResults(results),
    basePath,
  });
}

export async function exportRenamed(results: ChannelResult[], basePath: string): Promise<void> {
  return invoke("export_renamed", {
    results: toCommandChannelResults(results),
    basePath,
  });
}

export async function exportM3u(results: ChannelResult[], path: string): Promise<void> {
  return invoke("export_m3u", {
    results: toCommandChannelResults(results),
    path,
  });
}

export async function exportScanLogJson(path: string): Promise<void> {
  return invoke("export_scan_log_json", { path });
}

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function updateSettings(settings: AppSettings): Promise<void> {
  return invoke("update_settings", { settings });
}

export async function getScanPresets(): Promise<ScanPresetCollection> {
  return invoke("get_scan_presets");
}

export async function saveScanPreset(
  name: string,
  config: ScanPresetConfig,
  setAsDefault = false,
): Promise<ScanPresetCollection> {
  return invoke("save_scan_preset", { name, config, set_as_default: setAsDefault });
}

export async function renameScanPreset(
  currentName: string,
  newName: string,
): Promise<ScanPresetCollection> {
  return invoke("rename_scan_preset", {
    current_name: currentName,
    new_name: newName,
  });
}

export async function deleteScanPreset(name: string): Promise<ScanPresetCollection> {
  return invoke("delete_scan_preset", { name });
}

export async function setDefaultScanPreset(name: string | null): Promise<ScanPresetCollection> {
  return invoke("set_default_scan_preset", { name });
}

export async function checkFfmpegAvailable(): Promise<[boolean, boolean]> {
  return invoke("check_ffmpeg_available");
}

export async function setDefaultM3u8FileAssociation(): Promise<string> {
  return invoke("set_default_m3u8_file_association");
}

export async function readScreenshot(path: string): Promise<string> {
  return invoke("read_screenshot", { path });
}

export async function getScreenshotCacheStats(): Promise<ScreenshotCacheStats> {
  return invoke("get_screenshot_cache_stats");
}

export async function clearScreenshotCache(): Promise<ScreenshotCacheStats> {
  return invoke("clear_screenshot_cache");
}

export async function getScanHistory(
  playlistPath: string,
  sourceIdentity?: string | null,
): Promise<ScanHistoryItem[]> {
  return invoke("get_scan_history", {
    playlistPath,
    sourceIdentity: sourceIdentity ?? null,
  });
}

export async function clearScanHistory(
  playlistPath: string,
  sourceIdentity?: string | null,
): Promise<number> {
  return invoke("clear_scan_history", {
    playlistPath,
    sourceIdentity: sourceIdentity ?? null,
  });
}

export async function getRecentPlaylists(): Promise<RecentPlaylistEntry[]> {
  return invoke("get_recent_playlists");
}

export async function addRecentPlaylist(
  kind: RecentPlaylistKind,
  value: string,
  label?: string | null,
  savedPlaylistId?: string | null,
): Promise<RecentPlaylistEntry[]> {
  return invoke("add_recent_playlist", {
    recent: {
      kind,
      value,
      label: label ?? null,
      saved_playlist_id: savedPlaylistId ?? null,
    },
  });
}

export async function clearRecentPlaylists(): Promise<RecentPlaylistEntry[]> {
  return invoke("clear_recent_playlists");
}

export async function getSavedPlaylists(): Promise<SavedPlaylistEntry[]> {
  return invoke("get_saved_playlists");
}

export async function upsertSavedPlaylist(
  draft: SavedPlaylistDraft,
): Promise<SavedPlaylistUpsertResult> {
  return invoke("upsert_saved_playlist", { draft });
}

export async function deleteSavedPlaylist(id: string): Promise<SavedPlaylistEntry[]> {
  return invoke("delete_saved_playlist", { id });
}

export async function openSavedPlaylist(
  id: string,
  groupFilter?: string,
  channelSearch?: string,
): Promise<PlaylistPreview> {
  return invoke("open_saved_playlist", {
    id,
    groupFilter: groupFilter ?? null,
    channelSearch: channelSearch ?? null,
  });
}

export async function renamePlaylistSource(input: RenamePlaylistSourceInput): Promise<void> {
  return invoke("rename_playlist_source", { input });
}

export async function testXtreamServers(
  servers: string[],
  username: string,
  password: string,
): Promise<XtreamServerTestReport> {
  return invoke("test_xtream_servers", { servers, username, password });
}

export async function openChannelInPlayer(channel: {
  extinf_line: string;
  metadata_lines: string[];
  url: string;
}): Promise<void> {
  return invoke("open_channel_in_player", { channel });
}

export async function getStreamingProxyPort(): Promise<number> {
  return invoke("get_streaming_proxy_port");
}

export async function discoverChromecasts(): Promise<ChromecastDevice[]> {
  return invoke("discover_chromecasts");
}

export async function castToDevice(
  device: ChromecastDevice,
  request: CastMediaRequest,
): Promise<CastSession> {
  return invoke("cast_to_device", { device, request });
}

export async function stopCast(): Promise<void> {
  return invoke("stop_cast");
}

export async function getCastStatus(): Promise<CastSession | null> {
  return invoke("get_cast_status");
}

// --- Updater ---------------------------------------------------------------

/** Look for a newer signed release. Never downloads or installs anything. */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke("check_for_updates");
}

/** The version found by the last check, without a network request. */
export async function discoveredUpdate(): Promise<string | null> {
  return invoke("discovered_update");
}

/** Whether this installation can replace itself, or must go through its own
 *  package manager (AUR, apt/dnf). */
export async function updateInstallMode(): Promise<UpdateInstallMode> {
  return invoke("update_install_mode");
}

/** Open the distribution's update page. Only valid in manual install mode. */
export async function openManualUpdate(): Promise<void> {
  return invoke("open_manual_update");
}

/** Install the discovered update and restart. Resolves to `false` if there
 *  turned out to be nothing to install. */
export async function installUpdate(): Promise<boolean> {
  return invoke("install_update");
}
