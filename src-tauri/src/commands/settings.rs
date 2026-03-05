use std::collections::HashSet;
use std::sync::Arc;
use std::{fs, path::Path};

use tauri::Manager;
use tauri_plugin_store::StoreExt;

use crate::error::AppError;
use crate::models::settings::{AppSettings, ThemePreference};
use crate::state::AppState;

const MAX_SCREENSHOT_BYTES: u64 = 10 * 1024 * 1024;
const MIN_SCAN_HISTORY_LIMIT: u32 = 1;
const MAX_SCAN_HISTORY_LIMIT: u32 = 200;
const MIN_LOW_FPS_THRESHOLD: f64 = 0.0;
const MAX_LOW_FPS_THRESHOLD: f64 = 240.0;

pub fn apply_theme_preference(
    app: &tauri::AppHandle,
    preference: ThemePreference,
) -> Result<(), AppError> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(AppError::Other("Main window not found".to_string()));
    };

    let theme = match preference {
        ThemePreference::System => None,
        ThemePreference::Light => Some(tauri::Theme::Light),
        ThemePreference::Dark => Some(tauri::Theme::Dark),
    };

    window
        .set_theme(theme)
        .map_err(|error| AppError::Other(format!("Failed to apply theme: {}", error)))?;

    Ok(())
}

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

fn canonicalize_root_if_exists(path: &Path) -> Option<std::path::PathBuf> {
    if !path.exists() {
        return None;
    }
    path.canonicalize().ok()
}

fn is_supported_screenshot_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("png"))
        .unwrap_or(false)
}

fn validate_screenshot_path(
    requested_path: &Path,
    allowed_roots: &[std::path::PathBuf],
) -> Result<std::path::PathBuf, AppError> {
    let canonical_path = requested_path
        .canonicalize()
        .map_err(|e| AppError::Other(format!("Failed to resolve screenshot path: {}", e)))?;

    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|e| AppError::Other(format!("Failed to inspect screenshot: {}", e)))?;

    if !metadata.is_file() {
        return Err(AppError::Other(
            "Access denied: screenshot path must point to a file".to_string(),
        ));
    }

    if !is_supported_screenshot_extension(&canonical_path) {
        return Err(AppError::Other(
            "Access denied: only .png screenshot files are allowed".to_string(),
        ));
    }

    if metadata.len() > MAX_SCREENSHOT_BYTES {
        return Err(AppError::Other(format!(
            "Access denied: screenshot exceeds max size of {} bytes",
            MAX_SCREENSHOT_BYTES
        )));
    }

    if allowed_roots
        .iter()
        .any(|root| canonical_path.starts_with(root))
    {
        return Ok(canonical_path);
    }

    Err(AppError::Other(
        "Access denied: screenshot path is outside allowed directories".to_string(),
    ))
}

async fn allowed_screenshot_roots(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let mut roots: HashSet<std::path::PathBuf> = HashSet::new();

    if let Some(path) = canonicalize_root_if_exists(&screenshot_cache_root(app)) {
        roots.insert(path);
    }

    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().await;
    if let Some(custom_dir) = settings.screenshots_dir.as_deref() {
        if let Some(path) = canonicalize_root_if_exists(Path::new(custom_dir)) {
            roots.insert(path);
        }
    }

    roots.into_iter().collect()
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

#[cfg(target_os = "macos")]
fn set_default_m3u8_handler(app: &tauri::AppHandle) -> Result<String, AppError> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    type OSStatus = i32;
    type LSRolesMask = u32;
    const K_LS_ROLES_ALL: LSRolesMask = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        static kUTTagClassFilenameExtension: CFStringRef;
        fn UTTypeCreatePreferredIdentifierForTag(
            in_tag_class: CFStringRef,
            in_tag: CFStringRef,
            in_conforming_to_uti: CFStringRef,
        ) -> CFStringRef;
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_roles: LSRolesMask,
            in_handler_bundle_id: CFStringRef,
        ) -> OSStatus;
    }

    let bundle_id = app.config().identifier.as_str();
    if bundle_id.trim().is_empty() {
        return Err(AppError::Other(
            "App bundle identifier is missing; cannot set default handler".to_string(),
        ));
    }

    let extension = CFString::new("m3u8");
    let handler_bundle = CFString::new(bundle_id);
    let content_type = unsafe {
        let uti_ref = UTTypeCreatePreferredIdentifierForTag(
            kUTTagClassFilenameExtension,
            extension.as_concrete_TypeRef(),
            std::ptr::null(),
        );
        if uti_ref.is_null() {
            return Err(AppError::Other(
                "macOS could not resolve the .m3u8 content type".to_string(),
            ));
        }
        CFString::wrap_under_create_rule(uti_ref)
    };

    let status = unsafe {
        LSSetDefaultRoleHandlerForContentType(
            content_type.as_concrete_TypeRef(),
            K_LS_ROLES_ALL,
            handler_bundle.as_concrete_TypeRef(),
        )
    };
    if status != 0 {
        return Err(AppError::Other(format!(
            "macOS LaunchServices failed to set default app for .m3u8 (error {})",
            status
        )));
    }

    Ok("IPTV Checker is now the default app for .m3u8 files.".to_string())
}

#[cfg(target_os = "linux")]
fn set_default_m3u8_handler(app: &tauri::AppHandle) -> Result<String, AppError> {
    use std::process::Command;

    let identifier = app.config().identifier.as_str();
    if identifier.trim().is_empty() {
        return Err(AppError::Other(
            "App identifier is missing; cannot set default handler".to_string(),
        ));
    }

    let desktop_id = format!("{}.desktop", identifier);
    for mime_type in ["application/vnd.apple.mpegurl", "audio/x-mpegurl"] {
        let output = Command::new("xdg-mime")
            .args(["default", desktop_id.as_str(), mime_type])
            .output()
            .map_err(|error| {
                AppError::Other(format!(
                    "Failed to execute xdg-mime for {}: {}",
                    mime_type, error
                ))
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stderr.is_empty() {
                "unknown error".to_string()
            } else {
                stderr
            };
            return Err(AppError::Other(format!(
                "xdg-mime failed for {} ({}): {}",
                mime_type,
                output.status,
                detail
            )));
        }
    }

    Ok("IPTV Checker is now the default app for .m3u8 files.".to_string())
}

#[cfg(target_os = "windows")]
fn set_default_m3u8_handler(_app: &tauri::AppHandle) -> Result<String, AppError> {
    use std::process::Command;

    Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:defaultapps"])
        .spawn()
        .map_err(|error| {
            AppError::Other(format!(
                "Failed to open Windows Default Apps settings: {}",
                error
            ))
        })?;

    Ok("Opened Windows Default Apps settings. Set IPTV Checker as default for .m3u8 there."
        .to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn set_default_m3u8_handler(_app: &tauri::AppHandle) -> Result<String, AppError> {
    Err(AppError::Other(
        "Setting default apps for .m3u8 is not supported on this platform".to_string(),
    ))
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, AppError> {
    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
pub async fn update_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), AppError> {
    if settings.scan_history_limit < MIN_SCAN_HISTORY_LIMIT
        || settings.scan_history_limit > MAX_SCAN_HISTORY_LIMIT
    {
        return Err(AppError::Other(format!(
            "Invalid scan history limit: must be between {} and {}",
            MIN_SCAN_HISTORY_LIMIT, MAX_SCAN_HISTORY_LIMIT
        )));
    }
    if !settings.low_fps_threshold.is_finite()
        || settings.low_fps_threshold < MIN_LOW_FPS_THRESHOLD
        || settings.low_fps_threshold > MAX_LOW_FPS_THRESHOLD
    {
        return Err(AppError::Other(format!(
            "Invalid low FPS threshold: must be between {} and {}",
            MIN_LOW_FPS_THRESHOLD, MAX_LOW_FPS_THRESHOLD
        )));
    }

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

    if let Err(error) = apply_theme_preference(&app, settings.theme) {
        log::warn!("Failed to apply theme preference: {}", error);
    }

    Ok(())
}

#[tauri::command]
pub async fn check_ffmpeg_available(app: tauri::AppHandle) -> Result<(bool, bool), AppError> {
    let (ffmpeg, ffprobe) = crate::engine::ffmpeg::check_availability(&app).await;
    Ok((ffmpeg, ffprobe))
}

#[tauri::command]
pub async fn set_default_m3u8_file_association(
    app: tauri::AppHandle,
) -> Result<String, AppError> {
    set_default_m3u8_handler(&app)
}

/// Read a screenshot file and return it as a base64-encoded data URL.
/// This bypasses asset protocol / fs scope restrictions.
#[tauri::command]
pub async fn read_screenshot(app: tauri::AppHandle, path: String) -> Result<String, AppError> {
    use base64::Engine;

    let requested = Path::new(path.trim());
    let allowed_roots = allowed_screenshot_roots(&app).await;
    let validated_path = validate_screenshot_path(requested, &allowed_roots)?;

    let bytes = std::fs::read(&validated_path)
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
    use super::{collect_dir_stats, validate_screenshot_path};
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
        std::fs::write(nested.join("b.png"), vec![0u8; 7])
            .expect("fixture file should be writable");

        let (bytes, files) = collect_dir_stats(&root).expect("stats should be readable");
        assert_eq!(files, 2);
        assert_eq!(bytes, 12);

        std::fs::remove_dir_all(root).expect("fixture dir should be removable");
    }

    #[test]
    fn validate_screenshot_path_rejects_traversal_outside_allowed_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-screenshot-root-{unique}"));
        let safe_dir = root.join("safe");
        let outside = root.join("outside.png");
        std::fs::create_dir_all(&safe_dir).expect("safe dir should be created");
        std::fs::write(&outside, vec![0u8; 16]).expect("outside fixture should be writable");

        let traversal = safe_dir.join("../outside.png");
        let allowed = vec![safe_dir
            .canonicalize()
            .expect("safe dir should canonicalize")];
        let error =
            validate_screenshot_path(&traversal, &allowed).expect_err("path should be rejected");

        assert!(error.to_string().contains("outside allowed directories"));
        std::fs::remove_dir_all(&root).expect("fixture root should be removable");
    }

    #[test]
    fn validate_screenshot_path_rejects_symlink_escape_attempt() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-screenshot-symlink-{unique}"));
        let safe_dir = root.join("safe");
        let outside = root.join("outside.png");
        let symlink_path = safe_dir.join("escape.png");

        std::fs::create_dir_all(&safe_dir).expect("safe dir should be created");
        std::fs::write(&outside, vec![0u8; 8]).expect("outside fixture should be writable");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &symlink_path).expect("symlink should be created");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &symlink_path)
            .expect("symlink should be created");

        let allowed = vec![safe_dir
            .canonicalize()
            .expect("safe dir should canonicalize")];
        let error = validate_screenshot_path(&symlink_path, &allowed)
            .expect_err("symlink escape should be rejected");

        assert!(error.to_string().contains("outside allowed directories"));
        std::fs::remove_dir_all(&root).expect("fixture root should be removable");
    }

    #[test]
    fn validate_screenshot_path_allows_png_within_allowed_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-screenshot-valid-{unique}"));
        std::fs::create_dir_all(&root).expect("root should be created");
        let screenshot = root.join("frame.png");
        std::fs::write(&screenshot, vec![0u8; 64]).expect("fixture screenshot should be writable");

        let allowed = vec![root.canonicalize().expect("root should canonicalize")];
        let validated = validate_screenshot_path(&screenshot, &allowed)
            .expect("in-scope png should be accepted");

        assert!(validated.ends_with("frame.png"));
        std::fs::remove_dir_all(&root).expect("fixture root should be removable");
    }
}
