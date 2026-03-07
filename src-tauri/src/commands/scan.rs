use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::commands::history;
use crate::commands::settings;
use crate::engine::{checker, connectivity, disk, ffmpeg, parser, proxy, resume};
use crate::error::AppError;
use crate::models::backend_perf::BackendPerfSample;
use crate::models::channel::{Channel, ChannelResult, ChannelStatus};
use crate::models::playlist::PlaylistPreview;
use crate::models::scan::{
    PlaylistScore, RetryBackoff, ScanConfig, ScanErrorPayload, ScanEvent, ScanProgress,
    ScanResultBatchPayload, ScanSummary,
};
use crate::models::scan_log::{ChannelDebugLog, ScanDebugLog};
use crate::state::AppState;

static NEXT_SCAN_RUN_ID: AtomicU64 = AtomicU64::new(1);
const PROGRESS_EMIT_INTERVAL_MS: u64 = 50;
const CHECKPOINT_FLUSH_INTERVAL_MS: u64 = 250;
const CHECKPOINT_FLUSH_MAX_BATCH: usize = 128;
const RESULT_BATCH_MAX_ITEMS: usize = 64;

#[derive(Debug, Clone)]
struct SharedUrlResult {
    status: ChannelStatus,
    drm_system: Option<String>,
    latency_ms: Option<u64>,
    codec: Option<String>,
    resolution: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    video_bitrate: Option<String>,
    audio_bitrate: Option<String>,
    audio_codec: Option<String>,
    audio_only: bool,
    screenshot_path: Option<String>,
    low_framerate: bool,
    stream_url: Option<String>,
    retry_count: Option<u32>,
    error_reason: Option<String>,
    channel_log: ChannelDebugLog,
}

impl SharedUrlResult {
    fn dead(
        stream_url: Option<String>,
        latency_ms: Option<u64>,
        retry_count: Option<u32>,
        error_reason: Option<String>,
        channel_log: ChannelDebugLog,
    ) -> Self {
        Self {
            status: ChannelStatus::Dead,
            drm_system: None,
            latency_ms,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_only: false,
            screenshot_path: None,
            low_framerate: false,
            stream_url,
            retry_count,
            error_reason,
            channel_log,
        }
    }
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

async fn compute_shared_url_result(
    app: &AppHandle,
    client: &reqwest::Client,
    channel_url: &str,
    timeout: f64,
    retries: u32,
    retry_backoff: RetryBackoff,
    extended_timeout: Option<f64>,
    user_agent: &str,
    cancel: &CancellationToken,
    proxy_list: &Option<Vec<String>>,
    test_geoblock: bool,
    ffmpeg_ok: bool,
    ffprobe_ok: bool,
    profile_bitrate_flag: bool,
    ffprobe_timeout_secs: f64,
    ffmpeg_bitrate_timeout_secs: f64,
    low_fps_threshold: f64,
    skip_screenshots: bool,
    screenshots_dir: Option<&String>,
    screenshot_file_name: &str,
    screenshot_format: crate::models::settings::ScreenshotFormat,
    diagnostics_semaphore: &Arc<Semaphore>,
) -> Result<(SharedUrlResult, WorkerTiming), AppError> {
    let check_started_at = Instant::now();
    let check_outcome = if checker::uses_ffprobe_liveness(channel_url) {
        checker::check_channel_status_with_ffprobe_debug(
            app,
            channel_url,
            ffprobe_timeout_secs,
            retries,
            retry_backoff,
            None,
            ffprobe_ok,
            cancel,
        )
        .await
    } else {
        checker::check_channel_status_with_debug(
            client,
            channel_url,
            timeout,
            retries,
            retry_backoff,
            extended_timeout,
            user_agent,
            cancel,
        )
        .await
    };

    let (
        status_str,
        stream_url,
        latency_ms,
        retry_count,
        error_reason,
        drm_system,
        mut channel_log,
    ) = match check_outcome {
        Ok(outcome) => (
            outcome.status,
            outcome.stream_url,
            outcome.latency_ms,
            outcome.retries_used,
            outcome.last_error_reason,
            outcome.drm_system,
            outcome.debug_log,
        ),
        Err(AppError::Cancelled) => return Err(AppError::Cancelled),
        Err(error) => (
            "Dead".to_string(),
            None,
            None,
            0,
            Some(error.to_string()),
            None,
            ChannelDebugLog {
                channel_url: channel_url.to_string(),
                final_verdict: "Dead".to_string(),
                final_reason: Some(error.to_string()),
                ..ChannelDebugLog::default()
            },
        ),
    };
    let check_ms = check_started_at.elapsed().as_secs_f64() * 1000.0;

    let final_status_str = if status_str == "Geoblocked" && test_geoblock {
        if let Some(proxies) = proxy_list {
            if !proxies.is_empty() {
                proxy::confirm_geoblock(channel_url, proxies, timeout).await
            } else {
                status_str
            }
        } else {
            status_str
        }
    } else {
        status_str
    };

    let status = match final_status_str.as_str() {
        "Alive" => ChannelStatus::Alive,
        "DRM" => ChannelStatus::Drm,
        "Dead" => ChannelStatus::Dead,
        "Placeholder" => ChannelStatus::Placeholder,
        "Geoblocked" => ChannelStatus::Geoblocked,
        "Geoblocked (Confirmed)" => ChannelStatus::GeoblockedConfirmed,
        "Geoblocked (Unconfirmed)" => ChannelStatus::GeoblockedUnconfirmed,
        _ => ChannelStatus::Dead,
    };
    channel_log.final_verdict = final_status_str;
    if channel_log.final_reason.is_none() {
        channel_log.final_reason = error_reason.clone();
    }

    let mut timing = WorkerTiming {
        check_ms,
        diagnostics_ms: 0.0,
    };

    if !matches!(status, ChannelStatus::Alive | ChannelStatus::Drm) || cancel.is_cancelled() {
        let effective_status = if cancel.is_cancelled() {
            ChannelStatus::Dead
        } else {
            status
        };
        return Ok((
            SharedUrlResult {
                status: effective_status,
                drm_system: None,
                latency_ms,
                codec: None,
                resolution: None,
                width: None,
                height: None,
                fps: None,
                video_bitrate: None,
                audio_bitrate: None,
                audio_codec: None,
                audio_only: false,
                screenshot_path: None,
                low_framerate: false,
                stream_url,
                retry_count: (retry_count > 0).then_some(retry_count),
                error_reason,
                channel_log,
            },
            timing,
        ));
    }

    let target_url = stream_url.as_deref().unwrap_or(channel_url).to_string();
    let mut shared = SharedUrlResult {
        status: status.clone(),
        drm_system,
        latency_ms,
        codec: None,
        resolution: None,
        width: None,
        height: None,
        fps: None,
        video_bitrate: None,
        audio_bitrate: None,
        audio_codec: None,
        audio_only: false,
        screenshot_path: None,
        low_framerate: false,
        stream_url,
        retry_count: (retry_count > 0).then_some(retry_count),
        error_reason,
        channel_log,
    };

    // DRM-protected streams are reported distinctly without expensive diagnostics.
    if status == ChannelStatus::Drm {
        return Ok((shared, timing));
    }
    let diagnostics_started_at = Instant::now();
    let _diagnostics_permit = diagnostics_semaphore.clone().acquire_owned().await.ok();
    let ffprobe_timeout_duration =
        std::time::Duration::from_secs_f64(ffprobe_timeout_secs.clamp(1.0, 300.0));

    // Run ffprobe and screenshot capture in parallel — they are independent.
    // Bitrate profiling runs alongside screenshot after ffprobe starts.
    let want_screenshot = !skip_screenshots && ffmpeg_ok && screenshots_dir.is_some();

    let ffprobe_fut = async {
        if !ffprobe_ok {
            return None;
        }
        ffmpeg::collect_probe_snapshot_with_timeout(
            app,
            &target_url,
            cancel,
            Some(ffprobe_timeout_duration),
        )
        .await
        .ok()
    };

    let screenshot_fut = async {
        if !want_screenshot || cancel.is_cancelled() {
            return None;
        }
        let dir = screenshots_dir.unwrap();
        ffmpeg::capture_screenshot(
            app,
            &target_url,
            dir,
            screenshot_file_name,
            user_agent,
            screenshot_format,
            cancel,
        )
        .await
        .ok()
    };

    let (probe_result, screenshot_result) = tokio::join!(ffprobe_fut, screenshot_fut);

    if let Some(snapshot) = probe_result {
        shared.audio_only = snapshot.track_presence.has_audio && !snapshot.track_presence.has_video;
        if let Some(info) = snapshot.video_info {
            if !shared.audio_only {
                shared.codec = Some(info.codec);
                shared.resolution = Some(info.resolution.clone());
                shared.width = info.width;
                shared.height = info.height;
                shared.fps = info.fps;
                shared.low_framerate = info
                    .fps
                    .map(|fps| (fps as f64) <= low_fps_threshold)
                    .unwrap_or(false);
            }
        }
        if let Some(audio) = snapshot.audio_info {
            shared.audio_codec = Some(audio.codec);
            shared.audio_bitrate = audio.bitrate_kbps.map(|b| format!("{}", b));
        }
        shared.channel_log.ffprobe_output = Some(snapshot.ffprobe_output);
    }

    if let Some(path) = screenshot_result {
        shared.screenshot_path = Some(path);
    }

    if ffprobe_ok && !cancel.is_cancelled() && profile_bitrate_flag && ffmpeg_ok {
        if let Ok(bitrate) = ffmpeg::profile_bitrate(
            app,
            &target_url,
            user_agent,
            ffmpeg_bitrate_timeout_secs,
            cancel,
        )
        .await
        {
            shared.video_bitrate = Some(bitrate);
        }
    }
    timing.diagnostics_ms = diagnostics_started_at.elapsed().as_secs_f64() * 1000.0;

    Ok((shared, timing))
}

fn try_mark_scan_started(scanning: &mut bool) -> Result<(), AppError> {
    if *scanning {
        return Err(AppError::Other("A scan is already in progress".to_string()));
    }
    *scanning = true;
    Ok(())
}

fn mark_scan_finished(scanning: &mut bool) {
    *scanning = false;
}

fn sanitize_scope_suffix(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>();
    if sanitized.is_empty() {
        "Any".to_string()
    } else {
        sanitized
    }
}

fn cleanup_resume_files(log_file: &str, checkpoint_file: &str) {
    let _ = std::fs::remove_file(log_file);
    let _ = std::fs::remove_file(checkpoint_file);
}

fn emit_scan_error_event(app: &AppHandle, run_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        "scan://error",
        ScanEvent {
            run_id: run_id.to_string(),
            payload: ScanErrorPayload {
                message: message.into(),
            },
        },
    );
}

async fn cancel_scan_token(state: &AppState, scan_scope: &str) {
    let (token, pause_notify) = state
        .with_window_scan_state(scan_scope, |scan_state| {
            (
                scan_state.cancel_token.clone(),
                scan_state.pause_notify.clone(),
            )
        })
        .await;
    if let Some(cancel) = token {
        cancel.cancel();
    }
    pause_notify.notify_waiters();
}

async fn wait_if_paused(state: &AppState, scan_scope: &str, cancel: &CancellationToken) -> bool {
    loop {
        if cancel.is_cancelled() {
            return false;
        }

        let (paused, pause_notify) = state
            .with_window_scan_state(scan_scope, |scan_state| {
                (scan_state.paused, scan_state.pause_notify.clone())
            })
            .await;
        if !paused {
            return true;
        }

        tokio::select! {
            _ = cancel.cancelled() => return false,
            _ = pause_notify.notified() => {}
        }
    }
}

async fn reset_scan_state(state: &AppState, scan_scope: &str) {
    cancel_scan_token(state, scan_scope).await;
    clear_pre_spawn_scan_state(state, scan_scope).await;
}

async fn clear_pre_spawn_scan_state(state: &AppState, scan_scope: &str) {
    state
        .with_window_scan_state(scan_scope, |scan_state| {
            mark_scan_finished(&mut scan_state.scanning);
            scan_state.paused = false;
            scan_state.current_run_id = None;
            scan_state.cancel_token = None;
            scan_state.pause_notify.notify_waiters();
        })
        .await;
}

/// Clear scan state only if the current run_id still matches the finishing scan.
/// This prevents a finishing scan from accidentally wiping state that belongs to
/// a new scan that started during the cleanup window.
async fn clear_scan_state_for_run(state: &AppState, scan_scope: &str, finished_run_id: &str) {
    state
        .with_window_scan_state(scan_scope, |scan_state| {
            if scan_state.current_run_id.as_deref() != Some(finished_run_id) {
                return;
            }
            scan_state.current_run_id = None;
            mark_scan_finished(&mut scan_state.scanning);
            scan_state.paused = false;
            scan_state.cancel_token = None;
            scan_state.pause_notify.notify_waiters();
        })
        .await;
}

#[derive(Debug, Default, Clone, Copy)]
struct ScanCounters {
    completed: usize,
    alive: usize,
    dead: usize,
    placeholder: usize,
    geoblocked: usize,
    drm: usize,
    low_framerate: usize,
    mislabeled: usize,
}

#[derive(Debug, Clone)]
struct CompletedScanData {
    summary: ScanSummary,
    results: Vec<ChannelResult>,
    channel_logs: Vec<ChannelDebugLog>,
}

#[derive(Debug, Clone)]
struct WorkerOutput {
    result: ChannelResult,
    channel_log: ChannelDebugLog,
}

#[derive(Debug, Clone, Copy, Default)]
struct WorkerTiming {
    check_ms: f64,
    diagnostics_ms: f64,
}

impl ScanCounters {
    fn apply(&mut self, result: &ChannelResult) {
        match result.status {
            ChannelStatus::Alive => self.alive += 1,
            ChannelStatus::Dead => self.dead += 1,
            ChannelStatus::Placeholder => self.placeholder += 1,
            ChannelStatus::Drm => self.drm += 1,
            ChannelStatus::Geoblocked
            | ChannelStatus::GeoblockedConfirmed
            | ChannelStatus::GeoblockedUnconfirmed => self.geoblocked += 1,
            _ => {}
        }

        if result.low_framerate {
            self.low_framerate += 1;
        }
        if !result.label_mismatches.is_empty() {
            self.mislabeled += 1;
        }
        self.completed += 1;
    }

    fn as_progress(&self, total: usize) -> ScanProgress {
        ScanProgress {
            completed: self.completed,
            total,
            alive: self.alive,
            dead: self.dead,
            placeholder: self.placeholder,
            geoblocked: self.geoblocked,
            drm: self.drm,
        }
    }

    fn as_summary(&self, total: usize) -> ScanSummary {
        ScanSummary {
            total,
            alive: self.alive,
            dead: self.dead,
            placeholder: self.placeholder,
            geoblocked: self.geoblocked,
            drm: self.drm,
            low_framerate: self.low_framerate,
            mislabeled: self.mislabeled,
            playlist_score: None,
        }
    }
}

fn clamp_01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn clamp_score_10(value: f64) -> f64 {
    value.clamp(0.0, 10.0)
}

fn round_to_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn median_u64(values: &[u64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        Some(sorted[mid] as f64)
    } else {
        Some((sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0)
    }
}

fn is_hd_or_uhd(result: &ChannelResult) -> bool {
    if let (Some(width), Some(height)) = (result.width, result.height) {
        if width >= 1280 && height >= 720 {
            return true;
        }
    }
    if let Some(resolution) = result.resolution.as_ref() {
        let normalized = resolution.to_ascii_lowercase();
        return normalized.contains("720")
            || normalized.contains("1080")
            || normalized.contains("1440")
            || normalized.contains("2160")
            || normalized.contains("4k")
            || normalized.contains("uhd");
    }
    false
}

fn codec_tier_score(codec: Option<&str>) -> f64 {
    let Some(codec) = codec else {
        return 0.4;
    };
    let normalized = codec.to_ascii_lowercase();
    if normalized.contains("hevc") || normalized.contains("h265") || normalized.contains("h.265") {
        return 1.0;
    }
    if normalized.contains("av1") {
        return 1.0;
    }
    if normalized.contains("h264") || normalized.contains("h.264") || normalized.contains("avc") {
        return 0.8;
    }
    if normalized.contains("mpeg") || normalized.contains("vp9") {
        return 0.6;
    }
    0.5
}

fn compute_playlist_score(
    results: &[ChannelResult],
    total_channels: usize,
) -> Option<PlaylistScore> {
    if total_channels == 0 {
        return None;
    }

    let alive_results = results
        .iter()
        .filter(|result| result.status == ChannelStatus::Alive)
        .collect::<Vec<_>>();
    let alive_count = alive_results.len();

    let ping_score = {
        let latencies = alive_results
            .iter()
            .filter_map(|result| result.latency_ms)
            .collect::<Vec<_>>();
        let p50 = median_u64(&latencies);
        let raw = if let Some(p50) = p50 {
            // 100ms ~= excellent (10), 1200ms ~= poor (0)
            (1200.0 - p50) / 1100.0 * 10.0
        } else {
            0.0
        };
        clamp_score_10(raw)
    };

    let content_score = {
        let alive_ratio = alive_count as f64 / total_channels as f64;
        let unique_groups = results
            .iter()
            .map(|result| result.group.trim().to_ascii_lowercase())
            .filter(|group| !group.is_empty())
            .collect::<HashSet<_>>()
            .len();
        let diversity_ratio = clamp_01(unique_groups as f64 / 20.0);
        let epg_covered = results
            .iter()
            .filter(|result| {
                result
                    .tvg_id
                    .as_deref()
                    .map(str::trim)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
            })
            .count();
        let epg_ratio = epg_covered as f64 / total_channels as f64;

        clamp_score_10((alive_ratio * 0.6 + diversity_ratio * 0.2 + epg_ratio * 0.2) * 10.0)
    };

    let quality_score = {
        if alive_results.is_empty() {
            0.0
        } else {
            let hd_ratio = alive_results
                .iter()
                .filter(|result| is_hd_or_uhd(result))
                .count() as f64
                / alive_results.len() as f64;

            let codec_avg = alive_results
                .iter()
                .map(|result| codec_tier_score(result.codec.as_deref()))
                .sum::<f64>()
                / alive_results.len() as f64;

            let fps_known = alive_results
                .iter()
                .filter(|result| result.fps.is_some())
                .count();
            let fps_ratio = if fps_known == 0 {
                0.0
            } else {
                alive_results
                    .iter()
                    .filter(|result| result.fps.unwrap_or_default() >= 25)
                    .count() as f64
                    / fps_known as f64
            };

            clamp_score_10((hd_ratio * 0.5 + codec_avg * 0.3 + fps_ratio * 0.2) * 10.0)
        }
    };

    let overall_score =
        clamp_score_10(ping_score * 0.25 + content_score * 0.40 + quality_score * 0.35);

    Some(PlaylistScore {
        overall: round_to_tenth(overall_score),
        ping: round_to_tenth(ping_score),
        content: round_to_tenth(content_score),
        quality: round_to_tenth(quality_score),
    })
}

fn filter_channels_by_selection(
    channels: &mut Vec<Channel>,
    selected_indices: &Option<Vec<usize>>,
) {
    if let Some(selected_indices) = selected_indices {
        let selected: HashSet<usize> = selected_indices.iter().copied().collect();
        channels.retain(|channel| selected.contains(&channel.index));
    }
}

fn next_scan_run_id() -> String {
    format!(
        "scan-run-{}",
        NEXT_SCAN_RUN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn record_backend_perf(
    app: &AppHandle,
    state: &Arc<AppState>,
    metric: &str,
    value_ms: f64,
    run_id: Option<&str>,
) {
    if !cfg!(debug_assertions) {
        return;
    }

    let sample = BackendPerfSample {
        metric: metric.to_string(),
        value_ms,
        run_id: run_id.map(str::to_string),
        recorded_at_epoch_ms: now_epoch_ms(),
    };
    state.push_backend_perf_sample(sample.clone()).await;
    let _ = app.emit("scan://backend-perf", sample);
}

fn source_mtime_ms(path: &str) -> Option<u64> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn playlist_preview_cache_key(config: &ScanConfig) -> String {
    format!(
        "{}|g:{}|s:{}",
        config.file_path,
        config.group_filter.as_deref().unwrap_or("*"),
        config.channel_search.as_deref().unwrap_or("*")
    )
}

async fn parse_playlist_with_cache(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &ScanConfig,
    run_id: &str,
) -> Result<PlaylistPreview, AppError> {
    let source_mtime = source_mtime_ms(&config.file_path);
    let cache_key = playlist_preview_cache_key(config);
    if let Some(cached) = state
        .get_cached_playlist_preview(&cache_key, source_mtime)
        .await
    {
        return Ok(cached);
    }

    let parse_started_at = Instant::now();
    let preview = parser::parse_playlist(
        &config.file_path,
        &config.group_filter,
        &config.channel_search,
    )?;
    let parse_ms = parse_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(
        app,
        state,
        "scan.preflight.parse_ms",
        parse_ms,
        Some(run_id),
    )
    .await;
    state
        .put_cached_playlist_preview(cache_key, preview.clone(), source_mtime)
        .await;
    Ok(preview)
}

async fn emit_channel_result_event(
    app: &AppHandle,
    state: &Arc<AppState>,
    run_id: &str,
    result: ChannelResult,
) {
    let emit_started_at = Instant::now();
    let _ = app.emit(
        "scan://channel-result",
        ScanEvent {
            run_id: run_id.to_string(),
            payload: result,
        },
    );
    let emit_ms = emit_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(app, state, "scan.event_emit_ms", emit_ms, Some(run_id)).await;
}

async fn emit_progress_event(
    app: &AppHandle,
    state: &Arc<AppState>,
    run_id: &str,
    progress: ScanProgress,
) {
    let emit_started_at = Instant::now();
    let _ = app.emit(
        "scan://progress",
        ScanEvent {
            run_id: run_id.to_string(),
            payload: progress,
        },
    );
    let emit_ms = emit_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(app, state, "scan.event_emit_ms", emit_ms, Some(run_id)).await;
}

async fn emit_result_batch_event(
    app: &AppHandle,
    state: &Arc<AppState>,
    run_id: &str,
    items: Vec<ChannelResult>,
    progress: ScanProgress,
) {
    if items.is_empty() {
        return;
    }
    let emit_started_at = Instant::now();
    let _ = app.emit(
        "scan://channel-results-batch",
        ScanEvent {
            run_id: run_id.to_string(),
            payload: ScanResultBatchPayload { items, progress },
        },
    );
    let emit_ms = emit_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(app, state, "scan.event_emit_ms", emit_ms, Some(run_id)).await;
}

async fn flush_checkpoint_entries(
    log_file: &str,
    checkpoint_file: &str,
    pending: &mut Vec<resume::CheckpointWriteEntry>,
    app: &AppHandle,
    state: &Arc<AppState>,
    run_id: &str,
) {
    if pending.is_empty() {
        return;
    }
    let batch = std::mem::take(pending);
    let log_path = log_file.to_string();
    let checkpoint_path = checkpoint_file.to_string();
    let flush_started_at = Instant::now();
    let flush_result = tokio::task::spawn_blocking(move || {
        resume::write_entries(&log_path, &checkpoint_path, &batch)
    })
    .await;
    let flush_ms = flush_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(
        app,
        state,
        "scan.checkpoint_flush_ms",
        flush_ms,
        Some(run_id),
    )
    .await;

    match flush_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            log::warn!("Failed to flush checkpoint batch for {}: {}", run_id, error);
        }
        Err(error) => {
            log::warn!(
                "Checkpoint writer task join failure for {}: {}",
                run_id,
                error
            );
        }
    }
}

async fn run_checkpoint_writer(
    mut rx: tokio::sync::mpsc::Receiver<resume::CheckpointWriteEntry>,
    log_file: String,
    checkpoint_file: String,
    app: AppHandle,
    state: Arc<AppState>,
    run_id: String,
) {
    let mut pending =
        Vec::<resume::CheckpointWriteEntry>::with_capacity(CHECKPOINT_FLUSH_MAX_BATCH);
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(
        CHECKPOINT_FLUSH_INTERVAL_MS,
    ));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            maybe_entry = rx.recv() => {
                match maybe_entry {
                    Some(entry) => {
                        pending.push(entry);
                        if pending.len() >= CHECKPOINT_FLUSH_MAX_BATCH {
                            flush_checkpoint_entries(
                                &log_file,
                                &checkpoint_file,
                                &mut pending,
                                &app,
                                &state,
                                &run_id,
                            )
                            .await;
                        }
                    }
                    None => {
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                flush_checkpoint_entries(
                    &log_file,
                    &checkpoint_file,
                    &mut pending,
                    &app,
                    &state,
                    &run_id,
                )
                .await;
            }
        }
    }

    flush_checkpoint_entries(
        &log_file,
        &checkpoint_file,
        &mut pending,
        &app,
        &state,
        &run_id,
    )
    .await;
}

async fn execute_scan_run(
    app: AppHandle,
    state: Arc<AppState>,
    scan_scope: String,
    run_id: String,
    scan_started_at_epoch_ms: u64,
    config: ScanConfig,
    cancel_token: CancellationToken,
) -> Result<(), AppError> {
    log::info!(
        "Starting scan {} for window '{}': {} (concurrency: {}, retries: {}, retry_backoff: {:?})",
        run_id,
        scan_scope,
        config.file_path,
        config.concurrency,
        config.retries,
        config.retry_backoff
    );

    let preview = parse_playlist_with_cache(&app, &state, &config, &run_id).await?;
    let mut channels = preview.channels;
    filter_channels_by_selection(&mut channels, &config.selected_indices);
    let total = channels.len();
    log::info!("Scan {}: {} channels to check", run_id, total);

    if total == 0 {
        let summary = ScanSummary {
            total: 0,
            alive: 0,
            dead: 0,
            placeholder: 0,
            geoblocked: 0,
            drm: 0,
            low_framerate: 0,
            mislabeled: 0,
            playlist_score: None,
        };

        let _ = app.emit(
            "scan://complete",
            ScanEvent {
                run_id: run_id.clone(),
                payload: summary.clone(),
            },
        );
        let history_limit = {
            let settings = state.settings.lock().await;
            settings.scan_history_limit as usize
        };
        if let Err(error) = history::append_scan_history(
            &app,
            &run_id,
            &config,
            &summary,
            Vec::new(),
            history_limit,
        ) {
            log::warn!("Failed to write scan history for {}: {}", run_id, error);
        }
        state
            .with_window_scan_state(&scan_scope, |scan_state| {
                scan_state.scan_log = Some(ScanDebugLog {
                    run_id: run_id.clone(),
                    playlist_path: config.file_path.clone(),
                    source_identity: config.source_identity.clone(),
                    started_at_epoch_ms: scan_started_at_epoch_ms,
                    finished_at_epoch_ms: now_epoch_ms(),
                    summary,
                    channels: Vec::new(),
                });
            })
            .await;
        return Ok(());
    }

    // Resume support
    let resume_started_at = Instant::now();
    let playlist_path = std::path::Path::new(&config.file_path);
    let base_name = playlist_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let playlist_dir = playlist_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let group_suffix = config
        .group_filter
        .as_deref()
        .map(sanitize_scope_suffix)
        .unwrap_or_else(|| "AllGroups".to_string());
    let search_suffix = config
        .channel_search
        .as_deref()
        .map(sanitize_scope_suffix)
        .unwrap_or_else(|| "AllChannels".to_string());
    let scope_suffix = format!("{}_{}", group_suffix, search_suffix);

    let log_file = format!(
        "{}/{}_{}_checklog.txt",
        playlist_dir, base_name, scope_suffix
    );
    let checkpoint_file = format!(
        "{}/{}_{}_checkpoint.jsonl",
        playlist_dir, base_name, scope_suffix
    );

    let channel_indices: HashSet<usize> = channels.iter().map(|channel| channel.index).collect();
    let mut resumed_results = resume::load_checkpoint_results(&checkpoint_file)
        .into_iter()
        .filter(|result| channel_indices.contains(&result.index))
        .collect::<Vec<_>>();
    resumed_results.sort_by_key(|result| result.index);

    let resumed_indices: HashSet<usize> =
        resumed_results.iter().map(|result| result.index).collect();
    if resumed_indices.is_empty() {
        let log_file_clone = log_file.clone();
        let checkpoint_file_clone = checkpoint_file.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = std::fs::write(&log_file_clone, "");
            let _ = std::fs::remove_file(&checkpoint_file_clone);
        })
        .await;
    } else {
        channels.retain(|channel| !resumed_indices.contains(&channel.index));
        log::info!(
            "Resuming scan {} with {} completed channels and {} remaining",
            run_id,
            resumed_results.len(),
            channels.len()
        );
    }
    let resume_ms = resume_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(
        &app,
        &state,
        "scan.preflight.resume_load_ms",
        resume_ms,
        Some(&run_id),
    )
    .await;

    // Load proxies if configured
    let proxy_list = if config.test_geoblock {
        if let Some(ref proxy_file) = config.proxy_file {
            match proxy::load_proxy_list(proxy_file) {
                Ok(proxy_list) => {
                    log::info!("Loaded {} proxies from {}", proxy_list.len(), proxy_file);
                    Some(proxy_list)
                }
                Err(error) => {
                    return Err(AppError::Other(format!(
                        "Failed to load proxy file '{}': {}",
                        proxy_file, error
                    )));
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // Check ffmpeg availability
    let ffmpeg_check_started_at = Instant::now();
    let (ffmpeg_available, ffprobe_available) = ffmpeg::check_availability(&app).await;
    let ffmpeg_check_ms = ffmpeg_check_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(
        &app,
        &state,
        "scan.preflight.ffmpeg_check_ms",
        ffmpeg_check_ms,
        Some(&run_id),
    )
    .await;

    // Screenshots directory — use app temp dir by default (in-app preview only),
    // or a user-specified folder if configured.
    let (screenshot_retention_count, low_space_threshold_gb) = {
        let s = state.settings.lock().await;
        (s.screenshot_retention_count, s.low_space_threshold_gb)
    };
    let using_custom_screenshots_dir = config.screenshots_dir.is_some();
    let screenshots_dir = if !config.skip_screenshots && ffmpeg_available {
        let dir = match config.screenshots_dir.clone() {
            Some(d) => d,
            None => {
                let temp = app
                    .path()
                    .temp_dir()
                    .unwrap_or_else(|_| std::env::temp_dir());
                temp.join("iptv-checker-screenshots")
                    .join(format!("{}_{}", base_name, scope_suffix))
                    .to_string_lossy()
                    .to_string()
            }
        };
        {
            let dir_clone = dir.clone();
            tokio::task::spawn_blocking(move || std::fs::create_dir_all(&dir_clone))
                .await
                .map_err(|e| AppError::Other(format!("Failed to create screenshots directory: {}", e)))?
                .map_err(|e| AppError::Other(format!("Failed to create screenshots directory: {}", e)))?;
        }

        // Write scan metadata for eviction logic
        if !using_custom_screenshots_dir {
            let meta = serde_json::json!({
                "scan_started_at_epoch_ms": scan_started_at_epoch_ms,
                "source_identity": config.source_identity.clone().unwrap_or_default(),
                "playlist_file": config.file_path.clone(),
            });
            let meta_path = std::path::Path::new(&dir).join(".scan-meta.json");
            let meta_str = meta.to_string();
            match tokio::task::spawn_blocking(move || std::fs::write(&meta_path, meta_str)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => log::warn!("Failed to write scan metadata: {}", error),
                Err(error) => log::warn!("Failed to write scan metadata (join): {}", error),
            }

            // Pre-scan eviction: remove old dirs per retention policy
            let cache_root = std::path::Path::new(&dir)
                .parent()
                .unwrap_or_else(|| std::path::Path::new(&dir));
            let current_dir_name = std::path::Path::new(&dir)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut keep = HashSet::new();
            keep.insert(current_dir_name);
            let freed =
                settings::evict_old_screenshot_dirs(cache_root, &keep, screenshot_retention_count);
            if freed > 0 {
                log::info!(
                    "Pre-scan eviction freed {} bytes of screenshot cache",
                    freed
                );
            }
        }

        Some(dir)
    } else {
        None
    };

    let client = Arc::new(
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default(),
    );
    let semaphore = Arc::new(Semaphore::new(config.concurrency as usize));
    let diagnostics_limit = usize::max(1, usize::min(config.concurrency as usize, 4));
    let diagnostics_semaphore = Arc::new(Semaphore::new(diagnostics_limit));
    let (low_fps_threshold_setting, screenshot_format_setting) = {
        let settings = state.settings.lock().await;
        (settings.low_fps_threshold, settings.screenshot_format)
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<WorkerOutput>(256);
    let (checkpoint_tx, checkpoint_rx) =
        tokio::sync::mpsc::channel::<resume::CheckpointWriteEntry>(1024);

    let checkpoint_task = tokio::spawn(run_checkpoint_writer(
        checkpoint_rx,
        log_file.clone(),
        checkpoint_file.clone(),
        app.clone(),
        state.clone(),
        run_id.clone(),
    ));

    let app_for_events = app.clone();
    let state_for_events = state.clone();
    let run_id_for_events = run_id.clone();
    let batch_events_enabled = config
        .client_capabilities
        .as_ref()
        .map(|caps| caps.event_batch_v1)
        .unwrap_or(false);
    let event_task = tokio::spawn(async move {
        let mut counters = ScanCounters::default();
        let mut completed_results = Vec::with_capacity(total);
        let mut channel_logs = Vec::<ChannelDebugLog>::with_capacity(total);
        let mut pending_batch_results = Vec::<ChannelResult>::with_capacity(RESULT_BATCH_MAX_ITEMS);
        let mut first_result_emitted = false;
        let mut last_progress_emit = Instant::now()
            .checked_sub(std::time::Duration::from_millis(PROGRESS_EMIT_INTERVAL_MS))
            .unwrap_or_else(Instant::now);

        for result in resumed_results {
            counters.apply(&result);
            completed_results.push(result.clone());
            if batch_events_enabled {
                pending_batch_results.push(result);
                if pending_batch_results.len() >= RESULT_BATCH_MAX_ITEMS {
                    emit_result_batch_event(
                        &app_for_events,
                        &state_for_events,
                        &run_id_for_events,
                        std::mem::take(&mut pending_batch_results),
                        counters.as_progress(total),
                    )
                    .await;
                }
            } else {
                emit_channel_result_event(
                    &app_for_events,
                    &state_for_events,
                    &run_id_for_events,
                    result,
                )
                .await;
            }

            if last_progress_emit.elapsed().as_millis() as u64 >= PROGRESS_EMIT_INTERVAL_MS {
                if batch_events_enabled && !pending_batch_results.is_empty() {
                    emit_result_batch_event(
                        &app_for_events,
                        &state_for_events,
                        &run_id_for_events,
                        std::mem::take(&mut pending_batch_results),
                        counters.as_progress(total),
                    )
                    .await;
                }
                emit_progress_event(
                    &app_for_events,
                    &state_for_events,
                    &run_id_for_events,
                    counters.as_progress(total),
                )
                .await;
                last_progress_emit = Instant::now();
            }
        }

        while let Some(worker) = rx.recv().await {
            if !first_result_emitted {
                first_result_emitted = true;
                let time_to_first_ms =
                    now_epoch_ms().saturating_sub(scan_started_at_epoch_ms) as f64;
                record_backend_perf(
                    &app_for_events,
                    &state_for_events,
                    "scan.time_to_first_result_ms",
                    time_to_first_ms,
                    Some(&run_id_for_events),
                )
                .await;
            }

            counters.apply(&worker.result);
            completed_results.push(worker.result.clone());
            channel_logs.push(worker.channel_log);
            if batch_events_enabled {
                pending_batch_results.push(worker.result);
                if pending_batch_results.len() >= RESULT_BATCH_MAX_ITEMS {
                    emit_result_batch_event(
                        &app_for_events,
                        &state_for_events,
                        &run_id_for_events,
                        std::mem::take(&mut pending_batch_results),
                        counters.as_progress(total),
                    )
                    .await;
                }
            } else {
                emit_channel_result_event(
                    &app_for_events,
                    &state_for_events,
                    &run_id_for_events,
                    worker.result,
                )
                .await;
            }

            if last_progress_emit.elapsed().as_millis() as u64 >= PROGRESS_EMIT_INTERVAL_MS {
                if batch_events_enabled && !pending_batch_results.is_empty() {
                    emit_result_batch_event(
                        &app_for_events,
                        &state_for_events,
                        &run_id_for_events,
                        std::mem::take(&mut pending_batch_results),
                        counters.as_progress(total),
                    )
                    .await;
                }
                emit_progress_event(
                    &app_for_events,
                    &state_for_events,
                    &run_id_for_events,
                    counters.as_progress(total),
                )
                .await;
                last_progress_emit = Instant::now();
            }
        }

        if batch_events_enabled && !pending_batch_results.is_empty() {
            emit_result_batch_event(
                &app_for_events,
                &state_for_events,
                &run_id_for_events,
                std::mem::take(&mut pending_batch_results),
                counters.as_progress(total),
            )
            .await;
        }
        emit_progress_event(
            &app_for_events,
            &state_for_events,
            &run_id_for_events,
            counters.as_progress(total),
        )
        .await;

        CompletedScanData {
            summary: counters.as_summary(total),
            results: completed_results,
            channel_logs,
        }
    });

    let proxy_list = Arc::new(proxy_list);
    let shared_url_results: Arc<
        tokio::sync::Mutex<
            HashMap<
                String,
                Arc<tokio::sync::OnceCell<Result<(SharedUrlResult, WorkerTiming), AppError>>>,
            >,
        >,
    > = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    // Disk space tracking for screenshot pause
    let screenshots_paused = Arc::new(AtomicBool::new(false));
    let screenshots_paused_emitted = Arc::new(AtomicBool::new(false));
    let disk_check_counter = Arc::new(AtomicUsize::new(0));
    let eviction_in_progress = Arc::new(AtomicBool::new(false));

    // Network connectivity tracking — consecutive network-level failures trigger a check
    let consecutive_net_failures = Arc::new(std::sync::atomic::AtomicU32::new(0));

    let mut handles = Vec::new();

    for channel in channels {
        if cancel_token.is_cancelled() {
            break;
        }

        let pause_wait_started_at = Instant::now();
        if !wait_if_paused(state.as_ref(), &scan_scope, &cancel_token).await {
            break;
        }
        let pause_wait_ms = pause_wait_started_at.elapsed().as_secs_f64() * 1000.0;
        if pause_wait_ms >= 1.0 {
            record_backend_perf(
                &app,
                &state,
                "scan.pause_wait_ms",
                pause_wait_ms,
                Some(&run_id),
            )
            .await;
        }

        // Check if enough consecutive network failures have occurred to warrant a connectivity check
        if consecutive_net_failures.load(Ordering::Relaxed) >= connectivity::CONSECUTIVE_FAILURE_THRESHOLD {
            if !connectivity::check_connectivity().await {
                log::warn!("Network connectivity lost — pausing scan until recovery");
                let _ = app.emit(
                    "scan://network-paused",
                    ScanEvent {
                        run_id: run_id.clone(),
                        payload: (),
                    },
                );
                let recovered = connectivity::wait_for_connectivity_recovery(&cancel_token).await;
                if !recovered {
                    break; // cancelled while waiting
                }
                log::info!("Network connectivity restored — resuming scan");
                let _ = app.emit(
                    "scan://network-resumed",
                    ScanEvent {
                        run_id: run_id.clone(),
                        payload: (),
                    },
                );
            }
            consecutive_net_failures.store(0, Ordering::Relaxed);
        }

        let permit = semaphore.clone().acquire_owned().await;
        let permit = match permit {
            Ok(permit) => permit,
            Err(_) => break,
        };

        let tx = tx.clone();
        let checkpoint_tx = checkpoint_tx.clone();
        let cancel = cancel_token.clone();
        let client = Arc::clone(&client);
        let user_agent = config.user_agent.clone();
        let timeout = config.timeout;
        let retries = config.retries;
        let retry_backoff = config.retry_backoff;
        let extended_timeout = config.extended_timeout;
        let proxy_list = Arc::clone(&proxy_list);
        let test_geoblock = config.test_geoblock;
        let skip_screenshots = config.skip_screenshots;
        let profile_bitrate_flag = config.profile_bitrate;
        let ffprobe_timeout_secs = config.ffprobe_timeout_secs;
        let ffmpeg_bitrate_timeout_secs = config.ffmpeg_bitrate_timeout_secs;
        let low_fps_threshold = low_fps_threshold_setting;
        let screenshot_format = screenshot_format_setting;
        let screenshots_dir = screenshots_dir.clone();
        let ffmpeg_ok = ffmpeg_available;
        let ffprobe_ok = ffprobe_available;
        let task_app = app.clone();
        let state_for_perf = state.clone();
        let run_id_for_perf = run_id.clone();
        let shared_url_results = Arc::clone(&shared_url_results);
        let diagnostics_semaphore = Arc::clone(&diagnostics_semaphore);
        let screenshots_paused = Arc::clone(&screenshots_paused);
        let screenshots_paused_emitted = Arc::clone(&screenshots_paused_emitted);
        let disk_check_counter = Arc::clone(&disk_check_counter);
        let eviction_in_progress = Arc::clone(&eviction_in_progress);
        let using_custom_dir = using_custom_screenshots_dir;
        let low_space_threshold_gb = low_space_threshold_gb;
        let consecutive_net_failures = Arc::clone(&consecutive_net_failures);

        let handle = tokio::spawn(async move {
            let _permit = permit;
            if cancel.is_cancelled() {
                return;
            }

            let canonical_url = canonicalize_stream_url(&channel.url);
            let result_cell = {
                let mut cache = shared_url_results.lock().await;
                cache
                    .entry(canonical_url)
                    .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
                    .clone()
            };

            let screenshot_file_name =
                ffmpeg::build_screenshot_file_name(channel.index, &channel.name);

            // Check disk space periodically (every ~20 channels)
            let effective_skip_screenshots = if skip_screenshots
                || screenshots_paused.load(Ordering::Relaxed)
            {
                skip_screenshots || screenshots_paused.load(Ordering::Relaxed)
            } else if !using_custom_dir {
                let count = disk_check_counter.fetch_add(1, Ordering::Relaxed);
                if count % 20 == 0 {
                    if let Some(ref dir) = screenshots_dir {
                        let dir_path = std::path::Path::new(dir.as_str());
                        let tier = disk::classify_space(dir_path, low_space_threshold_gb);
                        match tier {
                            disk::DiskSpaceTier::Critical => {
                                screenshots_paused.store(true, Ordering::Relaxed);
                                if !screenshots_paused_emitted.swap(true, Ordering::Relaxed) {
                                    let _ = task_app.emit(
                                        "scan://screenshots-paused",
                                        ScanEvent {
                                            run_id: run_id_for_perf.clone(),
                                            payload: (),
                                        },
                                    );
                                }
                                true
                            }
                            disk::DiskSpaceTier::Low => {
                                // Try eviction if not already running
                                if !eviction_in_progress.swap(true, Ordering::Relaxed) {
                                    let cache_root = dir_path.parent().unwrap_or(dir_path);
                                    let freed = settings::evict_for_disk_space(
                                        cache_root,
                                        dir.as_str(),
                                        low_space_threshold_gb,
                                    );
                                    if freed > 0 {
                                        log::info!("Disk space eviction freed {} bytes", freed);
                                    }
                                    eviction_in_progress.store(false, Ordering::Relaxed);
                                    // Re-check after eviction
                                    let tier_after =
                                        disk::classify_space(dir_path, low_space_threshold_gb);
                                    if matches!(tier_after, disk::DiskSpaceTier::Critical) {
                                        screenshots_paused.store(true, Ordering::Relaxed);
                                        if !screenshots_paused_emitted.swap(true, Ordering::Relaxed)
                                        {
                                            let _ = task_app.emit(
                                                "scan://screenshots-paused",
                                                ScanEvent {
                                                    run_id: run_id_for_perf.clone(),
                                                    payload: (),
                                                },
                                            );
                                        }
                                        true
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            }
                            _ => false,
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            };

            let shared_result = result_cell
                .get_or_init(|| async {
                    compute_shared_url_result(
                        &task_app,
                        &client,
                        &channel.url,
                        timeout,
                        retries,
                        retry_backoff,
                        extended_timeout,
                        &user_agent,
                        &cancel,
                        &proxy_list,
                        test_geoblock,
                        ffmpeg_ok,
                        ffprobe_ok,
                        profile_bitrate_flag,
                        ffprobe_timeout_secs,
                        ffmpeg_bitrate_timeout_secs,
                        low_fps_threshold,
                        effective_skip_screenshots,
                        screenshots_dir.as_ref(),
                        &screenshot_file_name,
                        screenshot_format,
                        &diagnostics_semaphore,
                    )
                    .await
                })
                .await;

            let (mut shared, timing) = match shared_result {
                Ok(value) => value.clone(),
                Err(AppError::Cancelled) => return,
                Err(error) => {
                    let reason = error.to_string();
                    (
                        SharedUrlResult::dead(
                            None,
                            None,
                            None,
                            Some(reason.clone()),
                            ChannelDebugLog {
                                final_verdict: "Dead".to_string(),
                                final_reason: Some(reason),
                                ..ChannelDebugLog::default()
                            },
                        ),
                        WorkerTiming::default(),
                    )
                }
            };

            // Track consecutive network-level failures for connectivity detection
            if shared.status == ChannelStatus::Dead {
                if let Some(ref reason) = shared.error_reason {
                    if connectivity::is_network_level_error(reason) {
                        consecutive_net_failures.fetch_add(1, Ordering::Relaxed);
                    } else {
                        consecutive_net_failures.store(0, Ordering::Relaxed);
                    }
                } else {
                    consecutive_net_failures.store(0, Ordering::Relaxed);
                }
            } else {
                consecutive_net_failures.store(0, Ordering::Relaxed);
            }

            if timing.check_ms > 0.0 {
                record_backend_perf(
                    &task_app,
                    &state_for_perf,
                    "scan.worker.check_ms",
                    timing.check_ms,
                    Some(&run_id_for_perf),
                )
                .await;
            }
            if timing.diagnostics_ms > 0.0 {
                record_backend_perf(
                    &task_app,
                    &state_for_perf,
                    "scan.worker.diagnostics_ms",
                    timing.diagnostics_ms,
                    Some(&run_id_for_perf),
                )
                .await;
            }

            shared.channel_log.channel_index = channel.index;
            shared.channel_log.channel_name = channel.name.clone();
            shared.channel_log.channel_url = channel.url.clone();

            let mut result = ChannelResult {
                index: channel.index,
                playlist: channel.playlist.clone(),
                name: channel.name.clone(),
                group: channel.group.clone(),
                language: channel.language.clone(),
                tvg_id: channel.tvg_id.clone(),
                tvg_name: channel.tvg_name.clone(),
                tvg_logo: channel.tvg_logo.clone(),
                tvg_chno: channel.tvg_chno.clone(),
                url: channel.url.clone(),
                content_type: channel.content_type,
                status: shared.status.clone(),
                codec: shared.codec.clone(),
                resolution: shared.resolution.clone(),
                width: shared.width,
                height: shared.height,
                fps: shared.fps,
                latency_ms: shared.latency_ms,
                video_bitrate: shared.video_bitrate.clone(),
                audio_bitrate: shared.audio_bitrate.clone(),
                audio_codec: shared.audio_codec.clone(),
                audio_only: shared.audio_only,
                screenshot_path: shared.screenshot_path.clone(),
                label_mismatches: Vec::new(),
                low_framerate: shared.low_framerate,
                error_message: None,
                channel_id: parser::get_channel_id(&channel.url),
                extinf_line: channel.extinf_line.clone(),
                metadata_lines: channel.metadata_lines.clone(),
                stream_url: shared.stream_url.clone(),
                retry_count: shared.retry_count,
                error_reason: shared.error_reason.clone(),
                drm_system: shared.drm_system.clone(),
            };

            if result.status == ChannelStatus::Alive {
                if let Some(ref resolution) = result.resolution {
                    result.label_mismatches =
                        ffmpeg::check_label_mismatch(&channel.name, resolution);
                }
            }

            let _ = checkpoint_tx
                .send(resume::CheckpointWriteEntry {
                    log_entry: format!("{} - {} {}", channel.index + 1, channel.name, channel.url),
                    result: result.clone(),
                })
                .await;
            let _ = tx
                .send(WorkerOutput {
                    result,
                    channel_log: shared.channel_log.clone(),
                })
                .await;
        });
        handles.push(handle);
    }

    drop(tx);
    drop(checkpoint_tx);

    for handle in handles {
        let _ = handle.await;
    }

    let event_result = event_task.await;
    if let Err(error) = checkpoint_task.await {
        log::warn!("Checkpoint writer task failed for {}: {}", run_id, error);
    }

    let completed_scan = match event_result {
        Ok(data) => data,
        Err(error) => {
            cleanup_resume_files(&log_file, &checkpoint_file);
            return Err(AppError::Other(format!(
                "Scan failed while dispatching progress events: {}",
                error
            )));
        }
    };

    let mut summary = completed_scan.summary.clone();
    summary.playlist_score = compute_playlist_score(&completed_scan.results, summary.total);
    if cancel_token.is_cancelled() {
        let _ = app.emit(
            "scan://cancelled",
            ScanEvent {
                run_id: run_id.clone(),
                payload: summary,
            },
        );
        state
            .with_window_scan_state(&scan_scope, |scan_state| {
                scan_state.scan_log = None;
            })
            .await;
        cleanup_resume_files(&log_file, &checkpoint_file);
        return Ok(());
    }

    let history_limit = {
        let settings = state.settings.lock().await;
        settings.scan_history_limit as usize
    };
    if let Err(error) = history::append_scan_history(
        &app,
        &run_id,
        &config,
        &summary,
        completed_scan.results,
        history_limit,
    ) {
        log::warn!("Failed to write scan history for {}: {}", run_id, error);
    }

    let _ = app.emit(
        "scan://complete",
        ScanEvent {
            run_id: run_id.clone(),
            payload: summary.clone(),
        },
    );

    let mut channel_logs = completed_scan.channel_logs;
    channel_logs.sort_by_key(|entry| entry.channel_index);
    state
        .with_window_scan_state(&scan_scope, |scan_state| {
            scan_state.scan_log = Some(ScanDebugLog {
                run_id: run_id.clone(),
                playlist_path: config.file_path.clone(),
                source_identity: config.source_identity.clone(),
                started_at_epoch_ms: scan_started_at_epoch_ms,
                finished_at_epoch_ms: now_epoch_ms(),
                summary,
                channels: channel_logs,
            });
        })
        .await;
    cleanup_resume_files(&log_file, &checkpoint_file);
    Ok(())
}

#[tauri::command]
pub async fn start_scan(
    app: AppHandle,
    window: Window,
    config: ScanConfig,
) -> Result<String, AppError> {
    let start_command_started_at = Instant::now();
    let state = app.state::<Arc<AppState>>();
    let scan_scope = window.label().to_string();

    config.validate()?;
    let cancel_token = CancellationToken::new();
    let run_id = next_scan_run_id();
    let scan_started_at_epoch_ms = now_epoch_ms();

    state
        .with_window_scan_state(&scan_scope, |scan_state| -> Result<(), AppError> {
            try_mark_scan_started(&mut scan_state.scanning)?;
            scan_state.paused = false;
            scan_state.cancel_token = Some(cancel_token.clone());
            scan_state.current_run_id = Some(run_id.clone());
            scan_state.scan_log = None;
            scan_state.pause_notify.notify_waiters();
            Ok(())
        })
        .await?;

    let app_for_task = app.clone();
    let state_for_task = state.inner().clone();
    let scan_scope_for_task = scan_scope.clone();
    let run_id_for_task = run_id.clone();
    tokio::spawn(async move {
        let outcome = execute_scan_run(
            app_for_task.clone(),
            state_for_task.clone(),
            scan_scope_for_task.clone(),
            run_id_for_task.clone(),
            scan_started_at_epoch_ms,
            config,
            cancel_token,
        )
        .await;
        if let Err(error) = outcome {
            emit_scan_error_event(&app_for_task, &run_id_for_task, error.to_string());
        }
        clear_scan_state_for_run(
            state_for_task.as_ref(),
            &scan_scope_for_task,
            &run_id_for_task,
        )
        .await;
    });

    let command_ms = start_command_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(
        &app,
        state.inner(),
        "scan.start_scan_command_ms",
        command_ms,
        Some(&run_id),
    )
    .await;

    Ok(run_id)
}

#[tauri::command]
pub async fn cancel_scan(app: AppHandle, window: Window) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    cancel_scan_token(state.inner().as_ref(), window.label()).await;
    Ok(())
}

#[tauri::command]
pub async fn pause_scan(app: AppHandle, window: Window) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let (run_id, pause_notify) = state
        .with_window_scan_state(
            window.label(),
            |scan_state| -> Result<(Option<String>, Arc<tokio::sync::Notify>), AppError> {
                if !scan_state.scanning {
                    return Err(AppError::Other("No scan is currently running".to_string()));
                }
                let run_id = scan_state
                    .current_run_id
                    .clone()
                    .ok_or_else(|| AppError::Other("No active scan run id found".to_string()))?;
                if scan_state.paused {
                    return Ok((None, scan_state.pause_notify.clone()));
                }
                scan_state.paused = true;
                Ok((Some(run_id), scan_state.pause_notify.clone()))
            },
        )
        .await?;
    pause_notify.notify_waiters();
    if let Some(run_id) = run_id {
        let _ = app.emit(
            "scan://paused",
            ScanEvent {
                run_id,
                payload: (),
            },
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn resume_scan(app: AppHandle, window: Window) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let (run_id, pause_notify) = state
        .with_window_scan_state(
            window.label(),
            |scan_state| -> Result<(Option<String>, Arc<tokio::sync::Notify>), AppError> {
                if !scan_state.scanning {
                    return Err(AppError::Other("No scan is currently running".to_string()));
                }
                let run_id = scan_state
                    .current_run_id
                    .clone()
                    .ok_or_else(|| AppError::Other("No active scan run id found".to_string()))?;
                if !scan_state.paused {
                    return Ok((None, scan_state.pause_notify.clone()));
                }
                scan_state.paused = false;
                Ok((Some(run_id), scan_state.pause_notify.clone()))
            },
        )
        .await?;
    pause_notify.notify_waiters();
    if let Some(run_id) = run_id {
        let _ = app.emit(
            "scan://resumed",
            ScanEvent {
                run_id,
                payload: (),
            },
        );
    }

    Ok(())
}

/// Cancel any running scan and force-reset the scanning flag.
/// Called when opening a new playlist or on app startup to ensure clean state.
#[tauri::command]
pub async fn reset_scan(app: AppHandle, window: Window) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let scan_scope = window.label().to_string();
    reset_scan_state(state.inner().as_ref(), &scan_scope).await;

    log::info!("Scan state reset for window '{}'", scan_scope);
    Ok(())
}

/// Lightweight single-channel status check that bypasses the scan engine mutex.
/// Used by the frontend when in-app playback fails — checks whether the stream
/// is alive or dead and returns the updated result directly.
#[tauri::command]
pub async fn quick_check_channel(
    app: AppHandle,
    channel: ChannelResult,
) -> Result<ChannelResult, AppError> {
    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().await.clone();

    let cancel_token = CancellationToken::new();
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(settings.accept_invalid_certs)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();

    let ffprobe_ok = {
        let (_, fp) = ffmpeg::check_availability(&app).await;
        fp
    };

    let outcome = if checker::uses_ffprobe_liveness(&channel.url) {
        checker::check_channel_status_with_ffprobe_debug(
            &app,
            &channel.url,
            settings.ffprobe_timeout_secs,
            settings.retries,
            settings.retry_backoff.clone(),
            None,
            ffprobe_ok,
            &cancel_token,
        )
        .await
    } else {
        checker::check_channel_status_with_debug(
            &client,
            &channel.url,
            settings.timeout,
            settings.retries,
            settings.retry_backoff.clone(),
            settings.extended_timeout,
            &settings.user_agent,
            &cancel_token,
        )
        .await
    };

    let (status, stream_url, latency_ms, error_reason) = match outcome {
        Ok(o) => {
            let status = match o.status.as_str() {
                "Alive" => ChannelStatus::Alive,
                "DRM" => ChannelStatus::Drm,
                "Geoblocked" => ChannelStatus::Geoblocked,
                "Geoblocked (Confirmed)" => ChannelStatus::GeoblockedConfirmed,
                "Geoblocked (Unconfirmed)" => ChannelStatus::GeoblockedUnconfirmed,
                _ => ChannelStatus::Dead,
            };
            (status, o.stream_url, o.latency_ms, o.last_error_reason)
        }
        Err(_) => (ChannelStatus::Dead, None, None, None),
    };

    let mut result = channel;
    result.status = status;
    result.stream_url = stream_url;
    result.latency_ms = latency_ms;
    result.error_reason = error_reason;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn make_result(
        index: usize,
        status: ChannelStatus,
        low_framerate: bool,
        mismatched: bool,
    ) -> ChannelResult {
        ChannelResult {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Test".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            url: format!("http://example.com/{}.m3u8", index),
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
            label_mismatches: if mismatched {
                vec!["Label mismatch".to_string()]
            } else {
                Vec::new()
            },
            low_framerate,
            error_message: None,
            channel_id: "id".to_string(),
            extinf_line: "#EXTINF:-1,Test".to_string(),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
            drm_system: None,
        }
    }

    fn make_channel(index: usize) -> Channel {
        Channel {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {}", index),
            group: "Test".to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            url: format!("http://example.com/{}.m3u8", index),
            content_type: crate::models::channel::ContentType::Live,
            extinf_line: "#EXTINF:-1,Test".to_string(),
            metadata_lines: Vec::new(),
        }
    }

    #[test]
    fn canonicalize_stream_url_removes_default_port_and_fragment() {
        assert_eq!(
            canonicalize_stream_url(" http://Example.com:80/live/stream#frag "),
            "http://example.com/live/stream"
        );
        assert_eq!(
            canonicalize_stream_url("https://Example.com:443/live/stream?token=abc#part"),
            "https://example.com/live/stream?token=abc"
        );
    }

    #[test]
    fn canonicalize_stream_url_for_non_url_is_trim_only() {
        assert_eq!(
            canonicalize_stream_url("  not-a-valid-url  "),
            "not-a-valid-url"
        );
    }

    #[test]
    fn selected_channel_filter_keeps_all_when_none() {
        let mut channels = vec![make_channel(0), make_channel(1), make_channel(2)];
        filter_channels_by_selection(&mut channels, &None);
        assert_eq!(channels.len(), 3);
    }

    #[test]
    fn selected_channel_filter_keeps_only_selected_indices() {
        let mut channels = vec![make_channel(0), make_channel(1), make_channel(2)];
        let selected = Some(vec![2, 0]);
        filter_channels_by_selection(&mut channels, &selected);
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].index, 0);
        assert_eq!(channels[1].index, 2);
    }

    #[test]
    fn selected_channel_filter_handles_sparse_indices() {
        let mut channels = vec![make_channel(0), make_channel(2), make_channel(5)];
        let selected = Some(vec![5, 0]);
        filter_channels_by_selection(&mut channels, &selected);
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].index, 0);
        assert_eq!(channels[1].index, 5);
    }

    #[test]
    fn concurrent_start_guard_rejects_second_start() {
        let mut scanning = false;
        assert!(try_mark_scan_started(&mut scanning).is_ok());
        assert!(try_mark_scan_started(&mut scanning).is_err());
    }

    #[test]
    fn generated_run_ids_are_unique() {
        let first = next_scan_run_id();
        let second = next_scan_run_id();
        assert_ne!(first, second);
    }

    #[test]
    fn scan_counters_follow_event_order() {
        let mut counters = ScanCounters::default();
        let total = 4usize;

        let alive = make_result(0, ChannelStatus::Alive, true, true);
        counters.apply(&alive);
        let progress = counters.as_progress(total);
        assert_eq!(progress.completed, 1);
        assert_eq!(progress.alive, 1);
        assert_eq!(progress.dead, 0);
        assert_eq!(progress.geoblocked, 0);
        assert_eq!(progress.drm, 0);

        let geoblocked = make_result(1, ChannelStatus::Geoblocked, false, false);
        counters.apply(&geoblocked);
        let drm = make_result(2, ChannelStatus::Drm, false, false);
        counters.apply(&drm);
        let dead = make_result(3, ChannelStatus::Dead, false, false);
        counters.apply(&dead);

        let summary = counters.as_summary(total);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.alive, 1);
        assert_eq!(summary.dead, 1);
        assert_eq!(summary.geoblocked, 1);
        assert_eq!(summary.drm, 1);
        assert_eq!(summary.low_framerate, 1);
        assert_eq!(summary.mislabeled, 1);
        assert!(summary.playlist_score.is_none());
    }

    #[test]
    fn compute_playlist_score_builds_weighted_subscores() {
        let mut first = make_result(0, ChannelStatus::Alive, false, false);
        first.group = "Sports".to_string();
        first.latency_ms = Some(150);
        first.tvg_id = Some("epg-a".to_string());
        first.width = Some(1920);
        first.height = Some(1080);
        first.codec = Some("h264".to_string());
        first.fps = Some(30);

        let mut second = make_result(1, ChannelStatus::Alive, false, false);
        second.group = "Movies".to_string();
        second.latency_ms = Some(300);
        second.tvg_id = Some("epg-b".to_string());
        second.width = Some(3840);
        second.height = Some(2160);
        second.codec = Some("hevc".to_string());
        second.fps = Some(50);

        let mut third = make_result(2, ChannelStatus::Dead, false, false);
        third.group = "Kids".to_string();

        let score = compute_playlist_score(&[first, second, third], 3)
            .expect("score should be present for non-empty scans");

        assert!(score.ping > 0.0);
        assert!(score.content > 0.0);
        assert!(score.quality > 0.0);
        assert!(score.overall > 0.0);
        assert!(score.overall <= 10.0);
    }

    #[test]
    fn compute_playlist_score_returns_none_for_empty_scans() {
        assert!(compute_playlist_score(&[], 0).is_none());
    }

    #[tokio::test]
    async fn cancel_scan_token_cancels_active_token() {
        let state = AppState::new();
        let token = CancellationToken::new();
        let scan_scope = "main";

        state
            .with_window_scan_state(scan_scope, |scan_state| {
                scan_state.cancel_token = Some(token.clone());
            })
            .await;

        cancel_scan_token(state.as_ref(), scan_scope).await;
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn reset_scan_state_cancels_token_and_clears_flag() {
        let state = AppState::new();
        let token = CancellationToken::new();
        let scan_scope = "main";
        let other_scope = "secondary";

        state
            .with_window_scan_state(scan_scope, |scan_state| {
                scan_state.cancel_token = Some(token.clone());
                scan_state.scanning = true;
                scan_state.paused = true;
                scan_state.current_run_id = Some("scan-run-test".to_string());
            })
            .await;
        state
            .with_window_scan_state(other_scope, |scan_state| {
                scan_state.scanning = true;
                scan_state.current_run_id = Some("scan-run-other".to_string());
            })
            .await;

        reset_scan_state(state.as_ref(), scan_scope).await;

        assert!(token.is_cancelled());
        state
            .with_window_scan_state(scan_scope, |scan_state| {
                assert!(!scan_state.scanning);
                assert!(!scan_state.paused);
                assert!(scan_state.current_run_id.is_none());
            })
            .await;
        state
            .with_window_scan_state(other_scope, |scan_state| {
                assert!(scan_state.scanning);
                assert_eq!(scan_state.current_run_id.as_deref(), Some("scan-run-other"));
            })
            .await;
    }

    #[tokio::test]
    async fn clear_pre_spawn_scan_state_clears_flag_and_token() {
        let state = AppState::new();
        let token = CancellationToken::new();
        let scan_scope = "main";

        state
            .with_window_scan_state(scan_scope, |scan_state| {
                scan_state.cancel_token = Some(token);
                scan_state.scanning = true;
                scan_state.paused = true;
                scan_state.current_run_id = Some("scan-run-test".to_string());
            })
            .await;

        clear_pre_spawn_scan_state(state.as_ref(), scan_scope).await;

        state
            .with_window_scan_state(scan_scope, |scan_state| {
                assert!(!scan_state.scanning);
                assert!(scan_state.cancel_token.is_none());
                assert!(!scan_state.paused);
                assert!(scan_state.current_run_id.is_none());
            })
            .await;
    }
}
