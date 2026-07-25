//! Xtream server tester command.
//!
//! Given a set of candidate Xtream servers sharing one account, tests API
//! reachability, discovers a few working live channels, probes them per
//! server (TTFB, codec/resolution via ffprobe, screenshots), and ranks the
//! servers by quality and latency.

use crate::engine::ffmpeg;
use crate::engine::remote_cache::{
    PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT, PLAYLIST_DOWNLOAD_USER_AGENT,
};
use crate::engine::stream_proxy::{fetch_with_hop_validation, SafeFetchError};
use crate::engine::xtream::{
    build_xtream_player_api_action_url, build_xtream_player_api_url, build_xtream_stream_url,
    extract_xtream_account_info, normalize_xtream_server, XTREAM_JSON_API_TIMEOUT,
    XTREAM_PLAYER_API_TIMEOUT,
};
use crate::error::AppError;
use crate::state::AppState;
use futures::stream::{self, StreamExt};
use rand::seq::SliceRandom;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;
use url::Url;

const SERVER_TEST_FFPROBE_TIMEOUT: Duration = Duration::from_secs(8);
const SERVER_TEST_STREAM_TIMEOUT: Duration = Duration::from_secs(10);
const SERVER_TEST_DISCOVERY_HTTP_TIMEOUT: Duration = Duration::from_secs(4);
const SERVER_TEST_MAX_CHANNEL_CANDIDATES: usize = 15;
const SERVER_TEST_TARGET_WORKING_CHANNELS: usize = 3;
const SERVER_TEST_MAX_SCREENSHOTS: usize = 2;
const SERVER_TEST_PROBE_CHANNELS: usize = 2;
const SERVER_TEST_MAX_CONCURRENT_SERVERS: usize = 4;

fn build_server_test_client(
    timeout: Duration,
    accept_invalid_certs: bool,
) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(timeout)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .user_agent(PLAYLIST_DOWNLOAD_USER_AGENT)
        .build()
}

async fn server_test_get(
    client: &reqwest::Client,
    url: &str,
) -> Result<reqwest::Response, SafeFetchError> {
    fetch_with_hop_validation(url, |target| client.get(target)).await
}

#[derive(Debug, Clone, Serialize)]
pub struct XtreamChannelProbe {
    pub stream_id: String,
    pub latency_ms: Option<u64>,
    pub resolved_url: Option<String>,
    pub codec: Option<String>,
    pub resolution: Option<String>,
    pub fps: Option<u32>,
    pub screenshot: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct XtreamServerTestResult {
    pub server: String,
    pub success: bool,
    pub api_latency_ms: Option<u64>,
    pub avg_stream_latency_ms: Option<u64>,
    pub resolved_host: Option<String>,
    pub channel_probes: Vec<XtreamChannelProbe>,
    pub error: Option<String>,
    pub account_status: Option<String>,
    pub max_connections: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct XtreamServerTestReport {
    pub results: Vec<XtreamServerTestResult>,
    pub same_cdn: bool,
    pub channels_probed: u32,
}

fn stream_probe_succeeded(probe: &XtreamChannelProbe) -> bool {
    probe.latency_ms.is_some()
        || probe.resolved_url.is_some()
        || probe.codec.is_some()
        || probe.resolution.is_some()
        || probe.fps.is_some()
        || probe.screenshot.is_some()
}

fn emit_server_test_progress(app: &tauri::AppHandle, message: &str) {
    let _ = app.emit("scan://server-test-progress", message.to_string());
}

async fn fetch_xtream_stream_ids(
    server: &Url,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
) -> Result<Vec<String>, AppError> {
    let streams_url =
        build_xtream_player_api_action_url(server, username, password, "get_live_streams");

    let client = build_server_test_client(XTREAM_JSON_API_TIMEOUT, accept_invalid_certs)
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {}", e)))?;

    // Retry once on body-read failures (chunked transfer can drop mid-stream)
    let mut last_error = None;
    for attempt in 0..2 {
        if attempt > 0 {
            log::info!("Retrying live streams fetch (attempt {})", attempt + 1);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        let response = match server_test_get(&client, streams_url.as_str()).await {
            Ok(resp) => resp,
            Err(error) => {
                last_error = Some(format!(
                    "Failed to fetch live streams: {}",
                    error.into_message()
                ));
                continue;
            }
        };

        if !response.status().is_success() {
            return Err(AppError::Other(format!(
                "Live streams API returned HTTP {}",
                response.status()
            )));
        }

        let bytes = match crate::engine::proxy_common::read_capped(
            response,
            crate::engine::proxy_common::MAX_JSON_API_BYTES,
        )
        .await
        {
            Ok(b) => b,
            Err(e) => {
                let detail = match e {
                    crate::engine::proxy_common::ReadCappedError::TooLarge => {
                        "response exceeded the size limit".to_string()
                    }
                    crate::engine::proxy_common::ReadCappedError::Read(error) => {
                        error.without_url().to_string()
                    }
                };
                last_error = Some(format!("Failed to read live streams response: {detail}"));
                continue;
            }
        };

        let streams: Vec<serde_json::Value> = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::Parse(format!("Failed to parse live streams JSON: {}", e)))?;

        // Partition into channels with icons (more likely real video) vs without
        let mut with_icon = Vec::new();
        let mut without_icon = Vec::new();
        for entry in &streams {
            let id = match entry.get("stream_id") {
                Some(serde_json::Value::Number(n)) => n.to_string(),
                Some(serde_json::Value::String(s)) => s.clone(),
                _ => continue,
            };
            let has_icon = entry
                .get("stream_icon")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            if has_icon {
                with_icon.push(id);
            } else {
                without_icon.push(id);
            }
        }
        // Shuffle each group, then prioritize channels with icons
        with_icon.shuffle(&mut rand::rng());
        without_icon.shuffle(&mut rand::rng());
        let mut ids = with_icon;
        ids.extend(without_icon);

        return Ok(ids);
    }

    Err(AppError::Other(last_error.unwrap_or_else(|| {
        "Failed to fetch live streams".to_string()
    })))
}

async fn discover_working_channels(
    app: &tauri::AppHandle,
    server: &Url,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
) -> Result<Vec<String>, AppError> {
    use crate::engine::checker::is_placeholder_url;

    emit_server_test_progress(app, "Fetching channel list...");
    let ids = fetch_xtream_stream_ids(server, username, password, accept_invalid_certs).await?;
    if ids.is_empty() {
        return Err(AppError::Other(
            "Server returned no live streams".to_string(),
        ));
    }

    // ids are pre-shuffled with icon-having channels first (more likely real video)

    let client = build_server_test_client(SERVER_TEST_DISCOVERY_HTTP_TIMEOUT, accept_invalid_certs)
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {}", e)))?;

    let mut working = Vec::new();
    let limit = ids.len().min(SERVER_TEST_MAX_CHANNEL_CANDIDATES);

    for (i, stream_id) in ids.iter().take(limit).enumerate() {
        emit_server_test_progress(
            app,
            &format!(
                "Discovering channels ({}/{})... found {}",
                i + 1,
                limit,
                working.len()
            ),
        );

        let stream_url = build_xtream_stream_url(server, username, password, stream_id);

        // HTTP-only check: verify the stream responds with 200 and isn't a placeholder.
        // No ffprobe here — quality probing happens per-server in Phase 3.
        match server_test_get(&client, &stream_url).await {
            Ok(resp) if resp.status().is_success() => {
                let final_url = resp.url().to_string();
                if is_placeholder_url(&final_url) {
                    log::debug!("Skipping placeholder channel {}: {}", stream_id, final_url);
                    continue;
                }
                working.push(stream_id.clone());
                if working.len() >= SERVER_TEST_TARGET_WORKING_CHANNELS {
                    break;
                }
            }
            _ => continue,
        }
    }

    if working.is_empty() {
        return Err(AppError::Other(
            "Could not find any working channels to probe".to_string(),
        ));
    }

    Ok(working)
}

fn read_file_as_base64_data_uri(path: &std::path::Path) -> Option<String> {
    use base64::Engine;
    let bytes = std::fs::read(path).ok()?;
    let mime = match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

async fn probe_server_channels(
    app: &tauri::AppHandle,
    server: &Url,
    username: &str,
    password: &str,
    stream_ids: &[String],
    screenshot_dir: &std::path::Path,
    accept_invalid_certs: bool,
) -> Vec<XtreamChannelProbe> {
    let cancel = CancellationToken::new();
    let client = build_server_test_client(SERVER_TEST_STREAM_TIMEOUT, accept_invalid_certs);

    let client = match client {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let server_host = server.host_str().unwrap_or("unknown");
    let mut probes = Vec::new();
    let mut screenshots_taken: usize = 0;

    for stream_id in stream_ids {
        let stream_url = build_xtream_stream_url(server, username, password, stream_id);

        // Measure TTFB + get resolved URL
        let started = Instant::now();
        let http_result = server_test_get(&client, &stream_url).await;

        let (latency_ms, resolved_url) = match http_result {
            Ok(resp) if resp.status().is_success() => {
                let ttfb = started.elapsed().as_millis() as u64;
                let final_url = resp.url().to_string();
                (Some(ttfb), Some(final_url))
            }
            Ok(_) | Err(_) => (None, None),
        };

        // Probe the already validated final hop so ffmpeg cannot independently
        // follow the original URL into a private redirect target.
        let probe_url = resolved_url.as_deref();
        let (codec, resolution, fps) = if let Some(probe_url) = probe_url {
            match ffmpeg::collect_probe_snapshot_with_timeout(
                app,
                probe_url,
                None,
                &cancel,
                Some(SERVER_TEST_FFPROBE_TIMEOUT),
            )
            .await
            {
                Ok(snapshot) => {
                    if let Some(video) = snapshot.video_info {
                        (Some(video.codec), Some(video.resolution), video.fps)
                    } else {
                        (None, None, None)
                    }
                }
                Err(_) => (None, None, None),
            }
        } else {
            (None, None, None)
        };

        // Capture screenshot (limited to avoid excessive time)
        let screenshot = if let Some(probe_url) =
            probe_url.filter(|_| screenshots_taken < SERVER_TEST_MAX_SCREENSHOTS)
        {
            let file_name = format!("{}-{}", server_host, stream_id);
            match ffmpeg::capture_screenshot(
                app,
                probe_url,
                None,
                &screenshot_dir.to_string_lossy(),
                &file_name,
                PLAYLIST_DOWNLOAD_USER_AGENT,
                crate::models::settings::ScreenshotFormat::Webp,
                &cancel,
            )
            .await
            {
                Ok(path) => {
                    screenshots_taken += 1;
                    read_file_as_base64_data_uri(std::path::Path::new(&path))
                }
                Err(e) => {
                    log::debug!(
                        "Screenshot failed for {} on {}: {}",
                        stream_id,
                        server_host,
                        e
                    );
                    None
                }
            }
        } else {
            None
        };

        probes.push(XtreamChannelProbe {
            stream_id: stream_id.clone(),
            latency_ms,
            resolved_url,
            codec,
            resolution,
            fps,
            screenshot,
        });
    }

    probes
}

async fn test_single_server_api(
    server: &Url,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
) -> (Option<u64>, Option<String>, Option<u32>, Option<String>) {
    let api_url = build_xtream_player_api_url(server, username, password);
    let client = build_server_test_client(XTREAM_PLAYER_API_TIMEOUT, accept_invalid_certs);

    let client = match client {
        Ok(c) => c,
        Err(e) => return (None, None, None, Some(e.to_string())),
    };

    let started = Instant::now();
    let response = server_test_get(&client, api_url.as_str()).await;

    match response {
        Ok(resp) => {
            let latency = started.elapsed().as_millis() as u64;
            if !resp.status().is_success() {
                return (
                    Some(latency),
                    None,
                    None,
                    Some(format!("HTTP {}", resp.status())),
                );
            }
            let bytes = crate::engine::proxy_common::read_capped(
                resp,
                crate::engine::proxy_common::MAX_JSON_API_BYTES,
            )
            .await
            .ok();
            let (status, max_conn) = bytes
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|payload| {
                    extract_xtream_account_info(&payload)
                        .map(|info| (info.status.clone(), info.max_connections))
                })
                .unwrap_or((None, None));
            (Some(latency), status, max_conn, None)
        }
        Err(error) => (None, None, None, Some(error.into_message())),
    }
}

fn extract_host_from_url(url_str: &str) -> Option<String> {
    Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

fn most_common_resolved_host(probes: &[XtreamChannelProbe]) -> Option<String> {
    let mut counts = HashMap::<String, usize>::new();
    for probe in probes {
        if let Some(ref resolved) = probe.resolved_url {
            if let Some(host) = extract_host_from_url(resolved) {
                *counts.entry(host).or_insert(0) += 1;
            }
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(host, _)| host)
}

fn detect_same_cdn(results: &[XtreamServerTestResult]) -> bool {
    let mut all_hosts = HashSet::new();
    for result in results {
        for probe in &result.channel_probes {
            if let Some(ref resolved) = probe.resolved_url {
                if let Some(host) = extract_host_from_url(resolved) {
                    all_hosts.insert(host);
                }
            }
        }
    }
    all_hosts.len() <= 1
}

#[tauri::command]
pub async fn test_xtream_servers(
    app: tauri::AppHandle,
    servers: Vec<String>,
    username: String,
    password: String,
) -> Result<XtreamServerTestReport, AppError> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::Parse("Username cannot be empty".to_string()));
    }
    let password = password.trim().to_string();
    if password.is_empty() {
        return Err(AppError::Parse("Password cannot be empty".to_string()));
    }
    if servers.is_empty() {
        return Err(AppError::Parse("No servers provided".to_string()));
    }

    let accept_invalid_certs = app
        .state::<Arc<AppState>>()
        .settings
        .lock()
        .await
        .accept_invalid_certs;
    test_xtream_servers_inner(&app, servers, username, password, accept_invalid_certs).await
}

async fn test_xtream_servers_inner(
    app: &tauri::AppHandle,
    servers: Vec<String>,
    username: String,
    password: String,
    accept_invalid_certs: bool,
) -> Result<XtreamServerTestReport, AppError> {
    // Normalize all servers
    let normalized: Vec<(String, Url)> = servers
        .iter()
        .map(|s| {
            let url = normalize_xtream_server(s)?;
            Ok((s.clone(), url))
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    // Phase 1: API test (parallel)
    emit_server_test_progress(
        app,
        &format!("Testing API on {} servers...", normalized.len()),
    );

    let api_results = stream::iter(normalized.into_iter().map(|(raw, url)| {
        let u = username.clone();
        let p = password.clone();
        async move {
            let (api_latency, status, max_conn, error) =
                test_single_server_api(&url, &u, &p, accept_invalid_certs).await;
            (raw, url, api_latency, status, max_conn, error)
        }
    }))
    .buffered(SERVER_TEST_MAX_CONCURRENT_SERVERS)
    .collect::<Vec<_>>()
    .await;

    let successful_count = api_results
        .iter()
        .filter(|(_, _, _, _, _, error)| error.is_none())
        .count();

    emit_server_test_progress(
        app,
        &format!(
            "{} of {} servers responded",
            successful_count,
            api_results.len()
        ),
    );

    // Phase 2: Discover working channels — try each successful server until one works.
    // Some servers pass the basic API check but fail on the larger get_live_streams request.
    let successful_servers: Vec<Url> = api_results
        .iter()
        .filter(|(_, _, _, _, _, error)| error.is_none())
        .map(|(_, url, ..)| url.clone())
        .collect();

    if successful_servers.is_empty() {
        let results: Vec<XtreamServerTestResult> = api_results
            .into_iter()
            .map(
                |(raw, _, api_latency, status, max_conn, error)| XtreamServerTestResult {
                    server: raw,
                    success: false,
                    api_latency_ms: api_latency,
                    avg_stream_latency_ms: None,
                    resolved_host: None,
                    channel_probes: Vec::new(),
                    error,
                    account_status: status,
                    max_connections: max_conn,
                },
            )
            .collect();

        return Ok(XtreamServerTestReport {
            results,
            same_cdn: false,
            channels_probed: 0,
        });
    }

    let mut working_channels = None;
    for server in &successful_servers {
        match discover_working_channels(app, server, &username, &password, accept_invalid_certs)
            .await
        {
            Ok(channels) => {
                working_channels = Some(channels);
                break;
            }
            Err(e) => {
                log::warn!(
                    "Channel discovery failed on {}: {}, trying next server",
                    server,
                    e
                );
            }
        }
    }

    let working_channels = match working_channels {
        Some(channels) => channels,
        None => {
            return Err(AppError::Other(
                "Could not discover working channels from any server".to_string(),
            ));
        }
    };
    let channels_probed = working_channels.len() as u32;

    // Create temp dir for screenshots
    let screenshot_dir = std::env::temp_dir().join(format!(
        "iptv-server-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let _ = std::fs::create_dir_all(&screenshot_dir);

    // Phase 3: Probe all servers (parallel across servers, sequential per server)
    emit_server_test_progress(
        app,
        &format!(
            "Probing {} channels across {} servers...",
            channels_probed, successful_count
        ),
    );

    let mut results = stream::iter(api_results.into_iter().map(
        |(raw, url, api_latency, status, max_conn, api_error)| {
            let app = app.clone();
            let u = username.clone();
            let p = password.clone();
            let channels: Vec<String> = working_channels
                .iter()
                .take(SERVER_TEST_PROBE_CHANNELS)
                .cloned()
                .collect();
            let ss_dir = screenshot_dir.clone();
            async move {
                if api_error.is_some() {
                    return XtreamServerTestResult {
                        server: raw,
                        success: false,
                        api_latency_ms: api_latency,
                        avg_stream_latency_ms: None,
                        resolved_host: None,
                        channel_probes: Vec::new(),
                        error: api_error,
                        account_status: status,
                        max_connections: max_conn,
                    };
                }

                let probes = probe_server_channels(
                    &app,
                    &url,
                    &u,
                    &p,
                    &channels,
                    &ss_dir,
                    accept_invalid_certs,
                )
                .await;
                let latencies: Vec<u64> = probes.iter().filter_map(|p| p.latency_ms).collect();
                let avg_latency = if latencies.is_empty() {
                    None
                } else {
                    Some(latencies.iter().sum::<u64>() / latencies.len() as u64)
                };
                let resolved_host = most_common_resolved_host(&probes);
                let stream_probe_succeeded = probes.iter().any(stream_probe_succeeded);

                XtreamServerTestResult {
                    server: raw,
                    success: stream_probe_succeeded,
                    api_latency_ms: api_latency,
                    avg_stream_latency_ms: avg_latency,
                    resolved_host,
                    channel_probes: probes,
                    error: (!stream_probe_succeeded).then(|| {
                        "The API responded, but none of the sampled streams could be reached"
                            .to_string()
                    }),
                    account_status: status,
                    max_connections: max_conn,
                }
            }
        },
    ))
    .buffered(SERVER_TEST_MAX_CONCURRENT_SERVERS)
    .collect::<Vec<_>>()
    .await;

    // Phase 4: Analyze
    let same_cdn = detect_same_cdn(&results);

    // Sort: successful first, then by best resolution (quality), then by latency as tiebreaker.
    // Quality is determined by the max resolution height across probes.
    fn max_probe_height(result: &XtreamServerTestResult) -> u32 {
        result
            .channel_probes
            .iter()
            .filter_map(|p| {
                p.resolution.as_ref().and_then(|r| {
                    // Parse "1080p" -> 1080, "720p" -> 720, "WxH" -> H
                    r.trim_end_matches('p')
                        .parse::<u32>()
                        .ok()
                        .or_else(|| r.split('x').next_back()?.parse::<u32>().ok())
                })
            })
            .max()
            .unwrap_or(0)
    }

    results.sort_by(|a, b| {
        b.success.cmp(&a.success).then_with(|| {
            let a_quality = max_probe_height(a);
            let b_quality = max_probe_height(b);
            b_quality.cmp(&a_quality).then_with(|| {
                let a_stream = a.avg_stream_latency_ms.unwrap_or(u64::MAX);
                let b_stream = b.avg_stream_latency_ms.unwrap_or(u64::MAX);
                a_stream.cmp(&b_stream).then_with(|| {
                    let a_api = a.api_latency_ms.unwrap_or(u64::MAX);
                    let b_api = b.api_latency_ms.unwrap_or(u64::MAX);
                    a_api.cmp(&b_api)
                })
            })
        })
    });

    // Cleanup temp screenshot dir
    let _ = std::fs::remove_dir_all(&screenshot_dir);

    Ok(XtreamServerTestReport {
        results,
        same_cdn,
        channels_probed,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_server_test_client, server_test_get, stream_probe_succeeded, XtreamChannelProbe,
        SERVER_TEST_STREAM_TIMEOUT,
    };

    fn empty_probe() -> XtreamChannelProbe {
        XtreamChannelProbe {
            stream_id: "1".to_string(),
            latency_ms: None,
            resolved_url: None,
            codec: None,
            resolution: None,
            fps: None,
            screenshot: None,
        }
    }

    #[test]
    fn empty_stream_probe_is_not_successful() {
        assert!(!stream_probe_succeeded(&empty_probe()));
    }

    #[test]
    fn any_stream_probe_evidence_is_successful() {
        let mut probe = empty_probe();
        probe.codec = Some("h264".to_string());
        assert!(stream_probe_succeeded(&probe));
    }

    #[tokio::test]
    async fn server_test_rejects_private_network_targets() {
        let client = build_server_test_client(SERVER_TEST_STREAM_TIMEOUT, false)
            .expect("client should build");
        let url =
            url::Url::parse("http://169.254.169.254/latest/meta-data/").expect("URL should parse");

        let error = server_test_get(&client, url.as_str())
            .await
            .expect_err("metadata endpoint should be blocked");

        assert!(error.into_message().contains("private or local"));
    }
}
