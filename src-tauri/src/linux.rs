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
