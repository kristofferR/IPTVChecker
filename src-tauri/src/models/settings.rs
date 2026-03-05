use serde::{Deserialize, Serialize};

use super::scan::RetryBackoff;

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
    pub proxy_file: Option<String>,
    pub test_geoblock: bool,
    pub screenshots_dir: Option<String>,
    pub scan_history_limit: u32,
    pub scan_notifications: bool,
    pub low_fps_threshold: f64,
    pub theme: ThemePreference,
    pub log_level: String,
    pub show_prescan_filter: bool,
    pub channel_logo_size: ChannelLogoSize,
    pub screenshot_format: ScreenshotFormat,
    pub screenshot_retention_count: u32,
    pub low_space_threshold_gb: f64,
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
            timeout: 10.0,
            extended_timeout: None,
            concurrency: 1,
            retries: 3,
            retry_backoff: RetryBackoff::Linear,
            user_agent: "VLC/3.0.14 LibVLC/3.0.14".to_string(),
            skip_screenshots: false,
            profile_bitrate: false,
            proxy_file: None,
            test_geoblock: false,
            screenshots_dir: None,
            scan_history_limit: 20,
            scan_notifications: true,
            low_fps_threshold: 23.0,
            theme: ThemePreference::System,
            log_level: "error".to_string(),
            show_prescan_filter: false,
            channel_logo_size: ChannelLogoSize::default(),
            screenshot_format: ScreenshotFormat::default(),
            screenshot_retention_count: 1,
            low_space_threshold_gb: 5.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn default_enables_scan_notifications() {
        let settings = AppSettings::default();
        assert!(settings.scan_notifications);
    }

    #[test]
    fn default_low_fps_threshold_is_23() {
        let settings = AppSettings::default();
        assert_eq!(settings.low_fps_threshold, 23.0);
    }

    #[test]
    fn deserialize_missing_scan_notifications_defaults_to_true() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({}))
            .expect("settings should deserialize with defaults");
        assert!(settings.scan_notifications);
        assert_eq!(settings.low_fps_threshold, 23.0);
        assert_eq!(settings.channel_logo_size, super::ChannelLogoSize::Small);
    }
}
