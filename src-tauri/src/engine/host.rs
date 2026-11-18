//! The seam between the engine and the process hosting it.
//!
//! Engine code reports events and finds its state, directories and stored
//! values through [`Host`], so the same scan runs under the Tauri app, which
//! forwards events to the webview, and under the headless CLI, which has no
//! window at all.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;
use crate::state::AppState;

/// The app's `settings.json` store: settings, saved playlists, presets.
pub const SETTINGS_STORE_FILE: &str = "settings.json";

pub trait Host: Send + Sync + 'static {
    fn app_state(&self) -> &Arc<AppState>;

    /// Deliver an event whose payload is already JSON. Call
    /// [`emit`](dyn Host::emit) instead.
    fn emit_json(&self, event: &str, payload: String);

    fn app_data_dir(&self) -> Result<PathBuf, AppError>;

    fn temp_dir(&self) -> PathBuf;

    /// Where bundled resources live, for hosts that have such a place.
    fn resource_dir(&self) -> Option<PathBuf>;

    /// A value from the persisted settings store.
    fn stored(&self, key: &str) -> Option<serde_json::Value>;

    /// An owned handle, for tasks that outlive the caller's borrow.
    fn share(&self) -> Arc<dyn Host>;
}

impl dyn Host {
    /// Report an event to whoever is watching: the webview's listeners, or
    /// the CLI's progress output.
    pub fn emit<S: Serialize>(&self, event: &str, payload: S) {
        match serde_json::to_string(&payload) {
            Ok(json) => self.emit_json(event, json),
            Err(error) => log::warn!("Failed to serialize `{event}` event: {error}"),
        }
    }
}

impl Host for tauri::AppHandle {
    fn app_state(&self) -> &Arc<AppState> {
        self.state::<Arc<AppState>>().inner()
    }

    fn emit_json(&self, event: &str, payload: String) {
        let _ = self.emit_str(event, payload);
    }

    fn app_data_dir(&self) -> Result<PathBuf, AppError> {
        self.path().app_data_dir().map_err(|error| {
            AppError::Other(format!("Failed to resolve app data directory: {error}"))
        })
    }

    fn temp_dir(&self) -> PathBuf {
        self.path()
            .temp_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
    }

    fn resource_dir(&self) -> Option<PathBuf> {
        self.path().resource_dir().ok()
    }

    fn stored(&self, key: &str) -> Option<serde_json::Value> {
        self.store(SETTINGS_STORE_FILE).ok()?.get(key)
    }

    fn share(&self) -> Arc<dyn Host> {
        Arc::new(self.clone())
    }
}

/// A host with no window: the CLI's, and what tests run the engine under.
/// Its store is a snapshot and is never written back, so a running app's
/// settings are not overwritten.
#[derive(Clone)]
pub struct HeadlessHost(Arc<Headless>);

/// Receives an event's name and JSON payload.
type EventHandler = Box<dyn Fn(&str, &str) + Send + Sync>;

struct Headless {
    state: Arc<AppState>,
    data_dir: PathBuf,
    store: serde_json::Map<String, serde_json::Value>,
    on_event: EventHandler,
}

impl HeadlessHost {
    /// `store` is the settings store's content. Events arrive at `on_event`
    /// as their name and JSON payload.
    pub fn new(
        data_dir: PathBuf,
        store: serde_json::Map<String, serde_json::Value>,
        on_event: impl Fn(&str, &str) + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(Headless {
            state: AppState::new(),
            data_dir,
            store,
            on_event: Box::new(on_event),
        }))
    }
}

impl Host for HeadlessHost {
    fn app_state(&self) -> &Arc<AppState> {
        &self.0.state
    }

    fn emit_json(&self, event: &str, payload: String) {
        (self.0.on_event)(event, &payload);
    }

    fn app_data_dir(&self) -> Result<PathBuf, AppError> {
        Ok(self.0.data_dir.clone())
    }

    fn temp_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    // Bundled ffmpeg sits beside the executable on every platform, which the
    // binary lookup checks before asking the host.
    fn resource_dir(&self) -> Option<PathBuf> {
        None
    }

    fn stored(&self, key: &str) -> Option<serde_json::Value> {
        self.0.store.get(key).cloned()
    }

    fn share(&self) -> Arc<dyn Host> {
        Arc::new(self.clone())
    }
}
