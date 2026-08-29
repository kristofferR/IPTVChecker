// The scan/ffmpeg/cast pipelines thread a lot of per-check configuration
// through their worker functions. Bundling those into parameter structs is a
// worthwhile refactor, but it is a behavioural change to the hottest code in
// the app and does not belong to the lint gate that introduced this allow.
#![allow(clippy::too_many_arguments)]

pub mod commands;
pub mod engine;
pub mod error;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod models;
pub mod state;
pub mod urlnorm;

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use state::AppState;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Listener, Manager};

/// Stdout log level, dynamically updated from user settings.
/// The global `log::max_level()` stays at Trace so the Webview target
/// always receives all events (the Log window does its own filtering).
pub(crate) static STDOUT_LOG_LEVEL: AtomicUsize =
    AtomicUsize::new(log::LevelFilter::Error as usize);
#[cfg(target_os = "macos")]
use tauri_plugin_liquid_glass::{LiquidGlassConfig, LiquidGlassExt};
use tauri_plugin_store::StoreExt;

#[cfg(target_os = "macos")]
static APP_IS_QUITTING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static WINDOW_CLOSED_BY_USER: AtomicBool = AtomicBool::new(false);
static NEXT_WINDOW_ID: AtomicUsize = AtomicUsize::new(1);
const FRONTEND_OPEN_PATHS_EVENT: &str = "app://open-paths";

/// Menu events queued until their destination window declares itself ready.
static PENDING_MENU_EVENTS: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Open-path events queued until their destination window declares itself ready.
static PENDING_OPEN_PATHS: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static READY_MENU_WINDOWS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn is_supported_playlist_path(path: &Path) -> bool {
    if path.is_dir() {
        return true;
    }

    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| ext.eq_ignore_ascii_case("m3u") || ext.eq_ignore_ascii_case("m3u8"))
        .unwrap_or(false)
}

fn openable_path_from_path(path: &Path) -> Option<String> {
    if !path.exists() || !is_supported_playlist_path(path) {
        return None;
    }

    Some(path.to_string_lossy().into_owned())
}

fn openable_path_from_url(url: &url::Url) -> Option<String> {
    if url.scheme() != "file" {
        return None;
    }

    let path = url.to_file_path().ok()?;
    openable_path_from_path(&path)
}

fn openable_path_from_arg(arg: &OsStr) -> Option<String> {
    openable_path_from_path(Path::new(arg)).or_else(|| {
        arg.to_str()
            .and_then(|value| url::Url::parse(value).ok())
            .and_then(|url| openable_path_from_url(&url))
    })
}

fn collect_launch_open_paths() -> Vec<String> {
    let mut paths = Vec::new();
    for arg in std::env::args_os().skip(1) {
        let Some(path) = openable_path_from_arg(&arg) else {
            continue;
        };

        if !paths.contains(&path) {
            paths.push(path);
        }
    }

    paths
}

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
    if let Ok(mut ready) = READY_MENU_WINDOWS.lock() {
        ready.remove(&label);
    }

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
        // The built window is only consumed by the macOS-only vibrancy setup
        // and the Linux title-bar pass below; elsewhere the theme is applied
        // through the app handle.
        #[cfg_attr(
            not(any(target_os = "macos", target_os = "linux")),
            allow(unused_variables)
        )]
        Ok(window) => {
            // Linux: new windows follow the title-bar setting (hidden on
            // tiling window managers by default).
            #[cfg(target_os = "linux")]
            {
                let show_title_bar = {
                    let state = app.state::<Arc<AppState>>();
                    let settings = state.settings.blocking_lock();
                    linux::show_title_bar(&settings)
                };
                let _ = window.set_decorations(show_title_bar);
            }
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

fn create_new_window(app: &tauri::AppHandle) -> String {
    let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
    let label = format!("main{}", id);
    create_window_from_main_config(app, label.clone());
    label
}

fn queue_menu_event(window_label: &str, event_name: &str) {
    if let Ok(mut queue) = PENDING_MENU_EVENTS.lock() {
        queue
            .entry(window_label.to_string())
            .or_default()
            .push(event_name.to_string());
    }
}

fn queue_open_paths(window_label: &str, paths: &[String]) {
    if paths.is_empty() {
        return;
    }

    if let Ok(mut queue) = PENDING_OPEN_PATHS.lock() {
        let entry = queue.entry(window_label.to_string()).or_default();
        for path in paths {
            if !entry.contains(path) {
                entry.push(path.clone());
            }
        }
    }
}

fn is_menu_window_ready(window_label: &str) -> bool {
    READY_MENU_WINDOWS
        .lock()
        .map(|ready| ready.contains(window_label))
        .unwrap_or(false)
}

fn emit_menu_event_to_window(
    app: &tauri::AppHandle,
    window_label: &str,
    event_name: &str,
    context: &str,
) -> bool {
    if !is_menu_window_ready(window_label) {
        log::debug!(
            "Queueing menu event '{}' for window '{}' until listeners are ready",
            event_name,
            window_label
        );
        queue_menu_event(window_label, event_name);
        return false;
    }

    let Some(window) = app.get_webview_window(window_label) else {
        log::debug!(
            "Window '{}' disappeared before menu event '{}'; queueing",
            window_label,
            event_name
        );
        queue_menu_event(window_label, event_name);
        return false;
    };

    match window.emit(event_name, ()) {
        Ok(_) => {
            log::trace!(
                "menu event '{}' dispatched to {} '{}'",
                event_name,
                context,
                window_label
            );
            true
        }
        Err(error) => {
            log::warn!(
                "Failed to dispatch menu event '{}' to {} '{}': {}",
                event_name,
                context,
                window_label,
                error
            );
            false
        }
    }
}

fn flush_pending_menu_events(app: &tauri::AppHandle, window_label: &str) {
    let pending = PENDING_MENU_EVENTS
        .lock()
        .ok()
        .and_then(|mut queue| queue.remove(window_label))
        .unwrap_or_default();
    if pending.is_empty() {
        return;
    }

    if let Some(window) = app.get_webview_window(window_label) {
        for event_name in pending {
            log::debug!(
                "Dispatching queued menu event '{}' to window '{}'",
                event_name,
                window_label
            );
            if let Err(error) = window.emit(event_name.as_str(), ()) {
                log::warn!(
                    "Failed to dispatch queued menu event '{}' to '{}': {}",
                    event_name,
                    window_label,
                    error
                );
            }
        }
    } else if let Ok(mut queue) = PENDING_MENU_EVENTS.lock() {
        queue.insert(window_label.to_string(), pending);
    }
}

fn flush_pending_open_paths(app: &tauri::AppHandle, window_label: &str) {
    let pending = PENDING_OPEN_PATHS
        .lock()
        .ok()
        .and_then(|mut queue| queue.remove(window_label))
        .unwrap_or_default();
    if pending.is_empty() {
        return;
    }

    if let Some(window) = app.get_webview_window(window_label) {
        log::debug!(
            "Dispatching queued open-path event with {} path(s) to window '{}'",
            pending.len(),
            window_label
        );
        if let Err(error) = window.emit(FRONTEND_OPEN_PATHS_EVENT, pending.clone()) {
            log::warn!(
                "Failed to dispatch queued open-path event to '{}': {}",
                window_label,
                error
            );
            if let Ok(mut queue) = PENDING_OPEN_PATHS.lock() {
                queue.insert(window_label.to_string(), pending);
            }
        }
    } else if let Ok(mut queue) = PENDING_OPEN_PATHS.lock() {
        queue.insert(window_label.to_string(), pending);
    }
}

fn mark_menu_window_ready(app: &tauri::AppHandle, window_label: &str) {
    if let Ok(mut ready) = READY_MENU_WINDOWS.lock() {
        ready.insert(window_label.to_string());
    }
    flush_pending_menu_events(app, window_label);
    flush_pending_open_paths(app, window_label);
}

fn clear_menu_window_state(window_label: &str) {
    if let Ok(mut ready) = READY_MENU_WINDOWS.lock() {
        ready.remove(window_label);
    }
    if let Ok(mut queue) = PENDING_MENU_EVENTS.lock() {
        queue.remove(window_label);
    }
    if let Ok(mut queue) = PENDING_OPEN_PATHS.lock() {
        queue.remove(window_label);
    }
}

fn emit_menu_event_to_focused_window(app: &tauri::AppHandle, event_name: &str) {
    if let Some(window) = app.get_focused_window() {
        let window_label = window.label().to_string();
        let _ = emit_menu_event_to_window(app, &window_label, event_name, "focused window");
        return;
    }

    log::debug!(
        "No focused window for menu event '{}'; trying main window fallback",
        event_name
    );

    if app.get_webview_window("main").is_some() {
        let _ = emit_menu_event_to_window(app, "main", event_name, "fallback main window");
        return;
    }

    // Try any existing main-like window (main1, main2, etc.)
    for (label, _window) in app.webview_windows() {
        if label.starts_with("main") {
            let _ = emit_menu_event_to_window(app, &label, event_name, "window");
            return;
        }
    }

    // No windows exist — create one and queue the event for after page load
    log::info!(
        "No windows available for menu event '{}'; creating window and queueing event",
        event_name
    );
    let label = create_new_window(app);
    queue_menu_event(&label, event_name);
}

fn emit_open_paths_to_window(
    app: &tauri::AppHandle,
    window_label: &str,
    paths: &[String],
    context: &str,
) -> bool {
    if paths.is_empty() {
        return true;
    }

    if !is_menu_window_ready(window_label) {
        log::debug!(
            "Queueing open-path event for window '{}' until listeners are ready",
            window_label
        );
        queue_open_paths(window_label, paths);
        return false;
    }

    let Some(window) = app.get_webview_window(window_label) else {
        log::debug!(
            "Window '{}' disappeared before open-path event; queueing",
            window_label
        );
        queue_open_paths(window_label, paths);
        return false;
    };

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();

    match window.emit(FRONTEND_OPEN_PATHS_EVENT, paths) {
        Ok(_) => {
            log::trace!(
                "open-path event dispatched to {} '{}' with {} path(s)",
                context,
                window_label,
                paths.len()
            );
            true
        }
        Err(error) => {
            log::warn!(
                "Failed to dispatch open-path event to {} '{}': {}",
                context,
                window_label,
                error
            );
            false
        }
    }
}

fn emit_open_paths_to_focused_window(app: &tauri::AppHandle, paths: &[String]) {
    if paths.is_empty() {
        return;
    }

    if let Some(window) = app.get_focused_window() {
        let window_label = window.label().to_string();
        let _ = emit_open_paths_to_window(app, &window_label, paths, "focused window");
        return;
    }

    log::debug!("No focused window for open-path event; trying main window fallback");

    if app.get_webview_window("main").is_some() {
        let _ = emit_open_paths_to_window(app, "main", paths, "fallback main window");
        return;
    }

    for (label, _window) in app.webview_windows() {
        if label.starts_with("main") {
            let _ = emit_open_paths_to_window(app, &label, paths, "window");
            return;
        }
    }

    log::info!(
        "No windows available for open-path event; creating window and queueing {} path(s)",
        paths.len()
    );
    let label = create_new_window(app);
    queue_open_paths(&label, paths);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(not(fuzzing))]
pub fn run() {
    // Workaround for webkit2gtk DMABUF rendering issues on Wayland (common with
    // NVIDIA and some Intel GPUs). Must be set before any GTK/webkit2gtk init.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WAYLAND_DISPLAY").is_ok()
            && std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .target(
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout).filter(
                        |metadata| {
                            metadata.level() <= log::Level::Debug
                                && (metadata.level() as usize)
                                    <= STDOUT_LOG_LEVEL.load(Ordering::Relaxed)
                        },
                    ),
                )
                .target(
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview)
                        .filter(|metadata| metadata.level() <= log::Level::Debug),
                )
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .with_denylist(&["settings", "log"])
                .build(),
        );

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_liquid_glass::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("iptv-checker".to_string())
            .start_socket_server(true)
            .socket_path("/tmp/tauri-mcp-iptv-checker.sock".into()),
    ));

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_haptics::init());

    // One menu builder for all desktop platforms; only the modifier key,
    // the macOS app/Window menus, and where Settings/Quit live differ.
    let builder = builder.menu(|app| {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

        let is_macos = cfg!(target_os = "macos");
        let modifier = if is_macos { "Cmd" } else { "Ctrl" };
        let accel = |keys: &str| format!("{modifier}+{keys}");

        let settings_item = MenuItemBuilder::with_id("menu.app.settings", "Settings...")
            .accelerator(accel(","))
            .build(app)?;

        #[cfg(target_os = "macos")]
        let app_menu = SubmenuBuilder::new(app, "IPTV Checker")
            .about(Some(tauri::menu::AboutMetadata::default()))
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
            .accelerator(accel("N"))
            .build(app)?;
        let open_item = MenuItemBuilder::with_id("menu.file.open", "Open Playlist...")
            .accelerator(accel("O"))
            .build(app)?;
        let open_folder_item = MenuItemBuilder::with_id("menu.file.open_folder", "Open Folder...")
            .accelerator(accel("Shift+O"))
            .build(app)?;
        let open_url_item = MenuItemBuilder::with_id("menu.file.open_url", "Open URL...")
            .accelerator(accel("Shift+U"))
            .build(app)?;
        let export_csv_item = MenuItemBuilder::with_id("menu.file.export_csv", "Export CSV")
            .accelerator(accel("Shift+E"))
            .build(app)?;

        let file_menu = {
            let file_builder = SubmenuBuilder::with_id(app, "menu.file", "File")
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
                .item(
                    &SubmenuBuilder::with_id(app, "menu.file.open_saved", "Open Saved")
                        .text("menu.file.saved.0", "No saved playlists")
                        .build()?,
                )
                .text("menu.file.manage_saved", "Manage Saved Playlists…")
                .separator()
                .item(&export_csv_item)
                .text("menu.file.export_split", "Export Split Playlists")
                .text("menu.file.export_renamed", "Export Renamed Playlist")
                .text("menu.file.export_filtered_m3u", "Export Filtered M3U/M3U8")
                .text("menu.file.export_scan_log", "Export Scan Log (JSON)");

            // Settings and Quit live in the app menu on macOS, in File elsewhere.
            #[cfg(not(target_os = "macos"))]
            let file_builder = file_builder.separator().item(&settings_item).quit();

            file_builder.build()?
        };

        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .build()?;

        let toggle_sidebar_item =
            MenuItemBuilder::with_id("menu.view.toggle_sidebar", "Toggle Sidebar")
                .accelerator(accel("Shift+L"))
                .build(app)?;
        let toggle_report_item =
            MenuItemBuilder::with_id("menu.view.toggle_report", "Toggle Report")
                .accelerator(accel("Shift+R"))
                .build(app)?;
        let toggle_prescan_item =
            MenuItemBuilder::with_id("menu.view.toggle_prescan_filter", "Show Source Filter")
                .accelerator(accel("Shift+F"))
                .build(app)?;
        let toggle_header_button_text_item = MenuItemBuilder::with_id(
            "menu.view.toggle_header_button_text",
            "Show Header Button Text",
        )
        .build(app)?;
        let clear_filters_item =
            MenuItemBuilder::with_id("menu.view.clear_filters", "Clear Filters")
                .accelerator(accel("Shift+X"))
                .build(app)?;

        let log_window_item = MenuItemBuilder::with_id("menu.view.log_window", "Log")
            .accelerator(if is_macos { "Alt+Cmd+L" } else { "Ctrl+Alt+L" })
            .build(app)?;

        let view_menu = SubmenuBuilder::new(app, "View")
            .item(&toggle_sidebar_item)
            .item(&toggle_report_item)
            .item(&toggle_prescan_item)
            .item(&toggle_header_button_text_item)
            .item(&clear_filters_item)
            .text("menu.view.history", "Scan History")
            .separator()
            .item(&log_window_item)
            .build()?;

        let start_scan_item = MenuItemBuilder::with_id("menu.scan.start", "Start Scan")
            .accelerator(accel("R"))
            .build(app)?;
        let pause_scan_item = MenuItemBuilder::with_id("menu.scan.pause", "Pause Scan")
            .accelerator(accel("P"))
            .build(app)?;
        let stop_scan_item = MenuItemBuilder::with_id("menu.scan.stop", "Stop Scan")
            .accelerator(accel("."))
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
            .accelerator(accel("/"))
            .build(app)?;

        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&shortcuts_item)
            .separator()
            .text("menu.help.check_updates", "Check for Updates")
            .build()?;

        #[cfg(target_os = "macos")]
        {
            let window_menu =
                SubmenuBuilder::with_id(app, tauri::menu::WINDOW_SUBMENU_ID, "Window")
                    .minimize()
                    .maximize()
                    .fullscreen()
                    .separator()
                    .close_window()
                    .build()?;

            MenuBuilder::new(app)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&scan_menu)
                .item(&view_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()
        }
        #[cfg(not(target_os = "macos"))]
        {
            MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&scan_menu)
                .item(&view_menu)
                .item(&help_menu)
                .build()
        }
    });

    let builder = builder.on_menu_event(|app, event| {
        log::debug!("menu event: id={}", event.id().as_ref());
        if event.id().as_ref() == "menu.file.new_window" {
            create_new_window(app);
            return;
        }

        // Indexed recent/saved entries map by suffix rather than ten
        // hand-written arms each.
        let menu_id = event.id().as_ref();
        let indexed_event = |prefix: &str, target: &str| -> Option<String> {
            let index = menu_id.strip_prefix(prefix)?;
            index
                .parse::<u8>()
                .ok()
                .map(|index| format!("menu://{target}-{index}"))
        };
        if let Some(name) = indexed_event("menu.file.recent.", "open-recent")
            .or_else(|| indexed_event("menu.file.saved.", "open-saved"))
        {
            log::debug!("menu event → frontend: {name}");
            emit_menu_event_to_focused_window(app, &name);
            return;
        }

        let frontend_event = match menu_id {
            "menu.app.settings" => Some("menu://open-settings"),
            "menu.file.open" => Some("menu://open-playlist"),
            "menu.file.open_folder" => Some("menu://open-folder"),
            "menu.file.open_url" => Some("menu://open-url"),
            "menu.file.recent.clear" => Some("menu://clear-recent"),
            "menu.file.manage_saved" => Some("menu://manage-saved"),
            "menu.file.export_csv" => Some("menu://export-csv"),
            "menu.file.export_split" => Some("menu://export-split"),
            "menu.file.export_renamed" => Some("menu://export-renamed"),
            "menu.file.export_filtered_m3u" => Some("menu://export-filtered-m3u"),
            "menu.file.export_scan_log" => Some("menu://export-scan-log"),
            "menu.view.toggle_sidebar" => Some("menu://toggle-sidebar"),
            "menu.view.toggle_report" => Some("menu://toggle-report"),
            "menu.view.toggle_prescan_filter" => Some("menu://toggle-prescan-filter"),
            "menu.view.toggle_header_button_text" => Some("menu://toggle-header-button-text"),
            "menu.view.clear_filters" => Some("menu://clear-filters"),
            "menu.view.history" => Some("menu://open-history"),
            "menu.view.log_window" => Some("menu://open-log"),
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
            let app_handle = app.handle().clone();
            app.listen_any("menu-ready", move |event| {
                match serde_json::from_str::<String>(event.payload()) {
                    Ok(window_label) => {
                        log::debug!("Menu listeners ready in window '{}'", window_label);
                        mark_menu_window_ready(&app_handle, &window_label);
                    }
                    Err(error) => {
                        log::warn!(
                            "Ignoring invalid menu-ready payload '{}': {}",
                            event.payload(),
                            error
                        );
                    }
                }
            });

            // Load persisted settings
            if let Ok(store) = app.store("settings.json") {
                if let Some(value) = store.get("settings") {
                    if let Ok(persisted) =
                        serde_json::from_value::<models::settings::AppSettings>(value)
                    {
                        let state = app.state::<Arc<AppState>>();
                        STDOUT_LOG_LEVEL
                            .store(persisted.level_filter() as usize, Ordering::Relaxed);
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
                commands::settings::apply_theme_preference(app.handle(), theme_preference)
            {
                log::warn!("Failed to apply startup theme preference: {}", error);
            }

            commands::recent::refresh_recent_menu(app.handle());
            commands::saved::refresh_saved_menu(app.handle());

            let launch_open_paths = collect_launch_open_paths();
            if !launch_open_paths.is_empty() {
                log::info!(
                    "Detected {} playlist path(s) from launch arguments",
                    launch_open_paths.len()
                );
                emit_open_paths_to_focused_window(app.handle(), &launch_open_paths);
            }

            // Warm up the localhost streaming proxy in the background. Play
            // paths go through ensure_streaming_proxy_port (same start lock,
            // with a liveness probe), so an early click can't double-start a
            // listener — and setup no longer blocks window creation on the
            // bind, which previously had no timeout.
            {
                let handle_for_proxy = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let port =
                        engine::stream_proxy::ensure_streaming_proxy_port(handle_for_proxy).await;
                    if port == 0 {
                        log::error!("Failed to start streaming proxy at startup");
                    }
                });
            }

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

            #[cfg(target_os = "linux")]
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
                    })
                    .on_tray_icon_event(|tray, event| {
                        // Left-click on tray icon shows/focuses the main window
                        if matches!(event, tauri::tray::TrayIconEvent::Click { .. }) {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    });

                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }

                if let Err(error) = tray_builder.build(app) {
                    log::warn!("Failed to initialize system tray: {}", error);
                }
            }

            // On Linux, apply native window decorations per the title-bar
            // setting — hidden on tiling window managers by default — and set
            // the window title (overlay titlebar is macOS/Windows only).
            #[cfg(target_os = "linux")]
            {
                let show_title_bar = {
                    let state = app.state::<Arc<AppState>>();
                    let settings = state.settings.blocking_lock();
                    linux::show_title_bar(&settings)
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(show_title_bar);
                    let _ = window.set_title("IPTV Checker");
                }
            }

            commands::updater::spawn_automatic_update_checks(app.handle().clone());

            Ok(())
        })
        .manage(AppState::new() as Arc<AppState>)
        .invoke_handler(tauri::generate_handler![
            commands::playlist::open_playlist,
            commands::playlist::open_playlist_url,
            commands::playlist::open_playlist_xtream,
            commands::playlist::open_playlist_stalker,
            commands::player::open_channel_in_player,
            commands::player::get_streaming_proxy_port,
            commands::chromecast::discover_chromecasts,
            commands::chromecast::cast_to_device,
            commands::chromecast::stop_cast,
            commands::chromecast::get_cast_status,
            commands::scan::start_scan,
            commands::scan::pause_scan,
            commands::scan::resume_scan,
            commands::scan::cancel_scan,
            commands::scan::reset_scan,
            commands::scan::quick_check_channel,
            commands::scan::cancel_quick_check,
            commands::epg::load_epg,
            commands::epg::get_epg_programmes,
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
            commands::settings::get_title_bar_visibility,
            commands::settings::check_ffmpeg_available,
            commands::settings::set_default_m3u8_file_association,
            commands::settings::read_screenshot,
            commands::settings::get_screenshot_cache_stats,
            commands::settings::clear_screenshot_cache,
            commands::updater::check_for_updates,
            commands::updater::discovered_update,
            commands::updater::update_install_mode,
            commands::updater::open_manual_update,
            commands::updater::install_update,
            commands::history::get_scan_history,
            commands::history::clear_scan_history,
            commands::recent::get_recent_playlists,
            commands::recent::add_recent_playlist,
            commands::recent::clear_recent_playlists,
            commands::saved::get_saved_playlists,
            commands::saved::upsert_saved_playlist,
            commands::saved::delete_saved_playlist,
            commands::saved::open_saved_playlist,
            commands::saved::rename_playlist_source,
            commands::server_test::test_xtream_servers,
        ])
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let window = webview.window();

            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if window.label() == "settings" || window.label() == "log" {
                let _ = window.remove_menu();
            }

            if matches!(window.is_visible(), Ok(false)) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_window_event(|_window, _event| {
            if matches!(_event, tauri::WindowEvent::Destroyed) {
                clear_menu_window_state(_window.label());
            }

            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { .. } = _event {
                if !APP_IS_QUITTING.load(Ordering::Relaxed) {
                    if let Some(target_window) =
                        _window.app_handle().get_webview_window(_window.label())
                    {
                        if let Err(error) = _window.app_handle().liquid_glass().set_effect(
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
        .register_asynchronous_uri_scheme_protocol("streamproxy", |ctx, request, responder| {
            let app_handle = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response =
                    engine::stream_proxy::handle_proxy_request(&app_handle, request).await;
                responder.respond(response);
            });
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => {
                    let paths: Vec<String> =
                        urls.iter().filter_map(openable_path_from_url).collect();
                    if !paths.is_empty() {
                        log::info!(
                            "Received macOS open request with {} playlist path(s)",
                            paths.len()
                        );
                        emit_open_paths_to_focused_window(_app, &paths);
                    }
                }
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

                    if let Some(main_window) = _app.get_webview_window("main") {
                        let _ = main_window.unminimize();
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                        schedule_macos_system_appearance_patch(_app.clone(), "main".to_string());
                    } else {
                        create_fresh_main_window(_app);
                    }
                }
                _ => {}
            }
        });
}

#[cfg(fuzzing)]
pub fn run() {
    panic!("iptv_checker_lib::run is unavailable during fuzzing builds");
}

#[cfg(test)]
mod tests {
    use super::{is_supported_playlist_path, openable_path_from_arg, openable_path_from_url};
    use std::path::PathBuf;

    fn unique_temp_path(stem: &str, extension: Option<&str>) -> PathBuf {
        let unique = format!(
            "iptv-checker-open-path-{}-{}-{}",
            stem,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos()
        );
        let mut path = std::env::temp_dir().join(unique);
        if let Some(extension) = extension {
            path.set_extension(extension);
        }
        path
    }

    #[test]
    fn supported_playlist_path_accepts_directories_and_m3u_extensions() {
        let dir = unique_temp_path("dir", None);
        let m3u = unique_temp_path("playlist", Some("m3u"));
        let m3u8 = unique_temp_path("playlist", Some("M3U8"));
        let txt = unique_temp_path("playlist", Some("txt"));

        std::fs::create_dir(&dir).expect("temp dir should be creatable");
        std::fs::write(&m3u, "#EXTM3U\n").expect("m3u fixture should be writable");
        std::fs::write(&m3u8, "#EXTM3U\n").expect("m3u8 fixture should be writable");
        std::fs::write(&txt, "plain text").expect("txt fixture should be writable");

        assert!(is_supported_playlist_path(&dir));
        assert!(is_supported_playlist_path(&m3u));
        assert!(is_supported_playlist_path(&m3u8));
        assert!(!is_supported_playlist_path(&txt));

        std::fs::remove_dir_all(&dir).expect("temp dir cleanup should succeed");
        std::fs::remove_file(&m3u).expect("m3u cleanup should succeed");
        std::fs::remove_file(&m3u8).expect("m3u8 cleanup should succeed");
        std::fs::remove_file(&txt).expect("txt cleanup should succeed");
    }

    #[test]
    fn openable_path_helpers_reject_unsupported_inputs() {
        let txt = unique_temp_path("unsupported", Some("txt"));
        std::fs::write(&txt, "plain text").expect("txt fixture should be writable");

        assert!(openable_path_from_arg(txt.as_os_str()).is_none());

        let http_url =
            url::Url::parse("https://example.com/list.m3u8").expect("http url should parse");
        assert!(openable_path_from_url(&http_url).is_none());

        std::fs::remove_file(&txt).expect("txt cleanup should succeed");
    }

    #[test]
    fn openable_path_helpers_accept_file_urls_and_paths() {
        let file = unique_temp_path("with-space", Some("m3u8"));
        std::fs::write(&file, "#EXTM3U\n").expect("m3u8 fixture should be writable");

        let from_arg = openable_path_from_arg(file.as_os_str())
            .expect("plain file path arg should be accepted");
        assert_eq!(from_arg, file.to_string_lossy());

        let file_url = url::Url::from_file_path(&file).expect("file url should be creatable");
        let from_url = openable_path_from_url(&file_url).expect("file url should be accepted");
        assert_eq!(from_url, file.to_string_lossy());

        std::fs::remove_file(&file).expect("m3u8 cleanup should succeed");
    }
}
