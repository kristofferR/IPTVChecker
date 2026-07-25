//! macOS in-place update from a verified `.dmg`.
//!
//! Tauri's stock macOS updater expects an `.app.tar.gz` payload. IPTV Checker
//! publishes only the user-facing `.dmg` (which is the artifact that gets
//! notarized and stapled), so the release workflow points `latest.json` at the
//! `.dmg` and this module performs the install: mount, copy the bundle over the
//! running one, then relaunch. Tauri still does the download and minisign
//! verification, so the bytes handed to `install_dmg` are already trusted.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const APP_BUNDLE_NAME: &str = "IPTV Checker.app";

/// Unmounts on drop so an early return can't leave the DMG attached.
struct MountedDmg {
    mountpoint: PathBuf,
}

impl Drop for MountedDmg {
    fn drop(&mut self) {
        let _ = Command::new("hdiutil")
            .arg("detach")
            .arg(&self.mountpoint)
            .arg("-quiet")
            .status();
    }
}

/// Writes the verified DMG to a scratch directory, mounts it, and replaces the
/// running `.app` with the one inside. Returns the path that was replaced.
pub fn install_dmg(bytes: &[u8]) -> Result<PathBuf, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let work_dir = std::env::temp_dir().join(format!(
        "iptv-checker-update-{}-{nonce}",
        std::process::id()
    ));

    let result = (|| {
        // create_dir, not create_dir_all: an existing directory or symlink at
        // this path must not be silently reused, since whatever .app is found
        // under it gets copied over the installed bundle, possibly as admin.
        fs::create_dir(&work_dir).map_err(|e| e.to_string())?;
        let dmg_path = work_dir.join("IPTV-Checker-update.dmg");
        fs::write(&dmg_path, bytes).map_err(|e| e.to_string())?;

        let mountpoint = work_dir.join("mount");
        fs::create_dir(&mountpoint).map_err(|e| e.to_string())?;
        let mut attach = Command::new("hdiutil");
        attach
            .arg("attach")
            .arg("-nobrowse")
            .arg("-readonly")
            .arg("-mountpoint")
            .arg(&mountpoint)
            .arg(&dmg_path);
        run_command(&mut attach)?;
        let _mounted = MountedDmg {
            mountpoint: mountpoint.clone(),
        };

        let source_app = find_app_bundle(&mountpoint)?;
        let destination_app = current_app_bundle()?;
        replace_app_bundle(&source_app, &destination_app, &work_dir)?;
        Ok(destination_app)
    })();

    let _ = std::fs::remove_dir_all(&work_dir);
    result
}

// Waits for the old process to exit before reopening, so LaunchServices doesn't
// find the bundle mid-replacement. The wait is capped at ~60s so a process that
// hangs on quit leaves the new version openable instead of an immortal poller.
const RELAUNCH_SCRIPT: &str = "i=0; while [ \"$i\" -lt 600 ] && kill -0 \"$1\" 2>/dev/null; \
     do sleep 0.1; i=$((i+1)); done; exec /usr/bin/open -n \"$2\"";

fn relaunch_command(pid: u32, installed_app: &Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(RELAUNCH_SCRIPT)
        .arg("iptv-checker-update-relaunch")
        .arg(pid.to_string())
        .arg(installed_app);
    command
}

/// Spawns the detached helper that reopens the app once this process exits.
/// Call this *before* exiting: `AppHandle::restart` resolves the running
/// executable after its bundle has been moved aside, so it would quit without
/// reopening.
pub fn schedule_relaunch(installed_app: &Path) -> Result<(), String> {
    relaunch_command(std::process::id(), installed_app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            format!("Could not schedule IPTV Checker to reopen after the update: {error}")
        })
}

/// The `.app` bundle this process is running from.
pub fn current_app_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    for ancestor in exe.ancestors() {
        if ancestor.extension().is_some_and(|ext| ext == "app") {
            return Ok(ancestor.to_path_buf());
        }
    }
    Err("Could not locate the running .app bundle.".into())
}

fn find_app_bundle(mountpoint: &Path) -> Result<PathBuf, String> {
    let mut fallback = None;
    for entry in std::fs::read_dir(mountpoint).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "app") {
            if path.file_name().is_some_and(|name| name == APP_BUNDLE_NAME) {
                return Ok(path);
            }
            fallback = Some(path);
        }
    }
    fallback.ok_or_else(|| "The update DMG did not contain an app bundle.".into())
}

fn replace_app_bundle(
    source_app: &Path,
    destination_app: &Path,
    work_dir: &Path,
) -> Result<(), String> {
    let backup_dir = work_dir.join("backup");
    std::fs::create_dir(&backup_dir).map_err(|e| e.to_string())?;
    let backup_app = backup_dir.join(APP_BUNDLE_NAME);

    match std::fs::rename(destination_app, &backup_app) {
        Ok(()) => {
            if let Err(err) = ditto(source_app, destination_app) {
                let _ = std::fs::remove_dir_all(destination_app);
                let _ = std::fs::rename(&backup_app, destination_app);
                return Err(err);
            }
        }
        // PermissionDenied: the destination needs an admin copy. CrossesDevices:
        // the app lives on a different volume from the scratch dir, so it cannot
        // be renamed aside at all. Both fall back to the copy-based install.
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::CrossesDevices
            ) =>
        {
            install_with_admin_privileges(source_app, destination_app)?;
        }
        Err(err) => return Err(err.to_string()),
    }

    // Refresh the bundle's mtime so LaunchServices re-reads its Info.plist.
    let _ = Command::new("touch").arg(destination_app).status();
    Ok(())
}

fn ditto(source: &Path, destination: &Path) -> Result<(), String> {
    let mut command = Command::new("ditto");
    command.arg(source).arg(destination);
    run_command(&mut command)
}

fn install_with_admin_privileges(source_app: &Path, destination_app: &Path) -> Result<(), String> {
    // Back up the current bundle to a sibling path (same volume, so the move is
    // atomic) before overwriting, and restore it if `ditto` fails — otherwise a
    // failed privileged copy (disk full, interrupted read) would leave the user
    // with no app at all. This mirrors the rename/rollback the non-privileged
    // branch does, and the whole sequence runs inside one privileged shell so
    // the rollback is itself privileged.
    let script = format!(
        concat!(
            "do shell script \"",
            "rm -rf \" & quoted form of {backup} & \" ; ",
            "mv \" & quoted form of {destination} & \" \" & quoted form of {backup} & \" || exit 1 ; ",
            "if ditto \" & quoted form of {source} & \" \" & quoted form of {destination} & \" ; ",
            "then rm -rf \" & quoted form of {backup} & \" ; ",
            "else rm -rf \" & quoted form of {destination} & \" ; ",
            "mv \" & quoted form of {backup} & \" \" & quoted form of {destination} & \" ; exit 1 ; fi",
            "\" with administrator privileges"
        ),
        source = applescript_string(&source_app.display().to_string()),
        destination = applescript_string(&destination_app.display().to_string()),
        backup = applescript_string(&format!("{}.iptv-checker-backup", destination_app.display())),
    );
    let mut command = Command::new("osascript");
    command.arg("-e").arg(script);
    run_command(&mut command)
}

fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn run_command(command: &mut Command) -> Result<(), String> {
    let program = command.get_program().to_string_lossy().into_owned();
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let details = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(format!("{program} failed: {details}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_string_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_string(r#"/a "b"\c"#), r#""/a \"b\"\\c""#);
    }

    #[test]
    fn relaunch_command_waits_for_the_old_pid_then_opens_the_bundle() {
        let command = relaunch_command(4321, Path::new("/Applications/IPTV Checker.app"));
        let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy()).collect();
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], RELAUNCH_SCRIPT);
        assert_eq!(args[3], "4321");
        assert_eq!(args[4], "/Applications/IPTV Checker.app");
    }
}
