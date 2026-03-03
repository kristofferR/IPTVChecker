use std::collections::HashSet;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use url::Url;

use crate::error::AppError;

/// Minimum data threshold for direct streams (500KB).
const MIN_DATA_THRESHOLD: u64 = 1024 * 500;
/// Smaller threshold for HLS media segments (128KB).
const PLAYLIST_SEGMENT_THRESHOLD: u64 = 1024 * 128;
/// Maximum depth for following nested playlists.
const MAX_PLAYLIST_DEPTH: u32 = 4;
/// HTTP status codes indicating potential geoblocking.
const GEOBLOCK_STATUSES: &[u16] = &[403, 451, 426];
const SECONDARY_GEOBLOCK_STATUSES: &[u16] = &[401, 423, 451];

/// Internal result from a single verification attempt.
#[derive(Debug)]
enum VerifyResult {
    Alive(Option<String>),
    Dead,
    Geoblocked,
    Retry,
}

fn is_playlist_content_type(content_type: &str, url: &str) -> bool {
    let ct = content_type.to_lowercase();
    let path = Url::parse(url)
        .map(|u| u.path().to_lowercase())
        .unwrap_or_default();
    ct.contains("application/vnd.apple.mpegurl")
        || ct.contains("application/x-mpegurl")
        || path.ends_with(".m3u8")
}

fn is_direct_stream(content_type: &str, url: &str) -> bool {
    let ct = content_type.to_lowercase();
    let path = Url::parse(url)
        .map(|u| u.path().to_lowercase())
        .unwrap_or_default();
    ct.starts_with("video/")
        || ct.starts_with("audio/")
        || ct.contains("application/octet-stream")
        || ct.contains("application/mp4")
        || path.ends_with(".ts")
        || path.ends_with(".m2ts")
        || path.ends_with(".m4s")
        || path.ends_with(".mp4")
        || path.ends_with(".aac")
}

/// Extract the first non-comment URI from an HLS playlist body, resolving relative URLs.
fn extract_next_url(base_url: &str, playlist_body: &str) -> Option<String> {
    let base = Url::parse(base_url).ok()?;

    for raw_line in playlist_body.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // First non-comment, non-empty line is the URI
        return Some(base.join(line).ok()?.to_string());
    }
    None
}

/// Read from a streaming response, checking if we receive enough data.
async fn read_stream(
    response: reqwest::Response,
    min_bytes: u64,
) -> VerifyResult {
    use futures::StreamExt;

    let mut bytes_read: u64 = 0;
    let mut stable = true;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                bytes_read += chunk.len() as u64;
                if bytes_read >= min_bytes {
                    return VerifyResult::Alive(None);
                }
            }
            Err(_) => {
                stable = false;
                break;
            }
        }
    }

    if !stable {
        return VerifyResult::Dead;
    }

    // Fallback threshold logic
    let fallback = if min_bytes >= MIN_DATA_THRESHOLD {
        min_bytes
    } else {
        std::cmp::max(32768, min_bytes / 2)
    };

    if bytes_read >= fallback {
        VerifyResult::Alive(None)
    } else {
        VerifyResult::Dead
    }
}

/// Recursively verify a stream URL, following HLS playlists up to MAX_PLAYLIST_DEPTH.
async fn verify(
    client: &reqwest::Client,
    target_url: &str,
    timeout_secs: f64,
    depth: u32,
    visited: &mut HashSet<String>,
    headers: &HeaderMap,
) -> VerifyResult {
    if depth > MAX_PLAYLIST_DEPTH {
        return VerifyResult::Dead;
    }

    let normalized = target_url.split('#').next().unwrap_or(target_url).to_string();
    if visited.contains(&normalized) {
        return VerifyResult::Dead;
    }
    visited.insert(normalized);

    let request = client
        .get(target_url)
        .headers(headers.clone())
        .timeout(Duration::from_secs_f64(timeout_secs));

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_connect() || e.is_timeout() {
                return VerifyResult::Retry;
            }
            return VerifyResult::Dead;
        }
    };

    let status_code = resp.status().as_u16();

    if status_code == 429 {
        return VerifyResult::Retry;
    }
    if GEOBLOCK_STATUSES.contains(&status_code) {
        return VerifyResult::Geoblocked;
    }
    if status_code != 200 {
        if SECONDARY_GEOBLOCK_STATUSES.contains(&status_code) {
            return VerifyResult::Geoblocked;
        }
        return VerifyResult::Dead;
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let final_url = resp.url().to_string();

    if is_playlist_content_type(&content_type, &final_url) {
        let playlist_text = match resp.text().await {
            Ok(t) if !t.is_empty() => t,
            _ => return VerifyResult::Dead,
        };
        let next_url = match extract_next_url(&final_url, &playlist_text) {
            Some(u) => u,
            None => return VerifyResult::Dead,
        };
        return Box::pin(verify(client, &next_url, timeout_secs, depth + 1, visited, headers)).await;
    }

    let min_bytes = if is_direct_stream(&content_type, &final_url) {
        if depth == 0 {
            MIN_DATA_THRESHOLD
        } else {
            PLAYLIST_SEGMENT_THRESHOLD
        }
    } else if content_type.to_lowercase().starts_with("text/") {
        return VerifyResult::Dead;
    } else {
        // Unrecognized content-type — attempt stream read
        if depth == 0 {
            MIN_DATA_THRESHOLD
        } else {
            PLAYLIST_SEGMENT_THRESHOLD
        }
    };

    let result = read_stream(resp, min_bytes).await;
    match &result {
        VerifyResult::Alive(_) => VerifyResult::Alive(Some(final_url)),
        _ => result,
    }
}

/// Check the status of a single channel URL.
///
/// Returns (ChannelStatus string, Option<stream_url>).
pub async fn check_channel_status(
    client: &reqwest::Client,
    url: &str,
    timeout: f64,
    retries: u32,
    extended_timeout: Option<f64>,
    user_agent: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<(String, Option<String>), AppError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(user_agent).unwrap_or_else(|_| HeaderValue::from_static("VLC/3.0.14 LibVLC/3.0.14")),
    );

    let attempt_check = |current_timeout: f64| {
        let client = client.clone();
        let headers = headers.clone();
        let url = url.to_string();
        let cancel = cancel_token.clone();
        async move {
            for attempt in 0..retries {
                if cancel.is_cancelled() {
                    return Err(AppError::Cancelled);
                }

                let mut visited = HashSet::new();
                let result = verify(&client, &url, current_timeout, 0, &mut visited, &headers).await;

                match result {
                    VerifyResult::Alive(stream_url) => return Ok(("Alive".to_string(), stream_url)),
                    VerifyResult::Dead => return Ok(("Dead".to_string(), None)),
                    VerifyResult::Geoblocked => return Ok(("Geoblocked".to_string(), None)),
                    VerifyResult::Retry => {
                        if attempt + 1 < retries {
                            let delay = std::cmp::min(2 + attempt as u64, 5);
                            tokio::time::sleep(Duration::from_secs(delay)).await;
                        }
                    }
                }
            }
            Ok(("Dead".to_string(), None))
        }
    };

    let (status, stream_url) = attempt_check(timeout).await?;

    // If dead and extended timeout enabled, retry
    if status == "Dead" {
        if let Some(ext_timeout) = extended_timeout {
            let (status2, stream_url2) = attempt_check(ext_timeout).await?;
            return Ok((status2, stream_url2));
        }
    }

    Ok((status, stream_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_next_url_simple() {
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nhttp://example.com/low.m3u8\n";
        let result = extract_next_url("http://example.com/master.m3u8", playlist);
        assert_eq!(result, Some("http://example.com/low.m3u8".to_string()));
    }

    #[test]
    fn test_extract_next_url_relative() {
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nlow/index.m3u8\n";
        let result = extract_next_url("http://example.com/live/master.m3u8", playlist);
        assert_eq!(
            result,
            Some("http://example.com/live/low/index.m3u8".to_string())
        );
    }

    #[test]
    fn test_is_playlist_content_type() {
        assert!(is_playlist_content_type(
            "application/vnd.apple.mpegurl",
            "http://example.com/stream"
        ));
        assert!(is_playlist_content_type(
            "text/html",
            "http://example.com/stream.m3u8"
        ));
        assert!(!is_playlist_content_type(
            "video/mp4",
            "http://example.com/video.mp4"
        ));
    }
}
