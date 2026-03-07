pub mod commands;
pub mod engine;
pub mod error;
pub mod models;
pub mod state;

#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use state::AppState;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_liquid_glass::{LiquidGlassConfig, LiquidGlassExt};
use tauri_plugin_store::StoreExt;

#[cfg(target_os = "macos")]
static APP_IS_QUITTING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static WINDOW_CLOSED_BY_USER: AtomicBool = AtomicBool::new(false);
static NEXT_WINDOW_ID: AtomicUsize = AtomicUsize::new(1);

#[cfg(target_os = "macos")]
fn schedule_macos_system_appearance_patch(app: tauri::AppHandle, window_label: String) {
    if !app.liquid_glass().is_supported() {
        return;
    }

    std::thread::spawn(move || {
        for _attempt in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let handle = app.clone();
            let patched = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let patched_on_main = patched.clone();
            let target_label = window_label.clone();
            let _ = app.run_on_main_thread(move || {
                patched_on_main.store(false, Ordering::Relaxed);

                // Keep this patch local to macOS where the private selector exists.
                // We retry from the worker thread because the recreated window's
                // WKWebView hierarchy may not be fully attached immediately.
                use objc2::msg_send;
                use objc2::runtime::{AnyClass, AnyObject};
                type ObjcId = *mut AnyObject;

                unsafe fn find_webview(view: ObjcId, wkwebview_class: &AnyClass) -> Option<ObjcId> {
                    if view.is_null() {
                        return None;
                    }
                    let is_wk: bool = msg_send![view, isKindOfClass: wkwebview_class];
                    if is_wk {
                        return Some(view);
                    }
                    let subviews: ObjcId = msg_send![view, subviews];
                    let count: usize = msg_send![subviews, count];
                    for i in 0..count {
                        let subview: ObjcId = msg_send![subviews, objectAtIndex: i];
                        if let Some(wv) = find_webview(subview, wkwebview_class) {
                            return Some(wv);
                        }
                    }
                    None
                }

                if let Some(window) = handle.get_webview_window(&target_label) {
                    if let Ok(ns_window) = window.ns_window() {
                        unsafe {
                            let ns_window = ns_window as ObjcId;
                            let content_view: ObjcId = msg_send![ns_window, contentView];
                            if let Some(wkwebview_class) = AnyClass::get(c"WKWebView") {
                                if let Some(webview) = find_webview(content_view, wkwebview_class) {
                                    let config: ObjcId = msg_send![webview, configuration];
                                    let prefs: ObjcId = msg_send![config, preferences];
                                    let _: () = msg_send![prefs, _setUseSystemAppearance: true];
                                    patched_on_main.store(true, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                }
            });

            if patched.load(Ordering::Relaxed) {
                break;
            }
        }
    });
}

fn create_window_from_main_config(app: &tauri::AppHandle, label: String) {
    let Some(mut window_config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|cfg| cfg.label == "main")
        .cloned()
        .or_else(|| app.config().app.windows.first().cloned())
    else {
        log::error!("Cannot recreate main window: no window config found");
        return;
    };

    window_config.label = label;

    match tauri::WebviewWindowBuilder::from_config(app, &window_config)
        .and_then(|builder| builder.build())
    {
        Ok(window) => {
            let theme_preference = {
                let state = app.state::<Arc<AppState>>();
                let theme = state.settings.blocking_lock().theme;
                theme
            };
            if let Err(error) = commands::settings::apply_theme_preference(app, theme_preference) {
                log::warn!(
                    "Failed to apply theme preference on recreated window: {}",
                    error
                );
            }

            #[cfg(target_os = "macos")]
            {
                if let Err(error) = app
                    .liquid_glass()
                    .set_effect(&window, LiquidGlassConfig::default())
                {
                    log::warn!(
                        "Failed to apply liquid glass on recreated window: {}",
                        error
                    );
                }

                schedule_macos_system_appearance_patch(app.clone(), window.label().to_string());
            }
        }
        Err(error) => {
            log::error!("Failed to create window from main config: {}", error);
        }
    }
}

#[cfg(target_os = "macos")]
fn create_fresh_main_window(app: &tauri::AppHandle) {
    create_window_from_main_config(app, "main".to_string());
}

fn create_new_window(app: &tauri::AppHandle) {
    let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
    create_window_from_main_config(app, format!("main{}", id));
}

fn emit_menu_event_to_focused_window(app: &tauri::AppHandle, event_name: &str) {
    if let Some(window) = app.get_focused_window() {
        let window_label = window.label().to_string();
        match window.emit(event_name, ()) {
            Ok(_) => {
                log::trace!(
                    "menu event '{}' dispatched to focused window '{}'",
                    event_name,
                    window_label
                );
            }
            Err(error) => {
                log::warn!(
                    "Failed to dispatch menu event '{}' to focused window '{}': {}",
                    event_name,
                    window_label,
                    error
                );
            }
        }
        return;
    }

    log::debug!(
        "No focused window for menu event '{}'; trying main window fallback",
        event_name
    );

    if let Some(main_window) = app.get_webview_window("main") {
        match main_window.emit(event_name, ()) {
            Ok(_) => {
                log::trace!(
                    "menu event '{}' dispatched to fallback main window",
                    event_name
                );
            }
            Err(error) => {
                log::warn!(
                    "Failed to dispatch menu event '{}' to fallback main window: {}",
                    event_name,
                    error
                );
            }
        }
        return;
    }

    log::warn!(
        "No focused/main window available for menu event '{}'; falling back to broadcast",
        event_name
    );
    if let Err(error) = app.emit(event_name, ()) {
        log::warn!("Broadcast menu event '{}' failed: {}", event_name, error);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Trace)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Webview,
                ))
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("iptv-checker".to_string())
            .start_socket_server(true)
            .socket_path("/tmp/tauri-mcp-iptv-checker.sock".into()),
    ));

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_haptics::init());

    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

        let settings_item = MenuItemBuilder::with_id("menu.app.settings", "Settings...")
            .accelerator("Cmd+,")
            .build(app)?;

        let app_menu = SubmenuBuilder::new(app, "IPTV Checker")
            .about(Some(AboutMetadata::default()))
            .separator()
            .item(&settings_item)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let new_window_item = MenuItemBuilder::with_id("menu.file.new_window", "New Window")
            .accelerator("Cmd+N")
            .build(app)?;
        let open_item = MenuItemBuilder::with_id("menu.file.open", "Open Playlist...")
            .accelerator("Cmd+O")
            .build(app)?;
        let open_folder_item = MenuItemBuilder::with_id("menu.file.open_folder", "Open Folder...")
            .accelerator("Cmd+Shift+O")
            .build(app)?;
        let open_url_item = MenuItemBuilder::with_id("menu.file.open_url", "Open URL...")
            .accelerator("Cmd+Shift+U")
            .build(app)?;
        let export_csv_item = MenuItemBuilder::with_id("menu.file.export_csv", "Export CSV")
            .accelerator("Cmd+Shift+E")
            .build(app)?;

        let file_menu = SubmenuBuilder::with_id(app, "menu.file", "File")
            .item(&new_window_item)
            .separator()
            .item(&open_item)
            .item(&open_folder_item)
            .item(&open_url_item)
            .item(
                &SubmenuBuilder::with_id(app, "menu.file.open_recent", "Open Recent")
                    .text("menu.file.recent.0", "No recent playlists")
                    .separator()
                    .text("menu.file.recent.clear", "Clear Recent")
                    .build()?,
            )
            .separator()
            .item(&export_csv_item)
            .text("menu.file.export_split", "Export Split Playlists")
            .text("menu.file.export_renamed", "Export Renamed Playlist")
            .text("menu.file.export_filtered_m3u", "Export Filtered M3U/M3U8")
            .text("menu.file.export_scan_log", "Export Scan Log (JSON)")
            .separator()
            .close_window()
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let toggle_sidebar_item =
            MenuItemBuilder::with_id("menu.view.toggle_sidebar", "Toggle Sidebar")
                .accelerator("Cmd+Shift+L")
                .build(app)?;
        let toggle_report_item =
            MenuItemBuilder::with_id("menu.view.toggle_report", "Toggle Report")
                .accelerator("Cmd+Shift+R")
                .build(app)?;
        let toggle_prescan_item =
            MenuItemBuilder::with_id("menu.view.toggle_prescan_filter", "Show Pre-scan Filter")
                .accelerator("Cmd+Shift+F")
                .build(app)?;
        let clear_filters_item =
            MenuItemBuilder::with_id("menu.view.clear_filters", "Clear Filters")
                .accelerator("Cmd+Shift+X")
                .build(app)?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .item(&toggle_sidebar_item)
            .item(&toggle_report_item)
            .item(&toggle_prescan_item)
            .item(&clear_filters_item)
            .text("menu.view.history", "Scan History")
            .build()?;

        let start_scan_item = MenuItemBuilder::with_id("menu.scan.start", "Start Scan")
            .accelerator("Cmd+R")
            .build(app)?;
        let pause_scan_item = MenuItemBuilder::with_id("menu.scan.pause", "Pause Scan")
            .accelerator("Cmd+P")
            .build(app)?;
        let stop_scan_item = MenuItemBuilder::with_id("menu.scan.stop", "Stop Scan")
            .accelerator("Cmd+.")
            .build(app)?;

        let scan_menu = SubmenuBuilder::new(app, "Scan")
            .item(&start_scan_item)
            .item(&pause_scan_item)
            .text("menu.scan.resume", "Resume Scan")
            .item(&stop_scan_item)
            .separator()
            .text("menu.scan.settings", "Scan Settings")
            .build()?;

        let shortcuts_item = MenuItemBuilder::with_id("menu.help.shortcuts", "Keyboard Shortcuts")
            .accelerator("Cmd+/")
            .build(app)?;

        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&shortcuts_item)
            .separator()
            .text("menu.help.check_updates", "Check for Updates")
            .build()?;

        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&scan_menu)
            .item(&view_menu)
            .item(&help_menu)
            .build()
    });

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.menu(|app| {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

        let new_window_item = MenuItemBuilder::with_id("menu.file.new_window", "New Window")
            .accelerator("Ctrl+N")
            .build(app)?;
        let open_item = MenuItemBuilder::with_id("menu.file.open", "Open Playlist...")
            .accelerator("Ctrl+O")
            .build(app)?;
        let open_folder_item = MenuItemBuilder::with_id("menu.file.open_folder", "Open Folder...")
            .accelerator("Ctrl+Shift+O")
            .build(app)?;
        let open_url_item = MenuItemBuilder::with_id("menu.file.open_url", "Open URL...")
            .accelerator("Ctrl+Shift+U")
            .build(app)?;
        let export_csv_item = MenuItemBuilder::with_id("menu.file.export_csv", "Export CSV")
            .accelerator("Ctrl+Shift+E")
            .build(app)?;
        let settings_item = MenuItemBuilder::with_id("menu.app.settings", "Settings...")
            .accelerator("Ctrl+,")
            .build(app)?;

        let file_menu = SubmenuBuilder::with_id(app, "menu.file", "File")
            .item(&new_window_item)
            .separator()
            .item(&open_item)
            .item(&open_folder_item)
            .item(&open_url_item)
            .item(
                &SubmenuBuilder::with_id(app, "menu.file.open_recent", "Open Recent")
                    .text("menu.file.recent.0", "No recent playlists")
                    .separator()
                    .text("menu.file.recent.clear", "Clear Recent")
                    .build()?,
            )
            .separator()
            .item(&export_csv_item)
            .text("menu.file.export_split", "Export Split Playlists")
            .text("menu.file.export_renamed", "Export Renamed Playlist")
            .text("menu.file.export_filtered_m3u", "Export Filtered M3U/M3U8")
            .text("menu.file.export_scan_log", "Export Scan Log (JSON)")
            .separator()
            .item(&settings_item)
            .quit()
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let toggle_sidebar_item =
            MenuItemBuilder::with_id("menu.view.toggle_sidebar", "Toggle Sidebar")
                .accelerator("Ctrl+Shift+L")
                .build(app)?;
        let toggle_report_item =
            MenuItemBuilder::with_id("menu.view.toggle_report", "Toggle Report")
                .accelerator("Ctrl+Shift+R")
                .build(app)?;
        let toggle_prescan_item =
            MenuItemBuilder::with_id("menu.view.toggle_prescan_filter", "Show Pre-scan Filter")
                .accelerator("Ctrl+Shift+F")
                .build(app)?;
        let clear_filters_item =
            MenuItemBuilder::with_id("menu.view.clear_filters", "Clear Filters")
                .accelerator("Ctrl+Shift+X")
                .build(app)?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .item(&toggle_sidebar_item)
            .item(&toggle_report_item)
            .item(&toggle_prescan_item)
            .item(&clear_filters_item)
            .text("menu.view.history", "Scan History")
            .build()?;

        let start_scan_item = MenuItemBuilder::with_id("menu.scan.start", "Start Scan")
            .accelerator("Ctrl+R")
            .build(app)?;
        let pause_scan_item = MenuItemBuilder::with_id("menu.scan.pause", "Pause Scan")
            .accelerator("Ctrl+P")
            .build(app)?;
        let stop_scan_item = MenuItemBuilder::with_id("menu.scan.stop", "Stop Scan")
            .accelerator("Ctrl+.")
            .build(app)?;

        let scan_menu = SubmenuBuilder::new(app, "Scan")
            .item(&start_scan_item)
            .item(&pause_scan_item)
            .text("menu.scan.resume", "Resume Scan")
            .item(&stop_scan_item)
            .separator()
            .text("menu.scan.settings", "Scan Settings")
            .build()?;

        let shortcuts_item = MenuItemBuilder::with_id("menu.help.shortcuts", "Keyboard Shortcuts")
            .accelerator("Ctrl+/")
            .build(app)?;

        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&shortcuts_item)
            .separator()
            .text("menu.help.check_updates", "Check for Updates")
            .build()?;

        MenuBuilder::new(app)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&scan_menu)
            .item(&view_menu)
            .item(&help_menu)
            .build()
    });

    let builder = builder.on_menu_event(|app, event| {
        log::debug!("menu event: id={}", event.id().as_ref());
        if event.id().as_ref() == "menu.file.new_window" {
            create_new_window(app);
            return;
        }

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
            "menu.view.toggle_report" => Some("menu://toggle-report"),
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
            log::debug!("menu event → frontend: {name}");
            emit_menu_event_to_focused_window(app, name);
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

            // Background cleanup: evict old screenshot dirs per retention policy
            {
                let handle = app.handle().clone();
                let state = app.state::<Arc<AppState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let (retention_count, _) = {
                        let s = state.settings.lock().await;
                        (s.screenshot_retention_count, s.low_space_threshold_gb)
                    };
                    let cache_root = handle
                        .path()
                        .temp_dir()
                        .unwrap_or_else(|_| std::env::temp_dir())
                        .join("iptv-checker-screenshots");
                    if cache_root.exists() {
                        let freed = commands::settings::evict_old_screenshot_dirs(
                            &cache_root,
                            &std::collections::HashSet::new(),
                            retention_count,
                        );
                        if freed > 0 {
                            log::info!(
                                "Startup eviction freed {} bytes of screenshot cache",
                                freed
                            );
                        }
                    }
                });
            }

            // Enable _useSystemAppearance on WKWebView so CSS
            // `-apple-visual-effect: -apple-system-glass-material` works.
            // Deferred to avoid ObjC exceptions when webview isn't fully ready.
            #[cfg(target_os = "macos")]
            {
                schedule_macos_system_appearance_patch(app.handle().clone(), "main".to_string());
            }

            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::TrayIconBuilder;

                let open_item =
                    MenuItemBuilder::with_id("tray.open", "Open IPTV Checker").build(app)?;
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
            commands::playlist::open_playlist_stalker,
            commands::player::open_channel_in_player,
            commands::scan::start_scan,
            commands::scan::pause_scan,
            commands::scan::resume_scan,
            commands::scan::cancel_scan,
            commands::scan::reset_scan,
            commands::scan::quick_check_channel,
            commands::export::export_csv,
            commands::export::export_split,
            commands::export::export_renamed,
            commands::export::export_m3u,
            commands::export::export_scan_log_json,
            commands::settings::get_settings,
            commands::settings::get_scan_presets,
            commands::settings::save_scan_preset,
            commands::settings::rename_scan_preset,
            commands::settings::delete_scan_preset,
            commands::settings::set_default_scan_preset,
            commands::settings::update_settings,
            commands::settings::check_ffmpeg_available,
            commands::settings::set_default_m3u8_file_association,
            commands::settings::read_screenshot,
            commands::settings::get_screenshot_cache_stats,
            commands::settings::clear_screenshot_cache,
            commands::history::get_scan_history,
            commands::history::clear_scan_history,
            commands::recent::get_recent_playlists,
            commands::recent::add_recent_playlist,
            commands::recent::clear_recent_playlists,
        ])
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let window = webview.window();
            if matches!(window.is_visible(), Ok(false)) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if !APP_IS_QUITTING.load(Ordering::Relaxed) {
                    if let Some(target_window) =
                        window.app_handle().get_webview_window(window.label())
                    {
                        if let Err(error) = window.app_handle().liquid_glass().set_effect(
                            &target_window,
                            LiquidGlassConfig {
                                enabled: false,
                                ..Default::default()
                            },
                        ) {
                            log::debug!("Failed to remove liquid glass before close: {}", error);
                        }
                    }
                    WINDOW_CLOSED_BY_USER.store(true, Ordering::Relaxed);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::MenuEvent(menu_event) => {
                    let event_id = menu_event.id().as_ref();
                    if event_id.contains("quit") {
                        APP_IS_QUITTING.store(true, Ordering::Relaxed);
                    }
                }
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if APP_IS_QUITTING.load(Ordering::Relaxed) {
                        return;
                    }
                    if WINDOW_CLOSED_BY_USER.swap(false, Ordering::Relaxed) {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    APP_IS_QUITTING.store(false, Ordering::Relaxed);
                    WINDOW_CLOSED_BY_USER.store(false, Ordering::Relaxed);
                    if has_visible_windows {
                        return;
                    }

                    if let Some(main_window) = app.get_webview_window("main") {
                        let _ = main_window.unminimize();
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                        schedule_macos_system_appearance_patch(app.clone(), "main".to_string());
                    } else {
                        create_fresh_main_window(app);
                    }
                }
                _ => {}
            }
        });
}
