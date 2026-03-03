use std::collections::HashSet;
use std::path::Path;

use crate::error::AppError;

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
