pub mod commands;
pub mod engine;
pub mod error;
pub mod models;
pub mod state;

use std::sync::Arc;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").expect("main window");
                let _ = window_vibrancy::apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    None,
                );
            }
            Ok(())
        })
        .manage(AppState::new() as Arc<AppState>)
        .invoke_handler(tauri::generate_handler![
            commands::playlist::open_playlist,
            commands::scan::start_scan,
            commands::scan::cancel_scan,
            commands::export::export_csv,
            commands::export::export_split,
            commands::export::export_renamed,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::check_ffmpeg_available,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
