use serde::{Deserialize, Serialize};

use super::scan::RetryBackoff;

pub const DEFAULT_FFPROBE_TIMEOUT_SECS: f64 = 8.0;
pub const DEFAULT_FFMPEG_BITRATE_TIMEOUT_SECS: f64 = 30.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

/// Linux: window title bar visibility. `Auto` hides it on tiling window
/// managers (where the compositor moves/closes windows and the GTK header
/// bar is dead weight) and keeps it on floating desktops, where it is also
/// how you drag and close the window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum TitleBarPreference {
    #[default]
    Auto,
    Show,
    Hide,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ScreenshotFormat {
    #[default]
    Webp,
    Png,
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
#[derive(Default)]
pub enum ChannelLogoSize {
    #[default]
    Small,
    Medium,
    Large,
    Huge,
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
    /// Linux only: title bar visibility (auto / show / hide).
    pub title_bar: TitleBarPreference,
    pub log_level: String,
    pub show_prescan_filter: bool,
    pub hide_vod_content: bool,
    pub report_auto_reveal: bool,
    pub channel_logo_size: ChannelLogoSize,
    pub screenshot_format: ScreenshotFormat,
    pub screenshot_retention_count: u32,
    pub low_space_threshold_gb: f64,
    pub separate_placeholder_status: bool,
    pub show_header_button_text: bool,
    /// Keep the Xtream max-connections notice visible until it is dismissed.
    pub persistent_xtream_connection_notice: bool,
    /// Look for a signed update on launch and every six hours. Discovery only
    /// ever surfaces a notice; installing always needs explicit confirmation.
    pub automatic_update_checks: bool,
}

/// Declares which `AppSettings` fields a scan preset captures, and derives
/// `ScanPresetConfig` plus both copy directions from that one list.
///
/// Previously the field list appeared three times — the struct, `from_settings`
/// and `apply_to_settings` — so a new scan setting silently failed to round-trip
/// through presets if any one of them was missed. Now the list below is the only
/// place to edit, and a name that does not exist on `AppSettings` (or whose type
/// disagrees) fails to compile.
macro_rules! scan_preset_fields {
    ($($field:ident: $ty:ty,)*) => {
        #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
        #[serde(default)]
        pub struct ScanPresetConfig {
            $(pub $field: $ty,)*
        }

        impl ScanPresetConfig {
            /// Capture the scan-relevant subset of `settings`.
            // The macro cannot tell Copy fields from owned ones, so it clones
            // uniformly; for the Copy fields that is just a move.
            #[allow(clippy::clone_on_copy)]
            pub fn from_settings(settings: &AppSettings) -> Self {
                Self {
                    $($field: settings.$field.clone(),)*
                }
            }

            /// Overwrite only the scan-relevant fields of `settings`, leaving
            /// UI and app-level preferences untouched.
            #[allow(clippy::clone_on_copy)]
            pub fn apply_to_settings(&self, settings: &mut AppSettings) {
                $(settings.$field = self.$field.clone();)*
            }
        }
    };
}

scan_preset_fields! {
    timeout: f64,
    extended_timeout: Option<f64>,
    concurrency: u32,
    retries: u32,
    retry_backoff: RetryBackoff,
    user_agent: String,
    skip_screenshots: bool,
    profile_bitrate: bool,
    ffprobe_timeout_secs: f64,
    ffmpeg_bitrate_timeout_secs: f64,
    accept_invalid_certs: bool,
    proxy_file: Option<String>,
    test_geoblock: bool,
    screenshots_dir: Option<String>,
    low_fps_threshold: f64,
    screenshot_format: ScreenshotFormat,
}

impl Default for ScanPresetConfig {
    fn default() -> Self {
        Self::from_settings(&AppSettings::default())
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
            concurrency: 0,
            retries: 1,
            retry_backoff: RetryBackoff::None,
            user_agent: "TiviMate/5.1.6 (Android 12)".to_string(),
            skip_screenshots: false,
            profile_bitrate: false,
            ffprobe_timeout_secs: DEFAULT_FFPROBE_TIMEOUT_SECS,
            ffmpeg_bitrate_timeout_secs: DEFAULT_FFMPEG_BITRATE_TIMEOUT_SECS,
            accept_invalid_certs: false,
            proxy_file: None,
            test_geoblock: false,
            screenshots_dir: None,
            scan_history_limit: 20,
            scan_notifications: true,
            low_fps_threshold: 23.0,
            theme: ThemePreference::System,
            title_bar: TitleBarPreference::Auto,
            log_level: "error".to_string(),
            show_prescan_filter: false,
            hide_vod_content: false,
            report_auto_reveal: true,
            channel_logo_size: ChannelLogoSize::default(),
            screenshot_format: ScreenshotFormat::default(),
            screenshot_retention_count: 1,
            low_space_threshold_gb: 5.0,
            separate_placeholder_status: true,
            show_header_button_text: !cfg!(target_os = "macos"),
            persistent_xtream_connection_notice: false,
            automatic_update_checks: true,
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
        assert!(!settings.accept_invalid_certs);
    }

    /// Presets are stored as their own JSON object, so their keys have to keep
    /// matching the settings keys they are copied to and from. The macro makes
    /// a *missing* field a compile error; this catches the remaining case of a
    /// preset field that serializes under a name `AppSettings` does not use.
    #[test]
    fn preset_keys_are_a_subset_of_settings_keys() {
        let settings = serde_json::to_value(AppSettings::default()).expect("settings serialize");
        let preset = serde_json::to_value(ScanPresetConfig::default()).expect("preset serializes");

        let settings_keys = settings.as_object().expect("settings is an object");
        for key in preset.as_object().expect("preset is an object").keys() {
            assert!(
                settings_keys.contains_key(key),
                "preset field `{key}` has no matching AppSettings field"
            );
        }
    }

    #[test]
    fn default_concurrency_stays_in_auto_mode() {
        let settings = AppSettings::default();
        assert_eq!(settings.concurrency, 0);

        let deserialized: AppSettings = serde_json::from_value(serde_json::json!({}))
            .expect("settings should deserialize with defaults");
        assert_eq!(deserialized.concurrency, 0);
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
        assert!(!settings.hide_vod_content);
        assert!(!settings.persistent_xtream_connection_notice);
        assert_eq!(settings.low_fps_threshold, 23.0);
        assert_eq!(settings.channel_logo_size, super::ChannelLogoSize::Small);
        assert_eq!(settings.show_header_button_text, !cfg!(target_os = "macos"));
        // Pre-existing installs have no `title_bar` key in settings.json.
        assert_eq!(settings.title_bar, super::TitleBarPreference::Auto);
    }

    #[test]
    fn preset_config_round_trip_updates_scan_fields_only() {
        let base = AppSettings {
            timeout: 22.5,
            retries: 7,
            user_agent: "PresetAgent/1.0".to_string(),
            screenshot_format: ScreenshotFormat::Png,
            accept_invalid_certs: true,
            ..AppSettings::default()
        };
        let preset = ScanPresetConfig::from_settings(&base);

        let mut destination = AppSettings {
            theme: super::ThemePreference::Dark,
            scan_history_limit: 99,
            ..AppSettings::default()
        };
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
