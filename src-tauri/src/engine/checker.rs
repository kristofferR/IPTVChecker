use std::collections::HashSet;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use url::Url;

use crate::error::AppError;
use crate::models::scan::{RetryBackoff, MAX_RETRIES, MIN_RETRIES};

/// Minimum data threshold for direct streams (500KB).
const MIN_DATA_THRESHOLD: u64 = 1024 * 500;
/// Smaller threshold for HLS media segments (128KB).
const PLAYLIST_SEGMENT_THRESHOLD: u64 = 1024 * 128;
/// Maximum depth for following nested playlists.
const MAX_PLAYLIST_DEPTH: u32 = 4;
/// HTTP status codes indicating potential geoblocking.
const GEOBLOCK_STATUSES: &[u16] = &[403, 451, 426];
const SECONDARY_GEOBLOCK_STATUSES: &[u16] = &[401, 423, 451];
/// HTTP status codes that are typically transient and should be retried.
const RETRYABLE_HTTP_STATUSES: &[u16] = &[408, 425, 429, 500, 502, 503, 504];

/// Internal result from a single verification attempt.
#[derive(Debug, PartialEq, Eq)]
enum VerifyResult {
    Alive(Option<String>),
    Dead,
    Geoblocked,
    Retry,
}

fn classify_non_ok_status(status_code: u16) -> VerifyResult {
    if GEOBLOCK_STATUSES.contains(&status_code)
        || SECONDARY_GEOBLOCK_STATUSES.contains(&status_code)
    {
        return VerifyResult::Geoblocked;
    }

    if RETRYABLE_HTTP_STATUSES.contains(&status_code) {
        return VerifyResult::Retry;
    }

    VerifyResult::Dead
}

fn is_retryable_request_error(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() || err.is_decode()
    {
        return true;
    }

    err.status()
        .map(|status| RETRYABLE_HTTP_STATUSES.contains(&status.as_u16()))
        .unwrap_or(false)
}

fn total_attempts(max_retries: u32) -> u32 {
    max_retries.saturating_add(1)
}

fn retry_delay_seconds(backoff: RetryBackoff, retry_index: u32) -> u64 {
    match backoff {
        RetryBackoff::None => 0,
        RetryBackoff::Linear => u64::from((retry_index + 1).min(10)),
        RetryBackoff::Exponential => (1u64 << retry_index.min(5)).min(30),
    }
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

fn parse_variant_score(stream_inf_line: &str) -> (u64, u64, u64) {
    let mut resolution_pixels = 0u64;
    let mut average_bandwidth = 0u64;
    let mut bandwidth = 0u64;

    for raw_attribute in stream_inf_line.split(',') {
        let Some((raw_key, raw_value)) = raw_attribute.split_once('=') else {
            continue;
        };

        let key = raw_key.trim().to_ascii_uppercase();
        let value = raw_value.trim().trim_matches('"').trim_matches('\'');

        match key.as_str() {
            "RESOLUTION" => {
                if let Some((raw_width, raw_height)) = value.split_once('x') {
                    if let (Ok(width), Ok(height)) = (
                        raw_width.trim().parse::<u64>(),
                        raw_height.trim().parse::<u64>(),
                    ) {
                        resolution_pixels = width.saturating_mul(height);
                    }
                }
            }
            "AVERAGE-BANDWIDTH" => {
                if let Ok(parsed) = value.parse::<u64>() {
                    average_bandwidth = parsed;
                }
            }
            "BANDWIDTH" => {
                if let Ok(parsed) = value.parse::<u64>() {
                    bandwidth = parsed;
                }
            }
            _ => {}
        }
    }

    (resolution_pixels, average_bandwidth, bandwidth)
}

/// Extract a playable URI from an HLS playlist body, resolving relative URLs.
///
/// For master playlists, prefer the highest-quality variant by RESOLUTION, then
/// AVERAGE-BANDWIDTH, then BANDWIDTH. For media playlists, use the first segment URI.
fn extract_next_url(base_url: &str, playlist_body: &str) -> Option<String> {
    let base = Url::parse(base_url).ok()?;
    let mut first_uri: Option<String> = None;
    let mut variant_candidates: Vec<(String, (u64, u64, u64))> = Vec::new();
    let mut pending_variant_score: Option<(u64, u64, u64)> = None;

    for raw_line in playlist_body.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_variant_score = Some(parse_variant_score(attributes));
            continue;
        }

        if line.starts_with('#') {
            continue;
        }

        let resolved = match base.join(line) {
            Ok(url) => url.to_string(),
            Err(_) => continue,
        };

        if let Some(score) = pending_variant_score.take() {
            variant_candidates.push((resolved, score));
            continue;
        }

        if first_uri.is_none() {
            first_uri = Some(resolved);
        }
    }

    if let Some((best_url, _)) = variant_candidates
        .into_iter()
        .max_by_key(|(_, score)| *score)
    {
        return Some(best_url);
    }

    first_uri
}

/// Read from a streaming response, checking if we receive enough data.
async fn read_stream(response: reqwest::Response, min_bytes: u64) -> VerifyResult {
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
        return VerifyResult::Retry;
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

    let normalized = target_url
        .split('#')
        .next()
        .unwrap_or(target_url)
        .to_string();
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
            if is_retryable_request_error(&e) {
                return VerifyResult::Retry;
            }
            return VerifyResult::Dead;
        }
    };

    let status_code = resp.status().as_u16();

    if status_code != 200 {
        return classify_non_ok_status(status_code);
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
            _ => return VerifyResult::Retry,
        };
        let next_url = match extract_next_url(&final_url, &playlist_text) {
            Some(u) => u,
            None => return VerifyResult::Retry,
        };
        return Box::pin(verify(
            client,
            &next_url,
            timeout_secs,
            depth + 1,
            visited,
            headers,
        ))
        .await;
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
    retry_backoff: RetryBackoff,
    extended_timeout: Option<f64>,
    user_agent: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<(String, Option<String>), AppError> {
    if !timeout.is_finite() || timeout <= 0.0 {
        return Err(AppError::Other(
            "Invalid timeout: must be greater than 0 seconds".to_string(),
        ));
    }
    if let Some(ext) = extended_timeout {
        if !ext.is_finite() || ext <= 0.0 {
            return Err(AppError::Other(
                "Invalid extended timeout: must be greater than 0 seconds".to_string(),
            ));
        }
    }

    let retries = retries.clamp(MIN_RETRIES, MAX_RETRIES);
    let attempts = total_attempts(retries);

    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(user_agent)
            .unwrap_or_else(|_| HeaderValue::from_static("VLC/3.0.14 LibVLC/3.0.14")),
    );

    log::info!("Checking channel: {}", url);

    let attempt_check = |current_timeout: f64| {
        let client = client.clone();
        let headers = headers.clone();
        let url = url.to_string();
        let cancel = cancel_token.clone();
        async move {
            for attempt in 0..attempts {
                if cancel.is_cancelled() {
                    return Err(AppError::Cancelled);
                }

                log::debug!(
                    "Attempt {}/{} for {} (timeout: {}s, max_retries: {}, backoff: {:?})",
                    attempt + 1,
                    attempts,
                    url,
                    current_timeout,
                    retries,
                    retry_backoff
                );
                let mut visited = HashSet::new();
                let result =
                    verify(&client, &url, current_timeout, 0, &mut visited, &headers).await;

                match result {
                    VerifyResult::Alive(stream_url) => {
                        log::info!("Channel alive: {}", url);
                        return Ok(("Alive".to_string(), stream_url));
                    }
                    VerifyResult::Dead => {
                        log::info!("Channel dead: {}", url);
                        return Ok(("Dead".to_string(), None));
                    }
                    VerifyResult::Geoblocked => {
                        log::info!("Channel geoblocked: {}", url);
                        return Ok(("Geoblocked".to_string(), None));
                    }
                    VerifyResult::Retry => {
                        log::debug!("Retrying channel: {}", url);
                        if attempt < retries {
                            let delay = retry_delay_seconds(retry_backoff, attempt);
                            if delay > 0 {
                                tokio::time::sleep(Duration::from_secs(delay)).await;
                            }
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
        let playlist =
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nhttp://example.com/low.m3u8\n";
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
    fn test_extract_next_url_prefers_highest_master_variant() {
        let playlist = r#"#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=511680,AVERAGE-BANDWIDTH=393600,RESOLUTION=426x240,CODECS="avc1.4d5015,mp4a.40.2"
240p-cc/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5188040,AVERAGE-BANDWIDTH=3990800,RESOLUTION=1280x720,CODECS="avc1.64101f,mp4a.40.2"
720p-cc/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8048040,AVERAGE-BANDWIDTH=6190800,RESOLUTION=1920x1080,CODECS="avc1.641028,mp4a.40.2"
1080p-cc/index.m3u8
"#;

        let result = extract_next_url(
            "https://raycom-accdn-firetv.amagi.tv/playlist.m3u8",
            playlist,
        );

        assert_eq!(
            result,
            Some("https://raycom-accdn-firetv.amagi.tv/1080p-cc/index.m3u8".to_string())
        );
    }

    #[test]
    fn test_extract_next_url_media_playlist_uses_first_segment() {
        let playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk-001.ts\n#EXTINF:4,\nchunk-002.ts\n";
        let result = extract_next_url("http://example.com/live/720p/index.m3u8", playlist);
        assert_eq!(
            result,
            Some("http://example.com/live/720p/chunk-001.ts".to_string())
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

    #[test]
    fn test_retryable_status_classification() {
        for status in [408u16, 425, 429, 500, 502, 503, 504] {
            assert_eq!(classify_non_ok_status(status), VerifyResult::Retry);
        }
    }

    #[test]
    fn test_geoblock_status_classification() {
        for status in [401u16, 403, 423, 426, 451] {
            assert_eq!(classify_non_ok_status(status), VerifyResult::Geoblocked);
        }
    }

    #[test]
    fn test_terminal_status_classification() {
        for status in [400u16, 404, 405, 410] {
            assert_eq!(classify_non_ok_status(status), VerifyResult::Dead);
        }
    }

    #[test]
    fn test_retry_delay_respects_selected_policy() {
        assert_eq!(retry_delay_seconds(RetryBackoff::None, 0), 0);
        assert_eq!(retry_delay_seconds(RetryBackoff::Linear, 0), 1);
        assert_eq!(retry_delay_seconds(RetryBackoff::Linear, 4), 5);
        assert_eq!(retry_delay_seconds(RetryBackoff::Exponential, 0), 1);
        assert_eq!(retry_delay_seconds(RetryBackoff::Exponential, 3), 8);
    }

    #[test]
    fn test_total_attempts_includes_initial_request() {
        assert_eq!(total_attempts(0), 1);
        assert_eq!(total_attempts(3), 4);
    }
}
