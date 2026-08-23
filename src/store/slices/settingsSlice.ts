import type { StateCreator } from "zustand";
import { inferPlatformFromNavigator } from "../../lib/platform";
import { getScanPresets, getSettings, updateSettings } from "../../lib/tauri";
import type { AppSettings, ScanPresetConfig } from "../../lib/types";
import type { AppStore, SettingsSlice } from "../types";

const defaultShowHeaderButtonText = inferPlatformFromNavigator() !== "macos";

export const DEFAULT_SETTINGS: AppSettings = {
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
  accept_invalid_certs: false,
  proxy_file: null,
  test_geoblock: false,
  screenshots_dir: null,
  scan_history_limit: 20,
  scan_notifications: true,
  low_fps_threshold: 23.0,
  theme: "system",
  title_bar: "auto",
  log_level: "error",
  show_prescan_filter: false,
  hide_vod_content: false,
  report_auto_reveal: true,
  channel_logo_size: "small",
  screenshot_format: "webp",
  screenshot_retention_count: 1,
  low_space_threshold_gb: 5.0,
  separate_placeholder_status: true,
  show_header_button_text: defaultShowHeaderButtonText,
  external_player_path: null,
  persistent_xtream_connection_notice: false,
  automatic_update_checks: true,
};

function applyPresetConfig(base: AppSettings, config: ScanPresetConfig): AppSettings {
  return {
    ...base,
    timeout: config.timeout,
    extended_timeout: config.extended_timeout,
    concurrency: config.concurrency,
    retries: config.retries,
    retry_backoff: config.retry_backoff,
    user_agent: config.user_agent,
    skip_screenshots: config.skip_screenshots,
    profile_bitrate: config.profile_bitrate,
    ffprobe_timeout_secs: config.ffprobe_timeout_secs,
    ffmpeg_bitrate_timeout_secs: config.ffmpeg_bitrate_timeout_secs,
    accept_invalid_certs: config.accept_invalid_certs,
    proxy_file: config.proxy_file,
    test_geoblock: config.test_geoblock,
    screenshots_dir: config.screenshots_dir,
    low_fps_threshold: config.low_fps_threshold,
    screenshot_format: config.screenshot_format,
  };
}

function sameScanConfig(value: AppSettings, config: ScanPresetConfig): boolean {
  return (
    value.timeout === config.timeout &&
    value.extended_timeout === config.extended_timeout &&
    value.concurrency === config.concurrency &&
    value.retries === config.retries &&
    value.retry_backoff === config.retry_backoff &&
    value.user_agent === config.user_agent &&
    value.skip_screenshots === config.skip_screenshots &&
    value.profile_bitrate === config.profile_bitrate &&
    value.ffprobe_timeout_secs === config.ffprobe_timeout_secs &&
    value.ffmpeg_bitrate_timeout_secs === config.ffmpeg_bitrate_timeout_secs &&
    value.accept_invalid_certs === config.accept_invalid_certs &&
    value.proxy_file === config.proxy_file &&
    value.test_geoblock === config.test_geoblock &&
    value.screenshots_dir === config.screenshots_dir &&
    value.low_fps_threshold === config.low_fps_threshold &&
    value.screenshot_format === config.screenshot_format
  );
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  settings: DEFAULT_SETTINGS,
  settingsLoading: false,
  settingsHydrated: false,

  setSettings: (settings) => set({ settings }),
  setSettingsLoading: (settingsLoading) => set({ settingsLoading }),
  loadSettings: async () => {
    if (get().settingsLoading || get().settingsHydrated) {
      return;
    }

    set({ settingsLoading: true });
    try {
      let resolved = await getSettings();
      try {
        const presetState = await getScanPresets();
        if (presetState.default_preset) {
          const preset = presetState.presets.find(
            (entry) => entry.name === presetState.default_preset,
          );
          if (preset && !sameScanConfig(resolved, preset.config)) {
            resolved = applyPresetConfig(resolved, preset.config);
            await updateSettings(resolved);
          }
        }
      } catch {
        // Keep base settings when presets fail to load.
      }
      set({
        settings: resolved,
        settingsLoading: false,
        settingsHydrated: true,
      });
    } catch {
      set({
        settingsLoading: false,
        settingsHydrated: true,
      });
    }
  },
  saveSettings: async (settings) => {
    await updateSettings(settings);
    set({
      settings,
      settingsHydrated: true,
    });
  },
});
