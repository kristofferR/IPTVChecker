use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{HeaderValue, CONTENT_TYPE, RANGE, USER_AGENT};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::state::AppState;

/// Fail fast if upstream's TCP/TLS handshake stalls.
const PROXY_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Total timeout for buffered manifest/segment fetches through the Tauri scheme
/// proxy. These responses are finite and should stay bounded.
const PROXY_BUFFERED_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Per-read inactivity timeout — resets on every successful read, so it does NOT
/// cap total stream duration. Only kills truly dead/stalled connections.
const PROXY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Time to wait after cancelling local connections so the upstream server
/// has a chance to release the single-credential slot (TCP FIN → server-side
/// session cleanup) before the receiver path opens its own. 250ms is enough
/// for well-behaved IPTV portals; tail providers may need more, but the
/// receiver fetch will still typically succeed because we've at least closed
/// our socket.
const LOCAL_STREAM_CANCEL_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

/// Cancel all in-flight local streaming-proxy connections and wait briefly for
/// the upstream slot to be released. Receiver paths (Chromecast / AirPlay)
/// must call this before starting their own upstream fetch — single-credential
/// IPTV providers reject the receiver with HTTP 458 ("too many connections")
/// if the local player still holds the slot.
///
/// The token is replaced with a fresh one before being cancelled, so future
/// local-player connections after the receiver tears down still work.
pub async fn cancel_active_local_streams(state: &AppState) {
    let old = {
        let mut guard = state.local_stream_cancel.lock().await;
        std::mem::replace(&mut *guard, CancellationToken::new())
    };
    old.cancel();
    log::info!(
        "[StreamProxy] Released upstream slot (waiting {}ms for server cleanup)",
        LOCAL_STREAM_CANCEL_GRACE.as_millis()
    );
    tokio::time::sleep(LOCAL_STREAM_CANCEL_GRACE).await;
}

async fn current_local_stream_cancel(state: &AppState) -> CancellationToken {
    state.local_stream_cancel.lock().await.clone()
}

/// Base64url-encode an original stream URL for the proxy scheme.
pub fn encode_proxy_url(original: &str) -> String {
    URL_SAFE_NO_PAD.encode(original.as_bytes())
}

/// Decode a proxy path back to the original stream URL.
pub fn decode_proxy_url(encoded: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    String::from_utf8(bytes).ok()
}

pub fn build_streaming_proxy_url(port: u16, original: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(original.as_bytes()).collect();
    format!("http://127.0.0.1:{port}/stream?url={encoded}")
}

async fn streaming_proxy_port_is_alive(port: u16) -> bool {
    if port == 0 {
        return false;
    }

    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(250),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await,
        Ok(Ok(_))
    )
}

pub async fn ensure_streaming_proxy_port(app: tauri::AppHandle) -> u16 {
    let state = app.state::<Arc<AppState>>();
    let port = state.streaming_proxy_port.load(Ordering::Relaxed);
    if streaming_proxy_port_is_alive(port).await {
        return port;
    }
    if port > 0 {
        log::warn!(
            "[StreamProxy] Stored proxy port {} is unreachable, restarting listener",
            port
        );
    }

    let _guard = state.streaming_proxy_start_lock.lock().await;
    let port = state.streaming_proxy_port.load(Ordering::Relaxed);
    if streaming_proxy_port_is_alive(port).await {
        return port;
    }

    match start_streaming_proxy(app.clone()).await {
        Ok(port) => {
            state.streaming_proxy_port.store(port, Ordering::Relaxed);
            log::info!(
                "[StreamProxy] Lazily started localhost streaming proxy on port {}",
                port
            );
            port
        }
        Err(error) => {
            log::warn!(
                "[StreamProxy] Failed to start localhost streaming proxy: {}",
                error
            );
            0
        }
    }
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
pub(crate) fn redact_url(url: &str) -> String {
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

fn reqwest_error_kind(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else if err.is_body() {
        "body"
    } else if err.is_request() {
        "request"
    } else {
        "other"
    }
}

fn is_blocked_ipv4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
}

fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_blocked_ipv4(v4),
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_ipv4(mapped);
            }

            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
        }
    }
}

/// Reject URLs targeting localhost, private networks, or metadata endpoints.
async fn is_safe_upstream_url(url: &str) -> bool {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };

    let scheme = parsed.scheme().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return false;
    }

    let host = match parsed.host() {
        Some(h) => h,
        None => return false,
    };

    match host {
        Host::Domain(domain) => {
            if domain.eq_ignore_ascii_case("localhost") {
                return false;
            }

            let port = parsed.port_or_known_default().unwrap_or(80);
            let Ok(socket_addrs) = tokio::net::lookup_host((domain, port)).await else {
                return false;
            };
            let resolved_ips = socket_addrs.map(|addr| addr.ip()).collect::<Vec<_>>();
            !resolved_ips.is_empty() && resolved_ips.into_iter().all(|ip| !is_blocked_ip(ip))
        }
        Host::Ipv4(ip) => !is_blocked_ip(std::net::IpAddr::V4(ip)),
        Host::Ipv6(ip) => !is_blocked_ip(std::net::IpAddr::V6(ip)),
    }
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
            log::warn!("Stream proxy: failed to decode URL from request path");
            return error_response(400, "Invalid proxy URL encoding");
        }
    };

    if !is_safe_upstream_url(&original_url).await {
        log::warn!("Stream proxy: blocked request to private/local target");
        return error_response(403, "Target URL not allowed");
    }

    log::debug!("Stream proxy: fetching {}", redact_url(&original_url));

    let state = app.state::<Arc<AppState>>();
    let (user_agent, accept_invalid_certs) = {
        let settings = state.settings.lock().await;
        (settings.user_agent.clone(), settings.accept_invalid_certs)
    };

    let client = get_or_create_proxy_client(state.inner(), accept_invalid_certs).await;

    let mut req_builder = client
        .get(&original_url)
        .header(
            USER_AGENT,
            HeaderValue::from_str(&user_agent)
                .unwrap_or_else(|_| HeaderValue::from_static("TiviMate/5.1.6 (Android 12)")),
        )
        .timeout(PROXY_BUFFERED_RESPONSE_TIMEOUT);

    // Forward Range header for partial content requests
    if let Some(range) = request.headers().get(RANGE) {
        req_builder = req_builder.header(RANGE, range.clone());
    }

    let upstream_response = match req_builder.send().await {
        Ok(resp) => resp,
        Err(err) => {
            log::warn!(
                "Stream proxy: upstream request failed for {} ({})",
                redact_url(&original_url),
                reqwest_error_kind(&err)
            );
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
            log::warn!(
                "Stream proxy: failed to read buffered upstream body for {} ({})",
                redact_url(&original_url),
                reqwest_error_kind(&err)
            );
            if err.is_timeout() {
                return error_response(504, "Upstream response timed out");
            }
            return error_response(502, "Failed to read upstream response");
        }
    };

    // Rewrite M3U8 manifests so internal URLs also go through the proxy
    let looks_like_m3u8 =
        is_m3u8_response(&content_type, &final_url) || body.starts_with(b"#EXTM3U");
    let body = if looks_like_m3u8 {
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
        .header(
            "access-control-expose-headers",
            "content-range, content-length",
        );

    builder
        .body(body)
        .unwrap_or_else(|_| error_response(500, "Failed to build response"))
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

fn build_proxy_client(
    accept_invalid_certs: bool,
    connect_timeout: std::time::Duration,
    read_timeout: std::time::Duration,
) -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(accept_invalid_certs)
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .pool_max_idle_per_host(0)
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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

    let client = build_proxy_client(
        accept_invalid_certs,
        PROXY_CONNECT_TIMEOUT,
        PROXY_READ_TIMEOUT,
    );

    *guard = Some((client.clone(), accept_invalid_certs));
    client
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamForwardOutcome {
    Completed,
    UpstreamReadTimeout,
    UpstreamReadError(&'static str),
    DownstreamClosed,
}

async fn forward_response_as_chunked_stream<W>(
    writer: &mut W,
    response: reqwest::Response,
) -> StreamForwardOutcome
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut outcome = StreamForwardOutcome::Completed;
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                let size_line = format!("{:x}\r\n", chunk.len());
                if writer.write_all(size_line.as_bytes()).await.is_err() {
                    return StreamForwardOutcome::DownstreamClosed;
                }
                if writer.write_all(&chunk).await.is_err() {
                    return StreamForwardOutcome::DownstreamClosed;
                }
                if writer.write_all(b"\r\n").await.is_err() {
                    return StreamForwardOutcome::DownstreamClosed;
                }
            }
            Err(err) => {
                outcome = if err.is_timeout() {
                    StreamForwardOutcome::UpstreamReadTimeout
                } else {
                    StreamForwardOutcome::UpstreamReadError(reqwest_error_kind(&err))
                };
                break;
            }
        }
    }

    if writer.write_all(b"0\r\n\r\n").await.is_err() {
        return StreamForwardOutcome::DownstreamClosed;
    }

    outcome
}

// ---------------------------------------------------------------------------
// Localhost streaming proxy for MPEG-TS and other infinite-body streams.
// The Tauri URI scheme proxy buffers the full response, which fails for live
// streams. This lightweight TCP server streams bytes through without buffering.
// ---------------------------------------------------------------------------

/// Start a localhost HTTP proxy that streams upstream responses.
/// Returns the port the server is listening on.
pub async fn start_streaming_proxy(app: tauri::AppHandle) -> std::io::Result<u16> {
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    log::info!(
        "[StreamProxy] Localhost streaming proxy started on port {}",
        port
    );

    tokio::spawn(async move {
        loop {
            let (socket, _addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(err) => {
                    log::warn!("[StreamProxy] Accept error: {}", err);
                    continue;
                }
            };

            let app_handle = app.clone();
            // Snapshot the current cancel token so this connection dies if a
            // receiver path (Chromecast / AirPlay) calls
            // `cancel_active_local_streams` before we start its own upstream
            // fetch. Future connections accepted after that grab the
            // already-replaced fresh token, so they're unaffected.
            let cancel = current_local_stream_cancel(
                app_handle.state::<Arc<AppState>>().inner(),
            )
            .await;
            tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        log::debug!(
                            "[StreamProxy] Connection cancelled (receiver took the upstream slot)"
                        );
                    }
                    _ = handle_streaming_connection(socket, app_handle) => {}
                }
            });
        }
    });

    Ok(port)
}

async fn handle_streaming_connection(mut socket: tokio::net::TcpStream, app_handle: tauri::AppHandle) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

    if !is_safe_upstream_url(&url).await {
        log::warn!("[StreamProxy] Blocked request to private/local target");
        let response =
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 22\r\n\r\nTarget URL not allowed";
        let _ = socket.write_all(response.as_bytes()).await;
        return;
    }

    log::info!("[StreamProxy] Streaming {}", redact_url(&url));

    // Fetch upstream with streaming body using settings-aware client
    let state = app_handle.state::<Arc<AppState>>();
    let (user_agent, accept_invalid_certs) = {
        let settings = state.settings.lock().await;
        (settings.user_agent.clone(), settings.accept_invalid_certs)
    };

    let client = get_or_create_proxy_client(state.inner(), accept_invalid_certs).await;

    let response = match client
        .get(&url)
        .header(
            USER_AGENT,
            HeaderValue::from_str(&user_agent)
                .unwrap_or_else(|_| HeaderValue::from_static("TiviMate/5.1.6 (Android 12)")),
        )
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) => {
            log::warn!(
                "[StreamProxy] Upstream request failed for {} ({})",
                redact_url(&url),
                reqwest_error_kind(&err)
            );
            let (status_line, body) = if err.is_timeout() {
                ("HTTP/1.1 504 Gateway Timeout", "Upstream request timed out")
            } else {
                ("HTTP/1.1 502 Bad Gateway", "Upstream request failed")
            };
            let response = format!(
                "{status_line}\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            return;
        }
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Write HTTP response headers
    let status_line = match status.canonical_reason() {
        Some(reason) => format!("HTTP/1.1 {} {}\r\n", status.as_u16(), reason),
        None => format!("HTTP/1.1 {}\r\n", status.as_u16()),
    };
    let header = format!(
        "{}Content-Type: {}\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Transfer-Encoding: chunked\r\n\
             Cache-Control: no-cache\r\n\
             Connection: close\r\n\
             \r\n",
        status_line, content_type
    );
    if socket.write_all(header.as_bytes()).await.is_err() {
        return;
    }

    match forward_response_as_chunked_stream(&mut socket, response).await {
        StreamForwardOutcome::Completed => {
            log::debug!(
                "[StreamProxy] Upstream stream ended normally for {}",
                redact_url(&url)
            );
        }
        StreamForwardOutcome::UpstreamReadTimeout => {
            log::warn!(
                "[StreamProxy] Upstream stream stalled/timed out for {}",
                redact_url(&url)
            );
        }
        StreamForwardOutcome::UpstreamReadError(kind) => {
            log::warn!(
                "[StreamProxy] Upstream stream terminated for {} ({})",
                redact_url(&url),
                kind
            );
        }
        StreamForwardOutcome::DownstreamClosed => {
            log::debug!(
                "[StreamProxy] Downstream disconnected while streaming {}",
                redact_url(&url)
            );
        }
    }
}

fn parse_stream_request(request: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    // GET /stream?url=ENCODED HTTP/1.1
    let path = first_line.split_whitespace().nth(1)?;
    let url = Url::parse(&format!("http://localhost{path}")).ok()?;
    url.query_pairs()
        .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct TestStreamChunk {
        body: Vec<u8>,
        delay_after: Duration,
    }

    async fn spawn_chunked_upstream(
        chunks: Vec<TestStreamChunk>,
        tail_delay: Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("listener should have local addr");

        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("server should accept");
            let mut request_buf = vec![0u8; 8192];
            let _ = socket.read(&mut request_buf).await;

            let headers = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: video/mp2t\r\n",
                "Transfer-Encoding: chunked\r\n",
                "Connection: close\r\n",
                "\r\n"
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("server should write headers");

            for chunk in chunks {
                let size_line = format!("{:x}\r\n", chunk.body.len());
                if socket.write_all(size_line.as_bytes()).await.is_err() {
                    return;
                }
                if socket.write_all(&chunk.body).await.is_err() {
                    return;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    return;
                }
                if !chunk.delay_after.is_zero() {
                    tokio::time::sleep(chunk.delay_after).await;
                }
            }

            if !tail_delay.is_zero() {
                tokio::time::sleep(tail_delay).await;
            }

            let _ = socket.write_all(b"0\r\n\r\n").await;
            let _ = socket.shutdown().await;
        });

        (format!("http://{addr}"), handle)
    }

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
    fn build_streaming_proxy_url_percent_encodes_original_url() {
        assert_eq!(
            build_streaming_proxy_url(
                61234,
                "http://example.com/live/123.ts?token=a+b&name=V SPORT"
            ),
            "http://127.0.0.1:61234/stream?url=http%3A%2F%2Fexample.com%2Flive%2F123.ts%3Ftoken%3Da%2Bb%26name%3DV+SPORT"
        );
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
        assert!(
            result.contains(&expected_seg1),
            "segment-001 not rewritten:\n{result}"
        );
        assert!(
            result.contains(&expected_seg2),
            "segment-002 not rewritten:\n{result}"
        );
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
        assert!(
            result.contains(&expected_1080),
            "absolute URL not rewritten:\n{result}"
        );
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
        assert!(
            result.contains(&expected_key),
            "EXT-X-KEY URI not rewritten:\n{result}"
        );
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
        assert!(
            result.contains(&expected_map),
            "EXT-X-MAP URI not rewritten:\n{result}"
        );
        // BYTERANGE should be preserved
        assert!(
            result.contains("BYTERANGE="),
            "BYTERANGE attribute lost:\n{result}"
        );
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
        assert!(is_m3u8_response(
            "application/vnd.apple.mpegurl",
            "http://example.com/stream"
        ));
        assert!(is_m3u8_response(
            "application/x-mpegurl",
            "http://example.com/stream"
        ));
        assert!(!is_m3u8_response(
            "video/mp2t",
            "http://example.com/segment.ts"
        ));
    }

    #[test]
    fn is_m3u8_by_url_extension() {
        assert!(is_m3u8_response(
            "application/octet-stream",
            "http://example.com/live.m3u8"
        ));
        assert!(is_m3u8_response(
            "text/plain",
            "http://example.com/live.m3u8?token=abc"
        ));
        assert!(!is_m3u8_response(
            "text/plain",
            "http://example.com/segment.ts"
        ));
    }

    #[test]
    fn parse_stream_request_decodes_percent_encoded_utf8() {
        let request =
            "GET /stream?url=https%3A%2F%2Fexample.com%2Fstr%C3%B8m%3Ftoken%3Dabc%2B123 HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(
            parse_stream_request(request).as_deref(),
            Some("https://example.com/strøm?token=abc+123")
        );
    }

    #[tokio::test]
    async fn forward_response_as_chunked_stream_allows_long_lived_streams_without_total_timeout() {
        let read_timeout = Duration::from_millis(250);
        let simulated_old_total_timeout = Duration::from_millis(300);
        let chunks = vec![
            TestStreamChunk {
                body: vec![0x01; 64],
                delay_after: Duration::from_millis(140),
            },
            TestStreamChunk {
                body: vec![0x02; 64],
                delay_after: Duration::from_millis(140),
            },
            TestStreamChunk {
                body: vec![0x03; 64],
                delay_after: Duration::from_millis(140),
            },
        ];
        let (url, server_handle) = spawn_chunked_upstream(chunks, Duration::ZERO).await;
        let client = build_proxy_client(false, Duration::from_secs(1), read_timeout);
        let response = client
            .get(&url)
            .send()
            .await
            .expect("stream request should succeed");

        let started = Instant::now();
        let mut sink = tokio::io::sink();
        let outcome = forward_response_as_chunked_stream(&mut sink, response).await;
        let elapsed = started.elapsed();

        assert_eq!(outcome, StreamForwardOutcome::Completed);
        assert!(
            elapsed > simulated_old_total_timeout,
            "stream completed too quickly to cover the old timeout window: {:?}",
            elapsed
        );

        server_handle.await.expect("server task should finish");
    }

    #[tokio::test]
    async fn forward_response_as_chunked_stream_times_out_when_upstream_stalls() {
        let read_timeout = Duration::from_millis(120);
        let chunks = vec![TestStreamChunk {
            body: vec![0xAA; 64],
            delay_after: Duration::ZERO,
        }];
        let (url, server_handle) = spawn_chunked_upstream(chunks, Duration::from_millis(250)).await;
        let client = build_proxy_client(false, Duration::from_secs(1), read_timeout);
        let response = client
            .get(&url)
            .send()
            .await
            .expect("stream request should succeed");

        let mut sink = tokio::io::sink();
        let outcome = forward_response_as_chunked_stream(&mut sink, response).await;

        assert_eq!(outcome, StreamForwardOutcome::UpstreamReadTimeout);

        server_handle.await.expect("server task should finish");
    }

    #[tokio::test]
    async fn is_safe_upstream_blocks_private_ranges_and_ipv6() {
        assert!(!is_safe_upstream_url("http://localhost/").await);
        assert!(!is_safe_upstream_url("http://127.0.0.1/").await);
        assert!(!is_safe_upstream_url("http://10.0.0.1/").await);
        assert!(!is_safe_upstream_url("http://172.16.0.1/").await);
        assert!(!is_safe_upstream_url("http://192.168.1.1/").await);
        assert!(!is_safe_upstream_url("http://169.254.169.254/").await);
        assert!(!is_safe_upstream_url("http://[::1]/").await);
        assert!(!is_safe_upstream_url("http://[fe80::1]/").await);
        assert!(!is_safe_upstream_url("http://[fc00::1]/").await);
        assert!(!is_safe_upstream_url("http://[::ffff:127.0.0.1]/").await);
        assert!(!is_safe_upstream_url("http://[::ffff:10.0.0.1]/").await);
        assert!(is_safe_upstream_url("http://8.8.8.8/").await);
        assert!(is_safe_upstream_url("http://[2606:4700:4700::1111]/").await);
    }
}
