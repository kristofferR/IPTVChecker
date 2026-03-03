use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::error::AppError;

static NEXT_TEMP_PLAYLIST_ID: AtomicU64 = AtomicU64::new(0);

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
        "iptv-checker-single-channel-{pid}-{unix_nanos}-{sequence}.m3u8"
    ))
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

    let temp_path = write_unique_temp_playlist(&content)?;
    open_with_system_default(&temp_path)
}

#[cfg(test)]
mod tests {
    use super::{build_unique_temp_playlist_path, write_unique_temp_playlist_in_dir};

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
}
