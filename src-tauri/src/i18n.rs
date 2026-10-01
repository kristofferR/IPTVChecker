//! Native UI language: menus, tray, dialogs and notifications.
//!
//! The language is resolved once per launch from the `language` setting or the
//! system locale; changing it applies after a restart. The webview loads the
//! same locale through `get_ui_locale`, so both halves always agree.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::Manager;

/// Mirrors `LOCALES` in `src/i18n/index.ts`; each has `locales/<tag>.json`.
pub const SUPPORTED: &[&str] = &["en"];

fn catalog_source(locale: &str) -> Option<&'static str> {
    match locale {
        "en" => Some(include_str!("../locales/en.json")),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UiLocale {
    pub locale: &'static str,
    /// The `language` setting at launch, so the UI can tell a restart is pending.
    pub preference: Option<String>,
    /// The system's preferred locale, for regional date and number formats.
    pub system: Option<String>,
}

struct Launch {
    ui: UiLocale,
    messages: HashMap<String, String>,
    english: HashMap<String, String>,
}

static LAUNCH: OnceLock<Launch> = OnceLock::new();

fn parse(locale: &str) -> HashMap<String, String> {
    catalog_source(locale)
        .and_then(|source| serde_json::from_str(source).ok())
        .unwrap_or_default()
}

fn launch() -> &'static Launch {
    LAUNCH.get_or_init(|| start(None))
}

fn start(preference: Option<String>) -> Launch {
    let locale = resolve(preference.as_deref(), sys_locale::get_locales());
    Launch {
        ui: UiLocale {
            locale,
            preference,
            system: sys_locale::get_locale(),
        },
        messages: parse(locale),
        english: parse("en"),
    }
}

/// Fixes the launch locale from the persisted settings. Runs while the menu is
/// built, before plugins (including the settings store) are initialized.
pub fn init(app: &tauri::AppHandle) {
    let preference = persisted_language(app);
    LAUNCH.get_or_init(|| start(preference));
}

fn persisted_language(app: &tauri::AppHandle) -> Option<String> {
    // tauri-plugin-store keeps `settings.json` in the app data directory.
    let path = app.path().app_data_dir().ok()?.join("settings.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    value
        .get("settings")?
        .get("language")?
        .as_str()
        .map(str::to_owned)
}

pub fn ui_locale() -> UiLocale {
    launch().ui.clone()
}

/// The localized string for `key`, falling back to English, then to the key.
pub fn text(key: &str) -> String {
    let launch = launch();
    launch
        .messages
        .get(key)
        .or_else(|| launch.english.get(key))
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

/// Like [`text`], filling `{name}` placeholders.
pub fn text_with(key: &str, params: &[(&str, &str)]) -> String {
    params.iter().fold(text(key), |text, (name, value)| {
        text.replace(&format!("{{{name}}}"), value)
    })
}

fn resolve(preference: Option<&str>, system: impl IntoIterator<Item = String>) -> &'static str {
    preference
        .and_then(match_tag)
        .or_else(|| system.into_iter().find_map(|tag| match_tag(&tag)))
        .unwrap_or("en")
}

/// Maps a BCP 47 or POSIX locale (`pt_BR.UTF-8`, `zh-Hans-CN`) to a supported tag.
fn match_tag(tag: &str) -> Option<&'static str> {
    let tag = tag
        .split(['.', '@'])
        .next()?
        .replace('_', "-")
        .to_ascii_lowercase();
    let mut parts = tag.split('-');
    let language = parts.next()?;
    let wanted = match language {
        // Traditional Chinese readers are better served by the next preference.
        "zh" if tag.contains("hant") || parts.any(|part| matches!(part, "tw" | "hk" | "mo")) => {
            return None
        }
        "zh" => "zh-cn",
        "pt" => "pt-br",
        _ if SUPPORTED
            .iter()
            .any(|supported| supported.eq_ignore_ascii_case(&tag)) =>
        {
            tag.as_str()
        }
        _ => language,
    };
    SUPPORTED
        .iter()
        .copied()
        .find(|supported| supported.eq_ignore_ascii_case(wanted))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|tag| tag.to_string()).collect()
    }

    #[test]
    fn falls_back_to_english() {
        assert_eq!(resolve(None, system(&["xx-YY", "C"])), "en");
        assert_eq!(resolve(Some("xx"), Vec::new()), "en");
    }

    #[test]
    fn preference_wins_over_system() {
        assert_eq!(resolve(Some("en"), system(&["xx"])), "en");
    }

    #[test]
    fn matches_posix_and_regional_tags() {
        assert_eq!(match_tag("en_US.UTF-8"), Some("en"));
        assert_eq!(match_tag("en-GB"), Some("en"));
    }

    #[test]
    fn catalogs_parse_and_cover_english_keys() {
        let english = parse("en");
        assert!(!english.is_empty());
        for locale in SUPPORTED {
            let messages = parse(locale);
            assert!(
                !messages.is_empty(),
                "{locale} catalog is missing or invalid"
            );
            for key in messages.keys() {
                assert!(english.contains_key(key), "{locale} has unknown key {key}");
            }
        }
    }
}
