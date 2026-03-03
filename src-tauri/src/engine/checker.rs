use std::collections::HashSet;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderValue, LOCATION, USER_AGENT};
use url::Url;

use crate::error::AppError;
use crate::models::scan::{RetryBackoff, MAX_RETRIES, MIN_RETRIES};
use crate::models::scan_log::{ChannelAttemptDebugLog, ChannelDebugLog};

/// Minimum data threshold for direct streams (500KB).
const MIN_DATA_THRESHOLD: u64 = 1024 * 500;
/// Smaller threshold for HLS media segments (128KB).
const PLAYLIST_SEGMENT_THRESHOLD: u64 = 1024 * 128;
/// Maximum depth for following nested playlists.
const MAX_PLAYLIST_DEPTH: u32 = 4;
/// Maximum depth for following HTTP redirects.
const MAX_REDIRECT_DEPTH: u32 = 10;
/// HTTP status codes indicating potential geoblocking.
const GEOBLOCK_STATUSES: &[u16] = &[403, 451, 426];
const SECONDARY_GEOBLOCK_STATUSES: &[u16] = &[401, 423, 451];
/// HTTP status codes that are typically transient and should be retried.
const RETRYABLE_HTTP_STATUSES: &[u16] = &[408, 425, 429, 500, 502, 503, 504];

fn elapsed_millis(started_at: Instant) -> u64 {
    started_at
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Internal result from a single verification attempt.
#[derive(Debug, PartialEq, Eq)]
enum VerifyResult {
    Alive {
        stream_url: Option<String>,
        latency_ms: Option<u64>,
    },
    Dead {
        latency_ms: Option<u64>,
        reason: Option<String>,
    },
    Geoblocked {
        latency_ms: Option<u64>,
        reason: Option<String>,
    },
    Retry {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Default)]
struct VerifyMetrics {
    http_status_codes: Vec<u16>,
    redirect_chain: Vec<String>,
    bytes_transferred: u64,
    ttfb_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ChannelCheckOutcome {
    pub status: String,
    pub stream_url: Option<String>,
    pub latency_ms: Option<u64>,
    pub retries_used: u32,
    pub last_error_reason: Option<String>,
    pub debug_log: ChannelDebugLog,
}

fn classify_non_ok_status(status_code: u16, latency_ms: Option<u64>) -> VerifyResult {
    let reason = Some(format!("HTTP {}", status_code));
    if GEOBLOCK_STATUSES.contains(&status_code)
        || SECONDARY_GEOBLOCK_STATUSES.contains(&status_code)
    {
        return VerifyResult::Geoblocked { latency_ms, reason };
    }

    if RETRYABLE_HTTP_STATUSES.contains(&status_code) {
        return VerifyResult::Retry { reason };
    }

    VerifyResult::Dead { latency_ms, reason }
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

fn summarize_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "Timeout".to_string();
    }

    let raw = err.to_string();
    let lowered = raw.to_ascii_lowercase();

    if lowered.contains("connection refused") {
        return "Connection refused".to_string();
    }
    if lowered.contains("dns")
        || lowered.contains("failed to lookup address information")
        || lowered.contains("name or service not known")
        || lowered.contains("no such host")
        || lowered.contains("nodename nor servname")
    {
        return "DNS failure".to_string();
    }
    if lowered.contains("ssl")
        || lowered.contains("tls")
        || lowered.contains("certificate")
        || lowered.contains("handshake")
    {
        return "SSL/TLS error".to_string();
    }
    if lowered.contains("invalid url")
        || lowered.contains("builder error for url")
        || lowered.contains("unsupported scheme")
        || lowered.contains("relative url without a base")
    {
        return "Invalid URL".to_string();
    }
    if lowered.contains("redirect") && (lowered.contains("loop") || lowered.contains("too many")) {
        return "Redirect loop".to_string();
    }

    if let Some(status) = err.status() {
        return format!("HTTP {}", status.as_u16());
    }
    raw
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
async fn read_stream(
    response: reqwest::Response,
    min_bytes: u64,
    latency_ms: Option<u64>,
    request_started_at: Instant,
    metrics: &mut VerifyMetrics,
) -> VerifyResult {
    use futures::StreamExt;

    let mut bytes_read: u64 = 0;
    let mut observed_latency_ms = latency_ms;
    let mut stable = true;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                if observed_latency_ms.is_none() {
                    observed_latency_ms = Some(elapsed_millis(request_started_at));
                }
                bytes_read += chunk.len() as u64;
                metrics.bytes_transferred = metrics.bytes_transferred.saturating_add(chunk.len() as u64);
                if metrics.ttfb_ms.is_none() {
                    metrics.ttfb_ms = observed_latency_ms;
                }
                if bytes_read >= min_bytes {
                    return VerifyResult::Alive {
                        stream_url: None,
                        latency_ms: observed_latency_ms,
                    };
                }
            }
            Err(_) => {
                stable = false;
                break;
            }
        }
    }

    if !stable {
        return VerifyResult::Retry {
            reason: Some("Stream read interrupted".to_string()),
        };
    }

    // Fallback threshold logic
    let fallback = if min_bytes >= MIN_DATA_THRESHOLD {
        min_bytes
    } else {
        std::cmp::max(32768, min_bytes / 2)
    };

    if bytes_read >= fallback {
        VerifyResult::Alive {
            stream_url: None,
            latency_ms: observed_latency_ms.or(Some(elapsed_millis(request_started_at))),
        }
    } else {
        VerifyResult::Dead {
            latency_ms: observed_latency_ms.or(Some(elapsed_millis(request_started_at))),
            reason: Some(format!(
                "No data (insufficient stream data: {} bytes)",
                bytes_read
            )),
        }
    }
}

/// Recursively verify a stream URL, following HLS playlists up to MAX_PLAYLIST_DEPTH.
async fn verify(
    client: &reqwest::Client,
    target_url: &str,
    timeout_secs: f64,
    playlist_depth: u32,
    redirect_depth: u32,
    visited: &mut HashSet<String>,
    headers: &HeaderMap,
    root_latency_ms: Option<u64>,
    metrics: &mut VerifyMetrics,
) -> VerifyResult {
    if playlist_depth > MAX_PLAYLIST_DEPTH {
        return VerifyResult::Dead {
            latency_ms: root_latency_ms,
            reason: Some("Playlist recursion limit exceeded".to_string()),
        };
    }
    if redirect_depth > MAX_REDIRECT_DEPTH {
        return VerifyResult::Dead {
            latency_ms: root_latency_ms,
            reason: Some("Redirect loop".to_string()),
        };
    }

    let normalized = target_url
        .split('#')
        .next()
        .unwrap_or(target_url)
        .to_string();
    if visited.contains(&normalized) {
        return VerifyResult::Dead {
            latency_ms: root_latency_ms,
            reason: Some("Redirect loop".to_string()),
        };
    }
    visited.insert(normalized);
    if metrics
        .redirect_chain
        .last()
        .map(|value| value != target_url)
        .unwrap_or(true)
    {
        metrics.redirect_chain.push(target_url.to_string());
    }

    let request = client
        .get(target_url)
        .headers(headers.clone())
        .timeout(Duration::from_secs_f64(timeout_secs));

    let request_started_at = Instant::now();
    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            if is_retryable_request_error(&e) {
                return VerifyResult::Retry {
                    reason: Some(summarize_reqwest_error(&e)),
                };
            }
            return VerifyResult::Dead {
                latency_ms: root_latency_ms,
                reason: Some(summarize_reqwest_error(&e)),
            };
        }
    };
    let request_latency_ms = elapsed_millis(request_started_at);
    let effective_root_latency = root_latency_ms.or(Some(request_latency_ms));

    let status_code = resp.status().as_u16();
    metrics.http_status_codes.push(status_code);
    if metrics.ttfb_ms.is_none() {
        metrics.ttfb_ms = Some(request_latency_ms);
    }

    if (300..=399).contains(&status_code) {
        let location = match resp
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value,
            None => {
                return VerifyResult::Dead {
                    latency_ms: effective_root_latency,
                    reason: Some(format!("HTTP {} without Location header", status_code)),
                };
            }
        };

        let next_url = match resp.url().join(location) {
            Ok(url) => url.to_string(),
            Err(_) => {
                return VerifyResult::Dead {
                    latency_ms: effective_root_latency,
                    reason: Some(format!(
                        "HTTP {} with invalid redirect location",
                        status_code
                    )),
                };
            }
        };

        return Box::pin(verify(
            client,
            &next_url,
            timeout_secs,
            playlist_depth,
            redirect_depth + 1,
            visited,
            headers,
            effective_root_latency,
            metrics,
        ))
        .await;
    }

    if status_code != 200 {
        return classify_non_ok_status(status_code, effective_root_latency);
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
            _ => {
                return VerifyResult::Retry {
                    reason: Some("Empty playlist body".to_string()),
                };
            }
        };
        let next_url = match extract_next_url(&final_url, &playlist_text) {
            Some(u) => u,
            None => {
                return VerifyResult::Retry {
                    reason: Some("No playable URI found in playlist".to_string()),
                };
            }
        };
        return Box::pin(verify(
            client,
            &next_url,
            timeout_secs,
            playlist_depth + 1,
            redirect_depth,
            visited,
            headers,
            effective_root_latency,
            metrics,
        ))
        .await;
    }

    let min_bytes = if is_direct_stream(&content_type, &final_url) {
        if playlist_depth == 0 {
            MIN_DATA_THRESHOLD
        } else {
            PLAYLIST_SEGMENT_THRESHOLD
        }
    } else if content_type.to_lowercase().starts_with("text/") {
        return VerifyResult::Dead {
            latency_ms: effective_root_latency,
            reason: Some(format!(
                "Unexpected text content type: {}",
                content_type
            )),
        };
    } else {
        // Unrecognized content-type — attempt stream read
        if playlist_depth == 0 {
            MIN_DATA_THRESHOLD
        } else {
            PLAYLIST_SEGMENT_THRESHOLD
        }
    };

    let result = read_stream(resp, min_bytes, root_latency_ms, request_started_at, metrics).await;
    match result {
        VerifyResult::Alive { latency_ms, .. } => VerifyResult::Alive {
            stream_url: Some(final_url),
            latency_ms,
        },
        _ => result,
    }
}

/// Check the status of a single channel URL.
///
/// Returns status + diagnostics used for structured scan log export.
pub async fn check_channel_status_with_debug(
    client: &reqwest::Client,
    url: &str,
    timeout: f64,
    retries: u32,
    retry_backoff: RetryBackoff,
    extended_timeout: Option<f64>,
    user_agent: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<ChannelCheckOutcome, AppError> {
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

    struct AttemptOutcome {
        status: String,
        stream_url: Option<String>,
        latency_ms: Option<u64>,
        retries_used: u32,
        last_error_reason: Option<String>,
        successful_attempt: Option<u32>,
        attempts: Vec<ChannelAttemptDebugLog>,
    }

    let attempt_check = |current_timeout: f64, attempt_offset: u32| {
        let client = client.clone();
        let headers = headers.clone();
        let url = url.to_string();
        let cancel = cancel_token.clone();
        async move {
            let mut retries_used = 0u32;
            let mut last_error_reason: Option<String> = None;
            let mut attempt_logs = Vec::<ChannelAttemptDebugLog>::new();

            for attempt in 0..attempts {
                if cancel.is_cancelled() {
                    return Err(AppError::Cancelled);
                }

                let attempt_number = attempt_offset.saturating_add(attempt).saturating_add(1);
                let attempt_started_at_epoch_ms = now_epoch_ms();

                log::debug!(
                    "Attempt {}/{} for {} (timeout: {}s, max_retries: {}, backoff: {:?})",
                    attempt + 1,
                    attempts,
                    url,
                    current_timeout,
                    retries,
                    retry_backoff
                );
                let mut metrics = VerifyMetrics::default();
                let mut visited = HashSet::new();
                let result = verify(
                    &client,
                    &url,
                    current_timeout,
                    0,
                    0,
                    &mut visited,
                    &headers,
                    None,
                    &mut metrics,
                )
                .await;
                let attempt_ended_at_epoch_ms = now_epoch_ms();

                let (verdict, reason_for_log) = match &result {
                    VerifyResult::Alive { .. } => ("Alive".to_string(), None),
                    VerifyResult::Dead { reason, .. } => ("Dead".to_string(), reason.clone()),
                    VerifyResult::Geoblocked { reason, .. } => {
                        ("Geoblocked".to_string(), reason.clone())
                    }
                    VerifyResult::Retry { reason } => ("Retry".to_string(), reason.clone()),
                };
                attempt_logs.push(ChannelAttemptDebugLog {
                    attempt: attempt_number,
                    timeout_secs: current_timeout,
                    started_at_epoch_ms: attempt_started_at_epoch_ms,
                    ended_at_epoch_ms: attempt_ended_at_epoch_ms,
                    verdict: verdict.clone(),
                    reason: reason_for_log.clone(),
                    http_status_codes: metrics.http_status_codes,
                    redirect_chain: metrics.redirect_chain,
                    bytes_transferred: metrics.bytes_transferred,
                    ttfb_ms: metrics.ttfb_ms,
                });

                match result {
                    VerifyResult::Alive {
                        stream_url,
                        latency_ms,
                    } => {
                        log::info!("Channel alive: {}", url);
                        return Ok(AttemptOutcome {
                            status: "Alive".to_string(),
                            stream_url,
                            latency_ms,
                            retries_used,
                            last_error_reason,
                            successful_attempt: Some(attempt_number),
                            attempts: attempt_logs,
                        });
                    }
                    VerifyResult::Dead { latency_ms, reason } => {
                        log::info!("Channel dead: {}", url);
                        return Ok(AttemptOutcome {
                            status: "Dead".to_string(),
                            stream_url: None,
                            latency_ms,
                            retries_used,
                            last_error_reason: reason.or(last_error_reason),
                            successful_attempt: None,
                            attempts: attempt_logs,
                        });
                    }
                    VerifyResult::Geoblocked { latency_ms, reason } => {
                        log::info!("Channel geoblocked: {}", url);
                        return Ok(AttemptOutcome {
                            status: "Geoblocked".to_string(),
                            stream_url: None,
                            latency_ms,
                            retries_used,
                            last_error_reason: reason.or(last_error_reason),
                            successful_attempt: None,
                            attempts: attempt_logs,
                        });
                    }
                    VerifyResult::Retry { reason } => {
                        if let Some(reason) = reason {
                            last_error_reason = Some(reason);
                        }
                        log::debug!("Retrying channel: {}", url);
                        if attempt < retries {
                            retries_used = retries_used.saturating_add(1);
                            let delay = retry_delay_seconds(retry_backoff, attempt);
                            if delay > 0 {
                                tokio::time::sleep(Duration::from_secs(delay)).await;
                            }
                        }
                    }
                }
            }
            Ok(AttemptOutcome {
                status: "Dead".to_string(),
                stream_url: None,
                latency_ms: None,
                retries_used,
                last_error_reason,
                successful_attempt: None,
                attempts: attempt_logs,
            })
        }
    };

    let first = attempt_check(timeout, 0).await?;
    let mut final_outcome = first;

    // If dead and extended timeout enabled, retry
    if final_outcome.status == "Dead" {
        if let Some(ext_timeout) = extended_timeout {
            let second = attempt_check(ext_timeout, final_outcome.attempts.len() as u32).await?;
            let mut combined_attempts = final_outcome.attempts;
            combined_attempts.extend(second.attempts);

            final_outcome = AttemptOutcome {
                status: second.status,
                stream_url: second.stream_url,
                latency_ms: second.latency_ms,
                retries_used: final_outcome.retries_used.saturating_add(second.retries_used),
                last_error_reason: second.last_error_reason.or(final_outcome.last_error_reason),
                successful_attempt: second.successful_attempt,
                attempts: combined_attempts,
            };
        }
    }

    let mut http_status_codes = Vec::<u16>::new();
    let mut redirect_chain = Vec::<String>::new();
    let mut bytes_transferred: u64 = 0;
    let mut ttfb_ms: Option<u64> = None;
    for attempt in &final_outcome.attempts {
        http_status_codes.extend_from_slice(&attempt.http_status_codes);
        for url in &attempt.redirect_chain {
            if redirect_chain.last().map(|value| value != url).unwrap_or(true) {
                redirect_chain.push(url.clone());
            }
        }
        bytes_transferred = bytes_transferred.saturating_add(attempt.bytes_transferred);
        if ttfb_ms.is_none() {
            ttfb_ms = attempt.ttfb_ms;
        }
    }

    let check_started_at_epoch_ms = final_outcome
        .attempts
        .first()
        .map(|attempt| attempt.started_at_epoch_ms)
        .unwrap_or_else(now_epoch_ms);
    let check_ended_at_epoch_ms = final_outcome
        .attempts
        .last()
        .map(|attempt| attempt.ended_at_epoch_ms)
        .unwrap_or_else(now_epoch_ms);

    Ok(ChannelCheckOutcome {
        status: final_outcome.status.clone(),
        stream_url: final_outcome.stream_url,
        latency_ms: final_outcome.latency_ms,
        retries_used: final_outcome.retries_used,
        last_error_reason: final_outcome.last_error_reason.clone(),
        debug_log: ChannelDebugLog {
            channel_index: 0,
            channel_name: String::new(),
            channel_url: url.to_string(),
            check_started_at_epoch_ms,
            check_ended_at_epoch_ms,
            retry_attempts: final_outcome.retries_used,
            successful_attempt: final_outcome.successful_attempt,
            http_status_codes,
            redirect_chain,
            bytes_transferred,
            ttfb_ms,
            final_verdict: final_outcome.status,
            final_reason: final_outcome.last_error_reason,
            ffprobe_output: None,
            attempts: final_outcome.attempts,
        },
    })
}

/// Backwards-compatible status check API used by existing call sites.
pub async fn check_channel_status(
    client: &reqwest::Client,
    url: &str,
    timeout: f64,
    retries: u32,
    retry_backoff: RetryBackoff,
    extended_timeout: Option<f64>,
    user_agent: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<(String, Option<String>, Option<u64>, u32, Option<String>), AppError> {
    let outcome = check_channel_status_with_debug(
        client,
        url,
        timeout,
        retries,
        retry_backoff,
        extended_timeout,
        user_agent,
        cancel_token,
    )
    .await?;

    Ok((
        outcome.status,
        outcome.stream_url,
        outcome.latency_ms,
        outcome.retries_used,
        outcome.last_error_reason,
    ))
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
            assert_eq!(
                classify_non_ok_status(status, Some(900)),
                VerifyResult::Retry {
                    reason: Some(format!("HTTP {}", status)),
                }
            );
        }
    }

    #[test]
    fn test_geoblock_status_classification() {
        for status in [401u16, 403, 423, 426, 451] {
            assert_eq!(
                classify_non_ok_status(status, Some(321)),
                VerifyResult::Geoblocked {
                    latency_ms: Some(321),
                    reason: Some(format!("HTTP {}", status)),
                }
            );
        }
    }

    #[test]
    fn test_terminal_status_classification() {
        for status in [400u16, 404, 405, 410] {
            assert_eq!(
                classify_non_ok_status(status, Some(1234)),
                VerifyResult::Dead {
                    latency_ms: Some(1234),
                    reason: Some(format!("HTTP {}", status)),
                }
            );
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
