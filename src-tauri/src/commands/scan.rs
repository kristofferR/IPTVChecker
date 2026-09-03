use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::commands::history;
use crate::commands::settings;
use crate::engine::xtream::apply_xtream_archive_flags_to_results;
use crate::engine::{checker, connectivity, disk, ffmpeg, parser, proxy, resume, stream_proxy};
use crate::error::AppError;
use crate::models::backend_perf::BackendPerfSample;
use crate::models::channel::{Channel, ChannelResult, ChannelStatus};
use crate::models::playlist::PlaylistPreview;
use crate::models::scan::{
    RetryBackoff, ScanConfig, ScanErrorPayload, ScanEvent, ScanProgress, ScanResultBatchPayload,
    ScanSummary,
};
use crate::models::scan_log::{ChannelDebugLog, ScanDebugLog};
use crate::models::settings::ScreenshotFormat;
use crate::state::AppState;

static NEXT_SCAN_RUN_ID: AtomicU64 = AtomicU64::new(1);
const PROGRESS_EMIT_INTERVAL_MS: u64 = 50;
const CHECKPOINT_FLUSH_INTERVAL_MS: u64 = 250;
const CHECKPOINT_FLUSH_MAX_BATCH: usize = 128;
const RESULT_BATCH_MAX_ITEMS: usize = 64;
const MIN_SCREENSHOT_DIAGNOSTIC_TIMEOUT_SECS: f64 = 15.0;
const XTREAM_ARCHIVE_SCAN_COMPLETION_TIMEOUT: Duration = Duration::from_secs(2);

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
    hdr_format: Option<String>,
    video_bitrate: Option<String>,
    audio_bitrate: Option<String>,
    audio_codec: Option<String>,
    audio_channel_layout: Option<String>,
    audio_only: bool,
    screenshot_path: Option<String>,
    screenshot_error_reason: Option<String>,
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
            hdr_format: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_channel_layout: None,
            audio_only: false,
            screenshot_path: None,
            screenshot_error_reason: None,
            low_framerate: false,
            stream_url,
            retry_count,
            error_reason,
            channel_log,
        }
    }
}

/// Per-URL memo of check results, so channels that share a stream URL are only
/// fetched once. The `OnceCell` lets the second waiter block on the first
/// worker's result instead of racing it.
type SharedUrlResultCache = Arc<
    tokio::sync::Mutex<
        HashMap<
            String,
            Arc<tokio::sync::OnceCell<Result<(SharedUrlResult, WorkerTiming), AppError>>>,
        >,
    >,
>;

fn set_screenshot_capture_success(shared: &mut SharedUrlResult, path: String) {
    shared.screenshot_path = Some(path);
    shared.screenshot_error_reason = None;
    shared.channel_log.screenshot_error_reason = None;
}

fn set_screenshot_capture_error(shared: &mut SharedUrlResult, reason: String) {
    shared.screenshot_path = None;
    shared.screenshot_error_reason = Some(reason.clone());
    shared.channel_log.screenshot_error_reason = Some(reason);
}

fn apply_parallel_screenshot_outcome(
    shared: &mut SharedUrlResult,
    outcome: Result<Option<String>, AppError>,
) {
    match outcome {
        Ok(Some(path)) => set_screenshot_capture_success(shared, path),
        Ok(None) | Err(AppError::Cancelled) => {}
        Err(error) => set_screenshot_capture_error(shared, error.to_string()),
    }
}

fn apply_combined_screenshot_outcome(
    shared: &mut SharedUrlResult,
    primary_path: Option<String>,
    primary_error_reason: Option<String>,
    fallback_result: Option<Result<String, AppError>>,
) {
    if let Some(path) = primary_path {
        set_screenshot_capture_success(shared, path);
        return;
    }

    if let Some(result) = fallback_result {
        match result {
            Ok(path) => set_screenshot_capture_success(shared, path),
            Err(AppError::Cancelled) => {}
            Err(error) => set_screenshot_capture_error(shared, error.to_string()),
        }
        return;
    }

    if let Some(reason) = primary_error_reason {
        set_screenshot_capture_error(shared, reason);
    }
}

use crate::urlnorm::canonicalize_stream_url;

/// Per-run configuration and shared handles for checking a single stream URL.
/// Bundles timeouts, retry policy, feature flags, and shared limits so the
/// per-channel call site only adds the URL and screenshot destination.
struct SharedCheckContext<'a> {
    app: &'a AppHandle,
    client: &'a reqwest::Client,
    timeout: f64,
    retries: u32,
    retry_backoff: RetryBackoff,
    extended_timeout: Option<f64>,
    user_agent: &'a str,
    cancel: &'a CancellationToken,
    proxy_list: &'a Option<Vec<String>>,
    test_geoblock: bool,
    ffmpeg_ok: bool,
    ffprobe_ok: bool,
    profile_bitrate_flag: bool,
    ffprobe_timeout_secs: f64,
    ffmpeg_bitrate_timeout_secs: f64,
    low_fps_threshold: f64,
    screenshot_format: ScreenshotFormat,
    diagnostics_semaphore: &'a Arc<Semaphore>,
    single_connection_mode: bool,
}

async fn compute_shared_url_result(
    ctx: &SharedCheckContext<'_>,
    channel_url: &str,
    skip_screenshots: bool,
    screenshots_dir: Option<&String>,
    screenshot_file_name: &str,
) -> Result<(SharedUrlResult, WorkerTiming), AppError> {
    let &SharedCheckContext {
        app,
        client,
        timeout,
        retries,
        retry_backoff,
        extended_timeout,
        user_agent,
        cancel,
        proxy_list,
        test_geoblock,
        ffmpeg_ok,
        ffprobe_ok,
        profile_bitrate_flag,
        ffprobe_timeout_secs,
        ffmpeg_bitrate_timeout_secs,
        low_fps_threshold,
        screenshot_format,
        diagnostics_semaphore,
        single_connection_mode,
    } = ctx;
    let dispatcharr_single_pass = ffmpeg_ok && checker::is_dispatcharr_proxy_url(channel_url);
    let check_started_at = Instant::now();
    let check_outcome = if dispatcharr_single_pass {
        // Dispatcharr returns 503 while tearing down a channel after its last
        // client disconnects. Do not consume one connection for an HTTP byte
        // check and then race teardown with a second ffmpeg connection. The
        // combined diagnostics pass below is both the liveness check and the
        // metadata/screenshot/bitrate probe.
        Ok(checker::ChannelCheckOutcome {
            status: ChannelStatus::Alive,
            stream_url: Some(channel_url.to_string()),
            latency_ms: None,
            retries_used: 0,
            last_error_reason: None,
            drm_system: None,
            debug_log: ChannelDebugLog {
                channel_url: channel_url.to_string(),
                final_verdict: "Alive".to_string(),
                ..ChannelDebugLog::default()
            },
        })
    } else if checker::uses_ffprobe_liveness(channel_url) {
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
        checked_status,
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
            ChannelStatus::Dead,
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

    let status = if checked_status == ChannelStatus::Geoblocked && test_geoblock {
        if let Some(proxies) = proxy_list {
            if !proxies.is_empty() {
                proxy::confirm_geoblock(channel_url, proxies, timeout, cancel).await
            } else {
                checked_status
            }
        } else {
            checked_status
        }
    } else {
        checked_status
    };

    channel_log.final_verdict = status.to_string();
    if channel_log.final_reason.is_none() {
        channel_log.final_reason = error_reason.clone();
    }

    let mut timing = WorkerTiming {
        check_ms,
        diagnostics_ms: 0.0,
    };

    // A cancel that lands after the check finished must not rewrite a
    // completed verdict (possibly Alive) to Dead — that would emit and
    // checkpoint a lie. Bail with Cancelled so the channel stays unscanned
    // and resume re-checks it, matching the diagnostics cancel paths.
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    if !matches!(status, ChannelStatus::Alive | ChannelStatus::Drm) {
        return Ok((
            SharedUrlResult {
                status,
                drm_system: None,
                latency_ms,
                codec: None,
                resolution: None,
                width: None,
                height: None,
                fps: None,
                hdr_format: None,
                video_bitrate: None,
                audio_bitrate: None,
                audio_codec: None,
                audio_channel_layout: None,
                audio_only: false,
                screenshot_path: None,
                screenshot_error_reason: None,
                low_framerate: false,
                stream_url,
                retry_count: (retry_count > 0).then_some(retry_count),
                error_reason,
                channel_log,
            },
            timing,
        ));
    }

    // Hand ffmpeg the manifest URL, not the resolved leaf segment: for HLS,
    // verify() descends to a media segment that may have rolled off the live
    // window (404) or lack init context (invalid data). The original channel
    // URL is what the player uses and is what ffmpeg can reliably open.
    let target_url = match stream_url.as_deref() {
        Some(resolved) if checker::is_manifest_url(resolved) => resolved.to_string(),
        _ => channel_url.to_string(),
    };
    let redacted_target_url = stream_proxy::redact_url(&target_url);
    let mut shared = SharedUrlResult {
        status,
        drm_system,
        latency_ms,
        codec: None,
        resolution: None,
        width: None,
        height: None,
        fps: None,
        hdr_format: None,
        video_bitrate: None,
        audio_bitrate: None,
        audio_codec: None,
        audio_channel_layout: None,
        audio_only: false,
        screenshot_path: None,
        screenshot_error_reason: None,
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
    let mut diagnostics_permit = diagnostics_semaphore.clone().acquire_owned().await.ok();
    let ffprobe_timeout_duration =
        std::time::Duration::from_secs_f64(ffprobe_timeout_secs.clamp(1.0, 300.0));

    let want_screenshot = !skip_screenshots && ffmpeg_ok && screenshots_dir.is_some();
    let mut format_bitrate_kbps: Option<u32> = None;

    if (single_connection_mode || dispatcharr_single_pass) && ffmpeg_ok {
        // Single-provider: one ffmpeg process for metadata + screenshot + bitrate.
        // Avoids 5XX rejections from single-connection IPTV servers.
        let diag_timeout = if profile_bitrate_flag {
            ffmpeg_bitrate_timeout_secs
        } else if want_screenshot {
            ffprobe_timeout_secs.max(MIN_SCREENSHOT_DIAGNOSTIC_TIMEOUT_SECS)
        } else {
            ffprobe_timeout_secs
        };
        let mut combined_retries_used = 0u32;
        let (combined_result, final_attempt_elapsed) = loop {
            let attempt_started_at = Instant::now();
            let result = ffmpeg::run_combined_diagnostics(
                app,
                &target_url,
                Some(channel_url),
                user_agent,
                screenshots_dir.unwrap_or(&String::new()),
                screenshot_file_name,
                screenshot_format,
                want_screenshot,
                profile_bitrate_flag,
                diag_timeout,
                cancel,
            )
            .await;
            let attempt_elapsed = attempt_started_at.elapsed();

            let no_tracks_yet = matches!(
                &result,
                Ok(diag) if !(diag.track_presence.has_audio || diag.track_presence.has_video)
            );
            if !dispatcharr_single_pass || !no_tracks_yet || combined_retries_used >= retries {
                break (result, attempt_elapsed);
            }

            combined_retries_used = combined_retries_used.saturating_add(1);
            // The semaphore limits active diagnostics, not channels waiting for
            // Dispatcharr's teardown window. Release it during the backoff.
            drop(diagnostics_permit.take());
            // Dispatcharr explicitly returns Retry-After: 1 while a channel is
            // stopping. ffmpeg does not expose that header, so honor the same
            // minimum here and retain the configured backoff behavior.
            let delay_secs = match retry_backoff {
                RetryBackoff::None => 1,
                RetryBackoff::Linear => u64::from(combined_retries_used.min(10)),
                RetryBackoff::Exponential => {
                    (1u64 << combined_retries_used.saturating_sub(1).min(5)).min(30)
                }
            };
            tokio::select! {
                _ = cancel.cancelled() => {
                    return Err(AppError::Cancelled);
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(delay_secs.max(1))) => {}
            }
            diagnostics_permit = tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::Cancelled),
                permit = diagnostics_semaphore.clone().acquire_owned() => permit.ok(),
            };
        };
        if dispatcharr_single_pass {
            shared.latency_ms =
                Some(final_attempt_elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
            shared.retry_count = (combined_retries_used > 0).then_some(combined_retries_used);
        }

        match combined_result {
            Ok(diag) => {
                let has_tracks = diag.track_presence.has_audio || diag.track_presence.has_video;
                if dispatcharr_single_pass && !has_tracks {
                    let reason = diag.input_error_reason.clone().unwrap_or_else(|| {
                        "No decodable audio/video tracks reported by ffmpeg".to_string()
                    });
                    shared.status = ChannelStatus::Dead;
                    shared.error_reason = Some(reason.clone());
                    shared.channel_log.final_verdict = "Dead".to_string();
                    shared.channel_log.final_reason = Some(reason);
                }
                shared.audio_only = diag.track_presence.has_audio && !diag.track_presence.has_video;
                if let Some(info) = diag.video_info {
                    if !shared.audio_only {
                        shared.codec = Some(info.codec);
                        shared.resolution = Some(info.resolution.clone());
                        shared.width = info.width;
                        shared.height = info.height;
                        shared.fps = info.fps;
                        shared.hdr_format = info.hdr_format;
                        shared.low_framerate = info
                            .fps
                            .map(|fps| (fps as f64) <= low_fps_threshold)
                            .unwrap_or(false);
                    }
                }
                if let Some(audio) = diag.audio_info {
                    shared.audio_codec = Some(audio.codec);
                    shared.audio_bitrate = audio.bitrate_kbps.map(|b| format!("{}", b));
                    shared.audio_channel_layout = audio.channel_layout;
                }
                if let Some(kbps) = diag.profiled_bitrate_kbps {
                    shared.video_bitrate = Some(format!("{kbps} kbps"));
                }
                format_bitrate_kbps = diag.format_bitrate_kbps;
                shared.channel_log.diagnostics_output = Some(
                    crate::models::scan_log::cap_diagnostics_output(diag.diagnostics_output),
                );

                let png_fallback_result = if diag.screenshot_path.is_none()
                    && want_screenshot
                    && !dispatcharr_single_pass
                    && screenshot_format == ScreenshotFormat::Webp
                    && ffmpeg::should_retry_screenshot_as_png(
                        diag.screenshot_error_reason.as_deref(),
                    )
                    && !cancel.is_cancelled()
                {
                    Some(
                        ffmpeg::capture_screenshot(
                            app,
                            &target_url,
                            Some(channel_url),
                            screenshots_dir.unwrap(),
                            screenshot_file_name,
                            user_agent,
                            ScreenshotFormat::Png,
                            cancel,
                        )
                        .await,
                    )
                } else {
                    None
                };
                apply_combined_screenshot_outcome(
                    &mut shared,
                    diag.screenshot_path,
                    diag.screenshot_error_reason,
                    png_fallback_result,
                );
            }
            Err(AppError::Cancelled) => {
                drop(diagnostics_permit);
                return Err(AppError::Cancelled);
            }
            Err(err) => {
                log::warn!(
                    "Combined diagnostics failed for {}: {}",
                    redacted_target_url,
                    err
                );
                if want_screenshot {
                    set_screenshot_capture_error(&mut shared, err.to_string());
                }
                if dispatcharr_single_pass {
                    shared.status = ChannelStatus::Dead;
                    shared.error_reason = Some(err.to_string());
                    shared.channel_log.final_verdict = "Dead".to_string();
                    shared.channel_log.final_reason = Some(err.to_string());
                }
            }
        }
        drop(diagnostics_permit);
    } else {
        // Mixed-provider or no ffmpeg: parallel ffprobe + screenshot, then bitrate.
        // Faster when there are no connection limits.
        let ffprobe_fut = async {
            if !ffprobe_ok {
                return None;
            }
            ffmpeg::collect_probe_snapshot_with_timeout(
                app,
                &target_url,
                Some(channel_url),
                cancel,
                Some(ffprobe_timeout_duration),
            )
            .await
            .ok()
        };

        let screenshot_fut = async {
            if !want_screenshot || cancel.is_cancelled() {
                return Ok(None);
            }
            let dir = screenshots_dir.unwrap();
            ffmpeg::capture_screenshot(
                app,
                &target_url,
                Some(channel_url),
                dir,
                screenshot_file_name,
                user_agent,
                screenshot_format,
                cancel,
            )
            .await
            .map(Some)
        };

        let (probe_result, screenshot_result) = tokio::join!(ffprobe_fut, screenshot_fut);

        if let Some(snapshot) = probe_result {
            shared.audio_only =
                snapshot.track_presence.has_audio && !snapshot.track_presence.has_video;
            if let Some(info) = snapshot.video_info {
                if !shared.audio_only {
                    shared.codec = Some(info.codec);
                    shared.resolution = Some(info.resolution.clone());
                    shared.width = info.width;
                    shared.height = info.height;
                    shared.fps = info.fps;
                    shared.hdr_format = info.hdr_format;
                    shared.low_framerate = info
                        .fps
                        .map(|fps| (fps as f64) <= low_fps_threshold)
                        .unwrap_or(false);
                    if let Some(kbps) = info.bitrate_kbps {
                        shared.video_bitrate = Some(format!("{kbps} kbps"));
                    }
                }
            }
            if let Some(audio) = snapshot.audio_info {
                shared.audio_codec = Some(audio.codec);
                shared.audio_bitrate = audio.bitrate_kbps.map(|b| format!("{}", b));
                shared.audio_channel_layout = audio.channel_layout;
            }
            format_bitrate_kbps = snapshot.format_bitrate_kbps;
            shared.channel_log.diagnostics_output = Some(
                crate::models::scan_log::cap_diagnostics_output(snapshot.ffprobe_output),
            );
        }

        apply_parallel_screenshot_outcome(&mut shared, screenshot_result);

        // Release permit before bitrate profiling to avoid starving other channels.
        drop(diagnostics_permit);

        if ffprobe_ok && !cancel.is_cancelled() && profile_bitrate_flag && ffmpeg_ok {
            match ffmpeg::profile_bitrate(
                app,
                &target_url,
                Some(channel_url),
                user_agent,
                ffmpeg_bitrate_timeout_secs,
                cancel,
            )
            .await
            {
                Ok(bitrate) => {
                    shared.video_bitrate = Some(bitrate);
                }
                Err(AppError::Cancelled) => {}
                Err(err) => {
                    log::warn!(
                        "Bitrate profiling failed for {}: {}",
                        redacted_target_url,
                        err
                    );
                }
            }
        }
    }

    // Fallback: use format-level bitrate when video_bitrate is missing or N/A.
    if profile_bitrate_flag && matches!(shared.video_bitrate.as_deref(), None | Some("N/A")) {
        if let Some(fmt_kbps) = format_bitrate_kbps {
            let audio_kbps = shared
                .audio_bitrate
                .as_deref()
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            let video_kbps = fmt_kbps.saturating_sub(audio_kbps);
            if video_kbps > 0 {
                shared.video_bitrate = Some(format!("{video_kbps} kbps"));
            }
        }
    }
    timing.diagnostics_ms = diagnostics_started_at.elapsed().as_secs_f64() * 1000.0;

    Ok((shared, timing))
}

fn try_mark_scan_started(scanning: &mut bool) -> Result<(), AppError> {
    if *scanning {
        return Err(AppError::State("A scan is already in progress".to_string()));
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

fn filter_channels_by_selection(
    channels: &mut Vec<Channel>,
    selected_indices: &Option<Vec<usize>>,
) {
    if let Some(selected_indices) = selected_indices {
        let selected: HashSet<usize> = selected_indices.iter().copied().collect();
        channels.retain(|channel| selected.contains(&channel.index));
    }
}

fn filter_channels_by_content_type(channels: &mut Vec<Channel>, hide_vod_content: bool) {
    if hide_vod_content {
        channels.retain(|channel| {
            matches!(
                channel.content_type,
                crate::models::channel::ContentType::Live
            )
        });
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

fn log_scan_summary(outcome: &str, run_id: &str, started_at_epoch_ms: u64, summary: &ScanSummary) {
    let elapsed_secs = now_epoch_ms().saturating_sub(started_at_epoch_ms) as f64 / 1000.0;
    log::info!(
        "Scan {} {} in {:.1}s: total={}, alive={}, dead={}, placeholder={}, geoblocked={}, drm={}",
        run_id,
        outcome,
        elapsed_secs,
        summary.total,
        summary.alive,
        summary.dead,
        summary.placeholder,
        summary.geoblocked,
        summary.drm,
    );
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

fn hash_source_metadata(
    path: &str,
    metadata: &std::fs::Metadata,
    hasher: &mut DefaultHasher,
) -> Option<()> {
    path.hash(hasher);
    metadata.len().hash(hasher);
    metadata.modified().ok()?.hash(hasher);
    Some(())
}

fn source_fingerprint(path: &str) -> Option<u64> {
    let metadata = std::fs::metadata(path).ok()?;
    let mut hasher = DefaultHasher::new();

    if metadata.is_dir() {
        "directory".hash(&mut hasher);
        let playlist_paths = parser::find_playlists_in_dir(path).ok()?;
        playlist_paths.len().hash(&mut hasher);
        for playlist_path in playlist_paths {
            let playlist_metadata = std::fs::metadata(&playlist_path).ok()?;
            hash_source_metadata(&playlist_path, &playlist_metadata, &mut hasher)?;
        }
    } else {
        "file".hash(&mut hasher);
        hash_source_metadata(path, &metadata, &mut hasher)?;
    }

    Some(hasher.finish())
}

pub(crate) fn playlist_preview_cache_key_from_parts(
    file_path: &str,
    source_identity: Option<&str>,
    playlist_display_name: Option<&str>,
    group_filter: Option<&str>,
    channel_search: Option<&str>,
) -> String {
    format!(
        "{file_path}|i:{}|n:{}|g:{}|s:{}",
        source_identity.unwrap_or("*"),
        playlist_display_name.unwrap_or("*"),
        group_filter.unwrap_or("*"),
        channel_search.unwrap_or("*")
    )
}

fn playlist_preview_cache_key(config: &ScanConfig) -> String {
    playlist_preview_cache_key_from_parts(
        &config.file_path,
        config.source_identity.as_deref(),
        config.playlist_display_name.as_deref(),
        config.group_filter.as_deref(),
        config.channel_search.as_deref(),
    )
}

pub(crate) async fn seed_cached_playlist_preview(
    app: &AppHandle,
    file_path: &str,
    source_identity: Option<&str>,
    playlist_display_name: Option<&str>,
    group_filter: Option<&str>,
    channel_search: Option<&str>,
    preview: &PlaylistPreview,
) {
    let state = app.state::<Arc<AppState>>();
    let cache_key = playlist_preview_cache_key_from_parts(
        file_path,
        source_identity,
        playlist_display_name,
        group_filter,
        channel_search,
    );
    let source_fingerprint = source_fingerprint(file_path);
    state
        .put_cached_playlist_preview(cache_key, Arc::new(preview.clone()), source_fingerprint)
        .await;
}

async fn parse_playlist_with_cache(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &ScanConfig,
    run_id: &str,
) -> Result<Arc<PlaylistPreview>, AppError> {
    let source_fingerprint = source_fingerprint(&config.file_path);
    let cache_key = playlist_preview_cache_key(config);
    if let Some(cached) = state
        .get_cached_playlist_preview(&cache_key, source_fingerprint)
        .await
    {
        log::info!(
            "Scan {}: using cached playlist preview for {}",
            run_id,
            config.file_path
        );
        return Ok(cached);
    }

    if config.group_filter.is_some() || config.channel_search.is_some() {
        let full_preview_cache_key = playlist_preview_cache_key_from_parts(
            &config.file_path,
            config.source_identity.as_deref(),
            config.playlist_display_name.as_deref(),
            None,
            None,
        );
        if let Some(full_preview) = state
            .get_cached_playlist_preview(&full_preview_cache_key, source_fingerprint)
            .await
        {
            let filter_started_at = Instant::now();
            let group_filter = config.group_filter.clone();
            let channel_search = config.channel_search.clone();
            let filtered_preview = tokio::task::spawn_blocking(move || {
                parser::filter_playlist_preview(
                    full_preview.as_ref(),
                    &group_filter,
                    &channel_search,
                )
            })
            .await
            .map_err(|err| AppError::Other(format!("Playlist filter task failed: {err}")))??;
            let filter_ms = filter_started_at.elapsed().as_secs_f64() * 1000.0;
            record_backend_perf(
                app,
                state,
                "scan.preflight.filter_cached_ms",
                filter_ms,
                Some(run_id),
            )
            .await;

            log::info!(
                "Scan {}: derived filtered playlist preview from full cache for {}",
                run_id,
                config.file_path
            );
            // Derived previews are cheap to recreate and must not evict the
            // reusable full preview, especially for in-memory provider sources.
            return Ok(Arc::new(filtered_preview));
        }
    }

    let parse_started_at = Instant::now();
    // Parsing a big playlist is seconds of CPU-bound work; keep it off the
    // async runtime that is also driving proxies and event emission.
    let mut preview = {
        let file_path = config.file_path.clone();
        let group_filter = config.group_filter.clone();
        let channel_search = config.channel_search.clone();
        tokio::task::spawn_blocking(move || {
            parser::parse_playlist(&file_path, &group_filter, &channel_search)
        })
        .await
        .map_err(|err| AppError::Other(format!("Playlist parse task failed: {err}")))??
    };
    crate::commands::saved::apply_persisted_playlist_metadata(
        app,
        &mut preview,
        config
            .source_identity
            .as_deref()
            .and_then(|value| value.strip_prefix("saved:")),
        config.playlist_display_name.as_deref(),
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
    let preview = Arc::new(preview);
    state
        .put_cached_playlist_preview(cache_key, Arc::clone(&preview), source_fingerprint)
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
    pending: &mut Vec<resume::CheckpointWriteEntryWithLog>,
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
        resume::write_entries_with_channel_logs(&log_path, &checkpoint_path, &batch)
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
    mut rx: tokio::sync::mpsc::Receiver<resume::CheckpointWriteEntryWithLog>,
    log_file: String,
    checkpoint_file: String,
    app: AppHandle,
    state: Arc<AppState>,
    run_id: String,
) {
    let mut pending =
        Vec::<resume::CheckpointWriteEntryWithLog>::with_capacity(CHECKPOINT_FLUSH_MAX_BATCH);
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

/// Resume/checkpoint state derived from the on-disk files for a scan scope.
struct ResumeState {
    log_file: String,
    checkpoint_file: String,
    resumed_entries: Vec<resume::CheckpointResumeEntry>,
    base_name: String,
    scope_suffix: String,
}

fn refresh_resumed_catchup_metadata(
    entries: &mut [resume::CheckpointResumeEntry],
    channels: &[Channel],
) {
    let channels_by_index: HashMap<usize, &Channel> = channels
        .iter()
        .map(|channel| (channel.index, channel))
        .collect();

    for entry in entries {
        if let Some(channel) = channels_by_index.get(&entry.result.index) {
            entry.result.catchup = channel.catchup.clone();
            entry.result.catchup_days = channel.catchup_days;
            entry.result.catchup_source = channel.catchup_source.clone();
            entry.result.extinf_line = channel.extinf_line.clone();
        }
    }
}

/// Derive the resume file paths for this scan scope, load any checkpoint
/// entries that match the current channel set, and prune already-checked
/// channels from `channels`. Starts fresh (truncates the log and removes the
/// checkpoint) when nothing is resumable.
async fn load_resume_state(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &ScanConfig,
    run_id: &str,
    channels: &mut Vec<Channel>,
) -> ResumeState {
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
    let checkpoint_entries = {
        let checkpoint_file = checkpoint_file.clone();
        tokio::task::spawn_blocking(move || resume::load_checkpoint_entries(&checkpoint_file))
            .await
            .unwrap_or_default()
    };
    let mut resumed_entries = checkpoint_entries
        .into_iter()
        .filter(|entry| channel_indices.contains(&entry.result.index))
        .collect::<Vec<_>>();
    resumed_entries.sort_by_key(|entry| entry.result.index);
    refresh_resumed_catchup_metadata(&mut resumed_entries, channels);

    let resumed_indices: HashSet<usize> = resumed_entries
        .iter()
        .map(|entry| entry.result.index)
        .collect();
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
            resumed_entries.len(),
            channels.len()
        );
    }
    let resume_ms = resume_started_at.elapsed().as_secs_f64() * 1000.0;
    record_backend_perf(
        app,
        state,
        "scan.preflight.resume_load_ms",
        resume_ms,
        Some(run_id),
    )
    .await;

    ResumeState {
        log_file,
        checkpoint_file,
        resumed_entries,
        base_name,
        scope_suffix,
    }
}

/// Load the proxy list when geoblock testing is enabled and a proxy file is
/// configured. A configured-but-unreadable file aborts the scan.
fn load_proxy_list_if_configured(config: &ScanConfig) -> Result<Option<Vec<String>>, AppError> {
    if !config.test_geoblock {
        return Ok(None);
    }
    let Some(ref proxy_file) = config.proxy_file else {
        return Ok(None);
    };
    match proxy::load_proxy_list(proxy_file) {
        Ok(proxy_list) => {
            log::info!("Loaded {} proxies from {}", proxy_list.len(), proxy_file);
            Ok(Some(proxy_list))
        }
        Err(error) => {
            log::error!("Failed to load proxy file '{}': {}", proxy_file, error);
            Err(AppError::Other(format!(
                "Failed to load proxy file '{}': {}",
                proxy_file, error
            )))
        }
    }
}

/// Resolve and create the screenshots directory for this run (app temp cache
/// by default, or a user-specified folder), write the eviction metadata, and
/// evict old cached runs per the retention policy. Returns `None` when
/// screenshots are disabled or ffmpeg is unavailable.
async fn prepare_screenshots_dir(
    app: &AppHandle,
    config: &ScanConfig,
    base_name: &str,
    scope_suffix: &str,
    scan_started_at_epoch_ms: u64,
    screenshot_retention_count: u32,
    ffmpeg_available: bool,
) -> Result<Option<String>, AppError> {
    if config.skip_screenshots || !ffmpeg_available {
        return Ok(None);
    }

    let using_custom_screenshots_dir = config.screenshots_dir.is_some();
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
            .map_err(|e| {
                AppError::Other(format!("Failed to create screenshots directory: {}", e))
            })?;
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

    Ok(Some(dir))
}

/// When enough consecutive network-level failures have accumulated, verify
/// connectivity and, if offline, emit `scan://network-paused` and block until
/// the network recovers (emitting `scan://network-resumed` afterwards).
/// Returns false when cancelled while waiting for recovery.
async fn pause_if_network_down(
    app: &AppHandle,
    run_id: &str,
    cancel: &CancellationToken,
    consecutive_net_failures: &AtomicU32,
) -> bool {
    if consecutive_net_failures.load(Ordering::Relaxed)
        < connectivity::CONSECUTIVE_FAILURE_THRESHOLD
    {
        return true;
    }

    if !connectivity::check_connectivity().await {
        log::warn!("Network connectivity lost — pausing scan until recovery");
        let _ = app.emit(
            "scan://network-paused",
            ScanEvent {
                run_id: run_id.to_string(),
                payload: (),
            },
        );
        let recovered = connectivity::wait_for_connectivity_recovery(cancel).await;
        if !recovered {
            return false; // cancelled while waiting
        }
        log::info!("Network connectivity restored — resuming scan");
        let _ = app.emit(
            "scan://network-resumed",
            ScanEvent {
                run_id: run_id.to_string(),
                payload: (),
            },
        );
    }
    consecutive_net_failures.store(0, Ordering::Relaxed);
    true
}

/// Adaptive concurrency throttle — workers report pressure signals (timeouts,
/// HTTP 429s, retries) versus clean successes, and the dispatch loop delays
/// new work when the pressure ratio climbs. Emits `scan://adaptive-throttle`
/// events on engage/disengage transitions.
#[derive(Clone)]
struct AdaptiveThrottle {
    timeout_pressure: Arc<AtomicU32>,
    success_count: Arc<AtomicU32>,
    engaged: Arc<AtomicBool>,
}

impl AdaptiveThrottle {
    fn new() -> Self {
        Self {
            timeout_pressure: Arc::new(AtomicU32::new(0)),
            success_count: Arc::new(AtomicU32::new(0)),
            engaged: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Worker-side: record whether a completed channel showed server pressure.
    fn record_outcome(&self, pressure: bool) {
        if pressure {
            self.timeout_pressure.fetch_add(1, Ordering::Relaxed);
        } else {
            self.success_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Dispatcher-side: sleep before dispatching the next channel when servers
    /// show pressure; decays the counters so the ratio tracks recent behavior.
    async fn before_dispatch(&self, app: &AppHandle, run_id: &str) {
        let pressure = self.timeout_pressure.load(Ordering::Relaxed);
        let successes = self.success_count.load(Ordering::Relaxed);
        let total_so_far = pressure + successes;
        if total_so_far < 25 {
            return;
        }

        let pressure_ratio = pressure as f64 / total_so_far as f64;
        let delay_ms = if pressure_ratio > 0.5 {
            1000u64
        } else if pressure_ratio > 0.3 {
            300
        } else if pressure_ratio > 0.15 {
            50
        } else {
            0
        };

        if delay_ms > 0 {
            if !self.engaged.swap(true, Ordering::Relaxed) {
                log::info!(
                    "Adaptive throttle engaged: pressure_ratio={:.2} ({}/{} channels), delay={}ms",
                    pressure_ratio,
                    pressure,
                    total_so_far,
                    delay_ms
                );
                let _ = app.emit(
                    "scan://adaptive-throttle",
                    ScanEvent {
                        run_id: run_id.to_string(),
                        payload: serde_json::json!({
                            "engaged": true,
                            "pressure_ratio": pressure_ratio,
                            "delay_ms": delay_ms,
                        }),
                    },
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        } else if self.engaged.swap(false, Ordering::Relaxed) {
            log::info!(
                "Adaptive throttle disengaged: pressure_ratio={:.2}",
                pressure_ratio
            );
            let _ = app.emit(
                "scan://adaptive-throttle",
                ScanEvent {
                    run_id: run_id.to_string(),
                    payload: serde_json::json!({
                        "engaged": false,
                        "pressure_ratio": pressure_ratio,
                        "delay_ms": 0,
                    }),
                },
            );
        }

        // Decay pressure counters periodically to make the system responsive to changes
        if total_so_far > 100 {
            self.timeout_pressure
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v / 2))
                .ok();
            self.success_count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v / 2))
                .ok();
        }
    }
}

/// Disk-space guard for screenshot capture. Every ~20 channels it re-checks
/// free space on the screenshot volume, evicting old cached runs when space
/// is low and pausing screenshots (emitting `scan://screenshots-paused` once)
/// when space is critical. Cloned into each worker task.
#[derive(Clone)]
struct ScreenshotDiskGuard {
    paused: Arc<AtomicBool>,
    paused_emitted: Arc<AtomicBool>,
    check_counter: Arc<AtomicUsize>,
    eviction_in_progress: Arc<AtomicBool>,
    using_custom_dir: bool,
    low_space_threshold_gb: f64,
}

impl ScreenshotDiskGuard {
    fn new(using_custom_dir: bool, low_space_threshold_gb: f64) -> Self {
        Self {
            paused: Arc::new(AtomicBool::new(false)),
            paused_emitted: Arc::new(AtomicBool::new(false)),
            check_counter: Arc::new(AtomicUsize::new(0)),
            eviction_in_progress: Arc::new(AtomicBool::new(false)),
            using_custom_dir,
            low_space_threshold_gb,
        }
    }

    fn pause_and_emit(&self, app: &AppHandle, run_id: &str) {
        self.paused.store(true, Ordering::Relaxed);
        if !self.paused_emitted.swap(true, Ordering::Relaxed) {
            let _ = app.emit(
                "scan://screenshots-paused",
                ScanEvent {
                    run_id: run_id.to_string(),
                    payload: (),
                },
            );
        }
    }

    /// Decide whether this channel should skip its screenshot, re-checking
    /// disk space periodically (every ~20 channels).
    fn effective_skip(
        &self,
        app: &AppHandle,
        run_id: &str,
        skip_screenshots: bool,
        screenshots_dir: Option<&String>,
    ) -> bool {
        if skip_screenshots || self.paused.load(Ordering::Relaxed) {
            return true;
        }
        if self.using_custom_dir {
            return false;
        }
        let count = self.check_counter.fetch_add(1, Ordering::Relaxed);
        if !count.is_multiple_of(20) {
            return false;
        }
        let Some(dir) = screenshots_dir else {
            return false;
        };
        let dir_path = std::path::Path::new(dir.as_str());
        match disk::classify_space(dir_path, self.low_space_threshold_gb) {
            disk::DiskSpaceTier::Critical => {
                self.pause_and_emit(app, run_id);
                true
            }
            disk::DiskSpaceTier::Low => {
                // Try eviction if not already running
                if self.eviction_in_progress.swap(true, Ordering::Relaxed) {
                    return false;
                }
                let cache_root = dir_path.parent().unwrap_or(dir_path);
                let freed = settings::evict_for_disk_space(
                    cache_root,
                    dir.as_str(),
                    self.low_space_threshold_gb,
                );
                if freed > 0 {
                    log::info!("Disk space eviction freed {} bytes", freed);
                }
                self.eviction_in_progress.store(false, Ordering::Relaxed);
                // Re-check after eviction
                let tier_after = disk::classify_space(dir_path, self.low_space_threshold_gb);
                if matches!(tier_after, disk::DiskSpaceTier::Critical) {
                    self.pause_and_emit(app, run_id);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

/// Accumulates channel results and forwards them to the frontend, batching
/// `scan://channel-results-batch` events (when the client supports them) and
/// throttling `scan://progress` emissions.
struct ScanEventEmitter {
    app: AppHandle,
    state: Arc<AppState>,
    run_id: String,
    total: usize,
    batch_events_enabled: bool,
    counters: ScanCounters,
    completed_results: Vec<ChannelResult>,
    channel_logs: Vec<ChannelDebugLog>,
    pending_batch: Vec<ChannelResult>,
    last_progress_emit: Instant,
}

impl ScanEventEmitter {
    fn new(
        app: AppHandle,
        state: Arc<AppState>,
        run_id: String,
        total: usize,
        batch_events_enabled: bool,
    ) -> Self {
        Self {
            app,
            state,
            run_id,
            total,
            batch_events_enabled,
            counters: ScanCounters::default(),
            completed_results: Vec::with_capacity(total),
            channel_logs: Vec::with_capacity(total),
            pending_batch: Vec::with_capacity(RESULT_BATCH_MAX_ITEMS),
            last_progress_emit: Instant::now()
                .checked_sub(std::time::Duration::from_millis(PROGRESS_EMIT_INTERVAL_MS))
                .unwrap_or_else(Instant::now),
        }
    }

    /// Record one completed channel and emit it (batched or as a single
    /// `scan://channel-result`), plus a throttled progress event.
    async fn ingest(&mut self, result: ChannelResult, channel_log: Option<ChannelDebugLog>) {
        self.counters.apply(&result);
        self.completed_results.push(result.clone());
        if let Some(channel_log) = channel_log {
            self.channel_logs.push(channel_log);
        }
        if self.batch_events_enabled {
            self.pending_batch.push(result);
            if self.pending_batch.len() >= RESULT_BATCH_MAX_ITEMS {
                emit_result_batch_event(
                    &self.app,
                    &self.state,
                    &self.run_id,
                    std::mem::take(&mut self.pending_batch),
                    self.counters.as_progress(self.total),
                )
                .await;
            }
        } else {
            emit_channel_result_event(&self.app, &self.state, &self.run_id, result).await;
        }

        if self.last_progress_emit.elapsed().as_millis() as u64 >= PROGRESS_EMIT_INTERVAL_MS {
            self.flush_pending_and_emit_progress().await;
            self.last_progress_emit = Instant::now();
        }
    }

    /// Flush any pending result batch, then emit a progress event.
    async fn flush_pending_and_emit_progress(&mut self) {
        // pending_batch is only ever filled when batch events are enabled.
        if !self.pending_batch.is_empty() {
            emit_result_batch_event(
                &self.app,
                &self.state,
                &self.run_id,
                std::mem::take(&mut self.pending_batch),
                self.counters.as_progress(self.total),
            )
            .await;
        }
        emit_progress_event(
            &self.app,
            &self.state,
            &self.run_id,
            self.counters.as_progress(self.total),
        )
        .await;
    }

    /// Emit the trailing batch plus a final progress event and hand back the
    /// accumulated scan data.
    async fn finish(mut self) -> CompletedScanData {
        self.flush_pending_and_emit_progress().await;
        CompletedScanData {
            summary: self.counters.as_summary(self.total),
            results: self.completed_results,
            channel_logs: self.channel_logs,
        }
    }
}

/// Event-emitter task body: replay resumed checkpoint entries, then stream
/// worker outputs until the channel closes, and return the completed data.
async fn run_event_emitter(
    app: AppHandle,
    state: Arc<AppState>,
    run_id: String,
    total: usize,
    scan_started_at_epoch_ms: u64,
    batch_events_enabled: bool,
    resumed_entries: Vec<resume::CheckpointResumeEntry>,
    mut rx: tokio::sync::mpsc::Receiver<WorkerOutput>,
) -> CompletedScanData {
    let mut emitter = ScanEventEmitter::new(app, state, run_id, total, batch_events_enabled);
    let mut first_result_emitted = false;

    for resumed_entry in resumed_entries {
        emitter
            .ingest(resumed_entry.result, resumed_entry.channel_log)
            .await;
    }

    while let Some(worker) = rx.recv().await {
        if !first_result_emitted {
            first_result_emitted = true;
            let time_to_first_ms = now_epoch_ms().saturating_sub(scan_started_at_epoch_ms) as f64;
            record_backend_perf(
                &emitter.app,
                &emitter.state,
                "scan.time_to_first_result_ms",
                time_to_first_ms,
                Some(&emitter.run_id),
            )
            .await;
        }

        emitter
            .ingest(worker.result, Some(worker.channel_log))
            .await;
    }

    emitter.finish().await
}

/// Feed a finished channel's outcome into the connectivity and adaptive
/// throttle trackers.
fn track_worker_signals(
    shared: &SharedUrlResult,
    consecutive_net_failures: &AtomicU32,
    adaptive_throttle: &AdaptiveThrottle,
) {
    // Track consecutive network-level failures for connectivity detection
    let is_network_failure = shared.status == ChannelStatus::Dead
        && shared
            .error_reason
            .as_deref()
            .map(connectivity::is_network_level_error)
            .unwrap_or(false);
    if is_network_failure {
        consecutive_net_failures.fetch_add(1, Ordering::Relaxed);
    } else {
        consecutive_net_failures.store(0, Ordering::Relaxed);
    }

    // Adaptive concurrency — track pressure signals
    let is_pressure_signal = if shared.status == ChannelStatus::Dead {
        // Timeout or rate limit errors are pressure signals
        shared
            .error_reason
            .as_deref()
            .is_some_and(|reason| reason == "Timeout" || reason.starts_with("HTTP 429"))
    } else {
        false
    };
    // Retries indicate the server is under strain even if the channel eventually succeeded
    let had_retries = shared.retry_count.is_some_and(|count| count > 0);

    adaptive_throttle.record_outcome(is_pressure_signal || had_retries);
}

/// Combine a channel's playlist metadata with its shared check outcome into
/// the `ChannelResult` emitted to the frontend and checkpoint file.
fn build_channel_result(channel: &Channel, shared: &SharedUrlResult) -> ChannelResult {
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
        catchup: channel.catchup.clone(),
        catchup_days: channel.catchup_days,
        catchup_source: channel.catchup_source.clone(),
        url: channel.url.clone(),
        content_type: channel.content_type,
        status: shared.status,
        codec: shared.codec.clone(),
        resolution: shared.resolution.clone(),
        width: shared.width,
        height: shared.height,
        fps: shared.fps,
        latency_ms: shared.latency_ms,
        hdr_format: shared.hdr_format.clone(),
        video_bitrate: shared.video_bitrate.clone(),
        audio_bitrate: shared.audio_bitrate.clone(),
        audio_codec: shared.audio_codec.clone(),
        audio_channel_layout: shared.audio_channel_layout.clone(),
        audio_only: shared.audio_only,
        screenshot_path: shared.screenshot_path.clone(),
        screenshot_error_reason: shared.screenshot_error_reason.clone(),
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
            result.label_mismatches = ffmpeg::check_label_mismatch(&channel.name, resolution);
        }
    }

    result
}

/// Read the history limit from settings and append this run to scan history
/// on a blocking thread — serializing and writing the full results Vec (plus
/// reading the previous run for the diff) is blocking file IO.
async fn append_history_blocking(
    app: &AppHandle,
    state: &Arc<AppState>,
    run_id: &str,
    config: &ScanConfig,
    summary: &ScanSummary,
    results: Vec<ChannelResult>,
) {
    let history_limit = {
        let settings = state.settings.lock().await;
        settings.scan_history_limit as usize
    };
    let app = app.clone();
    let run_id = run_id.to_string();
    let config = config.clone();
    let summary = summary.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Err(error) =
            history::append_scan_history(&app, &run_id, &config, &summary, results, history_limit)
        {
            log::warn!("Failed to write scan history for {}: {}", run_id, error);
        }
    })
    .await;
}

/// Store the finished scan's debug log on the window scan state.
async fn store_scan_log(
    state: &Arc<AppState>,
    scan_scope: &str,
    run_id: &str,
    config: &ScanConfig,
    started_at_epoch_ms: u64,
    summary: ScanSummary,
    channel_logs: Vec<ChannelDebugLog>,
) {
    let run_id = run_id.to_string();
    let playlist_path = config.file_path.clone();
    let source_identity = config.source_identity.clone();
    state
        .with_window_scan_state(scan_scope, |scan_state| {
            scan_state.scan_log = Some(ScanDebugLog {
                run_id,
                playlist_path,
                source_identity,
                started_at_epoch_ms,
                finished_at_epoch_ms: now_epoch_ms(),
                summary,
                channels: channel_logs,
            });
        })
        .await;
}

/// Emit completion events and record history/debug state for a scan whose
/// filtered channel set is empty.
async fn finish_empty_scan(
    app: &AppHandle,
    state: &Arc<AppState>,
    scan_scope: &str,
    run_id: &str,
    scan_started_at_epoch_ms: u64,
    config: &ScanConfig,
) {
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

    log_scan_summary("completed", run_id, scan_started_at_epoch_ms, &summary);

    let _ = app.emit(
        "scan://complete",
        ScanEvent {
            run_id: run_id.to_string(),
            payload: summary.clone(),
        },
    );
    append_history_blocking(app, state, run_id, config, &summary, Vec::new()).await;
    store_scan_log(
        state,
        scan_scope,
        run_id,
        config,
        scan_started_at_epoch_ms,
        summary,
        Vec::new(),
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
    let preview_single_provider = preview.single_provider;
    let mut channels = preview.channels.clone();
    filter_channels_by_selection(&mut channels, &config.selected_indices);
    filter_channels_by_content_type(&mut channels, config.hide_vod_content);
    let total = channels.len();

    if total == 0 {
        finish_empty_scan(
            &app,
            &state,
            &scan_scope,
            &run_id,
            scan_started_at_epoch_ms,
            &config,
        )
        .await;
        return Ok(());
    }

    // Resume support
    let ResumeState {
        log_file,
        checkpoint_file,
        resumed_entries,
        base_name,
        scope_suffix,
    } = load_resume_state(&app, &state, &config, &run_id, &mut channels).await;

    // Compute single_provider from the filtered (and resume-pruned) channel set.
    let single_provider = if preview_single_provider {
        true
    } else {
        // The cached preview from parse_playlist may not have single_provider
        // set (it's populated separately during playlist open). Recompute.
        crate::commands::playlist::is_single_provider_check(&channels)
    };
    log::info!(
        "Scan {}: {} channels to check (single_provider: {})",
        run_id,
        total,
        single_provider
    );

    // Load proxies if configured
    let proxy_list = load_proxy_list_if_configured(&config)?;

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
    let screenshots_dir = prepare_screenshots_dir(
        &app,
        &config,
        &base_name,
        &scope_suffix,
        scan_started_at_epoch_ms,
        screenshot_retention_count,
        ffmpeg_available,
    )
    .await?;

    let client = Arc::new({
        let mut builder = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .redirect(reqwest::redirect::Policy::none());
        if single_provider {
            // Single-provider IPTV servers enforce connection limits.
            // Disable connection pooling so the checker's HTTP connection
            // is closed before the combined ffmpeg diagnostics connect.
            builder = builder.pool_max_idle_per_host(0);
        }
        builder.build().unwrap_or_default()
    });
    let semaphore = Arc::new(Semaphore::new(config.concurrency as usize));
    let diagnostics_limit = if single_provider {
        1
    } else {
        usize::max(1, usize::min(config.concurrency as usize, 4))
    };
    let diagnostics_semaphore = Arc::new(Semaphore::new(diagnostics_limit));
    let (low_fps_threshold_setting, screenshot_format_setting) = {
        let settings = state.settings.lock().await;
        (settings.low_fps_threshold, settings.screenshot_format)
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<WorkerOutput>(256);
    let (checkpoint_tx, checkpoint_rx) =
        tokio::sync::mpsc::channel::<resume::CheckpointWriteEntryWithLog>(1024);

    let checkpoint_task = tokio::spawn(run_checkpoint_writer(
        checkpoint_rx,
        log_file.clone(),
        checkpoint_file.clone(),
        app.clone(),
        state.clone(),
        run_id.clone(),
    ));

    let batch_events_enabled = config
        .client_capabilities
        .as_ref()
        .map(|caps| caps.event_batch_v1)
        .unwrap_or(false);
    let event_task = tokio::spawn(run_event_emitter(
        app.clone(),
        state.clone(),
        run_id.clone(),
        total,
        scan_started_at_epoch_ms,
        batch_events_enabled,
        resumed_entries,
        rx,
    ));

    let proxy_list = Arc::new(proxy_list);
    let shared_url_results: SharedUrlResultCache =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    // Disk space tracking for screenshot pause
    let disk_guard = ScreenshotDiskGuard::new(using_custom_screenshots_dir, low_space_threshold_gb);

    // Network connectivity tracking — consecutive network-level failures trigger a check
    let consecutive_net_failures = Arc::new(AtomicU32::new(0));

    // Adaptive concurrency — track pressure signals and successes to throttle dispatch
    let adaptive_throttle = AdaptiveThrottle::new();

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
        if !pause_if_network_down(&app, &run_id, &cancel_token, &consecutive_net_failures).await {
            break; // cancelled while waiting for connectivity
        }

        // Adaptive concurrency throttle — slow down dispatch when servers show pressure
        adaptive_throttle.before_dispatch(&app, &run_id).await;

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
        let single_connection_mode = single_provider;
        let disk_guard = disk_guard.clone();
        let consecutive_net_failures = Arc::clone(&consecutive_net_failures);
        let adaptive_throttle = adaptive_throttle.clone();

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
            let effective_skip_screenshots = disk_guard.effective_skip(
                &task_app,
                &run_id_for_perf,
                skip_screenshots,
                screenshots_dir.as_ref(),
            );

            let check_ctx = SharedCheckContext {
                app: &task_app,
                client: &client,
                timeout,
                retries,
                retry_backoff,
                extended_timeout,
                user_agent: &user_agent,
                cancel: &cancel,
                proxy_list: &proxy_list,
                test_geoblock,
                ffmpeg_ok,
                ffprobe_ok,
                profile_bitrate_flag,
                ffprobe_timeout_secs,
                ffmpeg_bitrate_timeout_secs,
                low_fps_threshold,
                screenshot_format,
                diagnostics_semaphore: &diagnostics_semaphore,
                single_connection_mode,
            };
            let shared_result = result_cell
                .get_or_init(|| async {
                    compute_shared_url_result(
                        &check_ctx,
                        &channel.url,
                        effective_skip_screenshots,
                        screenshots_dir.as_ref(),
                        &screenshot_file_name,
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

            track_worker_signals(&shared, &consecutive_net_failures, &adaptive_throttle);

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

            log::info!(
                "[Scan] #{} {} → {} (bitrate: {}, latency: {}, url: {})",
                channel.index,
                channel.name,
                shared.status,
                shared.video_bitrate.as_deref().unwrap_or("—"),
                shared
                    .latency_ms
                    .map(|ms| format!("{ms} ms"))
                    .unwrap_or_else(|| "—".to_string()),
                channel.url,
            );

            shared.channel_log.channel_index = channel.index;
            shared.channel_log.channel_name = channel.name.clone();
            shared.channel_log.channel_url = channel.url.clone();

            let result = build_channel_result(&channel, &shared);

            let _ = checkpoint_tx
                .send(resume::CheckpointWriteEntryWithLog {
                    log_entry: format!("{} - {} {}", channel.index + 1, channel.name, channel.url),
                    result: result.clone(),
                    channel_log: shared.channel_log.clone(),
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

    let mut panicked_workers = 0u32;
    for handle in handles {
        if let Err(err) = handle.await {
            panicked_workers += 1;
            log::error!("Scan worker task failed: {err}");
        }
    }
    if panicked_workers > 0 {
        log::error!(
            "{panicked_workers} scan worker(s) panicked — those channels are missing from results"
        );
    }

    let event_result = event_task.await;
    if let Err(error) = checkpoint_task.await {
        log::warn!("Checkpoint writer task failed for {}: {}", run_id, error);
    }

    let mut completed_scan = match event_result {
        Ok(data) => data,
        Err(error) => {
            log::error!("Scan failed while dispatching progress events: {}", error);
            cleanup_resume_files(&log_file, &checkpoint_file);
            return Err(AppError::Other(format!(
                "Scan failed while dispatching progress events: {}",
                error
            )));
        }
    };

    if !cancel_token.is_cancelled() {
        if let Some(source_identity) = config.source_identity.as_deref() {
            let archive_flags = tokio::select! {
                flags = state.wait_for_xtream_archive_flags(source_identity) => flags,
                _ = cancel_token.cancelled() => None,
                _ = tokio::time::sleep(XTREAM_ARCHIVE_SCAN_COMPLETION_TIMEOUT) => None,
            };
            if let Some(archive_flags) = archive_flags {
                apply_xtream_archive_flags_to_results(
                    &mut completed_scan.results,
                    archive_flags.as_ref(),
                );
            }
        }
    }

    let mut summary = completed_scan.summary.clone();
    summary.playlist_score = crate::engine::playlist_score::compute_playlist_score(
        &completed_scan.results,
        summary.total,
    );
    if cancel_token.is_cancelled() {
        log_scan_summary("cancelled", &run_id, scan_started_at_epoch_ms, &summary);
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

    // Serializing and writing the full results Vec (plus reading the previous
    // run for the diff) is blocking file IO — keep it off the runtime.
    append_history_blocking(
        &app,
        &state,
        &run_id,
        &config,
        &summary,
        completed_scan.results,
    )
    .await;

    log_scan_summary("completed", &run_id, scan_started_at_epoch_ms, &summary);

    let _ = app.emit(
        "scan://complete",
        ScanEvent {
            run_id: run_id.clone(),
            payload: summary.clone(),
        },
    );

    let mut channel_logs = completed_scan.channel_logs;
    channel_logs.sort_by_key(|entry| entry.channel_index);
    store_scan_log(
        &state,
        &scan_scope,
        &run_id,
        &config,
        scan_started_at_epoch_ms,
        summary,
        channel_logs,
    )
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
            let elapsed_secs =
                now_epoch_ms().saturating_sub(scan_started_at_epoch_ms) as f64 / 1000.0;
            log::error!(
                "Scan {} failed after {:.1}s: {}",
                run_id_for_task,
                elapsed_secs,
                error
            );
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
    log::info!(
        "Scan cancellation requested for window '{}'",
        window.label()
    );
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
        log::info!("Scan {} paused", run_id);
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
        log::info!("Scan {} resumed", run_id);
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

/// Shared HTTP clients for quick-check operations, keyed by TLS validation mode.
static QUICK_CHECK_CLIENT_STRICT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
static QUICK_CHECK_CLIENT_INSECURE: std::sync::OnceLock<reqwest::Client> =
    std::sync::OnceLock::new();

fn get_quick_check_client(accept_invalid_certs: bool) -> reqwest::Client {
    let cell = if accept_invalid_certs {
        &QUICK_CHECK_CLIENT_INSECURE
    } else {
        &QUICK_CHECK_CLIENT_STRICT
    };
    cell.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .danger_accept_invalid_certs(accept_invalid_certs)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
    .clone()
}

/// Lightweight single-channel status check that bypasses the scan engine mutex.
/// Used by the frontend when in-app playback fails — checks whether the stream
/// is alive or dead and returns the updated result directly.
#[tauri::command]
pub async fn quick_check_channel(
    app: AppHandle,
    channel: ChannelResult,
    request_id: Option<String>,
) -> Result<ChannelResult, AppError> {
    let check_started_at = Instant::now();
    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().await.clone();

    let cancel_token = CancellationToken::new();
    if let Some(request_id) = request_id.as_ref() {
        state
            .register_quick_check(request_id.clone(), cancel_token.clone())
            .await;
    }
    let client = get_quick_check_client(settings.accept_invalid_certs);

    let uses_ffprobe_liveness = checker::uses_ffprobe_liveness(&channel.url);
    let ffprobe_ok = if uses_ffprobe_liveness {
        let (_, fp) = ffmpeg::check_availability(&app).await;
        fp
    } else {
        false
    };

    let outcome = tokio::select! {
        _ = cancel_token.cancelled() => Err(AppError::Cancelled),
        outcome = async {
            if uses_ffprobe_liveness {
                checker::check_channel_status_with_ffprobe_debug(
                    &app,
                    &channel.url,
                    settings.ffprobe_timeout_secs,
                    settings.retries,
                    settings.retry_backoff,
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
                    settings.retry_backoff,
                    settings.extended_timeout,
                    &settings.user_agent,
                    &cancel_token,
                )
                .await
            }
        } => outcome,
    };

    if matches!(outcome, Err(AppError::Cancelled)) {
        if let Some(request_id) = request_id.as_deref() {
            state.unregister_quick_check(request_id).await;
        }
        return Err(AppError::Cancelled);
    }

    let (checked_status, stream_url, latency_ms, error_reason) = match outcome {
        Ok(o) => {
            log::info!(
                "[Quick Check] #{} {} → {} in {:.1}s (url: {})",
                channel.index,
                channel.name,
                o.status,
                check_started_at.elapsed().as_secs_f64(),
                channel.url,
            );
            (o.status, o.stream_url, o.latency_ms, o.last_error_reason)
        }
        Err(error) => {
            log::warn!(
                "[Quick Check] #{} {} failed after {:.1}s: {} (url: {})",
                channel.index,
                channel.name,
                check_started_at.elapsed().as_secs_f64(),
                error,
                channel.url,
            );
            (ChannelStatus::Dead, None, None, None)
        }
    };

    let status = if checked_status == ChannelStatus::Geoblocked && settings.test_geoblock {
        match settings.proxy_file.as_deref() {
            Some(proxy_file) => match proxy::load_proxy_list(proxy_file) {
                Ok(proxies) => {
                    proxy::confirm_geoblock(&channel.url, &proxies, settings.timeout, &cancel_token)
                        .await
                }
                Err(error) => {
                    log::warn!(
                        "[Quick Check] Could not confirm geoblock because proxy file '{}' failed to load: {}",
                        proxy_file,
                        error
                    );
                    checked_status
                }
            },
            None => checked_status,
        }
    } else {
        checked_status
    };

    if cancel_token.is_cancelled() {
        if let Some(request_id) = request_id.as_deref() {
            state.unregister_quick_check(request_id).await;
        }
        return Err(AppError::Cancelled);
    }

    let mut result = channel;
    result.status = status;
    result.stream_url = stream_url;
    result.latency_ms = latency_ms;
    result.error_reason = error_reason;
    result.screenshot_error_reason = None;
    if let Some(request_id) = request_id.as_deref() {
        state.unregister_quick_check(request_id).await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn cancel_quick_check(app: AppHandle, request_id: String) {
    app.state::<Arc<AppState>>()
        .cancel_quick_check(&request_id)
        .await;
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
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: format!("http://example.com/{}.m3u8", index),
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
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: format!("http://example.com/{}.m3u8", index),
            content_type: crate::models::channel::ContentType::Live,
            extinf_line: "#EXTINF:-1,Test".to_string(),
            metadata_lines: Vec::new(),
        }
    }

    fn make_shared_result() -> SharedUrlResult {
        SharedUrlResult {
            status: ChannelStatus::Alive,
            drm_system: None,
            latency_ms: None,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            hdr_format: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_channel_layout: None,
            audio_only: false,
            screenshot_path: None,
            screenshot_error_reason: None,
            low_framerate: false,
            stream_url: Some("https://example.com/live.m3u8".to_string()),
            retry_count: None,
            error_reason: None,
            channel_log: ChannelDebugLog::default(),
        }
    }

    #[test]
    fn resumed_results_use_current_catchup_metadata() {
        let mut result = make_result(1, ChannelStatus::Alive, false, false);
        result.catchup = Some("stale".to_string());
        result.catchup_days = Some(1);
        result.catchup_source = Some("https://old.example/archive".to_string());
        let mut entries = vec![resume::CheckpointResumeEntry {
            result,
            channel_log: None,
        }];
        let mut channel = make_channel(1);
        channel.catchup = Some("xc".to_string());
        channel.catchup_days = Some(7);
        channel.catchup_source = Some("https://new.example/archive".to_string());
        channel.extinf_line = "#EXTINF:-1 catchup=\"xc\" catchup-days=\"7\",Test".to_string();

        refresh_resumed_catchup_metadata(&mut entries, std::slice::from_ref(&channel));

        assert_eq!(entries[0].result.catchup.as_deref(), Some("xc"));
        assert_eq!(entries[0].result.catchup_days, Some(7));
        assert_eq!(
            entries[0].result.catchup_source.as_deref(),
            Some("https://new.example/archive")
        );
        assert_eq!(entries[0].result.extinf_line, channel.extinf_line);
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
    fn playlist_preview_cache_key_from_parts_matches_scan_config_shape() {
        assert_eq!(
            playlist_preview_cache_key_from_parts(
                "/tmp/playlist.m3u8",
                Some("saved:abc"),
                Some("My Playlist"),
                Some("Sports"),
                Some("arsenal"),
            ),
            "/tmp/playlist.m3u8|i:saved:abc|n:My Playlist|g:Sports|s:arsenal"
        );
    }

    #[test]
    fn source_fingerprint_tracks_nested_playlist_changes() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-scan-fingerprint-{unique}"));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).expect("nested fixture dir should be created");

        let first_playlist = nested.join("first.m3u8");
        std::fs::write(
            &first_playlist,
            "#EXTM3U\n#EXTINF:-1,One\nhttp://example.com/one.m3u8\n",
        )
        .expect("first fixture should be writable");
        let initial = source_fingerprint(&root.to_string_lossy())
            .expect("directory fingerprint should be available");

        std::fs::write(
            &first_playlist,
            "#EXTM3U\n#EXTINF:-1,One Updated\nhttp://example.com/one.m3u8\n",
        )
        .expect("nested fixture should be editable");
        let after_edit = source_fingerprint(&root.to_string_lossy())
            .expect("edited directory fingerprint should be available");
        assert_ne!(initial, after_edit);

        let second_playlist = root.join("second.m3u");
        std::fs::write(
            &second_playlist,
            "#EXTM3U\n#EXTINF:-1,Two\nhttp://example.com/two.m3u8\n",
        )
        .expect("second fixture should be writable");
        let after_add = source_fingerprint(&root.to_string_lossy())
            .expect("expanded directory fingerprint should be available");
        assert_ne!(after_edit, after_add);

        std::fs::remove_file(&second_playlist).expect("second fixture should be removable");
        let after_remove = source_fingerprint(&root.to_string_lossy())
            .expect("reduced directory fingerprint should be available");
        assert_ne!(after_add, after_remove);

        std::fs::remove_dir_all(root).expect("fixture directory should be removable");
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
    fn content_type_filter_keeps_all_when_disabled() {
        let mut live = make_channel(0);
        let mut movie = make_channel(1);
        let mut series = make_channel(2);
        live.content_type = crate::models::channel::ContentType::Live;
        movie.content_type = crate::models::channel::ContentType::Movie;
        series.content_type = crate::models::channel::ContentType::Series;
        let mut channels = vec![live, movie, series];
        filter_channels_by_content_type(&mut channels, false);
        assert_eq!(channels.len(), 3);
    }

    #[test]
    fn content_type_filter_drops_movies_and_series_when_enabled() {
        let mut live = make_channel(0);
        let mut movie = make_channel(1);
        let mut series = make_channel(2);
        live.content_type = crate::models::channel::ContentType::Live;
        movie.content_type = crate::models::channel::ContentType::Movie;
        series.content_type = crate::models::channel::ContentType::Series;
        let mut channels = vec![live, movie, series];
        filter_channels_by_content_type(&mut channels, true);
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].index, 0);
        assert!(matches!(
            channels[0].content_type,
            crate::models::channel::ContentType::Live
        ));
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
    fn parallel_screenshot_outcome_preserves_success_path() {
        let mut shared = make_shared_result();
        shared.screenshot_error_reason = Some("old error".to_string());
        shared.channel_log.screenshot_error_reason = Some("old error".to_string());

        apply_parallel_screenshot_outcome(&mut shared, Ok(Some("/tmp/channel.png".to_string())));

        assert_eq!(shared.screenshot_path.as_deref(), Some("/tmp/channel.png"));
        assert!(shared.screenshot_error_reason.is_none());
        assert!(shared.channel_log.screenshot_error_reason.is_none());
    }

    #[test]
    fn parallel_screenshot_outcome_preserves_error_reason() {
        let mut shared = make_shared_result();

        apply_parallel_screenshot_outcome(
            &mut shared,
            Err(AppError::Other(
                "ffmpeg exited with 1 - no stderr output".to_string(),
            )),
        );

        assert!(shared.screenshot_path.is_none());
        assert_eq!(
            shared.screenshot_error_reason.as_deref(),
            Some("ffmpeg exited with 1 - no stderr output")
        );
        assert_eq!(
            shared.channel_log.screenshot_error_reason.as_deref(),
            Some("ffmpeg exited with 1 - no stderr output")
        );
    }

    #[test]
    fn combined_screenshot_outcome_uses_primary_path() {
        let mut shared = make_shared_result();
        shared.screenshot_error_reason = Some("old error".to_string());
        shared.channel_log.screenshot_error_reason = Some("old error".to_string());

        apply_combined_screenshot_outcome(
            &mut shared,
            Some("/tmp/combined.webp".to_string()),
            Some("ignored error".to_string()),
            Some(Ok("/tmp/fallback.png".to_string())),
        );

        assert_eq!(
            shared.screenshot_path.as_deref(),
            Some("/tmp/combined.webp")
        );
        assert!(shared.screenshot_error_reason.is_none());
        assert!(shared.channel_log.screenshot_error_reason.is_none());
    }

    #[test]
    fn combined_screenshot_outcome_preserves_fallback_failure_reason() {
        let mut shared = make_shared_result();

        apply_combined_screenshot_outcome(
            &mut shared,
            None,
            Some("primary failure".to_string()),
            Some(Err(AppError::Other("fallback failure".to_string()))),
        );

        assert!(shared.screenshot_path.is_none());
        assert_eq!(
            shared.screenshot_error_reason.as_deref(),
            Some("fallback failure")
        );
        assert_eq!(
            shared.channel_log.screenshot_error_reason.as_deref(),
            Some("fallback failure")
        );
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
    async fn cancel_quick_check_cancels_registered_token() {
        let state = AppState::new();
        let token = CancellationToken::new();

        state
            .register_quick_check("archive-probe".to_string(), token.clone())
            .await;
        state.cancel_quick_check("archive-probe").await;

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
