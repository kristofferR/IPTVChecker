use serde::{Deserialize, Serialize};

use crate::models::chromecast::CastStreamKind;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AirPlaySessionState {
    Connecting,
    Playing,
    Paused,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirPlaySession {
    pub state: AirPlaySessionState,
    pub stream_url: String,
    pub channel_name: Option<String>,
    pub channel_logo: Option<String>,
    pub error_message: Option<String>,
    pub external_playback_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirPlayMediaRequest {
    pub original_url: String,
    pub channel_name: Option<String>,
    pub channel_logo: Option<String>,
    pub stream_kind: CastStreamKind,
}
