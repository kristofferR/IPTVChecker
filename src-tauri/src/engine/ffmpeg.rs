use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

// Compile-time target triple for resolving sidecar binary paths.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";

/// Resolve the path to an executable, preferring the bundled sidecar binary
/// over the system PATH. This bypasses the Tauri shell plugin which can
/// silently fail for long-running commands.
fn resolve_binary(app: &AppHandle, name: &str) -> String {
    let ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let sidecar_name = format!("{name}-{TARGET_TRIPLE}{ext}");

    if let Ok(dir) = app.path().resource_dir() {
        let path = dir.join(&sidecar_name);
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }

    // Fall back to system PATH
    name.to_string()
}

/// Run a sidecar command with args, falling back to system PATH.
/// Respects cancellation token — kills child process on cancel.
async fn run_sidecar(
    app: &AppHandle,
    name: &str,
    args: &[&str],
    cancel: &CancellationToken,
) -> Result<(String, String), AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    // Try sidecar first
    if let Ok(cmd) = app.shell().sidecar(format!("binaries/{}", name)) {
        if let Ok(output) = cmd.args(args).output().await {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Ok((stdout, stderr));
        }
    }

    // Fallback to system PATH — with cancellation support
    let mut child = tokio::process::Command::new(name)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| AppError::FfmpegNotAvailable)?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            Err(AppError::Cancelled)
        }
        status = child.wait() => {
            let _ = status.map_err(|_| AppError::FfmpegNotAvailable)?;
            let mut stdout_buf = Vec::new();
            let mut stderr_buf = Vec::new();
            if let Some(ref mut pipe) = stdout_pipe {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_end(&mut stdout_buf).await;
            }
            if let Some(ref mut pipe) = stderr_pipe {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_end(&mut stderr_buf).await;
            }
            Ok((
                String::from_utf8_lossy(&stdout_buf).to_string(),
                String::from_utf8_lossy(&stderr_buf).to_string(),
            ))
        }
    }
}

/// Check if ffmpeg and ffprobe sidecars are available.
pub async fn check_availability(app: &AppHandle) -> (bool, bool) {
    let no_cancel = CancellationToken::new();
    let ffmpeg_ok = run_sidecar(app, "ffmpeg", &["-version"], &no_cancel).await.is_ok();
    let ffprobe_ok = run_sidecar(app, "ffprobe", &["-version"], &no_cancel).await.is_ok();
    log::debug!("ffmpeg available: {}, ffprobe available: {}", ffmpeg_ok, ffprobe_ok);
    (ffmpeg_ok, ffprobe_ok)
}

/// Video stream info from ffprobe.
#[derive(Debug, Clone)]
pub struct VideoInfo {
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub resolution: String,
}

/// Audio stream info from ffprobe.
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
}

/// Get video stream info via ffprobe sidecar.
pub async fn get_stream_info(app: &AppHandle, url: &str, cancel: &CancellationToken) -> Result<VideoInfo, AppError> {
    log::debug!("Getting stream info for: {}", url);
    let (stdout, _) = run_sidecar(
        app,
        "ffprobe",
        &[
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,r_frame_rate",
            "-of", "default=noprint_wrappers=1",
            url,
        ],
        cancel,
    )
    .await?;

    let mut codec = String::from("Unknown");
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut fps: Option<u32> = None;

    for line in stdout.lines() {
        if let Some(val) = line.strip_prefix("codec_name=") {
            codec = val.to_uppercase();
        } else if let Some(val) = line.strip_prefix("width=") {
            width = val.parse().ok();
        } else if let Some(val) = line.strip_prefix("height=") {
            height = val.parse().ok();
        } else if let Some(val) = line.strip_prefix("r_frame_rate=") {
            if !val.is_empty() {
                if let Some((num, den)) = val.split_once('/') {
                    let n: f64 = num.parse().unwrap_or(0.0);
                    let d: f64 = den.parse().unwrap_or(1.0);
                    if d > 0.0 {
                        let computed = (n / d).round() as u32;
                        if computed > 0 {
                            fps = Some(computed);
                        }
                    }
                } else {
                    fps = val.parse::<f64>().ok().and_then(|f| {
                        let rounded = f.round() as u32;
                        if rounded > 0 { Some(rounded) } else { None }
                    });
                }
            }
        }
    }

    let resolution = match (width, height) {
        (Some(w), Some(h)) if w >= 3840 && h >= 2160 => "4K".to_string(),
        (Some(w), Some(h)) if w >= 1920 && h >= 1080 => "1080p".to_string(),
        (Some(w), Some(h)) if w >= 1280 && h >= 720 => "720p".to_string(),
        (Some(_), Some(_)) => "SD".to_string(),
        _ => "Unknown".to_string(),
    };

    Ok(VideoInfo {
        codec,
        width,
        height,
        fps,
        resolution,
    })
}

/// Get audio stream info via ffprobe sidecar.
pub async fn get_audio_info(app: &AppHandle, url: &str, cancel: &CancellationToken) -> Result<AudioInfo, AppError> {
    let (stdout, _) = run_sidecar(
        app,
        "ffprobe",
        &[
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,bit_rate",
            "-of", "default=noprint_wrappers=1",
            url,
        ],
        cancel,
    )
    .await?;

    let mut codec = String::from("Unknown");
    let mut bitrate_kbps: Option<u32> = None;

    for line in stdout.lines() {
        if let Some(val) = line.strip_prefix("codec_name=") {
            codec = val.to_uppercase();
        } else if let Some(val) = line.strip_prefix("bit_rate=") {
            bitrate_kbps = val.parse::<u64>().ok().map(|b| (b / 1000) as u32);
        }
    }

    Ok(AudioInfo {
        codec,
        bitrate_kbps,
    })
}

/// Capture a screenshot frame from a stream via ffmpeg.
/// Uses tokio::process::Command directly for reliability — the Tauri shell
/// plugin sidecar execution can silently fail for long-running ffmpeg tasks.
pub async fn capture_screenshot(
    app: &AppHandle,
    url: &str,
    output_dir: &str,
    file_name: &str,
    user_agent: &str,
    cancel: &CancellationToken,
) -> Result<String, AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    let output_path = Path::new(output_dir).join(format!("{}.png", file_name));
    let output_str = output_path.to_string_lossy().to_string();
    let timeout_duration = std::time::Duration::from_secs(15);

    let ffmpeg_bin = resolve_binary(app, "ffmpeg");

    // Capture the first available frame — no seeking (-ss) since live IPTV
    // streams don't support it reliably and it causes hangs.
    let mut child = tokio::process::Command::new(&ffmpeg_bin)
        .args([
            "-y",
            "-user_agent", user_agent,
            "-i", url,
            "-frames:v", "1",
            &output_str,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| AppError::FfmpegNotAvailable)?;

    let success = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err(AppError::Cancelled);
        }
        _ = tokio::time::sleep(timeout_duration) => {
            let _ = child.kill().await;
            log::warn!("Screenshot capture timed out for {}", file_name);
            false
        }
        result = child.wait() => {
            result.map(|s| s.success()).unwrap_or(false)
        }
    };

    if success && output_path.exists() {
        log::debug!("Screenshot captured: {}", output_str);
        Ok(output_str)
    } else {
        log::warn!(
            "Screenshot capture failed for {} (success={}, exists={})",
            file_name,
            success,
            output_path.exists()
        );
        Err(AppError::Other(format!(
            "Failed to capture screenshot for {}",
            file_name
        )))
    }
}

/// Profile approximate video bitrate by sampling the stream for 10 seconds.
pub async fn profile_bitrate(app: &AppHandle, url: &str, user_agent: &str, cancel: &CancellationToken) -> Result<String, AppError> {
    let (_, stderr) = run_sidecar(
        app,
        "ffmpeg",
        &[
            "-v", "debug",
            "-user_agent", user_agent,
            "-i", url,
            "-t", "10",
            "-f", "null",
            "-",
        ],
        cancel,
    )
    .await?;

    let mut total_bytes: u64 = 0;

    for line in stderr.lines() {
        if line.contains("Statistics:") && line.contains("bytes read") {
            if let Some(parts) = line.split("bytes read").next() {
                if let Some(size_str) = parts.split_whitespace().last() {
                    if let Ok(bytes) = size_str.parse::<u64>() {
                        total_bytes = bytes;
                        break;
                    }
                }
            }
        }
    }

    if total_bytes == 0 {
        return Ok("N/A".to_string());
    }

    let bitrate_kbps = (total_bytes * 8) / 1000 / 10;
    Ok(format!("{} kbps", bitrate_kbps))
}

/// Check label mismatch between channel name and actual resolution.
pub fn check_label_mismatch(channel_name: &str, resolution: &str) -> Vec<String> {
    let name_lower = channel_name.to_lowercase();
    let mut mismatches = Vec::new();

    if name_lower.contains("4k") || name_lower.contains("uhd") {
        if resolution != "4K" {
            mismatches.push(format!("Expected 4K, got {}", resolution));
        }
    } else if name_lower.contains("1080p") || name_lower.contains("fhd") {
        if resolution != "1080p" {
            mismatches.push(format!("Expected 1080p, got {}", resolution));
        }
    } else if name_lower.contains("hd") {
        if resolution != "1080p" && resolution != "720p" {
            mismatches.push(format!("Expected 720p or 1080p, got {}", resolution));
        }
    } else if resolution == "4K" {
        mismatches.push("4K channel not labeled as such".to_string());
    }

    mismatches
}
