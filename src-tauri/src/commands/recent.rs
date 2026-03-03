use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

const RECENT_STORE_KEY: &str = "recent_playlists";
const RECENT_LIMIT: usize = 10;
const RECENT_SLOT_COUNT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RecentPlaylistKind {
    File,
    Url,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentPlaylistEntry {
    pub kind: RecentPlaylistKind,
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecentPlaylistInput {
    pub kind: RecentPlaylistKind,
    pub value: String,
}

fn build_label(kind: &RecentPlaylistKind, value: &str) -> String {
    match kind {
        RecentPlaylistKind::File => Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
            .unwrap_or_else(|| value.to_string()),
        RecentPlaylistKind::Url => value.to_string(),
    }
}

fn load_recent_playlists(app: &tauri::AppHandle) -> Vec<RecentPlaylistEntry> {
    let Ok(store) = app.store("settings.json") else {
        return Vec::new();
    };
    let Some(value) = store.get(RECENT_STORE_KEY) else {
        return Vec::new();
    };
    serde_json::from_value::<Vec<RecentPlaylistEntry>>(value).unwrap_or_default()
}

fn save_recent_playlists(app: &tauri::AppHandle, entries: &[RecentPlaylistEntry]) {
    let Ok(store) = app.store("settings.json") else {
        return;
    };
    if let Ok(value) = serde_json::to_value(entries) {
        store.set(RECENT_STORE_KEY, value);
    }
}

fn sanitize_recent_playlists(entries: Vec<RecentPlaylistEntry>) -> Vec<RecentPlaylistEntry> {
    let mut sanitized = Vec::new();
    let mut seen: HashSet<(RecentPlaylistKind, String)> = HashSet::new();

    for entry in entries {
        let value = entry.value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        if entry.kind == RecentPlaylistKind::File && !Path::new(&value).exists() {
            continue;
        }

        let key = (entry.kind.clone(), value.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        sanitized.push(RecentPlaylistEntry {
            kind: entry.kind.clone(),
            value: value.clone(),
            label: if entry.label.trim().is_empty() {
                build_label(&entry.kind, &value)
            } else {
                entry.label
            },
        });

        if sanitized.len() >= RECENT_LIMIT {
            break;
        }
    }

    sanitized
}

#[cfg(target_os = "macos")]
fn update_recent_menu(app: &tauri::AppHandle, entries: &[RecentPlaylistEntry]) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(recent_submenu) = menu
        .get("menu.file.open_recent")
        .and_then(|item| item.as_submenu().cloned())
    else {
        return;
    };

    for slot in 0..RECENT_SLOT_COUNT {
        let id = format!("menu.file.recent.{}", slot);
        let Some(item_kind) = recent_submenu.get(&id) else {
            continue;
        };
        let Some(item) = item_kind.as_menuitem() else {
            continue;
        };

        if let Some(entry) = entries.get(slot) {
            let prefix = match entry.kind {
                RecentPlaylistKind::File => "File",
                RecentPlaylistKind::Url => "URL",
            };
            let _ = item.set_text(format!("{}. [{}] {}", slot + 1, prefix, entry.label));
            let _ = item.set_enabled(true);
        } else {
            let placeholder = if slot == 0 { "No recent playlists" } else { "—" };
            let _ = item.set_text(placeholder);
            let _ = item.set_enabled(false);
        }
    }

    if let Some(clear_item_kind) = recent_submenu.get("menu.file.recent.clear") {
        if let Some(clear_item) = clear_item_kind.as_menuitem() {
            let _ = clear_item.set_enabled(!entries.is_empty());
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn update_recent_menu(_app: &tauri::AppHandle, _entries: &[RecentPlaylistEntry]) {}

fn persist_recent_playlists(
    app: &tauri::AppHandle,
    entries: Vec<RecentPlaylistEntry>,
) -> Vec<RecentPlaylistEntry> {
    let sanitized = sanitize_recent_playlists(entries);
    save_recent_playlists(app, &sanitized);
    update_recent_menu(app, &sanitized);
    sanitized
}

pub fn refresh_recent_menu(app: &tauri::AppHandle) {
    let entries = load_recent_playlists(app);
    let _ = persist_recent_playlists(app, entries);
}

#[tauri::command]
pub async fn get_recent_playlists(
    app: tauri::AppHandle,
) -> Result<Vec<RecentPlaylistEntry>, AppError> {
    let entries = load_recent_playlists(&app);
    Ok(persist_recent_playlists(&app, entries))
}

#[tauri::command]
pub async fn add_recent_playlist(
    app: tauri::AppHandle,
    recent: RecentPlaylistInput,
) -> Result<Vec<RecentPlaylistEntry>, AppError> {
    let value = recent.value.trim().to_string();
    if value.is_empty() {
        return Err(AppError::Other("Recent playlist value cannot be empty".to_string()));
    }

    if recent.kind == RecentPlaylistKind::File && !Path::new(&value).exists() {
        return Err(AppError::Other(format!(
            "Recent playlist file does not exist: {}",
            value
        )));
    }

    let mut entries = load_recent_playlists(&app);
    entries.retain(|entry| !(entry.kind == recent.kind && entry.value == value));
    entries.insert(
        0,
        RecentPlaylistEntry {
            kind: recent.kind.clone(),
            value: value.clone(),
            label: build_label(&recent.kind, &value),
        },
    );

    Ok(persist_recent_playlists(&app, entries))
}

#[tauri::command]
pub async fn clear_recent_playlists(
    app: tauri::AppHandle,
) -> Result<Vec<RecentPlaylistEntry>, AppError> {
    Ok(persist_recent_playlists(&app, Vec::new()))
}
