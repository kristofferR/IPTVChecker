use crate::models::settings::{AppSettings, TitleBarPreference};

/// Whether the main window keeps its title bar. `Show`/`Hide` are explicit;
/// `Auto` hides it under a tiling window manager (where the compositor
/// moves/closes windows and the GTK header bar is dead weight) and keeps it
/// on floating desktops, where it is also how you drag and close the window.
pub fn show_title_bar(settings: &AppSettings) -> bool {
    match settings.title_bar {
        TitleBarPreference::Show => true,
        TitleBarPreference::Hide => false,
        TitleBarPreference::Auto => !is_tiling_wm(),
    }
}

/// Best-effort "is this session a tiling window manager?". Nothing in X11 or
/// Wayland lets a client ask, so match the session's advertised desktop
/// identifiers against the well-known tilers. Drives the `Auto` title-bar
/// default; Settings → Title bar overrides it either way.
pub fn is_tiling_wm() -> bool {
    static TILING: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TILING.get_or_init(|| {
        [
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_DESKTOP",
            "DESKTOP_SESSION",
        ]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .any(|value| is_tiling_desktop(&value))
    })
}

/// True when a desktop identifier (possibly colon-separated, as in
/// XDG_CURRENT_DESKTOP) names a window manager that tiles by default.
fn is_tiling_desktop(value: &str) -> bool {
    const TILERS: &[&str] = &[
        "hyprland",
        "sway",
        "swayfx",
        "i3",
        "i3wm",
        "river",
        "niri",
        "bspwm",
        "dwm",
        "dwl",
        "qtile",
        "awesome",
        "xmonad",
        "herbstluftwm",
        "leftwm",
        "spectrwm",
        "wmii",
        "ratpoison",
        "stumpwm",
    ];
    value
        .split(':')
        .map(|segment| segment.trim().to_ascii_lowercase())
        .any(|segment| TILERS.contains(&segment.as_str()))
}

/// NVIDIA's proprietary driver gained Wayland explicit sync in 555; before
/// that, WebKit's DMA-BUF renderer could paint blank, black or garbled frames.
/// `version` is `/sys/module/nvidia/version`, which is `None` for every other
/// GPU vendor (AMD, Intel, nouveau). Only a major version that parses and is
/// below 555 counts as old.
pub fn nvidia_driver_predates_explicit_sync(version: Option<&str>) -> bool {
    version
        .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major < 555)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiling_desktops_are_recognized_per_segment_case_insensitively() {
        assert!(is_tiling_desktop("Hyprland"));
        assert!(is_tiling_desktop("sway"));
        assert!(is_tiling_desktop("niri"));
        assert!(is_tiling_desktop("i3"));
        assert!(is_tiling_desktop("wlroots:Sway"));
        assert!(!is_tiling_desktop("GNOME"));
        assert!(!is_tiling_desktop("KDE"));
        assert!(!is_tiling_desktop("ubuntu:GNOME"));
        assert!(!is_tiling_desktop("XFCE"));
        assert!(!is_tiling_desktop(""));
        // Substrings must not match — only whole identifiers.
        assert!(!is_tiling_desktop("swayed"));
    }

    #[test]
    fn only_nvidia_drivers_before_explicit_sync_count_as_old() {
        for old in ["550.144.03", "470.256.02\n"] {
            assert!(nvidia_driver_predates_explicit_sync(Some(old)), "{old:?}");
        }
        for other in ["555.42.02", "615.78.08\n", "", "garbage"] {
            assert!(
                !nvidia_driver_predates_explicit_sync(Some(other)),
                "{other:?}"
            );
        }
        assert!(!nvidia_driver_predates_explicit_sync(None));
    }

    #[test]
    fn explicit_preference_overrides_detection() {
        let show = AppSettings {
            title_bar: TitleBarPreference::Show,
            ..AppSettings::default()
        };
        assert!(show_title_bar(&show));

        let hide = AppSettings {
            title_bar: TitleBarPreference::Hide,
            ..AppSettings::default()
        };
        assert!(!show_title_bar(&hide));
    }
}
