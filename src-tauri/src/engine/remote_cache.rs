//! Remote playlist download cache.
//!
//! Downloads playlists over HTTP with ETag/Last-Modified revalidation and
//! writes them into the app-data `remote-playlists/` cache directory using
//! an atomic temp-file rename. Shared HTTP constants (user agent, connect
//! timeout) and the http(s) URL validator live here because every remote
//! source (plain URL, Xtream, Stalker, server tester) uses them.

use crate::commands::playlist::{emit_load_progress, PlaylistLoadProgress, PROGRESS_THROTTLE};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use url::Url;

pub(crate) const PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PLAYLIST_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const PLAYLIST_DOWNLOAD_MAX_BYTES: u64 = 200 * 1024 * 1024;
const CACHE_TEMP_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
pub(crate) const PLAYLIST_DOWNLOAD_USER_AGENT: &str = "TiviMate/5.1.6 (Android 12)";

/// Cached HTTP validators used for conditional re-downloads.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RemotePlaylistCacheMetadata {
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Debug)]
enum PlaylistDownloadResult {
    NotModified,
    /// The body was streamed into the caller-supplied temp file.
    Updated {
        metadata: RemotePlaylistCacheMetadata,
    },
}

/// Parse and validate an http(s) URL, mapping failures to a friendly error.
pub(crate) fn parse_http_url(value: &str, invalid_message: &str) -> Result<Url, AppError> {
    let trimmed = value.trim();
    let parsed = Url::parse(trimmed)
        .map_err(|error| AppError::Parse(format!("{}: {}", invalid_message, error)))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Parse(format!(
            "{}: must use http:// or https://",
            invalid_message
        )));
    }

    Ok(parsed)
}

fn hash_source_key(source_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn source_cache_file_name(source_key: &str) -> String {
    format!("{}.m3u8", hash_source_key(source_key))
}

pub(crate) fn remote_playlist_cache_path_from_data_dir(
    data_dir: &std::path::Path,
    source_key: &str,
) -> Result<std::path::PathBuf, AppError> {
    let cache_dir = data_dir.join("remote-playlists");
    std::fs::create_dir_all(&cache_dir).map_err(AppError::Io)?;
    Ok(cache_dir.join(source_cache_file_name(source_key)))
}

fn cleanup_stale_cache_temp_files(cache_path: &std::path::Path) {
    let Some(parent) = cache_path.parent() else {
        return;
    };
    let Some(cache_name) = cache_path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let temp_prefix = format!("{}.", cache_name);
    let now_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(timestamp) = name
            .strip_prefix(&temp_prefix)
            .and_then(|value| value.strip_suffix(".tmp"))
            .and_then(|value| value.parse::<u128>().ok())
        else {
            continue;
        };
        if now_nanos.saturating_sub(timestamp) >= CACHE_TEMP_MAX_AGE.as_nanos() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn cache_metadata_path(cache_path: &std::path::Path) -> std::path::PathBuf {
    cache_path.with_extension("m3u8.meta.json")
}

fn load_cache_metadata(cache_path: &std::path::Path) -> Option<RemotePlaylistCacheMetadata> {
    let path = cache_metadata_path(cache_path);
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<RemotePlaylistCacheMetadata>(&bytes).ok()
}

fn save_cache_metadata(
    cache_path: &std::path::Path,
    metadata: &RemotePlaylistCacheMetadata,
) -> Result<(), AppError> {
    let path = cache_metadata_path(cache_path);
    let bytes = serde_json::to_vec(metadata).map_err(|error| {
        AppError::Parse(format!("Failed to serialize cache metadata: {}", error))
    })?;
    std::fs::write(path, bytes).map_err(AppError::Io)
}

fn map_download_error(
    error: reqwest::Error,
    error_label: &str,
    timeout: Duration,
    when: &str,
) -> AppError {
    if error.is_timeout() {
        return AppError::Other(format!(
            "Timed out while downloading {} after {} seconds",
            error_label,
            timeout.as_secs()
        ));
    }

    AppError::Other(format!(
        "Failed to {} downloaded {}: {}",
        when,
        error_label,
        error.without_url()
    ))
}

async fn download_playlist_to_file(
    app: Option<&AppHandle>,
    download_url: &Url,
    error_label: &str,
    connect_timeout: Duration,
    timeout: Duration,
    max_bytes: u64,
    accept_invalid_certs: bool,
    cache_metadata: Option<&RemotePlaylistCacheMetadata>,
    tmp_path: &std::path::Path,
) -> Result<PlaylistDownloadResult, AppError> {
    use futures::StreamExt;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(connect_timeout)
        .timeout(timeout)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|error| {
            AppError::Other(format!(
                "Failed to initialize HTTP client for {}: {}",
                error_label, error
            ))
        })?;
    emit_load_progress(
        app,
        PlaylistLoadProgress::Connecting {
            detail: "Initializing HTTP client",
        },
    );
    let mut request = client
        .get(download_url.clone())
        .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT);
    if let Some(metadata) = cache_metadata {
        if let Some(ref etag) = metadata.etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        if let Some(ref last_modified) = metadata.last_modified {
            request = request.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
        }
    }
    emit_load_progress(
        app,
        PlaylistLoadProgress::Connecting {
            detail: "Waiting for server",
        },
    );
    let response = request
        .send()
        .await
        .map_err(|error| map_download_error(error, error_label, timeout, "request"))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(PlaylistDownloadResult::NotModified);
    }
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "Failed to download {}: HTTP {}",
            error_label, status
        )));
    }

    let metadata = RemotePlaylistCacheMetadata {
        etag: response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        last_modified: response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
    };

    log::info!("[playlist-load] Download started for {}", error_label);
    // Stream chunks straight to the temp file so peak memory stays at chunk
    // size instead of the full download (up to the 200 MiB cap).
    let download_result = async {
        use tokio::io::AsyncWriteExt;

        let mut file = tokio::fs::File::create(tmp_path)
            .await
            .map_err(AppError::Io)?;
        let mut total = 0u64;
        let mut stream = response.bytes_stream();
        let download_start = Instant::now();
        let mut last_progress = Instant::now() - PROGRESS_THROTTLE;
        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result
                .map_err(|error| map_download_error(error, error_label, timeout, "read"))?;
            total = total.saturating_add(chunk.len() as u64);
            if total > max_bytes {
                return Err(AppError::Other(format!(
                    "Downloaded {} exceeds the maximum allowed size ({} MiB)",
                    error_label,
                    max_bytes / (1024 * 1024)
                )));
            }
            file.write_all(&chunk).await.map_err(AppError::Io)?;
            if last_progress.elapsed() >= PROGRESS_THROTTLE {
                emit_load_progress(
                    app,
                    PlaylistLoadProgress::Downloading {
                        bytes_downloaded: total,
                        elapsed_secs: download_start.elapsed().as_secs_f64(),
                    },
                );
                last_progress = Instant::now();
            }
        }
        file.flush().await.map_err(AppError::Io)?;

        // Final progress emission to ensure the UI shows the complete size.
        let elapsed = download_start.elapsed().as_secs_f64();
        emit_load_progress(
            app,
            PlaylistLoadProgress::Downloading {
                bytes_downloaded: total,
                elapsed_secs: elapsed,
            },
        );
        log::info!(
            "[playlist-load] Download complete: {:.1} MB in {:.1}s",
            total as f64 / (1024.0 * 1024.0),
            elapsed,
        );
        Ok(())
    }
    .await;

    if let Err(error) = download_result {
        let _ = tokio::fs::remove_file(tmp_path).await;
        return Err(error);
    }

    Ok(PlaylistDownloadResult::Updated { metadata })
}

async fn download_playlist_to_cache(
    app: Option<&AppHandle>,
    cache_path: std::path::PathBuf,
    download_url: &Url,
    error_label: &str,
    accept_invalid_certs: bool,
) -> Result<String, AppError> {
    let metadata = load_cache_metadata(&cache_path);
    cleanup_stale_cache_temp_files(&cache_path);
    let tmp_path = build_cache_tmp_path(&cache_path);

    let download = download_playlist_to_file(
        app,
        download_url,
        error_label,
        PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT,
        PLAYLIST_DOWNLOAD_TIMEOUT,
        PLAYLIST_DOWNLOAD_MAX_BYTES,
        accept_invalid_certs,
        metadata.as_ref(),
        &tmp_path,
    )
    .await?;

    let response_metadata = match download {
        PlaylistDownloadResult::NotModified => {
            if cache_path.exists() {
                return Ok(cache_path.to_string_lossy().to_string());
            }
            match download_playlist_to_file(
                app,
                download_url,
                error_label,
                PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT,
                PLAYLIST_DOWNLOAD_TIMEOUT,
                PLAYLIST_DOWNLOAD_MAX_BYTES,
                accept_invalid_certs,
                None,
                &tmp_path,
            )
            .await?
            {
                PlaylistDownloadResult::NotModified => {
                    return Err(AppError::Other(format!(
                        "Server returned 304 for {}, but cache file is missing",
                        error_label
                    )));
                }
                PlaylistDownloadResult::Updated { metadata } => metadata,
            }
        }
        PlaylistDownloadResult::Updated { metadata } => metadata,
    };

    emit_load_progress(
        app,
        PlaylistLoadProgress::Saving {
            detail: "Writing to disk",
        },
    );
    // The body already lives in the temp file; just rename it into place.
    {
        let cache_path = cache_path.clone();
        let tmp_path = tmp_path.clone();
        tokio::task::spawn_blocking(move || {
            crate::engine::disk::atomic_rename(&cache_path, &tmp_path)
        })
        .await
        .map_err(|err| AppError::Other(format!("Playlist cache write task failed: {err}")))??;
    }
    if let Err(error) = save_cache_metadata(&cache_path, &response_metadata) {
        log::warn!(
            "Failed to persist remote playlist cache metadata for {}: {}",
            cache_path.to_string_lossy(),
            error
        );
    }

    Ok(cache_path.to_string_lossy().to_string())
}

pub(crate) async fn download_playlist_to_cache_in_data_dir(
    app: Option<&AppHandle>,
    data_dir: &std::path::Path,
    source_key: &str,
    download_url: &Url,
    error_label: &str,
    accept_invalid_certs: bool,
) -> Result<String, AppError> {
    let cache_path = remote_playlist_cache_path_from_data_dir(data_dir, source_key)?;
    download_playlist_to_cache(
        app,
        cache_path,
        download_url,
        error_label,
        accept_invalid_certs,
    )
    .await
}

/// Timestamped sibling temp path for a cache file.
fn build_cache_tmp_path(cache_path: &std::path::Path) -> std::path::PathBuf {
    let tmp_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    cache_path.with_file_name(format!(
        "{}.{}.tmp",
        cache_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "playlist.m3u8".to_string()),
        tmp_suffix
    ))
}

/// Write raw bytes to the playlist cache, using the same atomic-rename
/// strategy as `download_playlist_to_cache`.
pub(crate) fn write_bytes_to_cache(
    cache_path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), AppError> {
    cleanup_stale_cache_temp_files(cache_path);
    let tmp_path = build_cache_tmp_path(cache_path);
    crate::engine::disk::atomic_write(cache_path, &tmp_path, bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        build_cache_tmp_path, cleanup_stale_cache_temp_files, download_playlist_to_file,
        source_cache_file_name,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;

    #[test]
    fn source_cache_file_name_is_deterministic() {
        let first = source_cache_file_name("xtream:https://demo.example.com|a|m3u_plus|ts");
        let second = source_cache_file_name("xtream:https://demo.example.com|a|m3u_plus|ts");
        let third = source_cache_file_name("xtream:https://demo.example.com|b|m3u_plus|ts");

        assert_eq!(first, second);
        assert_ne!(first, third);
        assert!(first.ends_with(".m3u8"));
    }

    #[test]
    fn cleanup_stale_cache_temp_files_removes_only_matching_temp_files() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-cache-cleanup-{unique}"));
        std::fs::create_dir_all(&root).expect("temp dir should be created");

        let cache_path = root.join("playlist-cache.m3u8");
        let stale_a = root.join("playlist-cache.m3u8.111.tmp");
        let stale_b = root.join("playlist-cache.m3u8.222.tmp");
        let keep_other = root.join("other-file.tmp");
        let keep_cache = root.join("playlist-cache.m3u8");
        let recent_tmp = build_cache_tmp_path(&cache_path);

        std::fs::write(&stale_a, b"stale").expect("stale file should be writable");
        std::fs::write(&stale_b, b"stale").expect("stale file should be writable");
        std::fs::write(&keep_other, b"keep").expect("other file should be writable");
        std::fs::write(&keep_cache, b"keep").expect("cache file should be writable");
        std::fs::write(&recent_tmp, b"in flight").expect("recent temp file should be writable");

        cleanup_stale_cache_temp_files(&cache_path);

        assert!(!stale_a.exists());
        assert!(!stale_b.exists());
        assert!(keep_other.exists());
        assert!(keep_cache.exists());
        assert!(recent_tmp.exists());

        std::fs::remove_dir_all(root).expect("temp dir should be removable");
    }

    #[tokio::test]
    async fn download_playlist_bytes_returns_error_when_response_exceeds_max_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have local address");

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test server should accept");
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;

            let body = vec![b'a'; 128];
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("test server should write headers");
            socket
                .write_all(&body)
                .await
                .expect("test server should write body");
        });

        let url = Url::parse(&format!("http://{}/playlist.m3u8", address))
            .expect("test URL should parse");
        let tmp_path =
            std::env::temp_dir().join(format!("iptv-download-cap-test-{}.tmp", std::process::id()));
        let error = download_playlist_to_file(
            None,
            &url,
            "playlist URL",
            Duration::from_secs(1),
            Duration::from_secs(1),
            32,
            false,
            None,
            &tmp_path,
        )
        .await
        .expect_err("oversized response should fail");
        assert!(
            !tmp_path.exists(),
            "failed download should remove temp file"
        );

        assert!(
            error
                .to_string()
                .contains("exceeds the maximum allowed size"),
            "unexpected error: {}",
            error
        );
    }

    #[tokio::test]
    async fn download_playlist_bytes_returns_timeout_error_for_slow_streams() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have local address");

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test server should accept");
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;

            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n")
                .await
                .expect("test server should write headers");
            tokio::time::sleep(Duration::from_millis(250)).await;
            socket
                .write_all(b"hello")
                .await
                .expect("test server should write delayed body");
        });

        let url = Url::parse(&format!("http://{}/playlist.m3u8", address))
            .expect("test URL should parse");
        let tmp_path = std::env::temp_dir().join(format!(
            "iptv-download-timeout-test-{}.tmp",
            std::process::id()
        ));
        let error = download_playlist_to_file(
            None,
            &url,
            "playlist URL",
            Duration::from_millis(100),
            Duration::from_millis(100),
            1024,
            false,
            None,
            &tmp_path,
        )
        .await
        .expect_err("slow response should timeout");
        assert!(
            !tmp_path.exists(),
            "failed download should remove temp file"
        );

        assert!(
            error.to_string().contains("Timed out while downloading"),
            "unexpected error: {}",
            error
        );
    }
}
