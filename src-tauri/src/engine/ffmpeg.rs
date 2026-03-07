use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::models::settings::ScreenshotFormat;

const MAX_SCREENSHOT_STEM_LEN: usize = 120;
const FALLBACK_SCREENSHOT_STEM: &str = "channel";
const MAX_STDERR_EXCERPT_CHARS: usize = 600;
const MAX_FFPROBE_OUTPUT_CHARS: usize = 16_000;
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const FFPROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const FFMPEG_BITRATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

// Compile-time target triple for resolving sidecar binary paths.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-unknown-linux-gnu";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-pc-windows-msvc";

/// Resolve the path to an executable, preferring the bundled sidecar binary
/// over the system PATH. This bypasses the Tauri shell plugin which can
/// silently fail for long-running commands.
fn resolve_binary(app: &AppHandle, name: &str) -> String {
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };

    if let Ok(dir) = app.path().resource_dir() {
        // Production builds: binary has platform triple suffix
        let sidecar_name = format!("{name}-{TARGET_TRIPLE}{ext}");
        let path = dir.join(&sidecar_name);
        if path.exists() {
            return path.to_string_lossy().to_string();
        }

        // Dev builds: Tauri copies external binaries without the triple suffix
        let dev_name = format!("{name}{ext}");
        let path = dir.join(&dev_name);
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }

    // Fall back to system PATH
    name.to_string()
}

fn stderr_excerpt(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return "no stderr output".to_string();
    }

    let mut excerpt: String = trimmed.chars().take(MAX_STDERR_EXCERPT_CHARS).collect();
    if trimmed.chars().count() > MAX_STDERR_EXCERPT_CHARS {
        excerpt.push_str("...");
    }
    excerpt
}

fn trim_windows_unsafe_edges(value: &str) -> String {
    value
        .trim_matches(|c: char| c == ' ' || c == '.' || c == '-')
        .to_string()
}

fn truncate_stem(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }
    value.chars().take(max_len).collect()
}

fn is_windows_reserved_stem(value: &str) -> bool {
    let upper = value.trim().to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Sanitize a screenshot filename stem to be valid across macOS/Linux/Windows.
pub fn sanitize_screenshot_stem(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_dash = false;

    for ch in raw.chars() {
        let normalized = if ch.is_control()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            '-'
        } else if ch.is_whitespace() {
            '-'
        } else {
            ch
        };

        if normalized == '-' {
            if !last_was_dash {
                out.push('-');
                last_was_dash = true;
            }
        } else {
            out.push(normalized);
            last_was_dash = false;
        }
    }

    let mut stem = trim_windows_unsafe_edges(&out);
    if stem.is_empty() {
        stem = FALLBACK_SCREENSHOT_STEM.to_string();
    }
    if is_windows_reserved_stem(&stem) {
        stem = format!("{stem}-channel");
    }

    stem = truncate_stem(&stem, MAX_SCREENSHOT_STEM_LEN);
    stem = trim_windows_unsafe_edges(&stem);
    if stem.is_empty() {
        return FALLBACK_SCREENSHOT_STEM.to_string();
    }
    stem
}

/// Build a deterministic screenshot stem for a channel index + name.
pub fn build_screenshot_file_name(channel_index: usize, channel_name: &str) -> String {
    let sanitized_name = sanitize_screenshot_stem(channel_name);
    let prefixed = format!("{}-{}", channel_index + 1, sanitized_name);
    let mut stem = truncate_stem(&prefixed, MAX_SCREENSHOT_STEM_LEN);
    stem = trim_windows_unsafe_edges(&stem);
    if stem.is_empty() {
        FALLBACK_SCREENSHOT_STEM.to_string()
    } else {
        stem
    }
}

fn unique_screenshot_output_path(output_dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let base_stem = sanitize_screenshot_stem(stem);
    let mut base = truncate_stem(&base_stem, MAX_SCREENSHOT_STEM_LEN);
    base = trim_windows_unsafe_edges(&base);
    if base.is_empty() {
        base = FALLBACK_SCREENSHOT_STEM.to_string();
    }

    let initial = output_dir.join(format!("{base}.{ext}"));
    if !initial.exists() {
        return initial;
    }

    for n in 2..=9_999usize {
        let suffix = format!("-{n}");
        let max_base_len = MAX_SCREENSHOT_STEM_LEN.saturating_sub(suffix.chars().count());
        let mut truncated_base = truncate_stem(&base, max_base_len);
        truncated_base = trim_windows_unsafe_edges(&truncated_base);
        if truncated_base.is_empty() {
            truncated_base = FALLBACK_SCREENSHOT_STEM.to_string();
        }

        let candidate = output_dir.join(format!("{truncated_base}{suffix}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    output_dir.join(format!("{base}-{ts}.{ext}"))
}

fn screenshot_header_is_valid(format: ScreenshotFormat, header: &[u8]) -> bool {
    match format {
        ScreenshotFormat::Png => header.starts_with(&PNG_SIGNATURE),
        ScreenshotFormat::Webp => {
            header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP"
        }
    }
}

fn validate_captured_screenshot(path: &Path, format: ScreenshotFormat) -> Result<(), String> {
    use std::io::Read;

    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("failed to read output metadata: {}", error))?;
    if metadata.len() < 12 {
        return Err("output image is empty".to_string());
    }

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("failed to open output image: {}", error))?;
    let mut header = [0u8; 16];
    let bytes_read = file
        .read(&mut header)
        .map_err(|error| format!("failed to read output image: {}", error))?;
    if bytes_read < 12 {
        return Err("output image header is incomplete".to_string());
    }

    if !screenshot_header_is_valid(format, &header[..bytes_read]) {
        return Err("output image header is invalid".to_string());
    }

    Ok(())
}

/// Run an ffmpeg/ffprobe command via resolved binary path with cancellation
/// and optional timeout handling.
async fn run_tool_command(
    app: &AppHandle,
    name: &str,
    args: &[&str],
    cancel: &CancellationToken,
    timeout: Option<std::time::Duration>,
) -> Result<(String, String), AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    let resolved_bin = resolve_binary(app, name);

    let mut child = tokio::process::Command::new(&resolved_bin)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| {
            log::warn!("Failed to spawn {} using '{}': {}", name, resolved_bin, err);
            AppError::FfmpegNotAvailable
        })?;

    // Take pipes and spawn concurrent readers BEFORE waiting on the child.
    // This prevents deadlocks when output exceeds the OS pipe buffer (~64KB).
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });

    let status = if let Some(timeout_duration) = timeout {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_reader.abort();
                stderr_reader.abort();
                return Err(AppError::Cancelled);
            }
            _ = tokio::time::sleep(timeout_duration) => {
                let _ = child.kill().await;
                let _ = child.wait().await;

                let stderr_buf = stderr_reader.await.unwrap_or_default();
                stdout_reader.abort();

                let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
                return Err(AppError::Other(format!(
                    "{} timed out after {:.1}s (binary: {}) - {}",
                    name,
                    timeout_duration.as_secs_f64(),
                    resolved_bin,
                    stderr_excerpt(&stderr)
                )));
            }
            status = child.wait() => {
                status.map_err(|_| AppError::FfmpegNotAvailable)?
            }
        }
    } else {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_reader.abort();
                stderr_reader.abort();
                return Err(AppError::Cancelled);
            }
            status = child.wait() => {
                status.map_err(|_| AppError::FfmpegNotAvailable)?
            }
        }
    };

    // Collect pipe output — completes quickly since child already exited.
    let stdout_buf = stdout_reader.await.unwrap_or_default();
    let stderr_buf = stderr_reader.await.unwrap_or_default();

    let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&stderr_buf).to_string();

    if !status.success() {
        let exit_code = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());
        return Err(AppError::Other(format!(
            "{} failed (binary: {}, exit: {}) - {}",
            name,
            resolved_bin,
            exit_code,
            stderr_excerpt(&stderr)
        )));
    }

    Ok((stdout, stderr))
}

/// Check if ffmpeg and ffprobe sidecars are available.
pub async fn check_availability(app: &AppHandle) -> (bool, bool) {
    let no_cancel = CancellationToken::new();
    let version_timeout = Some(std::time::Duration::from_secs(5));
    let ffmpeg_ok = run_tool_command(app, "ffmpeg", &["-version"], &no_cancel, version_timeout)
        .await
        .is_ok();
    let ffprobe_ok = run_tool_command(app, "ffprobe", &["-version"], &no_cancel, version_timeout)
        .await
        .is_ok();
    log::debug!(
        "ffmpeg available: {}, ffprobe available: {}",
        ffmpeg_ok,
        ffprobe_ok
    );
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

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeVideoStream>,
}

#[derive(Debug, Deserialize)]
struct FfprobeTrackOutput {
    streams: Vec<FfprobeTrackStream>,
}

#[derive(Debug, Clone, Deserialize)]
struct FfprobeVideoStream {
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct FfprobeTrackStream {
    codec_type: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StreamTrackPresence {
    pub has_video: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeSnapshot {
    pub track_presence: StreamTrackPresence,
    pub video_info: Option<VideoInfo>,
    pub audio_info: Option<AudioInfo>,
    pub ffprobe_output: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FfprobeCombinedStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeCombinedOutput {
    streams: Vec<FfprobeCombinedStream>,
}

fn parse_stream_track_presence(stdout: &str) -> Result<StreamTrackPresence, serde_json::Error> {
    let parsed: FfprobeTrackOutput = serde_json::from_str(stdout)?;
    let mut presence = StreamTrackPresence::default();

    for stream in parsed.streams {
        match stream
            .codec_type
            .as_deref()
            .map(|value| value.to_ascii_lowercase())
        {
            Some(ref codec_type) if codec_type == "video" => presence.has_video = true,
            Some(ref codec_type) if codec_type == "audio" => presence.has_audio = true,
            _ => {}
        }
    }

    Ok(presence)
}

fn truncate_ffprobe_output(stdout: &str) -> String {
    let mut truncated: String = stdout.chars().take(MAX_FFPROBE_OUTPUT_CHARS).collect();
    if stdout.chars().count() > MAX_FFPROBE_OUTPUT_CHARS {
        truncated.push_str("\n...truncated...");
    }
    truncated
}

fn parse_probe_snapshot(stdout: &str) -> Result<ProbeSnapshot, serde_json::Error> {
    let parsed: FfprobeCombinedOutput = serde_json::from_str(stdout)?;
    let mut presence = StreamTrackPresence::default();
    let mut best_video: Option<&FfprobeCombinedStream> = None;
    let mut best_video_pixels: u64 = 0;
    let mut audio_stream: Option<&FfprobeCombinedStream> = None;

    for stream in &parsed.streams {
        match stream
            .codec_type
            .as_deref()
            .map(|value| value.to_ascii_lowercase())
            .as_deref()
        {
            Some("video") => {
                presence.has_video = true;
                let pixels = stream.width.unwrap_or(0) as u64 * stream.height.unwrap_or(0) as u64;
                if best_video.is_none() || pixels >= best_video_pixels {
                    best_video = Some(stream);
                    best_video_pixels = pixels;
                }
            }
            Some("audio") => {
                presence.has_audio = true;
                if audio_stream.is_none() {
                    audio_stream = Some(stream);
                }
            }
            _ => {}
        }
    }

    let video_info = best_video.map(|stream| {
        let codec = stream
            .codec_name
            .as_ref()
            .map(|value| value.to_uppercase())
            .unwrap_or_else(|| "Unknown".to_string());
        let width = stream.width;
        let height = stream.height;
        let fps = stream.r_frame_rate.as_deref().and_then(parse_ffprobe_fps);
        VideoInfo {
            codec,
            width,
            height,
            fps,
            resolution: resolution_label(width, height),
        }
    });

    let audio_info = audio_stream.map(|stream| AudioInfo {
        codec: stream
            .codec_name
            .as_ref()
            .map(|value| value.to_uppercase())
            .unwrap_or_else(|| "Unknown".to_string()),
        bitrate_kbps: stream
            .bit_rate
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .map(|bits| (bits / 1000) as u32),
    });

    Ok(ProbeSnapshot {
        track_presence: presence,
        video_info,
        audio_info,
        ffprobe_output: truncate_ffprobe_output(stdout),
    })
}

fn parse_ffprobe_fps(raw: &str) -> Option<u32> {
    if raw.is_empty() {
        return None;
    }

    if let Some((num, den)) = raw.split_once('/') {
        let n: f64 = num.parse().ok()?;
        let d: f64 = den.parse().ok()?;
        if d <= 0.0 {
            return None;
        }
        let computed = (n / d).round() as u32;
        return if computed > 0 { Some(computed) } else { None };
    }

    raw.parse::<f64>().ok().and_then(|fps| {
        let rounded = fps.round() as u32;
        if rounded > 0 {
            Some(rounded)
        } else {
            None
        }
    })
}

fn resolution_label(width: Option<u32>, height: Option<u32>) -> String {
    match (width, height) {
        (Some(w), Some(h)) if w >= 3840 && h >= 2160 => "4K".to_string(),
        (Some(w), Some(h)) if w >= 1920 && h >= 1080 => "1080p".to_string(),
        (Some(w), Some(h)) if w >= 1280 && h >= 720 => "720p".to_string(),
        (Some(_), Some(_)) => "SD".to_string(),
        _ => "Unknown".to_string(),
    }
}

/// Get video stream info via ffprobe sidecar.
pub async fn get_stream_info(
    app: &AppHandle,
    url: &str,
    cancel: &CancellationToken,
) -> Result<VideoInfo, AppError> {
    log::debug!("Getting stream info for: {}", url);
    let (stdout, stderr) = run_tool_command(
        app,
        "ffprobe",
        &[
            "-v",
            "error",
            "-analyzeduration",
            "15000000",
            "-probesize",
            "15000000",
            "-select_streams",
            "v",
            "-show_entries",
            "stream=codec_name,width,height,r_frame_rate",
            "-of",
            "json",
            url,
        ],
        cancel,
        Some(FFPROBE_TIMEOUT),
    )
    .await?;

    let parsed: FfprobeOutput = serde_json::from_str(&stdout).map_err(|err| {
        AppError::Other(format!(
            "Failed to parse ffprobe stream info: {} ({})",
            err,
            stderr_excerpt(&stderr)
        ))
    })?;

    let best = parsed
        .streams
        .iter()
        .max_by_key(|stream| stream.width.unwrap_or(0) as u64 * stream.height.unwrap_or(0) as u64)
        .cloned();

    let codec = best
        .as_ref()
        .and_then(|stream| stream.codec_name.as_ref())
        .map(|value| value.to_uppercase())
        .unwrap_or_else(|| "Unknown".to_string());

    let width = best.as_ref().and_then(|stream| stream.width);
    let height = best.as_ref().and_then(|stream| stream.height);
    let fps = best
        .as_ref()
        .and_then(|stream| stream.r_frame_rate.as_deref())
        .and_then(parse_ffprobe_fps);

    let resolution = resolution_label(width, height);

    Ok(VideoInfo {
        codec,
        width,
        height,
        fps,
        resolution,
    })
}

/// Get audio stream info via ffprobe sidecar.
pub async fn get_audio_info(
    app: &AppHandle,
    url: &str,
    cancel: &CancellationToken,
) -> Result<AudioInfo, AppError> {
    let (stdout, _) = run_tool_command(
        app,
        "ffprobe",
        &[
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,bit_rate",
            "-of",
            "default=noprint_wrappers=1",
            url,
        ],
        cancel,
        Some(FFPROBE_TIMEOUT),
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

/// Detect whether a stream has audio tracks, video tracks, or both.
pub async fn get_stream_track_presence(
    app: &AppHandle,
    url: &str,
    cancel: &CancellationToken,
) -> Result<StreamTrackPresence, AppError> {
    let (stdout, stderr) = run_tool_command(
        app,
        "ffprobe",
        &[
            "-v",
            "error",
            "-analyzeduration",
            "15000000",
            "-probesize",
            "15000000",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            url,
        ],
        cancel,
        Some(FFPROBE_TIMEOUT),
    )
    .await?;

    parse_stream_track_presence(&stdout).map_err(|error| {
        AppError::Other(format!(
            "Failed to parse ffprobe stream track presence: {} ({})",
            error,
            stderr_excerpt(&stderr)
        ))
    })
}

/// Capture raw ffprobe JSON output for diagnostic export logs.
pub async fn collect_ffprobe_output(
    app: &AppHandle,
    url: &str,
    cancel: &CancellationToken,
) -> Result<String, AppError> {
    let (stdout, _stderr) = run_tool_command(
        app,
        "ffprobe",
        &[
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            url,
        ],
        cancel,
        Some(FFPROBE_TIMEOUT),
    )
    .await?;

    Ok(truncate_ffprobe_output(&stdout))
}

/// Collect stream diagnostics from one ffprobe run (track presence, video, audio,
/// and raw output for debug logs).
pub async fn collect_probe_snapshot(
    app: &AppHandle,
    url: &str,
    cancel: &CancellationToken,
) -> Result<ProbeSnapshot, AppError> {
    collect_probe_snapshot_with_timeout(app, url, cancel, Some(FFPROBE_TIMEOUT)).await
}

/// Collect stream diagnostics from one ffprobe run (track presence, video, audio,
/// and raw output for debug logs) with an explicit timeout.
pub async fn collect_probe_snapshot_with_timeout(
    app: &AppHandle,
    url: &str,
    cancel: &CancellationToken,
    timeout: Option<std::time::Duration>,
) -> Result<ProbeSnapshot, AppError> {
    let (stdout, stderr) = run_tool_command(
        app,
        "ffprobe",
        &[
            "-v",
            "error",
            "-analyzeduration",
            "15000000",
            "-probesize",
            "15000000",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate",
            "-show_format",
            "-of",
            "json",
            url,
        ],
        cancel,
        timeout,
    )
    .await?;

    parse_probe_snapshot(&stdout).map_err(|error| {
        AppError::Other(format!(
            "Failed to parse ffprobe probe snapshot: {} ({})",
            error,
            stderr_excerpt(&stderr)
        ))
    })
}

/// Capture a screenshot frame from a stream via ffmpeg.
/// Uses the unified command runner for consistent sidecar/PATH resolution
/// and bounded diagnostics on failures/timeouts.
async fn capture_screenshot_with_format(
    app: &AppHandle,
    url: &str,
    output_dir: &str,
    file_name: &str,
    user_agent: &str,
    format: ScreenshotFormat,
    cancel: &CancellationToken,
) -> Result<String, AppError> {
    let output_path =
        unique_screenshot_output_path(Path::new(output_dir), file_name, format.extension());
    let output_str = output_path.to_string_lossy().to_string();
    let timeout_duration = std::time::Duration::from_secs(15);

    // Capture the first available frame — no seeking (-ss) since live IPTV
    // streams don't support it reliably and it causes hangs.
    let mut args = vec!["-y", "-user_agent", user_agent, "-i", url, "-frames:v", "1"];
    if format == ScreenshotFormat::Webp {
        args.extend_from_slice(&["-c:v", "libwebp", "-quality", "90", "-pix_fmt", "yuv420p"]);
    }
    args.push(&output_str);

    let (_stdout, stderr) =
        run_tool_command(app, "ffmpeg", &args, cancel, Some(timeout_duration)).await?;

    if output_path.exists() {
        if let Err(error) = validate_captured_screenshot(&output_path, format) {
            let _ = std::fs::remove_file(&output_path);
            log::warn!(
                "Screenshot capture produced invalid output for {} - {}",
                file_name,
                error
            );
            return Err(AppError::Other(format!(
                "Failed to capture screenshot for {} - {}",
                file_name, error
            )));
        }
        log::debug!("Screenshot captured: {}", output_str);
        Ok(output_str)
    } else {
        log::warn!(
            "Screenshot capture failed for {} (exists={}) - {}",
            file_name,
            output_path.exists(),
            stderr_excerpt(&stderr)
        );
        Err(AppError::Other(format!(
            "Failed to capture screenshot for {} - output file missing",
            file_name,
        )))
    }
}

/// Capture a screenshot frame from a stream via ffmpeg.
/// Automatically retries as PNG when WebP capture fails.
pub async fn capture_screenshot(
    app: &AppHandle,
    url: &str,
    output_dir: &str,
    file_name: &str,
    user_agent: &str,
    format: ScreenshotFormat,
    cancel: &CancellationToken,
) -> Result<String, AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    match capture_screenshot_with_format(
        app, url, output_dir, file_name, user_agent, format, cancel,
    )
    .await
    {
        Ok(path) => Ok(path),
        Err(error) if format == ScreenshotFormat::Webp => {
            log::warn!(
                "WebP screenshot capture failed for {} ({}), retrying as PNG",
                file_name,
                error
            );
            capture_screenshot_with_format(
                app,
                url,
                output_dir,
                file_name,
                user_agent,
                ScreenshotFormat::Png,
                cancel,
            )
            .await
        }
        Err(error) => Err(error),
    }
}

/// Profile approximate video bitrate by sampling the stream for 10 seconds.
///
/// This spawns ffmpeg directly instead of using `run_tool_command` because:
/// - ffmpeg with `-t 10` on live streams normally exits non-zero (the stream is
///   still sending when the time limit is hit), which `run_tool_command` treats as error.
/// - We only need the "Statistics:" line from stderr, regardless of exit code.
pub async fn profile_bitrate(
    app: &AppHandle,
    url: &str,
    user_agent: &str,
    timeout_secs: f64,
    cancel: &CancellationToken,
) -> Result<String, AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    let timeout_duration = if timeout_secs.is_finite() {
        std::time::Duration::from_secs_f64(timeout_secs.clamp(1.0, 600.0))
    } else {
        FFMPEG_BITRATE_TIMEOUT
    };

    let resolved_bin = resolve_binary(app, "ffmpeg");

    let mut child = tokio::process::Command::new(&resolved_bin)
        .args([
            "-v",
            "verbose",
            "-user_agent",
            user_agent,
            "-i",
            url,
            "-t",
            "10",
            "-f",
            "null",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| {
            log::warn!("Failed to spawn ffmpeg using '{}': {}", resolved_bin, err);
            AppError::FfmpegNotAvailable
        })?;

    let stderr_pipe = child.stderr.take();
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });

    // Wait for exit with cancellation and timeout, accepting any exit code.
    let timed_out = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_reader.abort();
            return Err(AppError::Cancelled);
        }
        _ = tokio::time::sleep(timeout_duration) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            true
        }
        _status = child.wait() => {
            false
        }
    };

    let stderr_buf = stderr_reader.await.unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr_buf);

    // Parse the Statistics line regardless of exit code.
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

    if timed_out && total_bytes == 0 {
        return Err(AppError::Other(format!(
            "ffmpeg bitrate profiling timed out after {:.0}s (binary: {})",
            timeout_duration.as_secs_f64(),
            resolved_bin,
        )));
    }

    if total_bytes == 0 {
        return Ok("N/A".to_string());
    }

    let bitrate_kbps = (total_bytes * 8) / 1000 / 10;
    Ok(format!("{} kbps", bitrate_kbps))
}

/// Check if `word` appears in `haystack` as a standalone word (surrounded by
/// non-alphanumeric characters or string boundaries).
fn contains_word(haystack: &str, word: &str) -> bool {
    let h = haystack.as_bytes();
    let w = word.as_bytes();
    if w.is_empty() || h.len() < w.len() {
        return false;
    }
    for start in 0..=h.len() - w.len() {
        if &h[start..start + w.len()] != w {
            continue;
        }
        let before_ok = start == 0 || !h[start - 1].is_ascii_alphanumeric();
        let after_ok = start + w.len() == h.len() || !h[start + w.len()].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
    }
    false
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
    } else if contains_word(&name_lower, "hd") {
        if resolution != "1080p" && resolution != "720p" {
            mismatches.push(format!("Expected 720p or 1080p, got {}", resolution));
        }
    } else if resolution == "4K" {
        mismatches.push("4K channel not labeled as such".to_string());
    }

    mismatches
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        build_screenshot_file_name, check_label_mismatch, contains_word, parse_ffprobe_fps,
        parse_probe_snapshot, parse_stream_track_presence, resolution_label,
        sanitize_screenshot_stem, screenshot_header_is_valid, unique_screenshot_output_path,
        validate_captured_screenshot, ScreenshotFormat, MAX_SCREENSHOT_STEM_LEN,
    };

    #[test]
    fn parse_fractional_fps() {
        assert_eq!(parse_ffprobe_fps("30000/1001"), Some(30));
        assert_eq!(parse_ffprobe_fps("24000/1001"), Some(24));
    }

    #[test]
    fn parse_decimal_fps() {
        assert_eq!(parse_ffprobe_fps("29.97"), Some(30));
        assert_eq!(parse_ffprobe_fps(""), None);
    }

    #[test]
    fn map_resolution_labels() {
        assert_eq!(resolution_label(Some(3840), Some(2160)), "4K");
        assert_eq!(resolution_label(Some(1920), Some(1080)), "1080p");
        assert_eq!(resolution_label(Some(1280), Some(720)), "720p");
        assert_eq!(resolution_label(Some(854), Some(480)), "SD");
    }

    #[test]
    fn sanitize_screenshot_filename_reserved_chars() {
        assert_eq!(
            sanitize_screenshot_stem("News: / \"Global\" * HD?"),
            "News-Global-HD"
        );
        assert_eq!(sanitize_screenshot_stem("CON"), "CON-channel");
        assert_eq!(sanitize_screenshot_stem("   ...   "), "channel");
    }

    #[test]
    fn screenshot_filename_max_length() {
        let input = "a".repeat(MAX_SCREENSHOT_STEM_LEN + 40);
        let output = sanitize_screenshot_stem(&input);
        assert!(output.chars().count() <= MAX_SCREENSHOT_STEM_LEN);
    }

    #[test]
    fn screenshot_name_builder_uses_index_prefix() {
        assert_eq!(
            build_screenshot_file_name(0, "Sports/News: HD"),
            "1-Sports-News-HD"
        );
    }

    #[test]
    fn unique_path_adds_suffix_when_base_exists() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("iptv-checker-sanitize-{unique}"));
        std::fs::create_dir_all(&test_dir).expect("temp dir should be creatable");

        let existing = test_dir.join("1-Channel.webp");
        std::fs::write(&existing, b"old").expect("fixture file should be writable");

        let output = unique_screenshot_output_path(&test_dir, "1-Channel", "webp");
        assert_eq!(
            output.file_name().and_then(|n| n.to_str()),
            Some("1-Channel-2.webp")
        );

        std::fs::remove_dir_all(&test_dir).expect("temp dir should be removable");
    }

    #[test]
    fn screenshot_header_validation_matches_format() {
        let png_header = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
        let webp_header = [b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'E', b'B', b'P'];
        assert!(screenshot_header_is_valid(
            ScreenshotFormat::Png,
            &png_header
        ));
        assert!(screenshot_header_is_valid(
            ScreenshotFormat::Webp,
            &webp_header
        ));
        assert!(!screenshot_header_is_valid(
            ScreenshotFormat::Webp,
            &png_header
        ));
    }

    #[test]
    fn validate_captured_screenshot_rejects_invalid_header() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let test_dir =
            std::env::temp_dir().join(format!("iptv-checker-screenshot-validate-{unique}"));
        std::fs::create_dir_all(&test_dir).expect("temp dir should be creatable");

        let invalid_path = test_dir.join("invalid.webp");
        std::fs::write(&invalid_path, b"not-a-real-image")
            .expect("fixture file should be writable");

        let error = validate_captured_screenshot(&invalid_path, ScreenshotFormat::Webp)
            .expect_err("invalid header should be rejected");
        assert!(error.contains("invalid"));

        std::fs::remove_dir_all(&test_dir).expect("temp dir should be removable");
    }

    #[test]
    fn parse_stream_track_presence_detects_audio_only_streams() {
        let output = r#"{"streams":[{"codec_type":"audio"},{"codec_type":"data"}]}"#;
        let presence = parse_stream_track_presence(output).expect("track presence should parse");
        assert!(!presence.has_video);
        assert!(presence.has_audio);
    }

    #[test]
    fn parse_stream_track_presence_detects_mixed_streams() {
        let output = r#"{"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}"#;
        let presence = parse_stream_track_presence(output).expect("track presence should parse");
        assert!(presence.has_video);
        assert!(presence.has_audio);
    }

    #[test]
    fn parse_probe_snapshot_extracts_video_audio_and_raw_output() {
        let output = r#"{
            "streams":[
                {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"30000/1001"},
                {"codec_type":"audio","codec_name":"aac","bit_rate":"128000"}
            ]
        }"#;
        let snapshot = parse_probe_snapshot(output).expect("probe snapshot should parse");
        assert!(snapshot.track_presence.has_video);
        assert!(snapshot.track_presence.has_audio);
        let video = snapshot.video_info.expect("video info should exist");
        assert_eq!(video.codec, "H264");
        assert_eq!(video.width, Some(1920));
        assert_eq!(video.height, Some(1080));
        assert_eq!(video.fps, Some(30));
        assert_eq!(video.resolution, "1080p");
        let audio = snapshot.audio_info.expect("audio info should exist");
        assert_eq!(audio.codec, "AAC");
        assert_eq!(audio.bitrate_kbps, Some(128));
        assert!(snapshot.ffprobe_output.contains("\"streams\""));
    }

    #[test]
    fn parse_probe_snapshot_prefers_highest_resolution_video() {
        let output = r#"{
            "streams":[
                {"codec_type":"video","codec_name":"h264","width":1280,"height":720,"r_frame_rate":"25"},
                {"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,"r_frame_rate":"50"}
            ]
        }"#;
        let snapshot = parse_probe_snapshot(output).expect("probe snapshot should parse");
        let video = snapshot.video_info.expect("video info should exist");
        assert_eq!(video.codec, "HEVC");
        assert_eq!(video.resolution, "4K");
        assert_eq!(video.fps, Some(50));
    }

    #[test]
    fn contains_word_matches_standalone() {
        // Note: contains_word is case-sensitive; check_label_mismatch lowercases first
        assert!(contains_word("sports hd", "hd"));
        assert!(contains_word("hd channel", "hd"));
        assert!(contains_word("[hd]", "hd"));
        assert!(contains_word("(hd)", "hd"));
        assert!(contains_word("sports|hd", "hd"));
        assert!(contains_word("hd", "hd"));
    }

    #[test]
    fn contains_word_rejects_substrings() {
        assert!(!contains_word("ahmad tv", "hd"));
        assert!(!contains_word("shahd channel", "hd"));
        assert!(!contains_word("shadow tv", "hd"));
        assert!(!contains_word("fahd news", "hd"));
    }

    #[test]
    fn label_mismatch_hd_word_boundary() {
        // "HD" as standalone word should trigger mismatch
        assert!(!check_label_mismatch("Sports HD", "1080p").is_empty() == false);
        assert!(check_label_mismatch("Sports HD", "480p").len() == 1);

        // "hd" as part of a name should NOT trigger mismatch
        assert!(check_label_mismatch("Ahmad TV", "480p").is_empty());
        assert!(check_label_mismatch("Shahd Channel", "480p").is_empty());
    }
}
