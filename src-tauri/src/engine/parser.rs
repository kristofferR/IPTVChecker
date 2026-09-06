use std::collections::{BTreeMap, BTreeSet};
use std::io::BufRead;
use std::path::Path;

use url::Url;

use crate::engine::search_pattern::ChannelSearchPattern;
use crate::error::AppError;
use crate::models::channel::{Channel, ContentType};
use crate::models::playlist::PlaylistPreview;

const PLAYLIST_GROUP_PREFIX: &str = "Playlist: ";
const MAX_PLAYLIST_DISCOVERY_DEPTH: usize = 64;

fn epg_sources_for_channels(
    epg_sources: &[String],
    epg_sources_by_playlist: &BTreeMap<String, Vec<String>>,
    channels: &[Channel],
) -> (Vec<String>, BTreeMap<String, Vec<String>>) {
    let represented_playlists = channels
        .iter()
        .map(|channel| channel.playlist.as_str())
        .collect::<BTreeSet<_>>();
    let filtered_by_playlist = epg_sources_by_playlist
        .iter()
        .filter(|(playlist, _)| represented_playlists.contains(playlist.as_str()))
        .map(|(playlist, sources)| (playlist.clone(), sources.clone()))
        .collect::<BTreeMap<_, _>>();
    let represented_sources = filtered_by_playlist
        .values()
        .flatten()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let filtered_sources = epg_sources
        .iter()
        .filter(|source| represented_sources.contains(source.as_str()))
        .cloned()
        .collect();
    (filtered_sources, filtered_by_playlist)
}

/// Escape provider-supplied text before embedding it in a generated EXTINF
/// line. Newlines are flattened so a value cannot inject extra playlist tags.
pub(crate) fn escape_extinf_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\r', '\n'], " ")
}

/// Flatten line breaks in an EXTINF display title without changing visible
/// quotes or backslashes, which are not special after the metadata comma.
pub(crate) fn flatten_extinf_title(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

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

fn parse_attributes(payload: &str, comma_terminates_unquoted_value: bool) -> Vec<(String, String)> {
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
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && (!comma_terminates_unquoted_value || bytes[i] != b',')
            {
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

/// Parse key-value attributes from an #EXTINF line header.
pub fn parse_extinf_attributes(extinf_line: &str) -> Vec<(String, String)> {
    let header_end = find_unquoted_comma(extinf_line).unwrap_or(extinf_line.len());
    let header = &extinf_line[..header_end];
    let payload = header
        .split_once(':')
        .map(|(_, after_colon)| after_colon)
        .unwrap_or(header);
    parse_attributes(payload, true)
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

/// Parse a line's attributes once (or return empty for non-EXTINF lines).
/// The per-channel helpers below all take this pre-parsed list — the parse
/// hot loop must not re-walk the EXTINF line once per extracted field.
fn extinf_attributes_for(extinf_line: &str) -> Vec<(String, String)> {
    if extinf_line.starts_with("#EXTINF") {
        parse_extinf_attributes(extinf_line)
    } else {
        Vec::new()
    }
}

fn group_name_from_attrs(attrs: &[(String, String)]) -> String {
    attrs
        .iter()
        .find(|(key, _)| key == "group-title")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| "Unknown Group".to_string())
}

/// Extract group-title attribute from #EXTINF line.
pub fn get_group_name(extinf_line: &str) -> String {
    group_name_from_attrs(&extinf_attributes_for(extinf_line))
}

fn attr_value(attrs: &[(String, String)], key: &str) -> Option<String> {
    attrs
        .iter()
        .find_map(|(candidate_key, candidate_value)| {
            (candidate_key == key).then(|| candidate_value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn tvg_metadata_from_attrs(
    attrs: &[(String, String)],
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    (
        attr_value(attrs, "tvg-id"),
        attr_value(attrs, "tvg-name"),
        attr_value(attrs, "tvg-logo"),
        attr_value(attrs, "tvg-chno"),
    )
}

pub fn extract_tvg_metadata(
    extinf_line: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    tvg_metadata_from_attrs(&extinf_attributes_for(extinf_line))
}

/// Extract XMLTV EPG source URLs from a playlist `#EXTM3U` header line.
/// Both `x-tvg-url` and `url-tvg` occur in the wild, each possibly holding a
/// comma-separated list of URLs.
fn parse_header_epg_sources(header_line: &str) -> Vec<String> {
    let payload = header_line.strip_prefix("#EXTM3U").unwrap_or(header_line);
    let attrs = parse_attributes(payload, false);
    let mut sources = Vec::new();
    for key in ["x-tvg-url", "url-tvg"] {
        if let Some(value) = attr_value(&attrs, key) {
            let value = value.replace("&amp;", "&");
            for url in value.split(',') {
                let url = url.trim();
                if Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
                    && !sources.iter().any(|existing| existing == url)
                {
                    sources.push(url.to_string());
                }
            }
        }
    }
    sources
}

fn parse_catchup_days(raw: &str) -> Option<u32> {
    let digits: String = raw
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<u32>().ok().filter(|days| *days > 0)
}

/// Extract advertised catch-up metadata: `(type, days, source template)`.
///
/// `catchup-days`, `tvg-rec`, and `timeshift` all carry the archive depth in
/// days depending on the provider. A depth or source without an explicit type
/// still means the channel advertises catch-up, so the type defaults to
/// `default`; an explicitly disabled type suppresses everything.
fn catchup_metadata_from_attrs(
    attrs: &[(String, String)],
) -> (Option<String>, Option<u32>, Option<String>) {
    let kind = attr_value(attrs, "catchup")
        .or_else(|| attr_value(attrs, "catchup-type"))
        .map(|value| value.to_ascii_lowercase());
    if matches!(
        kind.as_deref(),
        Some("none" | "no" | "false" | "off" | "0" | "disabled")
    ) {
        return (None, None, None);
    }

    let days = ["catchup-days", "tvg-rec", "timeshift"]
        .iter()
        .find_map(|key| attr_value(attrs, key).and_then(|value| parse_catchup_days(&value)));
    let source = attr_value(attrs, "catchup-source");

    let kind = kind.or_else(|| (days.is_some() || source.is_some()).then(|| "default".to_string()));
    (kind, days, source)
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

fn language_from_attrs(attrs: &[(String, String)], group: &str, name: &str) -> Option<String> {
    for (key, value) in attrs {
        if matches!(
            key.as_str(),
            "tvg-language" | "tvg-lang" | "language" | "lang" | "tvg-country"
        ) {
            if let Some(language) = normalize_language_candidate(value) {
                return Some(language);
            }
        }
    }

    extract_prefixed_language(group).or_else(|| extract_prefixed_language(name))
}

pub fn detect_channel_language(group: &str, name: &str, extinf_line: &str) -> Option<String> {
    language_from_attrs(&extinf_attributes_for(extinf_line), group, name)
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
fn is_line_needed(
    line: &str,
    group_name: &str,
    group_filter: &Option<String>,
    pattern: &Option<ChannelSearchPattern>,
) -> Result<bool, AppError> {
    if !line.starts_with("#EXTINF") {
        return Ok(false);
    }
    if let Some(ref group) = group_filter {
        if group_name.trim().to_lowercase() != group.trim().to_lowercase() {
            return Ok(false);
        }
    }
    if let Some(ref pat) = pattern {
        let channel_name = get_channel_name(line);
        if !pat.is_match(&channel_name)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn compile_channel_search_pattern(
    channel_search: &Option<String>,
) -> Result<Option<ChannelSearchPattern>, AppError> {
    ChannelSearchPattern::compile(channel_search)
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

/// Derive a filtered preview from an already-parsed source while preserving
/// source indices and metadata. This avoids rereading very large playlists
/// when a scan adds only a group or channel-name filter.
pub fn filter_playlist_preview(
    preview: &PlaylistPreview,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let pattern = compile_channel_search_pattern(channel_search)?;
    let selected_group = group_filter
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase);
    let source_is_directory = Path::new(&preview.file_path).is_dir();

    let mut channels = Vec::new();
    for channel in &preview.channels {
        let include_group = selected_group.as_ref().is_none_or(|selected| {
            channel.group.trim().to_lowercase() == *selected
                || (source_is_directory
                    && format!("{PLAYLIST_GROUP_PREFIX}{}", channel.playlist)
                        .trim()
                        .to_lowercase()
                        == *selected)
        });
        if !include_group {
            continue;
        }

        if let Some(pattern) = &pattern {
            if !pattern.is_match(&channel.name)? {
                continue;
            }
        }
        channels.push(channel.clone());
    }

    let (live_count, movie_count, series_count) = content_type_totals(&channels);
    let (epg_sources, epg_sources_by_playlist) = if source_is_directory {
        epg_sources_for_channels(
            &preview.epg_sources,
            &preview.epg_sources_by_playlist,
            &channels,
        )
    } else {
        (
            preview.epg_sources.clone(),
            preview.epg_sources_by_playlist.clone(),
        )
    };
    Ok(PlaylistPreview {
        file_path: preview.file_path.clone(),
        file_name: preview.file_name.clone(),
        source_identity: preview.source_identity.clone(),
        saved_playlist_id: preview.saved_playlist_id.clone(),
        server_location: preview.server_location.clone(),
        single_provider: preview.single_provider,
        xtream_max_connections: preview.xtream_max_connections,
        xtream_account_info: preview.xtream_account_info.clone(),
        total_channels: channels.len(),
        live_count,
        movie_count,
        series_count,
        groups: preview.groups.clone(),
        epg_sources,
        epg_sources_by_playlist,
        channels,
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParseProgress {
    pub channels_found: usize,
    pub live_found: usize,
    pub movie_found: usize,
    pub series_found: usize,
}

/// An `#EXTINF` line awaiting its URL: `(raw line, parsed attributes, group)`.
/// Attributes are parsed once here rather than again per channel.
type PendingExtinf = (String, Vec<(String, String)>, String);

fn parse_playlist_reader<R: BufRead>(
    reader: R,
    file_path: &str,
    playlist_name: String,
    group_filter: &Option<String>,
    pattern: &Option<ChannelSearchPattern>,
    on_channel_parsed: Option<&dyn Fn(ParseProgress)>,
) -> Result<PlaylistPreview, AppError> {
    let mut channels = Vec::new();
    let mut groups = BTreeSet::new();
    let mut source_index = 0usize;
    let mut live_found = 0usize;
    let mut movie_found = 0usize;
    let mut series_found = 0usize;
    let mut pending_channel = false;
    let mut pending_extinf: Option<PendingExtinf> = None;
    let mut pending_metadata: Vec<String> = Vec::new();
    let mut orphaned_extinf = 0u32;
    let mut epg_sources: Vec<String> = Vec::new();

    for raw_line in reader.split(b'\n') {
        let raw_line = raw_line.map_err(AppError::Io)?;
        let mut line = String::from_utf8_lossy(&raw_line).to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        let line = line.trim().trim_start_matches('\u{feff}').to_string();

        if !pending_channel && line.starts_with("#EXTM3U") {
            for source in parse_header_epg_sources(&line) {
                if !epg_sources.contains(&source) {
                    epg_sources.push(source);
                }
            }
            continue;
        }

        if line.starts_with("#EXTINF") {
            // A new EXTINF supersedes any pending entry that never got a stream URL.
            if pending_channel && pending_extinf.is_some() {
                orphaned_extinf += 1;
            }
            pending_channel = true;
            pending_extinf = None;
            pending_metadata.clear();

            let attrs = parse_extinf_attributes(&line);
            let group = group_name_from_attrs(&attrs);
            // Always collect groups for the filter dropdown, even for skipped channels.
            groups.insert(group.clone());

            if is_line_needed(&line, &group, group_filter, pattern)? {
                pending_extinf = Some((line, attrs, group));
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

            let content_type = ContentType::detect_from_url(&line);
            match content_type {
                ContentType::Live => live_found += 1,
                ContentType::Movie => movie_found += 1,
                ContentType::Series => series_found += 1,
            }

            if let Some((extinf_line, attrs, group)) = pending_extinf.take() {
                let name = get_channel_name(&extinf_line);
                let language = language_from_attrs(&attrs, &group, &name);
                let (tvg_id, tvg_name, tvg_logo, tvg_chno) = tvg_metadata_from_attrs(&attrs);
                let (catchup, catchup_days, catchup_source) = catchup_metadata_from_attrs(&attrs);
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
                    catchup,
                    catchup_days,
                    catchup_source,
                    url: line,
                    content_type,
                    extinf_line,
                    metadata_lines: std::mem::take(&mut pending_metadata),
                });
            }

            pending_channel = false;
            source_index += 1;
            if let Some(cb) = &on_channel_parsed {
                cb(ParseProgress {
                    channels_found: source_index,
                    live_found,
                    movie_found,
                    series_found,
                });
            }
        }
    }

    if pending_channel && pending_extinf.is_some() {
        orphaned_extinf += 1;
    }
    if orphaned_extinf > 0 {
        log::warn!(
            "{}: {orphaned_extinf} EXTINF entry/entries had no stream URL and were skipped",
            file_path
        );
    }
    log::info!(
        "Parsed {} channels in {} groups",
        channels.len(),
        groups.len()
    );
    let (live_count, movie_count, series_count) = content_type_totals(&channels);
    let epg_sources_by_playlist = BTreeMap::from([(playlist_name.clone(), epg_sources.clone())]);
    Ok(PlaylistPreview {
        file_path: file_path.to_string(),
        file_name: playlist_name,
        epg_sources,
        epg_sources_by_playlist,
        source_identity: None,
        saved_playlist_id: None,
        server_location: None,
        single_provider: false,
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
    parse_playlist_with_progress(file_path, group_filter, channel_search, None)
}

pub fn parse_playlist_with_progress(
    file_path: &str,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
    on_channel_parsed: Option<&dyn Fn(ParseProgress)>,
) -> Result<PlaylistPreview, AppError> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(AppError::FileNotFound(file_path.to_string()));
    }
    if path.is_dir() {
        return parse_playlist_directory(
            file_path,
            group_filter,
            channel_search,
            on_channel_parsed,
        );
    }

    log::info!("Parsing playlist: {}", file_path);
    let file = std::fs::File::open(path).map_err(AppError::Io)?;
    let reader = std::io::BufReader::new(file);
    let playlist_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string());
    let pattern = compile_channel_search_pattern(channel_search)?;

    parse_playlist_reader(
        reader,
        file_path,
        playlist_name,
        group_filter,
        &pattern,
        on_channel_parsed,
    )
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
        None,
    )
}

fn parse_playlist_directory(
    dir_path: &str,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
    on_channel_parsed: Option<&dyn Fn(ParseProgress)>,
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
    let mut parsed_progress = ParseProgress::default();
    let mut epg_sources: Vec<String> = Vec::new();
    let mut epg_sources_by_playlist = BTreeMap::new();

    for file in files {
        let last_reported = std::cell::Cell::new(ParseProgress::default());
        let base_progress = parsed_progress;
        let child_progress = |child_count: ParseProgress| {
            last_reported.set(child_count);
            if let Some(cb) = on_channel_parsed {
                cb(ParseProgress {
                    channels_found: base_progress.channels_found + child_count.channels_found,
                    live_found: base_progress.live_found + child_count.live_found,
                    movie_found: base_progress.movie_found + child_count.movie_found,
                    series_found: base_progress.series_found + child_count.series_found,
                });
            }
        };
        let parsed = parse_playlist_with_progress(&file, &None, &None, Some(&child_progress))?;
        let playlist_id = Path::new(&file)
            .strip_prefix(dir_path)
            .unwrap_or_else(|_| Path::new(&file))
            .to_string_lossy()
            .replace('\\', "/");
        for source in &parsed.epg_sources {
            if !epg_sources.contains(source) {
                epg_sources.push(source.clone());
            }
        }
        epg_sources_by_playlist.insert(playlist_id.clone(), parsed.epg_sources.clone());
        let last = last_reported.get();
        parsed_progress = ParseProgress {
            channels_found: base_progress.channels_found + last.channels_found,
            live_found: base_progress.live_found + last.live_found,
            movie_found: base_progress.movie_found + last.movie_found,
            series_found: base_progress.series_found + last.series_found,
        };
        for mut channel in parsed.channels {
            channel.playlist.clone_from(&playlist_id);
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
                pat.is_match(&channel.name)?
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
    let (epg_sources, epg_sources_by_playlist) =
        epg_sources_for_channels(&epg_sources, &epg_sources_by_playlist, &channels);
    Ok(PlaylistPreview {
        file_path: dir_path.to_string(),
        file_name: dir_name,
        epg_sources,
        epg_sources_by_playlist,
        source_identity: None,
        saved_playlist_id: None,
        server_location: None,
        single_provider: false,
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
    fn escape_extinf_value_flattens_injected_lines_and_escapes_quotes() {
        assert_eq!(
            escape_extinf_value("News \\ \"HD\"\r\n#EXT-X-KEY"),
            "News \\\\ \\\"HD\\\"  #EXT-X-KEY"
        );
    }

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
    fn test_parse_header_epg_sources_reads_both_keys_and_lists() {
        assert_eq!(
            parse_header_epg_sources("#EXTM3U x-tvg-url=\"http://epg.example.com/guide.xml.gz\""),
            vec!["http://epg.example.com/guide.xml.gz".to_string()]
        );

        let line =
            "#EXTM3U x-tvg-url=\"http://a/epg.xml\" url-tvg=\"http://a/epg.xml,http://b/epg.xml\"";
        assert_eq!(
            parse_header_epg_sources(line),
            vec![
                "http://a/epg.xml".to_string(),
                "http://b/epg.xml".to_string()
            ]
        );

        assert_eq!(
            parse_header_epg_sources(
                "#EXTM3U x-tvg-url=http://a/epg.xml,http://b/epg.xml url-tvg=http://c/epg.xml"
            ),
            vec![
                "http://a/epg.xml".to_string(),
                "http://b/epg.xml".to_string(),
                "http://c/epg.xml".to_string()
            ]
        );

        assert!(parse_header_epg_sources("#EXTM3U").is_empty());
        assert!(parse_header_epg_sources("#EXTM3U x-tvg-url=\"not-a-url\"").is_empty());
        assert_eq!(
            parse_header_epg_sources("#EXTM3U x-tvg-url=\"HTTPS://epg.example.com/guide.xml\""),
            vec!["HTTPS://epg.example.com/guide.xml".to_string()]
        );
        assert_eq!(
            parse_header_epg_sources(
                "#EXTM3U x-tvg-url=\"https://epg.example.com/xmltv.php?username=u&amp;password=p\""
            ),
            vec!["https://epg.example.com/xmltv.php?username=u&password=p".to_string()]
        );
    }

    #[test]
    fn test_parse_m3u_reads_epg_sources_from_a_bom_prefixed_header() {
        let playlist = "\u{feff}#EXTM3U x-tvg-url=\"http://epg.example.com/guide.xml\"\n\
#EXTINF:-1,Channel One\n\
http://example.com/one.m3u8\n";

        let parsed = parse_m3u(playlist.as_bytes(), "bom.m3u8", &None, &None)
            .expect("BOM-prefixed playlist should parse");

        assert_eq!(
            parsed.epg_sources,
            vec!["http://epg.example.com/guide.xml".to_string()]
        );
    }

    #[test]
    fn test_catchup_metadata_reads_explicit_attributes() {
        let attrs = parse_extinf_attributes(
            "#EXTINF:-1 catchup=\"shift\" catchup-days=\"7\" catchup-source=\"http://x/${start}\",Ch",
        );
        assert_eq!(
            catchup_metadata_from_attrs(&attrs),
            (
                Some("shift".to_string()),
                Some(7),
                Some("http://x/${start}".to_string())
            )
        );
    }

    #[test]
    fn test_catchup_metadata_infers_default_type_from_day_aliases() {
        let rec = parse_extinf_attributes("#EXTINF:-1 tvg-rec=\"3\",Ch");
        assert_eq!(
            catchup_metadata_from_attrs(&rec),
            (Some("default".to_string()), Some(3), None)
        );

        let timeshift = parse_extinf_attributes("#EXTINF:-1 timeshift=\"5\",Ch");
        assert_eq!(
            catchup_metadata_from_attrs(&timeshift),
            (Some("default".to_string()), Some(5), None)
        );

        let none = parse_extinf_attributes("#EXTINF:-1 group-title=\"News\",Ch");
        assert_eq!(catchup_metadata_from_attrs(&none), (None, None, None));

        let invalid_then_valid = parse_extinf_attributes(
            "#EXTINF:-1 catchup-days=\"0\" tvg-rec=\"invalid\" timeshift=\"7\",Ch",
        );
        assert_eq!(
            catchup_metadata_from_attrs(&invalid_then_valid),
            (Some("default".to_string()), Some(7), None)
        );
    }

    #[test]
    fn test_catchup_metadata_respects_disabled_and_zero_values() {
        for value in ["none", "no", "false", "off", "0", "disabled"] {
            let line = format!("#EXTINF:-1 catchup=\"{value}\" catchup-days=\"7\",Ch");
            let disabled = parse_extinf_attributes(&line);
            assert_eq!(catchup_metadata_from_attrs(&disabled), (None, None, None));
        }

        let zero_days = parse_extinf_attributes("#EXTINF:-1 catchup-days=\"0\",Ch");
        assert_eq!(catchup_metadata_from_attrs(&zero_days), (None, None, None));
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
#EXTM3U x-tvg-url=\"http://epg.example.com/all.xml\"
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
        assert_eq!(
            preview.epg_sources,
            vec!["http://epg.example.com/all.xml".to_string()]
        );

        std::fs::remove_file(path).expect("fixture file should be removable");
    }

    #[test]
    fn test_filter_cached_preview_matches_filtered_parse() {
        let playlist = b"\
#EXTM3U
#EXTINF:-1 group-title=\"Sports\",Channel One
http://example.com/one.m3u8
#EXTINF:-1 group-title=\"News\",Channel Two
http://example.com/two.m3u8
#EXTINF:-1 group-title=\"Sports\",Channel Three
http://example.com/three.mp4
";
        let full =
            parse_m3u(playlist, "cached.m3u8", &None, &None).expect("full playlist should parse");
        let group_filter = Some(" sports ".to_string());
        let channel_search = Some("one|three".to_string());
        let derived = filter_playlist_preview(&full, &group_filter, &channel_search)
            .expect("cached preview should filter");
        let reparsed = parse_m3u(playlist, "cached.m3u8", &group_filter, &channel_search)
            .expect("filtered playlist should parse");

        assert_eq!(
            derived
                .channels
                .iter()
                .map(|channel| channel.index)
                .collect::<Vec<_>>(),
            reparsed
                .channels
                .iter()
                .map(|channel| channel.index)
                .collect::<Vec<_>>()
        );
        assert_eq!(derived.total_channels, reparsed.total_channels);
        assert_eq!(derived.live_count, reparsed.live_count);
        assert_eq!(derived.movie_count, reparsed.movie_count);
        assert_eq!(derived.series_count, reparsed.series_count);
        assert_eq!(derived.groups, reparsed.groups);
    }

    #[test]
    fn test_parse_playlist_keeps_stable_indices_across_filters() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-parser-stable-index-{unique}.m3u8"));

        let playlist = "\
#EXTM3U x-tvg-url=\"http://epg.example.com/all.xml\"
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

        let first = root.join("live.m3u8");
        let second = nested.join("live.m3u8");
        std::fs::write(
            &first,
            "\
#EXTM3U x-tvg-url=\"http://provider-a.example/epg.xml\"
#EXTINF:-1 group-title=\"Sports\",Alpha
http://example.com/alpha.m3u8
",
        )
        .expect("first fixture should be writable");
        std::fs::write(
            &second,
            "\
#EXTM3U x-tvg-url=\"http://provider-b.example/epg.xml\"
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
            vec!["live.m3u8".to_string(), "nested/live.m3u8".to_string()]
        );
        assert!(preview.groups.contains(&"Sports".to_string()));
        assert!(preview.groups.contains(&"News".to_string()));
        assert!(preview.groups.contains(&"Playlist: live.m3u8".to_string()));
        assert!(preview
            .groups
            .contains(&"Playlist: nested/live.m3u8".to_string()));
        assert_eq!(
            preview.epg_sources_by_playlist.get("live.m3u8"),
            Some(&vec!["http://provider-a.example/epg.xml".to_string()])
        );
        assert_eq!(
            preview.epg_sources_by_playlist.get("nested/live.m3u8"),
            Some(&vec!["http://provider-b.example/epg.xml".to_string()])
        );

        let playlist_filtered = parse_playlist(
            &root.to_string_lossy(),
            &Some("Playlist: nested/live.m3u8".to_string()),
            &None,
        )
        .expect("playlist-filtered directory parse should succeed");
        assert_eq!(playlist_filtered.total_channels, 1);
        assert_eq!(playlist_filtered.channels[0].name, "Beta");
        assert_eq!(playlist_filtered.channels[0].index, 1);
        assert_eq!(
            playlist_filtered.epg_sources,
            vec!["http://provider-b.example/epg.xml".to_string()]
        );
        assert_eq!(playlist_filtered.epg_sources_by_playlist.len(), 1);
        assert_eq!(
            playlist_filtered
                .epg_sources_by_playlist
                .get("nested/live.m3u8"),
            Some(&vec!["http://provider-b.example/epg.xml".to_string()])
        );

        let cached_filtered = filter_playlist_preview(
            &preview,
            &Some("Playlist: nested/live.m3u8".to_string()),
            &None,
        )
        .expect("cached directory preview should filter");
        assert_eq!(cached_filtered.epg_sources, playlist_filtered.epg_sources);
        assert_eq!(
            cached_filtered.epg_sources_by_playlist,
            playlist_filtered.epg_sources_by_playlist
        );

        std::fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn test_parse_playlist_directory_reports_cumulative_progress() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("iptv-parser-progress-{unique}"));
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

        let progress = std::cell::RefCell::new(Vec::new());
        let on_progress = |count: ParseProgress| progress.borrow_mut().push(count);
        parse_playlist_with_progress(&root.to_string_lossy(), &None, &None, Some(&on_progress))
            .expect("directory parse should succeed");

        assert_eq!(
            *progress.borrow(),
            vec![
                ParseProgress {
                    channels_found: 1,
                    live_found: 1,
                    movie_found: 0,
                    series_found: 0,
                },
                ParseProgress {
                    channels_found: 2,
                    live_found: 2,
                    movie_found: 0,
                    series_found: 0,
                },
            ]
        );

        std::fs::remove_dir_all(root).expect("fixture directory should be removable");
    }

    #[test]
    fn test_parse_playlist_progress_tracks_live_and_vod_counts() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be monotonic")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("iptv-parser-mixed-progress-{unique}.m3u8"));
        std::fs::write(
            &path,
            "\
#EXTM3U
#EXTINF:-1 group-title=\"Live\",Live One
http://example.com/live.m3u8
#EXTINF:-1 group-title=\"Movies\",Movie One
http://example.com/movie/one.mp4
#EXTINF:-1 group-title=\"Series\",Series One
http://example.com/series/one.mkv
",
        )
        .expect("fixture should be writable");

        let progress = std::cell::RefCell::new(Vec::new());
        let on_progress = |count: ParseProgress| progress.borrow_mut().push(count);
        parse_playlist_with_progress(&path.to_string_lossy(), &None, &None, Some(&on_progress))
            .expect("mixed parse should succeed");

        assert_eq!(
            *progress.borrow(),
            vec![
                ParseProgress {
                    channels_found: 1,
                    live_found: 1,
                    movie_found: 0,
                    series_found: 0,
                },
                ParseProgress {
                    channels_found: 2,
                    live_found: 1,
                    movie_found: 1,
                    series_found: 0,
                },
                ParseProgress {
                    channels_found: 3,
                    live_found: 1,
                    movie_found: 1,
                    series_found: 1,
                },
            ]
        );

        std::fs::remove_file(path).expect("fixture should be removable");
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
    fn test_parse_m3u_supports_negative_lookahead_channel_search() {
        let payload = b"#EXTM3U\n#EXTINF:-1 group-title=\"Sports\",News Hour\nhttp://example.com/news.m3u8\n#EXTINF:-1 group-title=\"Sports\",Friday Event\nhttp://example.com/event.m3u8\n#EXTINF:-1 group-title=\"Sports\",PPV Main Event\nhttp://example.com/ppv.m3u8\n";
        let channel_search = Some("^(?!.*(event|ppv))".to_string());

        let parsed = parse_m3u(payload, "lookahead.m3u8", &None, &channel_search)
            .expect("negative lookahead search should succeed");

        assert_eq!(parsed.total_channels, 1);
        assert_eq!(parsed.channels[0].name, "News Hour");
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
