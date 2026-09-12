use std::sync::Arc;

use tauri::Manager;
use tokio_util::sync::CancellationToken;

use crate::engine::cast_proxy;
use crate::error::AppError;
use crate::state::{AppState, LocalPlaybackState};

#[tauri::command]
pub async fn start_local_playback(
    window: tauri::WebviewWindow,
    url: String,
    request_id: String,
) -> Result<String, AppError> {
    let parsed =
        url::Url::parse(&url).map_err(|_| AppError::Other("Invalid playback URL".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::Other(
            "Playback requires an HTTP or HTTPS URL".into(),
        ));
    }
    let state = window.state::<Arc<AppState>>();
    let cancel = CancellationToken::new();
    state
        .local_playback
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            window.label().to_string(),
            LocalPlaybackState {
                request_id: request_id.clone(),
                cancel: cancel.clone(),
                proxy: None,
            },
        );

    let result =
        cast_proxy::start_local_playback(window.app_handle().clone(), url, cancel.clone()).await;
    let mut sessions = state
        .local_playback
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(session) = sessions
        .get_mut(window.label())
        .filter(|s| s.request_id == request_id)
    else {
        return Err(AppError::Other("Playback cancelled".into()));
    };
    match result {
        Ok(proxy) if !cancel.is_cancelled() => {
            let url = proxy.url.clone();
            session.proxy = Some(proxy);
            Ok(url)
        }
        result => {
            sessions.remove(window.label());
            Err(result
                .err()
                .unwrap_or_else(|| AppError::Other("Playback cancelled".into())))
        }
    }
}

#[tauri::command]
pub async fn stop_local_playback(window: tauri::WebviewWindow, request_id: String) {
    let state = window.state::<Arc<AppState>>();
    let mut sessions = state
        .local_playback
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if sessions
        .get(window.label())
        .is_some_and(|s| s.request_id == request_id)
    {
        sessions.remove(window.label());
    }
}
