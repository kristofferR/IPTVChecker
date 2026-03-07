use crate::engine::{ffmpeg, parser};
use crate::error::AppError;
use crate::models::channel::{Channel, ContentType};
use crate::models::playlist::{PlaylistPreview, XtreamAccountInfo};
use rand::seq::SliceRandom;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio_util::sync::CancellationToken;
use url::Url;

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

const PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PLAYLIST_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const PLAYLIST_DOWNLOAD_MAX_BYTES: u64 = 200 * 1024 * 1024;
const PLAYLIST_DOWNLOAD_USER_AGENT: &str = "VLC/3.0.23 LibVLC/3.0.23";
const XTREAM_PLAYER_API_TIMEOUT: Duration = Duration::from_secs(8);
const STALKER_API_TIMEOUT: Duration = Duration::from_secs(12);
const STALKER_USER_AGENT: &str =
    "Mozilla/5.0 (QtEmbedded; U; Linux; C) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";
const STALKER_X_USER_AGENT: &str = "Model: MAG250; Link: WiFi";
const SERVER_LOCATION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(4);

static SERVER_LOCATION_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RemotePlaylistCacheMetadata {
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Debug)]
enum PlaylistDownloadResult {
    NotModified,
    Updated {
        bytes: Vec<u8>,
        metadata: RemotePlaylistCacheMetadata,
    },
}

fn server_location_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    SERVER_LOCATION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dominant_channel_host(channels: &[Channel]) -> Option<String> {
    let mut counts = HashMap::<String, usize>::new();
    for channel in channels {
        let Ok(parsed) = Url::parse(channel.url.trim()) else {
            continue;
        };
        let Some(host) = parsed.host_str() else {
            continue;
        };
        let normalized = host.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        *counts.entry(normalized).or_insert(0) += 1;
    }

    counts
        .into_iter()
        .max_by(|(host_a, count_a), (host_b, count_b)| {
            count_a.cmp(count_b).then_with(|| host_b.cmp(host_a))
        })
        .map(|(host, _)| host)
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
    let addresses = tokio::net::lookup_host((host, 0)).await.ok()?;
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

async fn resolve_playlist_server_location(channels: &[Channel]) -> Option<String> {
    let host = dominant_channel_host(channels)?;
    if host.eq_ignore_ascii_case("localhost") {
        return None;
    }

    if let Ok(cache) = server_location_cache().lock() {
        if let Some(cached) = cache.get(&host) {
            return cached.clone();
        }
    }

    let location = match resolve_host_ip(&host).await {
        Some(ip) => lookup_ip_location(ip).await,
        None => None,
    };

    if let Ok(mut cache) = server_location_cache().lock() {
        cache.insert(host, location.clone());
    }

    location
}

async fn populate_server_location(preview: &mut PlaylistPreview) {
    preview.server_location = resolve_playlist_server_location(&preview.channels).await;
}

fn parse_http_url(value: &str, invalid_message: &str) -> Result<Url, AppError> {
    let trimmed = value.trim();
    let parsed = Url::parse(trimmed)
        .map_err(|error| AppError::Parse(format!("{}: {}", invalid_message, error)))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Parse(format!(
            "{}: must use http:// or https://",
            invalid_message
        )));
    }

    Ok(parsed)
}

fn hash_source_key(source_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn normalize_url_identity(url: &Url) -> String {
    let mut normalized = url.clone();
    normalized.set_fragment(None);
    if (normalized.scheme() == "http" && normalized.port() == Some(80))
        || (normalized.scheme() == "https" && normalized.port() == Some(443))
    {
        let _ = normalized.set_port(None);
    }
    normalized.to_string()
}

fn source_cache_file_name(source_key: &str) -> String {
    format!("{}.m3u8", hash_source_key(source_key))
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path().app_data_dir().map_err(|error| {
        AppError::Other(format!("Failed to resolve app data directory: {}", error))
    })
}

fn remote_playlist_cache_path_from_data_dir(
    data_dir: &std::path::Path,
    source_key: &str,
) -> Result<std::path::PathBuf, AppError> {
    let cache_dir = data_dir.join("remote-playlists");
    std::fs::create_dir_all(&cache_dir).map_err(AppError::Io)?;
    Ok(cache_dir.join(source_cache_file_name(source_key)))
}

fn cleanup_stale_cache_temp_files(cache_path: &std::path::Path) {
    let Some(parent) = cache_path.parent() else {
        return;
    };
    let Some(cache_name) = cache_path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let temp_prefix = format!("{}.", cache_name);

    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with(&temp_prefix) && name.ends_with(".tmp") {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn cache_metadata_path(cache_path: &std::path::Path) -> std::path::PathBuf {
    cache_path.with_extension("m3u8.meta.json")
}

fn load_cache_metadata(cache_path: &std::path::Path) -> Option<RemotePlaylistCacheMetadata> {
    let path = cache_metadata_path(cache_path);
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<RemotePlaylistCacheMetadata>(&bytes).ok()
}

fn save_cache_metadata(
    cache_path: &std::path::Path,
    metadata: &RemotePlaylistCacheMetadata,
) -> Result<(), AppError> {
    let path = cache_metadata_path(cache_path);
    let bytes = serde_json::to_vec(metadata).map_err(|error| {
        AppError::Parse(format!("Failed to serialize cache metadata: {}", error))
    })?;
    std::fs::write(path, bytes).map_err(AppError::Io)
}

fn map_download_error(
    error: reqwest::Error,
    error_label: &str,
    timeout: Duration,
    when: &str,
) -> AppError {
    if error.is_timeout() {
        return AppError::Other(format!(
            "Timed out while downloading {} after {} seconds",
            error_label,
            timeout.as_secs()
        ));
    }

    AppError::Other(format!(
        "Failed to {} downloaded {}: {}",
        when, error_label, error
    ))
}

async fn download_playlist_bytes(
    download_url: &Url,
    error_label: &str,
    connect_timeout: Duration,
    timeout: Duration,
    max_bytes: u64,
    cache_metadata: Option<&RemotePlaylistCacheMetadata>,
) -> Result<PlaylistDownloadResult, AppError> {
    use futures::StreamExt;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(connect_timeout)
        .timeout(timeout)
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| {
            AppError::Other(format!(
                "Failed to initialize HTTP client for {}: {}",
                error_label, error
            ))
        })?;
    let mut request = client
        .get(download_url.clone())
        .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT);
    if let Some(metadata) = cache_metadata {
        if let Some(ref etag) = metadata.etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        if let Some(ref last_modified) = metadata.last_modified {
            request = request.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|error| map_download_error(error, error_label, timeout, "request"))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(PlaylistDownloadResult::NotModified);
    }
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "Failed to download {}: HTTP {}",
            error_label, status
        )));
    }

    let metadata = RemotePlaylistCacheMetadata {
        etag: response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        last_modified: response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
    };

    let mut bytes = Vec::new();
    let mut total = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result
            .map_err(|error| map_download_error(error, error_label, timeout, "read"))?;
        total = total.saturating_add(chunk.len() as u64);
        if total > max_bytes {
            return Err(AppError::Other(format!(
                "Downloaded {} exceeds the maximum allowed size ({} MiB)",
                error_label,
                max_bytes / (1024 * 1024)
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(PlaylistDownloadResult::Updated { bytes, metadata })
}

async fn download_playlist_to_cache(
    cache_path: std::path::PathBuf,
    download_url: &Url,
    error_label: &str,
) -> Result<String, AppError> {
    let metadata = load_cache_metadata(&cache_path);
    let download = download_playlist_bytes(
        download_url,
        error_label,
        PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT,
        PLAYLIST_DOWNLOAD_TIMEOUT,
        PLAYLIST_DOWNLOAD_MAX_BYTES,
        metadata.as_ref(),
    )
    .await?;

    let (bytes, response_metadata) = match download {
        PlaylistDownloadResult::NotModified => {
            if cache_path.exists() {
                return Ok(cache_path.to_string_lossy().to_string());
            }
            match download_playlist_bytes(
                download_url,
                error_label,
                PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT,
                PLAYLIST_DOWNLOAD_TIMEOUT,
                PLAYLIST_DOWNLOAD_MAX_BYTES,
                None,
            )
            .await?
            {
                PlaylistDownloadResult::NotModified => {
                    return Err(AppError::Other(format!(
                        "Server returned 304 for {}, but cache file is missing",
                        error_label
                    )));
                }
                PlaylistDownloadResult::Updated { bytes, metadata } => (bytes, metadata),
            }
        }
        PlaylistDownloadResult::Updated { bytes, metadata } => (bytes, metadata),
    };

    cleanup_stale_cache_temp_files(&cache_path);
    let tmp_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = cache_path.with_file_name(format!(
        "{}.{}.tmp",
        cache_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "playlist.m3u8".to_string()),
        tmp_suffix
    ));

    let persist_result = (|| -> Result<(), AppError> {
        std::fs::write(&tmp_path, &bytes).map_err(AppError::Io)?;

        match std::fs::rename(&tmp_path, &cache_path) {
            Ok(()) => {}
            Err(first_error) => {
                if cache_path.exists() {
                    std::fs::remove_file(&cache_path).map_err(AppError::Io)?;
                    std::fs::rename(&tmp_path, &cache_path).map_err(AppError::Io)?;
                } else {
                    return Err(AppError::Io(first_error));
                }
            }
        }
        Ok(())
    })();

    if let Err(error) = persist_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }
    if let Err(error) = save_cache_metadata(&cache_path, &response_metadata) {
        log::warn!(
            "Failed to persist remote playlist cache metadata for {}: {}",
            cache_path.to_string_lossy(),
            error
        );
    }

    Ok(cache_path.to_string_lossy().to_string())
}

async fn download_playlist_to_cache_in_data_dir(
    data_dir: &std::path::Path,
    source_key: &str,
    download_url: &Url,
    error_label: &str,
) -> Result<String, AppError> {
    let cache_path = remote_playlist_cache_path_from_data_dir(data_dir, source_key)?;
    download_playlist_to_cache(cache_path, download_url, error_label).await
}

fn normalize_xtream_server(server: &str) -> Result<Url, AppError> {
    let mut parsed = parse_http_url(server, "Invalid Xtream server URL")?;
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid Xtream server URL: missing host".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Parse(
            "Xtream server URL must not include credentials".to_string(),
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::Parse(
            "Xtream server URL must not include query parameters or fragments".to_string(),
        ));
    }

    let path = parsed.path().trim_end_matches('/');
    let normalized_path = if path.is_empty() || path == "/get.php" {
        "/".to_string()
    } else if path.to_ascii_lowercase().ends_with("/get.php") {
        let base = &path[..path.len() - "/get.php".len()];
        if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        }
    } else {
        path.to_string()
    };
    parsed.set_path(&normalized_path);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

fn xtream_server_identity(server: &Url) -> String {
    let mut cleaned = server.clone();
    let _ = cleaned.set_username("");
    let _ = cleaned.set_password(None);
    cleaned.set_query(None);
    cleaned.set_fragment(None);
    cleaned.to_string().trim_end_matches('/').to_string()
}

fn build_xtream_download_url(server: &Url, username: &str, password: &str) -> Url {
    let mut playlist_url = server.clone();
    let mut endpoint_path = playlist_url.path().trim_end_matches('/').to_string();
    if endpoint_path.is_empty() || endpoint_path == "/" {
        endpoint_path = "/get.php".to_string();
    } else {
        endpoint_path.push_str("/get.php");
    }
    playlist_url.set_path(&endpoint_path);
    playlist_url.set_query(None);
    playlist_url.set_fragment(None);
    playlist_url
        .query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password)
        .append_pair("type", "m3u_plus")
        .append_pair("output", "ts");
    playlist_url
}

fn build_xtream_player_api_url(server: &Url, username: &str, password: &str) -> Url {
    let mut api_url = server.clone();
    let mut endpoint_path = api_url.path().trim_end_matches('/').to_string();
    if endpoint_path.is_empty() || endpoint_path == "/" {
        endpoint_path = "/player_api.php".to_string();
    } else {
        endpoint_path.push_str("/player_api.php");
    }
    api_url.set_path(&endpoint_path);
    api_url.set_query(None);
    api_url.set_fragment(None);
    api_url
        .query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password);
    api_url
}

fn build_xtream_player_api_action_url(
    server: &Url,
    username: &str,
    password: &str,
    action: &str,
) -> Url {
    let mut api_url = build_xtream_player_api_url(server, username, password);
    api_url.query_pairs_mut().append_pair("action", action);
    api_url
}

fn build_xtream_source_key(server: &Url, username: &str) -> String {
    format!(
        "xtream:{}|{}|m3u_plus|ts",
        xtream_server_identity(server),
        username
    )
}

fn parse_max_connections_value(value: &serde_json::Value) -> Option<u32> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().and_then(|value| {
            if value == 0 {
                None
            } else {
                u32::try_from(value).ok()
            }
        }),
        serde_json::Value::String(raw) => {
            let parsed = raw.trim().parse::<u32>().ok()?;
            (parsed > 0).then_some(parsed)
        }
        _ => None,
    }
}

fn parse_bool_like(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::Number(number) => number.as_i64().map(|raw| raw != 0),
        serde_json::Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = trimmed.parse::<i64>() {
                return Some(parsed != 0);
            }
            match trimmed.to_ascii_lowercase().as_str() {
                "true" | "yes" | "active" => Some(true),
                "false" | "no" | "inactive" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn parse_epoch_value(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().filter(|epoch| *epoch > 0),
        serde_json::Value::String(raw) => raw.trim().parse::<u64>().ok().filter(|epoch| *epoch > 0),
        _ => None,
    }
}

fn parse_optional_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(ToString::to_string)
}

fn extract_xtream_account_info(payload: &serde_json::Value) -> Option<XtreamAccountInfo> {
    let user = payload.get("user_info").unwrap_or(payload);
    let info = XtreamAccountInfo {
        status: parse_optional_string(user.get("status")),
        expires_at_epoch: user
            .get("exp_date")
            .and_then(parse_epoch_value)
            .or_else(|| user.get("expiration").and_then(parse_epoch_value)),
        created_at_epoch: user.get("created_at").and_then(parse_epoch_value),
        is_trial: user.get("is_trial").and_then(parse_bool_like),
        active_connections: user
            .get("active_cons")
            .and_then(parse_max_connections_value),
        max_connections: user
            .get("max_connections")
            .and_then(parse_max_connections_value),
    };

    let has_any = info.status.is_some()
        || info.expires_at_epoch.is_some()
        || info.created_at_epoch.is_some()
        || info.is_trial.is_some()
        || info.active_connections.is_some()
        || info.max_connections.is_some();
    has_any.then_some(info)
}

#[cfg(test)]
fn extract_xtream_max_connections(payload: &serde_json::Value) -> Option<u32> {
    extract_xtream_account_info(payload)
        .and_then(|account| account.max_connections)
        .or_else(|| {
            payload
                .get("max_connections")
                .and_then(parse_max_connections_value)
        })
}

/// Timeout for the (potentially large) JSON stream list downloads.
const XTREAM_JSON_API_TIMEOUT: Duration = Duration::from_secs(60);

/// Build an M3U playlist from the Xtream JSON API (`get_live_categories` +
/// `get_live_streams`).  This is the fallback when `/get.php` is blocked.
async fn fetch_xtream_playlist_via_json_api(
    server: &Url,
    username: &str,
    password: &str,
) -> Result<Vec<u8>, AppError> {
    let categories_url =
        build_xtream_player_api_action_url(server, username, password, "get_live_categories");
    let streams_url =
        build_xtream_player_api_action_url(server, username, password, "get_live_streams");

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_JSON_API_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {}", e)))?;

    let (cats_resp, streams_resp) = tokio::join!(
        client
            .get(categories_url)
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .send(),
        client
            .get(streams_url)
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .send(),
    );

    let cats_resp = cats_resp.map_err(|e| {
        AppError::Other(format!("Failed to fetch Xtream categories: {}", e))
    })?;
    let streams_resp = streams_resp.map_err(|e| {
        AppError::Other(format!("Failed to fetch Xtream live streams: {}", e))
    })?;

    if !cats_resp.status().is_success() {
        return Err(AppError::Other(format!(
            "Xtream categories API returned HTTP {}",
            cats_resp.status()
        )));
    }
    if !streams_resp.status().is_success() {
        return Err(AppError::Other(format!(
            "Xtream live streams API returned HTTP {}",
            streams_resp.status()
        )));
    }

    let cats_bytes = cats_resp.bytes().await.map_err(|e| {
        AppError::Other(format!("Failed to read Xtream categories response: {}", e))
    })?;
    let streams_bytes = streams_resp.bytes().await.map_err(|e| {
        AppError::Other(format!("Failed to read Xtream live streams response: {}", e))
    })?;

    let categories: Vec<serde_json::Value> =
        serde_json::from_slice(&cats_bytes).unwrap_or_default();
    let streams: Vec<serde_json::Value> = serde_json::from_slice(&streams_bytes)
        .map_err(|e| AppError::Parse(format!("Failed to parse Xtream live streams JSON: {}", e)))?;

    if streams.is_empty() {
        return Err(AppError::Other(
            "Xtream server returned an empty channel list".to_string(),
        ));
    }

    // Build a category_id -> category_name lookup.
    let cat_map: HashMap<String, String> = categories
        .iter()
        .filter_map(|cat| {
            let id = cat.get("category_id")?.as_str()?.to_string();
            let name = cat.get("category_name")?.as_str()?.to_string();
            Some((id, name))
        })
        .collect();

    // Derive the base stream URL: http(s)://server/live/username/password/
    let stream_base = {
        let mut base = server.clone();
        let mut path = base.path().trim_end_matches('/').to_string();
        path.push_str(&format!("/live/{}/{}/", username, password));
        base.set_path(&path);
        base.set_query(None);
        base.set_fragment(None);
        base.to_string()
    };

    let mut m3u = String::with_capacity(streams.len() * 200);
    m3u.push_str("#EXTM3U\n");

    for entry in &streams {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let stream_id = match entry.get("stream_id") {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => continue,
        };
        let tvg_id = entry
            .get("epg_channel_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let tvg_logo = entry
            .get("stream_icon")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let group = entry
            .get("category_id")
            .and_then(|v| v.as_str())
            .and_then(|id| cat_map.get(id))
            .map(|s| s.as_str())
            .unwrap_or("");

        m3u.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{}\" tvg-logo=\"{}\" group-title=\"{}\",{}\n",
            tvg_id, tvg_logo, group, name
        ));
        m3u.push_str(&format!("{}{}.ts\n", stream_base, stream_id));
    }

    log::info!(
        "Built M3U from Xtream JSON API: {} channels",
        streams.len()
    );

    Ok(m3u.into_bytes())
}

/// Write raw bytes to the playlist cache, using the same atomic-rename
/// strategy as `download_playlist_to_cache`.
fn write_bytes_to_cache(cache_path: &std::path::Path, bytes: &[u8]) -> Result<(), AppError> {
    cleanup_stale_cache_temp_files(cache_path);
    let tmp_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = cache_path.with_file_name(format!(
        "{}.{}.tmp",
        cache_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "playlist.m3u8".to_string()),
        tmp_suffix
    ));

    let result = (|| -> Result<(), AppError> {
        std::fs::write(&tmp_path, bytes).map_err(AppError::Io)?;
        match std::fs::rename(&tmp_path, cache_path) {
            Ok(()) => {}
            Err(first_error) => {
                if cache_path.exists() {
                    std::fs::remove_file(cache_path).map_err(AppError::Io)?;
                    std::fs::rename(&tmp_path, cache_path).map_err(AppError::Io)?;
                } else {
                    return Err(AppError::Io(first_error));
                }
            }
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

async fn fetch_xtream_account_info(
    server: &Url,
    username: &str,
    password: &str,
) -> Option<XtreamAccountInfo> {
    let api_url = build_xtream_player_api_url(server, username, password);
    let account_info_url =
        build_xtream_player_api_action_url(server, username, password, "get_account_info");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_PLAYER_API_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    for endpoint in [account_info_url, api_url.clone()] {
        let response = client
            .get(endpoint.clone())
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .send()
            .await
            .ok()?;

        if !response.status().is_success() {
            log::debug!(
                "Xtream player_api request returned HTTP {} for {}",
                response.status(),
                endpoint
            );
            continue;
        }

        let payload_bytes = response.bytes().await.ok()?;
        let payload = serde_json::from_slice::<serde_json::Value>(&payload_bytes).ok()?;
        if let Some(info) = extract_xtream_account_info(&payload) {
            return Some(info);
        }
    }

    None
}

fn normalize_stalker_portal(portal: &str) -> Result<Url, AppError> {
    let mut parsed = parse_http_url(portal, "Invalid Stalker portal URL")?;
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid Stalker portal URL: missing host".to_string(),
        ));
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let normalized_path = {
        let trimmed = parsed.path().trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    };
    parsed.set_path(&normalized_path);
    Ok(parsed)
}

fn normalize_stalker_mac(mac: &str) -> Result<String, AppError> {
    let hex_only = mac
        .chars()
        .filter(|value| value.is_ascii_hexdigit())
        .collect::<String>();
    if hex_only.len() != 12 {
        return Err(AppError::Parse(
            "Invalid MAC address: expected 12 hexadecimal characters".to_string(),
        ));
    }
    let upper = hex_only.to_ascii_uppercase();
    Ok(format!(
        "{}:{}:{}:{}:{}:{}",
        &upper[0..2],
        &upper[2..4],
        &upper[4..6],
        &upper[6..8],
        &upper[8..10],
        &upper[10..12]
    ))
}

fn append_stalker_endpoint(base: &Url, suffix: &str) -> Url {
    let mut endpoint = base.clone();
    let base_path = base.path().trim_end_matches('/');
    let full_path = if base_path.is_empty() {
        suffix.to_string()
    } else {
        format!("{}{}", base_path, suffix)
    };
    endpoint.set_path(&full_path);
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    endpoint
}

fn build_stalker_endpoint_candidates(portal: &Url) -> Vec<Url> {
    let mut candidates = Vec::<Url>::new();
    let mut push_unique = |candidate: Url| {
        if candidates.iter().any(|existing| existing == &candidate) {
            return;
        }
        candidates.push(candidate);
    };

    let raw_path = portal.path().trim_end_matches('/');
    let endpoint_suffixes = ["/portal.php", "/server/load.php"];

    if raw_path.ends_with("/portal.php") || raw_path.ends_with("/server/load.php") {
        push_unique(portal.clone());
        let base_path = raw_path
            .strip_suffix("/portal.php")
            .or_else(|| raw_path.strip_suffix("/server/load.php"))
            .unwrap_or(raw_path);
        let mut base = portal.clone();
        if base_path.is_empty() {
            base.set_path("/");
        } else {
            base.set_path(base_path);
        }
        for suffix in endpoint_suffixes {
            push_unique(append_stalker_endpoint(&base, suffix));
        }
        return candidates;
    }

    for suffix in endpoint_suffixes {
        push_unique(append_stalker_endpoint(portal, suffix));
    }
    candidates
}

fn value_to_non_empty_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn value_field_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(field) = value.get(*key) {
            if let Some(parsed) = value_to_non_empty_string(field) {
                return Some(parsed);
            }
        }
    }
    None
}

fn extract_stalker_items(payload: &serde_json::Value) -> Vec<serde_json::Value> {
    let root = payload.get("js").unwrap_or(payload);
    if let Some(array) = root.as_array() {
        return array.clone();
    }
    for key in ["data", "results", "items", "channels"] {
        if let Some(array) = root.get(key).and_then(|value| value.as_array()) {
            return array.clone();
        }
    }
    Vec::new()
}

fn extract_stalker_stream_url(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    for token in trimmed.split_whitespace() {
        let candidate = token
            .trim_matches(|value| value == '"' || value == '\'' || value == ';' || value == ',');
        if candidate.contains("://") {
            return Some(candidate.to_string());
        }
    }

    if trimmed.contains("://") {
        return Some(trimmed.to_string());
    }

    None
}

fn escape_extinf_attribute(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn stalker_referer(endpoint: &Url) -> String {
    let path = endpoint.path().trim_end_matches('/');
    let base_path = path
        .strip_suffix("/portal.php")
        .or_else(|| path.strip_suffix("/server/load.php"))
        .unwrap_or(path);
    let referer_path = if base_path.is_empty() {
        "/c/".to_string()
    } else {
        format!("{}/c/", base_path.trim_end_matches('/'))
    };

    let mut referer = endpoint.clone();
    referer.set_path(&referer_path);
    referer.set_query(None);
    referer.set_fragment(None);
    referer.to_string()
}

fn build_stalker_headers(
    endpoint: &Url,
    mac: &str,
    token: Option<&str>,
) -> Result<reqwest::header::HeaderMap, AppError> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(STALKER_USER_AGENT),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("x-user-agent"),
        reqwest::header::HeaderValue::from_static(STALKER_X_USER_AGENT),
    );

    let cookie_value = format!("mac={}; stb_lang=en; timezone=GMT", mac);
    headers.insert(
        reqwest::header::COOKIE,
        reqwest::header::HeaderValue::from_str(&cookie_value).map_err(|error| {
            AppError::Other(format!("Failed to build Stalker cookie header: {}", error))
        })?,
    );

    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_str(&stalker_referer(endpoint)).map_err(|error| {
            AppError::Other(format!("Failed to build Stalker referer header: {}", error))
        })?,
    );

    if let Some(value) = token {
        let auth_value = format!("Bearer {}", value);
        headers.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&auth_value).map_err(|error| {
                AppError::Other(format!(
                    "Failed to build Stalker authorization header: {}",
                    error
                ))
            })?,
        );
    }

    Ok(headers)
}

async fn stalker_request_json(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: Option<&str>,
    query: &[(&str, &str)],
) -> Result<serde_json::Value, AppError> {
    let mut request_url = endpoint.clone();
    {
        let mut query_pairs = request_url.query_pairs_mut();
        query_pairs.clear();
        for (key, value) in query {
            query_pairs.append_pair(key, value);
        }
    }

    let response = client
        .get(request_url)
        .headers(build_stalker_headers(endpoint, mac, token)?)
        .send()
        .await
        .map_err(|error| AppError::Other(format!("Stalker request failed: {}", error)))?;

    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "Stalker endpoint returned HTTP {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Other(format!("Failed to read Stalker response: {}", error)))?;
    serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|error| {
        AppError::Parse(format!(
            "Failed to parse Stalker response JSON at {}: {}",
            endpoint, error
        ))
    })
}

async fn fetch_stalker_token(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
) -> Result<String, AppError> {
    let payload = stalker_request_json(
        client,
        endpoint,
        mac,
        None,
        &[
            ("type", "stb"),
            ("action", "handshake"),
            ("token", ""),
            ("JsHttpRequest", "1-xml"),
        ],
    )
    .await?;

    let root = payload.get("js").unwrap_or(&payload);
    value_field_string(root, &["token"]).ok_or_else(|| {
        AppError::Other("Stalker handshake succeeded but no token was returned".to_string())
    })
}

async fn fetch_stalker_genres(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: &str,
) -> HashMap<String, String> {
    let payload = match stalker_request_json(
        client,
        endpoint,
        mac,
        Some(token),
        &[
            ("type", "itv"),
            ("action", "get_genres"),
            ("JsHttpRequest", "1-xml"),
        ],
    )
    .await
    {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut out = HashMap::new();
    for item in extract_stalker_items(&payload) {
        let Some(id) = value_field_string(&item, &["id", "genre_id", "category_id"]) else {
            continue;
        };
        let Some(title) = value_field_string(&item, &["title", "name"]) else {
            continue;
        };
        out.insert(id, title);
    }
    out
}

async fn fetch_stalker_channels(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: &str,
) -> Result<Vec<serde_json::Value>, AppError> {
    let requests: [&[(&str, &str)]; 2] = [
        &[
            ("type", "itv"),
            ("action", "get_all_channels"),
            ("JsHttpRequest", "1-xml"),
        ],
        &[
            ("type", "itv"),
            ("action", "get_ordered_list"),
            ("genre", "*"),
            ("force_ch_link_check", ""),
            ("JsHttpRequest", "1-xml"),
        ],
    ];

    let mut last_error: Option<String> = None;
    for request in requests {
        match stalker_request_json(client, endpoint, mac, Some(token), request).await {
            Ok(payload) => {
                let items = extract_stalker_items(&payload);
                if !items.is_empty() {
                    return Ok(items);
                }
                last_error = Some("response returned no channels".to_string());
            }
            Err(error) => {
                last_error = Some(error.to_string());
            }
        }
    }

    Err(AppError::Other(format!(
        "Failed to fetch channels from Stalker endpoint {}: {}",
        endpoint,
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )))
}

fn compile_search_pattern(channel_search: &Option<String>) -> Result<Option<Regex>, AppError> {
    if let Some(search) = channel_search.as_ref() {
        return Ok(Some(Regex::new(&format!("(?i){}", search)).map_err(
            |error| AppError::Parse(format!("Invalid regex '{}': {}", search, error)),
        )?));
    }
    Ok(None)
}

fn content_type_totals(channels: &[Channel]) -> (usize, usize, usize) {
    let mut live = 0usize;
    let mut movie = 0usize;
    let mut series = 0usize;

    for channel in channels {
        match channel.content_type {
            ContentType::Live => live += 1,
            ContentType::Movie => movie += 1,
            ContentType::Series => series += 1,
        }
    }

    (live, movie, series)
}

fn build_stalker_preview(
    portal: &Url,
    mac: &str,
    channels_payload: Vec<serde_json::Value>,
    genres_by_id: &HashMap<String, String>,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let pattern = compile_search_pattern(channel_search)?;
    let mut groups = BTreeSet::<String>::new();
    let mut channels = Vec::<Channel>::new();
    let mut source_index = 0usize;

    for item in channels_payload {
        let Some(raw_name) = value_field_string(&item, &["name", "title", "display_name"]) else {
            continue;
        };
        let Some(raw_command) = value_field_string(&item, &["cmd", "stream_url", "url"]) else {
            continue;
        };
        let Some(stream_url) = extract_stalker_stream_url(&raw_command) else {
            continue;
        };

        let group = value_field_string(
            &item,
            &[
                "tv_genre_title",
                "genre_title",
                "category_name",
                "group",
                "group_title",
            ],
        )
        .or_else(|| {
            let genre_id = value_field_string(&item, &["tv_genre_id", "genre_id", "category_id"])?;
            genres_by_id.get(&genre_id).cloned()
        })
        .unwrap_or_else(|| "Unknown Group".to_string());
        groups.insert(group.clone());

        let include_group = if let Some(selected_group) = group_filter {
            group.trim().eq_ignore_ascii_case(selected_group.trim())
        } else {
            true
        };
        let include_search = if let Some(ref regex) = pattern {
            regex.is_match(&raw_name)
        } else {
            true
        };

        let channel_id = value_field_string(&item, &["id", "ch_id", "channel_id"])
            .unwrap_or_else(|| format!("stalker-{}", source_index));
        let extinf_line = format!(
            "#EXTINF:-1 tvg-id=\"{}\" group-title=\"{}\",{}",
            escape_extinf_attribute(&channel_id),
            escape_extinf_attribute(&group),
            raw_name
        );

        if include_group && include_search {
            let language = parser::detect_channel_language(&group, &raw_name, &extinf_line);
            let (tvg_id, tvg_name, tvg_logo, tvg_chno) = parser::extract_tvg_metadata(&extinf_line);
            let content_type = ContentType::detect_from_url(&stream_url);
            channels.push(Channel {
                index: source_index,
                playlist: portal
                    .host_str()
                    .map(|host| format!("Stalker {}", host))
                    .unwrap_or_else(|| "Stalker Portal".to_string()),
                name: raw_name,
                group,
                language,
                tvg_id,
                tvg_name,
                tvg_logo,
                tvg_chno,
                url: stream_url,
                content_type,
                extinf_line,
                metadata_lines: Vec::new(),
            });
        }

        source_index += 1;
    }

    let (live_count, movie_count, series_count) = content_type_totals(&channels);
    Ok(PlaylistPreview {
        file_path: portal.to_string(),
        file_name: portal
            .host_str()
            .map(|host| format!("Stalker {}", host))
            .unwrap_or_else(|| "Stalker Portal".to_string()),
        source_identity: Some(format!(
            "stalker:{}|{}",
            normalize_url_identity(portal).trim_end_matches('/'),
            mac.to_ascii_lowercase()
        )),
        server_location: None,
        xtream_max_connections: None,
        xtream_account_info: None,
        total_channels: channels.len(),
        live_count,
        movie_count,
        series_count,
        groups: groups.into_iter().collect(),
        channels,
    })
}

#[tauri::command]
pub async fn open_playlist_stalker(
    source: StalkerOpenRequest,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let portal = normalize_stalker_portal(&source.portal)?;
    let mac = normalize_stalker_mac(&source.mac)?;
    let endpoints = build_stalker_endpoint_candidates(&portal);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(STALKER_API_TIMEOUT)
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

        populate_server_location(&mut preview).await;
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
    path: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let mut preview = parser::parse_playlist(&path, &group_filter, &channel_search)?;
    populate_server_location(&mut preview).await;
    Ok(preview)
}

#[tauri::command]
pub async fn open_playlist_url(
    app: tauri::AppHandle,
    url: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let data_dir = app_data_dir(&app)?;
    open_playlist_url_from_data_dir(&data_dir, &url, group_filter, channel_search).await
}

pub(crate) async fn open_playlist_url_from_data_dir(
    data_dir: &std::path::Path,
    url: &str,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let mut parsed = parse_http_url(url.trim(), "Invalid playlist URL")?;
    parsed.set_fragment(None);
    let normalized_identity = normalize_url_identity(&parsed);
    let source_key = format!("url:{}", normalized_identity);
    let cached_path =
        download_playlist_to_cache_in_data_dir(data_dir, &source_key, &parsed, "playlist URL")
            .await?;
    let mut preview = parser::parse_playlist(&cached_path, &group_filter, &channel_search)?;
    preview.source_identity = Some(format!("url:{}", normalized_identity));
    populate_server_location(&mut preview).await;
    Ok(preview)
}

#[tauri::command]
pub async fn open_playlist_xtream(
    app: tauri::AppHandle,
    source: XtreamOpenRequest,
    group_filter: Option<String>,
    channel_search: Option<String>,
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
    let data_dir = app_data_dir(&app)?;
    let cache_path = remote_playlist_cache_path_from_data_dir(&data_dir, &source_key)?;

    // Try /get.php and account info in parallel.
    let (xtream_account_info, m3u_result) = tokio::join!(
        fetch_xtream_account_info(&server, &username, &password),
        download_playlist_to_cache_in_data_dir(
            &data_dir,
            &source_key,
            &download_url,
            "Xtream playlist",
        )
    );

    // If /get.php failed, fall back to the JSON API.
    let cached_path = match m3u_result {
        Ok(path) => path,
        Err(get_php_error) => {
            log::info!(
                "Xtream /get.php download failed ({}), falling back to JSON API",
                get_php_error
            );
            let m3u_bytes =
                fetch_xtream_playlist_via_json_api(&server, &username, &password).await?;
            write_bytes_to_cache(&cache_path, &m3u_bytes)?;
            cache_path.to_string_lossy().to_string()
        }
    };

    let mut preview = parser::parse_playlist(&cached_path, &group_filter, &channel_search)?;
    preview.source_identity = Some(source_key);
    preview.xtream_max_connections = xtream_account_info
        .as_ref()
        .and_then(|account| account.max_connections);
    preview.xtream_account_info = xtream_account_info;
    populate_server_location(&mut preview).await;
    Ok(preview)
}

// --- Xtream Server Tester ---

const SERVER_TEST_FFPROBE_TIMEOUT: Duration = Duration::from_secs(8);
const SERVER_TEST_STREAM_TIMEOUT: Duration = Duration::from_secs(10);
const SERVER_TEST_MAX_CHANNEL_CANDIDATES: usize = 50;
const SERVER_TEST_TARGET_WORKING_CHANNELS: usize = 5;

#[derive(Debug, Clone, Serialize)]
pub struct XtreamChannelProbe {
    pub stream_id: String,
    pub latency_ms: Option<u64>,
    pub resolved_url: Option<String>,
    pub codec: Option<String>,
    pub resolution: Option<String>,
    pub fps: Option<u32>,
    pub screenshot: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct XtreamServerTestResult {
    pub server: String,
    pub success: bool,
    pub api_latency_ms: Option<u64>,
    pub avg_stream_latency_ms: Option<u64>,
    pub resolved_host: Option<String>,
    pub channel_probes: Vec<XtreamChannelProbe>,
    pub error: Option<String>,
    pub account_status: Option<String>,
    pub max_connections: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct XtreamServerTestReport {
    pub results: Vec<XtreamServerTestResult>,
    pub same_cdn: bool,
    pub channels_probed: u32,
}

fn build_xtream_stream_url(server: &Url, username: &str, password: &str, stream_id: &str) -> String {
    let mut base = server.clone();
    let mut path = base.path().trim_end_matches('/').to_string();
    path.push_str(&format!("/live/{}/{}/{}.ts", username, password, stream_id));
    base.set_path(&path);
    base.set_query(None);
    base.set_fragment(None);
    base.to_string()
}

async fn fetch_xtream_stream_ids(
    server: &Url,
    username: &str,
    password: &str,
) -> Result<Vec<String>, AppError> {
    let streams_url =
        build_xtream_player_api_action_url(server, username, password, "get_live_streams");

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_JSON_API_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {}", e)))?;

    let response = client
        .get(streams_url)
        .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Failed to fetch live streams: {}", e)))?;

    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "Live streams API returned HTTP {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("Failed to read live streams response: {}", e)))?;

    let streams: Vec<serde_json::Value> = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Parse(format!("Failed to parse live streams JSON: {}", e)))?;

    let ids: Vec<String> = streams
        .iter()
        .filter_map(|entry| match entry.get("stream_id") {
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            _ => None,
        })
        .collect();

    Ok(ids)
}

async fn discover_working_channels(
    app: &tauri::AppHandle,
    server: &Url,
    username: &str,
    password: &str,
) -> Result<Vec<String>, AppError> {
    use crate::engine::checker::is_placeholder_url;

    let mut ids = fetch_xtream_stream_ids(server, username, password).await?;
    if ids.is_empty() {
        return Err(AppError::Other(
            "Server returned no live streams".to_string(),
        ));
    }

    ids.shuffle(&mut rand::rng());

    let cancel = CancellationToken::new();
    let http_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(SERVER_TEST_STREAM_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
        .ok();

    let mut working = Vec::new();
    let limit = ids.len().min(SERVER_TEST_MAX_CHANNEL_CANDIDATES);

    for stream_id in ids.iter().take(limit) {
        let stream_url = build_xtream_stream_url(server, username, password, stream_id);

        // Check for placeholder via HTTP redirect before running ffprobe
        if let Some(ref client) = http_client {
            match client
                .get(&stream_url)
                .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
                .send()
                .await
            {
                Ok(resp) => {
                    let final_url = resp.url().to_string();
                    if is_placeholder_url(&final_url) {
                        log::debug!("Skipping placeholder channel {}: {}", stream_id, final_url);
                        continue;
                    }
                }
                Err(_) => continue,
            }
        }

        match ffmpeg::collect_probe_snapshot_with_timeout(
            app,
            &stream_url,
            &cancel,
            Some(SERVER_TEST_FFPROBE_TIMEOUT),
        )
        .await
        {
            Ok(snapshot) => {
                if snapshot.video_info.is_some() {
                    working.push(stream_id.clone());
                    if working.len() >= SERVER_TEST_TARGET_WORKING_CHANNELS {
                        break;
                    }
                }
            }
            Err(_) => continue,
        }
    }

    if working.is_empty() {
        return Err(AppError::Other(
            "Could not find any working channels to probe".to_string(),
        ));
    }

    Ok(working)
}

fn read_file_as_base64_data_uri(path: &std::path::Path) -> Option<String> {
    use base64::Engine;
    let bytes = std::fs::read(path).ok()?;
    let mime = match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

async fn probe_server_channels(
    app: &tauri::AppHandle,
    server: &Url,
    username: &str,
    password: &str,
    stream_ids: &[String],
    screenshot_dir: &std::path::Path,
) -> Vec<XtreamChannelProbe> {
    let cancel = CancellationToken::new();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(SERVER_TEST_STREAM_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let server_host = server.host_str().unwrap_or("unknown");
    let mut probes = Vec::new();

    for stream_id in stream_ids {
        let stream_url = build_xtream_stream_url(server, username, password, stream_id);

        // Measure TTFB + get resolved URL
        let started = Instant::now();
        let http_result = client
            .get(&stream_url)
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .send()
            .await;

        let (latency_ms, resolved_url) = match http_result {
            Ok(resp) => {
                let ttfb = started.elapsed().as_millis() as u64;
                let final_url = resp.url().to_string();
                (Some(ttfb), Some(final_url))
            }
            Err(_) => (None, None),
        };

        // Run ffprobe for codec/resolution/FPS
        let (codec, resolution, fps) =
            match ffmpeg::collect_probe_snapshot_with_timeout(
                app,
                &stream_url,
                &cancel,
                Some(SERVER_TEST_FFPROBE_TIMEOUT),
            )
            .await
            {
                Ok(snapshot) => {
                    if let Some(video) = snapshot.video_info {
                        (
                            Some(video.codec),
                            Some(video.resolution),
                            video.fps,
                        )
                    } else {
                        (None, None, None)
                    }
                }
                Err(_) => (None, None, None),
            };

        // Capture screenshot
        let file_name = format!("{}-{}", server_host, stream_id);
        let screenshot = match ffmpeg::capture_screenshot(
            app,
            &stream_url,
            &screenshot_dir.to_string_lossy(),
            &file_name,
            PLAYLIST_DOWNLOAD_USER_AGENT,
            crate::models::settings::ScreenshotFormat::Webp,
            &cancel,
        )
        .await
        {
            Ok(path) => read_file_as_base64_data_uri(std::path::Path::new(&path)),
            Err(e) => {
                log::debug!("Screenshot failed for {} on {}: {}", stream_id, server_host, e);
                None
            }
        };

        probes.push(XtreamChannelProbe {
            stream_id: stream_id.clone(),
            latency_ms,
            resolved_url,
            codec,
            resolution,
            fps,
            screenshot,
        });
    }

    probes
}

async fn test_single_server_api(
    server: &Url,
    username: &str,
    password: &str,
) -> (Option<u64>, Option<String>, Option<u32>, Option<String>) {
    let api_url = build_xtream_player_api_url(server, username, password);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_PLAYER_API_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => return (None, None, None, Some(e.to_string())),
    };

    let started = Instant::now();
    let response = client
        .get(api_url)
        .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
        .send()
        .await;

    match response {
        Ok(resp) => {
            let latency = started.elapsed().as_millis() as u64;
            if !resp.status().is_success() {
                return (
                    Some(latency),
                    None,
                    None,
                    Some(format!("HTTP {}", resp.status())),
                );
            }
            let bytes = resp.bytes().await.ok();
            let (status, max_conn) = bytes
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|payload| {
                    extract_xtream_account_info(&payload).map(|info| {
                        (
                            info.status.clone(),
                            info.max_connections,
                        )
                    })
                })
                .unwrap_or((None, None));
            (Some(latency), status, max_conn, None)
        }
        Err(e) => (None, None, None, Some(e.to_string())),
    }
}

fn extract_host_from_url(url_str: &str) -> Option<String> {
    Url::parse(url_str).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

fn most_common_resolved_host(probes: &[XtreamChannelProbe]) -> Option<String> {
    let mut counts = HashMap::<String, usize>::new();
    for probe in probes {
        if let Some(ref resolved) = probe.resolved_url {
            if let Some(host) = extract_host_from_url(resolved) {
                *counts.entry(host).or_insert(0) += 1;
            }
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(host, _)| host)
}

fn detect_same_cdn(results: &[XtreamServerTestResult]) -> bool {
    let mut all_hosts = HashSet::new();
    for result in results {
        for probe in &result.channel_probes {
            if let Some(ref resolved) = probe.resolved_url {
                if let Some(host) = extract_host_from_url(resolved) {
                    all_hosts.insert(host);
                }
            }
        }
    }
    all_hosts.len() <= 1
}

#[tauri::command]
pub async fn test_xtream_servers(
    app: tauri::AppHandle,
    servers: Vec<String>,
    username: String,
    password: String,
) -> Result<XtreamServerTestReport, AppError> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::Parse("Username cannot be empty".to_string()));
    }
    let password = password.trim().to_string();
    if password.is_empty() {
        return Err(AppError::Parse("Password cannot be empty".to_string()));
    }
    if servers.is_empty() {
        return Err(AppError::Parse("No servers provided".to_string()));
    }

    // Normalize all servers
    let normalized: Vec<(String, Url)> = servers
        .iter()
        .map(|s| {
            let url = normalize_xtream_server(s)?;
            Ok((s.clone(), url))
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    // Phase 1: API test (parallel)
    let api_futures: Vec<_> = normalized
        .iter()
        .map(|(raw, url)| {
            let url = url.clone();
            let u = username.clone();
            let p = password.clone();
            let raw = raw.clone();
            async move {
                let (api_latency, status, max_conn, error) =
                    test_single_server_api(&url, &u, &p).await;
                (raw, url, api_latency, status, max_conn, error)
            }
        })
        .collect();

    let api_results = futures::future::join_all(api_futures).await;

    // Phase 2: Discover working channels from the first successful server
    let first_successful = api_results
        .iter()
        .find(|(_, _, _, _, _, error)| error.is_none());

    let first_server = match first_successful {
        Some((_, url, ..)) => url.clone(),
        None => {
            // All failed — return results with errors
            let results: Vec<XtreamServerTestResult> = api_results
                .into_iter()
                .map(|(raw, _, api_latency, status, max_conn, error)| {
                    XtreamServerTestResult {
                        server: raw,
                        success: false,
                        api_latency_ms: api_latency,
                        avg_stream_latency_ms: None,
                        resolved_host: None,
                        channel_probes: Vec::new(),
                        error,
                        account_status: status,
                        max_connections: max_conn,
                    }
                })
                .collect();

            return Ok(XtreamServerTestReport {
                results,
                same_cdn: false,
                channels_probed: 0,
            });
        }
    };

    let working_channels =
        discover_working_channels(&app, &first_server, &username, &password).await?;
    let channels_probed = working_channels.len() as u32;

    // Create temp dir for screenshots
    let screenshot_dir = std::env::temp_dir().join(format!(
        "iptv-server-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let _ = std::fs::create_dir_all(&screenshot_dir);

    // Phase 3: Probe all servers (parallel across servers, sequential per server)
    let probe_futures: Vec<_> = api_results
        .into_iter()
        .map(|(raw, url, api_latency, status, max_conn, api_error)| {
            let app = app.clone();
            let u = username.clone();
            let p = password.clone();
            let channels = working_channels.clone();
            let ss_dir = screenshot_dir.clone();
            async move {
                if api_error.is_some() {
                    return XtreamServerTestResult {
                        server: raw,
                        success: false,
                        api_latency_ms: api_latency,
                        avg_stream_latency_ms: None,
                        resolved_host: None,
                        channel_probes: Vec::new(),
                        error: api_error,
                        account_status: status,
                        max_connections: max_conn,
                    };
                }

                let probes = probe_server_channels(&app, &url, &u, &p, &channels, &ss_dir).await;
                let latencies: Vec<u64> = probes
                    .iter()
                    .filter_map(|p| p.latency_ms)
                    .collect();
                let avg_latency = if latencies.is_empty() {
                    None
                } else {
                    Some(latencies.iter().sum::<u64>() / latencies.len() as u64)
                };
                let resolved_host = most_common_resolved_host(&probes);

                XtreamServerTestResult {
                    server: raw,
                    success: true,
                    api_latency_ms: api_latency,
                    avg_stream_latency_ms: avg_latency,
                    resolved_host,
                    channel_probes: probes,
                    error: None,
                    account_status: status,
                    max_connections: max_conn,
                }
            }
        })
        .collect();

    let mut results = futures::future::join_all(probe_futures).await;

    // Phase 4: Analyze
    let same_cdn = detect_same_cdn(&results);

    // Sort: successful first, then by best resolution (quality), then by latency as tiebreaker.
    // Quality is determined by the max resolution height across probes.
    fn max_probe_height(result: &XtreamServerTestResult) -> u32 {
        result
            .channel_probes
            .iter()
            .filter_map(|p| {
                p.resolution.as_ref().and_then(|r| {
                    // Parse "1080p" -> 1080, "720p" -> 720, "WxH" -> H
                    r.trim_end_matches('p')
                        .parse::<u32>()
                        .ok()
                        .or_else(|| r.split('x').last()?.parse::<u32>().ok())
                })
            })
            .max()
            .unwrap_or(0)
    }

    results.sort_by(|a, b| {
        b.success.cmp(&a.success).then_with(|| {
            let a_quality = max_probe_height(a);
            let b_quality = max_probe_height(b);
            b_quality.cmp(&a_quality).then_with(|| {
                let a_stream = a.avg_stream_latency_ms.unwrap_or(u64::MAX);
                let b_stream = b.avg_stream_latency_ms.unwrap_or(u64::MAX);
                a_stream.cmp(&b_stream).then_with(|| {
                    let a_api = a.api_latency_ms.unwrap_or(u64::MAX);
                    let b_api = b.api_latency_ms.unwrap_or(u64::MAX);
                    a_api.cmp(&b_api)
                })
            })
        })
    });

    // Cleanup temp screenshot dir
    let _ = std::fs::remove_dir_all(&screenshot_dir);

    Ok(XtreamServerTestReport {
        results,
        same_cdn,
        channels_probed,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_stalker_endpoint_candidates, build_stalker_preview, build_xtream_download_url,
        build_xtream_player_api_action_url, build_xtream_player_api_url, build_xtream_source_key,
        cleanup_stale_cache_temp_files, dominant_channel_host, download_playlist_bytes,
        extract_stalker_stream_url, extract_xtream_account_info, extract_xtream_max_connections,
        normalize_stalker_mac, normalize_stalker_portal, normalize_url_identity,
        normalize_xtream_server, parse_ipapi_location, source_cache_file_name,
    };
    use crate::models::channel::{Channel, ContentType};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;

    #[test]
    fn normalize_xtream_server_trims_get_php_and_trailing_slash() {
        let server = normalize_xtream_server("https://demo.example.com:8080/get.php/")
            .expect("server should normalize");
        assert_eq!(server.to_string(), "https://demo.example.com:8080/");
    }

    #[test]
    fn normalize_stalker_mac_formats_compact_input() {
        let mac = normalize_stalker_mac("001A79123456").expect("mac should normalize");
        assert_eq!(mac, "00:1A:79:12:34:56");
    }

    #[test]
    fn normalize_stalker_mac_rejects_invalid_length() {
        let error = normalize_stalker_mac("00:11:22:33:44").expect_err("invalid MAC should fail");
        assert!(error.to_string().contains("Invalid MAC address"));
    }

    #[test]
    fn build_stalker_endpoint_candidates_includes_common_endpoints() {
        let portal = normalize_stalker_portal("https://demo.example.com:8080/c")
            .expect("portal URL should normalize");
        let endpoints = build_stalker_endpoint_candidates(&portal);
        let as_strings = endpoints
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert_eq!(
            as_strings,
            vec![
                "https://demo.example.com:8080/c/portal.php".to_string(),
                "https://demo.example.com:8080/c/server/load.php".to_string(),
            ]
        );
    }

    #[test]
    fn extract_stalker_stream_url_handles_prefixed_commands() {
        let url = extract_stalker_stream_url("ffmpeg http://example.com/live/stream.m3u8")
            .expect("stream URL should be extracted");
        assert_eq!(url, "http://example.com/live/stream.m3u8");
    }

    #[test]
    fn normalize_xtream_server_rejects_invalid_scheme() {
        let error = normalize_xtream_server("ftp://demo.example.com")
            .expect_err("invalid scheme should fail");
        assert!(error.to_string().contains("must use http:// or https://"));
    }

    #[test]
    fn build_xtream_download_url_uses_expected_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_download_url(&server, "demo_user", "demo_pass");
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/get.php?username=demo_user&password=demo_pass&type=m3u_plus&output=ts"
        );
    }

    #[test]
    fn build_xtream_player_api_url_uses_expected_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_player_api_url(&server, "demo_user", "demo_pass");
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/player_api.php?username=demo_user&password=demo_pass"
        );
    }

    #[test]
    fn build_xtream_player_api_action_url_appends_action_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_player_api_action_url(
            &server,
            "demo_user",
            "demo_pass",
            "get_account_info",
        );
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/player_api.php?username=demo_user&password=demo_pass&action=get_account_info"
        );
    }

    #[test]
    fn build_xtream_source_key_excludes_password() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let key = build_xtream_source_key(&server, "demo_user");
        assert_eq!(
            key,
            "xtream:https://demo.example.com:8080|demo_user|m3u_plus|ts"
        );
        assert!(!key.contains("demo_pass"));
    }

    #[test]
    fn extract_xtream_max_connections_parses_user_info_string() {
        let payload = serde_json::json!({
            "user_info": {
                "max_connections": "4"
            }
        });
        assert_eq!(extract_xtream_max_connections(&payload), Some(4));
    }

    #[test]
    fn extract_xtream_max_connections_parses_numeric_fallback() {
        let payload = serde_json::json!({
            "max_connections": 2
        });
        assert_eq!(extract_xtream_max_connections(&payload), Some(2));
    }

    #[test]
    fn extract_xtream_account_info_parses_subscription_fields() {
        let payload = serde_json::json!({
            "user_info": {
                "status": "Active",
                "exp_date": "1735689600",
                "created_at": "1704067200",
                "is_trial": "1",
                "active_cons": "2",
                "max_connections": "4"
            }
        });
        let info = extract_xtream_account_info(&payload).expect("account info should parse");
        assert_eq!(info.status.as_deref(), Some("Active"));
        assert_eq!(info.expires_at_epoch, Some(1_735_689_600));
        assert_eq!(info.created_at_epoch, Some(1_704_067_200));
        assert_eq!(info.is_trial, Some(true));
        assert_eq!(info.active_connections, Some(2));
        assert_eq!(info.max_connections, Some(4));
    }

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

        assert_eq!(
            dominant_channel_host(&channels),
            Some("one.example.com".to_string())
        );
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
    fn build_stalker_preview_maps_channels_and_filters() {
        let portal = normalize_stalker_portal("https://demo.example.com:8080/c")
            .expect("portal URL should normalize");
        let channels_payload = vec![
            serde_json::json!({
                "id": 10,
                "name": "News HD",
                "cmd": "ffmpeg http://streams.example.com/news.m3u8",
                "tv_genre_id": "3"
            }),
            serde_json::json!({
                "id": 11,
                "name": "Sports Max",
                "cmd": "http://streams.example.com/sports.m3u8",
                "tv_genre_title": "Sports"
            }),
        ];
        let mut genres = std::collections::HashMap::new();
        genres.insert("3".to_string(), "News".to_string());

        let preview = build_stalker_preview(
            &portal,
            "00:1A:79:12:34:56",
            channels_payload,
            &genres,
            &Some("News".to_string()),
            &Some("news".to_string()),
        )
        .expect("preview should build");

        assert_eq!(preview.total_channels, 1);
        assert_eq!(preview.channels[0].name, "News HD");
        assert_eq!(preview.channels[0].group, "News");
        assert_eq!(preview.channels[0].index, 0);
        assert!(preview
            .source_identity
            .expect("source identity should exist")
            .starts_with("stalker:"));
    }

    #[test]
    fn source_cache_file_name_is_deterministic() {
        let first = source_cache_file_name("xtream:https://demo.example.com|a|m3u_plus|ts");
        let second = source_cache_file_name("xtream:https://demo.example.com|a|m3u_plus|ts");
        let third = source_cache_file_name("xtream:https://demo.example.com|b|m3u_plus|ts");

        assert_eq!(first, second);
        assert_ne!(first, third);
        assert!(first.ends_with(".m3u8"));
    }

    #[test]
    fn cleanup_stale_cache_temp_files_removes_only_matching_temp_files() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-cache-cleanup-{unique}"));
        std::fs::create_dir_all(&root).expect("temp dir should be created");

        let cache_path = root.join("playlist-cache.m3u8");
        let stale_a = root.join("playlist-cache.m3u8.111.tmp");
        let stale_b = root.join("playlist-cache.m3u8.222.tmp");
        let keep_other = root.join("other-file.tmp");
        let keep_cache = root.join("playlist-cache.m3u8");

        std::fs::write(&stale_a, b"stale").expect("stale file should be writable");
        std::fs::write(&stale_b, b"stale").expect("stale file should be writable");
        std::fs::write(&keep_other, b"keep").expect("other file should be writable");
        std::fs::write(&keep_cache, b"keep").expect("cache file should be writable");

        cleanup_stale_cache_temp_files(&cache_path);

        assert!(!stale_a.exists());
        assert!(!stale_b.exists());
        assert!(keep_other.exists());
        assert!(keep_cache.exists());

        std::fs::remove_dir_all(root).expect("temp dir should be removable");
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

    #[tokio::test]
    async fn download_playlist_bytes_returns_error_when_response_exceeds_max_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have local address");

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test server should accept");
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;

            let body = vec![b'a'; 128];
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("test server should write headers");
            socket
                .write_all(&body)
                .await
                .expect("test server should write body");
        });

        let url = Url::parse(&format!("http://{}/playlist.m3u8", address))
            .expect("test URL should parse");
        let error = download_playlist_bytes(
            &url,
            "playlist URL",
            Duration::from_secs(1),
            Duration::from_secs(1),
            32,
            None,
        )
        .await
        .expect_err("oversized response should fail");

        assert!(
            error
                .to_string()
                .contains("exceeds the maximum allowed size"),
            "unexpected error: {}",
            error
        );
    }

    #[tokio::test]
    async fn download_playlist_bytes_returns_timeout_error_for_slow_streams() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have local address");

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test server should accept");
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;

            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n")
                .await
                .expect("test server should write headers");
            tokio::time::sleep(Duration::from_millis(250)).await;
            socket
                .write_all(b"hello")
                .await
                .expect("test server should write delayed body");
        });

        let url = Url::parse(&format!("http://{}/playlist.m3u8", address))
            .expect("test URL should parse");
        let error = download_playlist_bytes(
            &url,
            "playlist URL",
            Duration::from_millis(100),
            Duration::from_millis(100),
            1024,
            None,
        )
        .await
        .expect_err("slow response should timeout");

        assert!(
            error.to_string().contains("Timed out while downloading"),
            "unexpected error: {}",
            error
        );
    }
}
