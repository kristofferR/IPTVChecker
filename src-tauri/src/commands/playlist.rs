use crate::engine::parser;
use crate::error::AppError;
use crate::models::playlist::PlaylistPreview;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::Manager;
use url::Url;

#[derive(Debug, Clone, Deserialize)]
pub struct XtreamOpenRequest {
    pub server: String,
    pub username: String,
    pub password: String,
}

const PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PLAYLIST_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PLAYLIST_DOWNLOAD_MAX_BYTES: u64 = 10 * 1024 * 1024;

fn parse_http_url(value: &str, invalid_message: &str) -> Result<Url, AppError> {
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

fn normalize_url_identity(url: &Url) -> String {
    let mut normalized = url.clone();
    normalized.set_fragment(None);
    if (normalized.scheme() == "http" && normalized.port() == Some(80))
        || (normalized.scheme() == "https" && normalized.port() == Some(443))
    {
        let _ = normalized.set_port(None);
    }
    normalized.to_string()
}

fn source_cache_file_name(source_key: &str) -> String {
    format!("{}.m3u8", hash_source_key(source_key))
}

fn remote_playlist_cache_path(
    app: &tauri::AppHandle,
    source_key: &str,
) -> Result<std::path::PathBuf, AppError> {
    let data_dir = app.path().app_data_dir().map_err(|error| {
        AppError::Other(format!("Failed to resolve app data directory: {}", error))
    })?;
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
        if name.starts_with(&temp_prefix) && name.ends_with(".tmp") {
            let _ = std::fs::remove_file(path);
        }
    }
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

    AppError::Other(format!("Failed to {} downloaded {}: {}", when, error_label, error))
}

async fn download_playlist_bytes(
    download_url: &Url,
    error_label: &str,
    connect_timeout: Duration,
    timeout: Duration,
    max_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    use futures::StreamExt;

    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(connect_timeout)
        .timeout(timeout)
        .build()
        .map_err(|error| {
            AppError::Other(format!(
                "Failed to initialize HTTP client for {}: {}",
                error_label, error
            ))
        })?
        .get(download_url.clone())
        .header(reqwest::header::USER_AGENT, "IPTV-Checker-GUI/1.0")
        .send()
        .await
        .map_err(|error| map_download_error(error, error_label, timeout, "request"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "Failed to download {}: HTTP {}",
            error_label, status
        )));
    }

    let mut bytes = Vec::new();
    let mut total = 0u64;
    let mut stream = response.bytes_stream();
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
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

async fn download_playlist_to_cache(
    app: &tauri::AppHandle,
    source_key: &str,
    download_url: &Url,
    error_label: &str,
) -> Result<String, AppError> {
    let bytes = download_playlist_bytes(
        download_url,
        error_label,
        PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT,
        PLAYLIST_DOWNLOAD_TIMEOUT,
        PLAYLIST_DOWNLOAD_MAX_BYTES,
    )
    .await?;

    let cache_path = remote_playlist_cache_path(app, source_key)?;
    cleanup_stale_cache_temp_files(&cache_path);
    let tmp_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = cache_path.with_file_name(format!(
        "{}.{}.tmp",
        cache_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "playlist.m3u8".to_string()),
        tmp_suffix
    ));

    let persist_result = (|| -> Result<(), AppError> {
        std::fs::write(&tmp_path, &bytes).map_err(AppError::Io)?;

        match std::fs::rename(&tmp_path, &cache_path) {
            Ok(()) => {}
            Err(first_error) => {
                if cache_path.exists() {
                    std::fs::remove_file(&cache_path).map_err(AppError::Io)?;
                    std::fs::rename(&tmp_path, &cache_path).map_err(AppError::Io)?;
                } else {
                    return Err(AppError::Io(first_error));
                }
            }
        }
        Ok(())
    })();

    if let Err(error) = persist_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    Ok(cache_path.to_string_lossy().to_string())
}

fn normalize_xtream_server(server: &str) -> Result<Url, AppError> {
    let mut parsed = parse_http_url(server, "Invalid Xtream server URL")?;
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid Xtream server URL: missing host".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Parse(
            "Xtream server URL must not include credentials".to_string(),
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::Parse(
            "Xtream server URL must not include query parameters or fragments".to_string(),
        ));
    }

    let path = parsed.path().trim_end_matches('/');
    let normalized_path = if path.is_empty() || path == "/get.php" {
        "/".to_string()
    } else if path.to_ascii_lowercase().ends_with("/get.php") {
        let base = &path[..path.len() - "/get.php".len()];
        if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        }
    } else {
        path.to_string()
    };
    parsed.set_path(&normalized_path);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

fn xtream_server_identity(server: &Url) -> String {
    let mut cleaned = server.clone();
    let _ = cleaned.set_username("");
    let _ = cleaned.set_password(None);
    cleaned.set_query(None);
    cleaned.set_fragment(None);
    cleaned.to_string().trim_end_matches('/').to_string()
}

fn build_xtream_download_url(server: &Url, username: &str, password: &str) -> Url {
    let mut playlist_url = server.clone();
    let mut endpoint_path = playlist_url.path().trim_end_matches('/').to_string();
    if endpoint_path.is_empty() || endpoint_path == "/" {
        endpoint_path = "/get.php".to_string();
    } else {
        endpoint_path.push_str("/get.php");
    }
    playlist_url.set_path(&endpoint_path);
    playlist_url.set_query(None);
    playlist_url.set_fragment(None);
    playlist_url
        .query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password)
        .append_pair("type", "m3u_plus")
        .append_pair("output", "ts");
    playlist_url
}

fn build_xtream_source_key(server: &Url, username: &str) -> String {
    format!(
        "xtream:{}|{}|m3u_plus|ts",
        xtream_server_identity(server),
        username
    )
}

#[tauri::command]
pub async fn open_playlist(
    path: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    parser::parse_playlist(&path, &group_filter, &channel_search)
}

#[tauri::command]
pub async fn open_playlist_url(
    app: tauri::AppHandle,
    url: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let mut parsed = parse_http_url(url.trim(), "Invalid playlist URL")?;
    parsed.set_fragment(None);
    let normalized_identity = normalize_url_identity(&parsed);
    let source_key = format!("url:{}", normalized_identity);
    let cached_path =
        download_playlist_to_cache(&app, &source_key, &parsed, "playlist URL").await?;
    let mut preview = parser::parse_playlist(&cached_path, &group_filter, &channel_search)?;
    preview.source_identity = Some(format!("url:{}", normalized_identity));
    Ok(preview)
}

#[tauri::command]
pub async fn open_playlist_xtream(
    app: tauri::AppHandle,
    source: XtreamOpenRequest,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let username = source.username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::Parse(
            "Xtream username cannot be empty".to_string(),
        ));
    }

    let password = source.password.trim().to_string();
    if password.is_empty() {
        return Err(AppError::Parse(
            "Xtream password cannot be empty".to_string(),
        ));
    }

    let server = normalize_xtream_server(&source.server)?;
    let source_key = build_xtream_source_key(&server, &username);
    let download_url = build_xtream_download_url(&server, &username, &password);
    let cached_path =
        download_playlist_to_cache(&app, &source_key, &download_url, "Xtream playlist").await?;
    let mut preview = parser::parse_playlist(&cached_path, &group_filter, &channel_search)?;
    preview.source_identity = Some(source_key);
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::{
        build_xtream_download_url, build_xtream_source_key, cleanup_stale_cache_temp_files,
        download_playlist_bytes, normalize_url_identity, normalize_xtream_server,
        source_cache_file_name,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;

    #[test]
    fn normalize_xtream_server_trims_get_php_and_trailing_slash() {
        let server = normalize_xtream_server("https://demo.example.com:8080/get.php/")
            .expect("server should normalize");
        assert_eq!(server.to_string(), "https://demo.example.com:8080/");
    }

    #[test]
    fn normalize_xtream_server_rejects_invalid_scheme() {
        let error = normalize_xtream_server("ftp://demo.example.com")
            .expect_err("invalid scheme should fail");
        assert!(error.to_string().contains("must use http:// or https://"));
    }

    #[test]
    fn build_xtream_download_url_uses_expected_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_download_url(&server, "demo_user", "demo_pass");
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/get.php?username=demo_user&password=demo_pass&type=m3u_plus&output=ts"
        );
    }

    #[test]
    fn build_xtream_source_key_excludes_password() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let key = build_xtream_source_key(&server, "demo_user");
        assert_eq!(
            key,
            "xtream:https://demo.example.com:8080|demo_user|m3u_plus|ts"
        );
        assert!(!key.contains("demo_pass"));
    }

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

        std::fs::write(&stale_a, b"stale").expect("stale file should be writable");
        std::fs::write(&stale_b, b"stale").expect("stale file should be writable");
        std::fs::write(&keep_other, b"keep").expect("other file should be writable");
        std::fs::write(&keep_cache, b"keep").expect("cache file should be writable");

        cleanup_stale_cache_temp_files(&cache_path);

        assert!(!stale_a.exists());
        assert!(!stale_b.exists());
        assert!(keep_other.exists());
        assert!(keep_cache.exists());

        std::fs::remove_dir_all(root).expect("temp dir should be removable");
    }

    #[test]
    fn normalize_url_identity_removes_default_port_and_fragment() {
        let parsed =
            Url::parse("https://Example.com:443/live/list.m3u8#frag").expect("URL should parse");
        assert_eq!(
            normalize_url_identity(&parsed),
            "https://example.com/live/list.m3u8"
        );
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
        let error = download_playlist_bytes(
            &url,
            "playlist URL",
            Duration::from_secs(1),
            Duration::from_secs(1),
            32,
        )
        .await
        .expect_err("oversized response should fail");

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
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n",
                )
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
        let error = download_playlist_bytes(
            &url,
            "playlist URL",
            Duration::from_millis(100),
            Duration::from_millis(100),
            1024,
        )
        .await
        .expect_err("slow response should timeout");

        assert!(
            error.to_string().contains("Timed out while downloading"),
            "unexpected error: {}",
            error
        );
    }
}
