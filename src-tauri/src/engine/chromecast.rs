//! Chromecast discovery and casting session management.
//!
//! Discovery uses mDNS browsing on `_googlecast._tcp.local.`. A Cast session
//! runs on a dedicated worker thread because rust_cast's `CastDevice` performs
//! synchronous TLS reads — we bridge it to async Tokio code via blocking
//! channels and `spawn_blocking`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use rust_cast::channels::media::{Media, Metadata, GenericMediaMetadata, Image, StreamType};
use rust_cast::channels::receiver::CastDeviceApp;
use rust_cast::{CastDevice, ChannelMessage};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::models::chromecast::{
    CastMediaRequest, CastSession, CastSessionState, CastStreamKind, ChromecastDevice,
};
use crate::state::AppState;

static SESSION_UID: AtomicU64 = AtomicU64::new(1);

const CAST_SERVICE_TYPE: &str = "_googlecast._tcp.local.";
const DEFAULT_RECEIVER_ID: &str = "receiver-0";
const CAST_STATUS_EVENT: &str = "cast://status";

/// One-shot mDNS scan that browses for Chromecast devices and returns the set
/// resolved within `wait`. Default wait keeps the UI snappy while still giving
/// devices time to respond.
pub async fn discover(wait: Duration) -> Result<Vec<ChromecastDevice>, AppError> {
    let daemon = ServiceDaemon::new()
        .map_err(|e| AppError::Other(format!("mDNS daemon init failed: {e}")))?;
    let receiver = daemon
        .browse(CAST_SERVICE_TYPE)
        .map_err(|e| AppError::Other(format!("mDNS browse failed: {e}")))?;

    // Spawn a blocking task that drains events from the flume receiver until the
    // wait deadline elapses, then deduplicates by device id.
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
    let model = info
        .get_property_val_str("md")
        .map(|s| s.to_string());
    Some(ChromecastDevice {
        id,
        friendly_name,
        model,
        host,
        port: info.port,
    })
}

/// Commands sent from the async world into the blocking session worker.
#[derive(Debug)]
enum SessionCommand {
    Stop,
}

/// State the AppState tracks per active cast session. Only one session at a
/// time is supported in the current scope.
pub struct ActiveCastSession {
    pub session: CastSession,
    /// Unique-per-process id, used by the worker's self-cleanup path to verify
    /// the stored session is still its own (and not a successor) before
    /// clearing it from `AppState`.
    pub uid: u64,
    cmd_tx: std::sync::mpsc::Sender<SessionCommand>,
    worker: Option<JoinHandle<()>>,
}

impl ActiveCastSession {
    pub fn snapshot(&self) -> CastSession {
        self.session.clone()
    }

    pub async fn stop(mut self) {
        let _ = self.cmd_tx.send(SessionCommand::Stop);
        if let Some(handle) = self.worker.take() {
            let _ = handle.await;
        }
    }
}

/// Start a Cast session: connect, launch the default media receiver, load
/// media. Spawns a worker thread that owns the `CastDevice` and handles
/// heartbeats and shutdown commands.
pub async fn start_session(
    app: AppHandle,
    device: ChromecastDevice,
    request: CastMediaRequest,
    cast_url: String,
) -> Result<ActiveCastSession, AppError> {
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<SessionCommand>();
    let (ready_tx, ready_rx) =
        tokio::sync::oneshot::channel::<Result<(String, String), AppError>>();

    let uid = SESSION_UID.fetch_add(1, Ordering::Relaxed);
    let device_for_worker = device.clone();
    let request_for_worker = request.clone();
    let cast_url_for_worker = cast_url.clone();
    let app_for_worker = app.clone();

    let worker = tokio::task::spawn_blocking(move || {
        run_session_worker(
            app_for_worker,
            uid,
            device_for_worker,
            request_for_worker,
            cast_url_for_worker,
            cmd_rx,
            ready_tx,
        );
    });

    let (session_id, transport_id) = ready_rx
        .await
        .map_err(|_| AppError::Other("Cast worker exited before ready".to_string()))??;
    log::info!(
        "[Chromecast] Session ready on '{}' (session_id={session_id}, transport_id={transport_id})",
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
        cmd_tx,
        worker: Some(worker),
    })
}

fn run_session_worker(
    app: AppHandle,
    uid: u64,
    device: ChromecastDevice,
    request: CastMediaRequest,
    cast_url: String,
    cmd_rx: std::sync::mpsc::Receiver<SessionCommand>,
    ready_tx: tokio::sync::oneshot::Sender<Result<(String, String), AppError>>,
) {
    // Connect (without host verification — Chromecast self-signed certs).
    let cast = match CastDevice::connect_without_host_verification(device.host.clone(), device.port)
    {
        Ok(c) => c,
        Err(err) => {
            let _ = ready_tx.send(Err(AppError::Other(format!(
                "Failed to connect to {}: {err}",
                device.host
            ))));
            return;
        }
    };

    if let Err(err) = cast.connection.connect(DEFAULT_RECEIVER_ID.to_string()) {
        let _ = ready_tx.send(Err(AppError::Other(format!(
            "Cast connect handshake failed: {err}"
        ))));
        return;
    }

    let app_handle = match cast.receiver.launch_app(&CastDeviceApp::DefaultMediaReceiver) {
        Ok(app) => app,
        Err(err) => {
            let _ = ready_tx.send(Err(AppError::Other(format!(
                "Default media receiver launch failed: {err}"
            ))));
            return;
        }
    };

    let transport_id = app_handle.transport_id.clone();
    let session_id = app_handle.session_id.clone();
    if let Err(err) = cast.connection.connect(transport_id.clone()) {
        let _ = ready_tx.send(Err(AppError::Other(format!(
            "Receiver app connect failed: {err}"
        ))));
        return;
    }

    let content_type = match request.stream_kind {
        CastStreamKind::Hls => "application/vnd.apple.mpegurl",
        CastStreamKind::MpegTs => "video/mp2t",
        CastStreamKind::Other => "application/octet-stream",
    };

    let metadata = Metadata::Generic(GenericMediaMetadata {
        title: request.channel_name.clone(),
        subtitle: None,
        images: request
            .channel_logo
            .clone()
            .map(|url| vec![Image::new(url)])
            .unwrap_or_default(),
        release_date: None,
    });

    let media = Media {
        content_id: cast_url.clone(),
        stream_type: StreamType::Live,
        content_type: content_type.to_string(),
        metadata: Some(metadata),
        duration: None,
    };

    if let Err(err) = cast
        .media
        .load(transport_id.clone(), session_id.clone(), &media)
    {
        let _ = ready_tx.send(Err(AppError::Other(format!("LOAD failed: {err}"))));
        return;
    }

    if ready_tx
        .send(Ok((session_id.clone(), transport_id.clone())))
        .is_err()
    {
        // Caller dropped — stop session immediately.
        let _ = cast.receiver.stop_app(session_id.clone());
        return;
    }

    // Drive the session: respond to heartbeats, watch for stop commands or
    // disconnects. This loop runs until a Stop command arrives, the device
    // disconnects, or a fatal error occurs.
    //
    // `manual_stop` distinguishes the explicit Stop command (where the caller
    // already cleared `AppState` before sending Stop) from self-exit paths
    // (Connection::Close, errors), where the worker must clear the stored
    // session itself so `get_cast_status()` doesn't keep reporting Playing.
    let mut manual_stop = false;
    loop {
        if let Ok(SessionCommand::Stop) = cmd_rx.try_recv() {
            let _ = cast.media.stop(transport_id.clone(), 0);
            let _ = cast.receiver.stop_app(session_id.clone());
            emit_state(&app, &device, CastSessionState::Stopped, &cast_url, &request, None);
            log::info!("[Chromecast] Session on '{}' stopped", device.friendly_name);
            manual_stop = true;
            break;
        }

        match cast.receive() {
            Ok(ChannelMessage::Heartbeat(_)) => {
                if let Err(err) = cast.heartbeat.pong() {
                    log::warn!("[Chromecast] Heartbeat pong failed: {err}");
                    emit_error(&app, &device, format!("Cast device disconnected: {err}"));
                    break;
                }
            }
            Ok(ChannelMessage::Connection(
                rust_cast::channels::connection::ConnectionResponse::Close,
            )) => {
                log::info!("[Chromecast] Receiver closed connection");
                emit_state(&app, &device, CastSessionState::Stopped, &cast_url, &request, None);
                break;
            }
            Ok(_) => {}
            Err(err) => {
                let msg = format!("{err}");
                log::warn!("[Chromecast] receive() error: {msg}");
                emit_error(&app, &device, msg);
                break;
            }
        }
    }

    // On self-exit, clear AppState so a remounted frontend that calls
    // `get_cast_status()` no longer sees a stale Playing state. The uid match
    // prevents us from clearing a successor session that was started after we
    // disconnected.
    if !manual_stop {
        let app_for_cleanup = app.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current().map(|h| h) {
            handle.spawn(async move {
                clear_app_state_if_uid_matches(&app_for_cleanup, uid).await;
            });
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

fn emit_error(app: &AppHandle, device: &ChromecastDevice, message: String) {
    let session = CastSession {
        device_id: device.id.clone(),
        device_name: device.friendly_name.clone(),
        state: CastSessionState::Error,
        stream_url: String::new(),
        channel_name: None,
        channel_logo: None,
        error_message: Some(message),
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
