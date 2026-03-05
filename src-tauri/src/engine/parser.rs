use regex::Regex;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::path::Path;

use crate::error::AppError;
use crate::models::channel::{Channel, ContentType};
use crate::models::playlist::PlaylistPreview;

const PLAYLIST_GROUP_PREFIX: &str = "Playlist: ";
const MAX_PLAYLIST_DISCOVERY_DEPTH: usize = 64;

pub fn find_unquoted_comma(input: &str) -> Option<usize> {
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

/// Parse key-value attributes from an #EXTINF line header.
pub fn parse_extinf_attributes(extinf_line: &str) -> Vec<(String, String)> {
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

fn extinf_attribute_value(extinf_line: &str, key: &str) -> Option<String> {
    if !extinf_line.starts_with("#EXTINF") {
        return None;
    }

    parse_extinf_attributes(extinf_line)
        .into_iter()
        .find_map(|(candidate_key, candidate_value)| {
            (candidate_key == key).then_some(candidate_value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

pub fn extract_tvg_metadata(
    extinf_line: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    (
        extinf_attribute_value(extinf_line, "tvg-id"),
        extinf_attribute_value(extinf_line, "tvg-name"),
        extinf_attribute_value(extinf_line, "tvg-logo"),
        extinf_attribute_value(extinf_line, "tvg-chno"),
    )
}

fn normalize_language_candidate(raw: &str) -> Option<String> {
    let first = raw
        .split(['|', ',', ';', '/'])
        .next()
        .map(str::trim)
        .unwrap_or("");
    if first.is_empty() {
        return None;
    }

    let bracket_trimmed = first
        .trim_matches(|c: char| {
            c == '[' || c == ']' || c == '(' || c == ')' || c == '{' || c == '}'
        })
        .trim();
    if bracket_trimmed.is_empty() {
        return None;
    }

    let primary = bracket_trimmed
        .split(['-', '_'])
        .next()
        .map(str::trim)
        .unwrap_or(bracket_trimmed);
    if primary.len() >= 2 && primary.len() <= 3 && primary.chars().all(|c| c.is_ascii_alphabetic())
    {
        return Some(primary.to_ascii_uppercase());
    }

    match primary.to_ascii_lowercase().as_str() {
        "english" => Some("EN".to_string()),
        "french" => Some("FR".to_string()),
        "arabic" => Some("AR".to_string()),
        "german" => Some("DE".to_string()),
        "spanish" => Some("ES".to_string()),
        "italian" => Some("IT".to_string()),
        "portuguese" => Some("PT".to_string()),
        "russian" => Some("RU".to_string()),
        "turkish" => Some("TR".to_string()),
        "dutch" => Some("NL".to_string()),
        "polish" => Some("PL".to_string()),
        _ => None,
    }
}

fn extract_prefixed_language(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((token, _)) = rest.split_once(']') {
            return normalize_language_candidate(token);
        }
    }
    if let Some(rest) = trimmed.strip_prefix('(') {
        if let Some((token, _)) = rest.split_once(')') {
            return normalize_language_candidate(token);
        }
    }

    let mut token = String::new();
    let mut end = 0usize;
    for (index, ch) in trimmed.char_indices() {
        if !ch.is_ascii_alphabetic() {
            break;
        }
        if token.len() >= 3 {
            break;
        }
        token.push(ch);
        end = index + ch.len_utf8();
    }

    if token.len() < 2 || token.len() > 3 {
        return None;
    }

    let rest = trimmed[end..].trim_start();
    let starts_with_separator = rest
        .chars()
        .next()
        .map(|ch| {
            matches!(
                ch,
                ':' | '|' | '-' | '/' | '▎' | '•' | '·' | '_' | '—' | '–'
            )
        })
        .unwrap_or(false);
    if !starts_with_separator {
        return None;
    }

    normalize_language_candidate(&token)
}

pub fn detect_channel_language(group: &str, name: &str, extinf_line: &str) -> Option<String> {
    if extinf_line.starts_with("#EXTINF") {
        for (key, value) in parse_extinf_attributes(extinf_line) {
            if matches!(
                key.as_str(),
                "tvg-language" | "tvg-lang" | "language" | "lang" | "tvg-country"
            ) {
                if let Some(language) = normalize_language_candidate(&value) {
                    return Some(language);
                }
            }
        }
    }

    extract_prefixed_language(group).or_else(|| extract_prefixed_language(name))
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

fn compile_channel_search_pattern(
    channel_search: &Option<String>,
) -> Result<Option<Regex>, AppError> {
    if let Some(search) = channel_search.as_ref() {
        return Ok(Some(Regex::new(&format!("(?i){}", search)).map_err(
            |e| AppError::Parse(format!("Invalid regex '{}': {}", search, e)),
        )?));
    }
    Ok(None)
}

fn content_type_totals(channels: &[Channel]) -> (usize, usize, usize) {
    let mut live = 0usize;
    let mut movie = 0usize;
    let mut series = 0usize;

    for channel in channels {
        match channel.content_type {
            ContentType::Live => live += 1,
            ContentType::Movie => movie += 1,
            ContentType::Series => series += 1,
        }
    }

    (live, movie, series)
}

fn parse_playlist_reader<R: BufRead>(
    reader: R,
    file_path: &str,
    playlist_name: String,
    group_filter: &Option<String>,
    pattern: &Option<Regex>,
) -> Result<PlaylistPreview, AppError> {
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

            if is_line_needed(&line, group_filter, pattern) {
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
                let language = detect_channel_language(&group, &name, &extinf_line);
                let (tvg_id, tvg_name, tvg_logo, tvg_chno) = extract_tvg_metadata(&extinf_line);
                let content_type = ContentType::detect_from_url(&line);
                channels.push(Channel {
                    index: source_index,
                    playlist: playlist_name.clone(),
                    name,
                    group,
                    language,
                    tvg_id,
                    tvg_name,
                    tvg_logo,
                    tvg_chno,
                    url: line,
                    content_type,
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
    let (live_count, movie_count, series_count) = content_type_totals(&channels);
    Ok(PlaylistPreview {
        file_path: file_path.to_string(),
        file_name: playlist_name,
        source_identity: None,
        server_location: None,
        xtream_max_connections: None,
        xtream_account_info: None,
        total_channels: channels.len(),
        live_count,
        movie_count,
        series_count,
        groups: groups.into_iter().collect(),
        channels,
    })
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
    let pattern = compile_channel_search_pattern(channel_search)?;

    parse_playlist_reader(reader, file_path, playlist_name, group_filter, &pattern)
}

/// Parse M3U/M3U8 data from memory (used by fuzz targets and in-memory tests).
pub fn parse_m3u(
    input: &[u8],
    playlist_name: &str,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let pattern = compile_channel_search_pattern(channel_search)?;
    let reader = std::io::BufReader::new(std::io::Cursor::new(input));
    parse_playlist_reader(
        reader,
        "<memory>",
        playlist_name.to_string(),
        group_filter,
        &pattern,
    )
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

    let pattern = compile_channel_search_pattern(channel_search)?;

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

    let (live_count, movie_count, series_count) = content_type_totals(&channels);
    Ok(PlaylistPreview {
        file_path: dir_path.to_string(),
        file_name: dir_name,
        source_identity: None,
        server_location: None,
        xtream_max_connections: None,
        xtream_account_info: None,
        total_channels: channels.len(),
        live_count,
        movie_count,
        series_count,
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
    collect_playlists_recursive(path, &mut playlists, 0)?;

    Ok(playlists)
}

fn collect_playlists_recursive(
    path: &Path,
    playlists: &mut Vec<String>,
    depth: usize,
) -> Result<(), AppError> {
    if depth > MAX_PLAYLIST_DISCOVERY_DEPTH {
        return Err(AppError::Parse(format!(
            "Directory nesting exceeds maximum depth of {}",
            MAX_PLAYLIST_DISCOVERY_DEPTH
        )));
    }

    let mut entries: Vec<_> = std::fs::read_dir(path)
        .map_err(AppError::Io)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let entry_path = entry.path();
        let file_type = entry.file_type().map_err(AppError::Io)?;
        if file_type.is_dir() {
            collect_playlists_recursive(&entry_path, playlists, depth + 1)?;
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
    fn test_detect_channel_language_prefers_attributes_then_prefixes() {
        assert_eq!(
            detect_channel_language(
                "FR: Sports",
                "FR | News Channel",
                "#EXTINF:-1 tvg-language=\"en\",Sample"
            ),
            Some("EN".to_string())
        );
        assert_eq!(
            detect_channel_language("AR ▎ Movies", "Sample Channel", "#EXTINF:-1,Sample"),
            Some("AR".to_string())
        );
        assert_eq!(
            detect_channel_language("Unknown", "EN | Sample Channel", "#EXTINF:-1,Sample"),
            Some("EN".to_string())
        );
    }

    #[test]
    fn test_extract_tvg_metadata_reads_extinf_attributes() {
        let extinf =
            "#EXTINF:-1 tvg-id=\"epg-1\" tvg-name=\"Channel Name\" tvg-logo=\"http://img/logo.png\" tvg-chno=\"101\",Channel Name";
        let (tvg_id, tvg_name, tvg_logo, tvg_chno) = extract_tvg_metadata(extinf);
        assert_eq!(tvg_id.as_deref(), Some("epg-1"));
        assert_eq!(tvg_name.as_deref(), Some("Channel Name"));
        assert_eq!(tvg_logo.as_deref(), Some("http://img/logo.png"));
        assert_eq!(tvg_chno.as_deref(), Some("101"));
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
        assert_eq!(preview.live_count, 2);
        assert_eq!(preview.movie_count, 0);
        assert_eq!(preview.series_count, 0);
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

    #[test]
    fn test_parse_m3u_from_memory() {
        let payload =
            b"#EXTM3U\n#EXTINF:-1 tvg-id=\"epg-1\" tvg-name=\"Channel One HD\" tvg-logo=\"http://example.com/logo.png\" tvg-chno=\"42\" group-title=\"News\",Channel One\nhttp://example.com/live.m3u8\n";
        let parsed = parse_m3u(payload, "memory-playlist.m3u8", &None, &None)
            .expect("in-memory parser should succeed");

        assert_eq!(parsed.file_path, "<memory>");
        assert_eq!(parsed.file_name, "memory-playlist.m3u8");
        assert_eq!(parsed.total_channels, 1);
        assert_eq!(parsed.live_count, 1);
        assert_eq!(parsed.movie_count, 0);
        assert_eq!(parsed.series_count, 0);
        assert_eq!(parsed.channels[0].name, "Channel One");
        assert_eq!(parsed.channels[0].group, "News");
        assert_eq!(parsed.channels[0].language, None);
        assert_eq!(parsed.channels[0].tvg_id.as_deref(), Some("epg-1"));
        assert_eq!(
            parsed.channels[0].tvg_name.as_deref(),
            Some("Channel One HD")
        );
        assert_eq!(
            parsed.channels[0].tvg_logo.as_deref(),
            Some("http://example.com/logo.png")
        );
        assert_eq!(parsed.channels[0].tvg_chno.as_deref(), Some("42"));
        assert_eq!(parsed.channels[0].url, "http://example.com/live.m3u8");
    }

    #[test]
    fn test_parse_m3u_detects_language_from_group_and_name_prefixes() {
        let payload = b"#EXTM3U\n#EXTINF:-1 group-title=\"FR: Sports\",France Sports\nhttp://example.com/fr.m3u8\n#EXTINF:-1 group-title=\"Other\",EN | World News\nhttp://example.com/en.m3u8\n";

        let parsed = parse_m3u(payload, "languages.m3u8", &None, &None)
            .expect("in-memory parser should succeed");

        assert_eq!(parsed.total_channels, 2);
        assert_eq!(parsed.channels[0].language.as_deref(), Some("FR"));
        assert_eq!(parsed.channels[1].language.as_deref(), Some("EN"));
    }

    #[test]
    fn test_parse_m3u_detects_live_movie_and_series_content_types() {
        let payload = b"#EXTM3U\n#EXTINF:-1 group-title=\"Live\",Live One\nhttp://server/user/pass/100\n#EXTINF:-1 group-title=\"Movies\",Movie One\nhttp://server/movie/user/pass/200.mp4\n#EXTINF:-1 group-title=\"Series\",Series One\nhttp://server/series/user/pass/300.mkv\n";

        let parsed =
            parse_m3u(payload, "content-types.m3u8", &None, &None).expect("parse should succeed");

        assert_eq!(parsed.total_channels, 3);
        assert_eq!(parsed.live_count, 1);
        assert_eq!(parsed.movie_count, 1);
        assert_eq!(parsed.series_count, 1);
        assert_eq!(parsed.channels[0].content_type, ContentType::Live);
        assert_eq!(parsed.channels[1].content_type, ContentType::Movie);
        assert_eq!(parsed.channels[2].content_type, ContentType::Series);
    }

    #[test]
    fn test_find_playlists_in_dir_enforces_depth_limit() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-parser-depth-{unique}"));
        std::fs::create_dir_all(&root).expect("root fixture dir should be created");

        let mut nested = root.clone();
        for level in 0..=MAX_PLAYLIST_DISCOVERY_DEPTH + 1 {
            nested = nested.join(format!("d{}", level));
            std::fs::create_dir_all(&nested).expect("nested fixture dir should be created");
        }
        std::fs::write(
            nested.join("too-deep.m3u8"),
            "#EXTM3U\n#EXTINF:-1,Deep\nhttp://example.com/deep.m3u8\n",
        )
        .expect("deep fixture file should be writable");

        let error = find_playlists_in_dir(&root.to_string_lossy())
            .expect_err("depth guard should reject deeply nested directories");
        assert!(error
            .to_string()
            .contains("Directory nesting exceeds maximum depth"));

        std::fs::remove_dir_all(root).expect("fixture directory should be removable");
    }
}
