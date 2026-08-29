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
const V2_DIR_NAME: &str = "scan-history-v2";
const V2_INDEX_FILE_NAME: &str = "index.json";
const V2_RUNS_DIR_NAME: &str = "runs";

// ── V1 types (for migration) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ScanHistoryStoreV1 {
    entries: Vec<PersistedScanHistoryEntryV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedScanHistoryEntryV1 {
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

// ── V2 types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryIndexV2 {
    version: u32,
    entries: Vec<IndexEntryV2>,
}

impl Default for HistoryIndexV2 {
    fn default() -> Self {
        Self {
            version: 2,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntryV2 {
    id: String,
    playlist_key: String,
    scanned_at_epoch_ms: u64,
    summary: ScanSummary,
    group_filter: Option<String>,
    channel_search: Option<String>,
    selected_count: usize,
    scope_key: String,
    diff: Option<ScanHistoryDiff>,
}

// ── Shared helpers ─────────────────────────────────────────────────────────

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

use crate::urlnorm::normalize_http_url_identity;

fn normalize_source_identity(source_identity: &str) -> Option<String> {
    let trimmed = source_identity.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(url_value) = trimmed.strip_prefix("url:") {
        return Some(
            normalize_http_url_identity(url_value)
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
        .and_then(|indices| {
            if indices.is_empty() {
                return None;
            }

            let mut normalized = indices.clone();
            normalized.sort_unstable();
            normalized.dedup();

            let selection = normalized
                .into_iter()
                .map(|index| index.to_string())
                .collect::<Vec<_>>()
                .join(",");
            Some(format!("selected:{selection}"))
        })
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

use crate::urlnorm::canonicalize_stream_url;

fn channel_identity_key(result: &ChannelResult) -> String {
    let base_url = result.stream_url.as_deref().unwrap_or(&result.url);
    canonicalize_stream_url(base_url)
}

fn is_alive(status: &ChannelStatus) -> bool {
    matches!(status, ChannelStatus::Alive | ChannelStatus::Drm)
}

fn compute_history_diff_from_results(
    newer_results: &[ChannelResult],
    older_results: &[ChannelResult],
) -> ScanHistoryDiff {
    let newer_map: HashMap<String, ChannelStatus> = newer_results
        .iter()
        .map(|result| (channel_identity_key(result), result.status))
        .collect();
    let older_map: HashMap<String, ChannelStatus> = older_results
        .iter()
        .map(|result| (channel_identity_key(result), result.status))
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

// ── V2 directory layout helpers ────────────────────────────────────────────

fn v2_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(V2_DIR_NAME)
}

fn v2_index_path(base_dir: &Path) -> PathBuf {
    v2_dir(base_dir).join(V2_INDEX_FILE_NAME)
}

fn v2_runs_dir(base_dir: &Path) -> PathBuf {
    v2_dir(base_dir).join(V2_RUNS_DIR_NAME)
}

fn v2_run_file_path(base_dir: &Path, run_id: &str) -> PathBuf {
    v2_runs_dir(base_dir).join(format!("{}.json", run_id))
}

fn v1_history_path(base_dir: &Path) -> PathBuf {
    base_dir.join(HISTORY_FILE_NAME)
}

fn v1_backup_path(base_dir: &Path) -> PathBuf {
    base_dir.join(format!("{}.v1-backup", HISTORY_FILE_NAME))
}

// ── V2 IO operations ──────────────────────────────────────────────────────

fn load_v2_index(base_dir: &Path) -> Result<HistoryIndexV2, AppError> {
    let index_path = v2_index_path(base_dir);
    if !index_path.exists() {
        return Ok(HistoryIndexV2::default());
    }

    let bytes = std::fs::read(&index_path).map_err(AppError::Io)?;
    if bytes.is_empty() {
        return Ok(HistoryIndexV2::default());
    }

    match serde_json::from_slice::<HistoryIndexV2>(&bytes) {
        Ok(index) => Ok(index),
        Err(error) => {
            log::warn!("V2 history index is corrupt, resetting: {}", error);
            let backup = index_path.with_extension("json.corrupt");
            let _ = std::fs::rename(&index_path, &backup);
            Ok(HistoryIndexV2::default())
        }
    }
}

fn save_v2_index(base_dir: &Path, index: &HistoryIndexV2) -> Result<(), AppError> {
    let dir = v2_dir(base_dir);
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;

    let index_path = v2_index_path(base_dir);
    let bytes = serde_json::to_vec(index).map_err(|error| {
        AppError::Parse(format!("Failed to serialize v2 history index: {}", error))
    })?;

    let tmp_path = index_path.with_extension("json.tmp");
    crate::engine::disk::atomic_write(&index_path, &tmp_path, &bytes)
}

fn write_run_file(
    base_dir: &Path,
    run_id: &str,
    results: &[ChannelResult],
) -> Result<(), AppError> {
    let runs_dir = v2_runs_dir(base_dir);
    std::fs::create_dir_all(&runs_dir).map_err(AppError::Io)?;

    let run_path = v2_run_file_path(base_dir, run_id);
    let sanitized_results = results
        .iter()
        .map(|result| {
            let mut sanitized = result.clone();
            sanitized.catchup_source = sanitized
                .catchup_source
                .as_deref()
                .map(crate::engine::resume::sanitize_url_for_persistence);
            sanitized
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&sanitized_results).map_err(|error| {
        AppError::Parse(format!(
            "Failed to serialize run file {}: {}",
            run_id, error
        ))
    })?;
    std::fs::write(&run_path, bytes).map_err(AppError::Io)?;
    Ok(())
}

fn load_run_file(base_dir: &Path, run_id: &str) -> Result<Vec<ChannelResult>, AppError> {
    let run_path = v2_run_file_path(base_dir, run_id);
    let bytes = std::fs::read(&run_path).map_err(AppError::Io)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Parse(format!("Failed to parse run file {}: {}", run_id, error)))
}

fn delete_run_file(base_dir: &Path, run_id: &str) {
    let run_path = v2_run_file_path(base_dir, run_id);
    if let Err(error) = std::fs::remove_file(&run_path) {
        log::warn!("Failed to delete per-run file {}: {}", run_id, error);
    }
}

// ── V1 migration ──────────────────────────────────────────────────────────

fn load_v1_store(path: &Path) -> Result<ScanHistoryStoreV1, AppError> {
    if !path.exists() {
        return Ok(ScanHistoryStoreV1::default());
    }

    let bytes = std::fs::read(path).map_err(AppError::Io)?;
    if bytes.is_empty() {
        return Ok(ScanHistoryStoreV1::default());
    }

    match serde_json::from_slice::<ScanHistoryStoreV1>(&bytes) {
        Ok(store) => Ok(store),
        Err(error) => {
            log::warn!(
                "V1 scan history file is corrupt, skipping migration: {}",
                error
            );
            Ok(ScanHistoryStoreV1::default())
        }
    }
}

fn migrate_v1_to_v2(base_dir: &Path) -> Result<(), AppError> {
    let v1_path = v1_history_path(base_dir);
    if !v1_path.exists() {
        return Ok(());
    }

    log::info!("Migrating v1 scan history to v2 layout...");
    let v1_store = load_v1_store(&v1_path)?;

    if v1_store.entries.is_empty() {
        // Nothing to migrate — just rename the v1 file
        let backup = v1_backup_path(base_dir);
        let _ = std::fs::rename(&v1_path, &backup);
        return Ok(());
    }

    // Write per-run files
    for entry in &v1_store.entries {
        if let Err(error) = write_run_file(base_dir, &entry.id, &entry.results) {
            log::warn!(
                "Failed to write per-run file during migration for {}: {}",
                entry.id,
                error
            );
        }
    }

    // Build v2 index with precomputed diffs
    // Group entries by playlist_key, sort by timestamp descending to compute diffs
    let mut by_playlist: HashMap<String, Vec<&PersistedScanHistoryEntryV1>> = HashMap::new();
    for entry in &v1_store.entries {
        by_playlist
            .entry(entry.playlist_key.clone())
            .or_default()
            .push(entry);
    }

    let mut index_entries = Vec::with_capacity(v1_store.entries.len());
    for (_playlist_key, mut entries) in by_playlist {
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.scanned_at_epoch_ms));

        for i in 0..entries.len() {
            let diff = if i + 1 < entries.len() {
                let newer = entries[i];
                let older = entries[i + 1];
                if newer.scope_key == older.scope_key {
                    Some(compute_history_diff_from_results(
                        &newer.results,
                        &older.results,
                    ))
                } else {
                    None
                }
            } else {
                None
            };

            let entry = entries[i];
            index_entries.push(IndexEntryV2 {
                id: entry.id.clone(),
                playlist_key: entry.playlist_key.clone(),
                scanned_at_epoch_ms: entry.scanned_at_epoch_ms,
                summary: entry.summary.clone(),
                group_filter: entry.group_filter.clone(),
                channel_search: entry.channel_search.clone(),
                selected_count: entry.selected_count,
                scope_key: entry.scope_key.clone(),
                diff,
            });
        }
    }

    let index = HistoryIndexV2 {
        version: 2,
        entries: index_entries,
    };
    save_v2_index(base_dir, &index)?;

    // Rename v1 file to backup
    let backup = v1_backup_path(base_dir);
    if let Err(error) = std::fs::rename(&v1_path, &backup) {
        log::warn!("Failed to rename v1 history file to backup: {}", error);
    }

    log::info!(
        "V1 to v2 migration complete ({} entries)",
        index.entries.len()
    );
    Ok(())
}

/// Ensure v2 layout exists, migrating from v1 if needed.
fn ensure_v2(base_dir: &Path) -> Result<(), AppError> {
    let index_path = v2_index_path(base_dir);
    if index_path.exists() {
        return Ok(());
    }

    migrate_v1_to_v2(base_dir)
}

// ── V2 retention ──────────────────────────────────────────────────────────

fn enforce_playlist_retention_v2(
    index: &mut HistoryIndexV2,
    base_dir: &Path,
    playlist_key: &str,
    history_limit: usize,
) {
    let mut matching: Vec<IndexEntryV2> = Vec::new();
    let mut other: Vec<IndexEntryV2> = Vec::new();

    for entry in index.entries.drain(..) {
        if entry.playlist_key == playlist_key {
            matching.push(entry);
        } else {
            other.push(entry);
        }
    }

    matching.sort_by_key(|entry| std::cmp::Reverse(entry.scanned_at_epoch_ms));

    // Delete per-run files for entries that will be removed
    if matching.len() > history_limit {
        for removed_entry in &matching[history_limit..] {
            delete_run_file(base_dir, &removed_entry.id);
        }
        matching.truncate(history_limit);
    }

    other.extend(matching);
    index.entries = other;
}

// ── Public API ─────────────────────────────────────────────────────────────

fn history_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app.path().app_data_dir().map_err(|error| {
        AppError::Other(format!("Failed to resolve app data directory: {}", error))
    })?;
    std::fs::create_dir_all(&data_dir).map_err(AppError::Io)?;
    Ok(data_dir)
}

pub fn append_scan_history(
    app: &tauri::AppHandle,
    run_id: &str,
    config: &ScanConfig,
    summary: &ScanSummary,
    results: Vec<ChannelResult>,
    history_limit: usize,
) -> Result<(), AppError> {
    let base_dir = history_base_dir(app)?;
    append_scan_history_at_dir(&base_dir, run_id, config, summary, results, history_limit)
}

fn append_scan_history_at_dir(
    base_dir: &Path,
    run_id: &str,
    config: &ScanConfig,
    summary: &ScanSummary,
    results: Vec<ChannelResult>,
    history_limit: usize,
) -> Result<(), AppError> {
    ensure_v2(base_dir)?;

    let mut index = load_v2_index(base_dir)?;
    let playlist_key = normalize_playlist_key(&config.file_path, config.source_identity.as_deref());
    let scope_key = build_scope_key(config);

    // Find most recent entry with same playlist_key AND scope_key
    let mut candidates: Vec<&IndexEntryV2> = index
        .entries
        .iter()
        .filter(|e| e.playlist_key == playlist_key && e.scope_key == scope_key)
        .collect();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.scanned_at_epoch_ms));

    let diff = if let Some(prev_entry) = candidates.first() {
        match load_run_file(base_dir, &prev_entry.id) {
            Ok(prev_results) => Some(compute_history_diff_from_results(&results, &prev_results)),
            Err(error) => {
                log::warn!(
                    "Failed to load previous run file {} for diff computation: {}",
                    prev_entry.id,
                    error
                );
                None
            }
        }
    } else {
        None
    };

    // Write per-run file
    write_run_file(base_dir, run_id, &results)?;

    // Add new entry to index
    let new_entry = IndexEntryV2 {
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
        scope_key,
        diff,
    };
    index.entries.push(new_entry);

    // Enforce retention
    enforce_playlist_retention_v2(
        &mut index,
        base_dir,
        &playlist_key,
        clamp_history_limit(history_limit),
    );

    // Save index atomically
    save_v2_index(base_dir, &index)?;
    Ok(())
}

fn get_scan_history_from_dir(
    base_dir: &Path,
    playlist_path: &str,
    source_identity: Option<&str>,
) -> Result<Vec<ScanHistoryItem>, AppError> {
    let playlist_key = normalize_playlist_key(playlist_path, source_identity);
    if playlist_key.is_empty() {
        return Ok(Vec::new());
    }

    ensure_v2(base_dir)?;
    let index = load_v2_index(base_dir)?;

    let mut matching: Vec<&IndexEntryV2> = index
        .entries
        .iter()
        .filter(|entry| entry.playlist_key == playlist_key)
        .collect();
    matching.sort_by_key(|entry| std::cmp::Reverse(entry.scanned_at_epoch_ms));

    let items = matching
        .iter()
        .map(|entry| ScanHistoryItem {
            id: entry.id.clone(),
            scanned_at_epoch_ms: entry.scanned_at_epoch_ms,
            summary: entry.summary.clone(),
            group_filter: entry.group_filter.clone(),
            channel_search: entry.channel_search.clone(),
            selected_count: entry.selected_count,
            diff: entry.diff.clone(),
        })
        .collect();

    Ok(items)
}

fn clear_scan_history_at_dir(
    base_dir: &Path,
    playlist_path: &str,
    source_identity: Option<&str>,
) -> Result<usize, AppError> {
    let playlist_key = normalize_playlist_key(playlist_path, source_identity);
    if playlist_key.is_empty() {
        return Ok(0);
    }

    ensure_v2(base_dir)?;
    let mut index = load_v2_index(base_dir)?;

    // Collect IDs of entries to remove (for per-run file deletion)
    let to_remove: Vec<String> = index
        .entries
        .iter()
        .filter(|entry| entry.playlist_key == playlist_key)
        .map(|entry| entry.id.clone())
        .collect();

    let removed = to_remove.len();
    if removed == 0 {
        return Ok(0);
    }

    // Delete per-run files
    for run_id in &to_remove {
        delete_run_file(base_dir, run_id);
    }

    // Remove from index
    index
        .entries
        .retain(|entry| entry.playlist_key != playlist_key);
    save_v2_index(base_dir, &index)?;

    Ok(removed)
}

#[tauri::command]
pub async fn get_scan_history(
    app: tauri::AppHandle,
    playlist_path: String,
    source_identity: Option<String>,
) -> Result<Vec<ScanHistoryItem>, AppError> {
    let base_dir = history_base_dir(&app)?;
    get_scan_history_from_dir(&base_dir, &playlist_path, source_identity.as_deref())
}

#[tauri::command]
pub async fn clear_scan_history(
    app: tauri::AppHandle,
    playlist_path: String,
    source_identity: Option<String>,
) -> Result<usize, AppError> {
    let base_dir = history_base_dir(&app)?;
    clear_scan_history_at_dir(&base_dir, &playlist_path, source_identity.as_deref())
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
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: url.to_string(),
            content_type: crate::models::channel::ContentType::Live,
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            hdr_format: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_channel_layout: None,
            audio_only: false,
            screenshot_path: None,
            screenshot_error_reason: None,
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
            playlist_display_name: Some(preview.file_name.clone()),
            group_filter: None,
            channel_search: None,
            selected_indices: None,
            hide_vod_content: false,
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
            language: channel.language.clone(),
            tvg_id: channel.tvg_id.clone(),
            tvg_name: channel.tvg_name.clone(),
            tvg_logo: channel.tvg_logo.clone(),
            tvg_chno: channel.tvg_chno.clone(),
            catchup: channel.catchup.clone(),
            catchup_days: channel.catchup_days,
            catchup_source: channel.catchup_source.clone(),
            url: channel.url.clone(),
            content_type: channel.content_type,
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            hdr_format: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_channel_layout: None,
            audio_only: false,
            screenshot_path: None,
            screenshot_error_reason: None,
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
            placeholder: results
                .iter()
                .filter(|result| result.status == ChannelStatus::Placeholder)
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
            playlist_score: None,
        }
    }

    fn make_config(file_path: &str, source_identity: Option<&str>) -> ScanConfig {
        ScanConfig {
            file_path: file_path.to_string(),
            source_identity: source_identity.map(String::from),
            playlist_display_name: None,
            group_filter: None,
            channel_search: None,
            selected_indices: None,
            hide_vod_content: false,
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

    fn make_summary(alive: usize, dead: usize) -> ScanSummary {
        ScanSummary {
            total: alive + dead,
            alive,
            dead,
            placeholder: 0,
            geoblocked: 0,
            drm: 0,
            low_framerate: 0,
            mislabeled: 0,
            playlist_score: None,
        }
    }

    #[test]
    fn compute_history_diff_counts_gained_lost_and_state_changes() {
        let older_results = vec![
            sample_result("http://example.com/a", ChannelStatus::Alive),
            sample_result("http://example.com/b", ChannelStatus::Dead),
            sample_result("http://example.com/c", ChannelStatus::Alive),
        ];
        let newer_results = vec![
            sample_result("http://example.com/a", ChannelStatus::Dead),
            sample_result("http://example.com/b", ChannelStatus::Alive),
            sample_result("http://example.com/d", ChannelStatus::Alive),
        ];

        let diff = compute_history_diff_from_results(&newer_results, &older_results);
        assert_eq!(diff.channels_gained, 1);
        assert_eq!(diff.channels_lost, 1);
        assert_eq!(diff.status_changed, 2);
        assert_eq!(diff.became_alive, 1);
        assert_eq!(diff.became_dead, 1);
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

    #[test]
    fn v2_append_and_get_history() {
        let test_root = create_test_root_dir("v2-append-get");
        std::fs::create_dir_all(&test_root).unwrap();

        let config = make_config("/tmp/sample.m3u8", None);
        let results1 = vec![
            sample_result("http://example.com/a", ChannelStatus::Alive),
            sample_result("http://example.com/b", ChannelStatus::Dead),
        ];
        let summary1 = make_summary(1, 1);

        append_scan_history_at_dir(&test_root, "run-1", &config, &summary1, results1, 20).unwrap();

        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "run-1");
        assert!(history[0].diff.is_none()); // no previous run to diff against

        // Second run with same scope
        let results2 = vec![
            sample_result("http://example.com/a", ChannelStatus::Dead),
            sample_result("http://example.com/c", ChannelStatus::Alive),
        ];
        let summary2 = make_summary(1, 1);

        std::thread::sleep(Duration::from_millis(2));
        append_scan_history_at_dir(&test_root, "run-2", &config, &summary2, results2, 20).unwrap();

        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, "run-2");
        assert_eq!(history[1].id, "run-1");

        // run-2 should have a diff against run-1
        let diff = history[0].diff.as_ref().expect("run-2 should have diff");
        assert_eq!(diff.channels_gained, 1); // c is new
        assert_eq!(diff.channels_lost, 1); // b is gone
        assert_eq!(diff.became_dead, 1); // a went alive -> dead

        // run-1 still has no diff
        assert!(history[1].diff.is_none());

        // Verify per-run files exist
        assert!(v2_run_file_path(&test_root, "run-1").exists());
        assert!(v2_run_file_path(&test_root, "run-2").exists());

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v2_run_files_redact_catchup_source_credentials() {
        let test_root = create_test_root_dir("v2-catchup-source-redaction");
        std::fs::create_dir_all(&test_root).unwrap();

        let mut result = sample_result("http://example.com/a", ChannelStatus::Alive);
        result.catchup_source = Some(
            "https://archive:secret@example.com/timeshift?username=demo&token=abc123".to_string(),
        );

        write_run_file(&test_root, "run-1", &[result]).unwrap();

        let persisted = std::fs::read_to_string(v2_run_file_path(&test_root, "run-1")).unwrap();
        assert!(!persisted.contains("secret"));
        assert!(!persisted.contains("demo"));
        assert!(!persisted.contains("abc123"));

        let loaded = load_run_file(&test_root, "run-1").unwrap();
        assert_eq!(
            loaded[0].catchup_source.as_deref(),
            Some("https://example.com/timeshift?username=REDACTED&token=REDACTED")
        );

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v2_retention_removes_old_entries_and_run_files() {
        let test_root = create_test_root_dir("v2-retention");
        std::fs::create_dir_all(&test_root).unwrap();

        let config = make_config("/tmp/sample.m3u8", None);
        let results = vec![sample_result("http://example.com/a", ChannelStatus::Alive)];
        let summary = make_summary(1, 0);

        for i in 1..=5 {
            std::thread::sleep(Duration::from_millis(2));
            append_scan_history_at_dir(
                &test_root,
                &format!("run-{}", i),
                &config,
                &summary,
                results.clone(),
                3, // only keep 3
            )
            .unwrap();
        }

        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(history.len(), 3);

        // Per-run files for run-1 and run-2 should be deleted
        assert!(!v2_run_file_path(&test_root, "run-1").exists());
        assert!(!v2_run_file_path(&test_root, "run-2").exists());
        // Per-run files for run-3, run-4, run-5 should exist
        assert!(v2_run_file_path(&test_root, "run-3").exists());
        assert!(v2_run_file_path(&test_root, "run-4").exists());
        assert!(v2_run_file_path(&test_root, "run-5").exists());

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v2_clear_history_removes_entries_and_run_files() {
        let test_root = create_test_root_dir("v2-clear");
        std::fs::create_dir_all(&test_root).unwrap();

        let config = make_config("/tmp/sample.m3u8", None);
        let results = vec![sample_result("http://example.com/a", ChannelStatus::Alive)];
        let summary = make_summary(1, 0);

        append_scan_history_at_dir(&test_root, "run-1", &config, &summary, results.clone(), 20)
            .unwrap();
        std::thread::sleep(Duration::from_millis(2));
        append_scan_history_at_dir(&test_root, "run-2", &config, &summary, results, 20).unwrap();

        let removed = clear_scan_history_at_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(removed, 2);

        // History should be empty
        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert!(history.is_empty());

        // Per-run files should be deleted
        assert!(!v2_run_file_path(&test_root, "run-1").exists());
        assert!(!v2_run_file_path(&test_root, "run-2").exists());

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v1_migration_preserves_history_and_computes_diffs() {
        let test_root = create_test_root_dir("v1-migration");
        std::fs::create_dir_all(&test_root).unwrap();

        // Write a v1 store directly
        let v1_store = ScanHistoryStoreV1 {
            entries: vec![
                PersistedScanHistoryEntryV1 {
                    id: "old-run-1".to_string(),
                    playlist_key: "/tmp/sample.m3u8".to_string(),
                    scanned_at_epoch_ms: 1000,
                    summary: make_summary(2, 0),
                    group_filter: None,
                    channel_search: None,
                    selected_count: 0,
                    scope_key: "group=*|channel_search=*|selected:*".to_string(),
                    results: vec![
                        sample_result("http://example.com/a", ChannelStatus::Alive),
                        sample_result("http://example.com/b", ChannelStatus::Alive),
                    ],
                },
                PersistedScanHistoryEntryV1 {
                    id: "old-run-2".to_string(),
                    playlist_key: "/tmp/sample.m3u8".to_string(),
                    scanned_at_epoch_ms: 2000,
                    summary: make_summary(1, 1),
                    group_filter: None,
                    channel_search: None,
                    selected_count: 0,
                    scope_key: "group=*|channel_search=*|selected:*".to_string(),
                    results: vec![
                        sample_result("http://example.com/a", ChannelStatus::Dead),
                        sample_result("http://example.com/b", ChannelStatus::Alive),
                    ],
                },
            ],
        };
        let v1_path = v1_history_path(&test_root);
        let bytes = serde_json::to_vec(&v1_store).unwrap();
        std::fs::write(&v1_path, bytes).unwrap();

        // Access history — should trigger migration
        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, "old-run-2");
        assert_eq!(history[1].id, "old-run-1");

        // old-run-2 should have a diff against old-run-1
        let diff = history[0].diff.as_ref().expect("should have diff");
        assert_eq!(diff.became_dead, 1); // a went alive -> dead

        // old-run-1 has no diff
        assert!(history[1].diff.is_none());

        // v1 file should be backed up
        assert!(!v1_path.exists());
        assert!(v1_backup_path(&test_root).exists());

        // v2 index and per-run files should exist
        assert!(v2_index_path(&test_root).exists());
        assert!(v2_run_file_path(&test_root, "old-run-1").exists());
        assert!(v2_run_file_path(&test_root, "old-run-2").exists());

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v2_different_scope_keys_do_not_produce_diff() {
        let test_root = create_test_root_dir("v2-scope-keys");
        std::fs::create_dir_all(&test_root).unwrap();

        let config1 = make_config("/tmp/sample.m3u8", None);
        let mut config2 = make_config("/tmp/sample.m3u8", None);
        config2.group_filter = Some("Sports".to_string());

        let results = vec![sample_result("http://example.com/a", ChannelStatus::Alive)];
        let summary = make_summary(1, 0);

        append_scan_history_at_dir(&test_root, "run-1", &config1, &summary, results.clone(), 20)
            .unwrap();
        std::thread::sleep(Duration::from_millis(2));
        append_scan_history_at_dir(&test_root, "run-2", &config2, &summary, results, 20).unwrap();

        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(history.len(), 2);
        // run-2 has different scope_key from run-1, so no diff
        assert!(history[0].diff.is_none());
        assert!(history[1].diff.is_none());

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v2_same_selection_size_but_different_indices_do_not_produce_diff() {
        let test_root = create_test_root_dir("v2-selection-scope-keys");
        std::fs::create_dir_all(&test_root).unwrap();

        let mut config1 = make_config("/tmp/sample.m3u8", None);
        config1.selected_indices = Some(vec![1, 5]);
        let mut config2 = make_config("/tmp/sample.m3u8", None);
        config2.selected_indices = Some(vec![2, 6]);

        let results = vec![sample_result("http://example.com/a", ChannelStatus::Alive)];
        let summary = make_summary(1, 0);

        append_scan_history_at_dir(&test_root, "run-1", &config1, &summary, results.clone(), 20)
            .unwrap();
        std::thread::sleep(Duration::from_millis(2));
        append_scan_history_at_dir(&test_root, "run-2", &config2, &summary, results, 20).unwrap();

        let history = get_scan_history_from_dir(&test_root, "/tmp/sample.m3u8", None).unwrap();
        assert_eq!(history.len(), 2);
        assert!(history[0].diff.is_none());
        assert!(history[1].diff.is_none());

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn v2_retention_does_not_affect_other_playlists() {
        let test_root = create_test_root_dir("v2-retention-isolation");
        std::fs::create_dir_all(&test_root).unwrap();

        let config_a = make_config("/tmp/playlist-a.m3u8", None);
        let config_b = make_config("/tmp/playlist-b.m3u8", None);
        let results = vec![sample_result("http://example.com/a", ChannelStatus::Alive)];
        let summary = make_summary(1, 0);

        // Add 3 entries for playlist-a
        for i in 1..=3 {
            std::thread::sleep(Duration::from_millis(2));
            append_scan_history_at_dir(
                &test_root,
                &format!("a-run-{}", i),
                &config_a,
                &summary,
                results.clone(),
                2, // keep 2
            )
            .unwrap();
        }

        // Add 1 entry for playlist-b
        append_scan_history_at_dir(&test_root, "b-run-1", &config_b, &summary, results, 20)
            .unwrap();

        // playlist-a should have 2 entries
        let history_a =
            get_scan_history_from_dir(&test_root, "/tmp/playlist-a.m3u8", None).unwrap();
        assert_eq!(history_a.len(), 2);

        // playlist-b should be unaffected
        let history_b =
            get_scan_history_from_dir(&test_root, "/tmp/playlist-b.m3u8", None).unwrap();
        assert_eq!(history_b.len(), 1);
        assert_eq!(history_b[0].id, "b-run-1");

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[tokio::test]
    async fn url_playlist_history_continues_across_reruns_and_generates_diff() {
        let test_root = create_test_root_dir("url-history");
        let data_dir = test_root.join("app-data");
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
            None,
            &data_dir,
            &format!(" http://LOCALHOST:{}/playlist.m3u8#first ", address.port()),
            None,
            None,
        )
        .await
        .expect("first URL playlist open should succeed");

        let second_preview = crate::commands::playlist::open_playlist_url_from_data_dir(
            None,
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

        // Use a common base_dir for history (not file path)
        let history_dir = test_root.join("history-data");
        std::fs::create_dir_all(&history_dir).unwrap();

        append_scan_history_at_dir(
            &history_dir,
            "url-run-1",
            &build_scan_config(&first_preview),
            &summarize_results(&first_results),
            first_results,
            20,
        )
        .expect("first history append should succeed");

        std::thread::sleep(Duration::from_millis(2));

        append_scan_history_at_dir(
            &history_dir,
            "url-run-2",
            &build_scan_config(&second_preview),
            &summarize_results(&second_results),
            second_results,
            20,
        )
        .expect("second history append should succeed");

        let history = get_scan_history_from_dir(
            &history_dir,
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
