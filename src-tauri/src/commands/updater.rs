//! Signed in-app updates.
//!
//! Discovery is deliberately separate from installation: a check never
//! downloads or replaces anything, so the UI can ask for explicit confirmation
//! before an update swaps out the running application and restarts it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::AppError;
use crate::state::AppState;

const AUTOMATIC_UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Consumed by `hooks/useUpdateCheck.ts`.
const UPDATE_AVAILABLE_EVENT: &str = "updater://update-available";
const RELEASES_URL: &str = "https://github.com/kristofferR/IPTVChecker/releases/latest";
#[cfg(target_os = "linux")]
const AUR_PACKAGE_URL: &str = "https://aur.archlinux.org/packages/iptv-checker-gui";

/// How this particular installation receives updates.
///
/// Each variant besides `SelfUpdatable` is constructed on exactly one OS, so
/// every target build leaves at least one unconstructed — hence the blanket
/// allow rather than a per-platform one. The enum stays platform-independent so
/// the mapping to install modes is unit-testable everywhere, and the tests do
/// exercise every variant.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallSource {
    /// The app can replace itself: macOS `.app`, an installed Windows copy, or
    /// a Linux AppImage.
    SelfUpdatable,
    /// Installed from the AUR, so pacman owns the files.
    Aur,
    /// Installed from the `.deb`/`.rpm`, owned by apt/dnf. Tauri's updater only
    /// supports AppImage on Linux, so it cannot install these either.
    SystemPackage,
    /// The Windows portable `.zip`. Tauri would run the NSIS installer, which
    /// updates a *separate* installed copy and leaves the portable executable
    /// the user launched untouched — so it must not be offered.
    WindowsPortable,
    /// A macOS bundle running from a read-only volume: straight from the
    /// mounted `.dmg`, or from an App Translocation path. The bundle cannot be
    /// replaced in place, and elevating to admin cannot make the mount
    /// writable, so the install would always fail.
    MacosReadOnly,
}

impl InstallSource {
    fn manual_url(self) -> Option<&'static str> {
        match self {
            Self::SelfUpdatable => None,
            #[cfg(target_os = "linux")]
            Self::Aur => Some(AUR_PACKAGE_URL),
            #[cfg(not(target_os = "linux"))]
            Self::Aur => Some(RELEASES_URL),
            Self::SystemPackage | Self::WindowsPortable | Self::MacosReadOnly => Some(RELEASES_URL),
        }
    }
}

/// The install affordance the UI should offer. `button_label` and
/// `instructions` are only set for installations that must be updated by their
/// own package manager.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallMode {
    kind: UpdateInstallKind,
    button_label: Option<String>,
    instructions: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum UpdateInstallKind {
    BuiltIn,
    Manual,
}

impl UpdateInstallMode {
    fn from_source(source: InstallSource, has_paru: bool, has_yay: bool) -> Self {
        match source {
            InstallSource::SelfUpdatable => Self {
                kind: UpdateInstallKind::BuiltIn,
                button_label: None,
                instructions: None,
            },
            InstallSource::Aur => {
                let instructions = if has_paru {
                    "Run paru -S iptv-checker-gui to update."
                } else if has_yay {
                    "Run yay -S iptv-checker-gui to update."
                } else {
                    "Update the iptv-checker-gui package with your AUR helper."
                };
                Self {
                    kind: UpdateInstallKind::Manual,
                    button_label: Some("Open IPTV Checker on AUR".into()),
                    instructions: Some(instructions.into()),
                }
            }
            InstallSource::SystemPackage => Self {
                kind: UpdateInstallKind::Manual,
                button_label: Some("Open the releases page".into()),
                instructions: Some(
                    "This copy was installed from a system package. Download the new \
                     .deb/.rpm and install it with your package manager."
                        .into(),
                ),
            },
            InstallSource::MacosReadOnly => Self {
                kind: UpdateInstallKind::Manual,
                button_label: Some("Open the releases page".into()),
                instructions: Some(
                    "IPTV Checker is running from a read-only volume. Drag it to your \
                     Applications folder and reopen it to enable in-app updates."
                        .into(),
                ),
            },
            InstallSource::WindowsPortable => Self {
                kind: UpdateInstallKind::Manual,
                button_label: Some("Open the releases page".into()),
                instructions: Some(
                    "This is the portable build. Download the new portable .zip and \
                     replace this copy."
                        .into(),
                ),
            },
        }
    }

    fn is_manual(&self) -> bool {
        self.kind == UpdateInstallKind::Manual
    }
}

#[cfg(target_os = "linux")]
fn command_available(program: &str) -> bool {
    std::process::Command::new(program)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(target_os = "linux")]
fn pacman_owns_current_executable() -> bool {
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    std::process::Command::new("pacman")
        .arg("-Qo")
        .arg(executable)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// AUR packages reuse the signed `.deb` payload but are owned by pacman, so
/// letting Tauri run `dpkg` would fail and would bypass pacman's ownership
/// database if forced. Everything that is not a running AppImage is likewise
/// owned by a system package manager — Tauri's Linux updater only knows how to
/// replace an AppImage.
#[cfg(any(target_os = "linux", test))]
fn linux_install_source(pacman_owned: bool, running_as_appimage: bool) -> InstallSource {
    if pacman_owned {
        InstallSource::Aur
    } else if running_as_appimage {
        InstallSource::SelfUpdatable
    } else {
        InstallSource::SystemPackage
    }
}

/// Tauri's NSIS installer writes `uninstall.exe` next to the app executable
/// (`WriteUninstaller "$INSTDIR\uninstall.exe"`), while the portable `.zip`
/// ships only the app and its ffmpeg sidecars — so the marker distinguishes an
/// installed copy from a portable one.
#[cfg(any(target_os = "windows", test))]
fn windows_install_source(has_uninstaller: bool) -> InstallSource {
    if has_uninstaller {
        InstallSource::SelfUpdatable
    } else {
        InstallSource::WindowsPortable
    }
}

#[cfg(target_os = "windows")]
fn uninstaller_beside_current_exe() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe")))
        .is_some_and(|marker| marker.is_file())
}

/// True when the running `.app` sits on a read-only mount. Distinguishes the
/// DMG/translocation case from an ordinary permission problem on
/// `/Applications`, which the privileged copy path does handle.
#[cfg(any(target_os = "macos", test))]
fn macos_install_source(on_read_only_volume: bool) -> InstallSource {
    if on_read_only_volume {
        InstallSource::MacosReadOnly
    } else {
        InstallSource::SelfUpdatable
    }
}

#[cfg(target_os = "macos")]
fn current_bundle_on_read_only_volume() -> bool {
    let Ok(bundle) = crate::engine::macos_dmg_update::current_app_bundle() else {
        // Not running from a bundle at all (e.g. `cargo run`); nothing to guard.
        return false;
    };
    let Ok(path) = std::ffi::CString::new(bundle.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut stat) } != 0 {
        return false;
    }
    stat.f_flags & libc::MNT_RDONLY as u32 != 0
}

fn current_install_source() -> InstallSource {
    #[cfg(target_os = "linux")]
    {
        linux_install_source(
            pacman_owns_current_executable(),
            std::env::var_os("APPIMAGE").is_some(),
        )
    }

    #[cfg(target_os = "windows")]
    {
        windows_install_source(uninstaller_beside_current_exe())
    }

    #[cfg(target_os = "macos")]
    {
        macos_install_source(current_bundle_on_read_only_volume())
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        InstallSource::SelfUpdatable
    }
}

fn current_install_mode() -> UpdateInstallMode {
    let source = current_install_source();
    let is_aur = source == InstallSource::Aur;
    #[cfg(target_os = "linux")]
    {
        UpdateInstallMode::from_source(
            source,
            is_aur && command_available("paru"),
            is_aur && command_available("yay"),
        )
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = is_aur;
        UpdateInstallMode::from_source(source, false, false)
    }
}

/// Detection shells out to pacman on Linux and stats the install directory on
/// Windows, so keep it off the async runtime thread on both.
async fn current_install_source_off_main() -> Result<InstallSource, AppError> {
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(current_install_source)
            .await
            .map_err(|error| AppError::Other(format!("install source worker failed: {error}")))
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Ok(current_install_source())
    }
}

async fn current_install_mode_off_main() -> Result<UpdateInstallMode, AppError> {
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(current_install_mode)
            .await
            .map_err(|error| AppError::Other(format!("update install mode worker failed: {error}")))
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Ok(current_install_mode())
    }
}

async fn available_update_unlocked(app: &AppHandle) -> Result<Option<Update>, AppError> {
    let updater = app
        .updater()
        .map_err(|e| AppError::Other(format!("updater unavailable: {e}")))?;
    updater
        .check()
        .await
        .map_err(|e| AppError::Other(format!("update check failed: {e}")))
}

async fn available_update(app: &AppHandle) -> Result<Option<Update>, AppError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let _operation_guard = state.update_checking.lock().await;
    available_update_unlocked(app).await
}

fn should_surface_update(remembered: Option<&str>, discovered: Option<&str>) -> bool {
    discovered.is_some() && remembered != discovered
}

/// Stores the discovery and reports whether it is new (so a background check
/// only notifies once per version).
async fn remember_available_update(app: &AppHandle, update: Option<Update>) -> bool {
    let state = app.state::<std::sync::Arc<AppState>>();
    let mut remembered = state.update_available.lock().await;
    let is_new = should_surface_update(
        remembered.as_ref().map(|update| update.version.as_str()),
        update.as_ref().map(|update| update.version.as_str()),
    );
    *remembered = update;
    is_new
}

/// Rejects a second install immediately rather than letting it queue.
struct UpdateInstallGuard<'a>(&'a AtomicBool);

impl<'a> UpdateInstallGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self, AppError> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self(flag))
            .map_err(|_| AppError::State("An update install is already in progress.".into()))
    }
}

impl Drop for UpdateInstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Result of a discovery request. `version` is `None` when already up to date.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub version: Option<String>,
    pub notes: Option<String>,
}

/// Check for a newer signed release without downloading or installing anything.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, AppError> {
    if app
        .state::<std::sync::Arc<AppState>>()
        .update_installing
        .load(Ordering::Acquire)
    {
        return Err(AppError::State(
            "An update install is already in progress.".into(),
        ));
    }

    let update = available_update(&app).await?;
    let result = UpdateCheckResult {
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()),
    };
    remember_available_update(&app, update).await;
    Ok(result)
}

/// The version found by the last check, without another network request. Lets
/// the UI label its update control as soon as it opens.
#[tauri::command]
pub async fn discovered_update(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<Option<String>, AppError> {
    Ok(state
        .update_available
        .lock()
        .await
        .as_ref()
        .map(|update| update.version.clone()))
}

/// Whether this installation can safely replace itself.
#[tauri::command]
pub async fn update_install_mode() -> Result<UpdateInstallMode, AppError> {
    current_install_mode_off_main().await
}

/// Open the distribution-owned update page for installations that must stay
/// under their system package manager. The URL is resolved here rather than
/// accepted from the webview.
#[tauri::command]
pub async fn open_manual_update(app: AppHandle) -> Result<(), AppError> {
    // One detection for both the check and the URL: re-deriving the URL would
    // run pacman again, and directly on the async runtime thread.
    let Some(url) = current_install_source_off_main().await?.manual_url() else {
        return Err(AppError::Validation(
            "This installation supports built-in updates.".into(),
        ));
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Other(format!("could not open {url}: {e}")))
}

async fn remembered_or_latest_update(app: &AppHandle) -> Result<Option<Update>, AppError> {
    let remembered = app
        .state::<std::sync::Arc<AppState>>()
        .update_available
        .lock()
        .await
        .clone();
    match remembered {
        Some(update) => Ok(Some(update)),
        None => available_update_unlocked(app).await,
    }
}

/// Download and install the discovered update. The caller is responsible for
/// having obtained explicit confirmation first.
#[cfg(not(target_os = "macos"))]
async fn run_update_install(app: &AppHandle) -> Result<bool, AppError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    // Hold discovery out for the whole download/install. The atomic guard has
    // already rejected any second install, so nothing waits here for long.
    let _operation_guard = state.update_checking.lock().await;
    match remembered_or_latest_update(app).await? {
        Some(update) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| AppError::Other(format!("update install failed: {e}")))?;
            app.restart();
        }
        None => Ok(false),
    }
}

/// Download the verified `.dmg` and install it. See `engine::macos_dmg_update`
/// for why macOS does not use Tauri's stock installer.
#[cfg(target_os = "macos")]
async fn run_update_install(app: &AppHandle) -> Result<bool, AppError> {
    use crate::engine::macos_dmg_update;

    let state = app.state::<std::sync::Arc<AppState>>();
    let _operation_guard = state.update_checking.lock().await;
    match remembered_or_latest_update(app).await? {
        Some(update) => {
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| AppError::Other(format!("update download failed: {e}")))?;
            let installed_app = tauri::async_runtime::spawn_blocking(move || {
                let installed = macos_dmg_update::install_dmg(&bytes)?;
                macos_dmg_update::schedule_relaunch(&installed)?;
                Ok::<_, String>(installed)
            })
            .await
            .map_err(|e| AppError::Other(format!("update install worker failed: {e}")))?
            .map_err(AppError::Other)?;
            log::info!("installed update into {}", installed_app.display());
            // `app.restart()` resolves the running executable after its bundle
            // has been moved aside, so it would exit without reopening. The
            // detached helper scheduled above waits for this process to
            // disappear and then reopens the new bundle.
            app.exit(0);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Install the discovered update and restart. Returns `false` if there was
/// nothing to install after all.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<bool, AppError> {
    if let Some(instructions) = current_install_mode_off_main().await?.instructions {
        return Err(AppError::Validation(instructions));
    }
    let _guard = UpdateInstallGuard::acquire(&state.update_installing)?;
    let result = run_update_install(&app).await;
    if let Err(error) = &result {
        log::warn!("update install failed: {error}");
    }
    result
}

async fn run_automatic_update_check(app: &AppHandle) {
    let state = app.state::<std::sync::Arc<AppState>>();
    if state.update_installing.load(Ordering::Acquire) {
        return;
    }

    match available_update(app).await {
        Ok(Some(update)) => {
            // The preference may have been switched off, or an install may have
            // started, while the request was in flight. Honour both before
            // showing anything.
            if state.update_installing.load(Ordering::Acquire)
                || !state.settings.lock().await.automatic_update_checks
            {
                return;
            }
            let version = update.version.clone();
            if remember_available_update(app, Some(update)).await {
                // Surface it in the running window immediately; the frontend
                // otherwise only learns about updates when the user checks.
                if let Err(error) = app.emit(UPDATE_AVAILABLE_EVENT, version.clone()) {
                    log::warn!("failed to emit {UPDATE_AVAILABLE_EVENT}: {error}");
                }
                let body = match current_install_mode_off_main().await {
                    Ok(mode) if mode.is_manual() => format!(
                        "IPTV Checker {version} is available. Open Settings for \
                         package-manager instructions."
                    ),
                    Ok(_) => format!(
                        "IPTV Checker {version} is available. Open Settings to review and \
                         install it."
                    ),
                    Err(error) => {
                        log::warn!("failed to detect the update install mode: {error}");
                        format!("IPTV Checker {version} is available.")
                    }
                };
                if let Err(error) = app
                    .notification()
                    .builder()
                    .title("IPTV Checker update available")
                    .body(body)
                    .show()
                {
                    log::warn!("failed to surface available update: {error}");
                }
            }
        }
        Ok(None) => {
            remember_available_update(app, None).await;
        }
        Err(error) => {
            // Discovery is best-effort and must never interrupt a scan or
            // startup. Manual checks still return their errors to the UI.
            log::warn!("automatic update check failed: {error}");
        }
    }
}

/// Check once at startup, then every six hours while the preference is on.
/// Enabling the preference wakes the loop instead of waiting for the next tick.
pub fn spawn_automatic_update_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<std::sync::Arc<AppState>>();
            let enabled = state.settings.lock().await.automatic_update_checks;
            if enabled {
                run_automatic_update_check(&app).await;
            }

            let _ = tokio::time::timeout(
                AUTOMATIC_UPDATE_INTERVAL,
                state.update_check_wake.notified(),
            )
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_installs_update_themselves() {
        assert_eq!(
            linux_install_source(false, true),
            InstallSource::SelfUpdatable
        );
    }

    #[test]
    fn pacman_owned_installs_defer_to_the_aur() {
        assert_eq!(linux_install_source(true, false), InstallSource::Aur);
        // An AUR helper that runs the AppImage would still be pacman-owned.
        assert_eq!(linux_install_source(true, true), InstallSource::Aur);
    }

    #[test]
    fn windows_portable_copies_are_manual() {
        // Tauri would run the NSIS installer, updating a separate installed
        // copy while the running portable .exe stays on the old version.
        let portable = windows_install_source(false);
        assert_eq!(portable, InstallSource::WindowsPortable);
        let mode = UpdateInstallMode::from_source(portable, false, false);
        assert!(mode.is_manual());
        assert_eq!(portable.manual_url(), Some(RELEASES_URL));
    }

    #[test]
    fn macos_bundles_on_read_only_volumes_are_manual() {
        // Running from the mounted .dmg or a translocated path: elevating to
        // admin cannot make the mount writable, so the install would fail.
        let mounted = macos_install_source(true);
        assert_eq!(mounted, InstallSource::MacosReadOnly);
        assert!(UpdateInstallMode::from_source(mounted, false, false).is_manual());
        assert_eq!(mounted.manual_url(), Some(RELEASES_URL));

        // A normal /Applications install is writable-or-elevatable.
        assert_eq!(macos_install_source(false), InstallSource::SelfUpdatable);
    }

    #[test]
    fn installed_windows_copies_update_themselves() {
        // uninstall.exe beside the executable is written only by the installer.
        assert_eq!(windows_install_source(true), InstallSource::SelfUpdatable);
    }

    #[test]
    fn deb_and_rpm_installs_are_manual() {
        // Tauri's Linux updater only replaces AppImages, so a non-AppImage,
        // non-pacman install must never offer the built-in path.
        let source = linux_install_source(false, false);
        assert_eq!(source, InstallSource::SystemPackage);
        assert!(UpdateInstallMode::from_source(source, false, false).is_manual());
        assert_eq!(source.manual_url(), Some(RELEASES_URL));
    }

    #[test]
    fn aur_instructions_name_the_available_helper() {
        let paru = UpdateInstallMode::from_source(InstallSource::Aur, true, true);
        assert_eq!(
            paru.instructions.as_deref(),
            Some("Run paru -S iptv-checker-gui to update.")
        );
        let yay = UpdateInstallMode::from_source(InstallSource::Aur, false, true);
        assert_eq!(
            yay.instructions.as_deref(),
            Some("Run yay -S iptv-checker-gui to update.")
        );
        let neither = UpdateInstallMode::from_source(InstallSource::Aur, false, false);
        assert_eq!(
            neither.instructions.as_deref(),
            Some("Update the iptv-checker-gui package with your AUR helper.")
        );
    }

    #[test]
    fn built_in_mode_carries_no_manual_copy() {
        let mode = UpdateInstallMode::from_source(InstallSource::SelfUpdatable, true, true);
        assert!(!mode.is_manual());
        assert!(mode.button_label.is_none());
        assert!(mode.instructions.is_none());
        assert!(InstallSource::SelfUpdatable.manual_url().is_none());
    }

    #[test]
    fn only_a_changed_version_is_surfaced_again() {
        assert!(should_surface_update(None, Some("1.7.0")));
        assert!(should_surface_update(Some("1.6.0"), Some("1.7.0")));
        assert!(!should_surface_update(Some("1.7.0"), Some("1.7.0")));
        // Going back to "up to date" must not raise a notification.
        assert!(!should_surface_update(Some("1.7.0"), None));
        assert!(!should_surface_update(None, None));
    }

    #[test]
    fn install_guard_rejects_a_concurrent_install() {
        let flag = AtomicBool::new(false);
        let first = UpdateInstallGuard::acquire(&flag).expect("first install should start");
        assert!(UpdateInstallGuard::acquire(&flag).is_err());
        drop(first);
        assert!(UpdateInstallGuard::acquire(&flag).is_ok());
    }
}
