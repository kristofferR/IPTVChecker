//! Save a catch-up programme to disk by remuxing the archive stream with
//! ffmpeg. Progress streams back over `archive-download://progress`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::engine::ffmpeg;
use crate::error::AppError;
use crate::state::AppState;

pub const ARCHIVE_DOWNLOAD_PROGRESS_EVENT: &str = "archive-download://progress";
const MAX_DOWNLOAD_DURATION_S: u64 = 24 * 3600;
/// Give up when the provider stalls for this long (microseconds, ffmpeg units).
const RW_TIMEOUT_US: &str = "30000000";

#[derive(Debug, Clone, Deserialize)]
pub struct ArchiveDownloadRequest {
    pub id: String,
    pub url: String,
    pub path: String,
    pub duration_s: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveDownloadProgress {
    pub id: String,
    pub out_time_s: f64,
    pub bytes: u64,
}

fn validate(request: &ArchiveDownloadRequest) -> Result<(), AppError> {
    if request.id.trim().is_empty() {
        return Err(AppError::Validation("Download id is required".to_string()));
    }
    if !(request.url.starts_with("http://") || request.url.starts_with("https://")) {
        return Err(AppError::Validation(
            "Archive downloads need an http(s) stream URL".to_string(),
        ));
    }
    if request.path.trim().is_empty() {
        return Err(AppError::Validation(
            "Choose where to save the recording".to_string(),
        ));
    }
    if request.duration_s == 0 || request.duration_s > MAX_DOWNLOAD_DURATION_S {
        return Err(AppError::Validation(format!(
            "Recording length must be between 1 second and {} hours",
            MAX_DOWNLOAD_DURATION_S / 3600
        )));
    }
    Ok(())
}

/// Parse one `-progress` key=value line into the running progress snapshot.
/// Returns true when the line closes a progress block and a snapshot should be emitted.
fn apply_progress_line(line: &str, progress: &mut ArchiveDownloadProgress) -> bool {
    let Some((key, value)) = line.split_once('=') else {
        return false;
    };
    match key.trim() {
        "out_time_us" | "out_time_ms" => {
            // Despite the name, ffmpeg reports out_time_ms in microseconds.
            if let Ok(us) = value.trim().parse::<i64>() {
                progress.out_time_s = (us.max(0) as f64) / 1_000_000.0;
            }
            false
        }
        "total_size" => {
            if let Ok(bytes) = value.trim().parse::<u64>() {
                progress.bytes = bytes;
            }
            false
        }
        "progress" => true,
        _ => false,
    }
}

#[tauri::command]
pub async fn download_archive(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    request: ArchiveDownloadRequest,
) -> Result<(), AppError> {
    validate(&request)?;
    // Register before any slow step so an early Cancel is not lost.
    let cancel = CancellationToken::new();
    state
        .register_archive_download(request.id.clone(), cancel.clone())
        .await;
    let result = async {
        let (ffmpeg_available, _) = ffmpeg::check_availability(&app).await;
        if !ffmpeg_available {
            return Err(AppError::FfmpegNotAvailable);
        }
        if cancel.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        let user_agent = state.settings.lock().await.user_agent.clone();
        // Record into a sibling .part file so a failure never touches an
        // existing file at the chosen path, then move it into place.
        let part_path = partial_path(&request.path);
        let outcome = run_download(&app, &request, &part_path, &user_agent, &cancel).await;
        match outcome {
            Ok(()) => crate::engine::disk::atomic_rename(
                std::path::Path::new(&request.path),
                std::path::Path::new(&part_path),
            ),
            Err(error) => {
                let _ = std::fs::remove_file(&part_path);
                Err(error)
            }
        }
    }
    .await;
    state.unregister_archive_download(&request.id).await;
    result
}

fn partial_path(path: &str) -> String {
    format!("{path}.part")
}

async fn run_download(
    app: &AppHandle,
    request: &ArchiveDownloadRequest,
    output_path: &str,
    user_agent: &str,
    cancel: &CancellationToken,
) -> Result<(), AppError> {
    let duration = request.duration_s.to_string();
    let args: Vec<&str> = vec![
        "-y",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-nostats",
        "-user_agent",
        user_agent,
        "-rw_timeout",
        RW_TIMEOUT_US,
        "-i",
        &request.url,
        "-t",
        &duration,
        "-c",
        "copy",
        "-f",
        "mpegts",
        "-progress",
        "pipe:1",
        output_path,
    ];
    let resolved_bin = ffmpeg::resolve_binary(app, "ffmpeg");
    let mut command = tokio::process::Command::new(&resolved_bin);
    ffmpeg::configure_background_process(&mut command);
    let mut child = command
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| {
            log::warn!("Failed to spawn ffmpeg for archive download: {err}");
            AppError::FfmpegNotAvailable
        })?;

    let stderr_pipe = child.stderr.take();
    let stderr_reader = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).to_string()
    });

    let stdout = child.stdout.take();
    let progress_app = app.clone();
    let progress_id = request.id.clone();
    let progress_reader = tokio::spawn(async move {
        let Some(stdout) = stdout else { return };
        let mut lines = BufReader::new(stdout).lines();
        let mut progress = ArchiveDownloadProgress {
            id: progress_id,
            out_time_s: 0.0,
            bytes: 0,
        };
        while let Ok(Some(line)) = lines.next_line().await {
            if apply_progress_line(&line, &mut progress) {
                let _ = progress_app.emit(ARCHIVE_DOWNLOAD_PROGRESS_EVENT, progress.clone());
            }
        }
    });

    let status = tokio::select! {
        _ = cancel.cancelled() => {
            ffmpeg::graceful_kill(&mut child, ffmpeg::GRACEFUL_KILL_TIMEOUT).await;
            progress_reader.abort();
            stderr_reader.abort();
            return Err(AppError::Cancelled);
        }
        status = child.wait() => status.map_err(|_| AppError::FfmpegNotAvailable)?,
    };
    let _ = progress_reader.await;
    let stderr = stderr_reader.await.unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    Err(AppError::Other(format!(
        "ffmpeg exited with {} - {}",
        status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string()),
        ffmpeg::stderr_excerpt(&stderr)
    )))
}

#[tauri::command]
pub async fn cancel_archive_download(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), AppError> {
    state.cancel_archive_download(&id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_update_snapshot_and_flag_block_end() {
        let mut progress = ArchiveDownloadProgress {
            id: "x".into(),
            out_time_s: 0.0,
            bytes: 0,
        };
        assert!(!apply_progress_line("out_time_us=1500000", &mut progress));
        assert!(!apply_progress_line("total_size=2048", &mut progress));
        assert!(apply_progress_line("progress=continue", &mut progress));
        assert_eq!(progress.out_time_s, 1.5);
        assert_eq!(progress.bytes, 2048);
        // ffmpeg emits N/A before the first packet is written.
        assert!(!apply_progress_line("out_time_us=N/A", &mut progress));
        assert_eq!(progress.out_time_s, 1.5);
    }

    #[test]
    fn validation_rejects_bad_requests() {
        let base = ArchiveDownloadRequest {
            id: "id".into(),
            url: "http://host/a.m3u8".into(),
            path: "/tmp/a.ts".into(),
            duration_s: 60,
        };
        assert!(validate(&base).is_ok());
        assert!(validate(&ArchiveDownloadRequest {
            url: "rtsp://host/a".into(),
            ..base.clone()
        })
        .is_err());
        assert!(validate(&ArchiveDownloadRequest {
            duration_s: 0,
            ..base.clone()
        })
        .is_err());
        assert!(validate(&ArchiveDownloadRequest {
            path: " ".into(),
            ..base
        })
        .is_err());
    }
}
