use crate::error::AppError;
use crate::models::channel::{ChannelResult, ChannelStatus};
use std::path::{Path, PathBuf};

fn map_csv_error(error: csv::Error) -> AppError {
    AppError::Other(format!("CSV export failed: {}", error))
}

fn sanitize_csv_cell(value: &str) -> String {
    let sanitized = value.replace('\u{0000}', "");
    let starts_with_formula = sanitized
        .chars()
        .find(|c| !c.is_whitespace())
        .map(|c| matches!(c, '=' | '+' | '-' | '@'))
        .unwrap_or(false);

    if starts_with_formula {
        format!("'{}", sanitized)
    } else {
        sanitized
    }
}

#[tauri::command]
pub async fn export_csv(results: Vec<ChannelResult>, path: String, playlist_name: String) -> Result<(), AppError> {
    let file = std::fs::File::create(&path).map_err(AppError::Io)?;
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(file);

    // Header matching Python CLI format
    writer
        .write_record([
            "Playlist",
            "Channel Number",
            "Total Channels in Playlist",
            "Channel Status",
            "Group Name",
            "Channel Name",
            "Channel ID",
            "Codec",
            "Bit Rate (kbps)",
            "Resolution",
            "Frame Rate",
            "Audio",
        ])
        .map_err(map_csv_error)?;

    let total = results.len();
    for (i, r) in results.iter().enumerate() {
        let status_str = r.status.to_string();
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

        writer
            .write_record([
                sanitize_csv_cell(&playlist_name),
                (i + 1).to_string(),
                total.to_string(),
                sanitize_csv_cell(&status_str),
                sanitize_csv_cell(&r.group),
                sanitize_csv_cell(&r.name),
                sanitize_csv_cell(&r.channel_id),
                sanitize_csv_cell(codec),
                sanitize_csv_cell(&bitrate),
                sanitize_csv_cell(resolution),
                sanitize_csv_cell(&fps),
                sanitize_csv_cell(&audio),
            ])
            .map_err(map_csv_error)?;
    }

    writer.flush().map_err(AppError::Io)?;
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

    if !working.is_empty() {
        let path = export_target_path(&base_path, "working");
        write_m3u_file(&path, &working)?;
    }
    if !dead.is_empty() {
        let path = export_target_path(&base_path, "dead");
        write_m3u_file(&path, &dead)?;
    }
    if !geoblocked.is_empty() {
        let path = export_target_path(&base_path, "geoblocked");
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

    let path = export_target_path(&base_path, "renamed");
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

fn export_target_path(base_path: &str, suffix: &str) -> PathBuf {
    let base = Path::new(base_path);
    let stem = base
        .file_stem()
        .and_then(|s| {
            if s.is_empty() {
                None
            } else {
                Some(s.to_string_lossy().to_string())
            }
        })
        .unwrap_or_else(|| "playlist".to_string());
    let parent = base
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}_{}.m3u8", stem, suffix))
}

fn write_m3u_file(path: &Path, entries: &[String]) -> Result<(), AppError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_result(name: &str, group: &str, channel_id: &str) -> ChannelResult {
        ChannelResult {
            index: 0,
            name: name.to_string(),
            group: group.to_string(),
            url: "http://example.com/live.m3u8".to_string(),
            status: ChannelStatus::Alive,
            codec: Some("H264".to_string()),
            resolution: Some("1080p".to_string()),
            width: Some(1920),
            height: Some(1080),
            fps: Some(30),
            video_bitrate: Some("5000 kbps".to_string()),
            audio_bitrate: Some("192".to_string()),
            audio_codec: Some("AAC".to_string()),
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: channel_id.to_string(),
            extinf_line: "#EXTINF:-1,Sample".to_string(),
            metadata_lines: Vec::new(),
            stream_url: None,
        }
    }

    #[test]
    fn export_target_path_uses_parent_directory_join() {
        let path = export_target_path("/tmp/iptv/source.m3u8", "working");
        assert_eq!(path, Path::new("/tmp/iptv").join("source_working.m3u8"));
    }

    #[test]
    fn export_target_path_handles_relative_paths() {
        let path = export_target_path("source.m3u8", "dead");
        assert_eq!(path, Path::new(".").join("source_dead.m3u8"));
    }

    #[test]
    fn export_target_path_handles_missing_extension() {
        let path = export_target_path("/tmp/iptv/source", "renamed");
        assert_eq!(path, Path::new("/tmp/iptv").join("source_renamed.m3u8"));
    }

    #[test]
    fn sanitize_csv_cell_blocks_formula_prefixes() {
        assert_eq!(sanitize_csv_cell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
        assert_eq!(sanitize_csv_cell("+cmd"), "'+cmd");
        assert_eq!(sanitize_csv_cell("-1"), "'-1");
        assert_eq!(sanitize_csv_cell("@x"), "'@x");
        assert_eq!(sanitize_csv_cell("safe value"), "safe value");
    }

    #[tokio::test]
    async fn export_csv_round_trips_and_mitigates_formulas() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-export-csv-{unique}.csv"));
        let path_string = path.to_string_lossy().to_string();

        let results = vec![sample_result(
            "=2+2,\"quoted\"\nline",
            "Sports,Live",
            "+channel-id",
        )];

        export_csv(results, path_string, "Playlist".to_string())
            .await
            .expect("csv export should succeed");

        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_path(&path)
            .expect("csv file should be readable");
        let rows: Vec<csv::StringRecord> = reader
            .records()
            .collect::<Result<Vec<_>, _>>()
            .expect("csv rows should parse");

        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.get(0), Some("Playlist"));
        assert_eq!(row.get(4), Some("Sports,Live"));
        assert_eq!(row.get(6), Some("'+channel-id"));
        assert!(row
            .get(5)
            .expect("name should exist")
            .starts_with("'=2+2"));

        std::fs::remove_file(path).expect("temporary csv should be removable");
    }
}
