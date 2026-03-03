use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::engine::{checker, ffmpeg, parser, proxy, resume};
use crate::error::AppError;
use crate::models::channel::{ChannelResult, ChannelStatus};
use crate::models::scan::{ScanConfig, ScanProgress, ScanSummary};
use crate::state::AppState;

#[tauri::command]
pub async fn start_scan(
    app: AppHandle,
    config: ScanConfig,
) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();

    // Prevent multiple simultaneous scans
    {
        let mut scanning = state.scanning.lock().await;
        if *scanning {
            return Err(AppError::Other("A scan is already in progress".to_string()));
        }
        *scanning = true;
    }

    if config.concurrency < 1 {
        let mut scanning = state.scanning.lock().await;
        *scanning = false;
        return Err(AppError::Other("Concurrency must be at least 1".to_string()));
    }

    let cancel_token = CancellationToken::new();
    {
        let mut token_lock = state.cancel_token.lock().await;
        *token_lock = Some(cancel_token.clone());
    }

    // Parse the playlist
    let preview = parser::parse_playlist(
        &config.file_path,
        &config.group_filter,
        &config.channel_search,
    )?;

    let channels = preview.channels;
    let total = channels.len();

    if total == 0 {
        let _ = app.emit("scan://complete", ScanSummary {
            total: 0,
            alive: 0,
            dead: 0,
            geoblocked: 0,
            low_framerate: 0,
            mislabeled: 0,
        });
        let mut scanning = state.scanning.lock().await;
        *scanning = false;
        return Ok(());
    }

    // Load proxies if configured
    let proxy_list = if let Some(ref proxy_file) = config.proxy_file {
        proxy::load_proxy_list(proxy_file).ok()
    } else {
        None
    };

    // Check ffmpeg availability
    let (ffmpeg_available, ffprobe_available) = ffmpeg::check_availability(&app).await;

    // Resume support
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
        .map(|g| g.replace('|', "").replace(' ', ""))
        .unwrap_or_else(|| "AllGroups".to_string());

    let log_file = format!("{}/{}_{}_checklog.txt", playlist_dir, base_name, group_suffix);
    let (processed_channels, _last_index) = resume::load_processed_channels(&log_file);

    // Screenshots directory
    let screenshots_dir = if !config.skip_screenshots && ffmpeg_available {
        let dir = config.screenshots_dir.clone().unwrap_or_else(|| {
            format!("{}/{}_{}_screenshots", playlist_dir, base_name, group_suffix)
        });
        std::fs::create_dir_all(&dir).ok();
        Some(dir)
    } else {
        None
    };

    // Spawn the scan task
    let app_handle = app.clone();
    let state_clone = state.inner().clone();

    tokio::spawn(async move {
        let client = Arc::new(
            reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .unwrap_or_default(),
        );
        let semaphore = Arc::new(Semaphore::new(config.concurrency as usize));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ChannelResult>(256);

        // Spawn a task to forward results as events
        let app_for_events = app_handle.clone();
        let event_task = tokio::spawn(async move {
            let mut alive = 0usize;
            let mut dead = 0usize;
            let mut geoblocked = 0usize;
            let mut low_framerate = 0usize;
            let mut mislabeled = 0usize;
            let mut completed = 0usize;

            while let Some(result) = rx.recv().await {
                match result.status {
                    ChannelStatus::Alive => alive += 1,
                    ChannelStatus::Dead => dead += 1,
                    ChannelStatus::Geoblocked
                    | ChannelStatus::GeoblockedConfirmed
                    | ChannelStatus::GeoblockedUnconfirmed => geoblocked += 1,
                    _ => {}
                }
                if result.low_framerate {
                    low_framerate += 1;
                }
                if !result.label_mismatches.is_empty() {
                    mislabeled += 1;
                }
                completed += 1;

                let _ = app_for_events.emit("scan://channel-result", &result);
                let _ = app_for_events.emit(
                    "scan://progress",
                    ScanProgress {
                        completed,
                        total,
                        alive,
                        dead,
                        geoblocked,
                    },
                );
            }

            ScanSummary {
                total,
                alive,
                dead,
                geoblocked,
                low_framerate,
                mislabeled,
            }
        });

        // Process channels
        let proxy_list = Arc::new(proxy_list);
        let mut handles = Vec::new();

        for channel in channels {
            if cancel_token.is_cancelled() {
                break;
            }

            let identifier = format!("{} {}", channel.name, channel.url);
            if processed_channels.contains(&identifier) {
                continue;
            }

            let permit = semaphore.clone().acquire_owned().await;
            if permit.is_err() {
                break;
            }
            let _permit = permit.unwrap();

            let tx = tx.clone();
            let cancel = cancel_token.clone();
            let client = Arc::clone(&client);
            let user_agent = config.user_agent.clone();
            let timeout = config.timeout;
            let retries = config.retries;
            let extended_timeout = config.extended_timeout;
            let proxy_list = Arc::clone(&proxy_list);
            let test_geoblock = config.test_geoblock;
            let skip_screenshots = config.skip_screenshots;
            let profile_bitrate_flag = config.profile_bitrate;
            let screenshots_dir = screenshots_dir.clone();
            let log_file = log_file.clone();
            let ffmpeg_ok = ffmpeg_available;
            let ffprobe_ok = ffprobe_available;
            let task_app = app_handle.clone();

            let handle = tokio::spawn(async move {
                if cancel.is_cancelled() {
                    return;
                }

                let (status_str, stream_url) = match checker::check_channel_status(
                    &client,
                    &channel.url,
                    timeout,
                    retries,
                    extended_timeout,
                    &user_agent,
                    &cancel,
                )
                .await
                {
                    Ok(r) => r,
                    Err(AppError::Cancelled) => return,
                    Err(_) => ("Dead".to_string(), None),
                };

                // Handle geoblock proxy confirmation
                let final_status_str = if status_str == "Geoblocked" && test_geoblock {
                    if let Some(ref proxies) = *proxy_list {
                        if !proxies.is_empty() {
                            proxy::confirm_geoblock(&channel.url, proxies, timeout).await
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
                    "Dead" => ChannelStatus::Dead,
                    "Geoblocked" => ChannelStatus::Geoblocked,
                    "Geoblocked (Confirmed)" => ChannelStatus::GeoblockedConfirmed,
                    "Geoblocked (Unconfirmed)" => ChannelStatus::GeoblockedUnconfirmed,
                    _ => ChannelStatus::Dead,
                };

                let mut result = ChannelResult {
                    index: channel.index,
                    name: channel.name.clone(),
                    group: channel.group.clone(),
                    url: channel.url.clone(),
                    status: status.clone(),
                    codec: None,
                    resolution: None,
                    width: None,
                    height: None,
                    fps: None,
                    video_bitrate: None,
                    audio_bitrate: None,
                    audio_codec: None,
                    screenshot_path: None,
                    label_mismatches: Vec::new(),
                    low_framerate: false,
                    error_message: None,
                    channel_id: parser::get_channel_id(&channel.url),
                    extinf_line: channel.extinf_line.clone(),
                    metadata_lines: channel.metadata_lines.clone(),
                    stream_url: stream_url.clone(),
                };

                // Get metadata for alive channels
                if status == ChannelStatus::Alive && !cancel.is_cancelled() {
                    let target_url = stream_url.as_deref().unwrap_or(&channel.url);

                    if ffprobe_ok {
                        if let Ok(info) = ffmpeg::get_stream_info(&task_app, target_url, &cancel).await {
                            result.codec = Some(info.codec);
                            result.resolution = Some(info.resolution.clone());
                            result.width = info.width;
                            result.height = info.height;
                            result.fps = info.fps;

                            if let Some(fps) = info.fps {
                                if fps <= 30 {
                                    result.low_framerate = true;
                                }
                            }

                            let mismatches =
                                ffmpeg::check_label_mismatch(&channel.name, &info.resolution);
                            result.label_mismatches = mismatches;
                        }

                        if !cancel.is_cancelled() {
                            if let Ok(audio) = ffmpeg::get_audio_info(&task_app, target_url, &cancel).await {
                                result.audio_codec = Some(audio.codec);
                                result.audio_bitrate =
                                    audio.bitrate_kbps.map(|b| format!("{}", b));
                            }
                        }

                        if !cancel.is_cancelled() && profile_bitrate_flag && ffmpeg_ok {
                            if let Ok(bitrate) =
                                ffmpeg::profile_bitrate(&task_app, target_url, &user_agent, &cancel).await
                            {
                                result.video_bitrate = Some(bitrate);
                            }
                        }
                    }

                    // Capture screenshot
                    if !cancel.is_cancelled() && !skip_screenshots && ffmpeg_ok {
                        if let Some(ref dir) = screenshots_dir {
                            let file_name = format!(
                                "{}-{}",
                                channel.index + 1,
                                channel.name.replace('/', "-")
                            );
                            if let Ok(path) =
                                ffmpeg::capture_screenshot(&task_app, target_url, dir, &file_name, &cancel).await
                            {
                                result.screenshot_path = Some(path);
                            }
                        }
                    }
                }

                // Write checkpoint log
                let _ = resume::write_log_entry(
                    &log_file,
                    &format!(
                        "{} - {} {}",
                        channel.index + 1,
                        channel.name,
                        channel.url
                    ),
                );

                let _ = tx.send(result).await;
                drop(_permit);
            });

            handles.push(handle);
        }

        // Wait for all channel checks to complete
        for handle in handles {
            let _ = handle.await;
        }

        // Drop the sender to close the channel
        drop(tx);

        // Wait for event forwarding to finish
        let summary = event_task.await.unwrap_or(ScanSummary {
            total,
            alive: 0,
            dead: 0,
            geoblocked: 0,
            low_framerate: 0,
            mislabeled: 0,
        });

        if cancel_token.is_cancelled() {
            let _ = app_handle.emit("scan://cancelled", ());
        } else {
            let _ = app_handle.emit("scan://complete", &summary);
        }

        // Reset scanning state
        let mut scanning = state_clone.scanning.lock().await;
        *scanning = false;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_scan(app: AppHandle) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let token = state.cancel_token.lock().await;
    if let Some(ref cancel) = *token {
        cancel.cancel();
    }
    Ok(())
}
