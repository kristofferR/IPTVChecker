//! LAN-bound HTTP proxy used to stream upstream IPTV content to a Chromecast.
//!
//! Unlike the in-app `stream_proxy` (which binds to 127.0.0.1 for the
//! webview), the cast proxy binds to `0.0.0.0` so the Chromecast on the LAN
//! can reach it. Each session generates a fresh random token; only requests
//! whose path starts with `/cast/<token>/` are served, so this short-lived,
//! per-session listener does not become an open relay.
//!
//! Two modes:
//! - **HLS pass-through** (`/cast/<token>/stream` + `/cast/<token>/seg/<b64>`):
//!   used when the upstream is already an HLS playlist. The proxy fetches the
//!   manifest, rewrites segment/key URIs to round-trip through itself, and
//!   forwards segments untouched.
//! - **Remux** (`/cast/<token>/hls/playlist.m3u8` + `/cast/<token>/hls/seg_NNNNN.ts`):
//!   used when the upstream is MPEG-TS. ffmpeg is spawned in copy mode to
//!   produce a sliding-window HLS playlist in a temp directory, which is then
//!   served from disk.
//!
//! Lifecycle: [`start`] returns a [`CastProxyHandle`] containing the bound
//! address and a cancel guard; dropping the handle (or calling `shutdown`)
//! tears the listener down, aborts in-flight forwarders, kills ffmpeg, and
//! removes the temp directory.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{HeaderValue, CONTENT_TYPE, USER_AGENT};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::Child;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::engine::ffmpeg::{configure_background_process, graceful_kill, resolve_binary, GRACEFUL_KILL_TIMEOUT};
use crate::engine::stream_proxy::redact_url;
use crate::error::AppError;
use crate::models::chromecast::CastStreamKind;
use crate::state::AppState;

const CAST_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CAST_READ_TIMEOUT: Duration = Duration::from_secs(20);
const MANIFEST_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const REMUX_PLAYLIST_READY_TIMEOUT: Duration = Duration::from_secs(20);
const REMUX_PLAYLIST_POLL_INTERVAL: Duration = Duration::from_millis(150);

pub struct CastProxyHandle {
    pub url: String,
    pub host: IpAddr,
    pub port: u16,
    pub token: String,
    cancel: CancellationToken,
    remux: Arc<Mutex<Option<RemuxState>>>,
}

impl CastProxyHandle {
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl Drop for CastProxyHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
        // Best-effort sync cleanup: try to lock without awaiting and clean up
        // the remux directory. The tokio task spawned in `start_remux` has its
        // own cleanup hook tied to the cancel token, which handles the killing
        // of ffmpeg and tempdir removal in the async context.
        if let Ok(mut guard) = self.remux.try_lock() {
            if let Some(state) = guard.take() {
                state.cleanup_blocking();
            }
        }
    }
}

struct RemuxState {
    tmpdir: PathBuf,
    /// ffmpeg child handle. We hold it for diagnostic logging; the worker task
    /// is responsible for waiting on it.
    child: Option<Child>,
}

impl RemuxState {
    fn cleanup_blocking(self) {
        // Best-effort sync cleanup used in Drop. The async cleanup path in
        // `cleanup` is preferred when available.
        let RemuxState { tmpdir, mut child } = self;
        if let Some(c) = child.as_mut() {
            let _ = c.start_kill();
        }
        // We deliberately don't `wait()` here — the spawned worker task will.
        // Just attempt to remove the directory; if files are still open it
        // will be cleaned up by the OS on next reboot.
        let _ = std::fs::remove_dir_all(&tmpdir);
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
/// cast URL until cancelled. For MPEG-TS sources, spawns ffmpeg to remux into
/// HLS so Chromecast can consume the stream.
pub async fn start(
    app: AppHandle,
    upstream_url: String,
    stream_kind: CastStreamKind,
) -> Result<CastProxyHandle, AppError> {
    let token = generate_token();
    let lan_ip = detect_lan_ip()
        .ok_or_else(|| AppError::Other("Could not determine LAN IP for cast proxy".to_string()))?;

    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(AppError::Io)?;
    let port = listener.local_addr().map_err(AppError::Io)?.port();

    let cancel = CancellationToken::new();
    let remux_state: Arc<Mutex<Option<RemuxState>>> = Arc::new(Mutex::new(None));
    // Final URL of the manifest after redirects, populated on the first
    // successful manifest fetch in `serve_upstream`. Used as the same-origin
    // anchor for segment-fetch validation so CDN-fronted streams (where the
    // operator URL 302s into a different host) don't self-reject.
    let resolved_origin: Arc<Mutex<Option<Url>>> = Arc::new(Mutex::new(None));

    // Build one HTTP client for the entire cast session. Cookies set on the
    // manifest response must persist into segment requests, so we cannot
    // reconstruct the client per call.
    let (user_agent, accept_invalid_certs) = {
        let state = app.state::<Arc<AppState>>();
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
    let client = Arc::new(client);

    let cast_url = if stream_kind == CastStreamKind::MpegTs {
        let started = start_remux(
            app.clone(),
            upstream_url.clone(),
            token.clone(),
            cancel.clone(),
            remux_state.clone(),
        )
        .await?;
        format!(
            "http://{lan_ip}:{port}/cast/{token}/hls/{}",
            started.playlist_filename
        )
    } else {
        format!("http://{lan_ip}:{port}/cast/{token}/stream")
    };

    log::info!(
        "[CastProxy] Listening on 0.0.0.0:{port} (advertising {lan_ip}:{port}) for {} (mode={:?})",
        redact_url(&upstream_url),
        stream_kind
    );

    let cancel_for_loop = cancel.clone();
    let token_clone = token.clone();
    let upstream_clone = upstream_url.clone();
    let remux_for_loop = remux_state.clone();
    let client_for_loop = client.clone();
    let user_agent_for_loop = user_agent.clone();
    let resolved_origin_for_loop = resolved_origin.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_for_loop.cancelled() => {
                    log::info!("[CastProxy] Listener on port {port} cancelled");
                    // Clean up remux state if any
                    let mut guard = remux_for_loop.lock().await;
                    if let Some(state) = guard.take() {
                        cleanup_remux_async(state).await;
                    }
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
                    let token_for_conn = token_clone.clone();
                    let upstream_for_conn = upstream_clone.clone();
                    let cancel_for_conn = cancel_for_loop.clone();
                    let remux_for_conn = remux_for_loop.clone();
                    let client_for_conn = client_for_loop.clone();
                    let user_agent_for_conn = user_agent_for_loop.clone();
                    let resolved_origin_for_conn = resolved_origin_for_loop.clone();
                    tokio::spawn(async move {
                        if let Err(err) = handle_connection(
                            socket,
                            peer.to_string(),
                            token_for_conn,
                            upstream_for_conn,
                            remux_for_conn,
                            cancel_for_conn,
                            client_for_conn,
                            user_agent_for_conn,
                            resolved_origin_for_conn,
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
        remux: remux_state,
    })
}

struct RemuxStartInfo {
    playlist_filename: String,
}

/// Spawn ffmpeg to remux the upstream MPEG-TS into a sliding-window HLS
/// playlist on disk. Waits for the playlist file to appear (so the Cast
/// device's first GET doesn't 404) before returning.
async fn start_remux(
    app: AppHandle,
    upstream_url: String,
    token: String,
    cancel: CancellationToken,
    remux_state: Arc<Mutex<Option<RemuxState>>>,
) -> Result<RemuxStartInfo, AppError> {
    let tmpdir = std::env::temp_dir().join(format!("iptv-cast-{token}"));
    std::fs::create_dir_all(&tmpdir).map_err(AppError::Io)?;

    let (user_agent, accept_invalid_certs) = {
        let state = app.state::<Arc<AppState>>();
        let settings = state.settings.lock().await;
        (settings.user_agent.clone(), settings.accept_invalid_certs)
    };

    let ffmpeg_bin = resolve_binary(&app, "ffmpeg");
    let playlist_path = tmpdir.join("playlist.m3u8");
    let segment_pattern = tmpdir.join("seg_%05d.ts");

    let mut cmd = tokio::process::Command::new(&ffmpeg_bin);
    configure_background_process(&mut cmd);
    cmd.kill_on_drop(true);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    cmd.arg("-hide_banner").arg("-loglevel").arg("warning");
    cmd.arg("-fflags").arg("+genpts+discardcorrupt");
    cmd.arg("-user_agent").arg(&user_agent);
    // `-tls_verify` is a private option of the TLS protocol — only add it
    // when the URL actually uses HTTPS, otherwise some ffmpeg builds reject
    // it as "Option not found" and abort the whole pipeline before the input
    // is even opened.
    if accept_invalid_certs && upstream_url.to_ascii_lowercase().starts_with("https://") {
        cmd.arg("-tls_verify").arg("0");
    }
    cmd.arg("-reconnect").arg("1");
    cmd.arg("-reconnect_streamed").arg("1");
    cmd.arg("-reconnect_delay_max").arg("5");
    cmd.arg("-i").arg(&upstream_url);
    cmd.arg("-c").arg("copy");
    cmd.arg("-f").arg("hls");
    cmd.arg("-hls_time").arg("4");
    cmd.arg("-hls_list_size").arg("6");
    cmd.arg("-hls_flags")
        .arg("delete_segments+omit_endlist+independent_segments");
    cmd.arg("-hls_segment_filename").arg(&segment_pattern);
    cmd.arg(&playlist_path);

    log::info!(
        "[CastProxy] Spawning ffmpeg remux for {} → {}",
        redact_url(&upstream_url),
        playlist_path.display()
    );

    let mut child = cmd.spawn().map_err(|err| {
        AppError::Other(format!(
            "Failed to spawn ffmpeg for cast remux ({ffmpeg_bin}): {err}"
        ))
    })?;

    // Drain stderr so the pipe doesn't fill and stall ffmpeg. Also useful for
    // diagnostics when remux fails.
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[CastProxy/ffmpeg] {line}");
            }
        });
    }

    // Park the child on the worker so we can wait on it; cancel kills it.
    let cancel_for_worker = cancel.clone();
    let tmpdir_for_worker = tmpdir.clone();
    let upstream_for_worker = upstream_url.clone();
    let remux_state_for_worker = remux_state.clone();
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                match status {
                    Ok(s) if s.success() => {
                        log::info!(
                            "[CastProxy/ffmpeg] Exited cleanly for {}",
                            redact_url(&upstream_for_worker)
                        );
                    }
                    Ok(s) => {
                        log::warn!(
                            "[CastProxy/ffmpeg] Exited with status {:?} for {}",
                            s.code(),
                            redact_url(&upstream_for_worker)
                        );
                    }
                    Err(err) => {
                        log::warn!("[CastProxy/ffmpeg] wait() failed: {err}");
                    }
                }
                // ffmpeg ended on its own — also cancel the listener so the
                // session tears down rather than serving a dead playlist.
                cancel_for_worker.cancel();
                let mut guard = remux_state_for_worker.lock().await;
                if let Some(state) = guard.take() {
                    cleanup_remux_async(state).await;
                }
            }
            _ = cancel_for_worker.cancelled() => {
                log::info!("[CastProxy/ffmpeg] Cancellation received, terminating");
                graceful_kill(&mut child, GRACEFUL_KILL_TIMEOUT).await;
                let _ = std::fs::remove_dir_all(&tmpdir_for_worker);
            }
        }
    });

    // Wait for the playlist to actually be written so the Cast device's first
    // GET doesn't 404. On failure, trip the cancel so the spawned ffmpeg
    // worker terminates and removes the temp dir.
    if let Err(err) = wait_for_playlist(&playlist_path, REMUX_PLAYLIST_READY_TIMEOUT, &cancel).await
    {
        cancel.cancel();
        return Err(err);
    }

    {
        let mut guard = remux_state.lock().await;
        *guard = Some(RemuxState {
            tmpdir: tmpdir.clone(),
            child: None,
        });
    }

    Ok(RemuxStartInfo {
        playlist_filename: "playlist.m3u8".to_string(),
    })
}

async fn wait_for_playlist(
    path: &Path,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), AppError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if path.exists() {
            // Wait for at least one segment line to appear so the Chromecast
            // doesn't request an empty playlist.
            if let Ok(content) = tokio::fs::read_to_string(path).await {
                if content.contains("#EXTINF") {
                    return Ok(());
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(AppError::Other(
                "Cast remux was cancelled before playlist became ready".to_string(),
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Other(
                "ffmpeg did not produce an HLS playlist in time".to_string(),
            ));
        }
        tokio::time::sleep(REMUX_PLAYLIST_POLL_INTERVAL).await;
    }
}

async fn cleanup_remux_async(state: RemuxState) {
    let RemuxState { tmpdir, mut child } = state;
    if let Some(c) = child.as_mut() {
        graceful_kill(c, GRACEFUL_KILL_TIMEOUT).await;
    }
    let _ = tokio::fs::remove_dir_all(&tmpdir).await;
}

async fn handle_connection(
    mut socket: tokio::net::TcpStream,
    peer: String,
    token: String,
    upstream_url: String,
    remux_state: Arc<Mutex<Option<RemuxState>>>,
    cancel: CancellationToken,
    client: Arc<reqwest::Client>,
    user_agent: String,
    resolved_origin: Arc<Mutex<Option<Url>>>,
) -> std::io::Result<()> {
    let mut buf = vec![0u8; 8192];
    let n = socket.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buf[..n]);
    let method = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .unwrap_or("?")
        .to_string();
    let path = match parse_request_path(&request) {
        Some(p) => p,
        None => {
            let _ = write_simple(&mut socket, 400, "text/plain", b"Bad request").await;
            return Ok(());
        }
    };
    log::info!("[CastProxy] {method} {path} from {peer}");

    // Chromecast CAF receivers send a CORS preflight (OPTIONS) before fetching
    // adaptive media. Answer it directly with the same allow-* headers we
    // attach to real responses.
    if method.eq_ignore_ascii_case("OPTIONS") {
        let header = "HTTP/1.1 204 No Content\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, Range, Accept-Encoding, Origin, User-Agent\r\n\
             Access-Control-Max-Age: 86400\r\n\
             Content-Length: 0\r\n\
             Connection: close\r\n\
             \r\n";
        let _ = socket.write_all(header.as_bytes()).await;
        return Ok(());
    }

    let allowed_prefix = format!("/cast/{token}/");
    if !path.starts_with(&allowed_prefix) {
        log::warn!("[CastProxy] Rejecting request with bad token from {peer}");
        let _ = write_simple(&mut socket, 403, "text/plain", b"Forbidden").await;
        return Ok(());
    }

    let suffix = &path[allowed_prefix.len()..];

    // Remux mode: serve files from the on-disk HLS directory.
    if let Some(rest) = suffix.strip_prefix("hls/") {
        let tmpdir_opt = {
            let guard = remux_state.lock().await;
            guard.as_ref().map(|s| s.tmpdir.clone())
        };
        let Some(tmpdir) = tmpdir_opt else {
            let _ = write_simple(&mut socket, 503, "text/plain", b"Remux not ready").await;
            return Ok(());
        };
        return serve_remux_file(&mut socket, &tmpdir, rest).await;
    }

    // Pass-through mode: entrypoint or rewritten manifest segment.
    let resolved_upstream = if let Some(encoded) = suffix.strip_prefix("seg/") {
        let decoded = match decode_segment(encoded) {
            Some(url) => url,
            None => {
                let _ = write_simple(&mut socket, 400, "text/plain", b"Bad segment").await;
                return Ok(());
            }
        };
        // Defense in depth: even though `rewrite_manifest` only emits
        // same-origin segment URLs, anyone who learns the token could craft
        // a `/cast/<token>/seg/<b64>` request to make us SSRF. Validate that
        // the decoded URL still shares origin with the upstream we were
        // started for.
        let decoded_url = match Url::parse(&decoded) {
            Ok(u) => u,
            Err(_) => {
                let _ = write_simple(&mut socket, 400, "text/plain", b"Bad segment").await;
                return Ok(());
            }
        };
        // Validate against the manifest's resolved origin if we've fetched it
        // already (post-redirect, so CDN-fronted streams aren't self-rejected),
        // falling back to the operator-supplied URL if the manifest hasn't
        // been fetched yet — and accept either origin if both are available
        // (some master playlists reference sub-playlists/segments on a
        // separate CDN host).
        let resolved_base = resolved_origin.lock().await.clone();
        let upstream_base = Url::parse(&upstream_url).ok();
        let allowed = match (&resolved_base, &upstream_base) {
            (Some(r), Some(u)) => {
                is_target_allowed(r, &decoded_url) || is_target_allowed(u, &decoded_url)
            }
            (Some(r), None) => is_target_allowed(r, &decoded_url),
            (None, Some(u)) => is_target_allowed(u, &decoded_url),
            (None, None) => false,
        };
        if !allowed {
            let base_label = resolved_base
                .as_ref()
                .or(upstream_base.as_ref())
                .map(|u| u.as_str().to_string())
                .unwrap_or_default();
            log::warn!(
                "[CastProxy] Rejected out-of-origin segment fetch for {} (base {})",
                redact_url(decoded_url.as_str()),
                redact_url(&base_label)
            );
            let _ = write_simple(&mut socket, 403, "text/plain", b"Forbidden").await;
            return Ok(());
        }
        decoded
    } else if suffix == "stream" {
        upstream_url.clone()
    } else {
        let _ = write_simple(&mut socket, 404, "text/plain", b"Not found").await;
        return Ok(());
    };

    serve_upstream(
        &mut socket,
        resolved_upstream,
        token,
        cancel,
        client,
        user_agent,
        resolved_origin,
    )
    .await
}

async fn serve_remux_file(
    socket: &mut tokio::net::TcpStream,
    tmpdir: &Path,
    relative: &str,
) -> std::io::Result<()> {
    // Reject path traversal: allow only simple filenames, no slashes.
    if relative.contains('/') || relative.contains("..") || relative.is_empty() {
        let _ = write_simple(socket, 400, "text/plain", b"Bad path").await;
        return Ok(());
    }
    let file_path = tmpdir.join(relative);
    let bytes = match tokio::fs::read(&file_path).await {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let _ = write_simple(socket, 404, "text/plain", b"Not found").await;
            return Ok(());
        }
        Err(err) => {
            log::warn!("[CastProxy] Failed to read remux file {file_path:?}: {err}");
            let _ = write_simple(socket, 500, "text/plain", b"Read error").await;
            return Ok(());
        }
    };
    let content_type = if relative.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if relative.ends_with(".ts") {
        "video/mp2t"
    } else {
        "application/octet-stream"
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-cache\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Range, Accept-Encoding, Origin, User-Agent\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Date\r\n\
         Connection: close\r\n\
         \r\n",
        len = bytes.len()
    );
    socket.write_all(header.as_bytes()).await?;
    socket.write_all(&bytes).await?;
    Ok(())
}

async fn serve_upstream(
    socket: &mut tokio::net::TcpStream,
    upstream_url: String,
    token: String,
    cancel: CancellationToken,
    client: Arc<reqwest::Client>,
    user_agent: String,
    resolved_origin: Arc<Mutex<Option<Url>>>,
) -> std::io::Result<()> {
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
        // Remember the manifest's resolved origin so subsequent segment
        // requests are validated against the same base used to rewrite the
        // segment URIs (otherwise CDN-fronted streams would self-reject).
        if let Ok(parsed) = Url::parse(&final_url) {
            let mut guard = resolved_origin.lock().await;
            *guard = Some(parsed);
        }
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
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, Range, Accept-Encoding, Origin, User-Agent\r\n\
             Access-Control-Expose-Headers: Content-Length, Content-Range, Date\r\n\
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
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Range, Accept-Encoding, Origin, User-Agent\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Date\r\n\
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
        "HTTP/1.1 {status}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {len}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\
         \r\n",
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

/// Reject non-HTTP(S) schemes and any target whose origin doesn't match the
/// base URL. The base URL itself is the operator-supplied stream we already
/// trust, so by pinning to its origin we prevent a malicious manifest from
/// pointing at loopback, RFC1918, or metadata endpoints. We deliberately do
/// not try to resolve hostnames (no DNS) — same-origin pinning is sufficient
/// because the operator already accepted the original host.
fn is_target_allowed(base: &Url, target: &Url) -> bool {
    if !matches!(target.scheme(), "http" | "https") {
        return false;
    }
    if target.scheme() != base.scheme() {
        return false;
    }
    if target.host_str() != base.host_str() {
        return false;
    }
    target.port_or_known_default() == base.port_or_known_default()
}

/// Rewrite all URI references in an HLS manifest to come back through this
/// proxy, so the Chromecast only ever talks to us. We base64url-encode the
/// resolved upstream URL into the path so we don't need persistent state.
/// Targets that don't pass [`is_target_allowed`] are left unrewritten — the
/// Cast device will then attempt them directly (and likely fail), but the
/// proxy refuses to act as a confused-deputy fetcher for them.
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
            Ok(resolved) if is_target_allowed(&base, &resolved) => {
                out.push_str(&format!("/cast/{token}/seg/{}", encode_segment(resolved.as_str())));
            }
            Ok(rejected) => {
                log::warn!(
                    "[CastProxy] Refusing to proxy out-of-origin segment {} (base {})",
                    redact_url(rejected.as_str()),
                    redact_url(base.as_str())
                );
                out.push_str(line);
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
        Ok(u) if is_target_allowed(base, &u) => u,
        Ok(rejected) => {
            log::warn!(
                "[CastProxy] Refusing to proxy out-of-origin tag URI {} (base {})",
                redact_url(rejected.as_str()),
                redact_url(base.as_str())
            );
            return line.to_string();
        }
        Err(_) => return line.to_string(),
    };
    let new_uri = format!("/cast/{token}/seg/{}", encode_segment(resolved.as_str()));

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

    #[test]
    fn rewrite_manifest_drops_cross_origin_segments() {
        let manifest = "\
#EXTM3U
#EXTINF:6.0,
http://127.0.0.1:9000/internal.ts
#EXTINF:6.0,
http://iptv.example.com/live/720p/seg-2.ts
";
        let base = "http://iptv.example.com/live/720p/index.m3u8";
        let rewritten = rewrite_manifest(manifest, base, "abc");
        // Loopback segment must remain unrewritten (no /cast/abc/seg/ prefix).
        assert!(
            rewritten.contains("http://127.0.0.1:9000/internal.ts"),
            "loopback line should be left untouched: {rewritten}"
        );
        let internal_b64 = encode_segment("http://127.0.0.1:9000/internal.ts");
        assert!(
            !rewritten.contains(&internal_b64),
            "loopback segment must not be encoded into a /seg/ URL: {rewritten}"
        );
        // Same-origin segment still rewritten.
        let allowed_b64 = encode_segment("http://iptv.example.com/live/720p/seg-2.ts");
        assert!(
            rewritten.contains(&format!("/cast/abc/seg/{allowed_b64}")),
            "same-origin segment must be rewritten: {rewritten}"
        );
    }

    #[test]
    fn is_target_allowed_blocks_non_http() {
        let base = Url::parse("http://iptv.example.com/live/index.m3u8").unwrap();
        let target = Url::parse("file:///etc/passwd").unwrap();
        assert!(!is_target_allowed(&base, &target));
    }

    #[test]
    fn is_target_allowed_blocks_cross_origin() {
        let base = Url::parse("http://iptv.example.com/live/index.m3u8").unwrap();
        assert!(!is_target_allowed(
            &base,
            &Url::parse("http://127.0.0.1/x").unwrap()
        ));
        assert!(!is_target_allowed(
            &base,
            &Url::parse("http://other.example.com/x").unwrap()
        ));
        assert!(!is_target_allowed(
            &base,
            &Url::parse("https://iptv.example.com/x").unwrap()
        ));
        assert!(!is_target_allowed(
            &base,
            &Url::parse("http://iptv.example.com:9000/x").unwrap()
        ));
    }

    #[test]
    fn is_target_allowed_accepts_same_origin() {
        let base = Url::parse("http://iptv.example.com/live/index.m3u8").unwrap();
        assert!(is_target_allowed(
            &base,
            &Url::parse("http://iptv.example.com/live/seg.ts").unwrap()
        ));
        assert!(is_target_allowed(
            &base,
            &Url::parse("http://iptv.example.com:80/live/seg.ts").unwrap()
        ));
    }

    /// Mirrors the segment-fetch acceptance logic in `handle_connection`. We
    /// keep it as a test-local helper so the pairwise check is exercised
    /// without spinning up sockets.
    fn segment_accepted(
        resolved: Option<&Url>,
        upstream: Option<&Url>,
        decoded: &Url,
    ) -> bool {
        match (resolved, upstream) {
            (Some(r), Some(u)) => is_target_allowed(r, decoded) || is_target_allowed(u, decoded),
            (Some(r), None) => is_target_allowed(r, decoded),
            (None, Some(u)) => is_target_allowed(u, decoded),
            (None, None) => false,
        }
    }

    #[test]
    fn segment_accepted_after_redirect_to_cdn() {
        // Operator URL — what the user typed in / what the proxy was started with.
        let upstream = Url::parse("http://provider.example/stream.m3u8").unwrap();
        // Final URL after the manifest fetch followed a 302 to the CDN.
        let resolved = Url::parse("http://cdn.example/stream.m3u8").unwrap();
        // Segment URI rewritten against the CDN base.
        let cdn_segment = Url::parse("http://cdn.example/seg-1.ts").unwrap();

        // Without resolved_origin populated yet (e.g. seg request races ahead
        // of the manifest, which shouldn't happen but we want a clean fail
        // rather than a random pass), the CDN segment must be rejected.
        assert!(!segment_accepted(None, Some(&upstream), &cdn_segment));

        // With resolved_origin populated by the manifest fetch, the CDN
        // segment is accepted — this is the regression the redirect-aware
        // allowlist exists to fix.
        assert!(segment_accepted(Some(&resolved), Some(&upstream), &cdn_segment));

        // A segment on the operator host (still legitimate during transition)
        // is accepted as long as either origin matches.
        let provider_segment = Url::parse("http://provider.example/seg-2.ts").unwrap();
        assert!(segment_accepted(Some(&resolved), Some(&upstream), &provider_segment));

        // A loopback or unrelated host is still rejected even with both
        // origins populated.
        let loopback = Url::parse("http://127.0.0.1:9000/x.ts").unwrap();
        assert!(!segment_accepted(Some(&resolved), Some(&upstream), &loopback));
    }

    #[test]
    fn rewrite_manifest_uses_post_redirect_base() {
        // Simulates the case where the manifest was fetched from
        // provider.example but redirected to cdn.example — `serve_upstream`
        // calls rewrite_manifest with the post-redirect URL, and the rewritten
        // segments encode CDN URLs. The redirect-aware seg validator on the
        // fetch boundary then accepts those CDN segments.
        let manifest = "\
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg-1.ts
";
        let cdn_final_url = "http://cdn.example/live/720p/index.m3u8";
        let rewritten = rewrite_manifest(manifest, cdn_final_url, "tok");
        let cdn_b64 = encode_segment("http://cdn.example/live/720p/seg-1.ts");
        assert!(
            rewritten.contains(&format!("/cast/tok/seg/{cdn_b64}")),
            "rewrite must encode the CDN URL: {rewritten}"
        );
    }
}
