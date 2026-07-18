use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use url::Url;

use crate::error::AppError;
use crate::models::playlist::PlaylistPreview;
use crate::models::saved_playlist::{
    SavedPlaylistDraft, SavedPlaylistEntry, SavedPlaylistSource, SavedPlaylistUpsertResult,
};

const SAVED_PLAYLISTS_STORE_KEY: &str = "saved_playlists";
const SOURCE_DISPLAY_NAMES_STORE_KEY: &str = "source_display_names";
#[cfg(target_os = "macos")]
const SAVED_SLOT_COUNT: usize = 10;
static NEXT_SAVED_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenameSourceDescriptor {
    Path { path: String },
    Url { url: String },
    Xtream { server: String, username: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenamePlaylistSourceInput {
    #[serde(default)]
    pub saved_playlist_id: Option<String>,
    #[serde(default)]
    pub descriptor: Option<RenameSourceDescriptor>,
    pub display_name: String,
}

fn next_saved_id() -> String {
    let counter = NEXT_SAVED_ID.fetch_add(1, Ordering::Relaxed);
    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("saved-{}-{}", epoch_ms, counter)
}

fn sort_saved_playlists(entries: &mut [SavedPlaylistEntry]) {
    entries.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn default_display_name(source: &SavedPlaylistSource) -> String {
    match source {
        SavedPlaylistSource::File { path } => Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| path.to_string()),
        SavedPlaylistSource::Url { url } => {
            let Ok(parsed) = Url::parse(url) else {
                return url.to_string();
            };
            crate::commands::playlist::friendly_name_from_url(&parsed)
        }
        SavedPlaylistSource::Xtream {
            servers,
            preferred_server,
            username,
            ..
        } => {
            let server = preferred_server
                .as_deref()
                .or_else(|| servers.first().map(String::as_str))
                .unwrap_or("Xtream");
            format!("{} ({})", crate::commands::playlist::xtream_host_label(server), username)
        }
    }
}

pub(crate) fn path_source_identity(path: &str) -> String {
    let trimmed = path.trim();
    let normalized = if trimmed.is_empty() {
        String::new()
    } else if let Ok(canonical) = Path::new(trimmed).canonicalize() {
        canonical.to_string_lossy().to_string()
    } else {
        trimmed.to_string()
    };
    format!("path:{}", normalized)
}

fn normalized_url_string(url: &str) -> Result<String, AppError> {
    let trimmed = url.trim();
    let parsed =
        Url::parse(trimmed).map_err(|_| AppError::Parse("Invalid playlist URL".to_string()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Parse(
            "Invalid playlist URL: must start with http:// or https://".to_string(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid playlist URL: missing host".to_string(),
        ));
    }
    Ok(crate::commands::playlist::normalize_url_identity(&parsed))
}

pub(crate) fn source_identity_for_url(url: &str) -> Result<String, AppError> {
    Ok(format!("url:{}", normalized_url_string(url)?))
}

pub(crate) fn source_identity_for_xtream(server: &str, username: &str) -> Result<String, AppError> {
    let normalized_server = crate::commands::playlist::normalize_xtream_server(server)?;
    let username = username.trim();
    if username.is_empty() {
        return Err(AppError::Parse(
            "Xtream username cannot be empty".to_string(),
        ));
    }
    Ok(crate::commands::playlist::build_xtream_source_key(
        &normalized_server,
        username,
    ))
}

fn sanitize_saved_playlist_entry(
    entry: SavedPlaylistEntry,
) -> Result<SavedPlaylistEntry, AppError> {
    let id = entry.id.trim().to_string();
    if id.is_empty() {
        return Err(AppError::Other(
            "Saved playlist id cannot be empty".to_string(),
        ));
    }

    let source = match entry.source {
        SavedPlaylistSource::File { path } => {
            let path = path.trim();
            if path.is_empty() {
                return Err(AppError::Other(
                    "Saved playlist file path cannot be empty".to_string(),
                ));
            }
            SavedPlaylistSource::File {
                path: path.to_string(),
            }
        }
        SavedPlaylistSource::Url { url } => SavedPlaylistSource::Url {
            url: normalized_url_string(&url)?,
        },
        SavedPlaylistSource::Xtream {
            servers,
            preferred_server,
            username,
            password,
        } => {
            let username = username.trim().to_string();
            if username.is_empty() {
                return Err(AppError::Parse(
                    "Xtream username cannot be empty".to_string(),
                ));
            }
            let password = password
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Parse("Xtream password cannot be empty".to_string()))?;

            let mut normalized_servers = Vec::new();
            let mut seen = HashSet::new();
            for server in servers {
                let normalized = crate::commands::playlist::normalize_xtream_server(&server)?
                    .to_string()
                    .trim_end_matches('/')
                    .to_string();
                if seen.insert(normalized.clone()) {
                    normalized_servers.push(normalized);
                }
            }
            if normalized_servers.is_empty() {
                return Err(AppError::Parse(
                    "Saved Xtream playlist must include at least one server".to_string(),
                ));
            }

            let preferred_server = preferred_server
                .as_deref()
                .and_then(|value| {
                    crate::commands::playlist::normalize_xtream_server(value)
                        .ok()
                        .map(|url| url.to_string().trim_end_matches('/').to_string())
                })
                .filter(|server| normalized_servers.iter().any(|value| value == server))
                .or_else(|| normalized_servers.first().cloned());

            SavedPlaylistSource::Xtream {
                servers: normalized_servers,
                preferred_server,
                username,
                password: Some(password),
            }
        }
    };

    let display_name = entry.display_name.trim();
    Ok(SavedPlaylistEntry {
        id,
        display_name: if display_name.is_empty() {
            default_display_name(&source)
        } else {
            display_name.to_string()
        },
        source,
    })
}

fn sanitize_saved_playlists(entries: Vec<SavedPlaylistEntry>) -> Vec<SavedPlaylistEntry> {
    let mut sanitized = Vec::new();
    let mut seen_ids = HashSet::new();

    for entry in entries {
        let Ok(entry) = sanitize_saved_playlist_entry(entry) else {
            continue;
        };
        if seen_ids.insert(entry.id.clone()) {
            sanitized.push(entry);
        }
    }

    sort_saved_playlists(&mut sanitized);
    sanitized
}

fn load_saved_playlists_raw(app: &tauri::AppHandle) -> Result<Vec<SavedPlaylistEntry>, AppError> {
    let Ok(store) = app.store("settings.json") else {
        return Ok(Vec::new());
    };
    let Some(value) = store.get(SAVED_PLAYLISTS_STORE_KEY) else {
        return Ok(Vec::new());
    };
    serde_json::from_value::<Vec<SavedPlaylistEntry>>(value)
        .map_err(|error| AppError::Other(format!("Failed to parse saved playlists: {error}")))
}

fn save_saved_playlists(app: &tauri::AppHandle, entries: &[SavedPlaylistEntry]) {
    let Ok(store) = app.store("settings.json") else {
        return;
    };
    if let Ok(value) = serde_json::to_value(entries) {
        store.set(SAVED_PLAYLISTS_STORE_KEY, value);
    }
}

pub(crate) fn load_saved_playlists(
    app: &tauri::AppHandle,
) -> Result<Vec<SavedPlaylistEntry>, AppError> {
    Ok(sanitize_saved_playlists(load_saved_playlists_raw(app)?))
}

fn persist_saved_playlists(
    app: &tauri::AppHandle,
    entries: Vec<SavedPlaylistEntry>,
) -> Vec<SavedPlaylistEntry> {
    let sanitized = sanitize_saved_playlists(entries);
    save_saved_playlists(app, &sanitized);
    update_saved_menu(app, &sanitized);
    sanitized
}

fn load_source_display_names(app: &tauri::AppHandle) -> HashMap<String, String> {
    let Ok(store) = app.store("settings.json") else {
        return HashMap::new();
    };
    let Some(value) = store.get(SOURCE_DISPLAY_NAMES_STORE_KEY) else {
        return HashMap::new();
    };
    let raw = serde_json::from_value::<HashMap<String, String>>(value).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some((key, value))
            }
        })
        .collect()
}

fn save_source_display_names(app: &tauri::AppHandle, names: &HashMap<String, String>) {
    let Ok(store) = app.store("settings.json") else {
        return;
    };
    if let Ok(value) = serde_json::to_value(names) {
        store.set(SOURCE_DISPLAY_NAMES_STORE_KEY, value);
    }
}

pub(crate) fn saved_playlist_by_id(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<Option<SavedPlaylistEntry>, AppError> {
    let target = id.trim();
    if target.is_empty() {
        return Ok(None);
    }
    Ok(load_saved_playlists(app)?
        .into_iter()
        .find(|entry| entry.id == target))
}

pub(crate) fn resolve_source_display_name(
    app: &tauri::AppHandle,
    saved_playlist_id: Option<&str>,
    source_identity: Option<&str>,
    path: Option<&str>,
    fallback: &str,
) -> String {
    if let Some(id) = saved_playlist_id {
        match saved_playlist_by_id(app, id) {
            Ok(Some(entry)) => return entry.display_name,
            Ok(None) => {}
            Err(error) => {
                log::warn!("Failed to load saved playlist metadata for '{id}': {error}");
            }
        }
    }

    let names = load_source_display_names(app);
    if let Some(identity) = source_identity.and_then(|value| names.get(value).cloned()) {
        return identity;
    }
    if let Some(path) = path {
        let key = path_source_identity(path);
        if let Some(value) = names.get(&key) {
            return value.clone();
        }
    }

    fallback.to_string()
}

pub(crate) fn apply_persisted_playlist_metadata(
    app: &tauri::AppHandle,
    preview: &mut PlaylistPreview,
    saved_playlist_id: Option<&str>,
    display_name_override: Option<&str>,
) -> Result<(), AppError> {
    let display_name = display_name_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            resolve_source_display_name(
                app,
                saved_playlist_id,
                preview.source_identity.as_deref(),
                Some(&preview.file_path),
                &preview.file_name,
            )
        });

    preview.saved_playlist_id = saved_playlist_id.map(ToString::to_string);
    preview.file_name = display_name.clone();

    if !Path::new(&preview.file_path).is_dir() {
        for channel in &mut preview.channels {
            channel.playlist = display_name.clone();
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_saved_menu_update(app: &tauri::AppHandle, entries: &[SavedPlaylistEntry]) {
    use tauri::menu::MenuItem;

    let Some(menu) = app.menu() else {
        return;
    };
    let Some(saved_submenu) = menu
        .get("menu.file")
        .and_then(|item| item.as_submenu().cloned())
        .and_then(|file_submenu| {
            file_submenu
                .get("menu.file.open_saved")
                .and_then(|item| item.as_submenu().cloned())
        })
    else {
        return;
    };

    if let Ok(items) = saved_submenu.items() {
        for index in (0..items.len()).rev() {
            let _ = saved_submenu.remove_at(index);
        }
    }

    let visible_entries = entries.iter().take(SAVED_SLOT_COUNT).enumerate();
    let mut inserted_any = false;
    for (slot, entry) in visible_entries {
        let Ok(item) = MenuItem::with_id(
            app,
            format!("menu.file.saved.{}", slot),
            format!("{}. {}", slot + 1, entry.display_name),
            true,
            None::<&str>,
        ) else {
            continue;
        };
        let _ = saved_submenu.insert(&item, slot);
        inserted_any = true;
    }

    if !inserted_any {
        if let Ok(empty_item) = MenuItem::with_id(
            app,
            "menu.file.saved.empty",
            "No saved playlists",
            false,
            None::<&str>,
        ) {
            let _ = saved_submenu.insert(&empty_item, 0);
        }
    }
}

#[cfg(target_os = "macos")]
fn update_saved_menu(app: &tauri::AppHandle, entries: &[SavedPlaylistEntry]) {
    let app_handle = app.clone();
    let entries = entries.to_vec();
    if let Err(error) = app.run_on_main_thread(move || {
        apply_saved_menu_update(&app_handle, &entries);
    }) {
        log::warn!("Failed to schedule saved menu update on main thread: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
fn update_saved_menu(_app: &tauri::AppHandle, _entries: &[SavedPlaylistEntry]) {}

pub fn refresh_saved_menu(app: &tauri::AppHandle) {
    match load_saved_playlists(app) {
        Ok(entries) => update_saved_menu(app, &entries),
        Err(error) => {
            log::warn!("Failed to refresh saved menu: {error}");
        }
    }
}

#[tauri::command]
pub async fn get_saved_playlists(
    app: tauri::AppHandle,
) -> Result<Vec<SavedPlaylistEntry>, AppError> {
    let entries = load_saved_playlists(&app)?;
    Ok(persist_saved_playlists(&app, entries))
}

#[tauri::command]
pub async fn upsert_saved_playlist(
    app: tauri::AppHandle,
    draft: SavedPlaylistDraft,
) -> Result<SavedPlaylistUpsertResult, AppError> {
    let entry = sanitize_saved_playlist_entry(SavedPlaylistEntry {
        id: draft.id.unwrap_or_else(next_saved_id),
        display_name: draft.display_name,
        source: draft.source,
    })?;

    let mut entries = load_saved_playlists(&app)?;
    if let Some(index) = entries.iter().position(|existing| existing.id == entry.id) {
        entries[index] = entry.clone();
    } else {
        entries.push(entry.clone());
    }

    let entries = persist_saved_playlists(&app, entries);
    crate::commands::recent::refresh_recent_menu(&app);

    Ok(SavedPlaylistUpsertResult { entry, entries })
}

#[tauri::command]
pub async fn delete_saved_playlist(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<SavedPlaylistEntry>, AppError> {
    let target = id.trim();
    if target.is_empty() {
        return Err(AppError::Other(
            "Saved playlist id cannot be empty".to_string(),
        ));
    }

    let mut entries = load_saved_playlists(&app)?;
    entries.retain(|entry| entry.id != target);
    let entries = persist_saved_playlists(&app, entries);
    crate::commands::recent::refresh_recent_menu(&app);
    Ok(entries)
}

#[tauri::command]
pub async fn rename_playlist_source(
    app: tauri::AppHandle,
    input: RenamePlaylistSourceInput,
) -> Result<(), AppError> {
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err(AppError::Other(
            "Playlist display name cannot be empty".to_string(),
        ));
    }

    if let Some(saved_playlist_id) = input.saved_playlist_id.as_deref() {
        let mut entries = load_saved_playlists(&app)?;
        let Some(entry) = entries
            .iter_mut()
            .find(|entry| entry.id == saved_playlist_id.trim())
        else {
            return Err(AppError::Other("Saved playlist not found".to_string()));
        };
        entry.display_name = display_name.to_string();
        let _ = persist_saved_playlists(&app, entries);
        crate::commands::recent::refresh_recent_menu(&app);
        return Ok(());
    }

    let descriptor = input
        .descriptor
        .ok_or_else(|| AppError::Other("Missing playlist source descriptor".to_string()))?;
    let source_key = match descriptor {
        RenameSourceDescriptor::Path { path } => path_source_identity(&path),
        RenameSourceDescriptor::Url { url } => source_identity_for_url(&url)?,
        RenameSourceDescriptor::Xtream { server, username } => {
            source_identity_for_xtream(&server, &username)?
        }
    };

    let mut names = load_source_display_names(&app);
    names.insert(source_key, display_name.to_string());
    save_source_display_names(&app, &names);
    crate::commands::recent::refresh_recent_menu(&app);
    Ok(())
}

#[tauri::command]
pub async fn open_saved_playlist(
    app: tauri::AppHandle,
    id: String,
    group_filter: Option<String>,
    channel_search: Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let entry = saved_playlist_by_id(&app, &id)?
        .ok_or_else(|| AppError::Other("Saved playlist not found".to_string()))?;

    let mut preview = match &entry.source {
        SavedPlaylistSource::File { path } => {
            if !Path::new(path).exists() {
                return Err(AppError::Other(format!(
                    "Saved playlist file does not exist: {}",
                    path
                )));
            }
            crate::commands::playlist::open_playlist_path_inner(
                &app,
                path.clone(),
                group_filter.clone(),
                channel_search.clone(),
            )
            .await?
        }
        SavedPlaylistSource::Url { url } => {
            let data_dir = app.path().app_data_dir().map_err(|error| {
                AppError::Other(format!("Failed to resolve app data directory: {}", error))
            })?;
            crate::commands::playlist::open_playlist_url_from_data_dir(
                Some(&app),
                &data_dir,
                url,
                group_filter.clone(),
                channel_search.clone(),
            )
            .await?
        }
        SavedPlaylistSource::Xtream {
            servers,
            preferred_server,
            username,
            password,
        } => {
            let password = password
                .clone()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| AppError::Parse("Saved Xtream password is missing".to_string()))?;

            let mut ordered_servers = Vec::new();
            if let Some(preferred) = preferred_server {
                ordered_servers.push(preferred.clone());
            }
            for server in servers {
                if !ordered_servers.iter().any(|value| value == server) {
                    ordered_servers.push(server.clone());
                }
            }

            let mut errors = Vec::new();
            let mut winning_server = None;
            let mut preview = None;
            for server in ordered_servers {
                let source = crate::commands::playlist::XtreamOpenRequest {
                    server: server.clone(),
                    username: username.clone(),
                    password: password.clone(),
                };
                match crate::commands::playlist::open_playlist_xtream_inner(
                    &app,
                    &source,
                    group_filter.clone(),
                    channel_search.clone(),
                    Some(format!("saved:{}", entry.id)),
                )
                .await
                {
                    Ok(result) => {
                        winning_server = Some(server);
                        preview = Some(result);
                        break;
                    }
                    Err(error) => {
                        errors.push(format!("{}: {}", server, error));
                    }
                }
            }

            let Some(preview) = preview else {
                return Err(AppError::Other(format!(
                    "Failed to open saved Xtream playlist \"{}\". {}",
                    entry.display_name,
                    errors.join(" | ")
                )));
            };

            if let Some(server) = winning_server {
                match load_saved_playlists(&app) {
                    Ok(mut entries) => {
                        if let Some(saved_entry) =
                            entries.iter_mut().find(|value| value.id == entry.id)
                        {
                            if let SavedPlaylistSource::Xtream {
                                preferred_server, ..
                            } = &mut saved_entry.source
                            {
                                *preferred_server = Some(server);
                            }
                            let _ = persist_saved_playlists(&app, entries);
                        }
                    }
                    Err(error) => {
                        log::warn!(
                            "Failed to update preferred server for saved playlist '{}': {}",
                            entry.id,
                            error
                        );
                    }
                }
            }

            preview
        }
    };

    apply_persisted_playlist_metadata(
        &app,
        &mut preview,
        Some(&entry.id),
        Some(&entry.display_name),
    )?;
    crate::commands::scan::seed_cached_playlist_preview(
        &app,
        &preview.file_path,
        preview.source_identity.as_deref(),
        Some(&preview.file_name),
        group_filter.as_deref(),
        channel_search.as_deref(),
        &preview,
    )
    .await;
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::{
        default_display_name, path_source_identity, sanitize_saved_playlist_entry,
        SavedPlaylistEntry, SavedPlaylistSource,
    };

    #[test]
    fn path_source_identity_keeps_prefix_and_value() {
        let key = path_source_identity("/tmp/sample.m3u8");
        assert!(key.starts_with("path:"));
        assert!(key.ends_with("/tmp/sample.m3u8"));
    }

    #[test]
    fn default_display_name_for_xtream_uses_preferred_server() {
        let label = default_display_name(&SavedPlaylistSource::Xtream {
            servers: vec![
                "https://backup.example.com".to_string(),
                "https://main.example.com".to_string(),
            ],
            preferred_server: Some("https://main.example.com".to_string()),
            username: "alice".to_string(),
            password: Some("secret".to_string()),
        });

        assert_eq!(label, "main.example.com (alice)");
    }

    #[test]
    fn sanitize_saved_playlist_entry_normalizes_xtream_servers() {
        let entry = sanitize_saved_playlist_entry(SavedPlaylistEntry {
            id: "saved-1".to_string(),
            display_name: "".to_string(),
            source: SavedPlaylistSource::Xtream {
                servers: vec![
                    "https://demo.example.com/".to_string(),
                    "https://demo.example.com/get.php".to_string(),
                ],
                preferred_server: None,
                username: "alice".to_string(),
                password: Some("secret".to_string()),
            },
        })
        .expect("entry should sanitize");

        match entry.source {
            SavedPlaylistSource::Xtream {
                servers,
                preferred_server,
                ..
            } => {
                assert_eq!(servers, vec!["https://demo.example.com".to_string()]);
                assert_eq!(
                    preferred_server,
                    Some("https://demo.example.com".to_string())
                );
            }
            _ => panic!("expected xtream source"),
        }
        assert_eq!(entry.display_name, "demo.example.com (alice)");
    }

    #[test]
    fn sanitize_saved_playlist_entry_keeps_missing_file_paths() {
        let entry = sanitize_saved_playlist_entry(SavedPlaylistEntry {
            id: "saved-file".to_string(),
            display_name: "Offline File".to_string(),
            source: SavedPlaylistSource::File {
                path: "/definitely/not/present/playlist.m3u".to_string(),
            },
        })
        .expect("missing file paths should remain saveable");

        match entry.source {
            SavedPlaylistSource::File { path } => {
                assert_eq!(path, "/definitely/not/present/playlist.m3u");
            }
            _ => panic!("expected file source"),
        }
    }
}
