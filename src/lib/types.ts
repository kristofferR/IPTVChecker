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
  name: string;
  group: string;
  url: string;
  extinf_line: string;
  metadata_lines: string[];
}

export interface ChannelResult {
  index: number;
  name: string;
  group: string;
  url: string;
  status: ChannelStatus;
  codec: string | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
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
  total_channels: number;
  groups: string[];
  channels: Channel[];
}

export interface ScanConfig {
  file_path: string;
  group_filter: string | null;
  channel_search: string | null;
  timeout: number;
  extended_timeout: number | null;
  concurrency: number;
  retries: number;
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

export interface AppSettings {
  timeout: number;
  extended_timeout: number | null;
  concurrency: number;
  retries: number;
  user_agent: string;
  skip_screenshots: boolean;
  profile_bitrate: boolean;
  proxy_file: string | null;
  test_geoblock: boolean;
  screenshots_dir: string | null;
  log_level: string;
}
