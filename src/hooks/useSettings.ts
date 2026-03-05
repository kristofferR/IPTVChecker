import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ScanPresetConfig } from "../lib/types";
import { getScanPresets, getSettings, updateSettings } from "../lib/tauri";

const DEFAULT_SETTINGS: AppSettings = {
  timeout: 10.0,
  extended_timeout: null,
  concurrency: 1,
  retries: 3,
  retry_backoff: "linear",
  user_agent: "VLC/3.0.14 LibVLC/3.0.14",
  skip_screenshots: false,
  profile_bitrate: false,
  ffprobe_timeout_secs: 30,
  ffmpeg_bitrate_timeout_secs: 60,
  accept_invalid_certs: false,
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
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  const applyPresetConfig = (
    base: AppSettings,
    config: ScanPresetConfig,
  ): AppSettings => ({
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
  });

  const sameScanConfig = (value: AppSettings, config: ScanPresetConfig): boolean =>
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
    value.screenshot_format === config.screenshot_format;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
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
        if (!cancelled) {
          setSettings(resolved);
        }
      } catch {
        // Use defaults on error
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (newSettings: AppSettings) => {
    await updateSettings(newSettings);
    setSettings(newSettings);
  }, []);

  return { settings, save, loading };
}
