use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    #[default]
    Live,
    Movie,
    Series,
}

impl std::fmt::Display for ContentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContentType::Live => write!(f, "Live"),
            ContentType::Movie => write!(f, "Movie"),
            ContentType::Series => write!(f, "Series"),
        }
    }
}

impl ContentType {
    fn classify_from_path(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        if lower.contains("/series/") {
            return Some(Self::Series);
        }
        if lower.contains("/movie/") || lower.contains("/vod/") {
            return Some(Self::Movie);
        }

        let cleaned = lower
            .split_once('?')
            .map(|(before, _)| before)
            .unwrap_or(&lower);
        let cleaned = cleaned
            .split_once('#')
            .map(|(before, _)| before)
            .unwrap_or(cleaned);
        let file_name = cleaned.rsplit('/').next().unwrap_or(cleaned);
        let extension = file_name.rsplit_once('.').map(|(_, ext)| ext)?;
        if extension.is_empty() {
            return None;
        }

        match extension {
            "m3u8" | "ts" | "m2ts" | "mpegts" => Some(Self::Live),
            "mp4" | "mkv" | "avi" | "mov" | "m4v" | "wmv" | "flv" | "webm" | "mpg" | "mpeg" => {
                Some(Self::Movie)
            }
            _ => None,
        }
    }

    pub fn detect_from_url(url: &str) -> Self {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Self::Live;
        }

        if let Ok(parsed) = url::Url::parse(trimmed) {
            if let Some(classified) = Self::classify_from_path(parsed.path()) {
                return classified;
            }
            if let Some(query) = parsed.query().map(str::to_ascii_lowercase) {
                if query.contains("type=series") || query.contains("action=get_series") {
                    return Self::Series;
                }
                if query.contains("type=movie")
                    || query.contains("type=vod")
                    || query.contains("action=get_vod")
                {
                    return Self::Movie;
                }
            }
            return Self::Live;
        }

        Self::classify_from_path(trimmed).unwrap_or(Self::Live)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelStatus {
    Pending,
    Checking,
    Alive,
    Drm,
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
            ChannelStatus::Drm => write!(f, "DRM"),
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
    #[serde(default)]
    pub language: Option<String>,
    pub url: String,
    #[serde(default)]
    pub content_type: ContentType,
    pub extinf_line: String,
    pub metadata_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelResult {
    pub index: usize,
    pub playlist: String,
    pub name: String,
    pub group: String,
    #[serde(default)]
    pub language: Option<String>,
    pub url: String,
    #[serde(default)]
    pub content_type: ContentType,
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
    #[serde(default)]
    pub drm_system: Option<String>,
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
            language: None,
            url: "https://example.com/live.m3u8".to_string(),
            content_type: ContentType::Live,
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
            drm_system: None,
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
        assert_eq!(parsed.language, None);
        assert_eq!(parsed.content_type, ContentType::Live);
    }

    #[test]
    fn serializes_error_reason_field_name() {
        let mut result = sample_result();
        result.error_reason = Some("DNS failure".to_string());

        let encoded = serde_json::to_value(result).expect("channel result should serialize");
        assert_eq!(
            encoded.get("error_reason").and_then(|v| v.as_str()),
            Some("DNS failure")
        );
        assert!(encoded.get("last_error_reason").is_none());
    }

    #[test]
    fn detect_content_type_handles_xtream_patterns() {
        assert_eq!(
            ContentType::detect_from_url("http://server/movie/user/pass/12345.mkv"),
            ContentType::Movie
        );
        assert_eq!(
            ContentType::detect_from_url("http://server/series/user/pass/12345.mp4"),
            ContentType::Series
        );
        assert_eq!(
            ContentType::detect_from_url("http://server/user/pass/12345"),
            ContentType::Live
        );
    }

    #[test]
    fn detect_content_type_handles_extension_and_fallback() {
        assert_eq!(
            ContentType::detect_from_url("https://example.com/channel.m3u8"),
            ContentType::Live
        );
        assert_eq!(
            ContentType::detect_from_url("https://example.com/video.mp4"),
            ContentType::Movie
        );
        assert_eq!(ContentType::detect_from_url("not-a-url"), ContentType::Live);
    }
}
