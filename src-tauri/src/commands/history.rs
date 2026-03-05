use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;
use crate::models::channel::{ChannelResult, ChannelStatus};
use crate::models::scan::{ScanConfig, ScanSummary};
use crate::models::scan_history::{ScanHistoryDiff, ScanHistoryItem};

const MIN_HISTORY_LIMIT: usize = 1;
const MAX_HISTORY_LIMIT: usize = 200;
const HISTORY_FILE_NAME: &str = "scan-history.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ScanHistoryStore {
    entries: Vec<PersistedScanHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedScanHistoryEntry {
    id: String,
    playlist_key: String,
    scanned_at_epoch_ms: u64,
    summary: ScanSummary,
    group_filter: Option<String>,
    channel_search: Option<String>,
    selected_count: usize,
    scope_key: String,
    results: Vec<ChannelResult>,
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn normalize_playlist_path_key(playlist_path: &str) -> String {
    let trimmed = playlist_path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let path = Path::new(trimmed);
    if let Ok(canonicalized) = path.canonicalize() {
        return canonicalized.to_string_lossy().to_string();
    }

    trimmed.to_string()
}

fn normalize_url_identity(url_value: &str) -> Option<String> {
    let trimmed = url_value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parsed = reqwest::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    parsed.set_fragment(None);

    if (parsed.scheme() == "http" && parsed.port() == Some(80))
        || (parsed.scheme() == "https" && parsed.port() == Some(443))
    {
        let _ = parsed.set_port(None);
    }

    Some(parsed.to_string())
}

fn normalize_source_identity(source_identity: &str) -> Option<String> {
    let trimmed = source_identity.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(url_value) = trimmed.strip_prefix("url:") {
        return Some(
            normalize_url_identity(url_value)
                .map(|normalized| format!("url:{}", normalized))
                .unwrap_or_else(|| trimmed.to_string()),
        );
    }

    Some(trimmed.to_string())
}

fn normalize_playlist_key(playlist_path: &str, source_identity: Option<&str>) -> String {
    if let Some(identity) = source_identity.and_then(normalize_source_identity) {
        return identity;
    }

    normalize_playlist_path_key(playlist_path)
}

fn build_scope_key(config: &ScanConfig) -> String {
    let group = config
        .group_filter
        .as_deref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "*".to_string());
    let channel_search = config
        .channel_search
        .as_deref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "*".to_string());
    let selected = config
        .selected_indices
        .as_ref()
        .map(|indices| format!("selected:{}", indices.len()))
        .unwrap_or_else(|| "selected:*".to_string());

    format!(
        "group={group}|channel_search={channel_search}|{selected}",
        group = group,
        channel_search = channel_search,
        selected = selected
    )
}

fn clamp_history_limit(limit: usize) -> usize {
    limit.clamp(MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
}

fn history_file_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app.path().app_data_dir().map_err(|error| {
        AppError::Other(format!("Failed to resolve app data directory: {}", error))
    })?;
    std::fs::create_dir_all(&data_dir).map_err(AppError::Io)?;
    Ok(data_dir.join(HISTORY_FILE_NAME))
}

fn load_history_store(path: &Path) -> Result<ScanHistoryStore, AppError> {
    if !path.exists() {
        return Ok(ScanHistoryStore::default());
    }

    let bytes = std::fs::read(path).map_err(AppError::Io)?;
    if bytes.is_empty() {
        return Ok(ScanHistoryStore::default());
    }

    match serde_json::from_slice::<ScanHistoryStore>(&bytes) {
        Ok(store) => Ok(store),
        Err(error) => {
            log::warn!("Scan history file is corrupt, resetting: {}", error);
            let backup = path.with_extension("json.corrupt");
            let _ = std::fs::rename(path, &backup);
            Ok(ScanHistoryStore::default())
        }
    }
}

fn save_history_store(path: &Path, store: &ScanHistoryStore) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(store).map_err(|error| {
        AppError::Parse(format!("Failed to serialize scan history store: {}", error))
    })?;

    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, bytes).map_err(AppError::Io)?;
    match std::fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if path.exists() {
                std::fs::remove_file(path).map_err(AppError::Io)?;
                std::fs::rename(&tmp_path, path).map_err(AppError::Io)?;
                Ok(())
            } else {
                let _ = std::fs::remove_file(&tmp_path);
                Err(AppError::Io(first_error))
            }
        }
    }
}

fn enforce_playlist_retention(
    entries: &mut Vec<PersistedScanHistoryEntry>,
    playlist_key: &str,
    history_limit: usize,
) {
    let mut matching = Vec::new();
    let mut other = Vec::new();

    for entry in entries.drain(..) {
        if entry.playlist_key == playlist_key {
            matching.push(entry);
        } else {
            other.push(entry);
        }
    }

    matching.sort_by(|a, b| b.scanned_at_epoch_ms.cmp(&a.scanned_at_epoch_ms));
    matching.truncate(history_limit);

    other.extend(matching);
    *entries = other;
}

fn canonicalize_stream_url(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(mut parsed) = reqwest::Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    parsed.set_fragment(None);

    if (parsed.scheme() == "http" && parsed.port() == Some(80))
        || (parsed.scheme() == "https" && parsed.port() == Some(443))
    {
        let _ = parsed.set_port(None);
    }

    parsed.to_string()
}

fn channel_identity_key(result: &ChannelResult) -> String {
    let base_url = result.stream_url.as_deref().unwrap_or(&result.url);
    canonicalize_stream_url(base_url)
}

fn is_alive(status: &ChannelStatus) -> bool {
    matches!(status, ChannelStatus::Alive | ChannelStatus::Drm)
}

fn compute_history_diff(
    newer: &PersistedScanHistoryEntry,
    older: &PersistedScanHistoryEntry,
) -> ScanHistoryDiff {
    let newer_map: HashMap<String, ChannelStatus> = newer
        .results
        .iter()
        .map(|result| (channel_identity_key(result), result.status.clone()))
        .collect();
    let older_map: HashMap<String, ChannelStatus> = older
        .results
        .iter()
        .map(|result| (channel_identity_key(result), result.status.clone()))
        .collect();

    let channels_gained = newer_map
        .keys()
        .filter(|key| !older_map.contains_key(*key))
        .count();
    let channels_lost = older_map
        .keys()
        .filter(|key| !newer_map.contains_key(*key))
        .count();

    let mut status_changed = 0usize;
    let mut became_alive = 0usize;
    let mut became_dead = 0usize;

    for (key, new_status) in &newer_map {
        if let Some(old_status) = older_map.get(key) {
            if new_status != old_status {
                status_changed += 1;
            }
            if !is_alive(old_status) && is_alive(new_status) {
                became_alive += 1;
            }
            if is_alive(old_status) && !is_alive(new_status) {
                became_dead += 1;
            }
        }
    }

    ScanHistoryDiff {
        channels_gained,
        channels_lost,
        status_changed,
        became_alive,
        became_dead,
    }
}

pub fn append_scan_history(
    app: &tauri::AppHandle,
    run_id: &str,
    config: &ScanConfig,
    summary: &ScanSummary,
    results: Vec<ChannelResult>,
    history_limit: usize,
) -> Result<(), AppError> {
    let history_path = history_file_path(app)?;
    append_scan_history_at_path(
        &history_path,
        run_id,
        config,
        summary,
        results,
        history_limit,
    )
}

fn append_scan_history_at_path(
    history_path: &Path,
    run_id: &str,
    config: &ScanConfig,
    summary: &ScanSummary,
    results: Vec<ChannelResult>,
    history_limit: usize,
) -> Result<(), AppError> {
    let mut store = load_history_store(history_path)?;

    let playlist_key = normalize_playlist_key(&config.file_path, config.source_identity.as_deref());
    let entry = PersistedScanHistoryEntry {
        id: run_id.to_string(),
        playlist_key: playlist_key.clone(),
        scanned_at_epoch_ms: now_epoch_ms(),
        summary: summary.clone(),
        group_filter: config.group_filter.clone(),
        channel_search: config.channel_search.clone(),
        selected_count: config
            .selected_indices
            .as_ref()
            .map(|v| v.len())
            .unwrap_or(0),
        scope_key: build_scope_key(config),
        results,
    };

    store.entries.push(entry);
    enforce_playlist_retention(
        &mut store.entries,
        &playlist_key,
        clamp_history_limit(history_limit),
    );
    save_history_store(history_path, &store)?;
    Ok(())
}

fn get_scan_history_from_path(
    history_path: &Path,
    playlist_path: &str,
    source_identity: Option<&str>,
) -> Result<Vec<ScanHistoryItem>, AppError> {
    let playlist_key = normalize_playlist_key(playlist_path, source_identity);
    if playlist_key.is_empty() {
        return Ok(Vec::new());
    }

    let mut entries = load_history_store(history_path)?
        .entries
        .into_iter()
        .filter(|entry| entry.playlist_key == playlist_key)
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| b.scanned_at_epoch_ms.cmp(&a.scanned_at_epoch_ms));

    let mut items = Vec::with_capacity(entries.len());
    for index in 0..entries.len() {
        let diff = if index + 1 < entries.len() {
            let newer = &entries[index];
            let older = &entries[index + 1];
            if newer.scope_key == older.scope_key {
                Some(compute_history_diff(newer, older))
            } else {
                None
            }
        } else {
            None
        };

        let entry = &entries[index];
        items.push(ScanHistoryItem {
            id: entry.id.clone(),
            scanned_at_epoch_ms: entry.scanned_at_epoch_ms,
            summary: entry.summary.clone(),
            group_filter: entry.group_filter.clone(),
            channel_search: entry.channel_search.clone(),
            selected_count: entry.selected_count,
            diff,
        });
    }

    Ok(items)
}

#[tauri::command]
pub async fn get_scan_history(
    app: tauri::AppHandle,
    playlist_path: String,
    source_identity: Option<String>,
) -> Result<Vec<ScanHistoryItem>, AppError> {
    let history_path = history_file_path(&app)?;
    get_scan_history_from_path(&history_path, &playlist_path, source_identity.as_deref())
}

#[tauri::command]
pub async fn clear_scan_history(
    app: tauri::AppHandle,
    playlist_path: String,
    source_identity: Option<String>,
) -> Result<usize, AppError> {
    let playlist_key = normalize_playlist_key(&playlist_path, source_identity.as_deref());
    if playlist_key.is_empty() {
        return Ok(0);
    }

    let history_path = history_file_path(&app)?;
    let mut store = load_history_store(&history_path)?;
    let before = store.entries.len();
    store
        .entries
        .retain(|entry| entry.playlist_key != playlist_key);
    let removed = before.saturating_sub(store.entries.len());

    if removed > 0 {
        save_history_store(&history_path, &store)?;
    }

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::channel::Channel;
    use crate::models::playlist::PlaylistPreview;
    use crate::models::scan::{RetryBackoff, ScanConfig};
    use std::path::PathBuf;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sample_result(url: &str, status: ChannelStatus) -> ChannelResult {
        ChannelResult {
            index: 0,
            playlist: "fixture.m3u8".to_string(),
            name: "Channel".to_string(),
            group: "Group".to_string(),
            url: url.to_string(),
            content_type: crate::models::channel::ContentType::Live,
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_only: false,
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: "id".to_string(),
            extinf_line: "#EXTINF:-1,Channel".to_string(),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
            drm_system: None,
        }
    }

    fn sample_entry(
        id: &str,
        timestamp_ms: u64,
        scope_key: &str,
        results: Vec<ChannelResult>,
    ) -> PersistedScanHistoryEntry {
        PersistedScanHistoryEntry {
            id: id.to_string(),
            playlist_key: "/tmp/sample.m3u8".to_string(),
            scanned_at_epoch_ms: timestamp_ms,
            summary: ScanSummary {
                total: results.len(),
                alive: results
                    .iter()
                    .filter(|result| result.status == ChannelStatus::Alive)
                    .count(),
                dead: results
                    .iter()
                    .filter(|result| result.status == ChannelStatus::Dead)
                    .count(),
                geoblocked: 0,
                drm: results
                    .iter()
                    .filter(|result| result.status == ChannelStatus::Drm)
                    .count(),
                low_framerate: 0,
                mislabeled: 0,
            },
            group_filter: None,
            channel_search: None,
            selected_count: 0,
            scope_key: scope_key.to_string(),
            results,
        }
    }

    fn create_test_root_dir(test_name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("iptv-history-{test_name}-{unique}"))
    }

    fn build_scan_config(preview: &PlaylistPreview) -> ScanConfig {
        ScanConfig {
            file_path: preview.file_path.clone(),
            source_identity: preview.source_identity.clone(),
            group_filter: None,
            channel_search: None,
            selected_indices: None,
            timeout: 5.0,
            extended_timeout: Some(10.0),
            concurrency: 1,
            retries: 0,
            retry_backoff: RetryBackoff::None,
            user_agent: "IPTVCheckerTests/1.0".to_string(),
            skip_screenshots: true,
            profile_bitrate: false,
            ffprobe_timeout_secs: 30.0,
            ffmpeg_bitrate_timeout_secs: 60.0,
            accept_invalid_certs: false,
            proxy_file: None,
            test_geoblock: false,
            screenshots_dir: None,
            client_capabilities: None,
        }
    }

    fn channel_result_from_channel(channel: &Channel, status: ChannelStatus) -> ChannelResult {
        ChannelResult {
            index: channel.index,
            playlist: channel.playlist.clone(),
            name: channel.name.clone(),
            group: channel.group.clone(),
            url: channel.url.clone(),
            content_type: channel.content_type,
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_only: false,
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: "id".to_string(),
            extinf_line: channel.extinf_line.clone(),
            metadata_lines: channel.metadata_lines.clone(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
            drm_system: None,
        }
    }

    fn summarize_results(results: &[ChannelResult]) -> ScanSummary {
        ScanSummary {
            total: results.len(),
            alive: results
                .iter()
                .filter(|result| result.status == ChannelStatus::Alive)
                .count(),
            dead: results
                .iter()
                .filter(|result| result.status == ChannelStatus::Dead)
                .count(),
            geoblocked: results
                .iter()
                .filter(|result| {
                    matches!(
                        result.status,
                        ChannelStatus::Geoblocked
                            | ChannelStatus::GeoblockedConfirmed
                            | ChannelStatus::GeoblockedUnconfirmed
                    )
                })
                .count(),
            drm: results
                .iter()
                .filter(|result| result.status == ChannelStatus::Drm)
                .count(),
            low_framerate: 0,
            mislabeled: 0,
        }
    }

    #[test]
    fn compute_history_diff_counts_gained_lost_and_state_changes() {
        let older = sample_entry(
            "old",
            1,
            "scope",
            vec![
                sample_result("http://example.com/a", ChannelStatus::Alive),
                sample_result("http://example.com/b", ChannelStatus::Dead),
                sample_result("http://example.com/c", ChannelStatus::Alive),
            ],
        );
        let newer = sample_entry(
            "new",
            2,
            "scope",
            vec![
                sample_result("http://example.com/a", ChannelStatus::Dead),
                sample_result("http://example.com/b", ChannelStatus::Alive),
                sample_result("http://example.com/d", ChannelStatus::Alive),
            ],
        );

        let diff = compute_history_diff(&newer, &older);
        assert_eq!(diff.channels_gained, 1);
        assert_eq!(diff.channels_lost, 1);
        assert_eq!(diff.status_changed, 2);
        assert_eq!(diff.became_alive, 1);
        assert_eq!(diff.became_dead, 1);
    }

    #[test]
    fn enforce_playlist_retention_keeps_newest_entries_per_playlist() {
        let mut entries = vec![
            sample_entry(
                "run-1",
                1,
                "scope",
                vec![sample_result("http://example.com/1", ChannelStatus::Alive)],
            ),
            sample_entry(
                "run-2",
                2,
                "scope",
                vec![sample_result("http://example.com/2", ChannelStatus::Alive)],
            ),
            sample_entry(
                "run-3",
                3,
                "scope",
                vec![sample_result("http://example.com/3", ChannelStatus::Alive)],
            ),
            PersistedScanHistoryEntry {
                id: "other-playlist".to_string(),
                playlist_key: "/tmp/other.m3u8".to_string(),
                scanned_at_epoch_ms: 999,
                summary: ScanSummary {
                    total: 1,
                    alive: 1,
                    dead: 0,
                    geoblocked: 0,
                    drm: 0,
                    low_framerate: 0,
                    mislabeled: 0,
                },
                group_filter: None,
                channel_search: None,
                selected_count: 0,
                scope_key: "scope".to_string(),
                results: vec![sample_result(
                    "http://example.com/other",
                    ChannelStatus::Alive,
                )],
            },
        ];

        enforce_playlist_retention(&mut entries, "/tmp/sample.m3u8", 2);

        let kept_sample_ids = entries
            .iter()
            .filter(|entry| entry.playlist_key == "/tmp/sample.m3u8")
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(kept_sample_ids.len(), 2);
        assert!(kept_sample_ids.contains(&"run-3"));
        assert!(kept_sample_ids.contains(&"run-2"));
        assert!(entries.iter().any(|entry| entry.id == "other-playlist"));
    }

    #[test]
    fn normalize_playlist_key_prefers_stable_url_source_identity() {
        let first = normalize_playlist_key(
            "/tmp/playlist-cache-a.m3u8",
            Some("url:https://Example.com:443/live/list.m3u8#frag"),
        );
        let second = normalize_playlist_key(
            "/tmp/playlist-cache-b.m3u8",
            Some("url:https://example.com/live/list.m3u8"),
        );

        assert_eq!(first, "url:https://example.com/live/list.m3u8");
        assert_eq!(first, second);
    }

    #[test]
    fn normalize_playlist_key_falls_back_to_path_when_source_identity_missing() {
        let key = normalize_playlist_key("/tmp/sample.m3u8", None);
        assert!(key.ends_with("/tmp/sample.m3u8"));
    }

    #[tokio::test]
    async fn url_playlist_history_continues_across_reruns_and_generates_diff() {
        let test_root = create_test_root_dir("url-history");
        let data_dir = test_root.join("app-data");
        let history_path = test_root.join("scan-history.json");
        std::fs::create_dir_all(&data_dir).expect("test data dir should be created");

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should expose local address");

        let first_playlist_body = "\
#EXTM3U
#EXTINF:-1 tvg-id=\"alpha\",Alpha
http://streams.example.com/a.m3u8
#EXTINF:-1 tvg-id=\"beta\",Beta
http://streams.example.com/b.m3u8
";
        let second_playlist_body = "\
#EXTM3U
#EXTINF:-1 tvg-id=\"alpha\",Alpha
http://streams.example.com/a.m3u8
#EXTINF:-1 tvg-id=\"charlie\",Charlie
http://streams.example.com/c.m3u8
";

        tokio::spawn(async move {
            for body in [first_playlist_body, second_playlist_body] {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                if socket.write_all(response.as_bytes()).await.is_err() {
                    return;
                }
            }
        });

        let first_preview = crate::commands::playlist::open_playlist_url_from_data_dir(
            &data_dir,
            &format!(" http://LOCALHOST:{}/playlist.m3u8#first ", address.port()),
            None,
            None,
        )
        .await
        .expect("first URL playlist open should succeed");

        let second_preview = crate::commands::playlist::open_playlist_url_from_data_dir(
            &data_dir,
            &format!("http://localhost:{}/playlist.m3u8#second", address.port()),
            None,
            None,
        )
        .await
        .expect("second URL playlist open should succeed");

        assert_eq!(first_preview.total_channels, 2);
        assert_eq!(second_preview.total_channels, 2);
        assert_eq!(
            first_preview.source_identity,
            second_preview.source_identity
        );

        let first_results = first_preview
            .channels
            .iter()
            .map(|channel| {
                let status = if channel.url.ends_with("/a.m3u8") {
                    ChannelStatus::Alive
                } else {
                    ChannelStatus::Dead
                };
                channel_result_from_channel(channel, status)
            })
            .collect::<Vec<_>>();
        let second_results = second_preview
            .channels
            .iter()
            .map(|channel| {
                let status = if channel.url.ends_with("/a.m3u8") {
                    ChannelStatus::Dead
                } else {
                    ChannelStatus::Alive
                };
                channel_result_from_channel(channel, status)
            })
            .collect::<Vec<_>>();

        append_scan_history_at_path(
            &history_path,
            "url-run-1",
            &build_scan_config(&first_preview),
            &summarize_results(&first_results),
            first_results,
            20,
        )
        .expect("first history append should succeed");

        std::thread::sleep(Duration::from_millis(2));

        append_scan_history_at_path(
            &history_path,
            "url-run-2",
            &build_scan_config(&second_preview),
            &summarize_results(&second_results),
            second_results,
            20,
        )
        .expect("second history append should succeed");

        let history = get_scan_history_from_path(
            &history_path,
            "/tmp/unrelated-cache-path.m3u8",
            second_preview.source_identity.as_deref(),
        )
        .expect("history lookup should succeed");

        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, "url-run-2");
        assert!(history[1].diff.is_none());

        let diff = history[0]
            .diff
            .as_ref()
            .expect("latest run should include diff against previous run");
        assert_eq!(diff.channels_gained, 1);
        assert_eq!(diff.channels_lost, 1);
        assert_eq!(diff.status_changed, 1);
        assert_eq!(diff.became_alive, 0);
        assert_eq!(diff.became_dead, 1);

        let _ = std::fs::remove_dir_all(&test_root);
    }
}
