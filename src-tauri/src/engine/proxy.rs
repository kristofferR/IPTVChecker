use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use url::Url;

use crate::error::AppError;

/// Load proxies from a file. Supports plain text and JSON formats.
pub fn load_proxy_list(proxy_file: &str) -> Result<Vec<String>, AppError> {
    let content = std::fs::read_to_string(proxy_file).map_err(|_| {
        AppError::FileNotFound(format!("Proxy file not found: {}", proxy_file))
    })?;
    let content = content.trim();

    // Try JSON format first
    if let Ok(json_data) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(arr) = json_data.as_array() {
            let mut proxies = Vec::new();
            for item in arr {
                if let Some(obj) = item.as_object() {
                    let ip = obj.get("ip").and_then(|v| v.as_str());
                    let port = obj.get("port").and_then(|v| {
                        v.as_u64().map(|n| n.to_string()).or_else(|| v.as_str().map(|s| s.to_string()))
                    });

                    if let (Some(ip), Some(port)) = (ip, port) {
                        if let Some(protocols) = obj.get("protocols").and_then(|v| v.as_array()) {
                            for proto in protocols {
                                if let Some(p) = proto.as_str() {
                                    proxies.push(format!("{}://{}:{}", p, ip, port));
                                }
                            }
                        } else if let Some(proto) = obj.get("protocol").and_then(|v| v.as_str()) {
                            proxies.push(format!("{}://{}:{}", proto, ip, port));
                        } else {
                            proxies.push(format!("http://{}:{}", ip, port));
                        }
                    }
                } else if let Some(s) = item.as_str() {
                    proxies.push(s.to_string());
                }
            }
            return Ok(proxies);
        }
    }

    // Plain text format
    let mut proxies = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains("://") {
            proxies.push(line.to_string());
        } else {
            proxies.push(format!("http://{}", line));
        }
    }

    Ok(proxies)
}

/// Test stream access through a specific proxy.
pub async fn test_with_proxy(
    url: &str,
    proxy: &str,
    timeout: f64,
    retries: u32,
) -> bool {
    let proxy_url = match reqwest::Proxy::all(proxy) {
        Ok(p) => p,
        Err(_) => return false,
    };

    let client = match reqwest::Client::builder()
        .proxy(proxy_url)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs_f64(timeout))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("VLC/3.0.14 LibVLC/3.0.14"),
    );

    let stream_extensions = [".ts", ".m2ts", ".m4s", ".mp4", ".aac", ".m3u8"];

    for attempt in 0..retries.max(1) {
        let resp = match client.get(url).headers(headers.clone()).send().await {
            Ok(r) => r,
            Err(_) => {
                if attempt + 1 < retries.max(1) {
                    tokio::time::sleep(Duration::from_secs_f64(0.5 * (attempt as f64 + 1.0))).await;
                }
                continue;
            }
        };

        if resp.status() != 200 {
            continue;
        }

        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        let stream_path = Url::parse(resp.url().as_str())
            .map(|u| u.path().to_lowercase())
            .unwrap_or_default();

        let is_stream = content_type.starts_with("video/")
            || content_type.starts_with("audio/")
            || content_type.contains("application/vnd.apple.mpegurl")
            || content_type.contains("application/x-mpegurl")
            || content_type.contains("application/octet-stream")
            || content_type.contains("application/mp4")
            || stream_extensions.iter().any(|ext| stream_path.ends_with(ext));

        if is_stream {
            // Read 500KB to verify
            use futures::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut read = 0u64;
            while let Some(Ok(chunk)) = stream.next().await {
                read += chunk.len() as u64;
                if read >= 1024 * 500 {
                    return true;
                }
            }
        }
    }

    false
}

/// Confirm geoblock by testing with up to 3 random proxies.
pub async fn confirm_geoblock(
    url: &str,
    proxy_list: &[String],
    timeout: f64,
) -> String {
    use rand::seq::SliceRandom;

    // Collect sample before any await to avoid Send issues with thread_rng
    let sample: Vec<String> = {
        let mut rng = rand::thread_rng();
        let sample_count = std::cmp::min(3, proxy_list.len());
        proxy_list
            .choose_multiple(&mut rng, sample_count)
            .cloned()
            .collect()
    };

    for proxy in &sample {
        if test_with_proxy(url, proxy, timeout, 3).await {
            return "Geoblocked (Confirmed)".to_string();
        }
    }

    "Geoblocked (Unconfirmed)".to_string()
}
