use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub timeout: f64,
    pub extended_timeout: Option<f64>,
    pub concurrency: u32,
    pub retries: u32,
    pub user_agent: String,
    pub skip_screenshots: bool,
    pub profile_bitrate: bool,
    pub proxy_file: Option<String>,
    pub test_geoblock: bool,
    pub screenshots_dir: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            timeout: 10.0,
            extended_timeout: None,
            concurrency: 1,
            retries: 6,
            user_agent: "VLC/3.0.14 LibVLC/3.0.14".to_string(),
            skip_screenshots: false,
            profile_bitrate: false,
            proxy_file: None,
            test_geoblock: false,
            screenshots_dir: None,
        }
    }
}
