use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanConfig {
    pub file_path: String,
    pub group_filter: Option<String>,
    pub channel_search: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub completed: usize,
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    pub geoblocked: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    pub geoblocked: usize,
    pub low_framerate: usize,
    pub mislabeled: usize,
}
