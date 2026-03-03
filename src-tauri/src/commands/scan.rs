use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::engine::{checker, ffmpeg, parser, proxy, resume};
use crate::error::AppError;
use crate::models::channel::{Channel, ChannelResult, ChannelStatus};
use crate::models::scan::{ScanConfig, ScanProgress, ScanSummary};
use crate::state::AppState;

#[derive(Debug, Clone)]
struct SharedUrlResult {
    status: ChannelStatus,
    codec: Option<String>,
    resolution: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    video_bitrate: Option<String>,
    audio_bitrate: Option<String>,
    audio_codec: Option<String>,
    screenshot_path: Option<String>,
    low_framerate: bool,
    stream_url: Option<String>,
}

impl SharedUrlResult {
    fn dead(stream_url: Option<String>) -> Self {
        Self {
            status: ChannelStatus::Dead,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            screenshot_path: None,
            low_framerate: false,
            stream_url,
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
    extended_timeout: Option<f64>,
    user_agent: &str,
    cancel: &CancellationToken,
    proxy_list: &Option<Vec<String>>,
    test_geoblock: bool,
    ffmpeg_ok: bool,
    ffprobe_ok: bool,
    profile_bitrate_flag: bool,
    skip_screenshots: bool,
    screenshots_dir: Option<&String>,
    screenshot_file_name: &str,
) -> Result<SharedUrlResult, AppError> {
    let (status_str, stream_url) = match checker::check_channel_status(
        client,
        channel_url,
        timeout,
        retries,
        extended_timeout,
        user_agent,
        cancel,
    )
    .await
    {
        Ok(r) => r,
        Err(AppError::Cancelled) => return Err(AppError::Cancelled),
        Err(_) => ("Dead".to_string(), None),
    };

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
        "Dead" => ChannelStatus::Dead,
        "Geoblocked" => ChannelStatus::Geoblocked,
        "Geoblocked (Confirmed)" => ChannelStatus::GeoblockedConfirmed,
        "Geoblocked (Unconfirmed)" => ChannelStatus::GeoblockedUnconfirmed,
        _ => ChannelStatus::Dead,
    };

    if status != ChannelStatus::Alive || cancel.is_cancelled() {
        return Ok(SharedUrlResult::dead(stream_url));
    }

    let target_url = stream_url
        .as_deref()
        .unwrap_or(channel_url)
        .to_string();
    let mut shared = SharedUrlResult {
        status,
        codec: None,
        resolution: None,
        width: None,
        height: None,
        fps: None,
        video_bitrate: None,
        audio_bitrate: None,
        audio_codec: None,
        screenshot_path: None,
        low_framerate: false,
        stream_url,
    };

    if ffprobe_ok {
        if let Ok(info) = ffmpeg::get_stream_info(app, &target_url, cancel).await {
            shared.codec = Some(info.codec);
            shared.resolution = Some(info.resolution.clone());
            shared.width = info.width;
            shared.height = info.height;
            shared.fps = info.fps;
            shared.low_framerate = info.fps.map(|fps| fps < 29).unwrap_or(false);
        }

        if !cancel.is_cancelled() {
            if let Ok(audio) = ffmpeg::get_audio_info(app, &target_url, cancel).await {
                shared.audio_codec = Some(audio.codec);
                shared.audio_bitrate = audio.bitrate_kbps.map(|b| format!("{}", b));
            }
        }

        if !cancel.is_cancelled() && profile_bitrate_flag && ffmpeg_ok {
            if let Ok(bitrate) =
                ffmpeg::profile_bitrate(app, &target_url, user_agent, cancel).await
            {
                shared.video_bitrate = Some(bitrate);
            }
        }
    }

    if !cancel.is_cancelled() && !skip_screenshots && ffmpeg_ok {
        if let Some(dir) = screenshots_dir {
            if let Ok(path) = ffmpeg::capture_screenshot(
                app,
                &target_url,
                dir,
                screenshot_file_name,
                user_agent,
                cancel,
            )
            .await
            {
                shared.screenshot_path = Some(path);
            }
        }
    }

    Ok(shared)
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

async fn cancel_scan_token(state: &AppState) {
    let token = state.cancel_token.lock().await;
    if let Some(ref cancel) = *token {
        cancel.cancel();
    }
}

async fn reset_scan_state(state: &AppState) {
    cancel_scan_token(state).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let mut scanning = state.scanning.lock().await;
    mark_scan_finished(&mut scanning);
}

#[derive(Debug, Default, Clone, Copy)]
struct ScanCounters {
    completed: usize,
    alive: usize,
    dead: usize,
    geoblocked: usize,
    low_framerate: usize,
    mislabeled: usize,
}

impl ScanCounters {
    fn apply(&mut self, result: &ChannelResult) {
        match result.status {
            ChannelStatus::Alive => self.alive += 1,
            ChannelStatus::Dead => self.dead += 1,
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
            geoblocked: self.geoblocked,
        }
    }

    fn as_summary(&self, total: usize) -> ScanSummary {
        ScanSummary {
            total,
            alive: self.alive,
            dead: self.dead,
            geoblocked: self.geoblocked,
            low_framerate: self.low_framerate,
            mislabeled: self.mislabeled,
        }
    }
}

fn filter_channels_by_selection(channels: &mut Vec<Channel>, selected_indices: &Option<Vec<usize>>) {
    if let Some(selected_indices) = selected_indices {
        let selected: HashSet<usize> = selected_indices.iter().copied().collect();
        channels.retain(|channel| selected.contains(&channel.index));
    }
}

#[tauri::command]
pub async fn start_scan(app: AppHandle, config: ScanConfig) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();

    // Prevent multiple simultaneous scans
    {
        let mut scanning = state.scanning.lock().await;
        config.validate()?;
        try_mark_scan_started(&mut scanning)?;
    }

    let cancel_token = CancellationToken::new();
    {
        let mut token_lock = state.cancel_token.lock().await;
        *token_lock = Some(cancel_token.clone());
    }

    log::info!(
        "Starting scan: {} (concurrency: {}, retries: {})",
        config.file_path,
        config.concurrency,
        config.retries
    );

    // Parse the playlist
    let preview = parser::parse_playlist(
        &config.file_path,
        &config.group_filter,
        &config.channel_search,
    )?;

    let mut channels = preview.channels;
    filter_channels_by_selection(&mut channels, &config.selected_indices);
    let total = channels.len();
    log::info!("Scan: {} channels to check", total);

    if total == 0 {
        let _ = app.emit(
            "scan://complete",
            ScanSummary {
                total: 0,
                alive: 0,
                dead: 0,
                geoblocked: 0,
                low_framerate: 0,
                mislabeled: 0,
            },
        );
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

    let log_file = format!(
        "{}/{}_{}_checklog.txt",
        playlist_dir, base_name, group_suffix
    );

    // Always start fresh — GUI scans are explicitly triggered by the user
    let _ = std::fs::write(&log_file, "");

    // Screenshots directory — use app temp dir by default (in-app preview only),
    // or a user-specified folder if configured.
    let screenshots_dir = if !config.skip_screenshots && ffmpeg_available {
        let dir = match config.screenshots_dir.clone() {
            Some(d) => d,
            None => {
                let temp = app
                    .path()
                    .temp_dir()
                    .unwrap_or_else(|_| std::env::temp_dir());
                temp.join("iptv-checker-screenshots")
                    .join(format!("{}_{}", base_name, group_suffix))
                    .to_string_lossy()
                    .to_string()
            }
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            let mut scanning = state.scanning.lock().await;
            *scanning = false;
            return Err(AppError::Other(format!(
                "Failed to create screenshots directory: {}",
                e
            )));
        }
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
            let mut counters = ScanCounters::default();

            while let Some(result) = rx.recv().await {
                counters.apply(&result);

                let _ = app_for_events.emit("scan://channel-result", &result);
                let _ = app_for_events.emit("scan://progress", counters.as_progress(total));
            }

            counters.as_summary(total)
        });

        // Process channels
        let proxy_list = Arc::new(proxy_list);
        let shared_url_results: Arc<
            tokio::sync::Mutex<
                HashMap<String, Arc<tokio::sync::OnceCell<Result<SharedUrlResult, AppError>>>>,
            >,
        > = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut handles = Vec::new();

        for channel in channels {
            if cancel_token.is_cancelled() {
                break;
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
            let shared_url_results = Arc::clone(&shared_url_results);

            let handle = tokio::spawn(async move {
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

                let shared_result = result_cell
                    .get_or_init(|| async {
                        compute_shared_url_result(
                            &task_app,
                            &client,
                            &channel.url,
                            timeout,
                            retries,
                            extended_timeout,
                            &user_agent,
                            &cancel,
                            &proxy_list,
                            test_geoblock,
                            ffmpeg_ok,
                            ffprobe_ok,
                            profile_bitrate_flag,
                            skip_screenshots,
                            screenshots_dir.as_ref(),
                            &screenshot_file_name,
                        )
                        .await
                    })
                    .await;

                let shared = match shared_result {
                    Ok(value) => value.clone(),
                    Err(AppError::Cancelled) => return,
                    Err(_) => SharedUrlResult::dead(None),
                };

                let mut result = ChannelResult {
                    index: channel.index,
                    name: channel.name.clone(),
                    group: channel.group.clone(),
                    url: channel.url.clone(),
                    status: shared.status.clone(),
                    codec: shared.codec.clone(),
                    resolution: shared.resolution.clone(),
                    width: shared.width,
                    height: shared.height,
                    fps: shared.fps,
                    video_bitrate: shared.video_bitrate.clone(),
                    audio_bitrate: shared.audio_bitrate.clone(),
                    audio_codec: shared.audio_codec.clone(),
                    screenshot_path: shared.screenshot_path.clone(),
                    label_mismatches: Vec::new(),
                    low_framerate: shared.low_framerate,
                    error_message: None,
                    channel_id: parser::get_channel_id(&channel.url),
                    extinf_line: channel.extinf_line.clone(),
                    metadata_lines: channel.metadata_lines.clone(),
                    stream_url: shared.stream_url.clone(),
                };

                if result.status == ChannelStatus::Alive {
                    if let Some(ref resolution) = result.resolution {
                        result.label_mismatches =
                            ffmpeg::check_label_mismatch(&channel.name, resolution);
                    }
                }

                // Write checkpoint log
                let _ = resume::write_log_entry(
                    &log_file,
                    &format!("{} - {} {}", channel.index + 1, channel.name, channel.url),
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
        mark_scan_finished(&mut scanning);
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_scan(app: AppHandle) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    cancel_scan_token(state.inner().as_ref()).await;
    Ok(())
}

/// Cancel any running scan and force-reset the scanning flag.
/// Called when opening a new playlist or on app startup to ensure clean state.
#[tauri::command]
pub async fn reset_scan(app: AppHandle) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    reset_scan_state(state.inner().as_ref()).await;

    log::info!("Scan state reset");
    Ok(())
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
            name: format!("Channel {}", index),
            group: "Test".to_string(),
            url: format!("http://example.com/{}.m3u8", index),
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
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
        }
    }

    fn make_channel(index: usize) -> Channel {
        Channel {
            index,
            name: format!("Channel {}", index),
            group: "Test".to_string(),
            url: format!("http://example.com/{}.m3u8", index),
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
        assert_eq!(canonicalize_stream_url("  not-a-valid-url  "), "not-a-valid-url");
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
    fn concurrent_start_guard_rejects_second_start() {
        let mut scanning = false;
        assert!(try_mark_scan_started(&mut scanning).is_ok());
        assert!(try_mark_scan_started(&mut scanning).is_err());
    }

    #[test]
    fn scan_counters_follow_event_order() {
        let mut counters = ScanCounters::default();
        let total = 3usize;

        let alive = make_result(0, ChannelStatus::Alive, true, true);
        counters.apply(&alive);
        let progress = counters.as_progress(total);
        assert_eq!(progress.completed, 1);
        assert_eq!(progress.alive, 1);
        assert_eq!(progress.dead, 0);
        assert_eq!(progress.geoblocked, 0);

        let geoblocked = make_result(1, ChannelStatus::Geoblocked, false, false);
        counters.apply(&geoblocked);
        let dead = make_result(2, ChannelStatus::Dead, false, false);
        counters.apply(&dead);

        let summary = counters.as_summary(total);
        assert_eq!(summary.total, 3);
        assert_eq!(summary.alive, 1);
        assert_eq!(summary.dead, 1);
        assert_eq!(summary.geoblocked, 1);
        assert_eq!(summary.low_framerate, 1);
        assert_eq!(summary.mislabeled, 1);
    }

    #[tokio::test]
    async fn cancel_scan_token_cancels_active_token() {
        let state = AppState::new();
        let token = CancellationToken::new();

        {
            let mut lock = state.cancel_token.lock().await;
            *lock = Some(token.clone());
        }

        cancel_scan_token(state.as_ref()).await;
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn reset_scan_state_cancels_token_and_clears_flag() {
        let state = AppState::new();
        let token = CancellationToken::new();

        {
            let mut token_lock = state.cancel_token.lock().await;
            *token_lock = Some(token.clone());
        }
        {
            let mut scan_lock = state.scanning.lock().await;
            *scan_lock = true;
        }

        reset_scan_state(state.as_ref()).await;

        assert!(token.is_cancelled());
        let scanning = state.scanning.lock().await;
        assert!(!*scanning);
    }
}
