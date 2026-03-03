use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::models::settings::AppSettings;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub cancel_token: Mutex<Option<CancellationToken>>,
    pub scanning: Mutex<bool>,
    pub paused: Mutex<bool>,
    pub current_run_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            settings: Mutex::new(AppSettings::default()),
            cancel_token: Mutex::new(None),
            scanning: Mutex::new(false),
            paused: Mutex::new(false),
            current_run_id: Mutex::new(None),
        })
    }
}
