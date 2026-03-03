import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ChannelResult,
  PlaylistPreview,
  ScanConfig,
  ScreenshotCacheStats,
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

export async function startScan(config: ScanConfig): Promise<string> {
  return invoke("start_scan", { config });
}

export async function cancelScan(): Promise<void> {
  return invoke("cancel_scan");
}

export async function resetScan(): Promise<void> {
  return invoke("reset_scan");
}

export async function exportCsv(
  results: ChannelResult[],
  path: string,
  playlistName: string,
): Promise<void> {
  return invoke("export_csv", { results, path, playlistName });
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

export async function openChannelInPlayer(channel: {
  extinf_line: string;
  metadata_lines: string[];
  url: string;
}): Promise<void> {
  return invoke("open_channel_in_player", { channel });
}
