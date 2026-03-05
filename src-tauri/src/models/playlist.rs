use serde::{Deserialize, Serialize};

use super::channel::Channel;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistPreview {
    pub file_path: String,
    pub file_name: String,
    pub source_identity: Option<String>,
    #[serde(default)]
    pub xtream_max_connections: Option<u32>,
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
