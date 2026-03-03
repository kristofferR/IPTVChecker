use std::path::Path;

use serde::Deserialize;

use crate::error::AppError;

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

#[tauri::command]
pub async fn open_channel_in_player(channel: PlayerChannel) -> Result<(), AppError> {
    let temp_path = std::env::temp_dir().join("iptv-checker-single-channel.m3u8");

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

    std::fs::write(&temp_path, content).map_err(AppError::Io)?;
    open_with_system_default(&temp_path)
}
