//! macOS-only AirPlay commands.
//!
//! Mirrors the shape of `commands/chromecast.rs`: the lifecycle lock
//! serializes start/stop so concurrent invocations cannot orphan a session
//! or proxy. Mutual exclusion with Chromecast is enforced here too — only
//! one external receiver is active at a time, so starting AirPlay tears
//! down any live cast first (and `cast_to_device` reciprocates).

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::engine::airplay;
use crate::engine::media_proxy::{self, ReceiverProfile};
use crate::error::AppError;
use crate::models::airplay::{AirPlayMediaRequest, AirPlaySession};
use crate::state::AppState;

#[tauri::command]
pub async fn start_airplay(
    app: AppHandle,
    request: AirPlayMediaRequest,
) -> Result<AirPlaySession, AppError> {
    let state = app.state::<Arc<AppState>>();

    // Serialize the entire teardown/start/store sequence so overlapping
    // start_airplay / stop_airplay calls can't interleave.
    let _lifecycle = state.airplay_lifecycle_lock.lock().await;

    // Mutual exclusion with Chromecast: if a cast is live we must stop it
    // before opening a new upstream slot. Take the lifecycle lock through
    // the same path stop_cast uses so we don't race a concurrent cast op.
    {
        let _cast_lifecycle = state.cast_lifecycle_lock.lock().await;
        let (session, proxy) = {
            let mut guard = state.cast_state.lock().await;
            (guard.session.take(), guard.proxy.take())
        };
        if let Some(handle) = proxy {
            handle.shutdown();
        }
        if let Some(active) = session {
            active.stop_silent().await;
        }
    }

    // Tear down any prior AirPlay session before starting a new one. Silent
    // stop because the new `Playing` event published by start_session is
    // the source of truth — emitting `Stopped` here would race it.
    let (prior_session, prior_proxy) = {
        let mut guard = state.airplay_state.lock().await;
        (guard.session.take(), guard.proxy.take())
    };
    if let Some(handle) = prior_proxy {
        handle.shutdown();
    }
    if let Some(active) = prior_session {
        active.stop_silent(&app).await;
    }

    let proxy_handle = media_proxy::start(
        app.clone(),
        request.original_url.clone(),
        request.stream_kind,
        ReceiverProfile::AirPlay,
    )
    .await?;
    let proxy_url = proxy_handle.url.clone();

    let session = match airplay::start_session(app.clone(), request.clone(), proxy_url).await {
        Ok(s) => s,
        Err(err) => {
            proxy_handle.shutdown();
            return Err(err);
        }
    };

    let snapshot = session.snapshot();
    {
        let mut guard = state.airplay_state.lock().await;
        guard.session = Some(session);
        guard.proxy = Some(proxy_handle);
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn stop_airplay(app: AppHandle) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();

    let _lifecycle = state.airplay_lifecycle_lock.lock().await;

    let (session, proxy) = {
        let mut guard = state.airplay_state.lock().await;
        (guard.session.take(), guard.proxy.take())
    };
    if let Some(handle) = proxy {
        handle.shutdown();
    }
    if let Some(active) = session {
        active.stop(&app).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_airplay_status(app: AppHandle) -> Option<AirPlaySession> {
    let state = app.state::<Arc<AppState>>();
    let guard = state.airplay_state.lock().await;
    guard.session.as_ref().map(|active| active.snapshot())
}
