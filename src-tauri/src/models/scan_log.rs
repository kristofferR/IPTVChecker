use serde::{Deserialize, Serialize};

use super::scan::ScanSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanDebugLog {
    pub run_id: String,
    pub playlist_path: String,
    pub source_identity: Option<String>,
    pub started_at_epoch_ms: u64,
    pub finished_at_epoch_ms: u64,
    pub summary: ScanSummary,
    pub channels: Vec<ChannelDebugLog>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChannelDebugLog {
    pub channel_index: usize,
    pub channel_name: String,
    pub channel_url: String,
    pub check_started_at_epoch_ms: u64,
    pub check_ended_at_epoch_ms: u64,
    pub retry_attempts: u32,
    pub successful_attempt: Option<u32>,
    pub http_status_codes: Vec<u16>,
    pub redirect_chain: Vec<String>,
    pub bytes_transferred: u64,
    pub ttfb_ms: Option<u64>,
    pub final_verdict: String,
    pub final_reason: Option<String>,
    pub ffprobe_output: Option<String>,
    pub attempts: Vec<ChannelAttemptDebugLog>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChannelAttemptDebugLog {
    pub attempt: u32,
    pub timeout_secs: f64,
    pub started_at_epoch_ms: u64,
    pub ended_at_epoch_ms: u64,
    pub verdict: String,
    pub reason: Option<String>,
    pub http_status_codes: Vec<u16>,
    pub redirect_chain: Vec<String>,
    pub bytes_transferred: u64,
    pub ttfb_ms: Option<u64>,
}
