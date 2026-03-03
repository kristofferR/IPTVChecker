use std::sync::Arc;
use std::{fs, path::Path};

use tauri::Manager;
use tauri_plugin_store::StoreExt;

use crate::error::AppError;
use crate::models::settings::AppSettings;
use crate::state::AppState;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScreenshotCacheStats {
    pub file_count: usize,
    pub total_bytes: u64,
    pub cache_dir: String,
}

fn screenshot_cache_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .temp_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("iptv-checker-screenshots")
}

fn collect_dir_stats(path: &Path) -> Result<(u64, usize), std::io::Error> {
    if !path.exists() {
        return Ok((0, 0));
    }

    let mut total_bytes = 0u64;
    let mut file_count = 0usize;

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            let (nested_bytes, nested_count) = collect_dir_stats(&entry.path())?;
            total_bytes += nested_bytes;
            file_count += nested_count;
        } else if metadata.is_file() {
            total_bytes += metadata.len();
            file_count += 1;
        }
    }

    Ok((total_bytes, file_count))
}

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

/// Read a screenshot file and return it as a base64-encoded data URL.
/// This bypasses asset protocol / fs scope restrictions.
#[tauri::command]
pub async fn read_screenshot(path: String) -> Result<String, AppError> {
    use base64::Engine;
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::Other(format!("Failed to read screenshot: {}", e)))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

#[tauri::command]
pub async fn get_screenshot_cache_stats(
    app: tauri::AppHandle,
) -> Result<ScreenshotCacheStats, AppError> {
    let cache_root = screenshot_cache_root(&app);
    let (total_bytes, file_count) = collect_dir_stats(&cache_root).map_err(AppError::Io)?;

    Ok(ScreenshotCacheStats {
        file_count,
        total_bytes,
        cache_dir: cache_root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn clear_screenshot_cache(
    app: tauri::AppHandle,
) -> Result<ScreenshotCacheStats, AppError> {
    let cache_root = screenshot_cache_root(&app);
    if cache_root.exists() {
        fs::remove_dir_all(&cache_root).map_err(AppError::Io)?;
    }

    Ok(ScreenshotCacheStats {
        file_count: 0,
        total_bytes: 0,
        cache_dir: cache_root.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::collect_dir_stats;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn collect_dir_stats_counts_nested_files_and_bytes() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-cache-stats-{unique}"));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir should be created");
        std::fs::write(root.join("a.png"), vec![0u8; 5]).expect("fixture file should be writable");
        std::fs::write(nested.join("b.png"), vec![0u8; 7]).expect("fixture file should be writable");

        let (bytes, files) = collect_dir_stats(&root).expect("stats should be readable");
        assert_eq!(files, 2);
        assert_eq!(bytes, 12);

        std::fs::remove_dir_all(root).expect("fixture dir should be removable");
    }
}
