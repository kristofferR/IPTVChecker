use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;
use url::Url;

use crate::error::AppError;

const RECENT_STORE_KEY: &str = "recent_playlists";
const RECENT_LIMIT: usize = 10;
const RECENT_SLOT_COUNT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RecentPlaylistKind {
    File,
    Url,
    Xtream,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct XtreamRecentValue {
    server: String,
    username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

fn normalize_xtream_server(server: &str) -> Option<String> {
    let trimmed = server.trim();
    let mut parsed = Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    if parsed.host_str().is_none() {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }

    parsed.set_query(None);
    parsed.set_fragment(None);
    let normalized_path = {
        let path = parsed.path().trim_end_matches('/');
        if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        }
    };
    parsed.set_path(&normalized_path);
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn parse_xtream_recent_value(value: &str) -> Option<XtreamRecentValue> {
    let parsed = serde_json::from_str::<XtreamRecentValue>(value).ok()?;
    let username = parsed.username.trim().to_string();
    if username.is_empty() {
        return None;
    }
    let server = normalize_xtream_server(&parsed.server)?;
    let password = parsed
        .password
        .filter(|p| !p.is_empty());
    Some(XtreamRecentValue {
        server,
        username,
        password,
    })
}

fn serialize_xtream_recent_value(value: &XtreamRecentValue) -> Option<String> {
    serde_json::to_string(value).ok()
}

/// Dedup key for Xtream entries: server + username (ignoring password).
fn xtream_dedup_key(value: &str) -> Option<(String, String)> {
    let parsed = parse_xtream_recent_value(value)?;
    Some((parsed.server, parsed.username))
}

fn xtream_host_label(server: &str) -> String {
    let Ok(parsed) = Url::parse(server) else {
        return server.to_string();
    };
    match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) => format!("{}:{}", host, port),
        (Some(host), None) => host.to_string(),
        _ => server.to_string(),
    }
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
        RecentPlaylistKind::Xtream => parse_xtream_recent_value(value)
            .map(|source| {
                format!(
                    "Xtream: {} ({})",
                    xtream_host_label(&source.server),
                    source.username
                )
            })
            .unwrap_or_else(|| "Xtream: Invalid Source".to_string()),
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
    let mut seen_xtream: HashSet<(String, String)> = HashSet::new();

    for entry in entries {
        let raw_value = entry.value.trim();
        if raw_value.is_empty() {
            continue;
        }

        let value = match entry.kind {
            RecentPlaylistKind::File => {
                let normalized = raw_value.to_string();
                if !Path::new(&normalized).exists() {
                    continue;
                }
                normalized
            }
            RecentPlaylistKind::Url => raw_value.to_string(),
            RecentPlaylistKind::Xtream => {
                let Some(source) = parse_xtream_recent_value(raw_value) else {
                    continue;
                };
                let xtream_key = (source.server.clone(), source.username.clone());
                if seen_xtream.contains(&xtream_key) {
                    continue;
                }
                seen_xtream.insert(xtream_key);
                let Some(serialized) = serialize_xtream_recent_value(&source) else {
                    continue;
                };
                serialized
            }
        };

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
fn apply_recent_menu_update(app: &tauri::AppHandle, entries: &[RecentPlaylistEntry]) {
    use tauri::menu::{MenuItem, PredefinedMenuItem};

    let Some(menu) = app.menu() else {
        return;
    };
    let Some(recent_submenu) = menu
        .get("menu.file")
        .and_then(|item| item.as_submenu().cloned())
        .and_then(|file_submenu| {
            file_submenu
                .get("menu.file.open_recent")
                .and_then(|item| item.as_submenu().cloned())
        })
    else {
        return;
    };

    if let Ok(items) = recent_submenu.items() {
        for index in (0..items.len()).rev() {
            let item = &items[index];
            if item.id() == &"menu.file.recent.clear" {
                continue;
            }
            let _ = recent_submenu.remove_at(index);
        }
    }

    let visible_entries = entries.iter().take(RECENT_SLOT_COUNT).enumerate();
    let mut inserted_any = false;
    for (slot, entry) in visible_entries {
        let prefix = match entry.kind {
            RecentPlaylistKind::File => "File",
            RecentPlaylistKind::Url => "URL",
            RecentPlaylistKind::Xtream => "Xtream",
        };
        let Ok(item) = MenuItem::with_id(
            app,
            format!("menu.file.recent.{}", slot),
            format!("{}. [{}] {}", slot + 1, prefix, entry.label),
            true,
            None::<&str>,
        ) else {
            continue;
        };
        let _ = recent_submenu.insert(&item, slot);
        inserted_any = true;
    }

    if inserted_any {
        if let Ok(separator) = PredefinedMenuItem::separator(app) {
            let entry_count = entries.len().min(RECENT_SLOT_COUNT);
            let _ = recent_submenu.insert(&separator, entry_count);
        }
    } else if let Ok(empty_item) = MenuItem::with_id(
        app,
        "menu.file.recent.empty",
        "No recent playlists",
        false,
        None::<&str>,
    ) {
        let _ = recent_submenu.insert(&empty_item, 0);
    }

    if let Some(clear_item_kind) = recent_submenu.get("menu.file.recent.clear") {
        if let Some(clear_item) = clear_item_kind.as_menuitem() {
            let _ = clear_item.set_enabled(inserted_any);
        }
    }
}

#[cfg(target_os = "macos")]
fn update_recent_menu(app: &tauri::AppHandle, entries: &[RecentPlaylistEntry]) {
    let app_handle = app.clone();
    let entries = entries.to_vec();
    if let Err(error) = app.run_on_main_thread(move || {
        apply_recent_menu_update(&app_handle, &entries);
    }) {
        log::warn!("Failed to schedule recent menu update on main thread: {error}");
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
    let raw_value = recent.value.trim();
    if raw_value.is_empty() {
        return Err(AppError::Other(
            "Recent playlist value cannot be empty".to_string(),
        ));
    }

    let value = match recent.kind {
        RecentPlaylistKind::File => {
            if !Path::new(raw_value).exists() {
                return Err(AppError::Other(format!(
                    "Recent playlist file does not exist: {}",
                    raw_value
                )));
            }
            raw_value.to_string()
        }
        RecentPlaylistKind::Url => raw_value.to_string(),
        RecentPlaylistKind::Xtream => {
            let Some(source) = parse_xtream_recent_value(raw_value) else {
                return Err(AppError::Other("Invalid Xtream recent value".to_string()));
            };
            serialize_xtream_recent_value(&source).ok_or_else(|| {
                AppError::Other("Failed to serialize Xtream recent value".to_string())
            })?
        }
    };

    let mut entries = load_recent_playlists(&app);
    let xtream_key = if recent.kind == RecentPlaylistKind::Xtream {
        xtream_dedup_key(&value)
    } else {
        None
    };
    entries.retain(|entry| {
        if entry.kind != recent.kind {
            return true;
        }
        if let Some((ref server, ref username)) = xtream_key {
            if let Some((s, u)) = xtream_dedup_key(&entry.value) {
                return &s != server || &u != username;
            }
        }
        entry.value != value
    });
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

#[cfg(test)]
mod tests {
    use super::{
        build_label, parse_xtream_recent_value, sanitize_recent_playlists, RecentPlaylistEntry,
        RecentPlaylistKind,
    };

    #[test]
    fn parse_xtream_recent_value_requires_valid_shape() {
        assert!(parse_xtream_recent_value(
            "{\"server\":\"https://demo.example.com\",\"username\":\"user\"}"
        )
        .is_some());
        assert!(parse_xtream_recent_value(
            "{\"server\":\"ftp://demo.example.com\",\"username\":\"user\"}"
        )
        .is_none());
        assert!(parse_xtream_recent_value(
            "{\"server\":\"https://demo.example.com\",\"username\":\"\"}"
        )
        .is_none());
    }

    #[test]
    fn sanitize_recent_playlists_dedupes_xtream_by_normalized_server() {
        let entries = vec![
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com/\",\"username\":\"alice\"}"
                    .to_string(),
                label: "".to_string(),
            },
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com\",\"username\":\"alice\"}"
                    .to_string(),
                label: "".to_string(),
            },
        ];

        let sanitized = sanitize_recent_playlists(entries);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].kind, RecentPlaylistKind::Xtream);
        assert_eq!(
            sanitized[0].value,
            "{\"server\":\"https://demo.example.com\",\"username\":\"alice\"}"
        );
    }

    #[test]
    fn sanitize_recent_playlists_dedupes_xtream_with_and_without_password() {
        let entries = vec![
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com\",\"username\":\"alice\",\"password\":\"secret\"}"
                    .to_string(),
                label: "".to_string(),
            },
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com\",\"username\":\"alice\"}"
                    .to_string(),
                label: "".to_string(),
            },
        ];

        let sanitized = sanitize_recent_playlists(entries);
        assert_eq!(sanitized.len(), 1);
        // The first entry (with password) should win
        assert!(sanitized[0].value.contains("password"));
    }

    #[test]
    fn build_label_for_xtream_uses_host_and_username() {
        let label = build_label(
            &RecentPlaylistKind::Xtream,
            "{\"server\":\"https://demo.example.com:8080\",\"username\":\"bob\"}",
        );
        assert_eq!(label, "Xtream: demo.example.com:8080 (bob)");
    }
}
