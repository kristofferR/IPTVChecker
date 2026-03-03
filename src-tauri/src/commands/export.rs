use crate::error::AppError;
use crate::models::channel::{ChannelResult, ChannelStatus};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const AUDIO_ONLY_EXPORT_TAG: &str = "#EXTVLCOPT:iptv-checker-audio-only=1";

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

fn format_latency(latency_ms: Option<u64>) -> String {
    match latency_ms {
        Some(ms) if ms < 1000 => format!("{} ms", ms),
        Some(ms) => format!("{:.1} s", ms as f64 / 1000.0),
        None => "Unknown".to_string(),
    }
}

#[tauri::command]
pub async fn export_csv(
    results: Vec<ChannelResult>,
    path: String,
    playlist_name: String,
    include_latency: bool,
) -> Result<(), AppError> {
    let file = std::fs::File::create(&path).map_err(AppError::Io)?;
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(file);

    // Header matching Python CLI format
    let mut headers = vec![
        "Playlist".to_string(),
        "Channel Number".to_string(),
        "Total Channels in Playlist".to_string(),
        "Channel Status".to_string(),
        "Group Name".to_string(),
        "Channel Name".to_string(),
        "Channel ID".to_string(),
        "Codec".to_string(),
        "Bit Rate (kbps)".to_string(),
        "Resolution".to_string(),
        "Frame Rate".to_string(),
        "Audio Only".to_string(),
        "Audio".to_string(),
    ];
    if include_latency {
        headers.push("Latency".to_string());
    }
    writer.write_record(headers).map_err(map_csv_error)?;

    let total = results.len();
    for (i, r) in results.iter().enumerate() {
        let playlist_cell = if r.playlist.trim().is_empty() {
            playlist_name.as_str()
        } else {
            r.playlist.as_str()
        };
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
        let audio_only = if r.audio_only { "Yes" } else { "No" };

        let mut row = vec![
            sanitize_csv_cell(playlist_cell),
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
            audio_only.to_string(),
            sanitize_csv_cell(&audio),
        ];
        if include_latency {
            row.push(sanitize_csv_cell(&format_latency(r.latency_ms)));
        }

        writer.write_record(row).map_err(map_csv_error)?;
    }

    writer.flush().map_err(AppError::Io)?;
    Ok(())
}

#[tauri::command]
pub async fn export_split(results: Vec<ChannelResult>, base_path: String) -> Result<(), AppError> {
    #[derive(Default)]
    struct SplitBuckets {
        working: Vec<String>,
        dead: Vec<String>,
        geoblocked: Vec<String>,
    }

    let mut playlists: BTreeMap<String, SplitBuckets> = BTreeMap::new();

    for r in &results {
        let playlist_key = playlist_file_key(&r.playlist);
        let buckets = playlists.entry(playlist_key).or_default();
        let entry = build_m3u_entry(r);
        match r.status {
            ChannelStatus::Alive => buckets.working.push(entry),
            ChannelStatus::Dead => buckets.dead.push(entry),
            ChannelStatus::Geoblocked
            | ChannelStatus::GeoblockedConfirmed
            | ChannelStatus::GeoblockedUnconfirmed => buckets.geoblocked.push(entry),
            _ => {}
        }
    }

    let split_by_playlist = playlists.len() > 1;

    for (playlist, buckets) in playlists {
        if !buckets.working.is_empty() {
            let suffix = if split_by_playlist {
                format!("{}_working", playlist)
            } else {
                "working".to_string()
            };
            let path = export_target_path(&base_path, &suffix);
            write_m3u_file(&path, &buckets.working)?;
        }
        if !buckets.dead.is_empty() {
            let suffix = if split_by_playlist {
                format!("{}_dead", playlist)
            } else {
                "dead".to_string()
            };
            let path = export_target_path(&base_path, &suffix);
            write_m3u_file(&path, &buckets.dead)?;
        }
        if !buckets.geoblocked.is_empty() {
            let suffix = if split_by_playlist {
                format!("{}_geoblocked", playlist)
            } else {
                "geoblocked".to_string()
            };
            let path = export_target_path(&base_path, &suffix);
            write_m3u_file(&path, &buckets.geoblocked)?;
        }
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
            if let Some(audio_only_metadata) = audio_only_export_metadata(r) {
                writeln!(file, "{}", audio_only_metadata).map_err(AppError::Io)?;
            }
            writeln!(file, "{}", r.url).map_err(AppError::Io)?;
        } else {
            writeln!(file, "{}", r.extinf_line).map_err(AppError::Io)?;
            for meta in &r.metadata_lines {
                writeln!(file, "{}", meta).map_err(AppError::Io)?;
            }
            if let Some(audio_only_metadata) = audio_only_export_metadata(r) {
                writeln!(file, "{}", audio_only_metadata).map_err(AppError::Io)?;
            }
            writeln!(file, "{}", r.url).map_err(AppError::Io)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn export_m3u(results: Vec<ChannelResult>, path: String) -> Result<(), AppError> {
    let entries = results
        .iter()
        .map(build_m3u_entry)
        .collect::<Vec<String>>();
    write_m3u_file(Path::new(&path), &entries)
}

fn build_m3u_entry(r: &ChannelResult) -> String {
    let mut entry = r.extinf_line.clone();
    for meta in &r.metadata_lines {
        entry.push('\n');
        entry.push_str(meta);
    }
    if let Some(audio_only_metadata) = audio_only_export_metadata(r) {
        entry.push('\n');
        entry.push_str(audio_only_metadata);
    }
    entry.push('\n');
    entry.push_str(&r.url);
    entry
}

fn audio_only_export_metadata(result: &ChannelResult) -> Option<&'static str> {
    result.audio_only.then_some(AUDIO_ONLY_EXPORT_TAG)
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

fn playlist_file_key(playlist: &str) -> String {
    let trimmed = playlist.trim();
    let raw = if trimmed.is_empty() {
        "playlist"
    } else {
        trimmed
    };
    let stem = Path::new(raw)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(raw);
    let sanitized = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    let compact = sanitized.trim_matches('_').to_string();
    if compact.is_empty() {
        "playlist".to_string()
    } else {
        compact
    }
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
            playlist: String::new(),
            name: name.to_string(),
            group: group.to_string(),
            url: "http://example.com/live.m3u8".to_string(),
            status: ChannelStatus::Alive,
            codec: Some("H264".to_string()),
            resolution: Some("1080p".to_string()),
            width: Some(1920),
            height: Some(1080),
            fps: Some(30),
            latency_ms: Some(230),
            video_bitrate: Some("5000 kbps".to_string()),
            audio_bitrate: Some("192".to_string()),
            audio_codec: Some("AAC".to_string()),
            audio_only: false,
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: channel_id.to_string(),
            extinf_line: "#EXTINF:-1,Sample".to_string(),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            last_error_reason: None,
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

        export_csv(results, path_string, "Playlist".to_string(), false)
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
        assert!(row.get(5).expect("name should exist").starts_with("'=2+2"));
        assert_eq!(row.get(11), Some("No"));

        std::fs::remove_file(path).expect("temporary csv should be removable");
    }

    #[tokio::test]
    async fn export_csv_includes_latency_column_when_enabled() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-export-csv-latency-{unique}.csv"));
        let path_string = path.to_string_lossy().to_string();

        let mut result = sample_result("Channel 1", "Sports", "channel-id");
        result.latency_ms = Some(1200);

        export_csv(vec![result], path_string, "Playlist".to_string(), true)
            .await
            .expect("csv export should succeed");

        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_path(&path)
            .expect("csv file should be readable");
        let headers = reader.headers().expect("headers should parse").clone();
        assert_eq!(headers.get(13), Some("Latency"));

        let rows: Vec<csv::StringRecord> = reader
            .records()
            .collect::<Result<Vec<_>, _>>()
            .expect("csv rows should parse");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get(13), Some("1.2 s"));

        std::fs::remove_file(path).expect("temporary csv should be removable");
    }

    #[tokio::test]
    async fn export_csv_includes_audio_only_flag() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-export-csv-audio-only-{unique}.csv"));
        let path_string = path.to_string_lossy().to_string();

        let mut result = sample_result("Radio 1", "Radio", "radio-1");
        result.audio_only = true;

        export_csv(vec![result], path_string, "Playlist".to_string(), false)
            .await
            .expect("csv export should succeed");

        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_path(&path)
            .expect("csv file should be readable");
        let headers = reader.headers().expect("headers should parse").clone();
        assert_eq!(headers.get(11), Some("Audio Only"));

        let rows: Vec<csv::StringRecord> = reader
            .records()
            .collect::<Result<Vec<_>, _>>()
            .expect("csv rows should parse");
        assert_eq!(rows[0].get(11), Some("Yes"));

        std::fs::remove_file(path).expect("temporary csv should be removable");
    }

    #[tokio::test]
    async fn export_m3u_writes_header_and_original_extinf_metadata() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-export-m3u-{unique}.m3u8"));
        let path_string = path.to_string_lossy().to_string();

        let mut result = sample_result("Channel 1", "Sports", "id-1");
        result.extinf_line =
            "#EXTINF:-1 tvg-id=\"id-1\" group-title=\"Sports\",Channel 1".to_string();
        result.metadata_lines = vec![
            "#KODIPROP:inputstream.ffmpegdirect.is_realtime_stream=true".to_string(),
            "#EXTVLCOPT:http-user-agent=VLC/3.0.14".to_string(),
        ];
        result.url = "http://example.com/sports/channel1.m3u8".to_string();
        result.audio_only = true;

        export_m3u(vec![result.clone()], path_string)
            .await
            .expect("m3u export should succeed");

        let exported = std::fs::read_to_string(&path).expect("m3u export should be readable");
        let expected = format!(
            "#EXTM3U\n{}\n{}\n{}\n{}\n{}\n",
            result.extinf_line,
            result.metadata_lines[0],
            result.metadata_lines[1],
            AUDIO_ONLY_EXPORT_TAG,
            result.url
        );
        assert_eq!(exported, expected);

        std::fs::remove_file(path).expect("temporary m3u should be removable");
    }
}
