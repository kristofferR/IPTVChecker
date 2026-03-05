use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendPerfSample {
    pub metric: String,
    pub value_ms: f64,
    pub run_id: Option<String>,
    pub recorded_at_epoch_ms: u64,
}
