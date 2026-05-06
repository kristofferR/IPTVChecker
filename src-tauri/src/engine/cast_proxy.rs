//! LAN-bound HTTP proxy used to stream upstream IPTV content to a Chromecast.
//!
//! Unlike the in-app `stream_proxy` (which binds to 127.0.0.1 for the
//! webview), the cast proxy binds to `0.0.0.0` so the Chromecast on the LAN
//! can reach it. Each session generates a fresh random token; only requests
//! whose path starts with `/cast/<token>/` are served, so this short-lived,
//! per-session listener does not become an open relay.
//!
//! Lifecycle: [`start`] returns a [`CastProxyHandle`] containing the bound
//! address and a cancel guard; dropping the handle (or calling `shutdown`)
//! tears the listener down and aborts in-flight forwarders.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{HeaderValue, CONTENT_TYPE, USER_AGENT};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::engine::stream_proxy::redact_url;
use crate::error::AppError;
use crate::state::AppState;

const CAST_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CAST_READ_TIMEOUT: Duration = Duration::from_secs(20);
const MANIFEST_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

pub struct CastProxyHandle {
    pub url: String,
    pub host: IpAddr,
    pub port: u16,
    pub token: String,
    cancel: CancellationToken,
}

impl CastProxyHandle {
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl Drop for CastProxyHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Generate a fresh 32-byte URL-safe token. Used in the URL path so untrusted
/// LAN peers can't hit the proxy without knowing it.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Best-effort discovery of the LAN-facing local IP. Falls back to 0.0.0.0
/// (the bind address) when nothing better is available; in that case the
/// caller should prompt the user, since the Chromecast won't be able to reach
/// the bind address by itself.
pub fn detect_lan_ip() -> Option<IpAddr> {
    match local_ip_address::local_ip() {
        Ok(ip) => Some(ip),
        Err(err) => {
            log::warn!("[CastProxy] Failed to detect LAN IP: {err}");
            None
        }
    }
}

/// Bind a fresh LAN-facing listener and serve upstream content for a single
/// cast URL until cancelled.
pub async fn start(
    app: AppHandle,
    upstream_url: String,
) -> Result<CastProxyHandle, AppError> {
    let token = generate_token();
    let lan_ip = detect_lan_ip()
        .ok_or_else(|| AppError::Other("Could not determine LAN IP for cast proxy".to_string()))?;

    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(AppError::Io)?;
    let port = listener.local_addr().map_err(AppError::Io)?.port();
    let cast_url = format!("http://{lan_ip}:{port}/cast/{token}/stream");

    log::info!(
        "[CastProxy] Listening on 0.0.0.0:{port} (advertising {lan_ip}:{port}) for {}",
        redact_url(&upstream_url)
    );

    let cancel = CancellationToken::new();
    let cancel_for_loop = cancel.clone();

    let token_clone = token.clone();
    let upstream_clone = upstream_url.clone();
    let app_for_loop = app.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_for_loop.cancelled() => {
                    log::info!("[CastProxy] Listener on port {port} cancelled");
                    break;
                }
                accept = listener.accept() => {
                    let (socket, peer) = match accept {
                        Ok(pair) => pair,
                        Err(err) => {
                            log::warn!("[CastProxy] Accept error: {err}");
                            continue;
                        }
                    };
                    let app_for_conn = app_for_loop.clone();
                    let token_for_conn = token_clone.clone();
                    let upstream_for_conn = upstream_clone.clone();
                    let cancel_for_conn = cancel_for_loop.clone();
                    tokio::spawn(async move {
                        if let Err(err) = handle_connection(
                            app_for_conn,
                            socket,
                            peer.to_string(),
                            token_for_conn,
                            upstream_for_conn,
                            cancel_for_conn,
                        )
                        .await
                        {
                            log::debug!("[CastProxy] Connection from {peer} ended: {err}");
                        }
                    });
                }
            }
        }
    });

    Ok(CastProxyHandle {
        url: cast_url,
        host: lan_ip,
        port,
        token,
        cancel,
    })
}

async fn handle_connection(
    app: AppHandle,
    mut socket: tokio::net::TcpStream,
    peer: String,
    token: String,
    upstream_url: String,
    cancel: CancellationToken,
) -> std::io::Result<()> {
    let mut buf = vec![0u8; 8192];
    let n = socket.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = match parse_request_path(&request) {
        Some(p) => p,
        None => {
            let _ = write_simple(&mut socket, 400, "text/plain", b"Bad request").await;
            return Ok(());
        }
    };

    let allowed_prefix = format!("/cast/{token}/");
    if !path.starts_with(&allowed_prefix) {
        log::warn!("[CastProxy] Rejecting request with bad token from {peer}");
        let _ = write_simple(&mut socket, 403, "text/plain", b"Forbidden").await;
        return Ok(());
    }

    // Determine whether this is the entrypoint (/stream) or a rewritten
    // segment/sub-playlist (/seg/<base64>).
    let suffix = &path[allowed_prefix.len()..];
    let resolved_upstream = if let Some(encoded) = suffix.strip_prefix("seg/") {
        match decode_segment(encoded) {
            Some(url) => url,
            None => {
                let _ = write_simple(&mut socket, 400, "text/plain", b"Bad segment").await;
                return Ok(());
            }
        }
    } else if suffix == "stream" {
        upstream_url.clone()
    } else {
        let _ = write_simple(&mut socket, 404, "text/plain", b"Not found").await;
        return Ok(());
    };

    serve_upstream(
        app,
        &mut socket,
        resolved_upstream,
        token,
        cancel,
    )
    .await
}

async fn serve_upstream(
    app: AppHandle,
    socket: &mut tokio::net::TcpStream,
    upstream_url: String,
    token: String,
    cancel: CancellationToken,
) -> std::io::Result<()> {
    let state = app.state::<Arc<AppState>>();
    let (user_agent, accept_invalid_certs) = {
        let settings = state.settings.lock().await;
        (settings.user_agent.clone(), settings.accept_invalid_certs)
    };

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(accept_invalid_certs)
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .pool_max_idle_per_host(0)
        .connect_timeout(CAST_CONNECT_TIMEOUT)
        .read_timeout(CAST_READ_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let response = match tokio::time::timeout(
        MANIFEST_FETCH_TIMEOUT,
        client
            .get(&upstream_url)
            .header(
                USER_AGENT,
                HeaderValue::from_str(&user_agent)
                    .unwrap_or_else(|_| HeaderValue::from_static("TiviMate/5.1.6 (Android 12)")),
            )
            .send(),
    )
    .await
    {
        Ok(Ok(resp)) => resp,
        Ok(Err(err)) => {
            log::warn!(
                "[CastProxy] Upstream fetch failed for {}: {err}",
                redact_url(&upstream_url)
            );
            return write_simple(socket, 502, "text/plain", b"Upstream failed").await;
        }
        Err(_) => {
            log::warn!(
                "[CastProxy] Upstream fetch timed out for {}",
                redact_url(&upstream_url)
            );
            return write_simple(socket, 504, "text/plain", b"Upstream timed out").await;
        }
    };

    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let looks_like_m3u8 = is_m3u8(&content_type, &final_url);

    if looks_like_m3u8 {
        // Buffer the manifest, rewrite URIs to round-trip through this proxy.
        let body = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => {
                log::warn!("[CastProxy] Failed to read manifest: {err}");
                return write_simple(socket, 502, "text/plain", b"Manifest read failed").await;
            }
        };
        let body_str = String::from_utf8_lossy(&body);
        let rewritten = rewrite_manifest(&body_str, &final_url, &token);

        let header = format!(
            "HTTP/1.1 {status} OK\r\n\
             Content-Type: application/vnd.apple.mpegurl\r\n\
             Content-Length: {len}\r\n\
             Cache-Control: no-cache\r\n\
             Connection: close\r\n\
             \r\n",
            status = status.as_u16(),
            len = rewritten.len()
        );
        socket.write_all(header.as_bytes()).await?;
        socket.write_all(rewritten.as_bytes()).await?;
        return Ok(());
    }

    // Otherwise stream the body through with chunked transfer.
    let status_line = match status.canonical_reason() {
        Some(reason) => format!("HTTP/1.1 {} {}\r\n", status.as_u16(), reason),
        None => format!("HTTP/1.1 {}\r\n", status.as_u16()),
    };
    let header = format!(
        "{status_line}Content-Type: {content_type}\r\n\
         Transfer-Encoding: chunked\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\
         \r\n"
    );
    socket.write_all(header.as_bytes()).await?;

    use futures::StreamExt;
    let mut stream = response.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                log::debug!("[CastProxy] Forward cancelled mid-stream");
                break;
            }
            chunk = stream.next() => {
                let Some(item) = chunk else { break; };
                match item {
                    Ok(bytes) => {
                        let size_line = format!("{:x}\r\n", bytes.len());
                        if socket.write_all(size_line.as_bytes()).await.is_err() {
                            return Ok(());
                        }
                        if socket.write_all(&bytes).await.is_err() {
                            return Ok(());
                        }
                        if socket.write_all(b"\r\n").await.is_err() {
                            return Ok(());
                        }
                    }
                    Err(err) => {
                        log::warn!("[CastProxy] Upstream stream error: {err}");
                        break;
                    }
                }
            }
        }
    }
    let _ = socket.write_all(b"0\r\n\r\n").await;
    Ok(())
}

fn parse_request_path(request: &str) -> Option<&str> {
    let first = request.lines().next()?;
    let mut parts = first.split_whitespace();
    let _method = parts.next()?;
    parts.next()
}

async fn write_simple(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
        len = body.len()
    );
    socket.write_all(header.as_bytes()).await?;
    socket.write_all(body).await?;
    Ok(())
}

fn is_m3u8(content_type: &str, url: &str) -> bool {
    let ct = content_type.to_lowercase();
    if ct.contains("application/vnd.apple.mpegurl") || ct.contains("application/x-mpegurl") {
        return true;
    }
    if let Ok(parsed) = Url::parse(url) {
        if parsed.path().to_lowercase().ends_with(".m3u8") {
            return true;
        }
    }
    false
}

/// Rewrite all URI references in an HLS manifest to come back through this
/// proxy, so the Chromecast only ever talks to us. We base64url-encode the
/// resolved upstream URL into the path so we don't need persistent state.
fn rewrite_manifest(body: &str, base_url: &str, token: &str) -> String {
    let base = match Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return body.to_string(),
    };
    let mut out = String::with_capacity(body.len());
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            // Rewrite URI="..." in select tags
            let upper = trimmed.to_ascii_uppercase();
            if (upper.starts_with("#EXT-X-MAP:")
                || upper.starts_with("#EXT-X-KEY:")
                || upper.starts_with("#EXT-X-MEDIA:")
                || upper.starts_with("#EXT-X-SESSION-KEY:"))
                && trimmed.contains("URI=")
            {
                out.push_str(&rewrite_tag_uri(trimmed, &base, token));
            } else {
                out.push_str(line);
            }
            out.push('\n');
            continue;
        }
        match base.join(trimmed) {
            Ok(resolved) => {
                out.push_str(&format!("/cast/{token}/seg/{}", encode_segment(resolved.as_str())));
            }
            Err(_) => out.push_str(line),
        }
        out.push('\n');
    }
    out
}

fn rewrite_tag_uri(line: &str, base: &Url, token: &str) -> String {
    let upper = line.to_ascii_uppercase();
    let Some(uri_pos) = upper.find("URI=") else {
        return line.to_string();
    };
    let after = &line[uri_pos + 4..];
    let (quote, start, end) = if after.starts_with('"') {
        let inner = &after[1..];
        let e = inner.find('"').unwrap_or(inner.len());
        (Some('"'), 1, 1 + e)
    } else if after.starts_with('\'') {
        let inner = &after[1..];
        let e = inner.find('\'').unwrap_or(inner.len());
        (Some('\''), 1, 1 + e)
    } else {
        let e = after
            .find(|c: char| c == ',' || c.is_whitespace())
            .unwrap_or(after.len());
        (None, 0, e)
    };
    let original = &after[start..end];
    let resolved = match base.join(original) {
        Ok(u) => u.to_string(),
        Err(_) => return line.to_string(),
    };
    let new_uri = format!("/cast/{token}/seg/{}", encode_segment(&resolved));

    let mut result = String::with_capacity(line.len() + new_uri.len());
    result.push_str(&line[..uri_pos + 4]);
    if let Some(q) = quote {
        result.push(q);
        result.push_str(&new_uri);
        result.push(q);
    } else {
        result.push_str(&new_uri);
    }
    let after_offset = uri_pos + 4 + end + if quote.is_some() { 1 } else { 0 };
    if after_offset < line.len() {
        result.push_str(&line[after_offset..]);
    }
    result
}

fn encode_segment(url: &str) -> String {
    URL_SAFE_NO_PAD.encode(url.as_bytes())
}

fn decode_segment(encoded: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_url_safe_and_long() {
        let token = generate_token();
        assert!(token.len() >= 40, "token too short: {token}");
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn rewrite_manifest_swaps_segment_lines() {
        let manifest = "\
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg-1.ts
#EXTINF:6.0,
seg-2.ts
";
        let base = "http://iptv.example.com/live/720p/index.m3u8";
        let rewritten = rewrite_manifest(manifest, base, "abc");
        assert!(rewritten.contains("/cast/abc/seg/"));
        let expected = format!(
            "/cast/abc/seg/{}",
            encode_segment("http://iptv.example.com/live/720p/seg-1.ts")
        );
        assert!(rewritten.contains(&expected), "missing rewritten seg-1: {rewritten}");
    }

    #[test]
    fn parse_request_path_extracts_target() {
        let request = "GET /cast/abc/stream HTTP/1.1\r\nHost: 192.168.1.10:5500\r\n\r\n";
        assert_eq!(parse_request_path(request), Some("/cast/abc/stream"));
    }
}
