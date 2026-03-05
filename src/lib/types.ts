export type ChannelStatus =
  | "pending"
  | "checking"
  | "alive"
  | "drm"
  | "dead"
  | "geoblocked"
  | "geoblocked_confirmed"
  | "geoblocked_unconfirmed";

export interface Channel {
  index: number;
  playlist: string;
  name: string;
  group: string;
  url: string;
  extinf_line: string;
  metadata_lines: string[];
}

export interface ChannelResult {
  index: number;
  playlist: string;
  name: string;
  group: string;
  url: string;
  status: ChannelStatus;
  codec: string | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  latency_ms: number | null;
  video_bitrate: string | null;
  audio_bitrate: string | null;
  audio_codec: string | null;
  audio_only: boolean;
  screenshot_path: string | null;
  label_mismatches: string[];
  low_framerate: boolean;
  error_message: string | null;
  channel_id: string;
  extinf_line: string;
  metadata_lines: string[];
  stream_url: string | null;
  retry_count?: number | null;
  error_reason?: string | null;
  last_error_reason?: string | null;
  drm_system?: string | null;
}

export interface PlaylistPreview {
  file_path: string;
  file_name: string;
  source_identity: string | null;
  xtream_max_connections: number | null;
  total_channels: number;
  groups: string[];
  channels: Channel[];
}

export interface XtreamOpenRequest {
  server: string;
  username: string;
  password: string;
}

export interface XtreamRecentSource {
  server: string;
  username: string;
}

export interface ScanConfig {
  file_path: string;
  source_identity: string | null;
  group_filter: string | null;
  channel_search: string | null;
  selected_indices: number[] | null;
  timeout: number;
  extended_timeout: number | null;
  concurrency: number;
  retries: number;
  retry_backoff: RetryBackoff;
  user_agent: string;
  skip_screenshots: boolean;
  profile_bitrate: boolean;
  ffprobe_timeout_secs: number;
  ffmpeg_bitrate_timeout_secs: number;
  proxy_file: string | null;
  test_geoblock: boolean;
  screenshots_dir: string | null;
  client_capabilities?: ScanClientCapabilities | null;
}

export interface ScanClientCapabilities {
  event_batch_v1: boolean;
}

export interface ScanProgress {
  completed: number;
  total: number;
  alive: number;
  dead: number;
  geoblocked: number;
  drm: number;
}

export interface ScanSummary {
  total: number;
  alive: number;
  dead: number;
  geoblocked: number;
  drm: number;
  low_framerate: number;
  mislabeled: number;
}

export interface ScanEvent<T> {
  run_id: string;
  payload: T;
}

export interface ScanResultBatchPayload {
  items: ChannelResult[];
  progress: ScanProgress;
}

// Shared payload contract for scan://error events.
export interface ScanErrorPayload {
  message: string;
}

export type ScreenshotFormat = "webp" | "png";
export type ChannelLogoSize = "small" | "medium" | "large" | "huge";

export interface AppSettings {
  timeout: number;
  extended_timeout: number | null;
  concurrency: number;
  retries: number;
  retry_backoff: RetryBackoff;
  user_agent: string;
  skip_screenshots: boolean;
  profile_bitrate: boolean;
  ffprobe_timeout_secs: number;
  ffmpeg_bitrate_timeout_secs: number;
  proxy_file: string | null;
  test_geoblock: boolean;
  screenshots_dir: string | null;
  scan_history_limit: number;
  scan_notifications: boolean;
  low_fps_threshold: number;
  theme: ThemePreference;
  log_level: string;
  show_prescan_filter: boolean;
  channel_logo_size: ChannelLogoSize;
  screenshot_format: ScreenshotFormat;
  screenshot_retention_count: number;
  low_space_threshold_gb: number;
}

export interface ScanPresetConfig {
  timeout: number;
  extended_timeout: number | null;
  concurrency: number;
  retries: number;
  retry_backoff: RetryBackoff;
  user_agent: string;
  skip_screenshots: boolean;
  profile_bitrate: boolean;
  ffprobe_timeout_secs: number;
  ffmpeg_bitrate_timeout_secs: number;
  proxy_file: string | null;
  test_geoblock: boolean;
  screenshots_dir: string | null;
  low_fps_threshold: number;
  screenshot_format: ScreenshotFormat;
}

export interface ScanSettingsPreset {
  name: string;
  config: ScanPresetConfig;
}

export interface ScanPresetCollection {
  presets: ScanSettingsPreset[];
  default_preset: string | null;
}

export interface ScanHistoryDiff {
  channels_gained: number;
  channels_lost: number;
  status_changed: number;
  became_alive: number;
  became_dead: number;
}

export interface ScanHistoryItem {
  id: string;
  scanned_at_epoch_ms: number;
  summary: ScanSummary;
  group_filter: string | null;
  channel_search: string | null;
  selected_count: number;
  diff: ScanHistoryDiff | null;
}

export type DiskSpaceTier = "plenty" | "moderate" | "low" | "critical";

export interface DiskSpaceInfo {
  available_bytes: number;
  tier: DiskSpaceTier;
}

export interface ScreenshotCacheStats {
  file_count: number;
  total_bytes: number;
  cache_dir: string;
  disk_space: DiskSpaceInfo | null;
}

export type RecentPlaylistKind = "file" | "url" | "xtream";

export interface RecentPlaylistEntry {
  kind: RecentPlaylistKind;
  value: string;
  label: string;
}

export type RetryBackoff = "none" | "linear" | "exponential";
export type ThemePreference = "system" | "light" | "dark";
