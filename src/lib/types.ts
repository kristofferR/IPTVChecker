export type ChannelStatus =
  | "pending"
  | "checking"
  | "alive"
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
  screenshot_path: string | null;
  label_mismatches: string[];
  low_framerate: boolean;
  error_message: string | null;
  channel_id: string;
  extinf_line: string;
  metadata_lines: string[];
  stream_url: string | null;
}

export interface PlaylistPreview {
  file_path: string;
  file_name: string;
  source_identity: string | null;
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
  proxy_file: string | null;
  test_geoblock: boolean;
  screenshots_dir: string | null;
}

export interface ScanProgress {
  completed: number;
  total: number;
  alive: number;
  dead: number;
  geoblocked: number;
}

export interface ScanSummary {
  total: number;
  alive: number;
  dead: number;
  geoblocked: number;
  low_framerate: number;
  mislabeled: number;
}

export interface ScanEvent<T> {
  run_id: string;
  payload: T;
}

export interface AppSettings {
  timeout: number;
  extended_timeout: number | null;
  concurrency: number;
  retries: number;
  retry_backoff: RetryBackoff;
  user_agent: string;
  skip_screenshots: boolean;
  profile_bitrate: boolean;
  proxy_file: string | null;
  test_geoblock: boolean;
  screenshots_dir: string | null;
  scan_history_limit: number;
  scan_notifications: boolean;
  theme: ThemePreference;
  log_level: string;
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

export interface ScreenshotCacheStats {
  file_count: number;
  total_bytes: number;
  cache_dir: string;
}

export type RecentPlaylistKind = "file" | "url" | "xtream";

export interface RecentPlaylistEntry {
  kind: RecentPlaylistKind;
  value: string;
  label: string;
}

export type RetryBackoff = "none" | "linear" | "exponential";
export type ThemePreference = "system" | "light" | "dark";
