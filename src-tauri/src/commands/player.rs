use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::error::AppError;

static NEXT_TEMP_PLAYLIST_ID: AtomicU64 = AtomicU64::new(0);
const TEMP_PLAYLIST_PREFIX: &str = "iptv-checker-single-channel-";
const TEMP_PLAYLIST_EXTENSION: &str = "m3u8";
const TEMP_PLAYLIST_DELETE_DELAY: std::time::Duration = std::time::Duration::from_secs(120);
const STALE_TEMP_PLAYLIST_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Deserialize)]
pub struct PlayerChannel {
    pub extinf_line: String,
    pub metadata_lines: Vec<String>,
    pub url: String,
}

fn open_with_system_default(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(AppError::Io)?;

    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open")
        .arg(path)
        .status()
        .map_err(AppError::Io)?;

    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .status()
        .map_err(AppError::Io)?;

    if status.success() {
        Ok(())
    } else {
        Err(AppError::Other(
            "Failed to open playlist with system default player".to_string(),
        ))
    }
}

fn write_unique_temp_playlist(content: &str) -> Result<PathBuf, AppError> {
    write_unique_temp_playlist_in_dir(&std::env::temp_dir(), content)
}

fn write_unique_temp_playlist_in_dir(temp_dir: &Path, content: &str) -> Result<PathBuf, AppError> {
    for _ in 0..16 {
        let path = build_unique_temp_playlist_path(temp_dir);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(content.as_bytes()).map_err(AppError::Io)?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::Io(error)),
        }
    }

    Err(AppError::Other(
        "Failed to create a unique temporary playlist file".to_string(),
    ))
}

fn build_unique_temp_playlist_path(temp_dir: &Path) -> PathBuf {
    let pid = std::process::id();
    let unix_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_TEMP_PLAYLIST_ID.fetch_add(1, Ordering::Relaxed);

    temp_dir.join(format!(
        "{TEMP_PLAYLIST_PREFIX}{pid}-{unix_nanos}-{sequence}.{TEMP_PLAYLIST_EXTENSION}"
    ))
}

fn is_temp_playlist_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    file_name.starts_with(TEMP_PLAYLIST_PREFIX) && extension == TEMP_PLAYLIST_EXTENSION
}

fn cleanup_stale_temp_playlists_in_dir(
    temp_dir: &Path,
    max_age: std::time::Duration,
    now: SystemTime,
) {
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_temp_playlist_file(&path) {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= max_age {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn spawn_temp_playlist_cleanup(
    path: PathBuf,
    delay: std::time::Duration,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let _ = std::fs::remove_file(path);
    })
}

#[tauri::command]
pub async fn open_channel_in_player(channel: PlayerChannel) -> Result<(), AppError> {
    let mut content = String::from("#EXTM3U\n");
    content.push_str(channel.extinf_line.trim_end());
    content.push('\n');

    for metadata in &channel.metadata_lines {
        let line = metadata.trim_end();
        if !line.is_empty() {
            content.push_str(line);
            content.push('\n');
        }
    }

    content.push_str(channel.url.trim());
    content.push('\n');

    let temp_dir = std::env::temp_dir();
    cleanup_stale_temp_playlists_in_dir(&temp_dir, STALE_TEMP_PLAYLIST_MAX_AGE, SystemTime::now());

    let temp_path = write_unique_temp_playlist(&content)?;
    match open_with_system_default(&temp_path) {
        Ok(()) => {
            let _ = spawn_temp_playlist_cleanup(temp_path, TEMP_PLAYLIST_DELETE_DELAY);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(temp_path);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_unique_temp_playlist_path, cleanup_stale_temp_playlists_in_dir,
        is_temp_playlist_file, spawn_temp_playlist_cleanup, write_unique_temp_playlist_in_dir,
    };
    use std::time::{Duration, SystemTime};

    fn test_temp_dir(prefix: &str) -> std::path::PathBuf {
        let unix_nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unix_nanos}"))
    }

    #[test]
    fn build_unique_temp_playlist_path_generates_distinct_paths() {
        let root = test_temp_dir("iptv-player-build-path");
        let first = build_unique_temp_playlist_path(&root);
        let second = build_unique_temp_playlist_path(&root);

        assert_ne!(first, second);
        assert!(first
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("iptv-checker-single-channel-"));
        assert_eq!(first.extension().and_then(|ext| ext.to_str()), Some("m3u8"));
    }

    #[test]
    fn write_unique_temp_playlist_in_dir_creates_unique_files_with_content() {
        let root = test_temp_dir("iptv-player-write-path");
        std::fs::create_dir_all(&root).expect("Failed to create test directory");

        let first_path = write_unique_temp_playlist_in_dir(&root, "#EXTM3U\nA\n")
            .expect("Failed to create first playlist file");
        let second_path = write_unique_temp_playlist_in_dir(&root, "#EXTM3U\nB\n")
            .expect("Failed to create second playlist file");

        assert_ne!(first_path, second_path);
        assert_eq!(
            std::fs::read_to_string(&first_path).expect("Failed to read first file"),
            "#EXTM3U\nA\n"
        );
        assert_eq!(
            std::fs::read_to_string(&second_path).expect("Failed to read second file"),
            "#EXTM3U\nB\n"
        );

        std::fs::remove_dir_all(&root).expect("Failed to remove test directory");
    }

    #[test]
    fn cleanup_stale_temp_playlists_in_dir_removes_only_old_generated_files() {
        let root = test_temp_dir("iptv-player-cleanup-stale");
        std::fs::create_dir_all(&root).expect("Failed to create test directory");

        let stale = root.join("iptv-checker-single-channel-stale.m3u8");
        let fresh = root.join("iptv-checker-single-channel-fresh.m3u8");
        let keep_other = root.join("other.m3u8");
        let keep_tmp = root.join("iptv-checker-single-channel-temp.tmp");

        std::fs::write(&stale, "#EXTM3U\nstale\n").expect("stale file should be writable");
        std::fs::write(&fresh, "#EXTM3U\nfresh\n").expect("fresh file should be writable");
        std::fs::write(&keep_other, "#EXTM3U\nother\n").expect("other file should be writable");
        std::fs::write(&keep_tmp, "#EXTM3U\ntmp\n").expect("tmp file should be writable");

        let stale_file = std::fs::OpenOptions::new()
            .write(true)
            .open(&stale)
            .expect("stale file should be openable");
        let stale_modified = SystemTime::now()
            .checked_sub(Duration::from_secs(2 * 60 * 60))
            .expect("time subtraction should succeed");
        stale_file
            .set_times(std::fs::FileTimes::new().set_modified(stale_modified))
            .expect("stale mtime should be set");

        cleanup_stale_temp_playlists_in_dir(&root, Duration::from_secs(60 * 60), SystemTime::now());

        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(keep_other.exists());
        assert!(keep_tmp.exists());
        assert!(is_temp_playlist_file(&fresh));
        assert!(!is_temp_playlist_file(&keep_other));

        std::fs::remove_dir_all(&root).expect("Failed to remove test directory");
    }

    #[test]
    fn spawn_temp_playlist_cleanup_removes_file_after_delay() {
        let root = test_temp_dir("iptv-player-cleanup-delay");
        std::fs::create_dir_all(&root).expect("Failed to create test directory");

        let path = root.join("iptv-checker-single-channel-delayed.m3u8");
        std::fs::write(&path, "#EXTM3U\ndelayed\n").expect("delayed file should be writable");

        let handle = spawn_temp_playlist_cleanup(path.clone(), Duration::from_millis(10));
        handle.join().expect("cleanup thread should complete");

        assert!(!path.exists());
        std::fs::remove_dir_all(&root).expect("Failed to remove test directory");
    }
}
