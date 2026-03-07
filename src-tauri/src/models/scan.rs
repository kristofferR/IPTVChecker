use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::models::channel::ChannelResult;

pub const MIN_TIMEOUT_SECS: f64 = 0.5;
pub const MAX_TIMEOUT_SECS: f64 = 300.0;
pub const MIN_EXTENDED_TIMEOUT_SECS: f64 = 1.0;
pub const MAX_EXTENDED_TIMEOUT_SECS: f64 = 600.0;
pub const MIN_FFPROBE_TIMEOUT_SECS: f64 = 1.0;
pub const MAX_FFPROBE_TIMEOUT_SECS: f64 = 300.0;
pub const MIN_FFMPEG_BITRATE_TIMEOUT_SECS: f64 = 5.0;
pub const MAX_FFMPEG_BITRATE_TIMEOUT_SECS: f64 = 300.0;
pub const MIN_CONCURRENCY: u32 = 1;
pub const MAX_CONCURRENCY: u32 = 20;
pub const MIN_RETRIES: u32 = 0;
pub const MAX_RETRIES: u32 = 10;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetryBackoff {
    None,
    Linear,
    Exponential,
}

impl Default for RetryBackoff {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanConfig {
    pub file_path: String,
    pub source_identity: Option<String>,
    pub group_filter: Option<String>,
    pub channel_search: Option<String>,
    pub selected_indices: Option<Vec<usize>>,
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
    #[serde(default)]
    pub accept_invalid_certs: bool,
    pub proxy_file: Option<String>,
    pub test_geoblock: bool,
    pub screenshots_dir: Option<String>,
    pub client_capabilities: Option<ScanClientCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScanClientCapabilities {
    #[serde(default)]
    pub event_batch_v1: bool,
}

impl ScanConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        if !self.timeout.is_finite()
            || self.timeout < MIN_TIMEOUT_SECS
            || self.timeout > MAX_TIMEOUT_SECS
        {
            return Err(AppError::Other(format!(
                "Invalid timeout: must be between {} and {} seconds",
                MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS
            )));
        }

        if let Some(ext) = self.extended_timeout {
            if !ext.is_finite()
                || ext < MIN_EXTENDED_TIMEOUT_SECS
                || ext > MAX_EXTENDED_TIMEOUT_SECS
            {
                return Err(AppError::Other(format!(
                    "Invalid extended timeout: must be between {} and {} seconds",
                    MIN_EXTENDED_TIMEOUT_SECS, MAX_EXTENDED_TIMEOUT_SECS
                )));
            }
        }

        if self.concurrency < MIN_CONCURRENCY || self.concurrency > MAX_CONCURRENCY {
            return Err(AppError::Other(format!(
                "Invalid concurrency: must be between {} and {}",
                MIN_CONCURRENCY, MAX_CONCURRENCY
            )));
        }

        if self.retries < MIN_RETRIES || self.retries > MAX_RETRIES {
            return Err(AppError::Other(format!(
                "Invalid retries: must be between {} and {}",
                MIN_RETRIES, MAX_RETRIES
            )));
        }

        if !self.ffprobe_timeout_secs.is_finite()
            || self.ffprobe_timeout_secs < MIN_FFPROBE_TIMEOUT_SECS
            || self.ffprobe_timeout_secs > MAX_FFPROBE_TIMEOUT_SECS
        {
            return Err(AppError::Other(format!(
                "Invalid ffprobe timeout: must be between {} and {} seconds",
                MIN_FFPROBE_TIMEOUT_SECS, MAX_FFPROBE_TIMEOUT_SECS
            )));
        }

        if !self.ffmpeg_bitrate_timeout_secs.is_finite()
            || self.ffmpeg_bitrate_timeout_secs < MIN_FFMPEG_BITRATE_TIMEOUT_SECS
            || self.ffmpeg_bitrate_timeout_secs > MAX_FFMPEG_BITRATE_TIMEOUT_SECS
        {
            return Err(AppError::Other(format!(
                "Invalid ffmpeg bitrate timeout: must be between {} and {} seconds",
                MIN_FFMPEG_BITRATE_TIMEOUT_SECS, MAX_FFMPEG_BITRATE_TIMEOUT_SECS
            )));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub completed: usize,
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    #[serde(default)]
    pub placeholder: usize,
    pub geoblocked: usize,
    #[serde(default)]
    pub drm: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    #[serde(default)]
    pub placeholder: usize,
    pub geoblocked: usize,
    #[serde(default)]
    pub drm: usize,
    pub low_framerate: usize,
    pub mislabeled: usize,
    #[serde(default)]
    pub playlist_score: Option<PlaylistScore>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaylistScore {
    pub overall: f64,
    pub ping: f64,
    pub content: f64,
    pub quality: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanEvent<T> {
    pub run_id: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResultBatchPayload {
    pub items: Vec<ChannelResult>,
    pub progress: ScanProgress,
}

/// Payload contract for `scan://error`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanErrorPayload {
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> ScanConfig {
        ScanConfig {
            file_path: "/tmp/test.m3u8".to_string(),
            source_identity: None,
            group_filter: None,
            channel_search: None,
            selected_indices: None,
            timeout: 10.0,
            extended_timeout: Some(20.0),
            concurrency: 1,
            retries: 1,
            retry_backoff: RetryBackoff::None,
            user_agent: "VLC/3.0.23 LibVLC/3.0.23".to_string(),
            skip_screenshots: false,
            profile_bitrate: false,
            ffprobe_timeout_secs: 30.0,
            ffmpeg_bitrate_timeout_secs: 60.0,
            accept_invalid_certs: false,
            proxy_file: None,
            test_geoblock: false,
            screenshots_dir: None,
            client_capabilities: None,
        }
    }

    #[test]
    fn validate_accepts_valid_ranges() {
        let config = valid_config();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_rejects_invalid_timeout_values() {
        let mut config = valid_config();
        config.timeout = 0.0;
        assert!(config.validate().is_err());

        config.timeout = f64::NAN;
        assert!(config.validate().is_err());

        config.timeout = MAX_TIMEOUT_SECS + 1.0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_invalid_extended_timeout_values() {
        let mut config = valid_config();
        config.extended_timeout = Some(0.0);
        assert!(config.validate().is_err());

        config.extended_timeout = Some(f64::INFINITY);
        assert!(config.validate().is_err());

        config.extended_timeout = Some(MAX_EXTENDED_TIMEOUT_SECS + 1.0);
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_invalid_retries_and_concurrency() {
        let mut config = valid_config();
        config.concurrency = 0;
        assert!(config.validate().is_err());

        config.concurrency = MAX_CONCURRENCY + 1;
        assert!(config.validate().is_err());

        config.concurrency = 1;
        config.retries = MIN_RETRIES;
        assert!(config.validate().is_ok());

        config.retries = MAX_RETRIES;
        assert!(config.validate().is_ok());

        config.retries = MAX_RETRIES + 1;
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_invalid_ffprobe_timeout() {
        let mut config = valid_config();
        config.ffprobe_timeout_secs = 0.0;
        assert!(config.validate().is_err());

        config.ffprobe_timeout_secs = f64::INFINITY;
        assert!(config.validate().is_err());

        config.ffprobe_timeout_secs = MAX_FFPROBE_TIMEOUT_SECS + 1.0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_invalid_ffmpeg_bitrate_timeout() {
        let mut config = valid_config();
        config.ffmpeg_bitrate_timeout_secs = 0.0;
        assert!(config.validate().is_err());

        config.ffmpeg_bitrate_timeout_secs = f64::NAN;
        assert!(config.validate().is_err());

        config.ffmpeg_bitrate_timeout_secs = MAX_FFMPEG_BITRATE_TIMEOUT_SECS + 1.0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn deserialize_missing_accept_invalid_certs_defaults_to_false() {
        let mut value =
            serde_json::to_value(valid_config()).expect("config should serialize to value");
        value
            .as_object_mut()
            .expect("config JSON should be an object")
            .remove("accept_invalid_certs");

        let config: ScanConfig =
            serde_json::from_value(value).expect("config should deserialize without field");
        assert!(!config.accept_invalid_certs);
    }
}
