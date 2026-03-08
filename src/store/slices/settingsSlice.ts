import type { StateCreator } from "zustand";
import type { AppStore, SettingsSlice } from "../types";
import type { AppSettings } from "../../lib/types";

const DEFAULT_SETTINGS: AppSettings = {
  timeout: 8.0,
  extended_timeout: null,
  concurrency: 1,
  retries: 1,
  retry_backoff: "none",
  user_agent: "VLC/3.0.23 LibVLC/3.0.23",
  skip_screenshots: false,
  profile_bitrate: false,
  ffprobe_timeout_secs: 8,
  ffmpeg_bitrate_timeout_secs: 30,
  accept_invalid_certs: true,
  proxy_file: null,
  test_geoblock: false,
  screenshots_dir: null,
  scan_history_limit: 20,
  scan_notifications: true,
  low_fps_threshold: 23.0,
  theme: "system",
  log_level: "error",
  show_prescan_filter: false,
  report_auto_reveal: true,
  channel_logo_size: "small",
  screenshot_format: "webp",
  screenshot_retention_count: 1,
  low_space_threshold_gb: 5.0,
  separate_placeholder_status: true,
};

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set) => ({
  settings: DEFAULT_SETTINGS,
  settingsLoading: true,

  setSettings: (settings) => set({ settings }),
  setSettingsLoading: (settingsLoading) => set({ settingsLoading }),
});
