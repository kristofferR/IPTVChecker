use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{HeaderValue, CONTENT_TYPE, RANGE, USER_AGENT};
use std::sync::Arc;
use tauri::Manager;
use url::Url;

use crate::state::AppState;

const PROXY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Base64url-encode an original stream URL for the proxy scheme.
pub fn encode_proxy_url(original: &str) -> String {
    URL_SAFE_NO_PAD.encode(original.as_bytes())
}

/// Decode a proxy path back to the original stream URL.
pub fn decode_proxy_url(encoded: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    String::from_utf8(bytes).ok()
}

fn is_m3u8_response(content_type: &str, url: &str) -> bool {
    let ct = content_type.to_lowercase();
    if ct.contains("application/vnd.apple.mpegurl") || ct.contains("application/x-mpegurl") {
        return true;
    }
    if let Ok(parsed) = Url::parse(url) {
        let path = parsed.path().to_lowercase();
        if path.ends_with(".m3u8") {
            return true;
        }
    }
    false
}

/// Rewrite URIs in an HLS manifest so they go through the stream proxy.
///
/// Handles:
/// - Bare URI lines (segment and playlist references)
/// - URI="..." attributes in #EXT-X-MAP, #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-SESSION-KEY
fn rewrite_m3u8_manifest(body: &str, base_url: &str) -> String {
    let base = match Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return body.to_string(),
    };

    let mut output = String::with_capacity(body.len());
    for line in body.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            output.push('\n');
            continue;
        }

        // Rewrite URI="..." attributes in HLS tags
        if trimmed.starts_with('#') {
            let upper = trimmed.to_ascii_uppercase();
            if (upper.starts_with("#EXT-X-MAP:")
                || upper.starts_with("#EXT-X-KEY:")
                || upper.starts_with("#EXT-X-MEDIA:")
                || upper.starts_with("#EXT-X-SESSION-KEY:"))
                && trimmed.contains("URI=")
            {
                output.push_str(&rewrite_tag_uri(trimmed, &base));
            } else {
                output.push_str(line);
            }
            output.push('\n');
            continue;
        }

        // Non-comment, non-empty line: a URI reference
        if let Ok(resolved) = base.join(trimmed) {
            let encoded = encode_proxy_url(resolved.as_str());
            output.push_str(&format!("streamproxy://localhost/{encoded}"));
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }

    output
}

/// Rewrite the URI="..." value inside an HLS tag line.
fn rewrite_tag_uri(line: &str, base: &Url) -> String {
    // Find URI=" (case-insensitive)
    let upper = line.to_ascii_uppercase();
    let Some(uri_pos) = upper.find("URI=") else {
        return line.to_string();
    };

    let after_uri_eq = &line[uri_pos + 4..];

    // Determine quote character (or unquoted)
    let (quote, uri_start, uri_end) = if after_uri_eq.starts_with('"') {
        let inner = &after_uri_eq[1..];
        let end = inner.find('"').unwrap_or(inner.len());
        (Some('"'), 1, 1 + end)
    } else if after_uri_eq.starts_with('\'') {
        let inner = &after_uri_eq[1..];
        let end = inner.find('\'').unwrap_or(inner.len());
        (Some('\''), 1, 1 + end)
    } else {
        let end = after_uri_eq
            .find(|c: char| c == ',' || c.is_whitespace())
            .unwrap_or(after_uri_eq.len());
        (None, 0, end)
    };

    let original_uri = &after_uri_eq[uri_start..uri_end];
    let resolved = match base.join(original_uri) {
        Ok(u) => u.to_string(),
        Err(_) => return line.to_string(),
    };
    let encoded = encode_proxy_url(&resolved);
    let proxy_uri = format!("streamproxy://localhost/{encoded}");

    let mut result = String::with_capacity(line.len() + proxy_uri.len());
    result.push_str(&line[..uri_pos + 4]); // everything up to and including "URI="
    if let Some(q) = quote {
        result.push(q);
        result.push_str(&proxy_uri);
        result.push(q);
    } else {
        result.push_str(&proxy_uri);
    }
    // Append the remainder after the original URI value
    let remainder_offset = uri_pos + 4 + uri_end + if quote.is_some() { 1 } else { 0 };
    if remainder_offset < line.len() {
        result.push_str(&line[remainder_offset..]);
    }
    result
}

/// Redact query parameters and userinfo from a URL for safe logging.
fn redact_url(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut parsed) => {
            if parsed.query().is_some() {
                parsed.set_query(Some("***"));
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                let _ = parsed.set_username("***");
                let _ = parsed.set_password(None);
            }
            parsed.to_string()
        }
        Err(_) => "invalid-url".to_string(),
    }
}

/// Reject URLs targeting localhost, private networks, or metadata endpoints.
fn is_safe_upstream_url(url: &str) -> bool {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };

    let scheme = parsed.scheme().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return false;
    }

    let host = match parsed.host_str() {
        Some(h) => h.to_lowercase(),
        None => return false,
    };

    // Block localhost and loopback
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" || host == "0.0.0.0" {
        return false;
    }

    // Block link-local and cloud metadata
    if host == "169.254.169.254" || host.starts_with("169.254.") {
        return false;
    }

    // Block private RFC1918 ranges
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        if ip.is_loopback() || ip.is_unspecified() {
            return false;
        }
        let octets = ip.octets();
        // 10.0.0.0/8
        if octets[0] == 10 { return false; }
        // 172.16.0.0/12
        if octets[0] == 172 && (16..=31).contains(&octets[1]) { return false; }
        // 192.168.0.0/16
        if octets[0] == 192 && octets[1] == 168 { return false; }
    }

    true
}

/// Handle an incoming proxy request: decode the URL, fetch upstream, return response.
pub async fn handle_proxy_request(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();
    let encoded = path.strip_prefix('/').unwrap_or(path);

    let original_url = match decode_proxy_url(encoded) {
        Some(url) => url,
        None => {
            log::warn!("Stream proxy: failed to decode URL from path: {}", path);
            return error_response(400, "Invalid proxy URL encoding");
        }
    };

    if !is_safe_upstream_url(&original_url) {
        log::warn!("Stream proxy: blocked request to private/local target");
        return error_response(403, "Target URL not allowed");
    }

    log::debug!("Stream proxy: fetching {}", redact_url(&original_url));

    let state = app.state::<Arc<AppState>>();
    let (user_agent, accept_invalid_certs) = {
        let settings = state.settings.lock().await;
        (
            settings.user_agent.clone(),
            settings.accept_invalid_certs,
        )
    };

    let client = get_or_create_proxy_client(state.inner(), accept_invalid_certs).await;

    let mut req_builder = client
        .get(&original_url)
        .header(
            USER_AGENT,
            HeaderValue::from_str(&user_agent)
                .unwrap_or_else(|_| HeaderValue::from_static("TiviMate/5.1.6 (Android 12)")),
        )
        .timeout(PROXY_TIMEOUT);

    // Forward Range header for partial content requests
    if let Some(range) = request.headers().get(RANGE) {
        req_builder = req_builder.header(RANGE, range.clone());
    }

    let upstream_response = match req_builder.send().await {
        Ok(resp) => resp,
        Err(err) => {
            log::warn!("Stream proxy: upstream request failed for {}: {}", redact_url(&original_url), err);
            if err.is_timeout() {
                return error_response(504, "Upstream request timed out");
            }
            return error_response(502, "Upstream request failed");
        }
    };

    let status = upstream_response.status().as_u16();
    let response_headers = upstream_response.headers().clone();
    let final_url = upstream_response.url().to_string();

    let content_type = response_headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let body = match upstream_response.bytes().await {
        Ok(bytes) => bytes.to_vec(),
        Err(err) => {
            log::warn!("Stream proxy: failed to read upstream body for {}: {}", redact_url(&original_url), err);
            return error_response(502, "Failed to read upstream response");
        }
    };

    // Rewrite M3U8 manifests so internal URLs also go through the proxy
    let body = if is_m3u8_response(&content_type, &final_url) {
        let manifest = String::from_utf8_lossy(&body);
        rewrite_m3u8_manifest(&manifest, &final_url).into_bytes()
    } else {
        body
    };

    let mut builder = tauri::http::Response::builder().status(status);

    // Forward important upstream headers
    let passthrough_headers = [
        "content-type",
        "content-range",
        "accept-ranges",
        "cache-control",
    ];
    for name in passthrough_headers {
        if let Some(value) = response_headers.get(name) {
            builder = builder.header(name, value.clone());
        }
    }

    // CORS headers so HLS.js XHR succeeds
    builder = builder
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-headers", "range")
        .header("access-control-expose-headers", "content-range, content-length");

    builder.body(body).unwrap_or_else(|_| error_response(500, "Failed to build response"))
}

fn error_response(status: u16, message: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .header("access-control-allow-origin", "*")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(Vec::new())
                .unwrap()
        })
}

async fn get_or_create_proxy_client(
    state: &AppState,
    accept_invalid_certs: bool,
) -> reqwest::Client {
    let mut guard = state.proxy_client.lock().await;
    if let Some((client, cached_accept_invalid)) = guard.as_ref() {
        if *cached_accept_invalid == accept_invalid_certs {
            return client.clone();
        }
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(accept_invalid_certs)
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .pool_max_idle_per_host(0)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    *guard = Some((client.clone(), accept_invalid_certs));
    client
}

// ---------------------------------------------------------------------------
// Localhost streaming proxy for MPEG-TS and other infinite-body streams.
// The Tauri URI scheme proxy buffers the full response, which fails for live
// streams. This lightweight TCP server streams bytes through without buffering.
// ---------------------------------------------------------------------------

/// Start a localhost HTTP proxy that streams upstream responses.
/// Returns the port the server is listening on.
pub async fn start_streaming_proxy() -> std::io::Result<u16> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    log::info!("[StreamProxy] Localhost streaming proxy started on port {}", port);

    tokio::spawn(async move {
        loop {
            let (mut socket, _addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(err) => {
                    log::warn!("[StreamProxy] Accept error: {}", err);
                    continue;
                }
            };

            tokio::spawn(async move {
                // Read the HTTP request line to extract the URL
                let mut buf = vec![0u8; 8192];
                let n = match socket.read(&mut buf).await {
                    Ok(0) => return,
                    Ok(n) => n,
                    Err(_) => return,
                };
                let request_str = String::from_utf8_lossy(&buf[..n]);

                // Parse GET /stream?url=ENCODED_URL HTTP/1.1
                let url = match parse_stream_request(&request_str) {
                    Some(url) => url,
                    None => {
                        let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                        let _ = socket.write_all(response.as_bytes()).await;
                        return;
                    }
                };

                log::info!("[StreamProxy] Streaming {}", redact_url(&url));

                // Fetch upstream with streaming body
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(10))
                    .pool_max_idle_per_host(0)
                    .build()
                    .unwrap_or_default();

                let response = match client
                    .get(&url)
                    .header(USER_AGENT, "TiviMate/5.1.6 (Android 12)")
                    .send()
                    .await
                {
                    Ok(resp) => resp,
                    Err(err) => {
                        log::warn!("[StreamProxy] Upstream request failed for {}: {}", redact_url(&url), err);
                        let body = format!("Upstream request failed: {}", err);
                        let response = format!(
                            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                        return;
                    }
                };

                let status = response.status().as_u16();
                let content_type = response
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("application/octet-stream")
                    .to_string();

                // Write HTTP response headers
                let header = format!(
                    "HTTP/1.1 {} OK\r\n\
                     Content-Type: {}\r\n\
                     Access-Control-Allow-Origin: *\r\n\
                     Transfer-Encoding: chunked\r\n\
                     Cache-Control: no-cache\r\n\
                     Connection: close\r\n\
                     \r\n",
                    status, content_type
                );
                if socket.write_all(header.as_bytes()).await.is_err() {
                    return;
                }

                // Stream body chunks
                use futures::StreamExt;
                let mut stream = response.bytes_stream();
                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(chunk) => {
                            // Write chunked transfer encoding
                            let size_line = format!("{:x}\r\n", chunk.len());
                            if socket.write_all(size_line.as_bytes()).await.is_err() {
                                break;
                            }
                            if socket.write_all(&chunk).await.is_err() {
                                break;
                            }
                            if socket.write_all(b"\r\n").await.is_err() {
                                break;
                            }
                        }
                        Err(err) => {
                            log::debug!("[StreamProxy] Stream read error for {}: {}", redact_url(&url), err);
                            break;
                        }
                    }
                }

                // Send final chunk
                let _ = socket.write_all(b"0\r\n\r\n").await;
                log::debug!("[StreamProxy] Stream ended for {}", redact_url(&url));
            });
        }
    });

    Ok(port)
}

fn parse_stream_request(request: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    // GET /stream?url=ENCODED HTTP/1.1
    let path = first_line.split_whitespace().nth(1)?;
    let encoded = path.strip_prefix("/stream?url=")?;
    // Simple percent-decoding
    let mut decoded = String::new();
    let mut chars = encoded.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h = chars.next()?;
            let l = chars.next()?;
            let hex = format!("{}{}", h as char, l as char);
            let byte = u8::from_str_radix(&hex, 16).ok()?;
            decoded.push(byte as char);
        } else if b == b'+' {
            decoded.push(' ');
        } else {
            decoded.push(b as char);
        }
    }
    Some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let urls = [
            "http://example.com/live/stream.m3u8",
            "https://iptv.server:8080/live/channel?token=abc123&key=xyz",
            "http://192.168.1.1:25461/live/user/pass/12345.ts",
            "http://example.com/path with spaces/stream.m3u8",
            "https://cdn.example.com/hls/4K/master.m3u8#t=0",
        ];
        for url in urls {
            let encoded = encode_proxy_url(url);
            let decoded = decode_proxy_url(&encoded);
            assert_eq!(decoded.as_deref(), Some(url), "roundtrip failed for: {url}");
        }
    }

    #[test]
    fn decode_invalid_base64_returns_none() {
        assert!(decode_proxy_url("!!!invalid!!!").is_none());
    }

    #[test]
    fn rewrite_m3u8_relative_segment_urls() {
        let manifest = "\
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
segment-001.ts
#EXTINF:4.0,
segment-002.ts
";
        let base = "http://iptv.example.com/live/720p/index.m3u8";
        let result = rewrite_m3u8_manifest(manifest, base);

        // Segments should be resolved and encoded
        let expected_seg1 = format!(
            "streamproxy://localhost/{}",
            encode_proxy_url("http://iptv.example.com/live/720p/segment-001.ts")
        );
        let expected_seg2 = format!(
            "streamproxy://localhost/{}",
            encode_proxy_url("http://iptv.example.com/live/720p/segment-002.ts")
        );
        assert!(result.contains(&expected_seg1), "segment-001 not rewritten:\n{result}");
        assert!(result.contains(&expected_seg2), "segment-002 not rewritten:\n{result}");
        // Tags should be preserved
        assert!(result.contains("#EXTM3U"));
        assert!(result.contains("#EXT-X-TARGETDURATION:4"));
    }

    #[test]
    fn rewrite_m3u8_absolute_urls() {
        let manifest = "\
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
https://cdn.example.com/hls/1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
https://cdn.example.com/hls/720p/index.m3u8
";
        let base = "https://origin.example.com/master.m3u8";
        let result = rewrite_m3u8_manifest(manifest, base);

        let expected_1080 = format!(
            "streamproxy://localhost/{}",
            encode_proxy_url("https://cdn.example.com/hls/1080p/index.m3u8")
        );
        assert!(result.contains(&expected_1080), "absolute URL not rewritten:\n{result}");
    }

    #[test]
    fn rewrite_m3u8_ext_x_key_uri() {
        let manifest = "\
#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.example.com/key?id=1\"
#EXTINF:4.0,
segment-001.ts
";
        let base = "http://example.com/live/index.m3u8";
        let result = rewrite_m3u8_manifest(manifest, base);

        let expected_key = format!(
            "streamproxy://localhost/{}",
            encode_proxy_url("https://keys.example.com/key?id=1")
        );
        assert!(result.contains(&expected_key), "EXT-X-KEY URI not rewritten:\n{result}");
    }

    #[test]
    fn rewrite_m3u8_ext_x_map_uri() {
        let manifest = "\
#EXTM3U
#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"1024@0\"
#EXTINF:4.0,
segment-001.m4s
";
        let base = "http://example.com/hls/index.m3u8";
        let result = rewrite_m3u8_manifest(manifest, base);

        let expected_map = format!(
            "streamproxy://localhost/{}",
            encode_proxy_url("http://example.com/hls/init.mp4")
        );
        assert!(result.contains(&expected_map), "EXT-X-MAP URI not rewritten:\n{result}");
        // BYTERANGE should be preserved
        assert!(result.contains("BYTERANGE="), "BYTERANGE attribute lost:\n{result}");
    }

    #[test]
    fn rewrite_preserves_empty_lines_and_comments() {
        let manifest = "\
#EXTM3U
# This is a comment
#EXT-X-VERSION:3

#EXTINF:4.0,
segment.ts
";
        let base = "http://example.com/index.m3u8";
        let result = rewrite_m3u8_manifest(manifest, base);

        assert!(result.contains("# This is a comment"));
        assert!(result.contains("#EXT-X-VERSION:3"));
    }

    #[test]
    fn is_m3u8_by_content_type() {
        assert!(is_m3u8_response("application/vnd.apple.mpegurl", "http://example.com/stream"));
        assert!(is_m3u8_response("application/x-mpegurl", "http://example.com/stream"));
        assert!(!is_m3u8_response("video/mp2t", "http://example.com/segment.ts"));
    }

    #[test]
    fn is_m3u8_by_url_extension() {
        assert!(is_m3u8_response("application/octet-stream", "http://example.com/live.m3u8"));
        assert!(is_m3u8_response("text/plain", "http://example.com/live.m3u8?token=abc"));
        assert!(!is_m3u8_response("text/plain", "http://example.com/segment.ts"));
    }
}
