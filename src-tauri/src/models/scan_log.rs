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
    #[serde(default)]
    pub screenshot_error_reason: Option<String>,
    #[serde(alias = "ffprobe_output")]
    pub diagnostics_output: Option<String>,
    pub attempts: Vec<ChannelAttemptDebugLog>,
}

/// Per-channel cap on retained ffprobe/ffmpeg diagnostics text. Channel logs
/// live in memory for the whole scan and are persisted to history, so an
/// unbounded tool dump (which can reach MBs on some streams) multiplies
/// across tens of thousands of channels.
pub const MAX_DIAGNOSTICS_OUTPUT_BYTES: usize = 64 * 1024;

/// Truncate diagnostics text to [`MAX_DIAGNOSTICS_OUTPUT_BYTES`], keeping the
/// tail (errors conclude a tool run) and prepending a marker when trimmed.
pub fn cap_diagnostics_output(output: String) -> String {
    if output.len() <= MAX_DIAGNOSTICS_OUTPUT_BYTES {
        return output;
    }
    // Reserve room for the marker so the result stays within the cap.
    // 64 bytes comfortably covers the marker text plus the byte count.
    const MARKER_RESERVE: usize = 64;
    let mut start = output.len() - (MAX_DIAGNOSTICS_OUTPUT_BYTES - MARKER_RESERVE);
    while !output.is_char_boundary(start) {
        start += 1;
    }
    format!("[... truncated {} bytes ...]\n{}", start, &output[start..])
}

#[cfg(test)]
mod cap_tests {
    use super::{cap_diagnostics_output, MAX_DIAGNOSTICS_OUTPUT_BYTES};

    #[test]
    fn cap_diagnostics_output_never_exceeds_cap() {
        let capped = cap_diagnostics_output("x".repeat(MAX_DIAGNOSTICS_OUTPUT_BYTES * 2));
        assert!(capped.len() <= MAX_DIAGNOSTICS_OUTPUT_BYTES);
        assert!(capped.starts_with("[... truncated "));

        let untouched = cap_diagnostics_output("y".repeat(MAX_DIAGNOSTICS_OUTPUT_BYTES));
        assert_eq!(untouched.len(), MAX_DIAGNOSTICS_OUTPUT_BYTES);
    }
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
