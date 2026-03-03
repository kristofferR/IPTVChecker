use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelStatus {
    Pending,
    Checking,
    Alive,
    Dead,
    Geoblocked,
    GeoblockedConfirmed,
    GeoblockedUnconfirmed,
}

impl std::fmt::Display for ChannelStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChannelStatus::Pending => write!(f, "Pending"),
            ChannelStatus::Checking => write!(f, "Checking"),
            ChannelStatus::Alive => write!(f, "Alive"),
            ChannelStatus::Dead => write!(f, "Dead"),
            ChannelStatus::Geoblocked => write!(f, "Geoblocked"),
            ChannelStatus::GeoblockedConfirmed => write!(f, "Geoblocked (Confirmed)"),
            ChannelStatus::GeoblockedUnconfirmed => write!(f, "Geoblocked (Unconfirmed)"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub index: usize,
    pub playlist: String,
    pub name: String,
    pub group: String,
    pub url: String,
    pub extinf_line: String,
    pub metadata_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelResult {
    pub index: usize,
    pub playlist: String,
    pub name: String,
    pub group: String,
    pub url: String,
    pub status: ChannelStatus,
    pub codec: Option<String>,
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub latency_ms: Option<u64>,
    pub video_bitrate: Option<String>,
    pub audio_bitrate: Option<String>,
    pub audio_codec: Option<String>,
    #[serde(default)]
    pub audio_only: bool,
    pub screenshot_path: Option<String>,
    pub label_mismatches: Vec<String>,
    pub low_framerate: bool,
    pub error_message: Option<String>,
    pub channel_id: String,
    pub extinf_line: String,
    pub metadata_lines: Vec<String>,
    pub stream_url: Option<String>,
    #[serde(default)]
    pub retry_count: Option<u32>,
    #[serde(default)]
    pub last_error_reason: Option<String>,
}
