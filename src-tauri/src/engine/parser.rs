use regex::Regex;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::path::Path;

use crate::error::AppError;
use crate::models::channel::Channel;
use crate::models::playlist::PlaylistPreview;

const PLAYLIST_GROUP_PREFIX: &str = "Playlist: ";

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
    if path.is_dir() {
        return parse_playlist_directory(file_path, group_filter, channel_search);
    }

    log::info!("Parsing playlist: {}", file_path);
    let file = std::fs::File::open(path).map_err(AppError::Io)?;
    let reader = std::io::BufReader::new(file);
    let playlist_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string());

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
    let mut source_index = 0usize;
    let mut pending_channel = false;
    let mut pending_extinf: Option<String> = None;
    let mut pending_metadata: Vec<String> = Vec::new();

    for raw_line in reader.split(b'\n') {
        let raw_line = raw_line.map_err(AppError::Io)?;
        let mut line = String::from_utf8_lossy(&raw_line).to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        let line = line.trim().to_string();

        if line.starts_with("#EXTINF") {
            // A new EXTINF supersedes any pending entry that never got a stream URL.
            pending_channel = true;
            pending_extinf = None;
            pending_metadata.clear();

            // Always collect groups for the filter dropdown, even for skipped channels.
            groups.insert(get_group_name(&line));

            if is_line_needed(&line, group_filter, &pattern) {
                pending_extinf = Some(line);
            }
            continue;
        }

        if pending_channel {
            if line.is_empty() || line.starts_with('#') {
                if pending_extinf.is_some() {
                    pending_metadata.push(line);
                }
                continue;
            }

            if let Some(extinf_line) = pending_extinf.take() {
                let name = get_channel_name(&extinf_line);
                let group = get_group_name(&extinf_line);
                channels.push(Channel {
                    index: source_index,
                    playlist: playlist_name.clone(),
                    name,
                    group,
                    url: line,
                    extinf_line,
                    metadata_lines: std::mem::take(&mut pending_metadata),
                });
            }

            pending_channel = false;
            source_index += 1;
        }
    }

    log::info!(
        "Parsed {} channels in {} groups",
        channels.len(),
        groups.len()
    );
    Ok(PlaylistPreview {
        file_path: file_path.to_string(),
        file_name: playlist_name,
        source_identity: None,
        total_channels: channels.len(),
        groups: groups.into_iter().collect(),
        channels,
    })
}

fn parse_playlist_directory(
    dir_path: &str,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let files = find_playlists_in_dir(dir_path)?;
    if files.is_empty() {
        return Err(AppError::FileNotFound(
            "No .m3u/.m3u8 files found in directory".to_string(),
        ));
    }

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
    let mut source_index = 0usize;

    for file in files {
        let parsed = parse_playlist(&file, &None, &None)?;
        for mut channel in parsed.channels {
            let playlist_group = format!("{}{}", PLAYLIST_GROUP_PREFIX, channel.playlist);
            groups.insert(channel.group.clone());
            groups.insert(playlist_group.clone());

            let include_group = if let Some(ref selected_group) = group_filter {
                let selected = selected_group.trim().to_lowercase();
                channel.group.trim().to_lowercase() == selected
                    || playlist_group.trim().to_lowercase() == selected
            } else {
                true
            };

            let include_search = if let Some(ref pat) = pattern {
                pat.is_match(&channel.name)
            } else {
                true
            };

            channel.index = source_index;
            source_index += 1;

            if include_group && include_search {
                channels.push(channel);
            }
        }
    }

    let dir_name = Path::new(dir_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| dir_path.to_string());

    Ok(PlaylistPreview {
        file_path: dir_path.to_string(),
        file_name: dir_name,
        source_identity: None,
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
    collect_playlists_recursive(path, &mut playlists)?;

    Ok(playlists)
}

fn collect_playlists_recursive(path: &Path, playlists: &mut Vec<String>) -> Result<(), AppError> {
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .map_err(AppError::Io)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let entry_path = entry.path();
        let file_type = entry.file_type().map_err(AppError::Io)?;
        if file_type.is_dir() {
            collect_playlists_recursive(&entry_path, playlists)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        if let Some(ext) = entry_path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if ext_lower == "m3u" || ext_lower == "m3u8" {
                playlists.push(entry_path.to_string_lossy().to_string());
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn test_parse_playlist_streaming_preserves_behavior() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-parser-streaming-{unique}.m3u8"));

        let playlist = "\
#EXTM3U
#EXTINF:-1 group-title=\"Sports\",Channel One
#KODIPROP:inputstream=ffmpegdirect
http://example.com/one.m3u8
#EXTINF:-1 group-title=\"News\",Channel Two
http://example.com/two.m3u8
#EXTINF:-1 group-title=\"Sports\",No URL
#EXTINF:-1 group-title=\"Sports\",Channel Three
http://example.com/three.m3u8
";

        std::fs::write(&path, playlist).expect("playlist fixture should be writable");

        let group_filter = Some("Sports".to_string());
        let preview = parse_playlist(&path.to_string_lossy(), &group_filter, &None)
            .expect("streaming parser should parse fixture");

        assert_eq!(preview.total_channels, 2);
        assert_eq!(preview.channels[0].name, "Channel One");
        assert_eq!(
            preview.channels[0].metadata_lines,
            vec!["#KODIPROP:inputstream=ffmpegdirect"]
        );
        assert_eq!(preview.channels[1].name, "Channel Three");
        assert!(preview.groups.contains(&"Sports".to_string()));
        assert!(preview.groups.contains(&"News".to_string()));

        std::fs::remove_file(path).expect("fixture file should be removable");
    }

    #[test]
    fn test_parse_playlist_keeps_stable_indices_across_filters() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-parser-stable-index-{unique}.m3u8"));

        let playlist = "\
#EXTM3U
#EXTINF:-1 group-title=\"Sports\",Channel One
http://example.com/one.m3u8
#EXTINF:-1 group-title=\"News\",Channel Two
http://example.com/two.m3u8
#EXTINF:-1 group-title=\"Sports\",Channel Three
http://example.com/three.m3u8
";

        std::fs::write(&path, playlist).expect("playlist fixture should be writable");

        let unfiltered = parse_playlist(&path.to_string_lossy(), &None, &None)
            .expect("unfiltered parse should succeed");
        assert_eq!(
            unfiltered
                .channels
                .iter()
                .map(|c| c.index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        let sports = parse_playlist(&path.to_string_lossy(), &Some("Sports".to_string()), &None)
            .expect("group filtered parse should succeed");
        assert_eq!(
            sports.channels.iter().map(|c| c.index).collect::<Vec<_>>(),
            vec![0, 2]
        );

        let searched = parse_playlist(&path.to_string_lossy(), &None, &Some("Three".to_string()))
            .expect("search filtered parse should succeed");
        assert_eq!(
            searched
                .channels
                .iter()
                .map(|c| c.index)
                .collect::<Vec<_>>(),
            vec![2]
        );

        std::fs::remove_file(path).expect("fixture file should be removable");
    }

    #[test]
    fn test_parse_playlist_directory_combines_sources_recursively() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-parser-dir-{unique}"));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).expect("nested fixture dir should be created");

        let first = root.join("first.m3u8");
        let second = nested.join("second.m3u");
        std::fs::write(
            &first,
            "\
#EXTM3U
#EXTINF:-1 group-title=\"Sports\",Alpha
http://example.com/alpha.m3u8
",
        )
        .expect("first fixture should be writable");
        std::fs::write(
            &second,
            "\
#EXTM3U
#EXTINF:-1 group-title=\"News\",Beta
http://example.com/beta.m3u8
",
        )
        .expect("second fixture should be writable");

        let preview = parse_playlist(&root.to_string_lossy(), &None, &None)
            .expect("directory parse should succeed");
        assert_eq!(preview.total_channels, 2);
        assert_eq!(
            preview
                .channels
                .iter()
                .map(|channel| channel.index)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(
            preview
                .channels
                .iter()
                .map(|channel| channel.playlist.clone())
                .collect::<Vec<_>>(),
            vec!["first.m3u8".to_string(), "second.m3u".to_string()]
        );
        assert!(preview.groups.contains(&"Sports".to_string()));
        assert!(preview.groups.contains(&"News".to_string()));
        assert!(preview.groups.contains(&"Playlist: first.m3u8".to_string()));
        assert!(preview.groups.contains(&"Playlist: second.m3u".to_string()));

        let playlist_filtered = parse_playlist(
            &root.to_string_lossy(),
            &Some("Playlist: second.m3u".to_string()),
            &None,
        )
        .expect("playlist-filtered directory parse should succeed");
        assert_eq!(playlist_filtered.total_channels, 1);
        assert_eq!(playlist_filtered.channels[0].name, "Beta");
        assert_eq!(playlist_filtered.channels[0].index, 1);

        std::fs::remove_dir_all(root).expect("fixture directory should be removable");
    }
}
