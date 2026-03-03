use serde::{Deserialize, Serialize};

use super::channel::Channel;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistPreview {
    pub file_path: String,
    pub file_name: String,
    pub source_identity: Option<String>,
    pub total_channels: usize,
    pub groups: Vec<String>,
    pub channels: Vec<Channel>,
}
