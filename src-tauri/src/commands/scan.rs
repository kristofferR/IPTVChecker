//! Tauri commands that drive scans. The scan itself lives in
//! [`crate::engine::scan`]; these start, pause and stop it for a window and
//! run the single-channel checks the UI asks for.

use std::sync::Arc;
use std::time::Instant;

use futures::stream::{self, StreamExt};
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::engine::scan::{
    self, SharedCheckContext, SharedUrlResult, build_channel_result, compute_shared_url_result,
};
use crate::engine::{checker, ffmpeg, proxy, stream_proxy};
use crate::error::AppError;
use crate::models::channel::{Channel, ChannelResult, ChannelStatus};
use crate::models::scan::{ScanConfig, ScanEvent};
use crate::models::scan_log::ChannelDebugLog;
use crate::state::AppState;

#[tauri::command]
pub async fn start_scan(
    app: AppHandle,
    window: Window,
    config: ScanConfig,
) -> Result<String, AppError> {
    let start_command_started_at = Instant::now();
    let state = app.state::<Arc<AppState>>();

    let pending = scan::begin_scan(state.inner(), window.label(), config).await?;
    let run_id = pending.run_id().to_string();
    // The window follows the run through its events; a failure arrives as
    // `scan://error`.
    tokio::spawn(pending.run(Arc::new(app.clone())));

    let command_ms = start_command_started_at.elapsed().as_secs_f64() * 1000.0;
    scan::record_backend_perf(
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
    scan::cancel_scan_token(state.inner().as_ref(), window.label()).await;
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
    scan::reset_scan_state(state.inner().as_ref(), &scan_scope).await;

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

    let redacted_url = stream_proxy::redact_url(&channel.url);
    let (checked_status, stream_url, latency_ms, error_reason) = match outcome {
        Ok(o) => {
            log::info!(
                "[Quick Check] #{} {} → {} in {:.1}s (url: {})",
                channel.index,
                channel.name,
                o.status,
                check_started_at.elapsed().as_secs_f64(),
                redacted_url,
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
                redacted_url,
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

/// One probed candidate, sent as `dispatcharr://probe-result`.
#[derive(Clone, serde::Serialize)]
struct CandidateProbeEvent {
    request_id: String,
    result: ChannelResult,
}

/// Probes that run at once when candidates come from unlimited accounts.
const CANDIDATE_PROBE_CONCURRENCY: usize = 4;

/// Probe Dispatcharr provider streams that are not loaded rows (candidates to
/// link), with the full scan checks and each account's connection limit.
/// Results arrive one by one as `dispatcharr://probe-result`. An account whose
/// connections Dispatcharr's viewers hold is reported untested ("Account
/// busy") instead of waiting. Cancel with `cancel_quick_check(request_id)`.
#[tauri::command]
pub async fn dispatcharr_probe_streams(
    app: AppHandle,
    request_id: String,
    connection: String,
    channels: Vec<Channel>,
) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().await.clone();
    let cancel = CancellationToken::new();
    state
        .register_quick_check(request_id.clone(), cancel.clone())
        .await;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(settings.accept_invalid_certs)
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .build()
        .unwrap_or_default();
    let (ffmpeg_ok, ffprobe_ok) = ffmpeg::check_availability(&app).await;
    let proxy_list = match (settings.test_geoblock, settings.proxy_file.as_deref()) {
        (true, Some(file)) => proxy::load_proxy_list(file).ok(),
        _ => None,
    };
    let diagnostics_semaphore = Arc::new(Semaphore::new(2));

    stream::iter(channels)
        .for_each_concurrent(CANDIDATE_PROBE_CONCURRENCY, |channel| {
            let (app, cancel, client, proxy_list, diagnostics_semaphore, request_id, settings) = (
                &app,
                &cancel,
                &client,
                &proxy_list,
                &diagnostics_semaphore,
                &request_id,
                &settings,
            );
            let connection = &connection;
            async move {
                let limit =
                    crate::engine::dispatcharr::dispatcharr_connection_limit(&channel.extinf_line);
                let viewers =
                    limit.and_then(|_| crate::engine::dispatcharr::account_viewers(connection));
                let busy = |channel: &Channel| {
                    let mut result = build_channel_result(
                        channel,
                        &SharedUrlResult::dead(
                            None,
                            None,
                            None,
                            Some("Account busy".to_string()),
                            ChannelDebugLog::default(),
                        ),
                    );
                    result.status = ChannelStatus::Pending;
                    result
                };
                let result = async {
                    let _permit = match limit {
                        Some((account_id, limit)) => {
                            if let Some(viewers) = &viewers
                                && viewers.on_account(account_id, false).await >= limit
                            {
                                return Ok(busy(&channel));
                            }
                            let slots = crate::engine::dispatcharr::account_connection_slots(
                                &channel.extinf_line,
                                account_id,
                                limit,
                            );
                            let permit = tokio::select! {
                                permit = Arc::clone(&slots).acquire_owned() => {
                                    permit.map_err(|_| AppError::Cancelled)?
                                }
                                _ = cancel.cancelled() => return Err(AppError::Cancelled),
                            };
                            // Probes and viewers together stay within the limit.
                            if let Some(viewers) = &viewers {
                                let ours = limit.saturating_sub(slots.available_permits());
                                if ours + viewers.on_account(account_id, false).await > limit {
                                    return Ok(busy(&channel));
                                }
                            }
                            Some(permit)
                        }
                        None => None,
                    };
                    let clip_write_lock = tokio::sync::Mutex::new(());
                    let ctx = SharedCheckContext {
                        host: app,
                        client,
                        timeout: settings.timeout,
                        retries: settings.retries,
                        retry_backoff: settings.retry_backoff,
                        extended_timeout: settings.extended_timeout,
                        user_agent: &settings.user_agent,
                        cancel,
                        proxy_list,
                        test_geoblock: settings.test_geoblock,
                        ffmpeg_ok,
                        ffprobe_ok,
                        profile_bitrate_flag: settings.profile_bitrate,
                        ffprobe_timeout_secs: settings.ffprobe_timeout_secs,
                        ffmpeg_bitrate_timeout_secs: settings.ffmpeg_bitrate_timeout_secs,
                        low_fps_threshold: settings.low_fps_threshold,
                        min_video_bitrate_kbps: settings.min_video_bitrate_kbps,
                        screenshot_format: settings.screenshot_format,
                        diagnostics_semaphore,
                        single_connection_mode: limit.is_some(),
                        // Metadata only: no screenshot or clip is written.
                        prune_superseded_clips: false,
                        low_space_threshold_gb: settings.low_space_threshold_gb,
                        clip_write_lock: &clip_write_lock,
                    };
                    let (shared, _) =
                        compute_shared_url_result(&ctx, &channel.url, true, None, None, "").await?;
                    Ok::<_, AppError>(build_channel_result(&channel, &shared))
                }
                .await;
                match result {
                    Ok(result) => {
                        let _ = app.emit(
                            "dispatcharr://probe-result",
                            CandidateProbeEvent {
                                request_id: request_id.clone(),
                                result,
                            },
                        );
                    }
                    Err(AppError::Cancelled) => {}
                    Err(error) => log::warn!("[dispatcharr] candidate probe failed: {}", error),
                }
            }
        })
        .await;

    state.unregister_quick_check(&request_id).await;
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_quick_check(app: AppHandle, request_id: String) {
    app.state::<Arc<AppState>>()
        .cancel_quick_check(&request_id)
        .await;
}
