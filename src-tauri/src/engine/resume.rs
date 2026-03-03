use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::error::AppError;
use crate::models::channel::ChannelResult;

const REDACTED_QUERY_VALUE: &str = "REDACTED";

fn sanitize_url_for_persistence(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(mut parsed) = url::Url::parse(trimmed) else {
        return trimmed.to_string();
    };

    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_fragment(None);

    let query_keys: Vec<String> = parsed
        .query_pairs()
        .map(|(key, _)| key.to_string())
        .collect();
    parsed.set_query(None);
    if !query_keys.is_empty() {
        let mut serializer = parsed.query_pairs_mut();
        for key in query_keys {
            serializer.append_pair(&key, REDACTED_QUERY_VALUE);
        }
    }

    parsed.to_string()
}

fn sanitize_log_entry(entry: &str) -> String {
    entry
        .split_whitespace()
        .map(|token| {
            if token.starts_with("http://") || token.starts_with("https://") {
                sanitize_url_for_persistence(token)
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

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

    let sanitized = sanitize_log_entry(entry);
    writeln!(file, "{}", sanitized).map_err(AppError::Io)?;
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

    let mut sanitized = result.clone();
    sanitized.url = sanitize_url_for_persistence(&sanitized.url);
    sanitized.stream_url = sanitized
        .stream_url
        .as_deref()
        .map(sanitize_url_for_persistence);

    let serialized = serde_json::to_string(&sanitized).map_err(|error| {
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
            audio_only: false,
            screenshot_path: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: format!("id-{}", index),
            extinf_line: format!("#EXTINF:-1,{}", name),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
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

    #[test]
    fn sanitize_url_for_persistence_redacts_credentials_and_query_values() {
        let sanitized = sanitize_url_for_persistence(
            "https://demo:secret@example.com/live.m3u8?token=abc123&password=hunter2#frag",
        );
        assert_eq!(
            sanitized,
            "https://example.com/live.m3u8?token=REDACTED&password=REDACTED"
        );
        assert!(!sanitized.contains("demo"));
        assert!(!sanitized.contains("secret"));
        assert!(!sanitized.contains("abc123"));
        assert!(!sanitized.contains("hunter2"));
    }

    #[test]
    fn write_log_entry_redacts_raw_secrets_in_urls() {
        let log_file = temp_file("resume-log-redaction");

        write_log_entry(
            &log_file,
            "7 - Secret Channel https://demo:secret@example.com/live.m3u8?token=abc123",
        )
        .expect("log write should succeed");

        let persisted = std::fs::read_to_string(&log_file).expect("log should be readable");
        assert!(persisted.contains("token=REDACTED"));
        assert!(!persisted.contains("abc123"));
        assert!(!persisted.contains("secret@example.com"));

        let _ = std::fs::remove_file(&log_file);
    }

    #[test]
    fn write_result_entry_redacts_url_and_stream_url() {
        let checkpoint_file = temp_file("resume-checkpoint-redaction");

        let mut result = make_result(8, "Secret", ChannelStatus::Alive);
        result.url = "https://demo:secret@example.com/live.m3u8?token=abc123".to_string();
        result.stream_url = Some(
            "https://stream.example.com/hls.m3u8?auth=xyz987&session=abcd".to_string(),
        );

        write_result_entry(&checkpoint_file, &result).expect("result write should succeed");

        let persisted =
            std::fs::read_to_string(&checkpoint_file).expect("checkpoint should be readable");
        assert!(!persisted.contains("abc123"));
        assert!(!persisted.contains("xyz987"));
        assert!(persisted.contains("token=REDACTED"));
        assert!(persisted.contains("auth=REDACTED"));
        assert!(persisted.contains("session=REDACTED"));

        let loaded = load_checkpoint_results(&checkpoint_file);
        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded[0].url,
            "https://example.com/live.m3u8?token=REDACTED"
        );
        assert_eq!(
            loaded[0].stream_url.as_deref(),
            Some("https://stream.example.com/hls.m3u8?auth=REDACTED&session=REDACTED")
        );

        let _ = std::fs::remove_file(&checkpoint_file);
    }
}
