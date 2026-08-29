use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use crate::error::AppError;
use crate::models::channel::ChannelResult;
use crate::models::scan_log::{ChannelAttemptDebugLog, ChannelDebugLog};

const REDACTED_QUERY_VALUE: &str = "REDACTED";
const REDACTED_PATH_SEGMENT: &str = "REDACTED";
static URL_IN_TEXT_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"https?://[^\s"'<>]+"#).expect("valid URL regex"));
static CATCHUP_SOURCE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)(catchup-source\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s,]+))"#)
        .expect("valid catch-up source regex")
});

pub(crate) fn sanitize_url_for_persistence(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(mut parsed) = url::Url::parse(trimmed) else {
        let without_fragment = trimmed.split_once('#').map_or(trimmed, |(value, _)| value);
        let (base, query) = without_fragment
            .split_once('?')
            .map_or((without_fragment, None), |(base, query)| {
                (base, Some(query))
            });
        let sanitized_base =
            redact_provider_path_credentials(base).unwrap_or_else(|| base.to_string());
        let Some(query) = query else {
            return sanitized_base;
        };
        if query.is_empty() {
            return sanitized_base;
        }

        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (key, _) in url::form_urlencoded::parse(query.as_bytes()) {
            serializer.append_pair(&key, REDACTED_QUERY_VALUE);
        }
        return format!("{}?{}", sanitized_base, serializer.finish());
    };

    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_fragment(None);
    if let Some(path) = redact_provider_path_credentials(parsed.path()) {
        parsed.set_path(&path);
    }

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

fn redact_provider_path_credentials(path: &str) -> Option<String> {
    let mut segments: Vec<String> = path.split('/').map(str::to_string).collect();
    let credential_positions = segments
        .iter()
        .enumerate()
        .find(|(index, segment)| {
            matches!(
                segment.to_ascii_lowercase().as_str(),
                "live" | "movie" | "series" | "timeshift"
            ) && segments.len() >= index + 4
        })
        .map(|(index, _)| (index + 1, index + 2))
        .or_else(|| {
            let nonempty: Vec<usize> = segments
                .iter()
                .enumerate()
                .filter_map(|(index, segment)| (!segment.is_empty()).then_some(index))
                .collect();
            if nonempty.len() == 3
                && segments[nonempty[2]].split('.').next().is_some_and(|id| {
                    !id.is_empty() && id.chars().all(|character| character.is_ascii_digit())
                })
            {
                Some((nonempty[0], nonempty[1]))
            } else {
                None
            }
        });

    let (username, password) = credential_positions?;
    segments[username] = REDACTED_PATH_SEGMENT.to_string();
    segments[password] = REDACTED_PATH_SEGMENT.to_string();
    Some(segments.join("/"))
}

pub(crate) fn sanitize_extinf_for_persistence(extinf_line: &str) -> String {
    CATCHUP_SOURCE_RE
        .replace_all(extinf_line, |captures: &regex::Captures<'_>| {
            let value = captures
                .get(2)
                .or_else(|| captures.get(3))
                .or_else(|| captures.get(4))
                .map_or("", |capture| capture.as_str());
            let quote = if captures.get(2).is_some() {
                "\""
            } else if captures.get(3).is_some() {
                "'"
            } else {
                ""
            };
            format!(
                "{}{}{}{}",
                &captures[1],
                quote,
                sanitize_url_for_persistence(value),
                quote
            )
        })
        .into_owned()
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

#[derive(Debug, Clone)]
pub struct CheckpointWriteEntry {
    pub log_entry: String,
    pub result: ChannelResult,
}

#[derive(Debug, Clone)]
pub struct CheckpointWriteEntryWithLog {
    pub log_entry: String,
    pub result: ChannelResult,
    pub channel_log: ChannelDebugLog,
}

#[derive(Debug, Clone)]
pub struct CheckpointResumeEntry {
    pub result: ChannelResult,
    pub channel_log: Option<ChannelDebugLog>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedCheckpointEntry {
    result: ChannelResult,
    #[serde(default)]
    channel_log: Option<ChannelDebugLog>,
}

// Both variants wrap a ChannelResult, so they are inherently ~1 KB and the size
// difference between them is just the optional log. Boxing to satisfy
// `large_enum_variant` would add an allocation per checkpoint line for a value
// that is destructured immediately after deserializing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum PersistedCheckpointLine {
    Entry(PersistedCheckpointEntry),
    LegacyResult(ChannelResult),
}

fn sanitize_embedded_urls(value: &str) -> String {
    URL_IN_TEXT_RE
        .replace_all(value, |captures: &regex::Captures<'_>| {
            sanitize_url_for_persistence(&captures[0])
        })
        .into_owned()
}

fn sanitize_attempt_log_for_persistence(
    attempt: &ChannelAttemptDebugLog,
) -> ChannelAttemptDebugLog {
    let mut sanitized = attempt.clone();
    sanitized.redirect_chain = sanitized
        .redirect_chain
        .iter()
        .map(|url| sanitize_url_for_persistence(url))
        .collect();
    sanitized.reason = sanitized.reason.as_deref().map(sanitize_embedded_urls);
    sanitized
}

fn sanitize_channel_log_for_persistence(channel_log: &ChannelDebugLog) -> ChannelDebugLog {
    let mut sanitized = channel_log.clone();
    sanitized.channel_url = sanitize_url_for_persistence(&sanitized.channel_url);
    sanitized.redirect_chain = sanitized
        .redirect_chain
        .iter()
        .map(|url| sanitize_url_for_persistence(url))
        .collect();
    sanitized.final_reason = sanitized
        .final_reason
        .as_deref()
        .map(sanitize_embedded_urls);
    sanitized.screenshot_error_reason = sanitized
        .screenshot_error_reason
        .as_deref()
        .map(sanitize_embedded_urls);
    sanitized.diagnostics_output = sanitized
        .diagnostics_output
        .as_deref()
        .map(sanitize_embedded_urls);
    sanitized.attempts = sanitized
        .attempts
        .iter()
        .map(sanitize_attempt_log_for_persistence)
        .collect();
    sanitized
}

fn sanitize_checkpoint_entry_for_persistence(
    entry: &CheckpointWriteEntryWithLog,
) -> PersistedCheckpointEntry {
    PersistedCheckpointEntry {
        result: sanitize_result_for_persistence(&entry.result),
        channel_log: Some(sanitize_channel_log_for_persistence(&entry.channel_log)),
    }
}

fn sanitize_result_for_persistence(result: &ChannelResult) -> ChannelResult {
    let mut sanitized = result.clone();
    sanitized.url = sanitize_url_for_persistence(&sanitized.url);
    sanitized.stream_url = sanitized
        .stream_url
        .as_deref()
        .map(sanitize_url_for_persistence);
    sanitized.catchup_source = sanitized
        .catchup_source
        .as_deref()
        .map(sanitize_url_for_persistence);
    sanitized.extinf_line = sanitize_extinf_for_persistence(&sanitized.extinf_line);
    sanitized
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
            let index_str = index_part.split_whitespace().next().unwrap_or("");
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

fn build_resumed_channel_log(result: &ChannelResult) -> ChannelDebugLog {
    ChannelDebugLog {
        channel_index: result.index,
        channel_name: result.name.clone(),
        channel_url: result.url.clone(),
        final_verdict: result.status.to_string(),
        final_reason: result.error_reason.clone(),
        screenshot_error_reason: result.screenshot_error_reason.clone(),
        ..ChannelDebugLog::default()
    }
}

/// Load checkpointed resume entries and keep the latest entry per index.
pub fn load_checkpoint_entries(checkpoint_file: &str) -> Vec<CheckpointResumeEntry> {
    let path = Path::new(checkpoint_file);
    if !path.exists() {
        return Vec::new();
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(err) => {
            log::warn!("Failed to read checkpoint file {checkpoint_file}: {err}");
            return Vec::new();
        }
    };

    let mut by_index: BTreeMap<usize, CheckpointResumeEntry> = BTreeMap::new();
    let mut malformed = 0u32;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<PersistedCheckpointLine>(line) {
            Ok(PersistedCheckpointLine::Entry(entry)) => {
                let channel_log = entry
                    .channel_log
                    .or_else(|| Some(build_resumed_channel_log(&entry.result)));
                by_index.insert(
                    entry.result.index,
                    CheckpointResumeEntry {
                        result: entry.result,
                        channel_log,
                    },
                );
            }
            Ok(PersistedCheckpointLine::LegacyResult(result)) => {
                by_index.insert(
                    result.index,
                    CheckpointResumeEntry {
                        channel_log: Some(build_resumed_channel_log(&result)),
                        result,
                    },
                );
            }
            Err(_) => {
                malformed += 1;
            }
        }
    }
    if malformed > 0 {
        log::warn!("Checkpoint {checkpoint_file}: skipped {malformed} malformed JSON line(s)");
    }

    by_index.into_values().collect()
}

/// Load checkpointed channel results (JSON lines) and keep the latest result per index.
pub fn load_checkpoint_results(checkpoint_file: &str) -> Vec<ChannelResult> {
    load_checkpoint_entries(checkpoint_file)
        .into_iter()
        .map(|entry| entry.result)
        .collect()
}

/// Append a single channel result to a checkpoint file as JSON.
pub fn write_result_entry(checkpoint_file: &str, result: &ChannelResult) -> Result<(), AppError> {
    use std::io::Write;

    let serialized = serde_json::to_string(&PersistedCheckpointEntry {
        result: sanitize_result_for_persistence(result),
        channel_log: None,
    })
    .map_err(|error| {
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

/// Append a batch of log+result entries, opening each file only once.
pub fn write_entries(
    log_file: &str,
    checkpoint_file: &str,
    entries: &[CheckpointWriteEntry],
) -> Result<(), AppError> {
    use std::io::Write;

    if entries.is_empty() {
        return Ok(());
    }

    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .map_err(AppError::Io)?;
    let mut checkpoint = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(checkpoint_file)
        .map_err(AppError::Io)?;

    for entry in entries {
        writeln!(log, "{}", sanitize_log_entry(&entry.log_entry)).map_err(AppError::Io)?;
        let serialized = serde_json::to_string(&PersistedCheckpointEntry {
            result: sanitize_result_for_persistence(&entry.result),
            channel_log: None,
        })
        .map_err(|error| {
            AppError::Parse(format!("Failed to serialize checkpoint result: {}", error))
        })?;
        writeln!(checkpoint, "{}", serialized).map_err(AppError::Io)?;
    }

    Ok(())
}

/// Append a batch of log+result+channel-log entries, opening each file only once.
pub fn write_entries_with_channel_logs(
    log_file: &str,
    checkpoint_file: &str,
    entries: &[CheckpointWriteEntryWithLog],
) -> Result<(), AppError> {
    use std::io::Write;

    if entries.is_empty() {
        return Ok(());
    }

    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .map_err(AppError::Io)?;
    let mut checkpoint = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(checkpoint_file)
        .map_err(AppError::Io)?;

    for entry in entries {
        writeln!(log, "{}", sanitize_log_entry(&entry.log_entry)).map_err(AppError::Io)?;
        let serialized = serde_json::to_string(&sanitize_checkpoint_entry_for_persistence(entry))
            .map_err(|error| {
            AppError::Parse(format!("Failed to serialize checkpoint result: {}", error))
        })?;
        writeln!(checkpoint, "{}", serialized).map_err(AppError::Io)?;
    }

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
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: format!("https://example.com/stream/{}", index),
            content_type: crate::models::channel::ContentType::Live,
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            hdr_format: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_channel_layout: None,
            audio_only: false,
            screenshot_path: None,
            screenshot_error_reason: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: format!("id-{}", index),
            extinf_line: format!("#EXTINF:-1,{}", name),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
            drm_system: None,
        }
    }

    fn make_channel_log(index: usize, url: &str) -> ChannelDebugLog {
        ChannelDebugLog {
            channel_index: index,
            channel_name: format!("Channel {index}"),
            channel_url: url.to_string(),
            redirect_chain: vec![format!("{url}?token=redirect")],
            final_verdict: "Alive".to_string(),
            final_reason: Some(format!("Failure for {url}?token=reason")),
            screenshot_error_reason: Some(format!("Capture failed for {url}?token=screenshot")),
            diagnostics_output: Some(format!("ffprobe input {url}?token=diag")),
            attempts: vec![ChannelAttemptDebugLog {
                attempt: 1,
                timeout_secs: 5.0,
                started_at_epoch_ms: 10,
                ended_at_epoch_ms: 20,
                verdict: "Alive".to_string(),
                reason: Some(format!("Attempt via {url}?token=attempt")),
                redirect_chain: vec![format!("{url}?token=attempt-chain")],
                bytes_transferred: 512,
                ttfb_ms: Some(42),
                http_status_codes: vec![200],
            }],
            ..ChannelDebugLog::default()
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
    fn checkpoint_entries_round_trip_channel_logs_with_redaction() {
        let log_file = temp_file("resume-checkpoint-log");
        let checkpoint_file = temp_file("resume-checkpoint-entries");
        let mut result = make_result(8, "Secret", ChannelStatus::Alive);
        result.url = "https://demo:secret@example.com/live.m3u8?token=abc123".to_string();
        result.stream_url =
            Some("https://stream.example.com/hls.m3u8?auth=xyz987&session=abcd".to_string());
        let channel_log = make_channel_log(result.index, &result.url);

        write_entries_with_channel_logs(
            &log_file,
            &checkpoint_file,
            &[CheckpointWriteEntryWithLog {
                log_entry: format!("8 - Secret {}", result.url),
                result: result.clone(),
                channel_log: channel_log.clone(),
            }],
        )
        .expect("entry write should succeed");

        let persisted =
            std::fs::read_to_string(&checkpoint_file).expect("checkpoint should be readable");
        assert!(!persisted.contains("abc123"));
        assert!(!persisted.contains("xyz987"));
        assert!(persisted.contains("token=REDACTED"));
        assert!(persisted.contains("auth=REDACTED"));

        let loaded = load_checkpoint_entries(&checkpoint_file);
        assert_eq!(loaded.len(), 1);
        let loaded_log = loaded[0]
            .channel_log
            .as_ref()
            .expect("channel log should persist");
        assert_eq!(loaded_log.channel_index, 8);
        assert!(loaded_log.channel_url.contains("token=REDACTED"));
        assert!(loaded_log
            .diagnostics_output
            .as_deref()
            .unwrap_or_default()
            .contains("token=REDACTED"));
        assert!(loaded_log
            .attempts
            .first()
            .and_then(|attempt| attempt.reason.as_deref())
            .unwrap_or_default()
            .contains("token=REDACTED"));

        let _ = std::fs::remove_file(&log_file);
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
    fn sanitize_url_for_persistence_redacts_relative_query_values() {
        assert_eq!(
            sanitize_url_for_persistence("?token=abc123&start=${start}#fragment"),
            "?token=REDACTED&start=REDACTED"
        );
        assert_eq!(
            sanitize_url_for_persistence("archive/path?username=demo&password=hunter2"),
            "archive/path?username=REDACTED&password=REDACTED"
        );
    }

    #[test]
    fn sanitize_url_for_persistence_redacts_provider_path_credentials() {
        let sanitized = sanitize_url_for_persistence(
            "https://provider.example/timeshift/path-user/path-pass/${duration}/${start}/42.ts",
        );
        assert!(sanitized.contains("/timeshift/REDACTED/REDACTED/"));
        assert!(!sanitized.contains("path-user"));
        assert!(!sanitized.contains("path-pass"));
        assert_eq!(
            sanitize_url_for_persistence(
                "/timeshift/relative-user/relative-pass/${duration}/${start}/42.ts"
            ),
            "/timeshift/REDACTED/REDACTED/${duration}/${start}/42.ts"
        );

        let extinf = sanitize_extinf_for_persistence(
            "#EXTINF:-1 catchup-source=\"https://provider.example/timeshift/extinf-user/extinf-pass/${duration}/${start}/42.ts\",Channel",
        );
        assert!(extinf.contains("/timeshift/REDACTED/REDACTED/"));
        assert!(!extinf.contains("extinf-user"));
        assert!(!extinf.contains("extinf-pass"));
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
    fn write_result_entry_redacts_result_urls() {
        let checkpoint_file = temp_file("resume-checkpoint-redaction");

        let mut result = make_result(8, "Secret", ChannelStatus::Alive);
        result.url = "https://demo:secret@example.com/live.m3u8?token=abc123".to_string();
        result.stream_url =
            Some("https://stream.example.com/hls.m3u8?auth=xyz987&session=abcd".to_string());
        result.catchup_source = Some(
            "https://archive:secret@example.com/timeshift?username=demo&password=hunter2"
                .to_string(),
        );
        result.extinf_line =
            "#EXTINF:-1 catchup-source=\"?token=checkpoint-secret&start=${start}\",Secret"
                .to_string();

        write_result_entry(&checkpoint_file, &result).expect("result write should succeed");

        let persisted =
            std::fs::read_to_string(&checkpoint_file).expect("checkpoint should be readable");
        assert!(!persisted.contains("abc123"));
        assert!(!persisted.contains("xyz987"));
        assert!(!persisted.contains("hunter2"));
        assert!(!persisted.contains("checkpoint-secret"));
        assert!(persisted.contains("token=REDACTED"));
        assert!(persisted.contains("auth=REDACTED"));
        assert!(persisted.contains("session=REDACTED"));
        assert!(persisted.contains("username=REDACTED"));
        assert!(persisted.contains("password=REDACTED"));

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
        assert_eq!(
            loaded[0].catchup_source.as_deref(),
            Some("https://example.com/timeshift?username=REDACTED&password=REDACTED")
        );
        assert_eq!(
            loaded[0].extinf_line,
            "#EXTINF:-1 catchup-source=\"?token=REDACTED&start=REDACTED\",Secret"
        );

        let _ = std::fs::remove_file(&checkpoint_file);
    }
}
