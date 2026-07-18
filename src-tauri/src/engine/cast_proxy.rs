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
//! - **Remux** (`/cast/<token>/hls/<manifest>` + sibling segment files):
//!   used when the upstream is MPEG-TS. ffmpeg is spawned in copy mode to
//!   produce a sliding-window manifest in a temp directory, which is then
//!   served from disk. H.264 streams produce HLS+TS (`playlist.m3u8` + .ts);
//!   HEVC streams produce DASH+fMP4 (`manifest.mpd` + .m4s) because CAFv3's
//!   default HLS player (MPL) can't render fMP4 segments — DASH on the same
//!   receiver uses Shaka, which handles fMP4 + HEVC natively.
//!
//! Lifecycle: [`start`] returns a [`CastProxyHandle`] containing the bound
//! address and a cancel guard; dropping the handle (or calling `shutdown`)
//! tears the listener down, aborts in-flight forwarders, kills ffmpeg, and
//! removes the temp directory.

use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
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
use crate::engine::proxy_common::{read_capped, ReadCappedError};
use crate::engine::stream_proxy::redact_url;
use crate::error::AppError;
use crate::models::chromecast::CastStreamKind;
use crate::state::AppState;

const CAST_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CAST_READ_TIMEOUT: Duration = Duration::from_secs(20);
const MANIFEST_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const REMUX_PLAYLIST_READY_TIMEOUT: Duration = Duration::from_secs(20);
const REMUX_PLAYLIST_POLL_INTERVAL: Duration = Duration::from_millis(150);
/// Hard cap on manifest body buffered into memory before rewriting. Real HLS
/// playlists are well under a megabyte; this exists so a misclassified upstream
/// (URL ends in `.m3u8` but body is actually a long-running MPEG-TS or live
/// stream) cannot OOM the proxy.
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;

pub struct CastProxyHandle {
    pub url: String,
    pub host: IpAddr,
    pub port: u16,
    pub token: String,
    /// True when the proxy serves a DASH manifest (HEVC remux). Lets the
    /// caller flip the LOAD payload to `application/dash+xml` so the receiver
    /// dispatches to its DASH/Shaka player instead of the default HLS player,
    /// which can't render fMP4 segments on CAFv3.
    pub is_dash: bool,
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

/// Best-effort discovery of the LAN-facing local IPv4. The proxy binds on
/// `0.0.0.0` (IPv4 only), so the address advertised back to the Chromecast
/// must also be IPv4 — `http://[::1]:port` is not a valid authority and an
/// IPv6-only host wouldn't be reachable from the IPv4-bound socket either.
///
/// `local_ip()` can return IPv6 on dual-stack hosts; in that case scan the
/// interface list for the first non-loopback IPv4. Returns `None` when no
/// usable IPv4 is available (the caller surfaces an error to the user).
pub fn detect_lan_ip() -> Option<IpAddr> {
    match local_ip_address::local_ip() {
        Ok(ip @ IpAddr::V4(_)) => return Some(ip),
        Ok(IpAddr::V6(_)) => {
            // Fall through to interface scan.
        }
        Err(err) => {
            log::debug!("[CastProxy] local_ip() returned error: {err}");
        }
    }
    match local_ip_address::list_afinet_netifas() {
        Ok(list) => {
            for (_, ip) in list {
                if let IpAddr::V4(v4) = ip {
                    if !v4.is_loopback() && !v4.is_unspecified() && !v4.is_link_local() {
                        return Some(IpAddr::V4(v4));
                    }
                }
            }
            log::warn!("[CastProxy] No usable IPv4 interface found");
            None
        }
        Err(err) => {
            log::warn!("[CastProxy] Failed to enumerate network interfaces: {err}");
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

    let (cast_url, is_dash) = if stream_kind == CastStreamKind::MpegTs {
        let started = start_remux(
            app.clone(),
            upstream_url.clone(),
            token.clone(),
            cancel.clone(),
            remux_state.clone(),
            client.clone(),
        )
        .await?;
        (
            format!(
                "http://{lan_ip}:{port}/cast/{token}/hls/{}",
                started.manifest_filename
            ),
            started.is_dash,
        )
    } else {
        (format!("http://{lan_ip}:{port}/cast/{token}/stream"), false)
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
        is_dash,
        cancel,
        remux: remux_state,
    })
}

struct RemuxStartInfo {
    manifest_filename: String,
    is_dash: bool,
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
    client: Arc<reqwest::Client>,
) -> Result<RemuxStartInfo, AppError> {
    let tmpdir = std::env::temp_dir().join(format!("iptv-cast-{token}"));
    std::fs::create_dir_all(&tmpdir).map_err(AppError::Io)?;

    let (user_agent, accept_invalid_certs) = {
        let state = app.state::<Arc<AppState>>();
        let settings = state.settings.lock().await;
        (settings.user_agent.clone(), settings.accept_invalid_certs)
    };

    let ffmpeg_bin = resolve_binary(&app, "ffmpeg");
    let ffprobe_bin = resolve_binary(&app, "ffprobe");

    // Probe the upstream's video + audio codecs. HEVC needs DASH+fMP4 because:
    // (a) HEVC must not ride MPEG-TS segments (per Cast spec — TS+HEVC fails);
    // (b) HLS+fMP4 looks correct on the wire but the Default Media Receiver's
    //     CAFv3 HLS player (MPL) doesn't render fMP4 segments, so it fetches
    //     init+1 segment then emits LoadFailed;
    // (c) DASH on the same receiver dispatches to Shaka, which handles
    //     fMP4+HEVC out of the box.
    // Audio: MPL is happy with AAC/MP3-in-TS, but EAC3/AC3/MP2-in-TS commonly
    // produce LoadFailed on Default Media Receiver. Probe so we know whether
    // a transcode-to-AAC is needed. Probe is best-effort: a failure (timeout,
    // missing ffprobe) falls through to HLS+TS with stream copy, correct for
    // the well-tested H.264+AAC case.
    let (video_codec, audio_codec) = probe_codecs(
        &ffprobe_bin,
        &upstream_url,
        &user_agent,
        accept_invalid_certs,
    )
    .await;
    let is_hevc = video_codec
        .as_deref()
        .map(|c| matches!(c, "hevc" | "h265"))
        .unwrap_or(false);
    // AAC is the only TS audio codec MPL plays reliably; transcode anything
    // else (EAC3, AC3, MP2, MP3, Opus, …) to AAC. When the probe is empty we
    // assume copy is fine — the H.264+AAC default. HEVC/DASH always
    // transcodes regardless of this flag (mp4 muxer needs `mp4a`).
    let audio_needs_transcode = audio_codec
        .as_deref()
        .map(|c| !matches!(c, "aac"))
        .unwrap_or(false);
    let manifest_path = if is_hevc {
        tmpdir.join("manifest.mpd")
    } else {
        tmpdir.join("playlist.m3u8")
    };

    let mut cmd = tokio::process::Command::new(&ffmpeg_bin);
    configure_background_process(&mut cmd);
    cmd.kill_on_drop(true);
    // For HEVC we pipe upstream bytes into ffmpeg's stdin via our own
    // reconnecting fetcher (see below). H.264 stays on ffmpeg's HTTP input
    // because TS+HLS is more tolerant of mid-stream resets and the simpler
    // path is well-tested.
    cmd.stdin(if is_hevc {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    })
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped());

    cmd.arg("-hide_banner").arg("-loglevel").arg("warning");
    cmd.arg("-fflags").arg("+genpts+discardcorrupt");
    if is_hevc {
        cmd.arg("-f").arg("mpegts");
        cmd.arg("-i").arg("pipe:0");
    } else {
        cmd.arg("-user_agent").arg(&user_agent);
        // `-tls_verify` is a private option of the TLS protocol — only add it
        // when the URL actually uses HTTPS, otherwise some ffmpeg builds reject
        // it as "Option not found" and abort the whole pipeline before the
        // input is even opened.
        if accept_invalid_certs && upstream_url.to_ascii_lowercase().starts_with("https://") {
            cmd.arg("-tls_verify").arg("0");
        }
        cmd.arg("-reconnect").arg("1");
        cmd.arg("-reconnect_streamed").arg("1");
        cmd.arg("-reconnect_delay_max").arg("5");
        cmd.arg("-i").arg(&upstream_url);
    }
    if is_hevc {
        // Video: copy HEVC; rewrite the fMP4 sample-entry codec tag so the
        // receiver's codec sniffer sees `hvc1` (Cast/Apple-standard) rather
        // than `hev1` (ffmpeg-default; Shaka and Cast reject it).
        cmd.arg("-c:v").arg("copy");
        cmd.arg("-tag:v").arg("hvc1");
        // Audio: transcode to clean AAC. Copy-into-mp4 fails on MPEG-TS
        // sources because the TS audio codec_tag (0x0F = MPEG-2 AAC OTI)
        // is incompatible with the mp4 muxer's expected `mp4a`, and many
        // EU broadcast streams carry MP2/AC3 audio that mp4 can't hold at
        // all. ~5% CPU at 192 kbps stereo — cheap insurance vs. failing
        // the whole header write with "incorrect codec parameters".
        cmd.arg("-c:a").arg("aac");
        cmd.arg("-b:a").arg("192k");
        cmd.arg("-ac").arg("2");
        // Resample with async drift correction so PTS gaps from upstream
        // reconnects (single-conn IPTV servers kick ffmpeg every few mins;
        // each reconnect introduces a timestamp jump) don't drop the AAC
        // encoder. `async=1000` permits up to 1s of compensation per
        // segment; without this the encoder flushes and the DASH muxer
        // aborts the run with "Application provided invalid, non monotonically
        // increasing dts".
        cmd.arg("-af").arg("aresample=async=1000");
        // Make negative timestamps after a TS reconnect zero-anchored
        // rather than letting them propagate into the fMP4 sample table,
        // which the muxer rejects.
        cmd.arg("-avoid_negative_ts").arg("make_zero");

        // DASH muxer: sliding-window live profile, fMP4 segments under
        // SegmentTemplate so Shaka can index by $Number$. `remove_at_exit`
        // pairs with `extra_window_size` so segments stay on disk a couple
        // of windows past the manifest tail (covers receiver reconnects).
        cmd.arg("-f").arg("dash");
        cmd.arg("-seg_duration").arg("4");
        cmd.arg("-window_size").arg("6");
        cmd.arg("-extra_window_size").arg("2");
        cmd.arg("-remove_at_exit").arg("1");
        cmd.arg("-use_template").arg("1");
        cmd.arg("-use_timeline").arg("1");
        cmd.arg("-init_seg_name")
            .arg("init-stream$RepresentationID$.m4s");
        cmd.arg("-media_seg_name")
            .arg("chunk-stream$RepresentationID$-$Number%05d$.m4s");
    } else {
        // H.264 + TS. Video is always copy. Audio is copy when the upstream
        // ships AAC (MPL native), otherwise transcoded to AAC — Default
        // Media Receiver MPL emits LoadFailed on EAC3/AC3-in-TS even though
        // the muxer accepts those codec_tags.
        cmd.arg("-c:v").arg("copy");
        if audio_needs_transcode {
            cmd.arg("-c:a").arg("aac");
            cmd.arg("-b:a").arg("192k");
            cmd.arg("-ac").arg("2");
            cmd.arg("-af").arg("aresample=async=1000");
        } else {
            cmd.arg("-c:a").arg("copy");
        }
        let segment_pattern = tmpdir.join("seg_%05d.ts");
        cmd.arg("-f").arg("hls");
        cmd.arg("-hls_time").arg("4");
        cmd.arg("-hls_list_size").arg("6");
        cmd.arg("-hls_flags")
            .arg("delete_segments+omit_endlist+independent_segments");
        cmd.arg("-hls_segment_filename").arg(&segment_pattern);
    }
    cmd.arg(&manifest_path);

    log::info!(
        "[CastProxy] Spawning ffmpeg remux ({}) for {} → {}",
        if is_hevc { "DASH/HEVC" } else { "HLS/H.264" },
        redact_url(&upstream_url),
        manifest_path.display()
    );

    let mut child = cmd.spawn().map_err(|err| {
        AppError::Other(format!(
            "Failed to spawn ffmpeg for cast remux ({ffmpeg_bin}): {err}"
        ))
    })?;

    // For HEVC, pump upstream bytes into ffmpeg's stdin via our own
    // reconnecting fetcher. ffmpeg's built-in `-reconnect 1 -reconnect_streamed
    // 1` opens a fresh HTTP response each time the upstream hangs up; the
    // resulting byte stream looks the same to the demuxer as ours, but
    // upstream resets land on TCP-message boundaries and ffmpeg flushes its
    // demuxer state, which on 4K HEVC means broken segments mid-window. With
    // a stdin pipe ffmpeg sees one continuous TS source for the lifetime of
    // the cast, and -fflags +genpts+discardcorrupt smooths over the inevitable
    // PTS resets between upstream connections instead of treating each as a
    // fresh demux session.
    if is_hevc {
        if let Some(stdin) = child.stdin.take() {
            spawn_upstream_pump(
                upstream_url.clone(),
                user_agent.clone(),
                client.clone(),
                stdin,
                cancel.clone(),
            );
        }
    }

    // Drain stderr so the pipe doesn't fill and stall ffmpeg. Each line is
    // logged at DEBUG and also kept in a small ring buffer that the wait task
    // dumps at WARN on non-zero exit — so the failure reason is visible at
    // the default log level without forcing the whole stream to INFO.
    let stderr_tail: Arc<Mutex<std::collections::VecDeque<String>>> =
        Arc::new(Mutex::new(std::collections::VecDeque::with_capacity(32)));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[CastProxy/ffmpeg] {line}");
                let mut t = tail.lock().await;
                if t.len() >= 32 {
                    t.pop_front();
                }
                t.push_back(line);
            }
        });
    }

    // Park the child on the worker so we can wait on it; cancel kills it.
    let cancel_for_worker = cancel.clone();
    let tmpdir_for_worker = tmpdir.clone();
    let upstream_for_worker = upstream_url.clone();
    let remux_state_for_worker = remux_state.clone();
    let stderr_tail_for_worker = stderr_tail.clone();
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
                        let tail = stderr_tail_for_worker.lock().await;
                        for line in tail.iter() {
                            log::warn!("[CastProxy/ffmpeg/stderr] {line}");
                        }
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

    // Wait for the manifest to actually be written so the Cast device's first
    // GET doesn't 404. On failure, trip the cancel so the spawned ffmpeg
    // worker terminates and removes the temp dir.
    if let Err(err) =
        wait_for_manifest(&manifest_path, is_hevc, REMUX_PLAYLIST_READY_TIMEOUT, &cancel).await
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
        manifest_filename: if is_hevc {
            "manifest.mpd".to_string()
        } else {
            "playlist.m3u8".to_string()
        },
        is_dash: is_hevc,
    })
}

async fn wait_for_manifest(
    path: &Path,
    is_dash: bool,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), AppError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if path.exists() {
            // Block until at least one segment is referenced so the Chromecast
            // doesn't request an empty manifest. HLS uses `#EXTINF`; DASH with
            // SegmentTimeline emits `<S ` entries once the first segment is
            // muxed.
            if let Ok(content) = tokio::fs::read_to_string(path).await {
                let ready = if is_dash {
                    content.contains("<S ") || content.contains("<S\t")
                } else {
                    content.contains("#EXTINF")
                };
                if ready {
                    return Ok(());
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(AppError::Other(
                "Cast remux was cancelled before manifest became ready".to_string(),
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Other(
                "ffmpeg did not produce a manifest in time".to_string(),
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

/// Pump bytes from the upstream IPTV URL into ffmpeg's stdin, transparently
/// reconnecting whenever the upstream hangs up or errors. Used for HEVC casts
/// so ffmpeg sees one continuous MPEG-TS byte stream instead of a sequence of
/// separate HTTP responses (which on single-connection IPTV servers happen
/// every few seconds and inject PTS resets ffmpeg's demuxer treats as a fresh
/// session — fatal for a live DASH muxer).
///
/// Exits when:
/// - the cancel token fires (cast session ended), or
/// - writing to ffmpeg's stdin fails (ffmpeg has died).
fn spawn_upstream_pump(
    upstream_url: String,
    user_agent: String,
    client: Arc<reqwest::Client>,
    mut stdin: tokio::process::ChildStdin,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        use futures::StreamExt;
        // Exponential backoff between reconnects: the base stays short so a
        // real hiccup doesn't starve ffmpeg's demuxer, but consecutive
        // failures grow the delay (capped at 5s) so a permanently-broken
        // upstream isn't hammered 5x per second for the whole session —
        // IPTV providers ban clients for exactly that pattern.
        const RECONNECT_BASE_BACKOFF: Duration = Duration::from_millis(200);
        const RECONNECT_MAX_BACKOFF: Duration = Duration::from_secs(5);
        fn reconnect_backoff(consecutive_failures: u32) -> Duration {
            RECONNECT_BASE_BACKOFF
                .saturating_mul(1u32 << consecutive_failures.min(5))
                .min(RECONNECT_MAX_BACKOFF)
        }
        let mut reconnects: u32 = 0;
        let mut consecutive_failures: u32 = 0;

        'session: loop {
            if cancel.is_cancelled() {
                break;
            }
            let label = if reconnects == 0 {
                "initial connect".to_string()
            } else {
                format!("reconnect #{reconnects}")
            };
            log::info!(
                "[CastProxy/pump] {label} for {}",
                redact_url(&upstream_url)
            );

            let response_result = tokio::select! {
                _ = cancel.cancelled() => break 'session,
                r = client
                    .get(&upstream_url)
                    .header(
                        USER_AGENT,
                        HeaderValue::from_str(&user_agent).unwrap_or_else(|_| {
                            HeaderValue::from_static("TiviMate/5.1.6 (Android 12)")
                        }),
                    )
                    .send() => r,
            };

            let response = match response_result {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    log::warn!(
                        "[CastProxy/pump] Upstream returned {} ({label})",
                        r.status()
                    );
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    tokio::select! {
                        _ = cancel.cancelled() => break 'session,
                        _ = tokio::time::sleep(reconnect_backoff(consecutive_failures)) => {}
                    }
                    reconnects += 1;
                    continue;
                }
                Err(err) => {
                    log::warn!("[CastProxy/pump] Upstream connect failed ({label}): {err}");
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    tokio::select! {
                        _ = cancel.cancelled() => break 'session,
                        _ = tokio::time::sleep(reconnect_backoff(consecutive_failures)) => {}
                    }
                    reconnects += 1;
                    continue;
                }
            };

            let mut stream = response.bytes_stream();
            let mut got_bytes = false;
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break 'session,
                    chunk = stream.next() => {
                        match chunk {
                            Some(Ok(bytes)) => {
                                got_bytes = true;
                                if let Err(err) = stdin.write_all(&bytes).await {
                                    // ffmpeg closed its stdin (likely died).
                                    // Nothing more we can do — exit the pump
                                    // and let the worker task observe the exit.
                                    log::info!(
                                        "[CastProxy/pump] ffmpeg stdin closed ({err}); pump exiting"
                                    );
                                    break 'session;
                                }
                            }
                            Some(Err(err)) => {
                                log::info!(
                                    "[CastProxy/pump] Upstream read error ({label}): {err}; reconnecting"
                                );
                                break;
                            }
                            None => {
                                log::info!(
                                    "[CastProxy/pump] Upstream EOF ({label}); reconnecting"
                                );
                                break;
                            }
                        }
                    }
                }
            }

            // A connection that produced data was a real session — reconnect
            // quickly. One that broke without a single byte counts as a
            // failure and escalates the backoff.
            if got_bytes {
                consecutive_failures = 0;
            } else {
                consecutive_failures = consecutive_failures.saturating_add(1);
            }
            tokio::select! {
                _ = cancel.cancelled() => break 'session,
                _ = tokio::time::sleep(reconnect_backoff(consecutive_failures)) => {}
            }
            reconnects += 1;
        }

        // Best-effort flush + close so ffmpeg sees EOF promptly when we exit.
        let _ = stdin.shutdown().await;
        log::info!(
            "[CastProxy/pump] Pump terminated for {} after {} reconnect(s)",
            redact_url(&upstream_url),
            reconnects
        );
    });
}

/// Best-effort probe of the upstream's primary video + audio codecs. Used to
/// pick the right ffmpeg pipeline:
/// - Video: HEVC → DASH+fMP4 (and `-tag:v hvc1`); H.264 → HLS+TS.
/// - Audio: anything other than AAC → transcode to AAC, since Default Media
///   Receiver MPL emits LoadFailed on EAC3/AC3/MP2-in-TS.
///
/// Returns `(None, None)` on any failure — the caller falls through to the
/// untagged H.264+copy remux, which is correct for the well-tested case.
async fn probe_codecs(
    ffprobe_bin: &str,
    upstream_url: &str,
    user_agent: &str,
    accept_invalid_certs: bool,
) -> (Option<String>, Option<String>) {
    const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

    let run = |stream_selector: &'static str| {
        let ffprobe_bin = ffprobe_bin.to_string();
        let upstream_url = upstream_url.to_string();
        let user_agent = user_agent.to_string();
        async move {
            let mut cmd = tokio::process::Command::new(&ffprobe_bin);
            configure_background_process(&mut cmd);
            cmd.kill_on_drop(true);
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());

            cmd.arg("-hide_banner").arg("-v").arg("error");
            cmd.arg("-user_agent").arg(&user_agent);
            if accept_invalid_certs && upstream_url.to_ascii_lowercase().starts_with("https://") {
                cmd.arg("-tls_verify").arg("0");
            }
            cmd.arg("-select_streams").arg(stream_selector);
            cmd.arg("-show_entries").arg("stream=codec_name");
            cmd.arg("-of").arg("default=nokey=1:noprint_wrappers=1");
            cmd.arg(&upstream_url);

            let output = match tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await {
                Ok(Ok(out)) => out,
                Ok(Err(err)) => {
                    log::warn!(
                        "[CastProxy] ffprobe spawn failed for {} ({stream_selector}): {err}",
                        redact_url(&upstream_url)
                    );
                    return None;
                }
                Err(_) => {
                    log::warn!(
                        "[CastProxy] ffprobe codec probe timed out for {} ({stream_selector})",
                        redact_url(&upstream_url)
                    );
                    return None;
                }
            };
            if !output.status.success() {
                log::debug!(
                    "[CastProxy] ffprobe codec probe exited non-zero for {} ({stream_selector}, status {:?})",
                    redact_url(&upstream_url),
                    output.status.code()
                );
                return None;
            }
            // ffprobe occasionally emits the codec name multiple times (e.g.
            // once per probe pass) even with a single `-select_streams` index.
            // Take the first non-empty token.
            let stdout = String::from_utf8_lossy(&output.stdout);
            let codec = stdout
                .split_ascii_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if codec.is_empty() { None } else { Some(codec) }
        }
    };

    let (video, audio) = tokio::join!(run("v:0"), run("a:0"));
    log::info!(
        "[CastProxy] Probed codecs video={} audio={} for {}",
        video.as_deref().unwrap_or("?"),
        audio.as_deref().unwrap_or("?"),
        redact_url(upstream_url)
    );
    (video, audio)
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
    let range_header = parse_request_header(&request, "range").map(|s| s.to_string());
    log::info!(
        "[CastProxy] {method} {redacted}{range_suffix} from {peer}",
        redacted = redact_cast_path(path),
        range_suffix = range_header
            .as_deref()
            .map(|r| format!(" range={r}"))
            .unwrap_or_default()
    );

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
        return serve_remux_file(
            &mut socket,
            &tmpdir,
            rest,
            &method,
            range_header.as_deref(),
        )
        .await;
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
        &method,
        range_header.as_deref(),
    )
    .await
}

async fn serve_remux_file(
    socket: &mut tokio::net::TcpStream,
    tmpdir: &Path,
    relative: &str,
    method: &str,
    range_header: Option<&str>,
) -> std::io::Result<()> {
    // Cross-platform path-traversal guard. The string-level checks reject
    // backslashes (Windows separator), drive letters (`C:foo`), and UNC
    // forms (`\\host\share`) that `Path::components` on Unix would otherwise
    // pass through as a single Normal component and then resolve outside
    // tmpdir at runtime. The component-walk catches the rest (`/`, `..`,
    // empty input, leading separator).
    if !is_safe_remux_filename(relative) {
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
    } else if relative.ends_with(".mpd") {
        // DASH manifest (HEVC remux). Shaka on the receiver dispatches on this
        // content-type to its DASH parser.
        "application/dash+xml"
    } else if relative.ends_with(".ts") {
        "video/mp2t"
    } else if relative.ends_with(".m4s") || relative.ends_with(".mp4") {
        // fMP4 init + media segments (DASH).
        "video/mp4"
    } else {
        "application/octet-stream"
    };
    let total_len = bytes.len() as u64;
    let is_head = method.eq_ignore_ascii_case("HEAD");

    // Honour byte-range requests so the receiver can resume a paused segment
    // (Shaka issues 0-N range probes for fMP4 init segments). Falls back to
    // 200/full body if the header is absent or malformed.
    let (status_line, content_range_line, body_slice): (&str, String, &[u8]) =
        if let Some(range) = range_header {
            match parse_byte_range(range, total_len) {
                Some((start, end_inclusive)) => (
                    "HTTP/1.1 206 Partial Content\r\n",
                    format!("Content-Range: bytes {start}-{end_inclusive}/{total_len}\r\n"),
                    &bytes[start as usize..=end_inclusive as usize],
                ),
                None => {
                    // Unsatisfiable: respond per RFC 7233 §4.4.
                    let header = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\n\
                         Content-Type: text/plain\r\n\
                         Content-Length: 0\r\n\
                         Content-Range: bytes */{total_len}\r\n\
                         Accept-Ranges: bytes\r\n\
                         Access-Control-Allow-Origin: *\r\n\
                         Connection: close\r\n\
                         \r\n"
                    );
                    socket.write_all(header.as_bytes()).await?;
                    return Ok(());
                }
            }
        } else {
            ("HTTP/1.1 200 OK\r\n", String::new(), &bytes[..])
        };

    let body_len = body_slice.len();
    let header = format!(
        "{status_line}\
         Content-Type: {content_type}\r\n\
         Content-Length: {body_len}\r\n\
         {content_range_line}\
         Accept-Ranges: bytes\r\n\
         Cache-Control: no-cache\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Range, Accept-Encoding, Origin, User-Agent\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Date\r\n\
         Connection: close\r\n\
         \r\n",
    );
    socket.write_all(header.as_bytes()).await?;
    if !is_head {
        socket.write_all(body_slice).await?;
    }
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
    method: &str,
    range_header: Option<&str>,
) -> std::io::Result<()> {
    let is_head = method.eq_ignore_ascii_case("HEAD");
    // Forward HEAD as HEAD upstream so we don't pay for a full body fetch we'll
    // discard. Range is forwarded as-is for both GET and HEAD; the upstream
    // either honours it (returning 206) or falls back to 200 and we pass that
    // through unchanged.
    let mut request_builder = if is_head {
        client.head(&upstream_url)
    } else {
        client.get(&upstream_url)
    }
    .header(
        USER_AGENT,
        HeaderValue::from_str(&user_agent)
            .unwrap_or_else(|_| HeaderValue::from_static("TiviMate/5.1.6 (Android 12)")),
    );
    if let Some(range) = range_header {
        if let Ok(value) = HeaderValue::from_str(range) {
            request_builder = request_builder.header(reqwest::header::RANGE, value);
        }
    }

    let response = match tokio::time::timeout(MANIFEST_FETCH_TIMEOUT, request_builder.send()).await
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
        // Refuse upfront if the upstream advertised a body bigger than the cap;
        // otherwise stream-and-cap the body so a misclassified or malicious
        // upstream (e.g. URL ends in .m3u8 but actually returns a live MPEG-TS)
        // can't buffer unbounded data.
        if let Some(len) = response.content_length() {
            if len > MAX_MANIFEST_BYTES {
                log::warn!(
                    "[CastProxy] Manifest content-length {len} exceeds cap; refusing to rewrite"
                );
                return write_simple(socket, 502, "text/plain", b"Manifest too large").await;
            }
        }
        let body = match read_capped(response, MAX_MANIFEST_BYTES).await {
            Ok(bytes) => bytes,
            Err(ReadCappedError::TooLarge) => {
                log::warn!(
                    "[CastProxy] Manifest exceeded {MAX_MANIFEST_BYTES} bytes; refusing to rewrite"
                );
                return write_simple(socket, 502, "text/plain", b"Manifest too large").await;
            }
            Err(ReadCappedError::Read(err)) => {
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
        // HEAD: headers only, no body. The receiver only ever HEAD-probes
        // segments anyway, but defensive against a manifest HEAD too.
        if !is_head {
            socket.write_all(rewritten.as_bytes()).await?;
        }
        return Ok(());
    }

    // Otherwise pass the body through. If the upstream gave us Content-Length
    // (typical for HEAD and Range responses), use it instead of chunked
    // transfer so the receiver knows the byte count up front. Forward
    // Content-Range and Accept-Ranges so byte-range responses pass through
    // verbatim — the receiver requested them, we shouldn't strip them.
    let status_line = match status.canonical_reason() {
        Some(reason) => format!("HTTP/1.1 {} {}\r\n", status.as_u16(), reason),
        None => format!("HTTP/1.1 {}\r\n", status.as_u16()),
    };
    let upstream_content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let upstream_content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let upstream_accept_ranges = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Build the transfer framing line. If we know the body length, we use
    // Content-Length and skip chunked encoding; otherwise fall back to
    // chunked. HEAD always uses Content-Length (or the upstream's if known)
    // and writes no body.
    let mut framing = String::new();
    if let Some(len) = upstream_content_length.as_deref() {
        framing.push_str(&format!("Content-Length: {len}\r\n"));
    } else if !is_head {
        framing.push_str("Transfer-Encoding: chunked\r\n");
    } else {
        framing.push_str("Content-Length: 0\r\n");
    }
    if let Some(cr) = upstream_content_range.as_deref() {
        framing.push_str(&format!("Content-Range: {cr}\r\n"));
    }
    framing.push_str(&format!(
        "Accept-Ranges: {}\r\n",
        upstream_accept_ranges.as_deref().unwrap_or("bytes")
    ));

    let header = format!(
        "{status_line}Content-Type: {content_type}\r\n\
         {framing}\
         Cache-Control: no-cache\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Range, Accept-Encoding, Origin, User-Agent\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Date\r\n\
         Connection: close\r\n\
         \r\n"
    );
    socket.write_all(header.as_bytes()).await?;
    if is_head {
        // Headers-only response.
        return Ok(());
    }
    let use_chunked = upstream_content_length.is_none();

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
                        if use_chunked {
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
                        } else if socket.write_all(&bytes).await.is_err() {
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
    if use_chunked {
        let _ = socket.write_all(b"0\r\n\r\n").await;
    }
    Ok(())
}

fn parse_request_path(request: &str) -> Option<&str> {
    let first = request.lines().next()?;
    let mut parts = first.split_whitespace();
    let _method = parts.next()?;
    parts.next()
}

/// True iff `relative` names exactly one normal path component — no
/// separators, no parent refs, no Windows drive prefix or UNC root, no
/// leading whitespace. Walks `Path::components` (Unix-only on the target
/// platform) plus a string-level scan for backslashes / `:` so a request
/// served on Linux can't smuggle `C:\Windows\win.ini` past the validator,
/// since `Path::components` on Unix would treat the whole string as a
/// single Normal component.
fn is_safe_remux_filename(relative: &str) -> bool {
    if relative.is_empty() {
        return false;
    }
    if relative.contains('\\') || relative.contains(':') {
        return false;
    }
    let mut comps = Path::new(relative).components();
    let first = match comps.next() {
        Some(c) => c,
        None => return false,
    };
    if !matches!(first, Component::Normal(_)) {
        return false;
    }
    if comps.next().is_some() {
        return false;
    }
    true
}

/// Strip the cast token and any base64-encoded segment URL from a request path
/// so it's safe to log. Anyone with log access could otherwise replay the
/// session token (bearer credential for the proxy) or recover upstream stream
/// URLs from the encoded segment paths.
///
/// Maps:
/// - `/cast/<token>/hls/playlist.m3u8` → `/cast/<redacted>/hls/playlist.m3u8`
/// - `/cast/<token>/seg/<b64>`         → `/cast/<redacted>/seg/<redacted>`
/// - everything else                   → returned as-is
fn redact_cast_path(path: &str) -> String {
    let Some(rest) = path.strip_prefix("/cast/") else {
        return path.to_string();
    };
    let (_token, tail) = match rest.split_once('/') {
        Some((t, tail)) => (t, tail),
        None => return "/cast/<redacted>".to_string(),
    };
    if let Some(rest) = tail.strip_prefix("seg/") {
        // The b64 after `seg/` decodes to the upstream URL. Also redact any
        // trailing `?query` even though we don't currently emit those.
        let _ = rest;
        return "/cast/<redacted>/seg/<redacted>".to_string();
    }
    format!("/cast/<redacted>/{tail}")
}

/// Look up a single request header by name (case-insensitive). Returns the
/// trimmed value of the first matching header line, or `None` if absent. Only
/// scans the header block — stops at the first blank line so request bodies
/// don't pollute matches.
fn parse_request_header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    let mut lines = request.lines();
    // Skip the request-line.
    lines.next()?;
    for line in lines {
        if line.is_empty() {
            return None;
        }
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            return Some(value.trim());
        }
    }
    None
}

/// Parse an HTTP `Range` header of the form `bytes=START-END` (END optional)
/// against a known content length. Returns `(start, end_inclusive)` clamped
/// into bounds, or `None` if the header is malformed or unsatisfiable. We only
/// support the single-range, byte-unit form — multi-range and suffix ranges
/// (`bytes=-N`) are uncommon for media playback and would complicate the
/// response framing.
fn parse_byte_range(header: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let rest = header.strip_prefix("bytes=")?.trim();
    let (start_s, end_s) = rest.split_once('-')?;
    let start: u64 = start_s.trim().parse().ok()?;
    let end_inclusive: u64 = if end_s.trim().is_empty() {
        total_len - 1
    } else {
        end_s.trim().parse().ok()?
    };
    if start > end_inclusive || start >= total_len {
        return None;
    }
    let end_clamped = end_inclusive.min(total_len - 1);
    Some((start, end_clamped))
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
    fn redact_cast_path_strips_token() {
        assert_eq!(
            redact_cast_path("/cast/abc123token/hls/playlist.m3u8"),
            "/cast/<redacted>/hls/playlist.m3u8"
        );
        assert_eq!(redact_cast_path("/cast/tok/stream"), "/cast/<redacted>/stream");
    }

    #[test]
    fn redact_cast_path_strips_segment_b64() {
        // The b64 after seg/ encodes the upstream URL — must not leak.
        assert_eq!(
            redact_cast_path("/cast/abc/seg/aHR0cDovL2V4YW1wbGUuY29tL3MudHM"),
            "/cast/<redacted>/seg/<redacted>"
        );
    }

    #[test]
    fn redact_cast_path_passes_unrelated_paths_through() {
        assert_eq!(redact_cast_path("/health"), "/health");
        assert_eq!(redact_cast_path("/"), "/");
        assert_eq!(redact_cast_path(""), "");
        // Lone `/cast/<token>` with no trailing slash still redacts.
        assert_eq!(redact_cast_path("/cast/onlytoken"), "/cast/<redacted>");
    }

    #[test]
    fn is_safe_remux_filename_accepts_simple_names() {
        assert!(is_safe_remux_filename("playlist.m3u8"));
        assert!(is_safe_remux_filename("seg_00001.ts"));
        assert!(is_safe_remux_filename("init-stream0.m4s"));
        assert!(is_safe_remux_filename("manifest.mpd"));
    }

    #[test]
    fn is_safe_remux_filename_rejects_unix_traversal() {
        assert!(!is_safe_remux_filename(""));
        assert!(!is_safe_remux_filename(".."));
        assert!(!is_safe_remux_filename("../etc/passwd"));
        assert!(!is_safe_remux_filename("/etc/passwd"));
        assert!(!is_safe_remux_filename("a/b"));
        assert!(!is_safe_remux_filename("./a"));
    }

    #[test]
    fn is_safe_remux_filename_rejects_windows_paths() {
        // Drive-letter and UNC forms must be rejected even when validating
        // on Unix, since `Path::components` on Unix would treat them as a
        // single Normal component.
        assert!(!is_safe_remux_filename("C:\\Windows\\win.ini"));
        assert!(!is_safe_remux_filename("C:foo"));
        assert!(!is_safe_remux_filename("\\\\server\\share\\file"));
        assert!(!is_safe_remux_filename("a\\b"));
        // A bare `:` anywhere in the filename is suspicious — block.
        assert!(!is_safe_remux_filename("foo:bar.ts"));
    }

    #[test]
    fn parse_request_header_finds_case_insensitive() {
        let req = "GET /cast/x HTTP/1.1\r\nHost: 1.2.3.4:5500\r\nRange: bytes=0-100\r\nUser-Agent: t\r\n\r\n";
        assert_eq!(parse_request_header(req, "range"), Some("bytes=0-100"));
        assert_eq!(parse_request_header(req, "Range"), Some("bytes=0-100"));
        assert_eq!(parse_request_header(req, "RANGE"), Some("bytes=0-100"));
        assert_eq!(parse_request_header(req, "host"), Some("1.2.3.4:5500"));
        assert_eq!(parse_request_header(req, "missing"), None);
    }

    #[test]
    fn parse_request_header_stops_at_blank_line() {
        // A header-shaped line that shows up after the blank line (i.e. in a
        // body) must not be returned. Mostly defensive — the proxy only ever
        // serves GET/HEAD/OPTIONS, but the parser should be honest about
        // header boundaries.
        let req = "POST /x HTTP/1.1\r\nHost: a\r\n\r\nRange: bytes=0-100\r\n";
        assert_eq!(parse_request_header(req, "range"), None);
    }

    #[test]
    fn parse_byte_range_full_range() {
        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=100-199", 1000), Some((100, 199)));
    }

    #[test]
    fn parse_byte_range_open_ended() {
        assert_eq!(parse_byte_range("bytes=500-", 1000), Some((500, 999)));
    }

    #[test]
    fn parse_byte_range_clamps_end() {
        assert_eq!(parse_byte_range("bytes=900-99999", 1000), Some((900, 999)));
    }

    #[test]
    fn parse_byte_range_rejects_out_of_bounds() {
        assert_eq!(parse_byte_range("bytes=1000-1100", 1000), None);
        assert_eq!(parse_byte_range("bytes=2000-3000", 1000), None);
    }

    #[test]
    fn parse_byte_range_rejects_inverted() {
        assert_eq!(parse_byte_range("bytes=200-100", 1000), None);
    }

    #[test]
    fn parse_byte_range_rejects_malformed() {
        assert_eq!(parse_byte_range("0-100", 1000), None); // missing unit
        assert_eq!(parse_byte_range("bytes=", 1000), None);
        assert_eq!(parse_byte_range("bytes=abc-def", 1000), None);
    }

    #[test]
    fn parse_byte_range_rejects_zero_length() {
        assert_eq!(parse_byte_range("bytes=0-0", 0), None);
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

    /// Spawns a one-shot HTTP server that serves `body` chunked (no
    /// Content-Length) and returns its bound `http://...` URL. Used to verify
    /// `read_capped` against a real reqwest::Response without depending on a
    /// full mock-server crate.
    async fn spawn_chunked_server(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let header = "HTTP/1.1 200 OK\r\n\
                          Content-Type: application/vnd.apple.mpegurl\r\n\
                          Transfer-Encoding: chunked\r\n\
                          Connection: close\r\n\r\n";
            let _ = socket.write_all(header.as_bytes()).await;
            // Emit in 64 KiB chunks so the cap can trip mid-stream rather
            // than only after the body fully arrives.
            for chunk in body.chunks(64 * 1024) {
                let _ = socket
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await;
                let _ = socket.write_all(chunk).await;
                let _ = socket.write_all(b"\r\n").await;
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn read_capped_accepts_body_within_cap() {
        let body = b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n".to_vec();
        let url = spawn_chunked_server(body.clone()).await;
        let resp = reqwest::get(&url).await.unwrap();
        let bytes = read_capped(resp, 2 * 1024 * 1024).await.expect("within cap");
        assert_eq!(bytes, body);
    }

    #[tokio::test]
    async fn read_capped_rejects_body_over_cap() {
        // 4 MiB body, 2 MiB cap. The cap must trip mid-stream rather than
        // letting the proxy buffer the whole payload.
        let body = vec![b'A'; 4 * 1024 * 1024];
        let url = spawn_chunked_server(body).await;
        let resp = reqwest::get(&url).await.unwrap();
        let result = read_capped(resp, 2 * 1024 * 1024).await;
        assert!(
            matches!(result, Err(ReadCappedError::TooLarge)),
            "expected TooLarge, got {:?}",
            result.map(|b| b.len())
        );
    }
}
