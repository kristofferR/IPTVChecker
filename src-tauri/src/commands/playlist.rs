//! Open-playlist Tauri commands and playlist load-progress plumbing.
//!
//! The heavy lifting lives in the engine modules: remote download caching in
//! `engine::remote_cache`, the Xtream API client in `engine::xtream`, and the
//! Stalker portal client in `engine::stalker`. This module wires them into
//! the `open_playlist*` commands and enriches previews with server metadata
//! (single-provider detection and server location lookup).

use crate::engine::parser;
use crate::engine::remote_cache::{
    download_playlist_to_cache_in_data_dir, parse_http_url,
    remote_playlist_cache_path_from_data_dir, write_bytes_to_cache,
    PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT, PLAYLIST_DOWNLOAD_USER_AGENT,
};
use crate::engine::stalker::{
    build_stalker_endpoint_candidates, build_stalker_preview, fetch_stalker_channels,
    fetch_stalker_genres, fetch_stalker_token, normalize_stalker_mac, normalize_stalker_portal,
    STALKER_API_TIMEOUT,
};
use crate::engine::xtream::{
    apply_xtream_archive_flags, build_xtream_download_url, build_xtream_xmltv_url,
    fetch_xtream_account_info, fetch_xtream_live_streams, fetch_xtream_playlist_via_json_api,
    xtream_archive_flags,
};
use crate::error::AppError;
use crate::models::channel::Channel;
use crate::models::playlist::PlaylistPreview;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

// Re-exported for callers elsewhere in the crate (saved.rs, recent.rs, scan.rs)
// that address these helpers via `crate::commands::playlist::...`.
pub(crate) use crate::engine::xtream::{
    build_xtream_source_key, normalize_xtream_server, xtream_host_label,
};
pub(crate) use crate::urlnorm::normalize_url_identity;

/// Live progress events emitted during playlist loading.
#[derive(Clone, Serialize)]
#[serde(tag = "stage")]
pub enum PlaylistLoadProgress {
    Connecting {
        detail: &'static str,
    },
    Downloading {
        bytes_downloaded: u64,
        elapsed_secs: f64,
    },
    Saving {
        detail: &'static str,
    },
    Parsing {
        channels_found: usize,
        live_found: usize,
        movie_found: usize,
        series_found: usize,
    },
    Processing {
        detail: &'static str,
    },
}

pub(crate) const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);
const PROGRESS_LOG_THROTTLE: Duration = Duration::from_secs(1);
const XTREAM_ARCHIVE_ENRICHMENT_GRACE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct PlaylistProgressLogState {
    last_download_log_at: Option<Instant>,
    last_download_bytes: u64,
    last_parse_log_at: Option<Instant>,
    last_parse_channels: usize,
}

static PLAYLIST_PROGRESS_LOG_STATE: OnceLock<Mutex<PlaylistProgressLogState>> = OnceLock::new();

fn playlist_progress_log_state() -> &'static Mutex<PlaylistProgressLogState> {
    PLAYLIST_PROGRESS_LOG_STATE.get_or_init(|| Mutex::new(PlaylistProgressLogState::default()))
}

pub(crate) fn emit_load_progress(app: Option<&AppHandle>, progress: PlaylistLoadProgress) {
    match &progress {
        PlaylistLoadProgress::Connecting { detail } => {
            log::info!("[playlist-load] Connecting: {}", detail);
        }
        PlaylistLoadProgress::Downloading {
            bytes_downloaded,
            elapsed_secs,
        } => {
            if let Ok(mut state) = playlist_progress_log_state().lock() {
                let should_log = *bytes_downloaded == 0
                    || state.last_download_log_at.is_none()
                    || state
                        .last_download_log_at
                        .is_some_and(|at| at.elapsed() >= PROGRESS_LOG_THROTTLE)
                    || bytes_downloaded.saturating_sub(state.last_download_bytes)
                        >= 5 * 1024 * 1024;
                if should_log {
                    log::info!(
                        "[playlist-load] Downloading: {:.1} MB in {:.1}s",
                        *bytes_downloaded as f64 / (1024.0 * 1024.0),
                        elapsed_secs
                    );
                    state.last_download_log_at = Some(Instant::now());
                    state.last_download_bytes = *bytes_downloaded;
                }
            }
        }
        PlaylistLoadProgress::Parsing {
            channels_found,
            live_found,
            movie_found,
            series_found,
        } => {
            if let Ok(mut state) = playlist_progress_log_state().lock() {
                let should_log = *channels_found == 0
                    || state.last_parse_log_at.is_none()
                    || state
                        .last_parse_log_at
                        .is_some_and(|at| at.elapsed() >= PROGRESS_LOG_THROTTLE)
                    || channels_found.saturating_sub(state.last_parse_channels) >= 10_000;
                if should_log {
                    log::info!(
                        "[playlist-load] Parsing: {} channels (live: {}, movies: {}, series: {})",
                        channels_found,
                        live_found,
                        movie_found,
                        series_found
                    );
                    state.last_parse_log_at = Some(Instant::now());
                    state.last_parse_channels = *channels_found;
                }
            }
        }
        PlaylistLoadProgress::Saving { detail } => {
            log::info!("[playlist-load] Saving: {}", detail);
        }
        PlaylistLoadProgress::Processing { detail } => {
            log::info!("[playlist-load] Processing: {}", detail);
        }
    }
    if let Some(app) = app {
        let _ = app.emit("playlist://load-progress", progress);
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct XtreamOpenRequest {
    pub server: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StalkerOpenRequest {
    pub portal: String,
    pub mac: String,
}

const SERVER_LOCATION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(4);

static SERVER_LOCATION_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn server_location_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    SERVER_LOCATION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fast host extraction without full URL parsing.
/// Handles `http://host:port/path`, `http://user:pass@host/path`, etc.
fn extract_host_fast(url: &str) -> Option<&str> {
    let after_scheme = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("rtsp://"))
        .or_else(|| url.strip_prefix("rtmp://"))?;
    // Skip userinfo if present (user:pass@)
    let after_userinfo = after_scheme
        .rfind('@')
        .map(|pos| &after_scheme[pos + 1..])
        .unwrap_or(after_scheme);
    let host = if let Some(bracketed) = after_userinfo.strip_prefix('[') {
        let end = bracketed.find(']')?;
        &bracketed[..end]
    } else {
        // Host ends at first '/', ':', '?', or '#' (port, path, query, or fragment)
        let end = after_userinfo
            .find(['/', ':', '?', '#'])
            .unwrap_or(after_userinfo.len());
        &after_userinfo[..end]
    };
    if host.is_empty() {
        return None;
    }
    Some(host)
}

fn channel_host_counts(channels: &[Channel]) -> HashMap<String, usize> {
    let mut counts = HashMap::<String, usize>::new();
    for channel in channels {
        let Some(host) = extract_host_fast(channel.url.trim()) else {
            continue;
        };
        *counts.entry(host.to_ascii_lowercase()).or_insert(0) += 1;
    }
    counts
}

fn dominant_host_from_counts(counts: &HashMap<String, usize>) -> Option<String> {
    counts
        .iter()
        .max_by(|(host_a, count_a), (host_b, count_b)| {
            count_a.cmp(count_b).then_with(|| host_b.cmp(host_a))
        })
        .map(|(host, _)| host.clone())
}

/// Returns `true` when ≥90% of parseable channel URLs share the same hostname.
pub(crate) fn is_single_provider_check(channels: &[Channel]) -> bool {
    is_single_provider(channels)
}

fn is_single_provider(channels: &[Channel]) -> bool {
    let counts = channel_host_counts(channels);
    let total: usize = counts.values().sum();
    if total == 0 {
        return false;
    }
    let max = counts.values().max().copied().unwrap_or(0);
    max * 10 >= total * 9 // equivalent to max/total >= 0.9 without floating point
}

fn is_routable_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified())
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local())
        }
    }
}

async fn resolve_host_ip(host: &str) -> Option<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_routable_ip(&ip).then_some(ip);
    }

    let mut fallback: Option<IpAddr> = None;
    let addresses = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::lookup_host((host, 0)),
    )
    .await
    .ok()?
    .ok()?;
    for socket_address in addresses {
        let ip = socket_address.ip();
        if is_routable_ip(&ip) {
            return Some(ip);
        }
        if fallback.is_none() {
            fallback = Some(ip);
        }
    }
    fallback.filter(is_routable_ip)
}

fn parse_ipapi_location(payload: &serde_json::Value) -> Option<String> {
    if payload
        .get("error")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }

    let city = payload
        .get("city")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let region = payload
        .get("region")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let country_code = payload
        .get("country_code")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase());
    let country_name = payload
        .get("country_name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if let (Some(city), Some(code)) = (city.as_ref(), country_code.as_ref()) {
        return Some(format!("{}, {}", city, code));
    }
    if let (Some(region), Some(code)) = (region.as_ref(), country_code.as_ref()) {
        return Some(format!("{}, {}", region, code));
    }
    if let Some(name) = country_name {
        return Some(name);
    }
    country_code
}

async fn lookup_ip_location(ip: IpAddr) -> Option<String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(SERVER_LOCATION_LOOKUP_TIMEOUT)
        .build()
        .ok()?;

    let url = format!("https://ipapi.co/{}/json/", ip);
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let payload_bytes = response.bytes().await.ok()?;
    let payload = serde_json::from_slice::<serde_json::Value>(&payload_bytes).ok()?;
    parse_ipapi_location(&payload)
}

/// Populate both server_location and single_provider in one pass over the
/// channel URLs, avoiding redundant `Url::parse()` calls on every channel.
async fn populate_server_metadata(app: Option<&AppHandle>, preview: &mut PlaylistPreview) {
    emit_load_progress(
        app,
        PlaylistLoadProgress::Processing {
            detail: "Analyzing channel URLs",
        },
    );
    let counts = channel_host_counts(&preview.channels);

    // single_provider
    let total: usize = counts.values().sum();
    if total > 0 {
        let max = counts.values().max().copied().unwrap_or(0);
        preview.single_provider = max * 10 >= total * 9;
    }

    // server_location — only look up when ≥90% of channels share the same host
    if preview.single_provider {
        if let Some(host) = dominant_host_from_counts(&counts) {
            if !host.eq_ignore_ascii_case("localhost") {
                if let Ok(cache) = server_location_cache().lock() {
                    if let Some(cached) = cache.get(&host) {
                        preview.server_location = cached.clone();
                        return;
                    }
                }
                emit_load_progress(
                    app,
                    PlaylistLoadProgress::Processing {
                        detail: "Looking up server location",
                    },
                );
                let location = match resolve_host_ip(&host).await {
                    Some(ip) => lookup_ip_location(ip).await,
                    None => None,
                };
                if let Ok(mut cache) = server_location_cache().lock() {
                    cache.insert(host, location.clone());
                }
                preview.server_location = location;
            }
        }
    }
}

/// Derive a human-friendly playlist name from a URL.
/// Prefers the filename from the path (e.g. "news.m3u"), falling back to the
/// hostname (e.g. "iptv-org.github.io").
pub(crate) fn friendly_name_from_url(url: &Url) -> String {
    if let Some(mut segments) = url.path_segments() {
        if let Some(last) = segments.rfind(|s| !s.is_empty()) {
            // Use the segment if it looks like a real name (has extension,
            // is short, or isn't a pure hex hash).
            if last.contains('.') || last.len() < 40 || !last.chars().all(|c| c.is_ascii_hexdigit())
            {
                return last.to_string();
            }
        }
    }
    url.host_str().unwrap_or("Playlist").to_string()
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path().app_data_dir().map_err(|error| {
        AppError::Other(format!("Failed to resolve app data directory: {}", error))
    })
}

async fn accepts_invalid_certs(app: Option<&AppHandle>) -> bool {
    let Some(app) = app else {
        return false;
    };
    app.state::<Arc<AppState>>()
        .settings
        .lock()
        .await
        .accept_invalid_certs
}

#[tauri::command]
pub async fn open_playlist_stalker(
    app: AppHandle,
    source: StalkerOpenRequest,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let portal = normalize_stalker_portal(&source.portal)?;
    let mac = normalize_stalker_mac(&source.mac)?;
    let endpoints = build_stalker_endpoint_candidates(&portal);
    let accept_invalid_certs = accepts_invalid_certs(Some(&app)).await;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(STALKER_API_TIMEOUT)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|error| {
            AppError::Other(format!(
                "Failed to initialize HTTP client for Stalker portal: {}",
                error
            ))
        })?;

    let mut errors = Vec::<String>::new();
    for endpoint in endpoints {
        let token = match fetch_stalker_token(&client, &endpoint, &mac).await {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("{} handshake failed: {}", endpoint, error));
                continue;
            }
        };

        let genres = fetch_stalker_genres(&client, &endpoint, &mac, &token).await;
        let channels_payload = match fetch_stalker_channels(&client, &endpoint, &mac, &token).await
        {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("{} channel fetch failed: {}", endpoint, error));
                continue;
            }
        };

        let mut preview = build_stalker_preview(
            &portal,
            &mac,
            channels_payload,
            &genres,
            &group_filter,
            &channel_search,
        )?;

        if preview.total_channels == 0 {
            errors.push(format!("{} returned no playable channels", endpoint));
            continue;
        }

        populate_server_metadata(Some(&app), &mut preview).await;
        crate::commands::scan::seed_cached_playlist_preview(
            &app,
            &preview.file_path,
            preview.source_identity.as_deref(),
            Some(&preview.file_name),
            group_filter.as_deref(),
            channel_search.as_deref(),
            &preview,
        )
        .await;
        return Ok(preview);
    }

    let detail = if errors.is_empty() {
        "No Stalker endpoints could be reached".to_string()
    } else {
        errors.join(" | ")
    };

    Err(AppError::Other(format!(
        "Failed to load channels from the Stalker portal. {}",
        detail
    )))
}

#[tauri::command]
pub async fn open_playlist(
    app: AppHandle,
    path: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let cache_group_filter = group_filter.clone();
    let cache_channel_search = channel_search.clone();
    let mut preview = open_playlist_path_inner(&app, path, group_filter, channel_search).await?;
    crate::commands::saved::apply_persisted_playlist_metadata(&app, &mut preview, None, None)?;
    crate::commands::scan::seed_cached_playlist_preview(
        &app,
        &preview.file_path,
        preview.source_identity.as_deref(),
        Some(&preview.file_name),
        cache_group_filter.as_deref(),
        cache_channel_search.as_deref(),
        &preview,
    )
    .await;
    Ok(preview)
}

/// Parse a playlist file on a blocking thread, forwarding throttled Parsing
/// progress events. Parsing a large (up to 200 MB) playlist is seconds of
/// CPU-bound work that must not stall a tokio runtime worker.
async fn parse_playlist_off_thread(
    app: Option<&AppHandle>,
    path: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    emit_load_progress(
        app,
        PlaylistLoadProgress::Parsing {
            channels_found: 0,
            live_found: 0,
            movie_found: 0,
            series_found: 0,
        },
    );
    let app_for_progress = app.cloned();
    tokio::task::spawn_blocking(move || {
        let last_emit = std::cell::Cell::new(Instant::now() - PROGRESS_THROTTLE);
        let on_progress = |progress: parser::ParseProgress| {
            if last_emit.get().elapsed() >= PROGRESS_THROTTLE {
                emit_load_progress(
                    app_for_progress.as_ref(),
                    PlaylistLoadProgress::Parsing {
                        channels_found: progress.channels_found,
                        live_found: progress.live_found,
                        movie_found: progress.movie_found,
                        series_found: progress.series_found,
                    },
                );
                last_emit.set(Instant::now());
            }
        };
        let cb: Option<&dyn Fn(parser::ParseProgress)> = if app_for_progress.is_some() {
            Some(&on_progress)
        } else {
            None
        };
        parser::parse_playlist_with_progress(&path, &group_filter, &channel_search, cb)
    })
    .await
    .map_err(|err| AppError::Other(format!("Playlist parse task failed: {err}")))?
}

pub(crate) async fn open_playlist_path_inner(
    app: &AppHandle,
    path: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let mut preview =
        parse_playlist_off_thread(Some(app), path.clone(), group_filter, channel_search).await?;
    populate_server_metadata(Some(app), &mut preview).await;
    Ok(preview)
}

#[tauri::command]
pub async fn open_playlist_url(
    app: tauri::AppHandle,
    url: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let cache_group_filter = group_filter.clone();
    let cache_channel_search = channel_search.clone();
    let data_dir = app_data_dir(&app)?;
    let mut preview =
        open_playlist_url_from_data_dir(Some(&app), &data_dir, &url, group_filter, channel_search)
            .await?;
    crate::commands::saved::apply_persisted_playlist_metadata(&app, &mut preview, None, None)?;
    crate::commands::scan::seed_cached_playlist_preview(
        &app,
        &preview.file_path,
        preview.source_identity.as_deref(),
        Some(&preview.file_name),
        cache_group_filter.as_deref(),
        cache_channel_search.as_deref(),
        &preview,
    )
    .await;
    Ok(preview)
}

pub(crate) async fn open_playlist_url_from_data_dir(
    app: Option<&AppHandle>,
    data_dir: &std::path::Path,
    url: &str,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let mut parsed = parse_http_url(url.trim(), "Invalid playlist URL")?;
    parsed.set_fragment(None);
    let normalized_identity = normalize_url_identity(&parsed);
    let source_key = format!("url:{}", normalized_identity);
    let cached_path = download_playlist_to_cache_in_data_dir(
        app,
        data_dir,
        &source_key,
        &parsed,
        "playlist URL",
        accepts_invalid_certs(app).await,
    )
    .await?;
    let mut preview =
        parse_playlist_off_thread(app, cached_path.clone(), group_filter, channel_search).await?;
    preview.file_name = friendly_name_from_url(&parsed);
    preview.source_identity = Some(format!("url:{}", normalized_identity));
    populate_server_metadata(app, &mut preview).await;
    Ok(preview)
}

#[tauri::command]
pub async fn open_playlist_xtream(
    app: tauri::AppHandle,
    source: XtreamOpenRequest,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let cache_group_filter = group_filter.clone();
    let cache_channel_search = channel_search.clone();
    let mut preview =
        open_playlist_xtream_inner(&app, &source, group_filter, channel_search, None).await?;
    crate::commands::saved::apply_persisted_playlist_metadata(&app, &mut preview, None, None)?;
    crate::commands::scan::seed_cached_playlist_preview(
        &app,
        &preview.file_path,
        preview.source_identity.as_deref(),
        Some(&preview.file_name),
        cache_group_filter.as_deref(),
        cache_channel_search.as_deref(),
        &preview,
    )
    .await;
    Ok(preview)
}

pub(crate) async fn open_playlist_xtream_inner(
    app: &tauri::AppHandle,
    source: &XtreamOpenRequest,
    group_filter: Option<String>,
    channel_search: Option<String>,
    source_identity_override: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let username = source.username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::Parse(
            "Xtream username cannot be empty".to_string(),
        ));
    }

    let password = source.password.trim().to_string();
    if password.is_empty() {
        return Err(AppError::Parse(
            "Xtream password cannot be empty".to_string(),
        ));
    }

    let server = normalize_xtream_server(&source.server)?;
    let source_key = build_xtream_source_key(&server, &username);
    let download_url = build_xtream_download_url(&server, &username, &password);
    let data_dir = app_data_dir(app)?;
    let cache_path = remote_playlist_cache_path_from_data_dir(&data_dir, &source_key)?;
    let accept_invalid_certs = accepts_invalid_certs(Some(app)).await;

    // Keep the potentially large live-stream catalog running independently so
    // it can enrich the parsed playlist without imposing its full timeout.
    let live_streams_task = {
        let server = server.clone();
        let username = username.clone();
        let password = password.clone();
        tokio::spawn(async move {
            fetch_xtream_live_streams(&server, &username, &password, accept_invalid_certs).await
        })
    };
    let (xtream_account_info, m3u_result) = tokio::join!(
        fetch_xtream_account_info(&server, &username, &password, accept_invalid_certs),
        download_playlist_to_cache_in_data_dir(
            Some(app),
            &data_dir,
            &source_key,
            &download_url,
            "Xtream playlist",
            accept_invalid_certs,
        ),
    );

    // If /get.php failed, fall back to the JSON API.
    let (cached_path, archive_task) = match m3u_result {
        Ok(path) => (path, Some(live_streams_task)),
        Err(get_php_error) => {
            log::info!(
                "Xtream /get.php download failed ({}), falling back to JSON API",
                get_php_error
            );
            let live_streams = live_streams_task.await.ok().flatten();
            let m3u_bytes = fetch_xtream_playlist_via_json_api(
                &server,
                &username,
                &password,
                accept_invalid_certs,
                live_streams,
            )
            .await?;
            // Same rule as the normal download path: a potentially large
            // synchronous cache write belongs on a blocking thread.
            {
                let cache_path = cache_path.clone();
                tokio::task::spawn_blocking(move || write_bytes_to_cache(&cache_path, &m3u_bytes))
                    .await
                    .map_err(|err| {
                        AppError::Other(format!("Playlist cache write task failed: {err}"))
                    })??;
            }
            (cache_path.to_string_lossy().to_string(), None)
        }
    };

    let mut preview = match parse_playlist_off_thread(
        Some(app),
        cached_path.clone(),
        group_filter,
        channel_search,
    )
    .await
    {
        Ok(preview) => preview,
        Err(error) => {
            if let Some(task) = archive_task {
                task.abort();
            }
            return Err(error);
        }
    };
    let archive_flags = if let Some(mut task) = archive_task {
        match tokio::time::timeout(XTREAM_ARCHIVE_ENRICHMENT_GRACE_TIMEOUT, &mut task).await {
            Ok(Ok(Some(live_streams))) => xtream_archive_flags(&live_streams),
            Ok(Ok(None)) => HashMap::new(),
            Ok(Err(error)) => {
                log::debug!("Xtream live-stream catalog task failed: {error}");
                HashMap::new()
            }
            Err(_) => {
                task.abort();
                HashMap::new()
            }
        }
    } else {
        HashMap::new()
    };
    let xmltv_source = build_xtream_xmltv_url(&server, &username, &password).to_string();
    if !preview.epg_sources.contains(&xmltv_source) {
        preview.epg_sources.push(xmltv_source);
    }
    if !archive_flags.is_empty() {
        apply_xtream_archive_flags(&mut preview.channels, &archive_flags);
    }
    let server_host = server.host_str().unwrap_or("Xtream");
    preview.file_name = format!("{} ({})", server_host, username);
    preview.source_identity = Some(source_identity_override.unwrap_or(source_key));
    preview.xtream_max_connections = xtream_account_info
        .as_ref()
        .and_then(|account| account.max_connections);
    preview.xtream_account_info = xtream_account_info;
    populate_server_metadata(Some(app), &mut preview).await;
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_host_fast, is_single_provider, normalize_url_identity, parse_ipapi_location,
    };
    use crate::models::channel::{Channel, ContentType};
    use url::Url;

    #[test]
    fn dominant_channel_host_uses_most_common_url_host() {
        let channel = |index: usize, url: &str| Channel {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Group".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: url.to_string(),
            content_type: ContentType::Live,
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
        };

        let channels = vec![
            channel(0, "https://one.example.com/live/1.m3u8"),
            channel(1, "https://one.example.com/live/2.m3u8"),
            channel(2, "https://two.example.com/live/3.m3u8"),
        ];

        let counts = super::channel_host_counts(&channels);
        assert_eq!(
            super::dominant_host_from_counts(&counts),
            Some("one.example.com".to_string())
        );
    }

    #[test]
    fn extract_host_fast_handles_userinfo_ipv6_and_empty_hosts() {
        assert_eq!(
            extract_host_fast("http://user:p@ss@host.example.com/live/1.m3u8"),
            Some("host.example.com")
        );
        assert_eq!(
            extract_host_fast("http://user:pass@[::1]:8080/path"),
            Some("::1")
        );
        assert_eq!(extract_host_fast("http://"), None);
        assert_eq!(extract_host_fast("https://?token=abc"), None);
    }

    #[test]
    fn is_single_provider_true_when_all_channels_share_host() {
        let channel = |index: usize, url: &str| Channel {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Group".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: url.to_string(),
            content_type: ContentType::Live,
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
        };

        let channels = vec![
            channel(0, "https://cdn.example.com/live/1.m3u8"),
            channel(1, "https://cdn.example.com/live/2.m3u8"),
            channel(2, "https://cdn.example.com/live/3.m3u8"),
        ];
        assert!(is_single_provider(&channels));
    }

    #[test]
    fn is_single_provider_true_at_ninety_percent_threshold() {
        let channel = |index: usize, url: &str| Channel {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Group".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: url.to_string(),
            content_type: ContentType::Live,
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
        };

        let mut channels: Vec<Channel> = (0..9)
            .map(|i| channel(i, &format!("https://cdn.example.com/live/{}.m3u8", i)))
            .collect();
        channels.push(channel(9, "https://other.example.com/live/9.m3u8"));
        // 9/10 = 90% => single provider
        assert!(is_single_provider(&channels));
    }

    #[test]
    fn is_single_provider_false_below_threshold() {
        let channel = |index: usize, url: &str| Channel {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Group".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: url.to_string(),
            content_type: ContentType::Live,
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
        };

        let mut channels: Vec<Channel> = (0..8)
            .map(|i| channel(i, &format!("https://cdn.example.com/live/{}.m3u8", i)))
            .collect();
        channels.push(channel(8, "https://other-a.example.com/live/8.m3u8"));
        channels.push(channel(9, "https://other-b.example.com/live/9.m3u8"));
        // 8/10 = 80% < 90% => mixed
        assert!(!is_single_provider(&channels));
    }

    #[test]
    fn is_single_provider_false_for_mixed_playlist() {
        let channel = |index: usize, url: &str| Channel {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Group".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: url.to_string(),
            content_type: ContentType::Live,
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
        };

        let channels = vec![
            channel(0, "https://cdn-a.example.com/live/1.m3u8"),
            channel(1, "https://cdn-b.example.com/live/2.m3u8"),
            channel(2, "https://cdn-c.example.com/live/3.m3u8"),
        ];
        assert!(!is_single_provider(&channels));
    }

    #[test]
    fn is_single_provider_false_for_empty_channels() {
        assert!(!is_single_provider(&[]));
    }

    #[test]
    fn parse_ipapi_location_formats_city_and_country_code() {
        let payload = serde_json::json!({
            "city": "Amsterdam",
            "region": "North Holland",
            "country_code": "nl",
            "country_name": "Netherlands"
        });
        assert_eq!(
            parse_ipapi_location(&payload),
            Some("Amsterdam, NL".to_string())
        );
    }

    #[test]
    fn normalize_url_identity_removes_default_port_and_fragment() {
        let parsed =
            Url::parse("https://Example.com:443/live/list.m3u8#frag").expect("URL should parse");
        assert_eq!(
            normalize_url_identity(&parsed),
            "https://example.com/live/list.m3u8"
        );
    }
}
