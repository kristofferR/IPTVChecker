use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::engine::cast_proxy::CastProxyHandle;
use crate::engine::chromecast::ActiveCastSession;
use crate::engine::xtream::apply_xtream_archive_flags;
use crate::models::backend_perf::BackendPerfSample;
use crate::models::playlist::PlaylistPreview;
use crate::models::scan_log::ScanDebugLog;
use crate::models::settings::AppSettings;

pub const PLAYLIST_PREVIEW_CACHE_LIMIT: usize = 8;
pub const BACKEND_PERF_SAMPLES_LIMIT: usize = 512;
const XTREAM_ARCHIVE_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
type XtreamArchiveFlags = HashMap<String, Option<u32>>;

struct XtreamArchiveEnrichmentState {
    generation: u64,
    flags: Option<Arc<XtreamArchiveFlags>>,
    notify: Arc<Notify>,
}

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
    quick_check_tokens: Mutex<HashMap<String, CancellationToken>>,
    archive_download_tokens: Mutex<HashMap<String, CancellationToken>>,
    backend_perf_samples: Mutex<VecDeque<BackendPerfSample>>,
    playlist_preview_cache: Mutex<HashMap<String, CachedPlaylistPreview>>,
    /// Programme index from the most recent load_epg call.
    pub epg: Mutex<Option<std::sync::Arc<crate::engine::epg::EpgIndex>>>,
    /// Serializes concurrent load_epg calls so two loads never interleave.
    pub epg_load_lock: Mutex<()>,
    xtream_archive_enrichments: Mutex<HashMap<String, XtreamArchiveEnrichmentState>>,
    xtream_archive_generation: std::sync::atomic::AtomicU64,
    /// Cancels the previous EPG load when the playlist or load request changes.
    pub epg_load_cancel: Mutex<CancellationToken>,
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
            quick_check_tokens: Mutex::new(HashMap::new()),
            archive_download_tokens: Mutex::new(HashMap::new()),
            backend_perf_samples: Mutex::new(VecDeque::new()),
            playlist_preview_cache: Mutex::new(HashMap::new()),
            epg: Mutex::new(None),
            epg_load_lock: Mutex::new(()),
            xtream_archive_enrichments: Mutex::new(HashMap::new()),
            xtream_archive_generation: std::sync::atomic::AtomicU64::new(0),
            epg_load_cancel: Mutex::new(CancellationToken::new()),
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

    pub async fn register_quick_check(&self, request_id: String, token: CancellationToken) {
        let mut quick_check_tokens = self.quick_check_tokens.lock().await;
        if quick_check_tokens
            .get(&request_id)
            .is_some_and(CancellationToken::is_cancelled)
        {
            token.cancel();
        }
        quick_check_tokens.insert(request_id, token);
    }

    pub async fn cancel_quick_check(&self, request_id: &str) {
        self.quick_check_tokens
            .lock()
            .await
            .entry(request_id.to_string())
            .or_insert_with(CancellationToken::new)
            .cancel();
    }

    pub async fn unregister_quick_check(&self, request_id: &str) {
        self.quick_check_tokens.lock().await.remove(request_id);
    }

    /// A cancel that arrived before registration leaves a cancelled
    /// tombstone; honour it so the recording never outlives its Cancel click.
    pub async fn register_archive_download(&self, id: String, token: CancellationToken) {
        let mut tokens = self.archive_download_tokens.lock().await;
        if tokens.get(&id).is_some_and(CancellationToken::is_cancelled) {
            token.cancel();
        }
        tokens.insert(id, token);
    }

    pub async fn cancel_archive_download(&self, id: &str) {
        self.archive_download_tokens
            .lock()
            .await
            .entry(id.to_string())
            .or_insert_with(CancellationToken::new)
            .cancel();
    }

    pub async fn unregister_archive_download(&self, id: &str) {
        self.archive_download_tokens.lock().await.remove(id);
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
        mut preview: Arc<PlaylistPreview>,
        source_fingerprint: Option<u64>,
    ) {
        let archive_flags = if let Some(source_identity) = &preview.source_identity {
            self.xtream_archive_enrichments
                .lock()
                .await
                .get(source_identity)
                .and_then(|enrichment| enrichment.flags.clone())
        } else {
            None
        };
        if let Some(flags) = archive_flags {
            apply_xtream_archive_flags(&mut Arc::make_mut(&mut preview).channels, &flags);
        }

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

    pub async fn begin_xtream_archive_enrichment(&self, source_identity: String) -> u64 {
        let generation = self
            .xtream_archive_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut enrichments = self.xtream_archive_enrichments.lock().await;
        let previous = enrichments.insert(
            source_identity.clone(),
            XtreamArchiveEnrichmentState {
                generation,
                flags: None,
                notify: Arc::new(Notify::new()),
            },
        );
        if enrichments.len() > PLAYLIST_PREVIEW_CACHE_LIMIT {
            if let Some(stale_key) = enrichments
                .iter()
                .filter(|(key, _)| key.as_str() != source_identity)
                .min_by_key(|(_, enrichment)| enrichment.generation)
                .map(|(key, _)| key.clone())
            {
                enrichments.remove(&stale_key);
            }
        }
        drop(enrichments);
        if let Some(previous) = previous {
            previous.notify.notify_waiters();
        }
        generation
    }

    pub async fn wait_for_xtream_archive_flags(
        &self,
        source_identity: &str,
    ) -> Option<Arc<XtreamArchiveFlags>> {
        let generation = self
            .xtream_archive_enrichments
            .lock()
            .await
            .get(source_identity)
            .map(|enrichment| enrichment.generation)?;

        tokio::time::timeout(XTREAM_ARCHIVE_WAIT_TIMEOUT, async {
            loop {
                let notify = {
                    let enrichments = self.xtream_archive_enrichments.lock().await;
                    let enrichment = enrichments.get(source_identity)?;
                    if enrichment.generation != generation {
                        return None;
                    }
                    if let Some(flags) = &enrichment.flags {
                        return Some(Arc::clone(flags));
                    }
                    Arc::clone(&enrichment.notify)
                };

                let notified = notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let enrichments = self.xtream_archive_enrichments.lock().await;
                    let enrichment = enrichments.get(source_identity)?;
                    if enrichment.generation != generation {
                        return None;
                    }
                    if let Some(flags) = &enrichment.flags {
                        return Some(Arc::clone(flags));
                    }
                }
                notified.await;
            }
        })
        .await
        .ok()
        .flatten()
    }

    pub async fn complete_xtream_archive_enrichment(
        &self,
        source_identity: &str,
        generation: u64,
        flags: XtreamArchiveFlags,
    ) -> bool {
        let flags = Arc::new(flags);
        let mut enrichments = self.xtream_archive_enrichments.lock().await;
        let Some(enrichment) = enrichments.get_mut(source_identity) else {
            return false;
        };
        if enrichment.generation != generation {
            return false;
        }
        enrichment.flags = Some(Arc::clone(&flags));
        enrichment.notify.notify_waiters();

        let mut cache = self.playlist_preview_cache.lock().await;
        for cached in cache.values_mut() {
            if cached.preview.source_identity.as_deref() == Some(source_identity) {
                apply_xtream_archive_flags(
                    &mut Arc::make_mut(&mut cached.preview).channels,
                    &flags,
                );
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::AppState;
    use crate::models::channel::{Channel, ContentType};
    use crate::models::playlist::PlaylistPreview;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn preview() -> PlaylistPreview {
        PlaylistPreview {
            file_path: "cached.m3u".to_string(),
            file_name: "Provider".to_string(),
            source_identity: Some("xtream:provider".to_string()),
            saved_playlist_id: None,
            server_location: None,
            single_provider: true,
            xtream_max_connections: None,
            xtream_account_info: None,
            total_channels: 1,
            live_count: 1,
            movie_count: 0,
            series_count: 0,
            groups: vec!["News".to_string()],
            epg_sources: Vec::new(),
            epg_sources_by_playlist: Default::default(),
            channels: vec![Channel {
                index: 0,
                playlist: "Provider".to_string(),
                name: "News".to_string(),
                group: "News".to_string(),
                language: None,
                tvg_id: None,
                tvg_name: None,
                tvg_logo: None,
                tvg_chno: None,
                catchup: None,
                catchup_days: None,
                catchup_source: None,
                url: "https://provider.example/live/user/pass/42.ts".to_string(),
                content_type: ContentType::Live,
                extinf_line: "#EXTINF:-1,News".to_string(),
                metadata_lines: Vec::new(),
            }],
        }
    }

    #[tokio::test]
    async fn only_current_xtream_enrichment_updates_cached_previews() {
        let state = AppState::new();
        let stale_generation = state
            .begin_xtream_archive_enrichment("xtream:provider".to_string())
            .await;
        let current_generation = state
            .begin_xtream_archive_enrichment("xtream:provider".to_string())
            .await;
        state
            .put_cached_playlist_preview("cache-key".to_string(), Arc::new(preview()), None)
            .await;

        let flags = HashMap::from([("42".to_string(), Some(7))]);
        assert!(
            !state
                .complete_xtream_archive_enrichment(
                    "xtream:provider",
                    stale_generation,
                    flags.clone(),
                )
                .await
        );
        assert!(state
            .get_cached_playlist_preview("cache-key", None)
            .await
            .is_some_and(|preview| preview.channels[0].catchup.is_none()));

        assert!(
            state
                .complete_xtream_archive_enrichment("xtream:provider", current_generation, flags,)
                .await
        );
        let cached = state
            .get_cached_playlist_preview("cache-key", None)
            .await
            .expect("cached preview");
        assert_eq!(cached.channels[0].catchup.as_deref(), Some("xc"));
        assert_eq!(cached.channels[0].catchup_days, Some(7));
    }

    #[tokio::test]
    async fn new_generation_waits_until_archive_flags_are_published() {
        let state = AppState::new();
        let generation = state
            .begin_xtream_archive_enrichment("xtream:provider".to_string())
            .await;
        state
            .put_cached_playlist_preview("cache-key".to_string(), Arc::new(preview()), None)
            .await;

        let cache = state.playlist_preview_cache.lock().await;
        let enrichments = state.xtream_archive_enrichments.lock().await;
        let completing_state = Arc::clone(&state);
        let completion = tokio::spawn(async move {
            completing_state
                .complete_xtream_archive_enrichment(
                    "xtream:provider",
                    generation,
                    HashMap::from([("42".to_string(), Some(7))]),
                )
                .await
        });
        tokio::task::yield_now().await;
        drop(enrichments);
        tokio::task::yield_now().await;

        let next_state = Arc::clone(&state);
        let next_generation = tokio::spawn(async move {
            next_state
                .begin_xtream_archive_enrichment("xtream:provider".to_string())
                .await
        });
        tokio::task::yield_now().await;
        assert!(!next_generation.is_finished());

        drop(cache);
        assert!(completion.await.expect("archive enrichment completion"));
        next_generation.await.expect("next archive generation");
    }

    #[tokio::test]
    async fn scan_waits_for_pending_xtream_enrichment() {
        let state = AppState::new();
        let generation = state
            .begin_xtream_archive_enrichment("xtream:provider".to_string())
            .await;
        let waiting_state = Arc::clone(&state);
        let waiter = tokio::spawn(async move {
            waiting_state
                .wait_for_xtream_archive_flags("xtream:provider")
                .await
        });
        tokio::task::yield_now().await;

        let flags = HashMap::from([("42".to_string(), Some(7))]);
        state
            .complete_xtream_archive_enrichment("xtream:provider", generation, flags)
            .await;

        let received = waiter.await.expect("archive enrichment waiter").unwrap();
        assert_eq!(received.get("42"), Some(&Some(7)));
    }
}
