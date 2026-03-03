import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../lib/types";
import { getSettings, updateSettings } from "../lib/tauri";

const DEFAULT_SETTINGS: AppSettings = {
  timeout: 10.0,
  extended_timeout: null,
  concurrency: 1,
  retries: 6,
  user_agent: "VLC/3.0.14 LibVLC/3.0.14",
  skip_screenshots: false,
  profile_bitrate: false,
  proxy_file: null,
  test_geoblock: false,
  screenshots_dir: null,
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => {
        // Use defaults on error
      })
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (newSettings: AppSettings) => {
    await updateSettings(newSettings);
    setSettings(newSettings);
  }, []);

  return { settings, save, loading };
}
