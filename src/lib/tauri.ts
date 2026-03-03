import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ChannelResult,
  PlaylistPreview,
  ScanConfig,
  ScanHistoryItem,
  RecentPlaylistEntry,
  RecentPlaylistKind,
  ScreenshotCacheStats,
  XtreamOpenRequest,
} from "./types";

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

export async function exportCsv(
  results: ChannelResult[],
  path: string,
  playlistName: string,
  includeLatency: boolean,
): Promise<void> {
  return invoke("export_csv", {
    results,
    path,
    playlistName,
    includeLatency,
  });
}

export async function exportSplit(
  results: ChannelResult[],
  basePath: string,
): Promise<void> {
  return invoke("export_split", { results, basePath });
}

export async function exportRenamed(
  results: ChannelResult[],
  basePath: string,
): Promise<void> {
  return invoke("export_renamed", { results, basePath });
}

export async function exportM3u(
  results: ChannelResult[],
  path: string,
): Promise<void> {
  return invoke("export_m3u", { results, path });
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

export async function checkFfmpegAvailable(): Promise<[boolean, boolean]> {
  return invoke("check_ffmpeg_available");
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
): Promise<RecentPlaylistEntry[]> {
  return invoke("add_recent_playlist", {
    recent: { kind, value },
  });
}

export async function clearRecentPlaylists(): Promise<RecentPlaylistEntry[]> {
  return invoke("clear_recent_playlists");
}

export async function openChannelInPlayer(channel: {
  extinf_line: string;
  metadata_lines: string[];
  url: string;
}): Promise<void> {
  return invoke("open_channel_in_player", { channel });
}
