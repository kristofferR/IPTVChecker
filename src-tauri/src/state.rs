use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::engine::cast_proxy::CastProxyHandle;
use crate::engine::chromecast::ActiveCastSession;
use crate::models::backend_perf::BackendPerfSample;
use crate::models::playlist::PlaylistPreview;
use crate::models::scan_log::ScanDebugLog;
use crate::models::settings::AppSettings;

pub const PLAYLIST_PREVIEW_CACHE_LIMIT: usize = 8;
pub const BACKEND_PERF_SAMPLES_LIMIT: usize = 512;

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone)]
pub struct CachedPlaylistPreview {
    pub source_fingerprint: Option<u64>,
    // Arc so cache hits hand out a reference instead of deep-copying a
    // potentially 100k-channel preview on every open/scan start.
    pub preview: Arc<PlaylistPreview>,
    pub cached_at_epoch_ms: u64,
}

impl CachedPlaylistPreview {
    fn new(preview: Arc<PlaylistPreview>, source_fingerprint: Option<u64>) -> Self {
        Self {
            source_fingerprint,
            preview,
            cached_at_epoch_ms: now_epoch_ms(),
        }
    }
}

pub struct WindowScanState {
    pub cancel_token: Option<CancellationToken>,
    pub scanning: bool,
    pub paused: bool,
    pub current_run_id: Option<String>,
    pub scan_log: Option<ScanDebugLog>,
    pub pause_notify: Arc<Notify>,
}

impl Default for WindowScanState {
    fn default() -> Self {
        Self {
            cancel_token: None,
            scanning: false,
            paused: false,
            current_run_id: None,
            scan_log: None,
            pause_notify: Arc::new(Notify::new()),
        }
    }
}

#[derive(Default)]
pub struct CastState {
    pub session: Option<ActiveCastSession>,
    pub proxy: Option<CastProxyHandle>,
}

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub proxy_client: Mutex<Option<(reqwest::Client, bool)>>,
    pub streaming_proxy_port: std::sync::atomic::AtomicU16,
    pub streaming_proxy_start_lock: Mutex<()>,
    pub cast_state: Mutex<CastState>,
    /// Held for the entire start/stop cast lifecycle so concurrent
    /// `cast_to_device` / `stop_cast` calls cannot interleave and corrupt
    /// the stored session.
    pub cast_lifecycle_lock: Mutex<()>,
    window_scan_states: Mutex<HashMap<String, WindowScanState>>,
    backend_perf_samples: Mutex<VecDeque<BackendPerfSample>>,
    playlist_preview_cache: Mutex<HashMap<String, CachedPlaylistPreview>>,
    /// Rejects a second install immediately instead of queueing it behind the
    /// first one on `update_checking`.
    pub update_installing: std::sync::atomic::AtomicBool,
    /// Serializes every updater operation so automatic discovery, a manual
    /// check, and an install can never contend for the updater.
    pub update_checking: Mutex<()>,
    /// The update found by the most recent check, if any. Retaining the
    /// verified metadata lets the install action apply exactly the update the
    /// user was shown rather than re-resolving it.
    pub update_available: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Wakes the periodic check loop when the preference is switched back on,
    /// instead of waiting out the current interval.
    pub update_check_wake: Notify,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            settings: Mutex::new(AppSettings::default()),
            proxy_client: Mutex::new(None),
            streaming_proxy_port: std::sync::atomic::AtomicU16::new(0),
            streaming_proxy_start_lock: Mutex::new(()),
            cast_state: Mutex::new(CastState::default()),
            cast_lifecycle_lock: Mutex::new(()),
            window_scan_states: Mutex::new(HashMap::new()),
            backend_perf_samples: Mutex::new(VecDeque::new()),
            playlist_preview_cache: Mutex::new(HashMap::new()),
            update_installing: std::sync::atomic::AtomicBool::new(false),
            update_checking: Mutex::new(()),
            update_available: Mutex::new(None),
            update_check_wake: Notify::new(),
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

    pub async fn window_pause_notify(&self, window_label: &str) -> Arc<Notify> {
        self.with_window_scan_state(window_label, |scan_state| scan_state.pause_notify.clone())
            .await
    }

    pub async fn push_backend_perf_sample(&self, sample: BackendPerfSample) {
        let mut samples = self.backend_perf_samples.lock().await;
        if samples.len() >= BACKEND_PERF_SAMPLES_LIMIT {
            samples.pop_front();
        }
        samples.push_back(sample);
    }

    pub async fn backend_perf_samples_snapshot(&self) -> Vec<BackendPerfSample> {
        let samples = self.backend_perf_samples.lock().await;
        samples.iter().cloned().collect()
    }

    pub async fn get_cached_playlist_preview(
        &self,
        cache_key: &str,
        source_fingerprint: Option<u64>,
    ) -> Option<Arc<PlaylistPreview>> {
        let cache = self.playlist_preview_cache.lock().await;
        cache.get(cache_key).and_then(|cached| {
            if cached.source_fingerprint == source_fingerprint {
                Some(Arc::clone(&cached.preview))
            } else {
                None
            }
        })
    }

    pub async fn put_cached_playlist_preview(
        &self,
        cache_key: String,
        preview: Arc<PlaylistPreview>,
        source_fingerprint: Option<u64>,
    ) {
        let mut cache = self.playlist_preview_cache.lock().await;
        if cache.len() >= PLAYLIST_PREVIEW_CACHE_LIMIT && !cache.contains_key(&cache_key) {
            if let Some(stale_key) = cache
                .iter()
                .min_by_key(|(_, value)| value.cached_at_epoch_ms)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&stale_key);
            }
        }
        cache.insert(
            cache_key,
            CachedPlaylistPreview::new(preview, source_fingerprint),
        );
    }
}
