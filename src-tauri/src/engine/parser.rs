use regex::Regex;
use std::collections::BTreeSet;
use std::path::Path;

use crate::error::AppError;
use crate::models::channel::Channel;
use crate::models::playlist::PlaylistPreview;

fn find_unquoted_comma(input: &str) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut quoted_by: Option<u8> = None;
    let mut escaped = false;

    for (i, &byte) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }

        if quoted_by.is_some() && byte == b'\\' {
            escaped = true;
            continue;
        }

        match quoted_by {
            Some(quote) if byte == quote => quoted_by = None,
            None if byte == b'"' || byte == b'\'' => quoted_by = Some(byte),
            None if byte == b',' => return Some(i),
            _ => {}
        }
    }

    None
}

fn parse_extinf_attributes(extinf_line: &str) -> Vec<(String, String)> {
    let header_end = find_unquoted_comma(extinf_line).unwrap_or(extinf_line.len());
    let header = &extinf_line[..header_end];
    let payload = header
        .split_once(':')
        .map(|(_, after_colon)| after_colon)
        .unwrap_or(header);

    let bytes = payload.as_bytes();
    let mut i = 0usize;
    let mut attrs = Vec::new();

    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == b',' {
            i += 1;
            continue;
        }

        let key_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b','
        {
            i += 1;
        }
        let key_end = i;

        let mut eq_pos = i;
        while eq_pos < bytes.len() && bytes[eq_pos].is_ascii_whitespace() {
            eq_pos += 1;
        }
        if eq_pos >= bytes.len() || bytes[eq_pos] != b'=' {
            i = key_end;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b',' {
                i += 1;
            }
            continue;
        }
        i = eq_pos + 1;

        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || key_start == key_end {
            continue;
        }

        let value = if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            let value_start = i;
            let mut escaped = false;
            while i < bytes.len() {
                let byte = bytes[i];
                if escaped {
                    escaped = false;
                    i += 1;
                    continue;
                }
                if byte == b'\\' {
                    escaped = true;
                    i += 1;
                    continue;
                }
                if byte == quote {
                    break;
                }
                i += 1;
            }

            let mut raw = payload[value_start..i].to_string();
            if quote == b'"' {
                raw = raw.replace("\\\"", "\"");
            } else {
                raw = raw.replace("\\'", "'");
            }
            raw = raw.replace("\\\\", "\\");

            if i < bytes.len() && bytes[i] == quote {
                i += 1;
            }
            raw.trim().to_string()
        } else {
            let value_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b',' {
                i += 1;
            }
            payload[value_start..i].trim().to_string()
        };

        let key = payload[key_start..key_end].trim().to_ascii_lowercase();
        if !key.is_empty() && !value.is_empty() {
            attrs.push((key, value));
        }
    }

    attrs
}

/// Extract channel name from #EXTINF line (text after the last comma).
pub fn get_channel_name(extinf_line: &str) -> String {
    if extinf_line.starts_with("#EXTINF") {
        if let Some(pos) = find_unquoted_comma(extinf_line) {
            let name = extinf_line[pos + 1..].trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    "Unknown Channel".to_string()
}

/// Extract group-title attribute from #EXTINF line.
pub fn get_group_name(extinf_line: &str) -> String {
    if extinf_line.starts_with("#EXTINF") {
        for (key, value) in parse_extinf_attributes(extinf_line) {
            if key == "group-title" {
                return value;
            }
        }
    }
    "Unknown Group".to_string()
}

/// Extract channel ID from the stream URL (last path segment, minus .ts extension).
pub fn get_channel_id(url: &str) -> String {
    if url.is_empty() {
        return "Unknown".to_string();
    }
    let segment = url.rsplit('/').next().unwrap_or("Unknown");
    if segment.is_empty() {
        return "Unknown".to_string();
    }
    segment.replace(".ts", "")
}

/// Return (stream_url, metadata_lines, end_index) for a channel entry starting at extinf_index.
fn get_channel_stream_entry(
    lines: &[String],
    extinf_index: usize,
) -> (Option<String>, Vec<String>, usize) {
    let mut metadata_lines = Vec::new();
    let mut j = extinf_index + 1;
    while j < lines.len() {
        let candidate = lines[j].trim();
        if candidate.starts_with("#EXTINF") {
            return (None, metadata_lines, j.saturating_sub(1));
        }
        if candidate.is_empty() || candidate.starts_with('#') {
            metadata_lines.push(candidate.to_string());
            j += 1;
            continue;
        }
        return (Some(candidate.to_string()), metadata_lines, j);
    }
    (None, metadata_lines, lines.len().saturating_sub(1))
}

/// Check if an #EXTINF line matches the group filter and channel name pattern.
fn is_line_needed(line: &str, group_filter: &Option<String>, pattern: &Option<Regex>) -> bool {
    if !line.starts_with("#EXTINF") {
        return false;
    }
    if let Some(ref group) = group_filter {
        let group_name = get_group_name(line);
        if group_name.trim().to_lowercase() != group.trim().to_lowercase() {
            return false;
        }
    }
    if let Some(ref pat) = pattern {
        let channel_name = get_channel_name(line);
        if !pat.is_match(&channel_name) {
            return false;
        }
    }
    true
}

/// Parse an M3U/M3U8 file and return a PlaylistPreview.
pub fn parse_playlist(
    file_path: &str,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(AppError::FileNotFound(file_path.to_string()));
    }

    log::info!("Parsing playlist: {}", file_path);
    let content = std::fs::read(path).map_err(AppError::Io)?;
    // Read with replacement for invalid UTF-8 bytes
    let content = String::from_utf8_lossy(&content).to_string();
    let lines: Vec<String> = content.lines().map(|l| l.trim().to_string()).collect();

    let pattern = if let Some(ref search) = channel_search {
        Some(
            Regex::new(&format!("(?i){}", search))
                .map_err(|e| AppError::Parse(format!("Invalid regex '{}': {}", search, e)))?,
        )
    } else {
        None
    };

    let mut channels = Vec::new();
    let mut groups = BTreeSet::new();
    let mut index = 0usize;
    let mut i = 0;

    while i < lines.len() {
        let line = &lines[i];
        if is_line_needed(line, group_filter, &pattern) {
            let (stream_url, metadata_lines, end_index) = get_channel_stream_entry(&lines, i);
            if let Some(url) = stream_url {
                let name = get_channel_name(line);
                let group = get_group_name(line);
                groups.insert(group.clone());
                channels.push(Channel {
                    index,
                    name,
                    group,
                    url,
                    extinf_line: line.to_string(),
                    metadata_lines,
                });
                index += 1;
            }
            i = end_index.max(i);
        } else if line.starts_with("#EXTINF") {
            // Not matching but still collect group names for the filter dropdown
            let group = get_group_name(line);
            groups.insert(group);
        }
        i += 1;
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string());

    log::info!(
        "Parsed {} channels in {} groups",
        channels.len(),
        groups.len()
    );
    Ok(PlaylistPreview {
        file_path: file_path.to_string(),
        file_name,
        total_channels: channels.len(),
        groups: groups.into_iter().collect(),
        channels,
    })
}

/// Find all .m3u/.m3u8 files in a directory.
pub fn find_playlists_in_dir(dir_path: &str) -> Result<Vec<String>, AppError> {
    let path = Path::new(dir_path);
    if !path.is_dir() {
        return Err(AppError::FileNotFound(format!(
            "Not a directory: {}",
            dir_path
        )));
    }

    let mut playlists = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .map_err(AppError::Io)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let entry_path = entry.path();
        if entry_path.is_file() {
            if let Some(ext) = entry_path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if ext_lower == "m3u" || ext_lower == "m3u8" {
                    playlists.push(entry_path.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(playlists)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_channel_name() {
        assert_eq!(get_channel_name("#EXTINF:-1,ESPN HD"), "ESPN HD");
        assert_eq!(
            get_channel_name("#EXTINF:-1 group-title=\"Sports\",BBC One"),
            "BBC One"
        );
        assert_eq!(
            get_channel_name(
                "#EXTINF:-1 tvg-name=\"News, International\" group-title=\"World\",Channel, HD"
            ),
            "Channel, HD"
        );
        assert_eq!(get_channel_name("not an extinf line"), "Unknown Channel");
    }

    #[test]
    fn test_get_group_name() {
        assert_eq!(
            get_group_name("#EXTINF:-1 group-title=\"Sports\",ESPN"),
            "Sports"
        );
        assert_eq!(
            get_group_name("#EXTINF:-1 group-title='Kids & Family',Cartoon"),
            "Kids & Family"
        );
        assert_eq!(
            get_group_name("#EXTINF:-1 group-title=Documentary,HistoryTV"),
            "Documentary"
        );
        assert_eq!(
            get_group_name("#EXTINF:-1 group-title = \"Sports Plus\",ESPN"),
            "Sports Plus"
        );
        assert_eq!(get_group_name("#EXTINF:-1,ESPN"), "Unknown Group");
    }

    #[test]
    fn test_get_channel_id() {
        assert_eq!(get_channel_id("http://example.com/live/123.ts"), "123");
        assert_eq!(get_channel_id("http://example.com/live/stream"), "stream");
        assert_eq!(get_channel_id(""), "Unknown");
    }
}
