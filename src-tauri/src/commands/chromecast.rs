use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::engine::cast_proxy;
use crate::engine::chromecast;
use crate::error::AppError;
use crate::models::chromecast::{CastMediaRequest, CastSession, ChromecastDevice};
use crate::state::AppState;

const DISCOVERY_WINDOW: Duration = Duration::from_millis(2500);

#[tauri::command]
pub async fn discover_chromecasts() -> Result<Vec<ChromecastDevice>, AppError> {
    chromecast::discover(DISCOVERY_WINDOW).await
}

#[tauri::command]
pub async fn cast_to_device(
    app: AppHandle,
    device: ChromecastDevice,
    request: CastMediaRequest,
) -> Result<CastSession, AppError> {
    let state = app.state::<Arc<AppState>>();

    // Tear down any prior session before starting a new one.
    let (prior_session, prior_proxy) = {
        let mut guard = state.cast_state.lock().await;
        (guard.session.take(), guard.proxy.take())
    };
    if let Some(handle) = prior_proxy {
        handle.shutdown();
    }
    if let Some(active) = prior_session {
        active.stop().await;
    }

    let proxy_handle = cast_proxy::start(
        app.clone(),
        request.original_url.clone(),
        request.stream_kind,
    )
    .await?;
    let cast_url = proxy_handle.url.clone();

    let session = match chromecast::start_session(
        app.clone(),
        device.clone(),
        request.clone(),
        cast_url.clone(),
    )
    .await
    {
        Ok(s) => s,
        Err(err) => {
            proxy_handle.shutdown();
            return Err(err);
        }
    };

    let snapshot = session.snapshot();
    {
        let mut guard = state.cast_state.lock().await;
        guard.session = Some(session);
        guard.proxy = Some(proxy_handle);
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn stop_cast(app: AppHandle) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let (session, proxy) = {
        let mut guard = state.cast_state.lock().await;
        (guard.session.take(), guard.proxy.take())
    };
    if let Some(handle) = proxy {
        handle.shutdown();
    }
    if let Some(active) = session {
        active.stop().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_cast_status(app: AppHandle) -> Option<CastSession> {
    let state = app.state::<Arc<AppState>>();
    let guard = state.cast_state.lock().await;
    guard.session.as_ref().map(|active| active.snapshot())
}
