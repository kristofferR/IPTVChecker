use std::collections::HashSet;
use std::path::Path;

use crate::error::AppError;

/// Load processed channels from a checkpoint log file.
/// Returns (set of "channel_name stream_url" identifiers, last_index).
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
        if let Some((index_part, identifier)) = line.split_once(" - ") {
            let index_str = index_part.trim().split_whitespace().next().unwrap_or("");
            if let Ok(idx) = index_str.parse::<usize>() {
                last_index = last_index.max(idx);
            }
            processed.insert(identifier.trim().to_string());
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
