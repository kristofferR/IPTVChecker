//! Stalker/Ministra portal client.
//!
//! MAG-STB-style handshake (token), genre and channel listing, and
//! conversion of the portal's channel payload into a `PlaylistPreview`.

use crate::engine::parser;
use crate::engine::remote_cache::parse_http_url;
use crate::engine::search_pattern::ChannelSearchPattern;
use crate::error::AppError;
use crate::models::channel::{Channel, ContentType};
use crate::models::playlist::PlaylistPreview;
use crate::urlnorm::normalize_url_identity;
use futures::stream::{self, StreamExt};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Duration;
use url::Url;

pub(crate) const STALKER_API_TIMEOUT: Duration = Duration::from_secs(12);
const STALKER_LINK_RESOLUTION_CONCURRENCY: usize = 16;
const STALKER_MAX_ORDERED_LIST_PAGES: usize = 10_000;
const STALKER_USER_AGENT: &str =
    "Mozilla/5.0 (QtEmbedded; U; Linux; C) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";
const STALKER_X_USER_AGENT: &str = "Model: MAG250; Link: WiFi";

pub(crate) fn normalize_stalker_portal(portal: &str) -> Result<Url, AppError> {
    let mut parsed = parse_http_url(portal, "Invalid Stalker portal URL")?;
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid Stalker portal URL: missing host".to_string(),
        ));
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let normalized_path = {
        let trimmed = parsed.path().trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    };
    parsed.set_path(&normalized_path);
    Ok(parsed)
}

pub(crate) fn normalize_stalker_mac(mac: &str) -> Result<String, AppError> {
    let hex_only = mac
        .chars()
        .filter(|value| value.is_ascii_hexdigit())
        .collect::<String>();
    if hex_only.len() != 12 {
        return Err(AppError::Parse(
            "Invalid MAC address: expected 12 hexadecimal characters".to_string(),
        ));
    }
    let upper = hex_only.to_ascii_uppercase();
    Ok(format!(
        "{}:{}:{}:{}:{}:{}",
        &upper[0..2],
        &upper[2..4],
        &upper[4..6],
        &upper[6..8],
        &upper[8..10],
        &upper[10..12]
    ))
}

fn append_stalker_endpoint(base: &Url, suffix: &str) -> Url {
    let mut endpoint = base.clone();
    let base_path = base.path().trim_end_matches('/');
    let full_path = if base_path.is_empty() {
        suffix.to_string()
    } else {
        format!("{}{}", base_path, suffix)
    };
    endpoint.set_path(&full_path);
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    endpoint
}

pub(crate) fn build_stalker_endpoint_candidates(portal: &Url) -> Vec<Url> {
    let mut candidates = Vec::<Url>::new();
    let mut push_unique = |candidate: Url| {
        if candidates.iter().any(|existing| existing == &candidate) {
            return;
        }
        candidates.push(candidate);
    };

    let raw_path = portal.path().trim_end_matches('/');
    let endpoint_suffixes = ["/portal.php", "/server/load.php"];

    if raw_path.ends_with("/portal.php") || raw_path.ends_with("/server/load.php") {
        push_unique(portal.clone());
        let base_path = raw_path
            .strip_suffix("/portal.php")
            .or_else(|| raw_path.strip_suffix("/server/load.php"))
            .unwrap_or(raw_path);
        let mut base = portal.clone();
        if base_path.is_empty() {
            base.set_path("/");
        } else {
            base.set_path(base_path);
        }
        for suffix in endpoint_suffixes {
            push_unique(append_stalker_endpoint(&base, suffix));
        }
        return candidates;
    }

    for suffix in endpoint_suffixes {
        push_unique(append_stalker_endpoint(portal, suffix));
    }
    candidates
}

fn value_to_non_empty_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn value_field_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(field) = value.get(*key) {
            if let Some(parsed) = value_to_non_empty_string(field) {
                return Some(parsed);
            }
        }
    }
    None
}

fn value_field_usize(value: &serde_json::Value, keys: &[&str]) -> Option<usize> {
    keys.iter().find_map(|key| {
        let field = value.get(*key)?;
        field
            .as_u64()
            .and_then(|number| usize::try_from(number).ok())
            .or_else(|| field.as_str()?.trim().parse::<usize>().ok())
    })
}

fn value_field_is_enabled(value: &serde_json::Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| match value.get(*key) {
        Some(serde_json::Value::Bool(enabled)) => *enabled,
        Some(serde_json::Value::Number(number)) => number.as_u64().is_some_and(|value| value != 0),
        Some(serde_json::Value::String(raw)) => {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        }
        _ => false,
    })
}

fn extract_stalker_items(payload: &serde_json::Value) -> Vec<serde_json::Value> {
    let root = payload.get("js").unwrap_or(payload);
    if let Some(array) = root.as_array() {
        return array.clone();
    }
    for key in ["data", "results", "items", "channels"] {
        if let Some(array) = root.get(key).and_then(|value| value.as_array()) {
            return array.clone();
        }
    }
    Vec::new()
}

fn extract_stalker_stream_url(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    for token in trimmed.split_whitespace() {
        let candidate = token
            .trim_matches(|value| value == '"' || value == '\'' || value == ';' || value == ',');
        if candidate.contains("://") {
            return Some(candidate.to_string());
        }
    }

    if trimmed.contains("://") {
        return Some(trimmed.to_string());
    }

    None
}

fn stalker_referer(endpoint: &Url) -> String {
    let path = endpoint.path().trim_end_matches('/');
    let base_path = path
        .strip_suffix("/portal.php")
        .or_else(|| path.strip_suffix("/server/load.php"))
        .unwrap_or(path);
    let trimmed_base = base_path.trim_end_matches('/');
    let referer_path = if trimmed_base.is_empty() {
        "/c/".to_string()
    } else if trimmed_base.ends_with("/c") {
        format!("{}/", trimmed_base)
    } else {
        format!("{}/c/", trimmed_base)
    };

    let mut referer = endpoint.clone();
    referer.set_path(&referer_path);
    referer.set_query(None);
    referer.set_fragment(None);
    referer.to_string()
}

fn build_stalker_headers(
    endpoint: &Url,
    mac: &str,
    token: Option<&str>,
) -> Result<reqwest::header::HeaderMap, AppError> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(STALKER_USER_AGENT),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("x-user-agent"),
        reqwest::header::HeaderValue::from_static(STALKER_X_USER_AGENT),
    );

    let cookie_value = format!("mac={}; stb_lang=en; timezone=GMT", mac);
    headers.insert(
        reqwest::header::COOKIE,
        reqwest::header::HeaderValue::from_str(&cookie_value).map_err(|error| {
            AppError::Other(format!("Failed to build Stalker cookie header: {}", error))
        })?,
    );

    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_str(&stalker_referer(endpoint)).map_err(|error| {
            AppError::Other(format!("Failed to build Stalker referer header: {}", error))
        })?,
    );

    if let Some(value) = token {
        let auth_value = format!("Bearer {}", value);
        headers.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&auth_value).map_err(|error| {
                AppError::Other(format!(
                    "Failed to build Stalker authorization header: {}",
                    error
                ))
            })?,
        );
    }

    Ok(headers)
}

async fn stalker_request_json(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: Option<&str>,
    query: &[(&str, &str)],
) -> Result<serde_json::Value, AppError> {
    let mut request_url = endpoint.clone();
    {
        let mut query_pairs = request_url.query_pairs_mut();
        query_pairs.clear();
        for (key, value) in query {
            query_pairs.append_pair(key, value);
        }
    }

    let response = client
        .get(request_url)
        .headers(build_stalker_headers(endpoint, mac, token)?)
        .send()
        .await
        .map_err(|error| AppError::Other(format!("Stalker request failed: {}", error)))?;

    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "Stalker endpoint returned HTTP {}",
            response.status()
        )));
    }

    let bytes = crate::engine::proxy_common::read_capped(
        response,
        crate::engine::proxy_common::MAX_JSON_API_BYTES,
    )
    .await
    .map_err(|error| AppError::Other(format!("Failed to read Stalker response: {:?}", error)))?;
    serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|error| {
        AppError::Parse(format!(
            "Failed to parse Stalker response JSON at {}: {}",
            endpoint, error
        ))
    })
}

pub(crate) async fn fetch_stalker_token(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
) -> Result<String, AppError> {
    let payload = stalker_request_json(
        client,
        endpoint,
        mac,
        None,
        &[
            ("type", "stb"),
            ("action", "handshake"),
            ("token", ""),
            ("JsHttpRequest", "1-xml"),
        ],
    )
    .await?;

    let root = payload.get("js").unwrap_or(&payload);
    value_field_string(root, &["token"]).ok_or_else(|| {
        AppError::Other("Stalker handshake succeeded but no token was returned".to_string())
    })
}

pub(crate) async fn fetch_stalker_genres(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: &str,
) -> HashMap<String, String> {
    let payload = match stalker_request_json(
        client,
        endpoint,
        mac,
        Some(token),
        &[
            ("type", "itv"),
            ("action", "get_genres"),
            ("JsHttpRequest", "1-xml"),
        ],
    )
    .await
    {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut out = HashMap::new();
    for item in extract_stalker_items(&payload) {
        let Some(id) = value_field_string(&item, &["id", "genre_id", "category_id"]) else {
            continue;
        };
        let Some(title) = value_field_string(&item, &["title", "name"]) else {
            continue;
        };
        out.insert(id, title);
    }
    out
}

pub(crate) async fn fetch_stalker_channels(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: &str,
) -> Result<Vec<serde_json::Value>, AppError> {
    let get_all_channels = stalker_request_json(
        client,
        endpoint,
        mac,
        Some(token),
        &[
            ("type", "itv"),
            ("action", "get_all_channels"),
            ("JsHttpRequest", "1-xml"),
        ],
    )
    .await;

    if let Ok(payload) = &get_all_channels {
        let items = extract_stalker_items(payload);
        if !items.is_empty() {
            return resolve_stalker_channel_links(client, endpoint, mac, token, items).await;
        }
    }

    let mut channels = Vec::new();
    let mut seen_pages = HashSet::new();
    let mut ordered_list_error = None;

    for page in 1..=STALKER_MAX_ORDERED_LIST_PAGES {
        let page_value = page.to_string();
        let payload = match stalker_request_json(
            client,
            endpoint,
            mac,
            Some(token),
            &[
                ("type", "itv"),
                ("action", "get_ordered_list"),
                ("genre", "*"),
                ("force_ch_link_check", ""),
                ("p", page_value.as_str()),
                ("JsHttpRequest", "1-xml"),
            ],
        )
        .await
        {
            Ok(payload) => payload,
            Err(error) => {
                ordered_list_error = Some(error.to_string());
                break;
            }
        };

        let page_items = extract_stalker_items(&payload);
        if page_items.is_empty() {
            break;
        }

        // Some portals ignore `p` and return page one forever. Stop on a
        // repeated page instead of duplicating channels until the safety cap.
        let page_signature = serde_json::to_string(&page_items).unwrap_or_default();
        if !seen_pages.insert(page_signature) {
            break;
        }

        let page_item_count = page_items.len();
        channels.extend(page_items);

        let root = payload.get("js").unwrap_or(&payload);
        let total_items = value_field_usize(root, &["total_items", "total"]);
        let total_pages = value_field_usize(root, &["total_pages"]);
        let max_page_items = value_field_usize(root, &["max_page_items"]);

        if total_items.is_some_and(|total| channels.len() >= total)
            || total_pages.is_some_and(|total| page >= total)
            || max_page_items.is_some_and(|page_size| page_item_count < page_size)
        {
            break;
        }
    }

    if channels.is_empty() {
        let get_all_error = get_all_channels
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "response returned no channels".to_string());
        return Err(AppError::Other(format!(
            "Failed to fetch channels from Stalker endpoint {}: {}",
            endpoint,
            ordered_list_error.unwrap_or(get_all_error)
        )));
    }

    resolve_stalker_channel_links(client, endpoint, mac, token, channels).await
}

fn original_stalker_command_is_playable(command: &str) -> bool {
    let Some(stream_url) = extract_stalker_stream_url(command) else {
        return false;
    };
    let Ok(parsed) = Url::parse(&stream_url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }

    let host_is_local = parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
        || parsed
            .host()
            .and_then(|host| match host {
                url::Host::Ipv4(address) => Some(address.is_loopback() || address.is_unspecified()),
                url::Host::Ipv6(address) => Some(address.is_loopback() || address.is_unspecified()),
                url::Host::Domain(_) => None,
            })
            .unwrap_or(false);
    let path_is_placeholder =
        parsed.path().contains("/ch/") && parsed.path().trim_end_matches('/').ends_with('_');

    !host_is_local && !path_is_placeholder
}

async fn resolve_stalker_channel_link(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: &str,
    mut item: serde_json::Value,
) -> Option<serde_json::Value> {
    let command = value_field_string(&item, &["cmd", "stream_url", "url"])?;
    let original_is_playable = original_stalker_command_is_playable(&command);
    let portal_requires_link = value_field_is_enabled(
        &item,
        &[
            "use_http_tmp_link",
            "use_load_balancing",
            "force_ch_link_check",
        ],
    );

    if original_is_playable && !portal_requires_link {
        let stream_url = extract_stalker_stream_url(&command)?;
        item.as_object_mut()?
            .insert("cmd".to_string(), serde_json::Value::String(stream_url));
        return Some(item);
    }

    let payload = stalker_request_json(
        client,
        endpoint,
        mac,
        Some(token),
        &[
            ("type", "itv"),
            ("action", "create_link"),
            ("cmd", command.as_str()),
            ("series", ""),
            ("forced_storage", ""),
            ("disable_ad", ""),
            ("download", ""),
            ("JsHttpRequest", "1-xml"),
        ],
    )
    .await;

    let resolved_url = payload
        .ok()
        .and_then(|payload| {
            let root = payload.get("js").unwrap_or(&payload);
            value_field_string(root, &["cmd", "url", "link", "stream_url"])
        })
        .and_then(|resolved_command| extract_stalker_stream_url(&resolved_command))
        .or_else(|| {
            original_is_playable
                .then(|| extract_stalker_stream_url(&command))
                .flatten()
        })?;

    item.as_object_mut()?
        .insert("cmd".to_string(), serde_json::Value::String(resolved_url));
    Some(item)
}

async fn resolve_stalker_channel_links(
    client: &reqwest::Client,
    endpoint: &Url,
    mac: &str,
    token: &str,
    channels: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let original_count = channels.len();
    let mut resolved = stream::iter(channels.into_iter().enumerate().map(
        |(index, item)| async move {
            (
                index,
                resolve_stalker_channel_link(client, endpoint, mac, token, item).await,
            )
        },
    ))
    .buffer_unordered(STALKER_LINK_RESOLUTION_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    resolved.sort_unstable_by_key(|(index, _)| *index);

    let channels = resolved
        .into_iter()
        .filter_map(|(_, item)| item)
        .collect::<Vec<_>>();
    if channels.is_empty() {
        return Err(AppError::Other(
            "The Stalker portal returned channels, but none had a playable stream link".to_string(),
        ));
    }
    if channels.len() < original_count {
        log::warn!(
            "Omitted {} Stalker channels whose stream links could not be resolved",
            original_count - channels.len()
        );
    }

    Ok(channels)
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

pub(crate) fn build_stalker_preview(
    portal: &Url,
    mac: &str,
    channels_payload: Vec<serde_json::Value>,
    genres_by_id: &HashMap<String, String>,
    group_filter: &Option<String>,
    channel_search: &Option<String>,
) -> Result<PlaylistPreview, AppError> {
    let pattern = ChannelSearchPattern::compile(channel_search)?;
    let mut groups = BTreeSet::<String>::new();
    let mut channels = Vec::<Channel>::new();
    let mut source_index = 0usize;

    for item in channels_payload {
        let Some(raw_name) = value_field_string(&item, &["name", "title", "display_name"]) else {
            continue;
        };
        let Some(raw_command) = value_field_string(&item, &["cmd", "stream_url", "url"]) else {
            continue;
        };
        let Some(stream_url) = extract_stalker_stream_url(&raw_command) else {
            continue;
        };

        let group = value_field_string(
            &item,
            &[
                "tv_genre_title",
                "genre_title",
                "category_name",
                "group",
                "group_title",
            ],
        )
        .or_else(|| {
            let genre_id = value_field_string(&item, &["tv_genre_id", "genre_id", "category_id"])?;
            genres_by_id.get(&genre_id).cloned()
        })
        .unwrap_or_else(|| "Unknown Group".to_string());
        groups.insert(group.clone());

        let include_group = if let Some(selected_group) = group_filter {
            group.trim().eq_ignore_ascii_case(selected_group.trim())
        } else {
            true
        };
        let include_search = if let Some(ref regex) = pattern {
            regex.is_match(&raw_name)?
        } else {
            true
        };

        let channel_id = value_field_string(&item, &["id", "ch_id", "channel_id"])
            .unwrap_or_else(|| format!("stalker-{}", source_index));
        let extinf_line = format!(
            "#EXTINF:-1 tvg-id=\"{}\" group-title=\"{}\",{}",
            parser::escape_extinf_value(&channel_id),
            parser::escape_extinf_value(&group),
            parser::flatten_extinf_title(&raw_name)
        );

        if include_group && include_search {
            let language = parser::detect_channel_language(&group, &raw_name, &extinf_line);
            let (tvg_id, tvg_name, tvg_logo, tvg_chno) = parser::extract_tvg_metadata(&extinf_line);
            let content_type = ContentType::detect_from_url(&stream_url);
            channels.push(Channel {
                index: source_index,
                playlist: portal
                    .host_str()
                    .map(|host| format!("Stalker {}", host))
                    .unwrap_or_else(|| "Stalker Portal".to_string()),
                name: raw_name,
                group,
                language,
                tvg_id,
                tvg_name,
                tvg_logo,
                tvg_chno,
                catchup: None,
                catchup_days: None,
                catchup_source: None,
                url: stream_url,
                content_type,
                extinf_line,
                metadata_lines: Vec::new(),
            });
        }

        source_index += 1;
    }

    let (live_count, movie_count, series_count) = content_type_totals(&channels);
    Ok(PlaylistPreview {
        file_path: portal.to_string(),
        file_name: portal
            .host_str()
            .map(|host| format!("Stalker {}", host))
            .unwrap_or_else(|| "Stalker Portal".to_string()),
        source_identity: Some(format!(
            "stalker:{}|{}",
            normalize_url_identity(portal).trim_end_matches('/'),
            mac.to_ascii_lowercase()
        )),
        saved_playlist_id: None,
        server_location: None,
        single_provider: true,
        xtream_max_connections: None,
        xtream_account_info: None,
        total_channels: channels.len(),
        live_count,
        movie_count,
        series_count,
        groups: groups.into_iter().collect(),
        epg_sources: Vec::new(),
        epg_sources_by_playlist: std::collections::BTreeMap::new(),
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_stalker_endpoint_candidates, build_stalker_preview, extract_stalker_stream_url,
        fetch_stalker_channels, normalize_stalker_mac, normalize_stalker_portal,
        original_stalker_command_is_playable, stalker_referer,
    };
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn normalize_stalker_mac_formats_compact_input() {
        let mac = normalize_stalker_mac("001A79123456").expect("mac should normalize");
        assert_eq!(mac, "00:1A:79:12:34:56");
    }

    #[test]
    fn normalize_stalker_mac_rejects_invalid_length() {
        let error = normalize_stalker_mac("00:11:22:33:44").expect_err("invalid MAC should fail");
        assert!(error.to_string().contains("Invalid MAC address"));
    }

    #[test]
    fn build_stalker_endpoint_candidates_includes_common_endpoints() {
        let portal = normalize_stalker_portal("https://demo.example.com:8080/c")
            .expect("portal URL should normalize");
        let endpoints = build_stalker_endpoint_candidates(&portal);
        let as_strings = endpoints
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert_eq!(
            as_strings,
            vec![
                "https://demo.example.com:8080/c/portal.php".to_string(),
                "https://demo.example.com:8080/c/server/load.php".to_string(),
            ]
        );
    }

    #[test]
    fn stalker_referer_does_not_duplicate_existing_c_path() {
        let endpoint = url::Url::parse("https://demo.example.com/c/portal.php").expect("valid URL");
        assert_eq!(stalker_referer(&endpoint), "https://demo.example.com/c/");
    }

    #[test]
    fn stalker_referer_adds_c_path_below_portal_root() {
        let endpoint = url::Url::parse("https://demo.example.com/stalker_portal/server/load.php")
            .expect("valid URL");
        assert_eq!(
            stalker_referer(&endpoint),
            "https://demo.example.com/stalker_portal/c/"
        );
    }

    #[test]
    fn extract_stalker_stream_url_handles_prefixed_commands() {
        let url = extract_stalker_stream_url("ffmpeg http://example.com/live/stream.m3u8")
            .expect("stream URL should be extracted");
        assert_eq!(url, "http://example.com/live/stream.m3u8");
    }

    #[test]
    fn only_non_placeholder_http_commands_can_fall_back_without_create_link() {
        assert!(original_stalker_command_is_playable(
            "ffmpeg https://streams.example.com/live/123.m3u8"
        ));
        assert!(!original_stalker_command_is_playable(
            "ffmpeg http://localhost/ch/123_"
        ));
        assert!(!original_stalker_command_is_playable(
            "ffmpeg https://portal.example.com/ch/123_"
        ));
        assert!(!original_stalker_command_is_playable("ffrt4://123"));
    }

    #[tokio::test]
    async fn fetch_stalker_channels_pages_and_resolves_commands() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock server should bind");
        let address = listener.local_addr().expect("mock address should exist");
        let server = tokio::spawn(async move {
            for _ in 0..6 {
                let (mut socket, _) = listener.accept().await.expect("request should arrive");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let bytes_read = socket.read(&mut buffer).await.expect("request should read");
                    if bytes_read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..bytes_read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }

                let request = String::from_utf8(request).expect("request should be UTF-8");
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("request target should exist");
                let url =
                    url::Url::parse(&format!("http://localhost{}", target)).expect("valid target");
                let query = url
                    .query_pairs()
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect::<HashMap<_, _>>();

                let body = match query.get("action").map(String::as_str) {
                    Some("get_all_channels") => serde_json::json!({
                        "js": { "data": [] }
                    }),
                    Some("get_ordered_list") if query.get("p").map(String::as_str) == Some("1") => {
                        serde_json::json!({
                            "js": {
                                "data": [
                                    { "id": "1", "name": "One", "cmd": "ffrt4://1" },
                                    { "id": "2", "name": "Two", "cmd": "ffrt4://2" }
                                ],
                                "total_items": "3",
                                "max_page_items": "2",
                                "cur_page": "1",
                                "total_pages": "2"
                            }
                        })
                    }
                    Some("get_ordered_list") => serde_json::json!({
                        "js": {
                            "data": [
                                { "id": "3", "name": "Three", "cmd": "ffrt4://3" }
                            ],
                            "total_items": 3,
                            "max_page_items": 2,
                            "cur_page": 2,
                            "total_pages": 2
                        }
                    }),
                    Some("create_link") => {
                        let id = query
                            .get("cmd")
                            .and_then(|command| command.rsplit('/').next())
                            .expect("command id should exist");
                        serde_json::json!({
                            "js": {
                                "cmd": format!("ffmpeg http://streams.example.com/{id}.m3u8")
                            }
                        })
                    }
                    action => panic!("unexpected action: {action:?}"),
                }
                .to_string();

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("response should write");
            }
        });

        let endpoint = url::Url::parse(&format!("http://{address}/portal.php"))
            .expect("endpoint should parse");
        let channels = fetch_stalker_channels(
            &reqwest::Client::new(),
            &endpoint,
            "00:1A:79:12:34:56",
            "test-token",
        )
        .await
        .expect("channels should load");

        assert_eq!(channels.len(), 3);
        let commands = channels
            .iter()
            .map(|channel| channel["cmd"].as_str().expect("resolved command"))
            .collect::<Vec<_>>();
        assert_eq!(
            commands,
            vec![
                "http://streams.example.com/1.m3u8",
                "http://streams.example.com/2.m3u8",
                "http://streams.example.com/3.m3u8",
            ]
        );
        server.await.expect("mock server should finish");
    }

    #[test]
    fn build_stalker_preview_maps_channels_and_filters() {
        let portal = normalize_stalker_portal("https://demo.example.com:8080/c")
            .expect("portal URL should normalize");
        let channels_payload = vec![
            serde_json::json!({
                "id": 10,
                "name": "News HD",
                "cmd": "ffmpeg http://streams.example.com/news.m3u8",
                "tv_genre_id": "3"
            }),
            serde_json::json!({
                "id": 11,
                "name": "Sports Max",
                "cmd": "http://streams.example.com/sports.m3u8",
                "tv_genre_title": "Sports"
            }),
        ];
        let mut genres = std::collections::HashMap::new();
        genres.insert("3".to_string(), "News".to_string());

        let preview = build_stalker_preview(
            &portal,
            "00:1A:79:12:34:56",
            channels_payload,
            &genres,
            &Some("News".to_string()),
            &Some("news".to_string()),
        )
        .expect("preview should build");

        assert_eq!(preview.total_channels, 1);
        assert_eq!(preview.channels[0].name, "News HD");
        assert_eq!(preview.channels[0].group, "News");
        assert_eq!(preview.channels[0].index, 0);
        assert!(preview
            .source_identity
            .expect("source identity should exist")
            .starts_with("stalker:"));
    }

    #[test]
    fn build_stalker_preview_preserves_title_quotes_and_backslashes() {
        let portal = normalize_stalker_portal("https://demo.example.com:8080/c")
            .expect("portal URL should normalize");
        let preview = build_stalker_preview(
            &portal,
            "00:1A:79:12:34:56",
            vec![serde_json::json!({
                "id": 10,
                "name": "News \"HD\" \\ One\nToday",
                "cmd": "http://streams.example.com/news.m3u8",
                "tv_genre_title": "News"
            })],
            &std::collections::HashMap::new(),
            &None,
            &None,
        )
        .expect("preview should build");

        assert_eq!(
            preview.channels[0].extinf_line,
            "#EXTINF:-1 tvg-id=\"10\" group-title=\"News\",News \"HD\" \\ One Today"
        );
    }

    #[test]
    fn build_stalker_preview_supports_negative_lookahead_search() {
        let portal = normalize_stalker_portal("https://demo.example.com:8080/c")
            .expect("portal URL should normalize");
        let channels_payload = vec![
            serde_json::json!({
                "id": 10,
                "name": "News HD",
                "cmd": "ffmpeg http://streams.example.com/news.m3u8",
                "tv_genre_title": "News"
            }),
            serde_json::json!({
                "id": 11,
                "name": "Friday Event",
                "cmd": "http://streams.example.com/event.m3u8",
                "tv_genre_title": "Sports"
            }),
            serde_json::json!({
                "id": 12,
                "name": "Sports PPV",
                "cmd": "http://streams.example.com/ppv.m3u8",
                "tv_genre_title": "Sports"
            }),
        ];

        let preview = build_stalker_preview(
            &portal,
            "00:1A:79:12:34:56",
            channels_payload,
            &std::collections::HashMap::new(),
            &None,
            &Some("^(?!.*(event|ppv))".to_string()),
        )
        .expect("preview should build");

        assert_eq!(preview.total_channels, 1);
        assert_eq!(preview.channels[0].name, "News HD");
    }
}
