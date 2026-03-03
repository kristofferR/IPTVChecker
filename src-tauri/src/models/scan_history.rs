use serde::{Deserialize, Serialize};

use super::scan::ScanSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanHistoryDiff {
    pub channels_gained: usize,
    pub channels_lost: usize,
    pub status_changed: usize,
    pub became_alive: usize,
    pub became_dead: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanHistoryItem {
    pub id: String,
    pub scanned_at_epoch_ms: u64,
    pub summary: ScanSummary,
    pub group_filter: Option<String>,
    pub channel_search: Option<String>,
    pub selected_count: usize,
    pub diff: Option<ScanHistoryDiff>,
}
