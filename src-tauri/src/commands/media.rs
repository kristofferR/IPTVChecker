//! Manual sample clip capture and access to saved media artifacts
//! (screenshots and sample clips) from the selected-channel sidebar.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use crate::commands::player::open_local_media;
use crate::commands::scan::ffmpeg_target_url;
use crate::commands::settings::{
    allowed_artifact_roots, media_cache_root, register_media_root, validate_artifact_path,
    ArtifactKind,
};
use crate::engine::proxy_common::parse_byte_range;
use crate::engine::{cast_proxy, disk, ffmpeg, stream_proxy};
use crate::error::AppError;
use crate::models::channel::SampleClipFormat;
use crate::state::AppState;

/// Path prefix on the localhost streaming proxy that serves a saved sample
/// clip for inline `<video>` preview: `/artifact/<token>/<base64url path>`.
const PREVIEW_ROUTE_PREFIX: &str = "/artifact/";
/// Per-launch secret for preview URLs. The streaming proxy port is reachable
/// by any local process, so only URLs minted by the app are served.
static PREVIEW_TOKEN: LazyLock<String> = LazyLock::new(cast_proxy::generate_token);
/// Cache subdirectory for clips captured outside a scan. Its scan metadata
/// keeps it under the same retention and low-space eviction as scan runs.
const MANUAL_CAPTURE_DIR: &str = "manual-samples";
const CAPTURE_URL_SCHEMES: &[&str] = &[
    "http", "https", "rtmp", "rtmps", "rtsp", "rtsps", "rtp", "udp",
];

/// Only hand ffmpeg network stream URLs, never local files or protocol
/// wrappers such as `concat:`.
fn ensure_capture_url(url: &str) -> Result<(), AppError> {
    let allowed = url::Url::parse(url)
        .map(|parsed| CAPTURE_URL_SCHEMES.contains(&parsed.scheme()))
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err(AppError::Other(
            "Sample clips can only be captured from network streams".to_string(),
        ))
    }
}

/// Resolve where a manual capture is written: the custom media folder when
/// set, otherwise a dedicated cache directory. Refuses to capture when space
/// is critical. Eviction stays with scans, so a capture never deletes the
/// screenshots of the results on screen.
fn prepare_manual_capture_dir(
    cache_root: &Path,
    custom_dir: Option<&str>,
    low_space_threshold_gb: f64,
) -> Result<PathBuf, AppError> {
    let dir = match custom_dir {
        Some(dir) => PathBuf::from(dir),
        None => cache_root.join(MANUAL_CAPTURE_DIR),
    };
    std::fs::create_dir_all(&dir).map_err(|error| {
        AppError::Other(format!("Failed to create sample clip directory: {}", error))
    })?;

    if custom_dir.is_none() {
        let scan_started_at_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let meta = serde_json::json!({
            "scan_started_at_epoch_ms": scan_started_at_epoch_ms,
            "source_identity": MANUAL_CAPTURE_DIR,
        });
        if let Err(error) = std::fs::write(dir.join(".scan-meta.json"), meta.to_string()) {
            log::warn!("Failed to write manual capture metadata: {}", error);
        }
    }

    if disk::classify_space(&dir, low_space_threshold_gb) == disk::DiskSpaceTier::Critical {
        return Err(AppError::Other(
            "Not enough free disk space to capture a sample clip".to_string(),
        ));
    }
    Ok(dir)
}

#[tauri::command]
pub async fn capture_sample_clip(
    app: tauri::AppHandle,
    channel_index: usize,
    channel_name: String,
    url: String,
    stream_url: Option<String>,
    source: String,
) -> Result<ffmpeg::SampleClip, AppError> {
    ensure_capture_url(&url)?;
    let stream_url = stream_url.filter(|value| ensure_capture_url(value).is_ok());
    let state = app.state::<Arc<AppState>>().inner().clone();
    let _capture_guard = state
        .sample_capture_lock
        .try_lock()
        .map_err(|_| AppError::Other("Another sample is being captured.".to_string()))?;
    let (ffmpeg_available, _) = ffmpeg::check_availability(&app).await;
    if !ffmpeg_available {
        return Err(AppError::FfmpegNotAvailable);
    }

    let (user_agent, duration_secs, custom_dir, low_space_threshold_gb) = {
        let state = app.state::<Arc<AppState>>();
        let settings = state.settings.lock().await;
        (
            settings.user_agent.clone(),
            settings.sample_clip_duration_secs,
            settings.screenshots_dir.clone(),
            settings.low_space_threshold_gb,
        )
    };
    let custom_dir_is_none = custom_dir.is_none();
    let cache_root = media_cache_root(&app);
    let output_dir = tokio::task::spawn_blocking(move || {
        prepare_manual_capture_dir(&cache_root, custom_dir.as_deref(), low_space_threshold_gb)
    })
    .await
    .map_err(|error| AppError::Other(format!("Failed to prepare sample clip: {}", error)))??;
    register_media_root(&app, &output_dir);

    // Channel indices and names repeat across playlists, so key manual clips
    // by source too; otherwise one window's recapture prunes another's clip.
    let file_name = format!(
        "{}-{}",
        source_key(&source),
        ffmpeg::build_screenshot_file_name(channel_index, &channel_name)
    );
    let clip = ffmpeg::capture_sample_clip(
        &app,
        &ffmpeg_target_url(&url, stream_url.as_deref()),
        Some(&url),
        &output_dir.to_string_lossy(),
        &file_name,
        &user_agent,
        duration_secs,
        &CancellationToken::new(),
    )
    .await?;

    // A recapture supersedes this channel's earlier manual clips. Only the
    // app's own cache is pruned; a custom folder holds the user's files.
    if custom_dir_is_none {
        remove_other_channel_clips(&output_dir, &file_name, Path::new(&clip.path));
    }
    Ok(clip)
}

/// Short stable key for a playlist source, used in manual clip names.
fn source_key(source: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

/// Delete clips in a scan folder that no result references.
pub(crate) fn sweep_unreferenced_clips(dir: &Path, referenced: &HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let is_clip = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext, "mp4" | "ts"));
        if is_clip && !referenced.contains(&path) {
            if let Err(error) = std::fs::remove_file(&path) {
                log::debug!("Failed to remove unreferenced sample clip: {}", error);
            }
        }
    }
}

/// Delete a channel's earlier clips (`stem.{mp4,ts}`, `stem-N.{mp4,ts}`) in
/// `dir`, except `keep`. One directory listing per capture is negligible next
/// to the seconds each clip takes to record.
pub(crate) fn remove_other_channel_clips(dir: &Path, stem: &str, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let is_clip = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext, "mp4" | "ts"));
        let same_channel = path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| ffmpeg::is_output_name_for_stem(name, stem));
        if is_clip && same_channel && path != keep {
            if let Err(error) = std::fs::remove_file(&path) {
                log::debug!("Failed to remove superseded sample clip: {}", error);
            }
        }
    }
}

async fn validated_media_path(
    app: &tauri::AppHandle,
    path: &str,
    kinds: &[ArtifactKind],
) -> Result<(PathBuf, ArtifactKind), AppError> {
    let allowed_roots = allowed_artifact_roots(app).await;
    validate_artifact_path(Path::new(path.trim()), &allowed_roots, kinds)
}

/// Open a saved sample clip in the configured external player (or the
/// system default application).
#[tauri::command]
pub async fn open_media_artifact(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let (path, _) = validated_media_path(&app, &path, &[ArtifactKind::SampleClip]).await?;
    open_local_media(&app, &path).await
}

/// Reveal a saved screenshot or sample clip in the system file manager.
#[tauri::command]
pub async fn reveal_media_artifact(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let (path, _) = validated_media_path(
        &app,
        &path,
        &[ArtifactKind::Screenshot, ArtifactKind::SampleClip],
    )
    .await?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| AppError::Other(format!("Failed to reveal media file: {}", error)))
}

/// Mint a localhost URL that streams a saved sample clip, with byte ranges,
/// for an inline `<video>`. Native HTTP playback works in every webview,
/// unlike media served from a custom URI scheme.
#[tauri::command]
pub async fn get_sample_clip_preview_url(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, AppError> {
    let (path, _) = validated_media_path(&app, &path, &[ArtifactKind::SampleClip]).await?;
    let port = stream_proxy::ensure_streaming_proxy_port(app.clone()).await;
    if port == 0 {
        return Err(AppError::Other("Preview server is unavailable".to_string()));
    }
    Ok(format!(
        "http://127.0.0.1:{port}{PREVIEW_ROUTE_PREFIX}{}/{}",
        *PREVIEW_TOKEN,
        stream_proxy::encode_proxy_url(&path.to_string_lossy())
    ))
}

#[derive(Debug, PartialEq, Eq)]
struct PreviewRequest<'a> {
    head_only: bool,
    encoded_path: &'a str,
    range: Option<&'a str>,
}

/// Parse a request head for the preview route. `None` when the path is not
/// a preview path; `Some(Err(()))` when it is one but the token or method is
/// not accepted.
fn parse_preview_request<'a>(
    request: &'a str,
    token: &str,
) -> Option<Result<PreviewRequest<'a>, ()>> {
    let mut lines = request.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?;
    let rest = request_line.next()?.strip_prefix(PREVIEW_ROUTE_PREFIX)?;
    let Some((request_token, encoded_path)) = rest.split_once('/') else {
        return Some(Err(()));
    };
    if request_token != token || !matches!(method, "GET" | "HEAD") {
        return Some(Err(()));
    }
    let range = lines.take_while(|line| !line.is_empty()).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("range")
            .then(|| value.trim())
    });
    Some(Ok(PreviewRequest {
        head_only: method == "HEAD",
        encoded_path,
        range,
    }))
}

/// Byte span to serve for an optional `Range` header: `Some(None)` means the
/// whole file, `None` means the range is unsatisfiable.
fn artifact_byte_span(range: Option<&str>, total_len: u64) -> Option<Option<(u64, u64)>> {
    match range {
        None => Some(None),
        Some(range) => parse_byte_range(range, total_len).map(Some),
    }
}

async fn write_status(socket: &mut tokio::net::TcpStream, status: &str) {
    use tokio::io::AsyncWriteExt;

    let response = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = socket.write_all(response.as_bytes()).await;
}

async fn stream_file_span(
    socket: &mut tokio::net::TcpStream,
    path: &Path,
    head: String,
    span: (u64, u64),
    head_only: bool,
) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    socket.write_all(head.as_bytes()).await?;
    if head_only {
        return Ok(());
    }
    let (start, end) = span;
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    tokio::io::copy(&mut file.take(end - start + 1), socket).await?;
    Ok(())
}

/// Serve a preview request on the localhost streaming proxy. Returns `false`
/// when the request is not for the preview route, leaving it to the proxy.
pub async fn try_serve_preview_request(
    app: &tauri::AppHandle,
    request: &str,
    socket: &mut tokio::net::TcpStream,
) -> bool {
    let request = match parse_preview_request(request, &PREVIEW_TOKEN) {
        None => return false,
        Some(Err(())) => {
            log::warn!("[StreamProxy] Rejected media preview request with a bad token");
            write_status(socket, "403 Forbidden").await;
            return true;
        }
        Some(Ok(request)) => request,
    };
    let Some(path) = stream_proxy::decode_proxy_url(request.encoded_path) else {
        write_status(socket, "400 Bad Request").await;
        return true;
    };
    let path = match validated_media_path(app, &path, &[ArtifactKind::SampleClip]).await {
        Ok((path, _)) => path,
        Err(error) => {
            log::warn!("Media preview request rejected: {}", error);
            write_status(socket, "403 Forbidden").await;
            return true;
        }
    };
    let Ok(total_len) = tokio::fs::metadata(&path).await.map(|meta| meta.len()) else {
        write_status(socket, "404 Not Found").await;
        return true;
    };
    let Some(span) = artifact_byte_span(request.range, total_len) else {
        use tokio::io::AsyncWriteExt;
        let response = format!(
            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total_len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = socket.write_all(response.as_bytes()).await;
        return true;
    };

    let format = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("ts") => SampleClipFormat::Ts,
        _ => SampleClipFormat::Mp4,
    };
    let (status, content_range, (start, end)) = match span {
        Some((start, end)) => (
            "206 Partial Content",
            format!("Content-Range: bytes {start}-{end}/{total_len}\r\n"),
            (start, end),
        ),
        None => ("200 OK", String::new(), (0, total_len.saturating_sub(1))),
    };
    let content_length = if total_len == 0 { 0 } else { end - start + 1 };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {content_length}\r\n{content_range}Accept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        format.mime_type()
    );
    let head_only = request.head_only || content_length == 0;
    if let Err(error) = stream_file_span(socket, &path, head, (start, end), head_only).await {
        log::debug!("Media preview response ended early: {}", error);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{
        artifact_byte_span, ensure_capture_url, parse_preview_request, remove_other_channel_clips,
        PreviewRequest,
    };

    #[test]
    fn capture_url_must_be_a_network_stream() {
        assert!(ensure_capture_url("https://example.com/live/1.m3u8").is_ok());
        assert!(ensure_capture_url("rtmp://example.com/live/1").is_ok());
        assert!(ensure_capture_url("rtsps://example.com/live/1").is_ok());
        assert!(ensure_capture_url("file:///etc/passwd").is_err());
        assert!(ensure_capture_url("concat:/tmp/a.ts|/tmp/b.ts").is_err());
    }

    #[test]
    fn recapture_prunes_only_this_channels_clips() {
        let dir = std::env::temp_dir().join(format!("iptv-manual-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("fixture dir");
        for name in [
            "3-News.ts",
            "3-News-2.mp4",
            "3-News-2.webp",
            "3-News-HD.mp4",
            "30-News.mp4",
            "3-News-3.mp4",
        ] {
            std::fs::write(dir.join(name), b"x").expect("fixture file");
        }

        remove_other_channel_clips(&dir, "3-News", &dir.join("3-News-3.mp4"));

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .expect("fixture dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "3-News-2.webp",
                "3-News-3.mp4",
                "3-News-HD.mp4",
                "30-News.mp4"
            ]
        );

        // A later recapture takes the freed base name; the gap before the
        // previous suffix must not stop the prune.
        std::fs::write(dir.join("3-News.mp4"), b"x").expect("fixture file");
        remove_other_channel_clips(&dir, "3-News", &dir.join("3-News.mp4"));
        assert!(!dir.join("3-News-3.mp4").exists());
        assert!(dir.join("3-News.mp4").exists());
        std::fs::remove_dir_all(&dir).expect("fixture cleanup");
    }

    #[test]
    fn preview_request_requires_the_session_token() {
        let request = "GET /artifact/secret/L2NsaXAubXA0 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-99\r\n\r\n";
        assert_eq!(
            parse_preview_request(request, "secret"),
            Some(Ok(PreviewRequest {
                head_only: false,
                encoded_path: "L2NsaXAubXA0",
                range: Some("bytes=0-99"),
            }))
        );
        assert_eq!(parse_preview_request(request, "other"), Some(Err(())));
        assert_eq!(
            parse_preview_request(
                "POST /artifact/secret/L2NsaXAubXA0 HTTP/1.1\r\n\r\n",
                "secret"
            ),
            Some(Err(()))
        );
    }

    #[test]
    fn preview_request_leaves_stream_requests_to_the_proxy() {
        let request = "GET /stream?url=https%3A%2F%2Fexample.com%2Flive.ts HTTP/1.1\r\n\r\n";
        assert_eq!(parse_preview_request(request, "secret"), None);
    }

    #[test]
    fn artifact_span_serves_requested_ranges() {
        assert_eq!(artifact_byte_span(None, 1_000), Some(None));
        assert_eq!(
            artifact_byte_span(Some("bytes=0-"), 1_000),
            Some(Some((0, 999)))
        );
        assert_eq!(
            artifact_byte_span(Some("bytes=100-199"), 1_000),
            Some(Some((100, 199)))
        );
        assert_eq!(artifact_byte_span(Some("bytes=5000-"), 1_000), None);
    }
}
