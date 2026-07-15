use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{HeaderValue, CONTENT_TYPE, RANGE, USER_AGENT};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;
use url::{Host, Url};

use crate::engine::ffmpeg::{
    configure_background_process, graceful_kill, resolve_binary, GRACEFUL_KILL_TIMEOUT,
};
use crate::state::AppState;

/// Fail fast if upstream's TCP/TLS handshake stalls.
const PROXY_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Total timeout for buffered manifest/segment fetches through the Tauri scheme
/// proxy. These responses are finite and should stay bounded.
const PROXY_BUFFERED_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Per-read inactivity timeout — resets on every successful read, so it does NOT
/// cap total stream duration. Only kills truly dead/stalled connections.
const PROXY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// Short retry delay for a live MPEG-TS source that drops its upstream socket.
/// The downstream connection stays open while the proxy reconnects, so the
/// browser player can keep its MediaSource and buffered video intact.
const STREAM_RECONNECT_BASE_DELAY: std::time::Duration = std::time::Duration::from_millis(500);
const STREAM_RECONNECT_MAX_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
const MPEG_TS_PACKET_SIZE: usize = 188;
const MPEG_TS_PCR_TICKS_PER_SECOND: u64 = 27_000_000;
const MPEG_TS_PCR_WRAP_TICKS: u64 = (1u64 << 33) * 300;
const STREAM_PACER_MAX_LEAD: std::time::Duration = std::time::Duration::from_secs(90);
/// A reqwest body chunk is small enough that it cannot legitimately span more
/// than a few seconds of broadcast time. Larger PCR steps usually mean the
/// provider switched clocks/PIDs or sent a corrupt timestamp.
const STREAM_PACER_MAX_PCR_STEP: std::time::Duration = std::time::Duration::from_millis(250);
/// Never let a suspect transport clock put the proxy to sleep long enough for
/// the browser's starvation watchdog to fire. Normal pacing delays stay well
/// below this because the proxy sleeps after every body chunk.
const STREAM_PACER_MAX_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
/// Read live providers eagerly into a bounded queue so downstream pacing does
/// not apply TCP backpressure to bursty servers and make them skip TS packets.
const STREAM_PROXY_READ_AHEAD_BYTES: usize = 64 * 1024 * 1024;
const STREAM_PROXY_READ_AHEAD_CHUNKS: usize = 4_096;
const REMUX_PACER_MAX_LEAD: std::time::Duration = std::time::Duration::from_secs(12);
/// Rebuild a monotonic packet clock from each encoded stream's packet
/// durations. This preserves video composition offsets (PTS-DTS), including
/// B-frames, while removing every provider timestamp hole without decoding.
const CONTIGUOUS_VIDEO_TIMESTAMPS: &str = "setts=dts=if(eq(N\\,0)\\,0\\,PREV_OUTDTS+if(gt(PREV_OUTDURATION\\,0)\\,PREV_OUTDURATION\\,if(gt(DURATION\\,0)\\,DURATION\\,1))):pts=if(eq(N\\,0)\\,PTS-STARTDTS\\,PREV_OUTDTS+if(gt(PREV_OUTDURATION\\,0)\\,PREV_OUTDURATION\\,if(gt(DURATION\\,0)\\,DURATION\\,1))+PTS-DTS)";
const CONTIGUOUS_AUDIO_TIMESTAMPS: &str = "setts=ts=if(eq(N\\,0)\\,0\\,PREV_OUTDTS+if(gt(PREV_OUTDURATION\\,0)\\,PREV_OUTDURATION\\,if(gt(DURATION\\,0)\\,DURATION\\,1)))";

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
            // Xtream credentials live in path segments rather than URL userinfo:
            // /live/{username}/{password}/{stream-id}.ts. Those URLs are the
            // most common source of playback diagnostics, so query/userinfo
            // redaction alone would still leak both credentials.
            let segments = parsed
                .path_segments()
                .map(|segments| segments.map(str::to_string).collect::<Vec<_>>())
                .unwrap_or_default();
            let credential_start = if segments.len() >= 4
                && matches!(
                    segments[0].to_ascii_lowercase().as_str(),
                    "live" | "movie" | "series"
                ) {
                Some(1)
            } else if segments.len() == 3
                && segments[2]
                    .split('.')
                    .next()
                    .is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
            {
                Some(0)
            } else {
                None
            };
            if let Some(start) = credential_start {
                let redacted_segments = segments
                    .iter()
                    .enumerate()
                    .map(|(index, segment)| {
                        if index == start || index == start + 1 {
                            "***"
                        } else {
                            segment.as_str()
                        }
                    })
                    .collect::<Vec<_>>();
                if let Ok(mut path) = parsed.path_segments_mut() {
                    path.clear().extend(redacted_segments);
                }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StreamForwardResult {
    outcome: StreamForwardOutcome,
    bytes_forwarded: u64,
}

struct TransportStreamPacer {
    scan_tail: Vec<u8>,
    pcr_pid: Option<u16>,
    last_pcr: Option<u64>,
    media_elapsed_ticks: u64,
    wall_anchor: Option<std::time::Instant>,
    announced: bool,
    reanchor_count: u32,
    max_lead: std::time::Duration,
}

impl TransportStreamPacer {
    fn new() -> Self {
        Self::with_max_lead(STREAM_PACER_MAX_LEAD)
    }

    fn with_max_lead(max_lead: std::time::Duration) -> Self {
        Self {
            scan_tail: Vec::with_capacity(MPEG_TS_PACKET_SIZE * 4),
            pcr_pid: None,
            last_pcr: None,
            media_elapsed_ticks: 0,
            wall_anchor: None,
            announced: false,
            reanchor_count: 0,
            max_lead,
        }
    }

    fn delay_for_payload(&mut self, payload: &[u8]) -> std::time::Duration {
        let mut scan = Vec::with_capacity(self.scan_tail.len() + payload.len());
        scan.extend_from_slice(&self.scan_tail);
        scan.extend_from_slice(payload);

        let latest_pcr = latest_transport_stream_pcr(&scan, self.pcr_pid);
        let tail_start = scan.len().saturating_sub(MPEG_TS_PACKET_SIZE * 4);
        self.scan_tail.clear();
        self.scan_tail.extend_from_slice(&scan[tail_start..]);

        let Some((pcr_pid, pcr)) = latest_pcr else {
            return std::time::Duration::ZERO;
        };
        self.pcr_pid.get_or_insert(pcr_pid);

        let Some(previous_pcr) = self.last_pcr else {
            self.last_pcr = Some(pcr);
            self.wall_anchor = Some(std::time::Instant::now());
            return std::time::Duration::ZERO;
        };

        let delta = if pcr >= previous_pcr {
            pcr - previous_pcr
        } else {
            MPEG_TS_PCR_WRAP_TICKS - previous_pcr + pcr
        };
        let discontinuity_ticks = duration_to_pcr_ticks(STREAM_PACER_MAX_PCR_STEP);
        if delta > discontinuity_ticks {
            self.last_pcr = Some(pcr);
            // The broadcaster may reset or jump its PCR at a program boundary.
            // Keep the accumulated wall-clock budget so each discontinuity
            // cannot grant another full forward-buffer allowance.
            return std::time::Duration::ZERO;
        }

        self.last_pcr = Some(pcr);
        self.media_elapsed_ticks = self.media_elapsed_ticks.saturating_add(delta);
        let media_elapsed = duration_from_pcr_ticks(self.media_elapsed_ticks);
        let target_wall_elapsed = media_elapsed.saturating_sub(self.max_lead);
        let wall_elapsed = self
            .wall_anchor
            .map(|anchor| anchor.elapsed())
            .unwrap_or_default();
        let delay = target_wall_elapsed.saturating_sub(wall_elapsed);
        if delay > STREAM_PACER_MAX_DELAY {
            // A bad-but-plausible PCR series can otherwise accumulate into one
            // very long sleep. Re-anchor at real-time pacing without granting
            // another forward-buffer allowance; the browser keeps the buffer
            // it already has and the next payload is paced normally.
            self.media_elapsed_ticks = duration_to_pcr_ticks(self.max_lead);
            self.wall_anchor = Some(std::time::Instant::now());
            self.reanchor_count = self.reanchor_count.saturating_add(1);
            log::warn!(
                "[StreamProxy] Re-anchored transport clock after an implausible pacing delay"
            );
            return std::time::Duration::ZERO;
        }
        delay
    }
}

fn spawn_playback_remux(
    app: &tauri::AppHandle,
    upstream_url: &str,
    user_agent: &str,
    accept_invalid_certs: bool,
) -> std::io::Result<tokio::process::Child> {
    let ffmpeg = resolve_binary(app, "ffmpeg");
    let mut command = tokio::process::Command::new(&ffmpeg);
    configure_background_process(&mut command);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("warning")
        .arg("-fflags")
        .arg("+genpts+discardcorrupt")
        // MPEG-TS is marked as timestamp-discontinuous, so ffmpeg can remove
        // jumps by shifting subsequent DTS/PTS. Its 10-second default misses
        // the 2-5 second holes that repeatedly freeze WebView's MediaSource.
        .arg("-dts_delta_threshold")
        .arg("0.5")
        .arg("-thread_queue_size")
        .arg("4096")
        .arg("-user_agent")
        .arg(user_agent);

    if accept_invalid_certs && upstream_url.to_ascii_lowercase().starts_with("https://") {
        command.arg("-tls_verify").arg("0");
    }

    command
        .arg("-reconnect")
        .arg("1")
        .arg("-reconnect_at_eof")
        .arg("1")
        .arg("-reconnect_streamed")
        .arg("1")
        .arg("-reconnect_delay_max")
        .arg("5")
        .arg("-i")
        .arg(upstream_url)
        .arg("-map")
        .arg("0:v:0?")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-sn")
        .arg("-dn")
        .arg("-c")
        .arg("copy")
        // Some providers reconnect in short finite bursts whose timestamps
        // have small holes. Even ffmpeg's discontinuity correction can leave
        // those holes at the MSE boundary. setts is a bitstream filter, so it
        // repairs the packet clock without the CPU/quality cost of transcoding.
        .arg("-bsf:v")
        .arg(CONTIGUOUS_VIDEO_TIMESTAMPS)
        .arg("-bsf:a")
        .arg(CONTIGUOUS_AUDIO_TIMESTAMPS)
        .arg("-avoid_negative_ts")
        .arg("make_zero")
        .arg("-max_interleave_delta")
        .arg("1000000")
        .arg("-muxdelay")
        .arg("0")
        .arg("-muxpreload")
        .arg("0")
        .arg("-mpegts_flags")
        .arg("+resend_headers+initial_discontinuity")
        .arg("-flush_packets")
        .arg("1")
        .arg("-f")
        .arg("mpegts")
        .arg("pipe:1");

    command.spawn().map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("failed to start playback remux with {ffmpeg}: {error}"),
        )
    })
}

async fn forward_playback_remux_as_chunked_stream<W>(
    writer: &mut W,
    mut child: tokio::process::Child,
    upstream_url: &str,
) -> StreamForwardResult
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let Some(mut stdout) = child.stdout.take() else {
        graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
        return StreamForwardResult {
            outcome: StreamForwardOutcome::UpstreamReadError("ffmpeg stdout unavailable"),
            bytes_forwarded: 0,
        };
    };

    if let Some(stderr) = child.stderr.take() {
        let redacted = redact_url(upstream_url);
        let original = upstream_url.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[StreamProxy/remux] {}", line.replace(&original, &redacted));
            }
        });
    }

    let budget = Arc::new(tokio::sync::Semaphore::new(STREAM_PROXY_READ_AHEAD_BYTES));
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel(STREAM_PROXY_READ_AHEAD_CHUNKS);
    let reader = tokio::spawn(async move {
        loop {
            let mut chunk = vec![0u8; 64 * 1024];
            match stdout.read(&mut chunk).await {
                Ok(0) => return StreamForwardOutcome::Completed,
                Ok(read) => {
                    chunk.truncate(read);
                    let permits = read.min(STREAM_PROXY_READ_AHEAD_BYTES) as u32;
                    let permit = match budget.clone().acquire_many_owned(permits).await {
                        Ok(permit) => permit,
                        Err(_) => return StreamForwardOutcome::DownstreamClosed,
                    };
                    if chunk_tx.send((chunk, permit)).await.is_err() {
                        return StreamForwardOutcome::DownstreamClosed;
                    }
                }
                Err(_) => return StreamForwardOutcome::UpstreamReadError("ffmpeg stdout failed"),
            }
        }
    });

    let mut bytes_forwarded = 0u64;
    let mut pacer = TransportStreamPacer::with_max_lead(REMUX_PACER_MAX_LEAD);
    while let Some((chunk, _budget_permit)) = chunk_rx.recv().await {
        let delay = pacer.delay_for_payload(&chunk);
        if !pacer.announced && pacer.wall_anchor.is_some() {
            pacer.announced = true;
            log::info!("[StreamProxy/remux] Enabled normalized transport-clock pacing");
        }
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let size_line = format!("{:x}\r\n", chunk.len());
        if writer.write_all(size_line.as_bytes()).await.is_err()
            || writer.write_all(&chunk).await.is_err()
            || writer.write_all(b"\r\n").await.is_err()
        {
            reader.abort();
            graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
            return StreamForwardResult {
                outcome: StreamForwardOutcome::DownstreamClosed,
                bytes_forwarded,
            };
        }
        bytes_forwarded = bytes_forwarded.saturating_add(chunk.len() as u64);
    }

    let outcome = match reader.await {
        Ok(outcome) => outcome,
        Err(_) => StreamForwardOutcome::UpstreamReadError("ffmpeg reader task failed"),
    };
    let status = match tokio::time::timeout(GRACEFUL_KILL_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        _ => {
            graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
            None
        }
    };
    if status.is_some_and(|status| !status.success()) {
        log::warn!(
            "[StreamProxy/remux] ffmpeg stopped while streaming {}",
            redact_url(upstream_url)
        );
    }

    StreamForwardResult {
        outcome,
        bytes_forwarded,
    }
}

fn duration_to_pcr_ticks(duration: std::time::Duration) -> u64 {
    duration
        .as_secs()
        .saturating_mul(MPEG_TS_PCR_TICKS_PER_SECOND)
        .saturating_add(
            u64::from(duration.subsec_nanos()).saturating_mul(MPEG_TS_PCR_TICKS_PER_SECOND)
                / 1_000_000_000,
        )
}

fn duration_from_pcr_ticks(ticks: u64) -> std::time::Duration {
    let seconds = ticks / MPEG_TS_PCR_TICKS_PER_SECOND;
    let remainder = ticks % MPEG_TS_PCR_TICKS_PER_SECOND;
    let nanos = remainder.saturating_mul(1_000_000_000) / MPEG_TS_PCR_TICKS_PER_SECOND;
    std::time::Duration::new(seconds, nanos as u32)
}

fn latest_transport_stream_pcr(data: &[u8], preferred_pid: Option<u16>) -> Option<(u16, u64)> {
    if data.len() < MPEG_TS_PACKET_SIZE * 3 {
        return None;
    }

    // Lock onto one packet boundary using three sync bytes. Scanning every
    // 0x47 byte can mistake H.264 payload data for a TS header and feed bogus
    // PCR jumps into the pacer.
    let max_offset = MPEG_TS_PACKET_SIZE.min(data.len() - MPEG_TS_PACKET_SIZE * 2);
    let sync_offset = (0..max_offset).find(|offset| {
        data[*offset] == 0x47
            && data[*offset + MPEG_TS_PACKET_SIZE] == 0x47
            && data[*offset + MPEG_TS_PACKET_SIZE * 2] == 0x47
    })?;

    let mut latest = None;
    let mut offset = sync_offset;
    while offset + MPEG_TS_PACKET_SIZE <= data.len() {
        let packet = &data[offset..offset + MPEG_TS_PACKET_SIZE];
        if let Some(pid) = transport_stream_packet_pid(packet) {
            if preferred_pid.map_or(true, |preferred| preferred == pid) {
                if let Some(pcr) = transport_stream_packet_pcr(packet) {
                    latest = Some((pid, pcr));
                }
            }
        }
        offset += MPEG_TS_PACKET_SIZE;
    }
    latest
}

fn transport_stream_packet_pid(packet: &[u8]) -> Option<u16> {
    if packet.len() < MPEG_TS_PACKET_SIZE || packet[0] != 0x47 {
        return None;
    }
    Some((u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]))
}

fn transport_stream_packet_pcr(packet: &[u8]) -> Option<u64> {
    if packet.len() < MPEG_TS_PACKET_SIZE || packet[0] != 0x47 {
        return None;
    }
    let adaptation_control = (packet[3] >> 4) & 0x03;
    if adaptation_control != 0x02 && adaptation_control != 0x03 {
        return None;
    }
    let adaptation_length = packet[4] as usize;
    if adaptation_length < 7 || 5 + adaptation_length > MPEG_TS_PACKET_SIZE {
        return None;
    }
    if packet[5] & 0x10 == 0 {
        return None;
    }

    let pcr_base = (u64::from(packet[6]) << 25)
        | (u64::from(packet[7]) << 17)
        | (u64::from(packet[8]) << 9)
        | (u64::from(packet[9]) << 1)
        | (u64::from(packet[10]) >> 7);
    let pcr_extension = (u64::from(packet[10] & 0x01) << 8) | u64::from(packet[11]);
    Some(pcr_base * 300 + pcr_extension)
}

async fn forward_response_as_chunked_stream<W>(
    writer: &mut W,
    response: reqwest::Response,
    mut pacer: Option<&mut TransportStreamPacer>,
) -> StreamForwardResult
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut bytes_forwarded = 0u64;
    let budget = Arc::new(tokio::sync::Semaphore::new(STREAM_PROXY_READ_AHEAD_BYTES));
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel(STREAM_PROXY_READ_AHEAD_CHUNKS);
    let reader = tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    let permits = chunk.len().min(STREAM_PROXY_READ_AHEAD_BYTES) as u32;
                    let permit = match budget.clone().acquire_many_owned(permits).await {
                        Ok(permit) => permit,
                        Err(_) => return StreamForwardOutcome::DownstreamClosed,
                    };
                    if chunk_tx.send((chunk, permit)).await.is_err() {
                        return StreamForwardOutcome::DownstreamClosed;
                    }
                }
                Err(err) => {
                    return if err.is_timeout() {
                        StreamForwardOutcome::UpstreamReadTimeout
                    } else {
                        StreamForwardOutcome::UpstreamReadError(reqwest_error_kind(&err))
                    };
                }
            }
        }
        StreamForwardOutcome::Completed
    });

    while let Some((chunk, _budget_permit)) = chunk_rx.recv().await {
        if let Some(pacer) = pacer.as_deref_mut() {
            let delay = pacer.delay_for_payload(&chunk);
            if !pacer.announced && pacer.wall_anchor.is_some() {
                pacer.announced = true;
                log::info!("[StreamProxy] Enabled transport-clock pacing for bursty live stream");
            }
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
        }
        let size_line = format!("{:x}\r\n", chunk.len());
        if writer.write_all(size_line.as_bytes()).await.is_err()
            || writer.write_all(&chunk).await.is_err()
            || writer.write_all(b"\r\n").await.is_err()
        {
            reader.abort();
            return StreamForwardResult {
                outcome: StreamForwardOutcome::DownstreamClosed,
                bytes_forwarded,
            };
        }
        bytes_forwarded = bytes_forwarded.saturating_add(chunk.len() as u64);
    }

    let outcome = match reader.await {
        Ok(outcome) => outcome,
        Err(_) => StreamForwardOutcome::UpstreamReadError("reader task failed"),
    };

    StreamForwardResult {
        outcome,
        bytes_forwarded,
    }
}

async fn finish_chunked_stream<W>(writer: &mut W) -> bool
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    writer.write_all(b"0\r\n\r\n").await.is_ok()
}

fn stream_reconnect_delay(consecutive_empty_attempts: u32) -> std::time::Duration {
    let multiplier = 1u32 << consecutive_empty_attempts.min(4);
    STREAM_RECONNECT_BASE_DELAY
        .saturating_mul(multiplier)
        .min(STREAM_RECONNECT_MAX_DELAY)
}

async fn wait_for_stream_reconnect(
    socket: &mut tokio::net::TcpStream,
    delay: std::time::Duration,
) -> bool {
    use tokio::io::AsyncReadExt;

    let mut downstream_probe = [0u8; 1];
    match tokio::time::timeout(delay, socket.read(&mut downstream_probe)).await {
        Err(_) => true,
        Ok(Ok(0)) | Ok(Err(_)) => false,
        // The browser should not send another request on this Connection: close
        // response, but consuming an unexpected byte is harmless and lets the
        // reconnect proceed.
        Ok(Ok(_)) => true,
    }
}

// ---------------------------------------------------------------------------
// Localhost streaming proxy for MPEG-TS and other infinite-body streams.
// The Tauri URI scheme proxy buffers the full response, which fails for live
// streams. This lightweight TCP server streams bytes through without buffering.
// ---------------------------------------------------------------------------

/// Start a localhost HTTP proxy that streams upstream responses.
/// Returns the port the server is listening on.
pub async fn start_streaming_proxy(app: tauri::AppHandle) -> std::io::Result<u16> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    log::info!(
        "[StreamProxy] Localhost streaming proxy started on port {}",
        port
    );

    tokio::spawn(async move {
        loop {
            let (mut socket, _addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(err) => {
                    log::warn!("[StreamProxy] Accept error: {}", err);
                    continue;
                }
            };

            let app_handle = app.clone();
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
                let request = match parse_stream_request(&request_str) {
                    Some(request) => request,
                    None => {
                        let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                        let _ = socket.write_all(response.as_bytes()).await;
                        return;
                    }
                };
                let url = request.url;
                let reconnect = request.reconnect;

                if !is_safe_upstream_url(&url).await {
                    log::warn!("[StreamProxy] Blocked request to private/local target");
                    let response = "HTTP/1.1 403 Forbidden\r\nContent-Length: 22\r\n\r\nTarget URL not allowed";
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

                let user_agent = HeaderValue::from_str(&user_agent)
                    .unwrap_or_else(|_| HeaderValue::from_static("TiviMate/5.1.6 (Android 12)"));

                if request.remux {
                    let user_agent_text =
                        user_agent.to_str().unwrap_or("TiviMate/5.1.6 (Android 12)");
                    let child = match spawn_playback_remux(
                        &app_handle,
                        &url,
                        user_agent_text,
                        accept_invalid_certs,
                    ) {
                        Ok(child) => child,
                        Err(error) => {
                            log::warn!(
                                "[StreamProxy/remux] Could not start for {}: {}",
                                redact_url(&url),
                                error
                            );
                            let body = "Playback remux unavailable";
                            let response = format!(
                                "HTTP/1.1 502 Bad Gateway\r\nContent-Length: {}\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = socket.write_all(response.as_bytes()).await;
                            return;
                        }
                    };

                    let header = concat!(
                        "HTTP/1.1 200 OK\r\n",
                        "Content-Type: video/mp2t\r\n",
                        "Access-Control-Allow-Origin: *\r\n",
                        "Transfer-Encoding: chunked\r\n",
                        "Cache-Control: no-cache\r\n",
                        "Connection: close\r\n",
                        "\r\n"
                    );
                    if socket.write_all(header.as_bytes()).await.is_err() {
                        let mut child = child;
                        graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
                        return;
                    }

                    log::info!(
                        "[StreamProxy/remux] Normalizing live MPEG-TS timestamps for {}",
                        redact_url(&url)
                    );
                    let forward =
                        forward_playback_remux_as_chunked_stream(&mut socket, child, &url).await;
                    if forward.outcome != StreamForwardOutcome::DownstreamClosed {
                        let _ = finish_chunked_stream(&mut socket).await;
                    }
                    return;
                }

                let response = match client
                    .get(&url)
                    .header(USER_AGENT, user_agent.clone())
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

                // Error responses are finite and should be delivered normally.
                // Only successful live bodies are safe to concatenate after an
                // upstream reconnect.
                if !reconnect || !status.is_success() {
                    let _ = forward_response_as_chunked_stream(&mut socket, response, None).await;
                    let _ = finish_chunked_stream(&mut socket).await;
                    return;
                }

                let mut response = response;
                let mut pacer = TransportStreamPacer::new();
                let mut reconnects = 0u32;
                let mut consecutive_empty_attempts = 0u32;

                loop {
                    let forward =
                        forward_response_as_chunked_stream(&mut socket, response, Some(&mut pacer))
                            .await;
                    if forward.outcome == StreamForwardOutcome::DownstreamClosed {
                        log::debug!(
                            "[StreamProxy] Downstream disconnected while streaming {}",
                            redact_url(&url)
                        );
                        return;
                    }

                    if forward.bytes_forwarded > 0 {
                        consecutive_empty_attempts = 0;
                    } else {
                        consecutive_empty_attempts = consecutive_empty_attempts.saturating_add(1);
                    }
                    reconnects = reconnects.saturating_add(1);

                    match forward.outcome {
                        StreamForwardOutcome::Completed => log::warn!(
                            "[StreamProxy] Upstream stream ended for {}; reconnecting (#{})",
                            redact_url(&url),
                            reconnects
                        ),
                        StreamForwardOutcome::UpstreamReadTimeout => log::warn!(
                            "[StreamProxy] Upstream stream stalled/timed out for {}; reconnecting (#{})",
                            redact_url(&url),
                            reconnects
                        ),
                        StreamForwardOutcome::UpstreamReadError(kind) => log::warn!(
                            "[StreamProxy] Upstream stream terminated for {} ({}); reconnecting (#{})",
                            redact_url(&url),
                            kind,
                            reconnects
                        ),
                        StreamForwardOutcome::DownstreamClosed => unreachable!(),
                    }

                    loop {
                        let delay = stream_reconnect_delay(consecutive_empty_attempts);
                        if !wait_for_stream_reconnect(&mut socket, delay).await {
                            log::debug!(
                                "[StreamProxy] Downstream closed while reconnecting {}",
                                redact_url(&url)
                            );
                            return;
                        }

                        match client
                            .get(&url)
                            .header(USER_AGENT, user_agent.clone())
                            .send()
                            .await
                        {
                            Ok(next_response) if next_response.status().is_success() => {
                                response = next_response;
                                break;
                            }
                            Ok(next_response) => {
                                consecutive_empty_attempts =
                                    consecutive_empty_attempts.saturating_add(1);
                                log::warn!(
                                    "[StreamProxy] Reconnect for {} returned HTTP {}; retrying",
                                    redact_url(&url),
                                    next_response.status()
                                );
                            }
                            Err(err) => {
                                consecutive_empty_attempts =
                                    consecutive_empty_attempts.saturating_add(1);
                                log::warn!(
                                    "[StreamProxy] Reconnect failed for {} ({}); retrying",
                                    redact_url(&url),
                                    reqwest_error_kind(&err)
                                );
                            }
                        }
                    }
                }
            });
        }
    });

    Ok(port)
}

#[derive(Debug, PartialEq, Eq)]
struct StreamRequest {
    url: String,
    reconnect: bool,
    remux: bool,
}

fn parse_stream_request(request: &str) -> Option<StreamRequest> {
    let first_line = request.lines().next()?;
    // GET /stream?url=ENCODED HTTP/1.1
    let path = first_line.split_whitespace().nth(1)?;
    let url = Url::parse(&format!("http://localhost{path}")).ok()?;
    let mut upstream_url = None;
    let mut reconnect = false;
    let mut remux = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "url" => upstream_url = Some(value.into_owned()),
            "reconnect" => reconnect = value == "1" || value.eq_ignore_ascii_case("true"),
            "remux" => remux = value == "1" || value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    upstream_url.map(|url| StreamRequest {
        url,
        reconnect,
        remux,
    })
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
    fn redact_url_hides_xtream_path_credentials() {
        assert_eq!(
            redact_url("http://provider.example/live/user-name/pass-word/12345.ts"),
            "http://provider.example/live/***/***/12345.ts"
        );
        assert_eq!(
            redact_url("https://provider.example/user/pass/67890?token=secret"),
            "https://provider.example/***/***/67890?***"
        );
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
            parse_stream_request(request),
            Some(StreamRequest {
                url: "https://example.com/strøm?token=abc+123".to_string(),
                reconnect: false,
                remux: false,
            })
        );
    }

    #[test]
    fn parse_stream_request_enables_opt_in_reconnect() {
        let request = "GET /stream?url=https%3A%2F%2Fexample.com%2Flive.ts&reconnect=1 HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(
            parse_stream_request(request),
            Some(StreamRequest {
                url: "https://example.com/live.ts".to_string(),
                reconnect: true,
                remux: false,
            })
        );
    }

    #[test]
    fn parse_stream_request_enables_opt_in_remux() {
        let request = "GET /stream?url=https%3A%2F%2Fexample.com%2Flive.ts&reconnect=1&remux=true HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(
            parse_stream_request(request),
            Some(StreamRequest {
                url: "https://example.com/live.ts".to_string(),
                reconnect: true,
                remux: true,
            })
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
        let result = forward_response_as_chunked_stream(&mut sink, response, None).await;
        let elapsed = started.elapsed();

        assert_eq!(result.outcome, StreamForwardOutcome::Completed);
        assert_eq!(result.bytes_forwarded, 192);
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
        let result = forward_response_as_chunked_stream(&mut sink, response, None).await;

        assert_eq!(result.outcome, StreamForwardOutcome::UpstreamReadTimeout);
        assert_eq!(result.bytes_forwarded, 64);

        server_handle.await.expect("server task should finish");
    }

    #[tokio::test]
    async fn reconnected_upstreams_share_one_downstream_chunked_response() {
        let (first_url, first_server) = spawn_chunked_upstream(
            vec![TestStreamChunk {
                body: vec![0x01, 0x02],
                delay_after: Duration::ZERO,
            }],
            Duration::ZERO,
        )
        .await;
        let (second_url, second_server) = spawn_chunked_upstream(
            vec![TestStreamChunk {
                body: vec![0x03, 0x04, 0x05],
                delay_after: Duration::ZERO,
            }],
            Duration::ZERO,
        )
        .await;
        let client = build_proxy_client(false, Duration::from_secs(1), Duration::from_secs(1));
        let first_response = client.get(&first_url).send().await.unwrap();
        let second_response = client.get(&second_url).send().await.unwrap();
        let mut downstream = Vec::new();

        let first = forward_response_as_chunked_stream(&mut downstream, first_response, None).await;
        let second =
            forward_response_as_chunked_stream(&mut downstream, second_response, None).await;
        assert!(finish_chunked_stream(&mut downstream).await);

        assert_eq!(first.bytes_forwarded, 2);
        assert_eq!(second.bytes_forwarded, 3);
        assert_eq!(
            downstream,
            b"2\r\n\x01\x02\r\n3\r\n\x03\x04\x05\r\n0\r\n\r\n"
        );
        first_server.await.expect("first server task should finish");
        second_server
            .await
            .expect("second server task should finish");
    }

    #[test]
    fn reconnect_delay_backs_off_and_caps() {
        assert_eq!(stream_reconnect_delay(0), Duration::from_millis(500));
        assert_eq!(stream_reconnect_delay(1), Duration::from_secs(1));
        assert_eq!(stream_reconnect_delay(3), Duration::from_secs(4));
        assert_eq!(stream_reconnect_delay(8), Duration::from_secs(5));
    }

    #[test]
    fn parses_mpeg_ts_program_clock_reference() {
        let pcr_base = 123_456_789u64;
        let pcr_extension = 42u64;
        let mut packet = vec![0xff; MPEG_TS_PACKET_SIZE];
        packet[0] = 0x47;
        packet[1] = 0x01;
        packet[2] = 0x00;
        packet[3] = 0x20;
        packet[4] = 7;
        packet[5] = 0x10;
        packet[6] = (pcr_base >> 25) as u8;
        packet[7] = (pcr_base >> 17) as u8;
        packet[8] = (pcr_base >> 9) as u8;
        packet[9] = (pcr_base >> 1) as u8;
        packet[10] = (((pcr_base & 1) << 7) | 0x7e | (pcr_extension >> 8)) as u8;
        packet[11] = pcr_extension as u8;

        assert_eq!(
            transport_stream_packet_pcr(&packet),
            Some(pcr_base * 300 + pcr_extension)
        );
        assert_eq!(
            duration_from_pcr_ticks(MPEG_TS_PCR_TICKS_PER_SECOND),
            Duration::from_secs(1)
        );
    }

    #[test]
    fn pcr_discontinuity_preserves_accumulated_pacing_budget() {
        let make_payload = |milliseconds: &[u64]| {
            let mut payload = Vec::with_capacity(milliseconds.len() * MPEG_TS_PACKET_SIZE);
            for millisecond in milliseconds {
                let pcr_base = millisecond * 90;
                let mut packet = vec![0xff; MPEG_TS_PACKET_SIZE];
                packet[0] = 0x47;
                packet[1] = 0x01;
                packet[2] = 0x00;
                packet[3] = 0x20;
                packet[4] = 7;
                packet[5] = 0x10;
                packet[6] = (pcr_base >> 25) as u8;
                packet[7] = (pcr_base >> 17) as u8;
                packet[8] = (pcr_base >> 9) as u8;
                packet[9] = (pcr_base >> 1) as u8;
                packet[10] = (((pcr_base & 1) << 7) | 0x7e) as u8;
                packet[11] = 0;
                payload.extend_from_slice(&packet);
            }
            payload
        };

        let mut pacer = TransportStreamPacer::new();
        assert_eq!(
            pacer.delay_for_payload(&make_payload(&[0, 0, 0])),
            Duration::ZERO
        );
        for step in 1..=360 {
            let milliseconds = step * 250;
            assert_eq!(
                pacer
                    .delay_for_payload(&make_payload(&[milliseconds, milliseconds, milliseconds,])),
                Duration::ZERO
            );
        }
        let first_delay = pacer.delay_for_payload(&make_payload(&[90_250, 90_250, 90_250]));
        assert!(first_delay > Duration::from_millis(200));
        pacer.wall_anchor = pacer.wall_anchor.map(|anchor| anchor - first_delay);

        let second_delay = pacer.delay_for_payload(&make_payload(&[90_500, 90_500, 90_500]));
        assert!(second_delay > Duration::from_millis(200));
        pacer.wall_anchor = pacer.wall_anchor.map(|anchor| anchor - second_delay);

        assert_eq!(
            pacer.delay_for_payload(&make_payload(&[200_000, 200_000, 200_000])),
            Duration::ZERO
        );
        assert!(
            pacer.delay_for_payload(&make_payload(&[200_250, 200_250, 200_250]))
                > Duration::from_millis(200)
        );
        assert_eq!(pacer.reanchor_count, 0);
    }

    #[test]
    fn pcr_pacer_reanchors_instead_of_returning_a_starvation_delay() {
        let make_payload = |milliseconds: &[u64]| {
            let mut payload = Vec::with_capacity(milliseconds.len() * MPEG_TS_PACKET_SIZE);
            for millisecond in milliseconds {
                let pcr_base = millisecond * 90;
                let mut packet = vec![0xff; MPEG_TS_PACKET_SIZE];
                packet[0] = 0x47;
                packet[1] = 0x01;
                packet[2] = 0x00;
                packet[3] = 0x20;
                packet[4] = 7;
                packet[5] = 0x10;
                packet[6] = (pcr_base >> 25) as u8;
                packet[7] = (pcr_base >> 17) as u8;
                packet[8] = (pcr_base >> 9) as u8;
                packet[9] = (pcr_base >> 1) as u8;
                packet[10] = (((pcr_base & 1) << 7) | 0x7e) as u8;
                packet[11] = 0;
                payload.extend_from_slice(&packet);
            }
            payload
        };

        let mut pacer = TransportStreamPacer::new();
        assert_eq!(
            pacer.delay_for_payload(&make_payload(&[0, 0, 0])),
            Duration::ZERO
        );
        for step in 1..=360 {
            let milliseconds = step * 250;
            assert_eq!(
                pacer
                    .delay_for_payload(&make_payload(&[milliseconds, milliseconds, milliseconds,])),
                Duration::ZERO
            );
        }
        assert!(
            pacer.delay_for_payload(&make_payload(&[90_250, 90_250, 90_250]))
                > Duration::from_millis(200)
        );
        for step in 362..=380 {
            let milliseconds = step * 250;
            assert!(!pacer
                .delay_for_payload(&make_payload(&[milliseconds, milliseconds, milliseconds,]))
                .is_zero());
        }
        assert_eq!(
            pacer.delay_for_payload(&make_payload(&[95_250, 95_250, 95_250])),
            Duration::ZERO
        );
        assert_eq!(pacer.reanchor_count, 1);
        assert_eq!(
            pacer.media_elapsed_ticks,
            duration_to_pcr_ticks(pacer.max_lead)
        );

        let resumed_delay = pacer.delay_for_payload(&make_payload(&[95_500, 95_500, 95_500]));
        assert!(resumed_delay > Duration::from_millis(200));
        assert!(resumed_delay <= STREAM_PACER_MAX_DELAY);
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
