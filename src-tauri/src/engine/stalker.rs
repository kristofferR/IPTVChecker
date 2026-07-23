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
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use url::Url;

pub(crate) const STALKER_API_TIMEOUT: Duration = Duration::from_secs(12);
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
    let referer_path = if base_path.is_empty() {
        "/c/".to_string()
    } else {
        format!("{}/c/", base_path.trim_end_matches('/'))
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
    let requests: [&[(&str, &str)]; 2] = [
        &[
            ("type", "itv"),
            ("action", "get_all_channels"),
            ("JsHttpRequest", "1-xml"),
        ],
        &[
            ("type", "itv"),
            ("action", "get_ordered_list"),
            ("genre", "*"),
            ("force_ch_link_check", ""),
            ("JsHttpRequest", "1-xml"),
        ],
    ];

    let mut last_error: Option<String> = None;
    for request in requests {
        match stalker_request_json(client, endpoint, mac, Some(token), request).await {
            Ok(payload) => {
                let items = extract_stalker_items(&payload);
                if !items.is_empty() {
                    return Ok(items);
                }
                last_error = Some("response returned no channels".to_string());
            }
            Err(error) => {
                last_error = Some(error.to_string());
            }
        }
    }

    Err(AppError::Other(format!(
        "Failed to fetch channels from Stalker endpoint {}: {}",
        endpoint,
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )))
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
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_stalker_endpoint_candidates, build_stalker_preview, extract_stalker_stream_url,
        normalize_stalker_mac, normalize_stalker_portal,
    };

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
    fn extract_stalker_stream_url_handles_prefixed_commands() {
        let url = extract_stalker_stream_url("ffmpeg http://example.com/live/stream.m3u8")
            .expect("stream URL should be extracted");
        assert_eq!(url, "http://example.com/live/stream.m3u8");
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
