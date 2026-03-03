use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use url::Url;

use crate::error::AppError;

fn is_valid_proxy_entry(candidate: &str) -> bool {
    let parsed = match Url::parse(candidate) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };

    let scheme_ok = matches!(
        parsed.scheme(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    );

    scheme_ok && parsed.host_str().is_some() && parsed.port().is_some()
}

/// Load proxies from a file. Supports plain text and JSON formats.
pub fn load_proxy_list(proxy_file: &str) -> Result<Vec<String>, AppError> {
    log::info!("Loading proxies from: {}", proxy_file);
    let content = std::fs::read_to_string(proxy_file)
        .map_err(|error| AppError::Other(format!("Failed to read proxy file: {}", error)))?;
    let content = content.trim();

    if content.is_empty() {
        return Err(AppError::Other("Proxy file is empty".to_string()));
    }

    let mut candidates = Vec::new();

    // Try JSON format first
    if content.starts_with('[') || content.starts_with('{') {
        let json_data = serde_json::from_str::<serde_json::Value>(content)
            .map_err(|error| AppError::Other(format!("Malformed proxy JSON: {}", error)))?;
        let arr = json_data.as_array().ok_or_else(|| {
            AppError::Other("Malformed proxy JSON: expected an array of proxy entries".to_string())
        })?;

        for item in arr {
            if let Some(obj) = item.as_object() {
                let ip = obj.get("ip").and_then(|v| v.as_str());
                let port = obj.get("port").and_then(|v| {
                    v.as_u64()
                        .map(|n| n.to_string())
                        .or_else(|| v.as_str().map(|s| s.to_string()))
                });

                if let (Some(ip), Some(port)) = (ip, port) {
                    if let Some(protocols) = obj.get("protocols").and_then(|v| v.as_array()) {
                        for proto in protocols {
                            if let Some(p) = proto.as_str() {
                                candidates.push(format!("{}://{}:{}", p, ip, port));
                            }
                        }
                    } else if let Some(proto) = obj.get("protocol").and_then(|v| v.as_str()) {
                        candidates.push(format!("{}://{}:{}", proto, ip, port));
                    } else {
                        candidates.push(format!("http://{}:{}", ip, port));
                    }
                }
            } else if let Some(s) = item.as_str() {
                candidates.push(s.to_string());
            }
        }
    } else {
        // Plain text format
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if line.contains("://") {
                candidates.push(line.to_string());
            } else {
                candidates.push(format!("http://{}", line));
            }
        }
    }

    let mut proxies = Vec::new();
    let mut invalid_entries = Vec::new();
    for candidate in candidates {
        if is_valid_proxy_entry(&candidate) {
            proxies.push(candidate);
        } else {
            invalid_entries.push(candidate);
        }
    }

    if proxies.is_empty() {
        let details = if invalid_entries.is_empty() {
            "No proxy entries found".to_string()
        } else {
            format!(
                "No valid proxy entries found. Invalid entries: {}",
                invalid_entries.join(", ")
            )
        };
        return Err(AppError::Other(details));
    }

    if !invalid_entries.is_empty() {
        log::warn!(
            "Ignoring {} invalid proxy entries while loading {}",
            invalid_entries.len(),
            proxy_file
        );
    }

    Ok(proxies)
}

/// Test stream access through a specific proxy.
pub async fn test_with_proxy(url: &str, proxy: &str, timeout: f64, retries: u32) -> bool {
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
            || stream_extensions
                .iter()
                .any(|ext| stream_path.ends_with(ext));

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
pub async fn confirm_geoblock(url: &str, proxy_list: &[String], timeout: f64) -> String {
    use rand::seq::IndexedRandom;

    // Collect sample before any await to avoid Send issues with rng
    let sample: Vec<String> = {
        let mut rng = rand::rng();
        let sample_count = std::cmp::min(3, proxy_list.len());
        proxy_list.sample(&mut rng, sample_count).cloned().collect()
    };

    for proxy in &sample {
        log::debug!("Testing geoblock via proxy: {}", proxy);
        if test_with_proxy(url, proxy, timeout, 3).await {
            return "Geoblocked (Confirmed)".to_string();
        }
    }

    "Geoblocked (Unconfirmed)".to_string()
}

#[cfg(test)]
mod tests {
    use super::load_proxy_list;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unique}.txt"))
    }

    #[test]
    fn load_proxy_list_rejects_malformed_json() {
        let path = unique_temp_path("iptv-proxy-malformed");
        std::fs::write(&path, "{not-json").expect("fixture file should be writable");

        let error = load_proxy_list(path.to_str().expect("path should be utf-8"))
            .expect_err("malformed json should be rejected");
        assert!(error.to_string().contains("Malformed proxy JSON"));

        std::fs::remove_file(path).expect("fixture file should be removable");
    }

    #[test]
    fn load_proxy_list_rejects_invalid_entries_only() {
        let path = unique_temp_path("iptv-proxy-invalid");
        std::fs::write(&path, "not-a-proxy\nstill-bad").expect("fixture file should be writable");

        let error = load_proxy_list(path.to_str().expect("path should be utf-8"))
            .expect_err("invalid proxy list should be rejected");
        assert!(error.to_string().contains("No valid proxy entries found"));

        std::fs::remove_file(path).expect("fixture file should be removable");
    }

    #[test]
    fn load_proxy_list_accepts_mixed_plain_text_with_comments() {
        let path = unique_temp_path("iptv-proxy-valid");
        std::fs::write(
            &path,
            "# comment\n127.0.0.1:8080\nhttp://localhost:3128\nnot-a-proxy",
        )
        .expect("fixture file should be writable");

        let proxies = load_proxy_list(path.to_str().expect("path should be utf-8"))
            .expect("proxy list should load");
        assert_eq!(proxies.len(), 2);
        assert!(proxies.iter().any(|p| p == "http://127.0.0.1:8080"));
        assert!(proxies.iter().any(|p| p == "http://localhost:3128"));

        std::fs::remove_file(path).expect("fixture file should be removable");
    }
}
