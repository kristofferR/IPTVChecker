use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;
use crate::models::saved_playlist::{SavedPlaylistEntry as SavedSourceEntry, SavedPlaylistSource};

const RECENT_STORE_KEY: &str = "recent_playlists";
const RECENT_LIMIT: usize = 10;
#[cfg(target_os = "macos")]
const RECENT_SLOT_COUNT: usize = 10;
const DEFAULT_PLAYLIST_URL: &str = "https://iptv-org.github.io/iptv/index.m3u";
const DEFAULT_PLAYLIST_LABEL: &str = "iptv-org — Full index";
const LEGACY_DEFAULT_PLAYLIST_URL: &str = "https://iptv-org.github.io/iptv/categories/news.m3u";
const LEGACY_DEFAULT_PLAYLIST_LABEL: &str = "iptv-org — News channels";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RecentPlaylistKind {
    File,
    Url,
    Xtream,
    Dispatcharr,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct XtreamRecentValue {
    server: String,
    username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

fn normalize_xtream_server(server: &str) -> Option<String> {
    // Delegate to the canonical normalizer (it also strips /get.php) so
    // recent-entry dedup keys can't drift from the saved-playlist and
    // source-identity keys built in playlist.rs.
    let url = crate::commands::playlist::normalize_xtream_server(server).ok()?;
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn parse_xtream_recent_value(value: &str) -> Option<XtreamRecentValue> {
    let parsed = serde_json::from_str::<XtreamRecentValue>(value).ok()?;
    let username = parsed.username.trim().to_string();
    if username.is_empty() {
        return None;
    }
    let server = normalize_xtream_server(&parsed.server)?;
    let password = parsed.password.filter(|p| !p.is_empty());
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

/// Secrets are only present when the user chose to remember them.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DispatcharrRecentValue {
    server: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    /// Identifies the API-key account when the key itself is not remembered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_fingerprint: Option<String>,
}

fn parse_dispatcharr_recent_value(value: &str) -> Option<DispatcharrRecentValue> {
    let parsed = serde_json::from_str::<DispatcharrRecentValue>(value).ok()?;
    let clean = |value: Option<String>| {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let server = crate::engine::dispatcharr::normalize_dispatcharr_server(&parsed.server).ok()?;
    Some(DispatcharrRecentValue {
        server: server.to_string().trim_end_matches('/').to_string(),
        username: clean(parsed.username),
        password: clean(parsed.password),
        api_key: clean(parsed.api_key),
        key_fingerprint: clean(parsed.key_fingerprint)
            .filter(|value| value.len() == 12 && value.bytes().all(|b| b.is_ascii_hexdigit())),
    })
}

/// Source identity of a recent Dispatcharr value.
fn dispatcharr_recent_identity(source: &DispatcharrRecentValue) -> Option<String> {
    if let (None, Some(fingerprint)) = (&source.api_key, &source.key_fingerprint) {
        let base = crate::engine::dispatcharr::normalize_dispatcharr_server(&source.server).ok()?;
        return Some(crate::engine::dispatcharr::dispatcharr_source_key(
            &base,
            &format!("api-key:{}", fingerprint),
        ));
    }
    crate::commands::saved::source_identity_for_dispatcharr(
        &source.server,
        source.username.as_deref(),
        source.api_key.as_deref(),
    )
    .ok()
}

/// Dedup key for credentialed sources: server + account, ignoring secrets.
fn credential_dedup_key(kind: &RecentPlaylistKind, value: &str) -> Option<(String, String)> {
    match kind {
        RecentPlaylistKind::Xtream => xtream_dedup_key(value),
        RecentPlaylistKind::Dispatcharr => {
            let identity = dispatcharr_recent_identity(&parse_dispatcharr_recent_value(value)?)?;
            Some((identity, String::new()))
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentPlaylistEntry {
    pub kind: RecentPlaylistKind,
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_playlist_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecentPlaylistInput {
    pub kind: RecentPlaylistKind,
    pub value: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub saved_playlist_id: Option<String>,
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
                    "{} ({})",
                    crate::commands::playlist::xtream_host_label(&source.server),
                    source.username
                )
            })
            .unwrap_or_else(|| "Invalid Source".to_string()),
        RecentPlaylistKind::Dispatcharr => parse_dispatcharr_recent_value(value)
            .map(|source| {
                format!(
                    "{} (Dispatcharr)",
                    crate::commands::playlist::xtream_host_label(&source.server)
                )
            })
            .unwrap_or_else(|| "Invalid Source".to_string()),
    }
}

fn find_saved_playlist_for_recent(
    app: &tauri::AppHandle,
    kind: &RecentPlaylistKind,
    value: &str,
) -> Result<Option<SavedSourceEntry>, AppError> {
    let entries = crate::commands::saved::load_saved_playlists(app)?;

    match kind {
        RecentPlaylistKind::File => {
            let target = crate::commands::saved::path_source_identity(value);
            Ok(entries.into_iter().find(|entry| {
                matches!(
                    &entry.source,
                    SavedPlaylistSource::File { path }
                        if crate::commands::saved::path_source_identity(path) == target
                )
            }))
        }
        RecentPlaylistKind::Url => {
            let target = crate::commands::saved::source_identity_for_url(value)?;
            Ok(entries.into_iter().find(|entry| {
                matches!(
                    &entry.source,
                    SavedPlaylistSource::Url { url }
                        if crate::commands::saved::source_identity_for_url(url)
                            .ok()
                            .as_deref()
                            == Some(target.as_str())
                )
            }))
        }
        RecentPlaylistKind::Xtream => {
            let Some(source) = parse_xtream_recent_value(value) else {
                return Ok(None);
            };
            let target = crate::commands::saved::source_identity_for_xtream(
                &source.server,
                &source.username,
            )?;

            Ok(entries.into_iter().find(|entry| match &entry.source {
                SavedPlaylistSource::Xtream {
                    servers, username, ..
                } => {
                    if username.trim() != source.username {
                        return false;
                    }

                    servers.iter().any(|server| {
                        crate::commands::saved::source_identity_for_xtream(server, username)
                            .ok()
                            .as_deref()
                            == Some(target.as_str())
                    })
                }
                _ => false,
            }))
        }
        RecentPlaylistKind::Dispatcharr => {
            let Some(target) =
                parse_dispatcharr_recent_value(value).and_then(|s| dispatcharr_recent_identity(&s))
            else {
                return Ok(None);
            };
            Ok(entries.into_iter().find(|entry| match &entry.source {
                SavedPlaylistSource::Dispatcharr {
                    server,
                    username,
                    api_key,
                    ..
                } => {
                    crate::commands::saved::source_identity_for_dispatcharr(
                        server,
                        username.as_deref(),
                        api_key.as_deref(),
                    )
                    .ok()
                    .as_deref()
                        == Some(target.as_str())
                }
                _ => false,
            }))
        }
    }
}

fn default_recent_playlists() -> Vec<RecentPlaylistEntry> {
    vec![RecentPlaylistEntry {
        kind: RecentPlaylistKind::Url,
        value: DEFAULT_PLAYLIST_URL.to_string(),
        label: DEFAULT_PLAYLIST_LABEL.to_string(),
        saved_playlist_id: None,
    }]
}

fn load_recent_playlists(app: &tauri::AppHandle) -> Vec<RecentPlaylistEntry> {
    let Ok(store) = app.store("settings.json") else {
        return default_recent_playlists();
    };
    let Some(value) = store.get(RECENT_STORE_KEY) else {
        return default_recent_playlists();
    };
    let entries = serde_json::from_value::<Vec<RecentPlaylistEntry>>(value).unwrap_or_default();
    if entries.is_empty() {
        return default_recent_playlists();
    }
    entries
}

fn save_recent_playlists(app: &tauri::AppHandle, entries: &[RecentPlaylistEntry]) {
    let Ok(store) = app.store("settings.json") else {
        return;
    };
    if let Ok(value) = serde_json::to_value(entries) {
        store.set(RECENT_STORE_KEY, value);
    }
}

fn sanitize_recent_playlists_inner(
    app: Option<&tauri::AppHandle>,
    entries: Vec<RecentPlaylistEntry>,
) -> Vec<RecentPlaylistEntry> {
    let mut sanitized = Vec::new();
    let mut seen: HashSet<(RecentPlaylistKind, String)> = HashSet::new();
    let mut seen_xtream: HashSet<(String, String)> = HashSet::new();

    for entry in entries {
        let raw_value = entry.value.trim();
        if raw_value.is_empty() {
            continue;
        }

        let (entry_kind, entry_value, entry_label, entry_saved_playlist_id) = if entry.kind
            == RecentPlaylistKind::Url
            && raw_value == LEGACY_DEFAULT_PLAYLIST_URL
            && entry.label.trim() == LEGACY_DEFAULT_PLAYLIST_LABEL
        {
            (
                RecentPlaylistKind::Url,
                DEFAULT_PLAYLIST_URL.to_string(),
                DEFAULT_PLAYLIST_LABEL.to_string(),
                None,
            )
        } else {
            (
                entry.kind.clone(),
                raw_value.to_string(),
                entry.label.clone(),
                entry
                    .saved_playlist_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string),
            )
        };

        let value = match entry_kind {
            RecentPlaylistKind::File => {
                let normalized = entry_value;
                if !Path::new(&normalized).exists() {
                    continue;
                }
                normalized
            }
            RecentPlaylistKind::Url => entry_value,
            RecentPlaylistKind::Xtream => {
                let Some(source) = parse_xtream_recent_value(&entry_value) else {
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
            RecentPlaylistKind::Dispatcharr => {
                let Some(source) = parse_dispatcharr_recent_value(&entry_value) else {
                    continue;
                };
                let Some(identity) = dispatcharr_recent_identity(&source) else {
                    continue;
                };
                if !seen_xtream.insert((identity, String::new())) {
                    continue;
                }
                let Ok(serialized) = serde_json::to_string(&source) else {
                    continue;
                };
                serialized
            }
        };

        let key = (entry_kind.clone(), value.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        let fallback_label = build_label(&entry_kind, &value);

        let display_name = if let Some(app) = app {
            crate::commands::saved::resolve_source_display_name(
                app,
                entry_saved_playlist_id.as_deref(),
                match entry_kind {
                    RecentPlaylistKind::File => None,
                    RecentPlaylistKind::Url => {
                        crate::commands::saved::source_identity_for_url(&value).ok()
                    }
                    RecentPlaylistKind::Xtream => {
                        parse_xtream_recent_value(&value).and_then(|source| {
                            crate::commands::saved::source_identity_for_xtream(
                                &source.server,
                                &source.username,
                            )
                            .ok()
                        })
                    }
                    RecentPlaylistKind::Dispatcharr => parse_dispatcharr_recent_value(&value)
                        .and_then(|source| dispatcharr_recent_identity(&source)),
                }
                .as_deref(),
                match entry_kind {
                    RecentPlaylistKind::File => Some(value.as_str()),
                    _ => None,
                },
                if entry_label.trim().is_empty() {
                    &fallback_label
                } else {
                    &entry_label
                },
            )
        } else if entry_label.trim().is_empty() {
            fallback_label.clone()
        } else {
            entry_label.clone()
        };

        let saved_playlist_id = if let Some(app) = app {
            let validated_saved_entry = entry_saved_playlist_id.as_deref().and_then(|id| {
                match crate::commands::saved::saved_playlist_by_id(app, id) {
                    Ok(entry) => entry,
                    Err(error) => {
                        log::warn!(
                            "Failed to resolve saved playlist '{id}' for recent menu: {}",
                            error
                        );
                        None
                    }
                }
            });

            let matched_saved_entry = if validated_saved_entry.is_some() {
                None
            } else {
                match find_saved_playlist_for_recent(app, &entry_kind, &value) {
                    Ok(entry) => entry,
                    Err(error) => {
                        // Log the label: Xtream and Dispatcharr values can
                        // hold remembered credentials.
                        log::warn!(
                            "Failed to backfill saved playlist id for recent entry '{}': {}",
                            build_label(&entry_kind, &value),
                            error
                        );
                        None
                    }
                }
            };

            validated_saved_entry
                .or(matched_saved_entry)
                .map(|entry| entry.id)
        } else {
            entry_saved_playlist_id.clone()
        };

        sanitized.push(RecentPlaylistEntry {
            kind: entry_kind.clone(),
            value: value.clone(),
            label: display_name,
            saved_playlist_id,
        });

        if sanitized.len() >= RECENT_LIMIT {
            break;
        }
    }

    sanitized
}

fn sanitize_recent_playlists(
    app: &tauri::AppHandle,
    entries: Vec<RecentPlaylistEntry>,
) -> Vec<RecentPlaylistEntry> {
    sanitize_recent_playlists_inner(Some(app), entries)
}

#[cfg(test)]
fn sanitize_recent_playlists_for_tests(
    entries: Vec<RecentPlaylistEntry>,
) -> Vec<RecentPlaylistEntry> {
    sanitize_recent_playlists_inner(None, entries)
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
            if item.id() == "menu.file.recent.clear" {
                continue;
            }
            let _ = recent_submenu.remove_at(index);
        }
    }

    let visible_entries = entries.iter().take(RECENT_SLOT_COUNT).enumerate();
    let mut inserted_any = false;
    for (slot, entry) in visible_entries {
        let prefix = match entry.kind {
            RecentPlaylistKind::File => crate::i18n::text("menu.file.recent.kind_file"),
            RecentPlaylistKind::Url => "URL".to_string(),
            RecentPlaylistKind::Xtream => "Xtream".to_string(),
            RecentPlaylistKind::Dispatcharr => "Dispatcharr".to_string(),
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
        crate::i18n::text("menu.file.recent.empty"),
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
    let sanitized = sanitize_recent_playlists(app, entries);
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
        RecentPlaylistKind::Dispatcharr => {
            let Some(source) = parse_dispatcharr_recent_value(raw_value) else {
                return Err(AppError::Other(
                    "Invalid Dispatcharr recent value".to_string(),
                ));
            };
            serde_json::to_string(&source).map_err(|_| {
                AppError::Other("Failed to serialize Dispatcharr recent value".to_string())
            })?
        }
    };

    let mut entries = load_recent_playlists(&app);
    let credential_key = credential_dedup_key(&recent.kind, &value);
    entries.retain(|entry| {
        if entry.kind != recent.kind {
            return true;
        }
        if let Some(ref key) = credential_key {
            if let Some(existing) = credential_dedup_key(&entry.kind, &entry.value) {
                return &existing != key;
            }
        }
        entry.value != value
    });
    entries.insert(
        0,
        RecentPlaylistEntry {
            kind: recent.kind.clone(),
            value: value.clone(),
            label: recent
                .label
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| build_label(&recent.kind, &value)),
            saved_playlist_id: recent
                .saved_playlist_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
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
        build_label, default_recent_playlists, parse_xtream_recent_value,
        sanitize_recent_playlists_for_tests, RecentPlaylistEntry, RecentPlaylistKind,
        DEFAULT_PLAYLIST_LABEL, DEFAULT_PLAYLIST_URL, LEGACY_DEFAULT_PLAYLIST_LABEL,
        LEGACY_DEFAULT_PLAYLIST_URL,
    };

    #[test]
    fn default_recent_playlist_points_to_iptv_org_index() {
        let entries = default_recent_playlists();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, RecentPlaylistKind::Url);
        assert_eq!(entries[0].value, DEFAULT_PLAYLIST_URL);
        assert_eq!(entries[0].label, DEFAULT_PLAYLIST_LABEL);
    }

    #[test]
    fn sanitize_recent_playlists_migrates_legacy_seeded_default() {
        let entries = sanitize_recent_playlists_for_tests(vec![RecentPlaylistEntry {
            kind: RecentPlaylistKind::Url,
            value: LEGACY_DEFAULT_PLAYLIST_URL.to_string(),
            label: LEGACY_DEFAULT_PLAYLIST_LABEL.to_string(),
            saved_playlist_id: None,
        }]);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, RecentPlaylistKind::Url);
        assert_eq!(entries[0].value, DEFAULT_PLAYLIST_URL);
        assert_eq!(entries[0].label, DEFAULT_PLAYLIST_LABEL);
    }

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
    fn unremembered_api_keys_stay_separate_recents() {
        let recent = |fingerprint: &str| RecentPlaylistEntry {
            kind: RecentPlaylistKind::Dispatcharr,
            value: format!(
                r#"{{"server":"http://dvr.example:9191","key_fingerprint":"{}"}}"#,
                fingerprint
            ),
            label: String::new(),
            saved_playlist_id: None,
        };
        let sanitized = sanitize_recent_playlists_for_tests(vec![
            recent("aaaaaaaaaaaa"),
            recent("bbbbbbbbbbbb"),
        ]);
        assert_eq!(sanitized.len(), 2);
        // Same value the frontend computes for an unremembered key.
        assert_eq!(
            crate::engine::dispatcharr::api_key_fingerprint("key"),
            "2c70e12b7a06"
        );
    }

    #[test]
    fn sanitize_recent_playlists_dedupes_xtream_by_normalized_server() {
        let entries = vec![
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com/\",\"username\":\"alice\"}"
                    .to_string(),
                label: "".to_string(),
                saved_playlist_id: None,
            },
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com\",\"username\":\"alice\"}"
                    .to_string(),
                label: "".to_string(),
                saved_playlist_id: None,
            },
        ];

        let sanitized = sanitize_recent_playlists_for_tests(entries);
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
                saved_playlist_id: None,
            },
            RecentPlaylistEntry {
                kind: RecentPlaylistKind::Xtream,
                value: "{\"server\":\"https://demo.example.com\",\"username\":\"alice\"}"
                    .to_string(),
                label: "".to_string(),
                saved_playlist_id: None,
            },
        ];

        let sanitized = sanitize_recent_playlists_for_tests(entries);
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
        assert_eq!(label, "demo.example.com:8080 (bob)");
    }
}
