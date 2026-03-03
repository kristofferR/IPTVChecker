use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::error::AppError;
use crate::models::channel::ChannelResult;

/// Load processed channels from a checkpoint log file.
/// Returns (set of channel URLs, last_index).
pub fn load_processed_channels(log_file: &str) -> (HashSet<String>, usize) {
    let path = Path::new(log_file);
    if !path.exists() {
        return (HashSet::new(), 0);
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (HashSet::new(), 0),
    };

    let mut processed = HashSet::new();
    let mut last_index: usize = 0;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Extract URL: last whitespace-separated token starting with http:// or https://
        if let Some(url) = line
            .split_whitespace()
            .rev()
            .find(|t| t.starts_with("http://") || t.starts_with("https://"))
        {
            processed.insert(url.to_string());
        }
        // Extract index for last_index tracking
        if let Some((index_part, _)) = line.split_once(" - ") {
            let index_str = index_part.trim().split_whitespace().next().unwrap_or("");
            if let Ok(idx) = index_str.parse::<usize>() {
                last_index = last_index.max(idx);
            }
        }
    }

    (processed, last_index)
}

/// Write a single log entry to the checkpoint file.
pub fn write_log_entry(log_file: &str, entry: &str) -> Result<(), AppError> {
    use std::io::Write;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .map_err(AppError::Io)?;

    writeln!(file, "{}", entry).map_err(AppError::Io)?;
    Ok(())
}

/// Load checkpointed channel results (JSON lines) and keep the latest result per index.
pub fn load_checkpoint_results(checkpoint_file: &str) -> Vec<ChannelResult> {
    let path = Path::new(checkpoint_file);
    if !path.exists() {
        return Vec::new();
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut by_index: BTreeMap<usize, ChannelResult> = BTreeMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(result) = serde_json::from_str::<ChannelResult>(line) {
            by_index.insert(result.index, result);
        }
    }

    by_index.into_values().collect()
}

/// Append a single channel result to a checkpoint file as JSON.
pub fn write_result_entry(checkpoint_file: &str, result: &ChannelResult) -> Result<(), AppError> {
    use std::io::Write;

    let serialized = serde_json::to_string(result).map_err(|error| {
        AppError::Parse(format!("Failed to serialize checkpoint result: {}", error))
    })?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(checkpoint_file)
        .map_err(AppError::Io)?;

    writeln!(file, "{}", serialized).map_err(AppError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::channel::ChannelStatus;

    fn make_result(index: usize, name: &str, status: ChannelStatus) -> ChannelResult {
        ChannelResult {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: name.to_string(),
            group: "Group".to_string(),
            url: format!("https://example.com/stream/{}", index),
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: format!("id-{}", index),
            extinf_line: format!("#EXTINF:-1,{}", name),
            metadata_lines: Vec::new(),
            stream_url: None,
        }
    }

    fn temp_file(name: &str) -> String {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir()
            .join(format!("iptv-checker-{}-{}-{}", name, pid, nanos))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn checkpoint_load_keeps_latest_result_per_index() {
        let checkpoint_file = temp_file("resume-checkpoint");

        let first = make_result(2, "Old Name", ChannelStatus::Dead);
        let second = make_result(2, "New Name", ChannelStatus::Alive);
        let third = make_result(5, "Another", ChannelStatus::Geoblocked);

        write_result_entry(&checkpoint_file, &first).expect("first result write should succeed");
        write_result_entry(&checkpoint_file, &second).expect("second result write should succeed");
        write_result_entry(&checkpoint_file, &third).expect("third result write should succeed");

        let loaded = load_checkpoint_results(&checkpoint_file);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].index, 2);
        assert_eq!(loaded[0].name, "New Name");
        assert_eq!(loaded[0].status, ChannelStatus::Alive);
        assert_eq!(loaded[1].index, 5);

        let _ = std::fs::remove_file(&checkpoint_file);
    }

    #[test]
    fn processed_log_load_extracts_urls_and_last_index() {
        let log_file = temp_file("resume-log");

        write_log_entry(&log_file, "1 - First https://example.com/a")
            .expect("first log write should succeed");
        write_log_entry(&log_file, "4 - Fourth https://example.com/b")
            .expect("second log write should succeed");
        write_log_entry(&log_file, "not parseable")
            .expect("non-parseable log write should succeed");

        let (processed, last_index) = load_processed_channels(&log_file);
        assert_eq!(processed.len(), 2);
        assert!(processed.contains("https://example.com/a"));
        assert!(processed.contains("https://example.com/b"));
        assert_eq!(last_index, 4);

        let _ = std::fs::remove_file(&log_file);
    }
}
