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

use cast_sender::namespace::media::{
    GenericMediaMetadataBuilder, MediaInformationBuilder, StreamType,
};
use cast_sender::{App as CastApp, AppId, ImageBuilder, MediaController, Receiver};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex};
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

/// State the AppState tracks per active cast session. Only one session at a
/// time is supported in the current scope.
pub struct ActiveCastSession {
    pub session: CastSession,
    /// Unique-per-process id, used by the worker's self-cleanup path to verify
    /// the stored session is still its own (and not a successor) before
    /// clearing it from `AppState`.
    pub uid: u64,
    stop_tx: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl ActiveCastSession {
    pub fn snapshot(&self) -> CastSession {
        self.session.clone()
    }

    pub async fn stop(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.await;
        }
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
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
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
        worker: Some(worker),
    })
}

async fn run_session_worker(
    app: AppHandle,
    uid: u64,
    device: ChromecastDevice,
    request: CastMediaRequest,
    cast_url: String,
    mut stop_rx: oneshot::Receiver<()>,
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

    let media_controller = match MediaController::new(cast_app.clone(), receiver.clone()) {
        Ok(c) => c,
        Err(err) => {
            let _ = receiver.stop_app(&cast_app).await;
            receiver.disconnect().await;
            let _ = ready_tx.send(Err(AppError::Other(format!(
                "Media controller init failed: {err}"
            ))));
            return;
        }
    };

    let media_info = match build_media_info(&request, &cast_url) {
        Ok(m) => m,
        Err(err) => {
            let _ = receiver.stop_app(&cast_app).await;
            receiver.disconnect().await;
            let _ = ready_tx.send(Err(err));
            return;
        }
    };

    if let Err(err) = media_controller.load(media_info).await {
        let _ = receiver.stop_app(&cast_app).await;
        receiver.disconnect().await;
        let _ = ready_tx.send(Err(AppError::Other(format!("LOAD failed: {err}"))));
        return;
    }

    if ready_tx.send(Ok(())).is_err() {
        // Caller dropped before we signaled ready — tear down immediately.
        let _ = receiver.stop_app(&cast_app).await;
        receiver.disconnect().await;
        return;
    }

    let manual_stop =
        drive_session(&app, &device, &request, &cast_url, &receiver, &cast_app, &mut stop_rx)
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

fn build_media_info(
    request: &CastMediaRequest,
    cast_url: &str,
) -> Result<cast_sender::namespace::media::MediaInformation, AppError> {
    // The cast proxy always serves HLS to the Chromecast — direct pass-through
    // for HLS upstreams, ffmpeg-remuxed HLS for MPEG-TS. So the receiver always
    // sees an .m3u8 manifest regardless of the upstream's original wire format.
    let content_type = match request.stream_kind {
        CastStreamKind::Hls | CastStreamKind::MpegTs => "application/vnd.apple.mpegurl",
        CastStreamKind::Other => "application/octet-stream",
    };

    let images = request
        .channel_logo
        .as_ref()
        .and_then(|url| ImageBuilder::default().url(url.clone()).build().ok())
        .map(|img| vec![img])
        .unwrap_or_default();

    let mut metadata_builder = GenericMediaMetadataBuilder::default();
    if let Some(title) = request.channel_name.clone() {
        metadata_builder.title(title);
    }
    if !images.is_empty() {
        metadata_builder.images(images);
    }
    let metadata = metadata_builder
        .build()
        .map_err(|err| AppError::Other(format!("Cast metadata build failed: {err}")))?;

    MediaInformationBuilder::default()
        .content_id(cast_url.to_string())
        .stream_type(StreamType::Live)
        .content_type(content_type.to_string())
        .metadata(metadata)
        .build()
        .map_err(|err| AppError::Other(format!("Cast MediaInformation build failed: {err}")))
}

/// Returns `true` if the session ended due to an explicit stop signal,
/// `false` if the device disconnected on its own.
async fn drive_session(
    app: &AppHandle,
    device: &ChromecastDevice,
    request: &CastMediaRequest,
    cast_url: &str,
    receiver: &Receiver,
    cast_app: &CastApp,
    stop_rx: &mut oneshot::Receiver<()>,
) -> bool {
    let mut tick = tokio::time::interval(CONNECTION_POLL_INTERVAL);
    // First tick fires immediately — skip it so we don't false-positive on a
    // session that has barely started.
    tick.tick().await;
    loop {
        tokio::select! {
            _ = &mut *stop_rx => {
                let _ = receiver.stop_app(cast_app).await;
                receiver.disconnect().await;
                emit_state(app, device, CastSessionState::Stopped, cast_url, request, None);
                log::info!("[Chromecast] Session on '{}' stopped", device.friendly_name);
                return true;
            }
            _ = tick.tick() => {
                if !receiver.is_connected().await {
                    log::info!("[Chromecast] Receiver connection lost on '{}'", device.friendly_name);
                    emit_state(app, device, CastSessionState::Stopped, cast_url, request, None);
                    return false;
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
