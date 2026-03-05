use serde::{Deserialize, Serialize};

use super::channel::Channel;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamAccountInfo {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub expires_at_epoch: Option<u64>,
    #[serde(default)]
    pub created_at_epoch: Option<u64>,
    #[serde(default)]
    pub is_trial: Option<bool>,
    #[serde(default)]
    pub active_connections: Option<u32>,
    #[serde(default)]
    pub max_connections: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistPreview {
    pub file_path: String,
    pub file_name: String,
    pub source_identity: Option<String>,
    #[serde(default)]
    pub server_location: Option<String>,
    #[serde(default)]
    pub xtream_max_connections: Option<u32>,
    #[serde(default)]
    pub xtream_account_info: Option<XtreamAccountInfo>,
    pub total_channels: usize,
    #[serde(default)]
    pub live_count: usize,
    #[serde(default)]
    pub movie_count: usize,
    #[serde(default)]
    pub series_count: usize,
    pub groups: Vec<String>,
    pub channels: Vec<Channel>,
}
