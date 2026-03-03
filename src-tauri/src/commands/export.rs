use crate::error::AppError;
use crate::models::channel::{ChannelResult, ChannelStatus};

#[tauri::command]
pub async fn export_csv(results: Vec<ChannelResult>, path: String, playlist_name: String) -> Result<(), AppError> {
    use std::io::Write;

    let mut file = std::fs::File::create(&path).map_err(AppError::Io)?;

    // CSV header matching Python CLI format
    writeln!(
        file,
        "Playlist,Channel Number,Total Channels in Playlist,Channel Status,Group Name,Channel Name,Channel ID,Codec,Bit Rate (kbps),Resolution,Frame Rate,Audio"
    )
    .map_err(AppError::Io)?;

    let total = results.len();
    for (i, r) in results.iter().enumerate() {
        let status_str = r.status.to_string();
        let group = r.group.replace('"', "\"\"").replace('\n', " ").replace('\r', "");
        let name = r.name.replace('"', "\"\"").replace('\n', " ").replace('\r', "");
        let codec = r.codec.as_deref().unwrap_or("Unknown");
        let bitrate = r
            .video_bitrate
            .as_deref()
            .map(|b| b.replace("kbps", "").trim().to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        let resolution = r.resolution.as_deref().unwrap_or("Unknown");
        let fps = r.fps.map(|f| f.to_string()).unwrap_or_default();
        let audio = format!(
            "{} kbps {}",
            r.audio_bitrate.as_deref().unwrap_or("Unknown"),
            r.audio_codec.as_deref().unwrap_or("Unknown")
        );

        writeln!(
            file,
            "{},{},{},{},\"{}\",\"{}\",{},{},{},{},{},{}",
            playlist_name,
            i + 1,
            total,
            status_str,
            group,
            name,
            r.channel_id,
            codec,
            bitrate,
            resolution,
            fps,
            audio
        )
        .map_err(AppError::Io)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn export_split(
    results: Vec<ChannelResult>,
    base_path: String,
) -> Result<(), AppError> {
    let mut working = Vec::new();
    let mut dead = Vec::new();
    let mut geoblocked = Vec::new();

    for r in &results {
        let entry = build_m3u_entry(r);
        match r.status {
            ChannelStatus::Alive => working.push(entry),
            ChannelStatus::Dead => dead.push(entry),
            ChannelStatus::Geoblocked
            | ChannelStatus::GeoblockedConfirmed
            | ChannelStatus::GeoblockedUnconfirmed => geoblocked.push(entry),
            _ => {}
        }
    }

    let base = std::path::Path::new(&base_path);
    let stem = base
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "playlist".to_string());
    let dir = base
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    if !working.is_empty() {
        let path = format!("{}/{}_working.m3u8", dir, stem);
        write_m3u_file(&path, &working)?;
    }
    if !dead.is_empty() {
        let path = format!("{}/{}_dead.m3u8", dir, stem);
        write_m3u_file(&path, &dead)?;
    }
    if !geoblocked.is_empty() {
        let path = format!("{}/{}_geoblocked.m3u8", dir, stem);
        write_m3u_file(&path, &geoblocked)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn export_renamed(
    results: Vec<ChannelResult>,
    base_path: String,
) -> Result<(), AppError> {
    use std::io::Write;

    let base = std::path::Path::new(&base_path);
    let stem = base
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "playlist".to_string());
    let dir = base
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let path = format!("{}/{}_renamed.m3u8", dir, stem);
    let mut file = std::fs::File::create(&path).map_err(AppError::Io)?;
    writeln!(file, "#EXTM3U").map_err(AppError::Io)?;

    for r in &results {
        if r.status == ChannelStatus::Alive {
            // Build renamed EXTINF line
            let video_info = format_video_info(r);
            let audio_info = format_audio_info(r);
            let renamed_name = format!("{} ({} | Audio: {})", r.name, video_info, audio_info);

            // Replace channel name in EXTINF line
            let extinf = if let Some(pos) = r.extinf_line.find(',') {
                format!("{},{}", &r.extinf_line[..pos], renamed_name)
            } else {
                r.extinf_line.clone()
            };

            writeln!(file, "{}", extinf).map_err(AppError::Io)?;
            for meta in &r.metadata_lines {
                writeln!(file, "{}", meta).map_err(AppError::Io)?;
            }
            writeln!(file, "{}", r.url).map_err(AppError::Io)?;
        } else {
            writeln!(file, "{}", r.extinf_line).map_err(AppError::Io)?;
            for meta in &r.metadata_lines {
                writeln!(file, "{}", meta).map_err(AppError::Io)?;
            }
            writeln!(file, "{}", r.url).map_err(AppError::Io)?;
        }
    }

    Ok(())
}

fn build_m3u_entry(r: &ChannelResult) -> String {
    let mut entry = r.extinf_line.clone();
    for meta in &r.metadata_lines {
        entry.push('\n');
        entry.push_str(meta);
    }
    entry.push('\n');
    entry.push_str(&r.url);
    entry
}

fn write_m3u_file(path: &str, entries: &[String]) -> Result<(), AppError> {
    use std::io::Write;
    let mut file = std::fs::File::create(path).map_err(AppError::Io)?;
    writeln!(file, "#EXTM3U").map_err(AppError::Io)?;
    for entry in entries {
        writeln!(file, "{}", entry).map_err(AppError::Io)?;
    }
    Ok(())
}

fn format_video_info(r: &ChannelResult) -> String {
    let mut parts = Vec::new();
    if let Some(ref res) = r.resolution {
        if res != "Unknown" {
            let res_display = if let Some(fps) = r.fps {
                format!("{}{}", res, fps)
            } else {
                res.clone()
            };
            parts.push(res_display);
        }
    }
    if let Some(ref codec) = r.codec {
        if codec != "Unknown" {
            parts.push(codec.clone());
        }
    }
    let base = if parts.is_empty() {
        "Unknown".to_string()
    } else {
        parts.join(" ")
    };
    if let Some(ref bitrate) = r.video_bitrate {
        if bitrate != "Unknown" && bitrate != "N/A" {
            return format!("{} ({})", base, bitrate);
        }
    }
    base
}

fn format_audio_info(r: &ChannelResult) -> String {
    match (&r.audio_bitrate, &r.audio_codec) {
        (Some(bitrate), Some(codec)) if codec != "Unknown" => {
            format!("{} kbps {}", bitrate, codec)
        }
        _ => "Unknown".to_string(),
    }
}
