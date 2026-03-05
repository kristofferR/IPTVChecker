use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

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
    pub source_mtime_ms: Option<u64>,
    pub preview: PlaylistPreview,
    pub cached_at_epoch_ms: u64,
}

impl CachedPlaylistPreview {
    fn new(preview: PlaylistPreview, source_mtime_ms: Option<u64>) -> Self {
        Self {
            source_mtime_ms,
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

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    window_scan_states: Mutex<HashMap<String, WindowScanState>>,
    backend_perf_samples: Mutex<VecDeque<BackendPerfSample>>,
    playlist_preview_cache: Mutex<HashMap<String, CachedPlaylistPreview>>,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            settings: Mutex::new(AppSettings::default()),
            window_scan_states: Mutex::new(HashMap::new()),
            backend_perf_samples: Mutex::new(VecDeque::new()),
            playlist_preview_cache: Mutex::new(HashMap::new()),
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
        source_mtime_ms: Option<u64>,
    ) -> Option<PlaylistPreview> {
        let cache = self.playlist_preview_cache.lock().await;
        cache.get(cache_key).and_then(|cached| {
            if cached.source_mtime_ms == source_mtime_ms {
                Some(cached.preview.clone())
            } else {
                None
            }
        })
    }

    pub async fn put_cached_playlist_preview(
        &self,
        cache_key: String,
        preview: PlaylistPreview,
        source_mtime_ms: Option<u64>,
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
            CachedPlaylistPreview::new(preview, source_mtime_ms),
        );
    }
}
