use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromecastDevice {
    pub id: String,
    pub friendly_name: String,
    pub model: Option<String>,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CastSessionState {
    Connecting,
    Loading,
    Playing,
    Paused,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSession {
    pub device_id: String,
    pub device_name: String,
    pub state: CastSessionState,
    pub stream_url: String,
    pub channel_name: Option<String>,
    pub channel_logo: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastMediaRequest {
    pub original_url: String,
    pub channel_name: Option<String>,
    pub channel_logo: Option<String>,
    pub stream_kind: CastStreamKind,
    #[serde(default)]
    pub is_finite: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CastStreamKind {
    Hls,
    MpegTs,
    Other,
}
