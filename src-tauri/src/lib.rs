pub mod commands;
pub mod engine;
pub mod error;
pub mod models;
pub mod state;

use std::sync::Arc;

use state::AppState;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Trace)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_haptics::init());

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

            let settings_menu_item = MenuItemBuilder::with_id("menu.app.settings", "Settings...")
                .accelerator("Cmd+,")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "IPTV Checker")
                .about(Some(AboutMetadata::default()))
                .separator()
                .item(&settings_menu_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_menu = SubmenuBuilder::with_id(app, "menu.file", "File")
                .text("menu.file.open", "Open Playlist...")
                .text("menu.file.open_folder", "Open Folder...")
                .text("menu.file.open_url", "Open URL...")
                .item(
                    &SubmenuBuilder::with_id(app, "menu.file.open_recent", "Open Recent")
                        .text("menu.file.recent.0", "No recent playlists")
                        .separator()
                        .text("menu.file.recent.clear", "Clear Recent")
                        .build()?,
                )
                .separator()
                .text("menu.file.export_csv", "Export CSV")
                .text("menu.file.export_split", "Export Split Playlists")
                .text("menu.file.export_renamed", "Export Renamed Playlist")
                .text("menu.file.export_filtered_m3u", "Export Filtered M3U/M3U8")
                .text("menu.file.export_scan_log", "Export Scan Log (JSON)")
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .text("menu.view.toggle_sidebar", "Toggle Sidebar")
                .text("menu.view.toggle_prescan_filter", "Show Pre-scan Filter")
                .text("menu.view.clear_filters", "Clear Filters")
                .text("menu.view.history", "Scan History")
                .build()?;

            let scan_menu = SubmenuBuilder::new(app, "Scan")
                .text("menu.scan.start", "Start Scan")
                .text("menu.scan.pause", "Pause Scan")
                .text("menu.scan.resume", "Resume Scan")
                .text("menu.scan.stop", "Stop Scan")
                .separator()
                .text("menu.scan.settings", "Scan Settings")
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .text("menu.help.shortcuts", "Keyboard Shortcuts")
                .separator()
                .text("menu.help.check_updates", "Check for Updates")
                .build()?;

            MenuBuilder::new(app)
                .item(&app_menu)
                .item(&file_menu)
                .item(&view_menu)
                .item(&scan_menu)
                .item(&help_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            let frontend_event = match event.id().as_ref() {
                "menu.app.settings" => Some("menu://open-settings"),
                "menu.file.open" => Some("menu://open-playlist"),
                "menu.file.open_folder" => Some("menu://open-folder"),
                "menu.file.open_url" => Some("menu://open-url"),
                "menu.file.recent.0" => Some("menu://open-recent-0"),
                "menu.file.recent.1" => Some("menu://open-recent-1"),
                "menu.file.recent.2" => Some("menu://open-recent-2"),
                "menu.file.recent.3" => Some("menu://open-recent-3"),
                "menu.file.recent.4" => Some("menu://open-recent-4"),
                "menu.file.recent.5" => Some("menu://open-recent-5"),
                "menu.file.recent.6" => Some("menu://open-recent-6"),
                "menu.file.recent.7" => Some("menu://open-recent-7"),
                "menu.file.recent.8" => Some("menu://open-recent-8"),
                "menu.file.recent.9" => Some("menu://open-recent-9"),
                "menu.file.recent.clear" => Some("menu://clear-recent"),
                "menu.file.export_csv" => Some("menu://export-csv"),
                "menu.file.export_split" => Some("menu://export-split"),
                "menu.file.export_renamed" => Some("menu://export-renamed"),
                "menu.file.export_filtered_m3u" => Some("menu://export-filtered-m3u"),
                "menu.file.export_scan_log" => Some("menu://export-scan-log"),
                "menu.view.toggle_sidebar" => Some("menu://toggle-sidebar"),
                "menu.view.toggle_prescan_filter" => Some("menu://toggle-prescan-filter"),
                "menu.view.clear_filters" => Some("menu://clear-filters"),
                "menu.view.history" => Some("menu://open-history"),
                "menu.scan.start" => Some("menu://start-scan"),
                "menu.scan.pause" => Some("menu://pause-scan"),
                "menu.scan.resume" => Some("menu://resume-scan"),
                "menu.scan.stop" => Some("menu://stop-scan"),
                "menu.scan.settings" => Some("menu://open-settings"),
                "menu.help.shortcuts" => Some("menu://keyboard-shortcuts"),
                "menu.help.check_updates" => Some("menu://check-updates"),
                _ => None,
            };

            if let Some(name) = frontend_event {
                let _ = app.emit(name, ());
            }
        });

    builder
        .setup(|app| {
            // Load persisted settings
            if let Ok(store) = app.store("settings.json") {
                if let Some(value) = store.get("settings") {
                    if let Ok(persisted) =
                        serde_json::from_value::<models::settings::AppSettings>(value)
                    {
                        let state = app.state::<Arc<AppState>>();
                        log::set_max_level(persisted.level_filter());
                        *state.settings.blocking_lock() = persisted;
                    }
                }
            }

            let theme_preference = {
                let state = app.state::<Arc<AppState>>();
                let theme = state.settings.blocking_lock().theme;
                theme
            };
            if let Err(error) =
                commands::settings::apply_theme_preference(&app.handle(), theme_preference)
            {
                log::warn!("Failed to apply startup theme preference: {}", error);
            }

            commands::recent::refresh_recent_menu(&app.handle());

            // Enable _useSystemAppearance on WKWebView so CSS
            // `-apple-visual-effect: -apple-system-glass-material` works.
            #[cfg(target_os = "macos")]
            {
                use cocoa::base::{id, nil, NO};
                use objc::runtime::{Class, BOOL, YES};
                use objc::{msg_send, sel, sel_impl};

                unsafe fn find_webview(view: id) -> Option<id> {
                    if view == nil {
                        return None;
                    }
                    if let Some(cls) = Class::get("WKWebView") {
                        let is_wk: BOOL = msg_send![view, isKindOfClass: cls];
                        if is_wk != NO {
                            return Some(view);
                        }
                    }
                    let subviews: id = msg_send![view, subviews];
                    let count: usize = msg_send![subviews, count];
                    for i in 0..count {
                        let subview: id = msg_send![subviews, objectAtIndex: i];
                        if let Some(wv) = find_webview(subview) {
                            return Some(wv);
                        }
                    }
                    None
                }

                if let Some(window) = app.get_webview_window("main") {
                    let ns_window: id = window.ns_window().unwrap() as id;
                    unsafe {
                        let content_view: id = msg_send![ns_window, contentView];
                        if let Some(webview) = find_webview(content_view) {
                            let config: id = msg_send![webview, configuration];
                            let prefs: id = msg_send![config, preferences];
                            let _: () =
                                msg_send![prefs, _setUseSystemAppearance: YES];
                        }
                    }
                }
            }

            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::TrayIconBuilder;

                let open_item = MenuItemBuilder::with_id("tray.open", "Open IPTV Checker")
                    .build(app)?;
                let quit_item = MenuItemBuilder::with_id("tray.quit", "Quit").build(app)?;

                let tray_menu = MenuBuilder::new(app)
                    .item(&open_item)
                    .separator()
                    .item(&quit_item)
                    .build()?;

                let mut tray_builder = TrayIconBuilder::with_id("main")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "tray.open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "tray.quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    });

                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }

                if let Err(error) = tray_builder.build(app) {
                    log::warn!("Failed to initialize system tray: {}", error);
                }
            }

            Ok(())
        })
        .manage(AppState::new() as Arc<AppState>)
        .invoke_handler(tauri::generate_handler![
            commands::playlist::open_playlist,
            commands::playlist::open_playlist_url,
            commands::playlist::open_playlist_xtream,
            commands::player::open_channel_in_player,
            commands::scan::start_scan,
            commands::scan::pause_scan,
            commands::scan::resume_scan,
            commands::scan::cancel_scan,
            commands::scan::reset_scan,
            commands::export::export_csv,
            commands::export::export_split,
            commands::export::export_renamed,
            commands::export::export_m3u,
            commands::export::export_scan_log_json,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::check_ffmpeg_available,
            commands::settings::read_screenshot,
            commands::settings::get_screenshot_cache_stats,
            commands::settings::clear_screenshot_cache,
            commands::history::get_scan_history,
            commands::history::clear_scan_history,
            commands::recent::get_recent_playlists,
            commands::recent::add_recent_playlist,
            commands::recent::clear_recent_playlists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
