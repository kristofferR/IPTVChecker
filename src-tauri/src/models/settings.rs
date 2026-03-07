use serde::{Deserialize, Serialize};

use super::scan::RetryBackoff;

pub const DEFAULT_FFPROBE_TIMEOUT_SECS: f64 = 8.0;
pub const DEFAULT_FFMPEG_BITRATE_TIMEOUT_SECS: f64 = 30.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

impl Default for ThemePreference {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotFormat {
    Webp,
    Png,
}

impl Default for ScreenshotFormat {
    fn default() -> Self {
        Self::Webp
    }
}

impl ScreenshotFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Webp => "webp",
            Self::Png => "png",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelLogoSize {
    Small,
    Medium,
    Large,
    Huge,
}

impl Default for ChannelLogoSize {
    fn default() -> Self {
        Self::Small
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub timeout: f64,
    pub extended_timeout: Option<f64>,
    pub concurrency: u32,
    pub retries: u32,
    pub retry_backoff: RetryBackoff,
    pub user_agent: String,
    pub skip_screenshots: bool,
    pub profile_bitrate: bool,
    pub ffprobe_timeout_secs: f64,
    pub ffmpeg_bitrate_timeout_secs: f64,
    pub accept_invalid_certs: bool,
    pub proxy_file: Option<String>,
    pub test_geoblock: bool,
    pub screenshots_dir: Option<String>,
    pub scan_history_limit: u32,
    pub scan_notifications: bool,
    pub low_fps_threshold: f64,
    pub theme: ThemePreference,
    pub log_level: String,
    pub show_prescan_filter: bool,
    pub report_auto_reveal: bool,
    pub channel_logo_size: ChannelLogoSize,
    pub screenshot_format: ScreenshotFormat,
    pub screenshot_retention_count: u32,
    pub low_space_threshold_gb: f64,
    pub separate_placeholder_status: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ScanPresetConfig {
    pub timeout: f64,
    pub extended_timeout: Option<f64>,
    pub concurrency: u32,
    pub retries: u32,
    pub retry_backoff: RetryBackoff,
    pub user_agent: String,
    pub skip_screenshots: bool,
    pub profile_bitrate: bool,
    pub ffprobe_timeout_secs: f64,
    pub ffmpeg_bitrate_timeout_secs: f64,
    pub accept_invalid_certs: bool,
    pub proxy_file: Option<String>,
    pub test_geoblock: bool,
    pub screenshots_dir: Option<String>,
    pub low_fps_threshold: f64,
    pub screenshot_format: ScreenshotFormat,
}

impl Default for ScanPresetConfig {
    fn default() -> Self {
        Self::from_settings(&AppSettings::default())
    }
}

impl ScanPresetConfig {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            timeout: settings.timeout,
            extended_timeout: settings.extended_timeout,
            concurrency: settings.concurrency,
            retries: settings.retries,
            retry_backoff: settings.retry_backoff,
            user_agent: settings.user_agent.clone(),
            skip_screenshots: settings.skip_screenshots,
            profile_bitrate: settings.profile_bitrate,
            ffprobe_timeout_secs: settings.ffprobe_timeout_secs,
            ffmpeg_bitrate_timeout_secs: settings.ffmpeg_bitrate_timeout_secs,
            accept_invalid_certs: settings.accept_invalid_certs,
            proxy_file: settings.proxy_file.clone(),
            test_geoblock: settings.test_geoblock,
            screenshots_dir: settings.screenshots_dir.clone(),
            low_fps_threshold: settings.low_fps_threshold,
            screenshot_format: settings.screenshot_format,
        }
    }

    pub fn apply_to_settings(&self, settings: &mut AppSettings) {
        settings.timeout = self.timeout;
        settings.extended_timeout = self.extended_timeout;
        settings.concurrency = self.concurrency;
        settings.retries = self.retries;
        settings.retry_backoff = self.retry_backoff;
        settings.user_agent = self.user_agent.clone();
        settings.skip_screenshots = self.skip_screenshots;
        settings.profile_bitrate = self.profile_bitrate;
        settings.ffprobe_timeout_secs = self.ffprobe_timeout_secs;
        settings.ffmpeg_bitrate_timeout_secs = self.ffmpeg_bitrate_timeout_secs;
        settings.accept_invalid_certs = self.accept_invalid_certs;
        settings.proxy_file = self.proxy_file.clone();
        settings.test_geoblock = self.test_geoblock;
        settings.screenshots_dir = self.screenshots_dir.clone();
        settings.low_fps_threshold = self.low_fps_threshold;
        settings.screenshot_format = self.screenshot_format;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScanSettingsPreset {
    pub name: String,
    pub config: ScanPresetConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct ScanPresetCollection {
    pub presets: Vec<ScanSettingsPreset>,
    pub default_preset: Option<String>,
}

impl AppSettings {
    pub fn level_filter(&self) -> log::LevelFilter {
        match self.log_level.to_lowercase().as_str() {
            "trace" => log::LevelFilter::Trace,
            "debug" => log::LevelFilter::Debug,
            "info" => log::LevelFilter::Info,
            "warning" | "warn" => log::LevelFilter::Warn,
            _ => log::LevelFilter::Error,
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            timeout: 8.0,
            extended_timeout: None,
            concurrency: 1,
            retries: 1,
            retry_backoff: RetryBackoff::None,
            user_agent: "VLC/3.0.23 LibVLC/3.0.23".to_string(),
            skip_screenshots: false,
            profile_bitrate: false,
            ffprobe_timeout_secs: DEFAULT_FFPROBE_TIMEOUT_SECS,
            ffmpeg_bitrate_timeout_secs: DEFAULT_FFMPEG_BITRATE_TIMEOUT_SECS,
            accept_invalid_certs: true,
            proxy_file: None,
            test_geoblock: false,
            screenshots_dir: None,
            scan_history_limit: 20,
            scan_notifications: true,
            low_fps_threshold: 23.0,
            theme: ThemePreference::System,
            log_level: "error".to_string(),
            show_prescan_filter: false,
            report_auto_reveal: true,
            channel_logo_size: ChannelLogoSize::default(),
            screenshot_format: ScreenshotFormat::default(),
            screenshot_retention_count: 1,
            low_space_threshold_gb: 5.0,
            separate_placeholder_status: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, ScanPresetConfig, ScreenshotFormat};

    #[test]
    fn default_enables_scan_notifications() {
        let settings = AppSettings::default();
        assert!(settings.scan_notifications);
        assert!(settings.accept_invalid_certs);
    }

    #[test]
    fn default_low_fps_threshold_is_23() {
        let settings = AppSettings::default();
        assert_eq!(settings.low_fps_threshold, 23.0);
        assert_eq!(
            settings.ffprobe_timeout_secs,
            super::DEFAULT_FFPROBE_TIMEOUT_SECS
        );
        assert_eq!(
            settings.ffmpeg_bitrate_timeout_secs,
            super::DEFAULT_FFMPEG_BITRATE_TIMEOUT_SECS
        );
    }

    #[test]
    fn deserialize_missing_scan_notifications_defaults_to_true() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({}))
            .expect("settings should deserialize with defaults");
        assert!(settings.scan_notifications);
        assert!(settings.report_auto_reveal);
        assert_eq!(settings.low_fps_threshold, 23.0);
        assert_eq!(settings.channel_logo_size, super::ChannelLogoSize::Small);
    }

    #[test]
    fn preset_config_round_trip_updates_scan_fields_only() {
        let mut base = AppSettings::default();
        base.timeout = 22.5;
        base.retries = 7;
        base.user_agent = "PresetAgent/1.0".to_string();
        base.screenshot_format = ScreenshotFormat::Png;
        base.accept_invalid_certs = true;
        let preset = ScanPresetConfig::from_settings(&base);

        let mut destination = AppSettings::default();
        destination.theme = super::ThemePreference::Dark;
        destination.scan_history_limit = 99;
        preset.apply_to_settings(&mut destination);

        assert_eq!(destination.timeout, 22.5);
        assert_eq!(destination.retries, 7);
        assert_eq!(destination.user_agent, "PresetAgent/1.0");
        assert_eq!(destination.screenshot_format, ScreenshotFormat::Png);
        assert!(destination.accept_invalid_certs);
        assert_eq!(destination.theme, super::ThemePreference::Dark);
        assert_eq!(destination.scan_history_limit, 99);
    }
}
