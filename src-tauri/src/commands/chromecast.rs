use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::engine::chromecast;
use crate::engine::media_proxy::{self, ReceiverProfile};
use crate::engine::stream_proxy;
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

    // Serialize the entire teardown/start/store sequence so overlapping
    // cast_to_device / stop_cast calls cannot interleave and orphan a session.
    let _lifecycle = state.cast_lifecycle_lock.lock().await;

    // Mutual exclusion with AirPlay (macOS only): a single upstream slot
    // can't service both an Apple TV and a Chromecast, and the user only
    // has eyes on one TV. Take the AirPlay lifecycle lock so we don't race
    // a concurrent start_airplay.
    #[cfg(target_os = "macos")]
    {
        let _airplay_lifecycle = state.airplay_lifecycle_lock.lock().await;
        let (airplay_session, airplay_proxy) = {
            let mut guard = state.airplay_state.lock().await;
            (guard.session.take(), guard.proxy.take())
        };
        if let Some(handle) = airplay_proxy {
            handle.shutdown();
        }
        if let Some(active) = airplay_session {
            active.stop_silent(&app).await;
        }
    }

    // Same-device redirect? Try a seamless media swap on the live receiver
    // session — sends a fresh LOAD on the existing MediaController so the TV
    // doesn't flash back to its launcher between channel changes.
    //
    // Combine the device check and the take into one critical section: the
    // worker self-cleanup (`clear_app_state_if_uid_matches`) only acquires
    // `cast_state`, not `cast_lifecycle_lock`, so a 5s drive_session tick
    // detecting a disconnect could otherwise null `guard.session` between a
    // detached check and a follow-up `take().expect("checked above")` — and
    // panic the command thread.
    let same_device_take = {
        let mut guard = state.cast_state.lock().await;
        let matches = guard
            .session
            .as_ref()
            .map(|s| s.session.device_id == device.id)
            .unwrap_or(false);
        if matches {
            // unwrap is safe under the same lock that just observed `is_some`.
            Some((guard.session.take().unwrap(), guard.proxy.take()))
        } else {
            None
        }
    };

    if let Some((mut active, prior_proxy)) = same_device_take {
        // Same as the fresh-launch path below: drop any local-player upstream
        // fetch so single-credential IPTV portals don't reject ffmpeg's load
        // with HTTP 458.
        stream_proxy::cancel_active_local_streams(state.inner()).await;

        match media_proxy::start(
            app.clone(),
            request.original_url.clone(),
            request.stream_kind,
            ReceiverProfile::Chromecast,
        )
        .await
        {
            Ok(new_proxy) => {
                let new_cast_url = new_proxy.url.clone();
                let new_is_dash = new_proxy.is_dash;
                match active
                    .swap_media(&app, request.clone(), new_cast_url.clone(), new_is_dash)
                    .await
                {
                    Ok(snapshot) => {
                        {
                            let mut guard = state.cast_state.lock().await;
                            guard.session = Some(active);
                            guard.proxy = Some(new_proxy);
                        }
                        if let Some(p) = prior_proxy {
                            p.shutdown();
                        }
                        return Ok(snapshot);
                    }
                    Err(err) => {
                        log::warn!(
                            "[Chromecast] Hot-swap failed, falling back to fresh launch: {err}"
                        );
                        new_proxy.shutdown();
                        // Silent stop: a fresh launch follows immediately, and
                        // emitting `Stopped` here would race the new `Playing`
                        // event in the renderer and flicker the cast UI.
                        active.stop_silent().await;
                        if let Some(p) = prior_proxy {
                            p.shutdown();
                        }
                        // Fall through to the fresh-launch path below.
                    }
                }
            }
            Err(err) => {
                // Couldn't start the new proxy — restore the live session and
                // bail. Existing cast keeps playing on the old proxy.
                {
                    let mut guard = state.cast_state.lock().await;
                    guard.session = Some(active);
                    guard.proxy = prior_proxy;
                }
                return Err(err);
            }
        }
    } else {
        // Different device or no prior session — tear down whatever's there.
        // Silent stop because a new session is starting immediately on the
        // line below; the new `Playing` event is the source of truth.
        let (prior_session, prior_proxy) = {
            let mut guard = state.cast_state.lock().await;
            (guard.session.take(), guard.proxy.take())
        };
        if let Some(handle) = prior_proxy {
            handle.shutdown();
        }
        if let Some(active) = prior_session {
            active.stop_silent().await;
        }
    }

    // Release the upstream slot before ffmpeg connects (HTTP 458 mitigation
    // on single-credential IPTV portals — see comment in `start_airplay`).
    stream_proxy::cancel_active_local_streams(state.inner()).await;

    let proxy_handle = media_proxy::start(
        app.clone(),
        request.original_url.clone(),
        request.stream_kind,
        ReceiverProfile::Chromecast,
    )
    .await?;
    let cast_url = proxy_handle.url.clone();

    let session = match chromecast::start_session(
        app.clone(),
        device.clone(),
        request.clone(),
        cast_url.clone(),
        proxy_handle.is_dash,
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

    // Serialize against in-flight cast_to_device transitions.
    let _lifecycle = state.cast_lifecycle_lock.lock().await;

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
