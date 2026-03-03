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
        if let Some(url) = line.split_whitespace().rev().find(|t| t.starts_with("http://") || t.starts_with("https://")) {
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

    let serialized = serde_json::to_string(result)
        .map_err(|error| AppError::Parse(format!("Failed to serialize checkpoint result: {}", error)))?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(checkpoint_file)
        .map_err(AppError::Io)?;

    writeln!(file, "{}", serialized).map_err(AppError::Io)?;
    Ok(())
}
