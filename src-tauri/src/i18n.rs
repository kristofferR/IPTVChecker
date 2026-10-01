//! Native UI language: menus, tray, dialogs and notifications.
//!
//! The language comes from the `language` setting once per launch (English
//! until the user picks one); changing it applies after a restart. The webview
//! loads the same locale through `get_ui_locale`, so both halves always agree.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;

/// Mirrors `LOCALES` in `src/i18n/index.ts`; each has `locales/<tag>.json`.
pub const SUPPORTED: &[&str] = &[
    "en", "zh-CN", "ru", "es", "uk", "pt-BR", "tr", "fr", "de", "it", "pl", "vi", "id",
];

fn catalog_source(locale: &str) -> Option<&'static str> {
    match locale {
        "en" => Some(include_str!("../locales/en.json")),
        "zh-CN" => Some(include_str!("../locales/zh-CN.json")),
        "ru" => Some(include_str!("../locales/ru.json")),
        "es" => Some(include_str!("../locales/es.json")),
        "uk" => Some(include_str!("../locales/uk.json")),
        "pt-BR" => Some(include_str!("../locales/pt-BR.json")),
        "tr" => Some(include_str!("../locales/tr.json")),
        "fr" => Some(include_str!("../locales/fr.json")),
        "de" => Some(include_str!("../locales/de.json")),
        "it" => Some(include_str!("../locales/it.json")),
        "pl" => Some(include_str!("../locales/pl.json")),
        "vi" => Some(include_str!("../locales/vi.json")),
        "id" => Some(include_str!("../locales/id.json")),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UiLocale {
    pub locale: &'static str,
    /// A supported system language to offer when none has been chosen yet.
    pub suggested: Option<&'static str>,
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
    let locale = preference.as_deref().and_then(match_tag).unwrap_or("en");
    let suggested = preference
        .is_none()
        .then(|| suggest(sys_locale::get_locales()))
        .flatten();
    Launch {
        ui: UiLocale {
            locale,
            suggested,
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
    // `app.path()` isn't managed yet while the menu builds, so resolve it the
    // way Tauri does.
    let path = dirs::data_dir()?
        .join(&app.config().identifier)
        .join("settings.json");
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

/// The first supported system language, unless that is English already.
fn suggest(system: impl IntoIterator<Item = String>) -> Option<&'static str> {
    system
        .into_iter()
        .find_map(|tag| match_tag(&tag))
        .filter(|locale| *locale != "en")
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
    fn suggests_supported_non_english_system_languages() {
        assert_eq!(suggest(system(&["xx-YY", "C"])), None);
        assert_eq!(suggest(system(&["en-US", "de-DE"])), None);
        assert_eq!(suggest(system(&["nb-NO", "de-DE"])), Some("de"));
    }

    #[test]
    fn matches_posix_and_regional_tags() {
        assert_eq!(match_tag("en_US.UTF-8"), Some("en"));
        assert_eq!(match_tag("en-GB"), Some("en"));
    }

    #[test]
    fn catalogs_match_english_keys() {
        let english = parse("en");
        assert!(!english.is_empty());
        let mut expected: Vec<_> = english.keys().collect();
        expected.sort();
        for locale in SUPPORTED {
            let messages = parse(locale);
            let mut keys: Vec<_> = messages.keys().collect();
            keys.sort();
            assert_eq!(keys, expected, "{locale} catalog keys differ from English");
        }
    }

    #[test]
    fn matches_supported_languages() {
        assert_eq!(match_tag("de-AT"), Some("de"));
        assert_eq!(match_tag("pt_PT.UTF-8"), Some("pt-BR"));
        assert_eq!(match_tag("zh-Hans-CN"), Some("zh-CN"));
        assert_eq!(match_tag("zh-TW"), None);
        assert_eq!(match_tag("zh-Hant"), None);
        assert_eq!(suggest(system(&["zh-HK", "uk-UA"])), Some("uk"));
    }
}
