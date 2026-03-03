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
    #[serde(default, alias = "last_error_reason")]
    pub error_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_result() -> ChannelResult {
        ChannelResult {
            index: 0,
            playlist: "fixture.m3u8".to_string(),
            name: "Channel".to_string(),
            group: "Group".to_string(),
            url: "https://example.com/live.m3u8".to_string(),
            status: ChannelStatus::Dead,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_only: false,
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: "id-0".to_string(),
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
        }
    }

    #[test]
    fn deserializes_legacy_last_error_reason_alias() {
        let value = serde_json::json!({
            "index": 0,
            "playlist": "fixture.m3u8",
            "name": "Channel",
            "group": "Group",
            "url": "https://example.com/live.m3u8",
            "status": "dead",
            "codec": null,
            "resolution": null,
            "width": null,
            "height": null,
            "fps": null,
            "latency_ms": null,
            "video_bitrate": null,
            "audio_bitrate": null,
            "audio_codec": null,
            "audio_only": false,
            "screenshot_path": null,
            "label_mismatches": [],
            "low_framerate": false,
            "error_message": null,
            "channel_id": "id-0",
            "extinf_line": "#EXTINF:-1,Channel",
            "metadata_lines": [],
            "stream_url": null,
            "retry_count": null,
            "last_error_reason": "Timeout"
        });

        let parsed: ChannelResult =
            serde_json::from_value(value).expect("legacy alias should deserialize");
        assert_eq!(parsed.error_reason.as_deref(), Some("Timeout"));
    }

    #[test]
    fn serializes_error_reason_field_name() {
        let mut result = sample_result();
        result.error_reason = Some("DNS failure".to_string());

        let encoded = serde_json::to_value(result).expect("channel result should serialize");
        assert_eq!(encoded.get("error_reason").and_then(|v| v.as_str()), Some("DNS failure"));
        assert!(encoded.get("last_error_reason").is_none());
    }
}
