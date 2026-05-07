//! Chromecast discovery and casting session management.
//!
//! Discovery uses mDNS browsing on `_googlecast._tcp.local.`. A Cast session
//! drives an async `cast_sender::Receiver` from a tokio task. cast-sender uses
//! async-native-tls (system TLS) which accepts Chromecast's self-signed certs
//! — rustls's webpki parser rejects those with `UnsupportedCertVersion`
//! before any custom verifier can run, which is why we cannot use rust_cast
//! 0.19+ against real devices.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cast_sender::namespace::media::Media;
use cast_sender::namespace::{Custom, NamespaceUrn};
use cast_sender::{App as CastApp, AppId, Payload, Receiver};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::models::chromecast::{
    CastMediaRequest, CastSession, CastSessionState, CastStreamKind, ChromecastDevice,
};
use crate::state::AppState;

static SESSION_UID: AtomicU64 = AtomicU64::new(1);

const CAST_SERVICE_TYPE: &str = "_googlecast._tcp.local.";
const CAST_STATUS_EVENT: &str = "cast://status";
/// How often we poll `Receiver::is_connected` to detect that the device went
/// away (TV powered off, network blip). cast-sender exposes no event for this,
/// so a periodic check is the simplest reliable signal.
const CONNECTION_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// One-shot mDNS scan that browses for Chromecast devices and returns the set
/// resolved within `wait`. Default wait keeps the UI snappy while still giving
/// devices time to respond.
pub async fn discover(wait: Duration) -> Result<Vec<ChromecastDevice>, AppError> {
    let daemon = ServiceDaemon::new()
        .map_err(|e| AppError::Other(format!("mDNS daemon init failed: {e}")))?;
    let receiver = daemon
        .browse(CAST_SERVICE_TYPE)
        .map_err(|e| AppError::Other(format!("mDNS browse failed: {e}")))?;

    let devices = tokio::task::spawn_blocking(move || -> HashMap<String, ChromecastDevice> {
        let mut found: HashMap<String, ChromecastDevice> = HashMap::new();
        let deadline = std::time::Instant::now() + wait;
        loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline - now;
            match receiver.recv_timeout(remaining) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    if let Some(device) = resolved_to_device(&info) {
                        found.insert(device.id.clone(), device);
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        found
    })
    .await
    .map_err(|e| AppError::Other(format!("mDNS scan task failed: {e}")))?;

    let _ = daemon.shutdown();

    let mut list: Vec<ChromecastDevice> = devices.into_values().collect();
    list.sort_by(|a, b| a.friendly_name.cmp(&b.friendly_name));
    Ok(list)
}

fn resolved_to_device(info: &mdns_sd::ResolvedService) -> Option<ChromecastDevice> {
    let v4 = info.get_addresses_v4();
    let host = v4.iter().next()?.to_string();
    let id = info
        .get_property_val_str("id")
        .map(|s| s.to_string())
        .unwrap_or_else(|| info.fullname.clone());
    let friendly_name = info
        .get_property_val_str("fn")
        .map(|s| s.to_string())
        .or_else(|| {
            info.fullname
                .strip_suffix(".")
                .and_then(|s| s.split('.').next())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "Chromecast".to_string());
    let model = info.get_property_val_str("md").map(|s| s.to_string());
    Some(ChromecastDevice {
        id,
        friendly_name,
        model,
        host,
        port: info.port,
    })
}

/// Sent from `swap_media` to the worker to trigger a fresh LOAD on the
/// existing receiver app without tearing it down. Used to switch channels
/// seamlessly when redirecting a cast to the same device.
struct SwapRequest {
    request: CastMediaRequest,
    cast_url: String,
    response_tx: oneshot::Sender<Result<(), AppError>>,
}

/// How a session was asked to stop. `Loud` emits a `Stopped` cast status
/// event so any listening frontend reflects the change; `Silent` skips the
/// emission and is used when the caller is immediately replacing the session
/// with a new one — emitting `Stopped` between the old teardown and the new
/// `Playing` event causes the cast UI to flicker to "not casting" because the
/// two events can race in the renderer.
#[derive(Debug, Clone, Copy)]
enum StopReason {
    Loud,
    Silent,
}

/// State the AppState tracks per active cast session. Only one session at a
/// time is supported in the current scope.
pub struct ActiveCastSession {
    pub session: CastSession,
    /// Unique-per-process id, used by the worker's self-cleanup path to verify
    /// the stored session is still its own (and not a successor) before
    /// clearing it from `AppState`.
    pub uid: u64,
    stop_tx: Option<oneshot::Sender<StopReason>>,
    swap_tx: mpsc::Sender<SwapRequest>,
    worker: Option<JoinHandle<()>>,
}

impl ActiveCastSession {
    pub fn snapshot(&self) -> CastSession {
        self.session.clone()
    }

    pub async fn stop(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(StopReason::Loud);
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.await;
        }
    }

    /// Tear down without emitting a `Stopped` cast status event. Used by the
    /// command layer when it is about to immediately start a replacement
    /// session — keeps the frontend from briefly observing "not casting"
    /// between the two backend transitions.
    pub async fn stop_silent(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(StopReason::Silent);
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.await;
        }
    }

    /// Swap the cast media on the live receiver session. The worker sends a
    /// fresh LOAD on the existing receiver app — no `stop_app` / `disconnect`
    /// round-trip — so the TV transitions cleanly between channels instead of
    /// flashing back to the launcher.
    pub async fn swap_media(
        &mut self,
        app: &AppHandle,
        request: CastMediaRequest,
        cast_url: String,
    ) -> Result<CastSession, AppError> {
        let (response_tx, response_rx) = oneshot::channel();
        self.swap_tx
            .send(SwapRequest {
                request: request.clone(),
                cast_url: cast_url.clone(),
                response_tx,
            })
            .await
            .map_err(|_| AppError::Other("Cast worker swap channel closed".to_string()))?;
        response_rx
            .await
            .map_err(|_| AppError::Other("Cast worker dropped swap response".to_string()))??;

        self.session.stream_url = cast_url;
        self.session.channel_name = request.channel_name;
        self.session.channel_logo = request.channel_logo;
        self.session.state = CastSessionState::Playing;
        self.session.error_message = None;
        emit_status(app, &self.session);
        Ok(self.session.clone())
    }
}

/// Start a Cast session: connect, launch the default media receiver, load
/// media. Spawns a tokio task that owns the `Receiver` and watches for stop
/// signals or device disconnect.
pub async fn start_session(
    app: AppHandle,
    device: ChromecastDevice,
    request: CastMediaRequest,
    cast_url: String,
) -> Result<ActiveCastSession, AppError> {
    let (stop_tx, stop_rx) = oneshot::channel::<StopReason>();
    let (swap_tx, swap_rx) = mpsc::channel::<SwapRequest>(1);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), AppError>>();
    let uid = SESSION_UID.fetch_add(1, Ordering::Relaxed);

    let device_for_worker = device.clone();
    let request_for_worker = request.clone();
    let cast_url_for_worker = cast_url.clone();
    let app_for_worker = app.clone();

    let worker = tokio::spawn(async move {
        run_session_worker(
            app_for_worker,
            uid,
            device_for_worker,
            request_for_worker,
            cast_url_for_worker,
            stop_rx,
            swap_rx,
            ready_tx,
        )
        .await;
    });

    ready_rx
        .await
        .map_err(|_| AppError::Other("Cast worker exited before ready".to_string()))??;

    log::info!(
        "[Chromecast] Session ready on '{}'",
        device.friendly_name
    );

    let session = CastSession {
        device_id: device.id.clone(),
        device_name: device.friendly_name.clone(),
        state: CastSessionState::Playing,
        stream_url: cast_url,
        channel_name: request.channel_name.clone(),
        channel_logo: request.channel_logo.clone(),
        error_message: None,
    };
    emit_status(&app, &session);

    Ok(ActiveCastSession {
        session,
        uid,
        stop_tx: Some(stop_tx),
        swap_tx,
        worker: Some(worker),
    })
}

async fn run_session_worker(
    app: AppHandle,
    uid: u64,
    device: ChromecastDevice,
    request: CastMediaRequest,
    cast_url: String,
    mut stop_rx: oneshot::Receiver<StopReason>,
    mut swap_rx: mpsc::Receiver<SwapRequest>,
    ready_tx: oneshot::Sender<Result<(), AppError>>,
) {
    let receiver = Receiver::new();

    if let Err(err) = receiver.connect(&device.host).await {
        let _ = ready_tx.send(Err(AppError::Other(format!(
            "Cast connect handshake failed: {err}"
        ))));
        return;
    }

    let cast_app = match receiver.launch_app(AppId::DefaultMediaReceiver).await {
        Ok(a) => a,
        Err(err) => {
            receiver.disconnect().await;
            let _ = ready_tx.send(Err(AppError::Other(format!(
                "Default media receiver launch failed: {err}"
            ))));
            return;
        }
    };

    let load_payload = build_load_payload(&request, &cast_url);

    if let Err(err) = send_load(&receiver, &cast_app, load_payload).await {
        let _ = receiver.stop_app(&cast_app).await;
        receiver.disconnect().await;
        let _ = ready_tx.send(Err(err));
        return;
    }

    if ready_tx.send(Ok(())).is_err() {
        // Caller dropped before we signaled ready — tear down immediately.
        let _ = receiver.stop_app(&cast_app).await;
        receiver.disconnect().await;
        return;
    }

    let manual_stop = drive_session(
        &app,
        &device,
        request,
        cast_url,
        &receiver,
        &cast_app,
        &mut stop_rx,
        &mut swap_rx,
    )
    .await;

    // For self-exit paths (device disconnected, error) we clear the stored
    // session so a remounted frontend calling `get_cast_status()` doesn't see
    // a stale Playing state. On manual stop the caller already cleared the
    // session before sending Stop, so we skip. The uid match prevents
    // clearing a successor session started after we exited.
    if !manual_stop {
        let app_for_cleanup = app.clone();
        tokio::spawn(async move {
            clear_app_state_if_uid_matches(&app_for_cleanup, uid).await;
        });
    }
}

/// Build a Cast V2-format LOAD payload as a `Custom` namespace message.
///
/// We bypass `cast-sender 0.3`'s typed `MediaInformation` because its
/// `MediaMetadata` enum serializes the discriminator as `"type": "GENERIC"`
/// (CAF SDK style) rather than `"metadataType": 0` (Cast V2 protocol style).
/// The Default Media Receiver only honours the latter — when it gets the
/// former it falls back to displaying "Default Media Receiver" on the TV
/// instead of the channel name. The old rust_cast crate emitted the V2
/// numeric form, which is why channel names rendered correctly there.
///
/// Custom + flatten lets us hand-craft the LOAD JSON; cast-sender's
/// `Receiver::send_request` still wraps it with the right `requestId`.
fn build_load_payload(request: &CastMediaRequest, cast_url: &str) -> Custom {
    log::debug!(
        "[Chromecast] build_load_payload: channel_name={:?} channel_logo_present={} stream_kind={:?}",
        request.channel_name,
        request.channel_logo.is_some(),
        request.stream_kind,
    );

    // The cast proxy always serves HLS to the Chromecast — direct pass-through
    // for HLS upstreams, ffmpeg-remuxed HLS for MPEG-TS. So the receiver always
    // sees an .m3u8 manifest regardless of the upstream's original wire format.
    let content_type = match request.stream_kind {
        CastStreamKind::Hls | CastStreamKind::MpegTs => "application/vnd.apple.mpegurl",
        CastStreamKind::Other => "application/octet-stream",
    };

    let mut metadata = serde_json::Map::new();
    metadata.insert("metadataType".to_string(), json!(0));
    if let Some(title) = request.channel_name.clone() {
        metadata.insert("title".to_string(), json!(title.clone()));
        metadata.insert("subtitle".to_string(), json!(title));
    }
    if let Some(logo) = request.channel_logo.clone() {
        metadata.insert("images".to_string(), json!([{ "url": logo }]));
    }

    let media = json!({
        "contentId": cast_url,
        "contentType": content_type,
        "streamType": "LIVE",
        "metadata": Value::Object(metadata),
    });

    let mut fields = HashMap::new();
    fields.insert("type".to_string(), json!("LOAD"));
    fields.insert("media".to_string(), media);
    fields.insert("autoplay".to_string(), json!(true));

    Custom {
        namespace: NamespaceUrn::Media,
        fields,
    }
}

/// Send a hand-crafted LOAD payload and translate the receiver's response
/// into our `AppError`. Mirrors `MediaController::handle_error` so callers
/// see a meaningful message on `LOAD_FAILED`, `INVALID_PLAYER_STATE`, etc.,
/// instead of treating those as silent successes.
async fn send_load(
    receiver: &Receiver,
    cast_app: &CastApp,
    payload: Custom,
) -> Result<(), AppError> {
    let response = receiver
        .send_request(cast_app, payload)
        .await
        .map_err(|err| AppError::Other(format!("LOAD failed: {err}")))?;

    if let Payload::Media(media) = &response.payload {
        match media {
            Media::InvalidRequest(err) => {
                return Err(AppError::Other(format!(
                    "Cast LOAD rejected: {:?}",
                    err.reason
                )));
            }
            Media::InvalidPlayerState => {
                return Err(AppError::Other(
                    "Cast LOAD rejected: invalid player state".to_string(),
                ));
            }
            Media::LoadFailed => {
                return Err(AppError::Other("Cast LOAD failed".to_string()));
            }
            Media::LoadCancelled => {
                return Err(AppError::Other("Cast LOAD cancelled".to_string()));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Returns `true` if the session ended due to an explicit stop signal,
/// `false` if the device disconnected on its own.
async fn drive_session(
    app: &AppHandle,
    device: &ChromecastDevice,
    mut request: CastMediaRequest,
    mut cast_url: String,
    receiver: &Receiver,
    cast_app: &CastApp,
    stop_rx: &mut oneshot::Receiver<StopReason>,
    swap_rx: &mut mpsc::Receiver<SwapRequest>,
) -> bool {
    let mut tick = tokio::time::interval(CONNECTION_POLL_INTERVAL);
    // First tick fires immediately — skip it so we don't false-positive on a
    // session that has barely started.
    tick.tick().await;
    loop {
        tokio::select! {
            stop_signal = &mut *stop_rx => {
                let reason = stop_signal.unwrap_or(StopReason::Loud);
                let _ = receiver.stop_app(cast_app).await;
                receiver.disconnect().await;
                if matches!(reason, StopReason::Loud) {
                    emit_state(app, device, CastSessionState::Stopped, &cast_url, &request, None);
                    log::info!("[Chromecast] Session on '{}' stopped", device.friendly_name);
                } else {
                    log::info!(
                        "[Chromecast] Session on '{}' stopped silently (replacing)",
                        device.friendly_name
                    );
                }
                return true;
            }
            _ = tick.tick() => {
                if !receiver.is_connected().await {
                    log::info!("[Chromecast] Receiver connection lost on '{}'", device.friendly_name);
                    emit_state(app, device, CastSessionState::Stopped, &cast_url, &request, None);
                    return false;
                }
            }
            maybe_swap = swap_rx.recv() => {
                let Some(swap) = maybe_swap else {
                    // All senders dropped — session is being torn down by the
                    // owning struct; just keep looping until stop_rx fires.
                    continue;
                };
                let load_payload = build_load_payload(&swap.request, &swap.cast_url);
                match send_load(receiver, cast_app, load_payload).await {
                    Ok(_) => {
                        log::info!(
                            "[Chromecast] Hot-swapped media on '{}' -> {}",
                            device.friendly_name,
                            swap.request.channel_name.as_deref().unwrap_or("(unnamed)")
                        );
                        request = swap.request;
                        cast_url = swap.cast_url;
                        let _ = swap.response_tx.send(Ok(()));
                    }
                    Err(err) => {
                        let _ = swap.response_tx.send(Err(err));
                    }
                }
            }
        }
    }
}

async fn clear_app_state_if_uid_matches(app: &AppHandle, uid: u64) {
    let state = app.state::<Arc<AppState>>();
    let mut guard = state.cast_state.lock().await;
    let matches = guard.session.as_ref().map(|s| s.uid) == Some(uid);
    if matches {
        log::info!("[Chromecast] Clearing stored session after worker exit (uid={uid})");
        let _ = guard.session.take();
        if let Some(proxy) = guard.proxy.take() {
            proxy.shutdown();
        }
    }
}

fn emit_status(app: &AppHandle, session: &CastSession) {
    let _ = app.emit(CAST_STATUS_EVENT, session);
}

fn emit_state(
    app: &AppHandle,
    device: &ChromecastDevice,
    state: CastSessionState,
    cast_url: &str,
    request: &CastMediaRequest,
    error_message: Option<String>,
) {
    let session = CastSession {
        device_id: device.id.clone(),
        device_name: device.friendly_name.clone(),
        state,
        stream_url: cast_url.to_string(),
        channel_name: request.channel_name.clone(),
        channel_logo: request.channel_logo.clone(),
        error_message,
    };
    emit_status(app, &session);
}

/// Holder for the single active session on the AppState.
#[derive(Default)]
pub struct CastSessionHandle(pub Mutex<Option<ActiveCastSession>>);

impl CastSessionHandle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(None)))
    }
}
