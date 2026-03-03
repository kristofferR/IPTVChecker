use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_store::StoreExt;

use crate::error::AppError;
use crate::models::settings::AppSettings;
use crate::state::AppState;

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, AppError> {
    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    app: tauri::AppHandle,
    settings: AppSettings,
) -> Result<(), AppError> {
    let state = app.state::<Arc<AppState>>();
    let mut current = state.settings.lock().await;
    log::set_max_level(settings.level_filter());
    *current = settings.clone();

    // Persist to store
    if let Ok(store) = app.store("settings.json") {
        if let Ok(value) = serde_json::to_value(&settings) {
            store.set("settings", value);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn check_ffmpeg_available(app: tauri::AppHandle) -> Result<(bool, bool), AppError> {
    let (ffmpeg, ffprobe) = crate::engine::ffmpeg::check_availability(&app).await;
    Ok((ffmpeg, ffprobe))
}
