use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::engine::stream_proxy::redact_url;
use crate::error::AppError;
use crate::models::settings::ScreenshotFormat;

const MAX_SCREENSHOT_STEM_LEN: usize = 120;
const FALLBACK_SCREENSHOT_STEM: &str = "channel";
const MAX_STDERR_EXCERPT_CHARS: usize = 600;
const MAX_FFPROBE_OUTPUT_CHARS: usize = 16_000;
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const FFPROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const FFMPEG_BITRATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const GRACEFUL_KILL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Cached compiled regexes for parse_ffmpeg_stderr / parse_bytes_read / profile_bitrate.
static VIDEO_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"Stream #\d+:\d+.*?: Video: (\w+)").unwrap());
static RESOLUTION_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d{2,5})x(\d{2,5})").unwrap());
static FPS_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d+(?:\.\d+)?)\s+fps").unwrap());
static TBR_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d+(?:\.\d+)?)\s+tbr").unwrap());
static AUDIO_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"Stream #\d+:\d+.*?: Audio: (\w+)").unwrap());
static AUDIO_LAYOUT_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"Audio: .*?,\s*\d+\s*Hz,\s*([^,]+)").unwrap());
static AUDIO_BITRATE_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d+)\s+kb/s").unwrap());
static FORMAT_BR_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"bitrate:\s*(\d+)\s*kb/s").unwrap());
static BYTES_READ_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d+)\s+bytes\s+read").unwrap());
static AUDIO_LAYOUT_VALUE_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(\d+(?:\.\d+)?)").unwrap());

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

/// Send SIGTERM (Unix) and wait up to `grace` for the process to exit.
/// Falls back to SIGKILL if the grace period expires or on Windows.
async fn graceful_kill(child: &mut tokio::process::Child, grace: std::time::Duration) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            // SAFETY: pid is valid — the child has not been waited yet.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            match tokio::time::timeout(grace, child.wait()).await {
                Ok(_) => return,
                Err(_) => {
                    log::debug!(
                        "ffmpeg pid {pid} did not exit within {grace:?} after SIGTERM, sending SIGKILL"
                    );
                }
            }
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Cached resolved binary paths — resolved once per session.
static FFMPEG_PATH: OnceLock<String> = OnceLock::new();
static FFPROBE_PATH: OnceLock<String> = OnceLock::new();

/// Cached ffmpeg/ffprobe availability — checked once per session.
static FFTOOLS_AVAILABLE: OnceLock<(bool, bool)> = OnceLock::new();

fn binary_candidate_names(name: &str, ext: &str) -> [String; 2] {
    [format!("{name}-{TARGET_TRIPLE}{ext}"), format!("{name}{ext}")]
}

fn resolve_binary_from_dir(dir: &Path, candidates: &[String]) -> Option<String> {
    for candidate in candidates {
        let path = dir.join(candidate);
        if path.is_file() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

fn resolve_bundled_binary(app: &AppHandle, candidates: &[String]) -> Option<String> {
    #[cfg(debug_assertions)]
    {
        // In `tauri dev`, prefer the project sidecar inputs directly so debug
        // runs use the same ffmpeg build that production packages bundle.
        let dev_binaries_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        if let Some(path) = resolve_binary_from_dir(&dev_binaries_dir, candidates) {
            return Some(path);
        }
    }

    // Check the executable's own directory next (macOS bundles externalBin
    // into Contents/MacOS/, alongside the main binary).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(path) = resolve_binary_from_dir(dir, candidates) {
                return Some(path);
            }
        }
    }

    // Also check the Tauri resource directory.
    if let Ok(dir) = app.path().resource_dir() {
        if let Some(path) = resolve_binary_from_dir(&dir, candidates) {
            return Some(path);
        }
    }

    None
}

/// Resolve the path to an executable, preferring bundled sidecar binaries over
/// the system PATH so debug and production use the same ffmpeg build. Results
/// are cached per binary name for the session.
fn resolve_binary(app: &AppHandle, name: &str) -> String {
    let cache = match name {
        "ffmpeg" => Some(&FFMPEG_PATH),
        "ffprobe" => Some(&FFPROBE_PATH),
        _ => None,
    };
    if let Some(lock) = cache {
        return lock
            .get_or_init(|| resolve_binary_uncached(app, name))
            .clone();
    }
    resolve_binary_uncached(app, name)
}

fn resolve_binary_uncached(app: &AppHandle, name: &str) -> String {
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };

    let candidates = binary_candidate_names(name, ext);

    if let Some(path) = resolve_bundled_binary(app, &candidates) {
        return path;
    }

    if let Some(path) = resolve_binary_from_path(name, ext) {
        return path;
    }

    name.to_string()
}

fn resolve_binary_from_path(name: &str, ext: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    let candidate_name = format!("{name}{ext}");
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(&candidate_name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn configure_background_process(_command: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        _command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
}

fn stderr_excerpt(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return "no stderr output".to_string();
    }

    let sanitized = trimmed
        .lines()
        .map(sanitize_ffmpeg_stderr_line)
        .collect::<Vec<_>>()
        .join("\n");
    let mut excerpt: String = sanitized.chars().take(MAX_STDERR_EXCERPT_CHARS).collect();
    if trimmed.chars().count() > MAX_STDERR_EXCERPT_CHARS {
        excerpt.push_str("...");
    }
    excerpt
}

fn sanitize_ffmpeg_stderr_line(line: &str) -> String {
    if line.contains("Input #") {
        if let Some((prefix, remainder)) = line.split_once(" from '") {
            if let Some((url, suffix)) = remainder.split_once('\'') {
                return format!("{prefix} from '{}'{suffix}", redact_url(url));
            }
        }
        return "Input #<REDACTED> from '<REDACTED_URL>'".to_string();
    }
    line.to_string()
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

fn append_screenshot_output_args<'a>(
    args: &mut Vec<&'a str>,
    format: ScreenshotFormat,
    output_path: &'a str,
) {
    args.extend_from_slice(&["-frames:v", "1", "-update", "1"]);

    match format {
        ScreenshotFormat::Webp => {
            args.extend_from_slice(&["-c:v", "libwebp", "-quality", "90", "-pix_fmt", "yuv420p"]);
        }
        ScreenshotFormat::Png => {
            // Force 8-bit PNG output. HDR HEVC sources otherwise default to
            // rgb48be, which inflates files well past the UI read limit.
            args.extend_from_slice(&["-pix_fmt", "rgb24"]);
        }
    }

    args.push(output_path);
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

    let mut command = tokio::process::Command::new(&resolved_bin);
    configure_background_process(&mut command);

    let mut child = command
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
                graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;

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
    if let Some(&cached) = FFTOOLS_AVAILABLE.get() {
        return cached;
    }

    let no_cancel = CancellationToken::new();
    let version_timeout = Some(std::time::Duration::from_secs(5));
    let (ffmpeg_result, ffprobe_result) = tokio::join!(
        run_tool_command(app, "ffmpeg", &["-version"], &no_cancel, version_timeout),
        run_tool_command(app, "ffprobe", &["-version"], &no_cancel, version_timeout),
    );
    let result = (ffmpeg_result.is_ok(), ffprobe_result.is_ok());
    log::debug!(
        "ffmpeg available: {}, ffprobe available: {}",
        result.0,
        result.1
    );
    if result.0 || result.1 {
        let _ = FFTOOLS_AVAILABLE.set(result);
    }
    result
}

/// Video stream info from ffprobe.
#[derive(Debug, Clone)]
pub struct VideoInfo {
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub resolution: String,
    pub bitrate_kbps: Option<u32>,
    pub hdr_format: Option<String>,
}

/// Audio stream info from ffprobe.
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub channel_layout: Option<String>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
struct FfprobeTrackOutput {
    streams: Vec<FfprobeTrackStream>,
}

#[cfg(test)]
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
    pub format_bitrate_kbps: Option<u32>,
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
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    color_space: Option<String>,
    pix_fmt: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    #[serde(default)]
    side_data_list: Vec<FfprobeStreamSideData>,
}

#[derive(Debug, Clone, Deserialize)]
struct FfprobeStreamSideData {
    side_data_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    bit_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeCombinedOutput {
    streams: Vec<FfprobeCombinedStream>,
    format: Option<FfprobeFormat>,
}

#[cfg(test)]
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

fn detect_hdr_format_from_ffprobe(stream: &FfprobeCombinedStream) -> Option<String> {
    let codec = stream
        .codec_name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let transfer = stream
        .color_transfer
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let primaries = stream
        .color_primaries
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let color_space = stream
        .color_space
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let pix_fmt = stream
        .pix_fmt
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();

    if codec.contains("dovi")
        || stream.side_data_list.iter().any(|side_data| {
            side_data
                .side_data_type
                .as_deref()
                .map(|value| {
                    let lower = value.to_ascii_lowercase();
                    lower.contains("dovi") || lower.contains("dolby vision")
                })
                .unwrap_or(false)
        })
    {
        return Some("Dolby Vision".to_string());
    }

    if transfer == "arib-std-b67" {
        return Some("HLG".to_string());
    }

    let bt2020 = primaries.contains("bt2020") || color_space.contains("bt2020");
    let high_bit_depth = pix_fmt.contains("10") || pix_fmt.contains("12");
    if transfer == "smpte2084" {
        return Some(if bt2020 || high_bit_depth {
            "HDR10".to_string()
        } else {
            "PQ".to_string()
        });
    }

    if bt2020 && high_bit_depth {
        return Some("HDR".to_string());
    }

    None
}

fn normalize_audio_channel_layout(raw: &str, channels: Option<u32>) -> Option<String> {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }

    if let Some(captures) = AUDIO_LAYOUT_VALUE_RE.captures(&lower) {
        return captures
            .get(1)
            .map(|value| value.as_str().to_string())
            .filter(|value| audio_layout_score(value.as_str()).is_some_and(|score| score > 2.0));
    }

    let normalized = match lower.as_str() {
        "quad" => Some("4.0".to_string()),
        "hexagonal" => Some("6.0".to_string()),
        "octagonal" => Some("8.0".to_string()),
        _ => None,
    };
    if normalized.is_some() {
        return normalized;
    }

    channels.and_then(|count| {
        if count > 2 {
            Some(format!("{count} ch"))
        } else {
            None
        }
    })
}

fn audio_layout_score(value: &str) -> Option<f64> {
    value
        .strip_suffix(" ch")
        .unwrap_or(value)
        .parse::<f64>()
        .ok()
}

fn detect_hdr_format_from_ffmpeg_line(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    if lower.contains("dovi") || lower.contains("dolby vision") {
        return Some("Dolby Vision".to_string());
    }
    if lower.contains("arib-std-b67") || contains_word(&lower, "hlg") {
        return Some("HLG".to_string());
    }
    if lower.contains("smpte2084") {
        return Some("HDR10".to_string());
    }
    let high_bit_depth =
        lower.contains("p010") || lower.contains("10le") || lower.contains("10be")
            || lower.contains("12le")
            || lower.contains("12be");
    if lower.contains("bt2020") && high_bit_depth {
        return Some("HDR".to_string());
    }
    None
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
            .map(|value| normalize_codec_name(value))
            .unwrap_or_else(|| "Unknown".to_string());
        let width = stream.width;
        let height = stream.height;
        let fps = stream.r_frame_rate.as_deref().and_then(parse_ffprobe_fps);
        let bitrate_kbps = stream
            .bit_rate
            .as_deref()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|bits| (bits / 1000) as u32);
        VideoInfo {
            codec,
            width,
            height,
            fps,
            resolution: resolution_label(width, height),
            bitrate_kbps,
            hdr_format: detect_hdr_format_from_ffprobe(stream),
        }
    });

    let audio_info = audio_stream.map(|stream| AudioInfo {
        codec: stream
            .codec_name
            .as_ref()
            .map(|value| normalize_codec_name(value))
            .unwrap_or_else(|| "Unknown".to_string()),
        bitrate_kbps: stream
            .bit_rate
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .map(|bits| (bits / 1000) as u32),
        channel_layout: stream
            .channel_layout
            .as_deref()
            .and_then(|layout| normalize_audio_channel_layout(layout, stream.channels)),
    });

    let format_bitrate_kbps = parsed
        .format
        .and_then(|f| f.bit_rate)
        .and_then(|v| v.parse::<u64>().ok())
        .map(|bits| (bits / 1000) as u32);

    Ok(ProbeSnapshot {
        track_presence: presence,
        video_info,
        audio_info,
        format_bitrate_kbps,
        ffprobe_output: truncate_ffprobe_output(stdout),
    })
}

fn normalize_codec_name(raw: &str) -> String {
    let upper = raw.to_uppercase();
    upper.strip_suffix("VIDEO").unwrap_or(&upper).to_string()
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
            "-show_streams",
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
    let mut args = vec!["-y", "-user_agent", user_agent, "-i", url];
    append_screenshot_output_args(&mut args, format, &output_str);

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

    // Leave at least 15s of headroom within the timeout for connection
    // setup and graceful shutdown. Minimum streaming duration is 3s.
    let sample_secs = (timeout_duration.as_secs().saturating_sub(15)).clamp(3, 10);
    let sample_secs_str = sample_secs.to_string();

    let mut command = tokio::process::Command::new(&resolved_bin);
    configure_background_process(&mut command);

    let mut child = command
        .args([
            "-v",
            "verbose",
            "-user_agent",
            user_agent,
            "-i",
            url,
            "-t",
            &sample_secs_str,
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
        const MAX_RETAIN_BYTES: usize = 1_024 * 1_024; // 1 MB
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            // Drain stderr fully to prevent the child from blocking on a full
            // pipe. Keep the *tail* (last MAX_RETAIN_BYTES) since the
            // Statistics line we parse is written near process exit.
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > MAX_RETAIN_BYTES * 2 {
                            let start = buf.len() - MAX_RETAIN_BYTES;
                            buf.drain(..start);
                        }
                    }
                }
            }
            if buf.len() > MAX_RETAIN_BYTES {
                let start = buf.len() - MAX_RETAIN_BYTES;
                buf.drain(..start);
            }
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
            graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
            true
        }
        _status = child.wait() => {
            false
        }
    };

    let stderr_buf = stderr_reader.await.unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr_buf);

    // Parse Statistics lines regardless of exit code. For HLS streams, ffmpeg
    // opens many HTTP connections (playlist + segments), each printing its own
    // "Statistics: N bytes read" line. Sum all of them to get total bytes.
    let mut total_bytes: u64 = 0;

    for line in stderr.lines() {
        if line.contains("Statistics:") && line.contains("bytes read") {
            if let Some(parts) = line.split("bytes read").next() {
                if let Some(size_str) = parts.split_whitespace().last() {
                    if let Ok(bytes) = size_str.parse::<u64>() {
                        total_bytes = total_bytes.saturating_add(bytes);
                    }
                }
            }
        }
    }

    // Fallback: regex scan for "<digits> bytes read" anywhere in stderr.
    // Handles format variations across ffmpeg versions. Sum all matches.
    if total_bytes == 0 {
        for caps in BYTES_READ_RE.captures_iter(&stderr) {
            if let Ok(bytes) = caps[1].parse::<u64>() {
                total_bytes = total_bytes.saturating_add(bytes);
            }
        }
    }

    if total_bytes == 0 {
        let tail: String = stderr
            .lines()
            .rev()
            .take(5)
            .map(sanitize_ffmpeg_stderr_line)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        if timed_out {
            log::warn!("Bitrate profiling timed out after {:.0}s with no Statistics line. stderr tail: {tail}", timeout_duration.as_secs_f64());
            return Err(AppError::Other(format!(
                "ffmpeg bitrate profiling timed out after {:.0}s (binary: {})",
                timeout_duration.as_secs_f64(),
                resolved_bin,
            )));
        }
        log::warn!("Bitrate profiling completed but no bytes-read data found in stderr. stderr tail: {tail}");
        return Ok("N/A".to_string());
    }

    let bitrate_kbps = (total_bytes * 8) / 1000 / sample_secs;
    Ok(format!("{} kbps", bitrate_kbps))
}

// ---------------------------------------------------------------------------
// Combined diagnostics: single-connection ffmpeg for metadata + screenshot + bitrate
// ---------------------------------------------------------------------------

/// Result of a single combined ffmpeg diagnostics run.
#[derive(Debug, Clone)]
pub struct CombinedDiagnostics {
    pub track_presence: StreamTrackPresence,
    pub video_info: Option<VideoInfo>,
    pub audio_info: Option<AudioInfo>,
    pub format_bitrate_kbps: Option<u32>,
    pub screenshot_path: Option<String>,
    pub profiled_bitrate_kbps: Option<u64>,
    pub diagnostics_output: String,
}

/// Parse stream metadata from ffmpeg verbose stderr output.
///
/// Extracts codec, resolution, fps, audio info, and format bitrate from
/// `Stream #` and `Duration:` lines that ffmpeg prints with `-v verbose`.
fn parse_ffmpeg_stderr(
    stderr: &str,
) -> (
    StreamTrackPresence,
    Option<VideoInfo>,
    Option<AudioInfo>,
    Option<u32>,
) {
    let mut presence = StreamTrackPresence::default();
    let mut best_video: Option<(String, Option<u32>, Option<u32>, Option<u32>, u64, Option<String>)> = None; // (codec, w, h, fps, pixels, hdr)
    let mut audio_info: Option<AudioInfo> = None;
    let mut format_bitrate_kbps: Option<u32> = None;

    for line in stderr.lines() {
        // Video stream
        if let Some(caps) = VIDEO_RE.captures(line) {
            presence.has_video = true;
            let codec = caps[1].to_string();

            let (w, h) = RESOLUTION_RE
                .captures(line)
                .map(|c| {
                    let w = c[1].parse::<u32>().ok();
                    let h = c[2].parse::<u32>().ok();
                    (w, h)
                })
                .unwrap_or((None, None));

            let fps = FPS_RE
                .captures(line)
                .or_else(|| TBR_RE.captures(line))
                .and_then(|c| c[1].parse::<f64>().ok())
                .map(|f| f.round() as u32)
                .filter(|&f| f > 0 && f <= 240);

            let pixels = w.unwrap_or(0) as u64 * h.unwrap_or(0) as u64;
            let hdr_format = detect_hdr_format_from_ffmpeg_line(line);
            let is_better = match &best_video {
                Some((_, _, _, _, prev_px, _)) => pixels > *prev_px,
                None => true,
            };
            if is_better {
                best_video = Some((codec, w, h, fps, pixels, hdr_format));
            }

            continue;
        }

        // Audio stream (take first)
        if audio_info.is_none() {
            if let Some(caps) = AUDIO_RE.captures(line) {
                presence.has_audio = true;
                let codec = caps[1].to_string();
                let bitrate_kbps = AUDIO_BITRATE_RE
                    .captures(line)
                    .and_then(|c| c[1].parse::<u32>().ok());
                let channel_layout = AUDIO_LAYOUT_RE
                    .captures(line)
                    .and_then(|captures| captures.get(1))
                    .and_then(|value| normalize_audio_channel_layout(value.as_str(), None));
                audio_info = Some(AudioInfo {
                    codec: normalize_codec_name(&codec),
                    bitrate_kbps,
                    channel_layout,
                });
                continue;
            }
        } else if line.contains("Audio:") && line.contains("Stream #") {
            presence.has_audio = true;
        }

        // Format-level bitrate from Duration line
        if format_bitrate_kbps.is_none() && line.contains("Duration:") {
            format_bitrate_kbps = FORMAT_BR_RE
                .captures(line)
                .and_then(|c| c[1].parse::<u32>().ok());
        }
    }

    let video_info = best_video.map(|(codec, w, h, fps, _, hdr_format)| VideoInfo {
        codec: normalize_codec_name(&codec),
        width: w,
        height: h,
        fps,
        resolution: resolution_label(w, h),
        bitrate_kbps: None, // Not available from ffmpeg stderr stream lines
        hdr_format,
    });

    (presence, video_info, audio_info, format_bitrate_kbps)
}

/// Parse total bytes read from ffmpeg verbose Statistics lines.
/// Returns (total_bytes, sample_seconds).
fn parse_bytes_read(stderr: &str, sample_secs: u64) -> Option<u64> {
    let mut total_bytes: u64 = 0;

    // Primary: look for "Statistics: N bytes read" lines
    for line in stderr.lines() {
        if line.contains("Statistics:") && line.contains("bytes read") {
            if let Some(parts) = line.split("bytes read").next() {
                if let Some(size_str) = parts.split_whitespace().last() {
                    if let Ok(bytes) = size_str.parse::<u64>() {
                        total_bytes = total_bytes.saturating_add(bytes);
                    }
                }
            }
        }
    }

    // Fallback: regex scan for "<digits> bytes read" anywhere
    if total_bytes == 0 {
        for caps in BYTES_READ_RE.captures_iter(stderr) {
            if let Ok(bytes) = caps[1].parse::<u64>() {
                total_bytes = total_bytes.saturating_add(bytes);
            }
        }
    }

    if total_bytes == 0 || sample_secs == 0 {
        return None;
    }
    Some((total_bytes * 8) / 1000 / sample_secs)
}

/// Run all stream diagnostics in a single ffmpeg process.
///
/// Depending on `profile_bitrate` and `want_screenshot`, builds one of four
/// ffmpeg command modes that minimizes connections to the stream server.
pub async fn run_combined_diagnostics(
    app: &AppHandle,
    url: &str,
    user_agent: &str,
    output_dir: &str,
    file_name: &str,
    screenshot_format: ScreenshotFormat,
    want_screenshot: bool,
    profile_bitrate: bool,
    timeout_secs: f64,
    cancel: &CancellationToken,
) -> Result<CombinedDiagnostics, AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::Cancelled);
    }

    let timeout_duration = if timeout_secs.is_finite() {
        std::time::Duration::from_secs_f64(timeout_secs.clamp(1.0, 600.0))
    } else if profile_bitrate {
        FFMPEG_BITRATE_TIMEOUT
    } else {
        FFPROBE_TIMEOUT
    };

    let resolved_bin = resolve_binary(app, "ffmpeg");

    // When profiling, stream for 3–10 seconds to gather bitrate data.
    let sample_secs = if profile_bitrate {
        (timeout_duration.as_secs().saturating_sub(15)).clamp(3, 10)
    } else {
        0
    };
    let sample_secs_str = sample_secs.to_string();

    // Build screenshot output path
    let screenshot_path = if want_screenshot {
        Some(unique_screenshot_output_path(
            Path::new(output_dir),
            file_name,
            screenshot_format.extension(),
        ))
    } else {
        None
    };
    let screenshot_str = screenshot_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    // Build ffmpeg args
    let mut args: Vec<&str> = vec!["-v", "verbose", "-user_agent", user_agent, "-i", url];

    // Output 1: screenshot (if wanted)
    if let Some(ref out) = screenshot_str {
        append_screenshot_output_args(&mut args, screenshot_format, out);
    }

    // Output 2: null sink for bitrate profiling (or just metadata-only decode)
    if profile_bitrate {
        args.extend_from_slice(&["-t", &sample_secs_str, "-f", "null", "-"]);
    } else if screenshot_str.is_none() {
        // Mode D: no screenshot, no profiling — just decode 1 frame for metadata
        args.extend_from_slice(&["-frames:v", "1", "-f", "null", "-"]);
    }

    // Spawn the process
    let mut command = tokio::process::Command::new(&resolved_bin);
    configure_background_process(&mut command);

    let mut child = command
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| {
            log::warn!("Failed to spawn ffmpeg using '{}': {}", resolved_bin, err);
            AppError::FfmpegNotAvailable
        })?;

    // Read stderr in a background task (same tail-buffer pattern as profile_bitrate)
    let stderr_pipe = child.stderr.take();
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        const MAX_RETAIN_BYTES: usize = 1_024 * 1_024;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > MAX_RETAIN_BYTES * 2 {
                            let start = buf.len() - MAX_RETAIN_BYTES;
                            buf.drain(..start);
                        }
                    }
                }
            }
            if buf.len() > MAX_RETAIN_BYTES {
                let start = buf.len() - MAX_RETAIN_BYTES;
                buf.drain(..start);
            }
        }
        buf
    });

    // Wait for exit with cancellation and timeout, accepting any exit code
    let timed_out = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_reader.abort();
            return Err(AppError::Cancelled);
        }
        _ = tokio::time::sleep(timeout_duration) => {
            graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
            true
        }
        _status = child.wait() => {
            false
        }
    };

    let stderr_buf = stderr_reader.await.unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr_buf);

    // Parse stream metadata from verbose output
    let (track_presence, video_info, audio_info, format_bitrate_kbps) =
        parse_ffmpeg_stderr(&stderr);

    // Parse bitrate from Statistics lines (if profiling)
    let profiled_bitrate_kbps = if profile_bitrate {
        let kbps = parse_bytes_read(&stderr, sample_secs);
        if kbps.is_none() && !timed_out {
            log::warn!(
                "Combined diagnostics: no bytes-read data in stderr. stderr tail: {}",
                stderr
                    .lines()
                    .rev()
                    .take(3)
                    .map(sanitize_ffmpeg_stderr_line)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
        }
        kbps
    } else {
        None
    };

    // Validate screenshot
    let validated_screenshot = if let Some(ref path) = screenshot_path {
        if path.exists() {
            match validate_captured_screenshot(path, screenshot_format) {
                Ok(()) => Some(path.to_string_lossy().to_string()),
                Err(error) => {
                    let _ = std::fs::remove_file(path);
                    log::warn!("Combined diagnostics: invalid screenshot - {}", error);
                    None
                }
            }
        } else {
            log::debug!("Combined diagnostics: screenshot output file missing");
            None
        }
    } else {
        None
    };

    // Truncate stderr for debug log
    let diagnostics_output = {
        let relevant: String = stderr
            .lines()
            .map(sanitize_ffmpeg_stderr_line)
            .filter(|l| {
                l.contains("Stream #")
                    || l.contains("Duration:")
                    || l.contains("Input #")
                    || l.contains("Statistics:")
                    || l.contains("Error")
            })
            .take(30)
            .collect::<Vec<_>>()
            .join("\n");
        if relevant.len() > MAX_FFPROBE_OUTPUT_CHARS {
            relevant.chars().take(MAX_FFPROBE_OUTPUT_CHARS).collect()
        } else {
            relevant
        }
    };

    Ok(CombinedDiagnostics {
        track_presence,
        video_info,
        audio_info,
        format_bitrate_kbps,
        screenshot_path: validated_screenshot,
        profiled_bitrate_kbps,
        diagnostics_output,
    })
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

/// Normalize Unicode superscript/subscript characters to ASCII equivalents.
///
/// Some IPTV providers use Unicode superscript characters in channel or group
/// names, e.g. "ᵁᴴᴰ ³⁸⁴⁰ᴾ" instead of "UHD 3840P". This normalizes those
/// characters so label-matching logic can detect quality tags reliably.
fn normalize_superscript(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            // Superscript digits
            '\u{2070}' => '0',
            '\u{00B9}' => '1',
            '\u{00B2}' => '2',
            '\u{00B3}' => '3',
            '\u{2074}' => '4',
            '\u{2075}' => '5',
            '\u{2076}' => '6',
            '\u{2077}' => '7',
            '\u{2078}' => '8',
            '\u{2079}' => '9',
            // Subscript digits
            '\u{2080}' => '0',
            '\u{2081}' => '1',
            '\u{2082}' => '2',
            '\u{2083}' => '3',
            '\u{2084}' => '4',
            '\u{2085}' => '5',
            '\u{2086}' => '6',
            '\u{2087}' => '7',
            '\u{2088}' => '8',
            '\u{2089}' => '9',
            // Modifier/superscript letters (Latin small capitals & modifiers)
            '\u{1D2C}' => 'A',
            '\u{1D2E}' => 'B',
            '\u{1D30}' => 'D',
            '\u{1D31}' => 'E',
            '\u{1D33}' => 'G',
            '\u{1D34}' => 'H',
            '\u{1D35}' => 'I',
            '\u{1D36}' => 'J',
            '\u{1D37}' => 'K',
            '\u{1D38}' => 'L',
            '\u{1D39}' => 'M',
            '\u{1D3A}' => 'N',
            '\u{1D3C}' => 'O',
            '\u{1D3E}' => 'P',
            '\u{1D3F}' => 'R',
            '\u{1D40}' => 'T',
            '\u{1D41}' => 'U',
            '\u{1D42}' => 'W',
            '\u{02B8}' => 'y',
            other => other,
        })
        .collect()
}

/// Check label mismatch between channel name and actual resolution.
pub fn check_label_mismatch(channel_name: &str, resolution: &str) -> Vec<String> {
    let name_lower = normalize_superscript(channel_name).to_lowercase();
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
        append_screenshot_output_args, binary_candidate_names, build_screenshot_file_name,
        check_label_mismatch, contains_word, normalize_superscript, parse_bytes_read,
        parse_ffmpeg_stderr, parse_ffprobe_fps, parse_probe_snapshot,
        parse_stream_track_presence, resolution_label, resolve_binary_from_dir,
        sanitize_screenshot_stem, screenshot_header_is_valid, unique_screenshot_output_path,
        validate_captured_screenshot, ScreenshotFormat, MAX_SCREENSHOT_STEM_LEN, TARGET_TRIPLE,
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
    fn resolve_binary_from_dir_prefers_target_specific_name() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("iptv-checker-binary-resolve-{unique}"));
        std::fs::create_dir_all(&test_dir).expect("temp dir should be creatable");

        let candidates = binary_candidate_names("ffmpeg", "");
        let generic = test_dir.join("ffmpeg");
        let target_specific = test_dir.join(format!("ffmpeg-{TARGET_TRIPLE}"));
        std::fs::write(&generic, b"generic").expect("generic binary should be writable");
        std::fs::write(&target_specific, b"target").expect("target binary should be writable");

        let resolved = resolve_binary_from_dir(&test_dir, &candidates);
        assert_eq!(
            resolved.as_deref(),
            Some(target_specific.to_string_lossy().as_ref())
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
    fn screenshot_output_args_force_png_to_8_bit_rgb() {
        let mut args = Vec::new();
        append_screenshot_output_args(&mut args, ScreenshotFormat::Png, "/tmp/frame.png");

        assert!(args.windows(2).any(|pair| pair == ["-update", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "rgb24"]));
        assert!(!args.iter().any(|arg| *arg == "libwebp"));
        assert_eq!(args.last(), Some(&"/tmp/frame.png"));
    }

    #[test]
    fn screenshot_output_args_keep_webp_encoder_settings() {
        let mut args = Vec::new();
        append_screenshot_output_args(&mut args, ScreenshotFormat::Webp, "/tmp/frame.webp");

        assert!(args.windows(2).any(|pair| pair == ["-update", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libwebp"]));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "yuv420p"]));
        assert_eq!(args.last(), Some(&"/tmp/frame.webp"));
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
        assert_eq!(video.hdr_format, None);
        let audio = snapshot.audio_info.expect("audio info should exist");
        assert_eq!(audio.codec, "AAC");
        assert_eq!(audio.bitrate_kbps, Some(128));
        assert_eq!(audio.channel_layout, None);
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
        assert_eq!(video.hdr_format, None);
    }

    #[test]
    fn parse_probe_snapshot_detects_hdr_and_multichannel_audio() {
        let output = r#"{
            "streams":[
                {
                    "codec_type":"video",
                    "codec_name":"hevc",
                    "width":3840,
                    "height":2160,
                    "r_frame_rate":"50",
                    "pix_fmt":"yuv420p10le",
                    "color_space":"bt2020nc",
                    "color_primaries":"bt2020",
                    "color_transfer":"smpte2084"
                },
                {
                    "codec_type":"audio",
                    "codec_name":"eac3",
                    "bit_rate":"384000",
                    "channel_layout":"5.1(side)",
                    "channels":6
                }
            ]
        }"#;

        let snapshot = parse_probe_snapshot(output).expect("probe snapshot should parse");
        let video = snapshot.video_info.expect("video info should exist");
        assert_eq!(video.hdr_format.as_deref(), Some("HDR10"));

        let audio = snapshot.audio_info.expect("audio info should exist");
        assert_eq!(audio.codec, "EAC3");
        assert_eq!(audio.channel_layout.as_deref(), Some("5.1"));
    }

    #[test]
    fn parse_probe_snapshot_detects_dolby_vision_side_data() {
        let output = r#"{
            "streams":[
                {
                    "codec_type":"video",
                    "codec_name":"hevc",
                    "width":3840,
                    "height":2160,
                    "r_frame_rate":"24",
                    "pix_fmt":"yuv420p10le",
                    "side_data_list":[
                        {"side_data_type":"DOVI configuration record"}
                    ]
                }
            ]
        }"#;

        let snapshot = parse_probe_snapshot(output).expect("probe snapshot should parse");
        let video = snapshot.video_info.expect("video info should exist");
        assert_eq!(video.hdr_format.as_deref(), Some("Dolby Vision"));
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

    #[test]
    fn normalize_superscript_digits_and_letters() {
        assert_eq!(normalize_superscript("⁴ᴷ"), "4K");
        assert_eq!(normalize_superscript("ᵁᴴᴰ"), "UHD");
        assert_eq!(normalize_superscript("³⁸⁴⁰ᴾ"), "3840P");
        assert_eq!(normalize_superscript("¹⁰⁸⁰ᴾ"), "1080P");
        assert_eq!(normalize_superscript("ᴰᴼᴸᴮʸ ᴬᵁᴰᴵᴼ"), "DOLBy AUDIO");
        // Plain ASCII passes through unchanged
        assert_eq!(normalize_superscript("4K UHD"), "4K UHD");
    }

    #[test]
    fn label_mismatch_unicode_superscript_4k() {
        // "ᵁᴴᴰ ³⁸⁴⁰ᴾ" should be treated as 4K label
        assert!(check_label_mismatch("NO - Movie ᵁᴴᴰ ³⁸⁴⁰ᴾ", "4K").is_empty());
        assert!(!check_label_mismatch("NO - Movie ᵁᴴᴰ ³⁸⁴⁰ᴾ", "1080p").is_empty());

        // "⁴ᴷ" alone should also match
        assert!(check_label_mismatch("Channel ⁴ᴷ", "4K").is_empty());
        assert!(!check_label_mismatch("Channel ⁴ᴷ", "720p").is_empty());
    }

    #[test]
    fn parse_ffmpeg_stderr_h264_mpegts() {
        let stderr = r#"
Input #0, mpegts, from 'http://example.com/stream':
  Duration: N/A, start: 28182.486000, bitrate: N/A
  Stream #0:0[0x100]: Video: h264 (High), yuv420p(tv, bt709, progressive, left), 1920x1080 [SAR 1:1 DAR 16:9], 50 fps, 50 tbr, 90k tbn
  Stream #0:1[0x101](und): Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp, 127 kb/s
"#;
        let (presence, video, audio, fmt_br) = parse_ffmpeg_stderr(stderr);
        assert!(presence.has_video);
        assert!(presence.has_audio);

        let v = video.unwrap();
        assert_eq!(v.codec, "H264");
        assert_eq!(v.width, Some(1920));
        assert_eq!(v.height, Some(1080));
        assert_eq!(v.fps, Some(50));
        assert_eq!(v.resolution, "1080p");
        assert_eq!(v.hdr_format, None);

        let a = audio.unwrap();
        assert_eq!(a.codec, "AAC");
        assert_eq!(a.bitrate_kbps, Some(127));
        assert_eq!(a.channel_layout, None);

        assert_eq!(fmt_br, None); // "bitrate: N/A"
    }

    #[test]
    fn parse_ffmpeg_stderr_hevc_with_format_bitrate() {
        let stderr = r#"
Input #0, hls, from 'http://example.com/stream.m3u8':
  Duration: N/A, start: 0.0, bitrate: 4500 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 25 fps, 25 tbr, 90k tbn
  Stream #0:1: Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s
"#;
        let (presence, video, audio, fmt_br) = parse_ffmpeg_stderr(stderr);
        assert!(presence.has_video);
        assert!(presence.has_audio);

        let v = video.unwrap();
        assert_eq!(v.codec, "HEVC");
        assert_eq!(v.width, Some(3840));
        assert_eq!(v.height, Some(2160));
        assert_eq!(v.fps, Some(25));
        assert_eq!(v.resolution, "4K");
        assert_eq!(v.hdr_format.as_deref(), Some("HDR10"));

        let a = audio.unwrap();
        assert_eq!(a.codec, "AC3");
        assert_eq!(a.bitrate_kbps, Some(448));
        assert_eq!(a.channel_layout.as_deref(), Some("5.1"));

        assert_eq!(fmt_br, Some(4500));
    }

    #[test]
    fn parse_ffmpeg_stderr_audio_only() {
        let stderr = r#"
Input #0, mp3, from 'http://example.com/radio':
  Duration: N/A, start: 0.0, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
"#;
        let (presence, video, audio, fmt_br) = parse_ffmpeg_stderr(stderr);
        assert!(!presence.has_video);
        assert!(presence.has_audio);
        assert!(video.is_none());
        assert_eq!(audio.unwrap().codec, "MP3");
        assert_eq!(fmt_br, Some(128));
    }

    #[test]
    fn parse_ffmpeg_stderr_picks_highest_resolution() {
        let stderr = r#"
  Stream #0:0: Video: h264, yuv420p, 640x480, 25 fps, 25 tbr
  Stream #0:1: Video: h264, yuv420p, 1920x1080, 50 fps, 50 tbr
  Stream #0:2: Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s
"#;
        let (_, video, _, _) = parse_ffmpeg_stderr(stderr);
        let v = video.unwrap();
        assert_eq!(v.width, Some(1920));
        assert_eq!(v.height, Some(1080));
        assert_eq!(v.fps, Some(50));
    }

    #[test]
    fn parse_bytes_read_sums_statistics_lines() {
        let stderr = r#"
[https @ 0x1] Statistics: 1048576 bytes read, 0 seeks
[https @ 0x2] Statistics: 2097152 bytes read, 0 seeks
[https @ 0x3] Statistics: 524288 bytes read, 0 seeks
"#;
        // total = 3670016 bytes, 10 seconds => (3670016*8)/1000/10 = 2936 kbps
        assert_eq!(parse_bytes_read(stderr, 10), Some(2936));
    }

    #[test]
    fn parse_bytes_read_returns_none_when_no_data() {
        let stderr = "Error opening input: Server returned 5XX\n";
        assert_eq!(parse_bytes_read(stderr, 10), None);
    }
}
