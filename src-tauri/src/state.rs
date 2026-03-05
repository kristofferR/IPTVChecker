use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::models::scan_log::ScanDebugLog;
use crate::models::settings::AppSettings;

#[derive(Default)]
pub struct WindowScanState {
    pub cancel_token: Option<CancellationToken>,
    pub scanning: bool,
    pub paused: bool,
    pub current_run_id: Option<String>,
    pub scan_log: Option<ScanDebugLog>,
}

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    window_scan_states: Mutex<HashMap<String, WindowScanState>>,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            settings: Mutex::new(AppSettings::default()),
            window_scan_states: Mutex::new(HashMap::new()),
        })
    }

    pub async fn with_window_scan_state<R>(
        &self,
        window_label: &str,
        mutate: impl FnOnce(&mut WindowScanState) -> R,
    ) -> R {
        let mut window_scan_states = self.window_scan_states.lock().await;
        let state = window_scan_states
            .entry(window_label.to_string())
            .or_default();
        mutate(state)
    }
}
