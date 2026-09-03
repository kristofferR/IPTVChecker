//! Xtream Codes API client.
//!
//! Server URL normalization, endpoint/URL builders, account-info retrieval,
//! and a JSON-API fallback that builds an M3U playlist when /get.php fails.

use crate::engine::remote_cache::{
    parse_http_url, PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT, PLAYLIST_DOWNLOAD_USER_AGENT,
};
use crate::error::AppError;
use crate::models::channel::{Channel, ContentType};
use crate::models::playlist::XtreamAccountInfo;
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

pub(crate) const XTREAM_PLAYER_API_TIMEOUT: Duration = Duration::from_secs(8);

/// Timeout for the (potentially large) JSON stream list downloads.
pub(crate) const XTREAM_JSON_API_TIMEOUT: Duration = Duration::from_secs(60);

/// "host:port" (or bare host) display label for an Xtream server URL.
pub(crate) fn xtream_host_label(server: &str) -> String {
    let Ok(parsed) = Url::parse(server) else {
        return server.to_string();
    };
    match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) => format!("{}:{}", host, port),
        (Some(host), None) => host.to_string(),
        _ => server.to_string(),
    }
}

pub(crate) fn normalize_xtream_server(server: &str) -> Result<Url, AppError> {
    let mut parsed = parse_http_url(server, "Invalid Xtream server URL")?;
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid Xtream server URL: missing host".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Parse(
            "Xtream server URL must not include credentials".to_string(),
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::Parse(
            "Xtream server URL must not include query parameters or fragments".to_string(),
        ));
    }

    let path = parsed.path().trim_end_matches('/');
    let normalized_path = if path.is_empty() || path == "/get.php" {
        "/".to_string()
    } else if path.to_ascii_lowercase().ends_with("/get.php") {
        let base = &path[..path.len() - "/get.php".len()];
        if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        }
    } else {
        path.to_string()
    };
    parsed.set_path(&normalized_path);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

fn xtream_server_identity(server: &Url) -> String {
    let mut cleaned = server.clone();
    let _ = cleaned.set_username("");
    let _ = cleaned.set_password(None);
    cleaned.set_query(None);
    cleaned.set_fragment(None);
    cleaned.to_string().trim_end_matches('/').to_string()
}

pub(crate) fn build_xtream_download_url(server: &Url, username: &str, password: &str) -> Url {
    let mut playlist_url = server.clone();
    let mut endpoint_path = playlist_url.path().trim_end_matches('/').to_string();
    if endpoint_path.is_empty() || endpoint_path == "/" {
        endpoint_path = "/get.php".to_string();
    } else {
        endpoint_path.push_str("/get.php");
    }
    playlist_url.set_path(&endpoint_path);
    playlist_url.set_query(None);
    playlist_url.set_fragment(None);
    playlist_url
        .query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password)
        .append_pair("type", "m3u_plus")
        .append_pair("output", "ts");
    playlist_url
}

pub(crate) fn build_xtream_xmltv_url(server: &Url, username: &str, password: &str) -> Url {
    let mut xmltv_url = server.clone();
    let mut endpoint_path = xmltv_url.path().trim_end_matches('/').to_string();
    if endpoint_path.is_empty() || endpoint_path == "/" {
        endpoint_path = "/xmltv.php".to_string();
    } else {
        endpoint_path.push_str("/xmltv.php");
    }
    xmltv_url.set_path(&endpoint_path);
    xmltv_url.set_query(None);
    xmltv_url.set_fragment(None);
    xmltv_url
        .query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password);
    xmltv_url
}

pub(crate) fn build_xtream_player_api_url(server: &Url, username: &str, password: &str) -> Url {
    let mut api_url = server.clone();
    let mut endpoint_path = api_url.path().trim_end_matches('/').to_string();
    if endpoint_path.is_empty() || endpoint_path == "/" {
        endpoint_path = "/player_api.php".to_string();
    } else {
        endpoint_path.push_str("/player_api.php");
    }
    api_url.set_path(&endpoint_path);
    api_url.set_query(None);
    api_url.set_fragment(None);
    api_url
        .query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password);
    api_url
}

pub(crate) fn build_xtream_player_api_action_url(
    server: &Url,
    username: &str,
    password: &str,
    action: &str,
) -> Url {
    let mut api_url = build_xtream_player_api_url(server, username, password);
    api_url.query_pairs_mut().append_pair("action", action);
    api_url
}

pub(crate) fn build_xtream_source_key(server: &Url, username: &str) -> String {
    format!(
        "xtream:{}|{}|m3u_plus|ts",
        xtream_server_identity(server),
        username
    )
}

/// Direct live stream URL for a given stream id (used by the server tester).
pub(crate) fn build_xtream_stream_url(
    server: &Url,
    username: &str,
    password: &str,
    stream_id: &str,
) -> String {
    let mut base = server.clone();
    let mut path = base.path().trim_end_matches('/').to_string();
    path.push_str(&format!("/live/{}/{}/{}.ts", username, password, stream_id));
    base.set_path(&path);
    base.set_query(None);
    base.set_fragment(None);
    base.to_string()
}

fn parse_max_connections_value(value: &serde_json::Value) -> Option<u32> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().and_then(|value| {
            if value == 0 {
                None
            } else {
                u32::try_from(value).ok()
            }
        }),
        serde_json::Value::String(raw) => {
            let parsed = raw.trim().parse::<u32>().ok()?;
            (parsed > 0).then_some(parsed)
        }
        _ => None,
    }
}

fn parse_bool_like(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::Number(number) => number.as_i64().map(|raw| raw != 0),
        serde_json::Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = trimmed.parse::<i64>() {
                return Some(parsed != 0);
            }
            match trimmed.to_ascii_lowercase().as_str() {
                "true" | "yes" | "active" => Some(true),
                "false" | "no" | "inactive" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn parse_epoch_value(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().filter(|epoch| *epoch > 0),
        serde_json::Value::String(raw) => raw.trim().parse::<u64>().ok().filter(|epoch| *epoch > 0),
        _ => None,
    }
}

fn parse_optional_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn extract_xtream_account_info(
    payload: &serde_json::Value,
) -> Option<XtreamAccountInfo> {
    let user = payload.get("user_info").unwrap_or(payload);
    let info = XtreamAccountInfo {
        status: parse_optional_string(user.get("status")),
        expires_at_epoch: user
            .get("exp_date")
            .and_then(parse_epoch_value)
            .or_else(|| user.get("expiration").and_then(parse_epoch_value)),
        created_at_epoch: user.get("created_at").and_then(parse_epoch_value),
        is_trial: user.get("is_trial").and_then(parse_bool_like),
        active_connections: user
            .get("active_cons")
            .and_then(parse_max_connections_value),
        max_connections: user
            .get("max_connections")
            .and_then(parse_max_connections_value),
    };

    let has_any = info.status.is_some()
        || info.expires_at_epoch.is_some()
        || info.created_at_epoch.is_some()
        || info.is_trial.is_some()
        || info.active_connections.is_some()
        || info.max_connections.is_some();
    has_any.then_some(info)
}

#[cfg(test)]
fn extract_xtream_max_connections(payload: &serde_json::Value) -> Option<u32> {
    extract_xtream_account_info(payload)
        .and_then(|account| account.max_connections)
        .or_else(|| {
            payload
                .get("max_connections")
                .and_then(parse_max_connections_value)
        })
}

fn describe_read_capped_error(error: crate::engine::proxy_common::ReadCappedError) -> String {
    match error {
        crate::engine::proxy_common::ReadCappedError::TooLarge => {
            "response exceeded the size limit".to_string()
        }
        crate::engine::proxy_common::ReadCappedError::Read(error) => {
            error.without_url().to_string()
        }
    }
}

/// Fetch a single Xtream JSON API endpoint, returning a parsed JSON array.
/// Returns `None` on non-2xx or parse failures so callers can distinguish a
/// failed request from a successful empty catalog.
async fn fetch_xtream_json_array(
    client: &reqwest::Client,
    url: reqwest::Url,
    label: &str,
) -> Option<Vec<serde_json::Value>> {
    match client
        .get(url)
        .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match crate::engine::proxy_common::read_capped(
                resp,
                crate::engine::proxy_common::MAX_JSON_API_BYTES,
            )
            .await
            {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(entries) => Some(entries),
                    Err(e) => {
                        log::warn!("Failed to parse Xtream {} JSON response: {}", label, e);
                        None
                    }
                },
                Err(e) => {
                    let detail = describe_read_capped_error(e);
                    log::warn!("Failed to read Xtream {} response: {}", label, detail);
                    None
                }
            }
        }
        Ok(resp) => {
            log::warn!("Xtream {} API returned HTTP {}", label, resp.status());
            None
        }
        Err(e) => {
            log::warn!("Failed to fetch Xtream {}: {}", label, e.without_url());
            None
        }
    }
}

/// Build category_id -> category_name lookup from a JSON categories array.
fn build_category_map(categories: &[serde_json::Value]) -> HashMap<String, String> {
    categories
        .iter()
        .filter_map(|cat| {
            let id = cat.get("category_id")?.as_str()?.to_string();
            let name = cat.get("category_name")?.as_str()?.to_string();
            Some((id, name))
        })
        .collect()
}

/// Build base stream URL for a given content type path segment.
fn build_xtream_stream_base(server: &Url, segment: &str, username: &str, password: &str) -> String {
    let mut base = server.clone();
    let mut path = base.path().trim_end_matches('/').to_string();
    path.push_str(&format!("/{}/{}/{}/", segment, username, password));
    base.set_path(&path);
    base.set_query(None);
    base.set_fragment(None);
    base.to_string()
}

/// Read a numeric Xtream field that servers return as either number or string.
fn xtream_numeric_field(entry: &serde_json::Value, key: &str) -> Option<i64> {
    match entry.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// Build the catch-up attributes for a stream entry, or an empty string.
/// Xtream advertises archives via `tv_archive` / `tv_archive_duration` (days).
fn xtream_catchup_attrs(entry: &serde_json::Value) -> String {
    if xtream_numeric_field(entry, "tv_archive") != Some(1) {
        return String::new();
    }
    match xtream_numeric_field(entry, "tv_archive_duration").filter(|days| *days > 0) {
        Some(days) => format!(" catchup=\"xc\" catchup-days=\"{}\"", days),
        None => " catchup=\"xc\"".to_string(),
    }
}

fn xtream_stream_id(entry: &serde_json::Value) -> Option<String> {
    match entry.get("stream_id") {
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        Some(serde_json::Value::String(raw)) if !raw.trim().is_empty() => {
            Some(raw.trim().to_string())
        }
        _ => None,
    }
}

pub(crate) async fn fetch_xtream_live_streams(
    server: &Url,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
) -> Option<Vec<serde_json::Value>> {
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_JSON_API_TIMEOUT)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
    else {
        return None;
    };
    let url = build_xtream_player_api_action_url(server, username, password, "get_live_streams");

    fetch_xtream_json_array(&client, url, "live streams").await
}

pub(crate) fn xtream_archive_flags(
    live_streams: &[serde_json::Value],
) -> HashMap<String, Option<u32>> {
    live_streams
        .iter()
        .filter(|entry| xtream_numeric_field(entry, "tv_archive") == Some(1))
        .filter_map(|entry| {
            let stream_id = xtream_stream_id(entry)?;
            let days = xtream_numeric_field(entry, "tv_archive_duration")
                .filter(|days| *days > 0)
                .and_then(|days| u32::try_from(days).ok());
            Some((stream_id, days))
        })
        .collect()
}

pub(crate) fn apply_xtream_archive_flags(
    channels: &mut [Channel],
    archive_flags: &HashMap<String, Option<u32>>,
) {
    for channel in channels {
        if channel.content_type != ContentType::Live
            || extinf_explicitly_disables_catchup(&channel.extinf_line)
        {
            continue;
        }
        let Some(stream_id) = Url::parse(&channel.url).ok().and_then(|url| {
            let file_name = url.path_segments()?.next_back()?;
            Some(
                file_name
                    .rsplit_once('.')
                    .map_or(file_name, |(stem, _)| stem)
                    .to_string(),
            )
        }) else {
            continue;
        };
        let Some(days) = archive_flags.get(&stream_id) else {
            continue;
        };

        let added_catchup = channel.catchup.is_none();
        if added_catchup {
            channel.catchup = Some("xc".to_string());
        }
        let added_days = channel.catchup_days.is_none().then_some(*days).flatten();
        if channel.catchup_days.is_none() {
            channel.catchup_days = *days;
        }
        append_xtream_archive_attrs(&mut channel.extinf_line, added_catchup, added_days);
    }
}

fn extinf_explicitly_disables_catchup(extinf_line: &str) -> bool {
    let attrs = crate::engine::parser::parse_extinf_attributes(extinf_line);
    let catchup = attrs
        .iter()
        .find(|(key, _)| key == "catchup")
        .or_else(|| attrs.iter().find(|(key, _)| key == "catchup-type"))
        .map(|(_, value)| value.trim().to_ascii_lowercase());

    matches!(
        catchup.as_deref(),
        Some("none" | "no" | "false" | "off" | "0" | "disabled")
    )
}

fn append_xtream_archive_attrs(
    extinf_line: &mut String,
    add_catchup: bool,
    catchup_days: Option<u32>,
) {
    if !add_catchup && catchup_days.is_none() {
        return;
    }
    let Some(comma) = crate::engine::parser::find_unquoted_comma(extinf_line) else {
        return;
    };

    let mut attrs = String::new();
    if add_catchup {
        attrs.push_str(" catchup=\"xc\"");
    }
    if let Some(days) = catchup_days {
        attrs.push_str(&format!(" catchup-days=\"{}\"", days));
    }
    extinf_line.insert_str(comma, &attrs);
}

/// Append M3U entries for a list of Xtream streams.
fn append_xtream_streams_to_m3u(
    m3u: &mut String,
    streams: &[serde_json::Value],
    cat_map: &HashMap<String, String>,
    stream_base: &str,
    extension: &str,
) -> usize {
    let mut count = 0;
    for entry in streams {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let stream_id = match entry.get("stream_id") {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => continue,
        };
        let tvg_id = entry
            .get("epg_channel_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let tvg_logo = entry
            .get("stream_icon")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let group = entry
            .get("category_id")
            // Servers that return category_id as a number are handled by the
            // numeric match below, so a string miss is simply no group.
            .and_then(|v| v.as_str())
            .and_then(|id| cat_map.get(id))
            .map(|s| s.as_str())
            .unwrap_or("");

        // Also try category_id as number
        let group = if group.is_empty() {
            match entry.get("category_id") {
                Some(serde_json::Value::Number(n)) => cat_map
                    .get(&n.to_string())
                    .map(|s| s.as_str())
                    .unwrap_or(""),
                _ => "",
            }
        } else {
            group
        };

        m3u.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{}\" tvg-logo=\"{}\" group-title=\"{}\"{},{}\n",
            crate::engine::parser::escape_extinf_value(tvg_id),
            crate::engine::parser::escape_extinf_value(tvg_logo),
            crate::engine::parser::escape_extinf_value(group),
            xtream_catchup_attrs(entry),
            crate::engine::parser::flatten_extinf_title(name)
        ));
        m3u.push_str(&format!("{}{}.{}\n", stream_base, stream_id, extension));
        count += 1;
    }
    count
}

/// Build an M3U playlist from the Xtream JSON API. Series catalogs are omitted:
/// their IDs identify metadata records, not playable episodes, and resolving
/// every series into episodes would turn this fallback into an unbounded burst
/// of provider requests.
pub(crate) async fn fetch_xtream_playlist_via_json_api(
    server: &Url,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
    live_streams: Option<Vec<serde_json::Value>>,
) -> Result<Vec<u8>, AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_JSON_API_TIMEOUT)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {}", e)))?;

    // Fetch the remaining content types in parallel. The live catalog request
    // already completed while /get.php was downloading, so reuse its outcome.
    let live_cats_url =
        build_xtream_player_api_action_url(server, username, password, "get_live_categories");
    let vod_cats_url =
        build_xtream_player_api_action_url(server, username, password, "get_vod_categories");
    let vod_streams_url =
        build_xtream_player_api_action_url(server, username, password, "get_vod_streams");
    let (live_cats, vod_cats, vod_streams) = tokio::join!(
        async {
            fetch_xtream_json_array(&client, live_cats_url, "live categories")
                .await
                .unwrap_or_default()
        },
        async {
            fetch_xtream_json_array(&client, vod_cats_url, "VOD categories")
                .await
                .unwrap_or_default()
        },
        async {
            fetch_xtream_json_array(&client, vod_streams_url, "VOD streams")
                .await
                .unwrap_or_default()
        },
    );
    let live_streams = live_streams.unwrap_or_default();

    if live_streams.is_empty() && vod_streams.is_empty() {
        return Err(AppError::Other(
            "Xtream server returned no live or VOD content".to_string(),
        ));
    }

    // Build category lookups
    let live_cat_map = build_category_map(&live_cats);
    let vod_cat_map = build_category_map(&vod_cats);

    // Build base URLs for each content type
    let live_base = build_xtream_stream_base(server, "live", username, password);
    let movie_base = build_xtream_stream_base(server, "movie", username, password);

    let estimated_total = live_streams.len() + vod_streams.len();
    let mut m3u = String::with_capacity(estimated_total * 200);
    let xmltv_url = build_xtream_xmltv_url(server, username, password);
    m3u.push_str(&format!(
        "#EXTM3U x-tvg-url=\"{}\"\n",
        crate::engine::parser::escape_extinf_value(xmltv_url.as_str())
    ));

    // Live streams → .ts extension
    let live_count =
        append_xtream_streams_to_m3u(&mut m3u, &live_streams, &live_cat_map, &live_base, "ts");

    // VOD streams → container extension from API or default .mp4
    let mut vod_count = 0;
    for entry in &vod_streams {
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let stream_id = match entry.get("stream_id") {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => continue,
        };
        let tvg_logo = entry
            .get("stream_icon")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let container_extension = entry
            .get("container_extension")
            .and_then(|v| v.as_str())
            .unwrap_or("mp4");
        let group = entry
            .get("category_id")
            .and_then(|v| match v {
                serde_json::Value::String(s) => vod_cat_map.get(s.as_str()),
                serde_json::Value::Number(n) => vod_cat_map.get(&n.to_string()),
                _ => None,
            })
            .map(|s| s.as_str())
            .unwrap_or("");

        m3u.push_str(&format!(
            "#EXTINF:-1 tvg-logo=\"{}\" group-title=\"VOD: {}\",{}\n",
            crate::engine::parser::escape_extinf_value(tvg_logo),
            crate::engine::parser::escape_extinf_value(group),
            crate::engine::parser::flatten_extinf_title(name)
        ));
        m3u.push_str(&format!(
            "{}{}.{}\n",
            movie_base, stream_id, container_extension
        ));
        vod_count += 1;
    }

    log::info!(
        "Built M3U from Xtream JSON API: {} live, {} VOD ({} total)",
        live_count,
        vod_count,
        live_count + vod_count
    );

    Ok(m3u.into_bytes())
}

pub(crate) async fn fetch_xtream_account_info(
    server: &Url,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
) -> Option<XtreamAccountInfo> {
    let api_url = build_xtream_player_api_url(server, username, password);
    let account_info_url =
        build_xtream_player_api_action_url(server, username, password, "get_account_info");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(XTREAM_PLAYER_API_TIMEOUT)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .ok()?;

    // Errors on one endpoint must not abort the loop — the plain player_api.php
    // fallback exists precisely for servers where get_account_info misbehaves.
    for endpoint in [account_info_url, api_url.clone()] {
        // Never log the raw endpoint — player_api URLs carry the username and
        // password as query parameters.
        let safe_endpoint = crate::engine::stream_proxy::redact_url(endpoint.as_str());
        let response = match client
            .get(endpoint.clone())
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                log::debug!(
                    "Xtream player_api request failed for {safe_endpoint}: {}",
                    err.without_url()
                );
                continue;
            }
        };

        if !response.status().is_success() {
            log::debug!(
                "Xtream player_api request returned HTTP {} for {}",
                response.status(),
                safe_endpoint
            );
            continue;
        }

        let payload = match crate::engine::proxy_common::read_capped(
            response,
            crate::engine::proxy_common::MAX_JSON_API_BYTES,
        )
        .await
        {
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(payload) => payload,
                Err(err) => {
                    log::debug!(
                        "Xtream player_api returned invalid JSON for {safe_endpoint}: {err}"
                    );
                    continue;
                }
            },
            Err(err) => {
                let detail = describe_read_capped_error(err);
                log::debug!("Xtream player_api body read failed for {safe_endpoint}: {detail}");
                continue;
            }
        };
        if let Some(info) = extract_xtream_account_info(&payload) {
            return Some(info);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        append_xtream_streams_to_m3u, apply_xtream_archive_flags, build_xtream_download_url,
        build_xtream_player_api_action_url, build_xtream_player_api_url, build_xtream_source_key,
        build_xtream_xmltv_url, extract_xtream_account_info, extract_xtream_max_connections,
        normalize_xtream_server,
    };
    use std::collections::HashMap;
    use url::Url;

    #[test]
    fn generated_xtream_entries_carry_catchup_attributes() {
        let streams = vec![
            serde_json::json!({
                "name": "Archive One",
                "stream_id": 1,
                "tv_archive": 1,
                "tv_archive_duration": 7
            }),
            serde_json::json!({
                "name": "Archive Two",
                "stream_id": 2,
                "tv_archive": "1",
                "tv_archive_duration": "3"
            }),
            serde_json::json!({
                "name": "Live Only",
                "stream_id": 3,
                "tv_archive": 0
            }),
        ];
        let mut m3u = String::new();

        append_xtream_streams_to_m3u(
            &mut m3u,
            &streams,
            &HashMap::new(),
            "https://example.com/live/user/pass/",
            "ts",
        );

        let lines: Vec<&str> = m3u.lines().collect();
        assert!(lines[0].contains("catchup=\"xc\" catchup-days=\"7\""));
        assert!(lines[2].contains("catchup=\"xc\" catchup-days=\"3\""));
        assert!(!lines[4].contains("catchup"));
    }

    #[test]
    fn archive_flags_enrich_missing_m3u_metadata_without_overwriting_it() {
        let mut channels = vec![
            crate::models::channel::Channel {
                index: 0,
                playlist: "fixture.m3u".to_string(),
                name: "Missing metadata".to_string(),
                group: String::new(),
                language: None,
                tvg_id: None,
                tvg_name: None,
                tvg_logo: None,
                tvg_chno: None,
                catchup: None,
                catchup_days: None,
                catchup_source: None,
                url: "https://example.com/live/user/pass/42.ts".to_string(),
                content_type: crate::models::channel::ContentType::Live,
                extinf_line: "#EXTINF:-1,Missing metadata".to_string(),
                metadata_lines: Vec::new(),
            },
            crate::models::channel::Channel {
                index: 1,
                playlist: "fixture.m3u".to_string(),
                name: "Existing metadata".to_string(),
                group: String::new(),
                language: None,
                tvg_id: None,
                tvg_name: None,
                tvg_logo: None,
                tvg_chno: None,
                catchup: Some("append".to_string()),
                catchup_days: Some(14),
                catchup_source: None,
                url: "https://example.com/live/user/pass/43.m3u8?token=secret".to_string(),
                content_type: crate::models::channel::ContentType::Live,
                extinf_line: "#EXTINF:-1 catchup=\"append\" catchup-days=\"14\",Existing metadata"
                    .to_string(),
                metadata_lines: Vec::new(),
            },
        ];
        let flags = HashMap::from([("42".to_string(), Some(7)), ("43".to_string(), Some(3))]);

        apply_xtream_archive_flags(&mut channels, &flags);

        assert_eq!(channels[0].catchup.as_deref(), Some("xc"));
        assert_eq!(channels[0].catchup_days, Some(7));
        assert_eq!(
            channels[0].extinf_line,
            "#EXTINF:-1 catchup=\"xc\" catchup-days=\"7\",Missing metadata"
        );
        assert_eq!(channels[1].catchup.as_deref(), Some("append"));
        assert_eq!(channels[1].catchup_days, Some(14));
        assert_eq!(
            channels[1].extinf_line,
            "#EXTINF:-1 catchup=\"append\" catchup-days=\"14\",Existing metadata"
        );
    }

    #[test]
    fn archive_flags_only_enrich_live_channels() {
        let mut channels = vec![crate::models::channel::Channel {
            index: 0,
            playlist: "fixture.m3u".to_string(),
            name: "Movie".to_string(),
            group: String::new(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: "https://example.com/movie/user/pass/42.mp4".to_string(),
            content_type: crate::models::channel::ContentType::Movie,
            extinf_line: "#EXTINF:-1,Movie".to_string(),
            metadata_lines: Vec::new(),
        }];
        let flags = HashMap::from([("42".to_string(), Some(7))]);

        apply_xtream_archive_flags(&mut channels, &flags);

        assert_eq!(channels[0].catchup, None);
        assert_eq!(channels[0].catchup_days, None);
        assert_eq!(channels[0].extinf_line, "#EXTINF:-1,Movie");
    }

    #[test]
    fn archive_flags_preserve_explicitly_disabled_catchup() {
        let mut channels = vec![crate::models::channel::Channel {
            index: 0,
            playlist: "fixture.m3u".to_string(),
            name: "No archive".to_string(),
            group: String::new(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            catchup: None,
            catchup_days: None,
            catchup_source: None,
            url: "https://example.com/live/user/pass/42.ts".to_string(),
            content_type: crate::models::channel::ContentType::Live,
            extinf_line: "#EXTINF:-1 catchup=\"false\",No archive".to_string(),
            metadata_lines: Vec::new(),
        }];
        let flags = HashMap::from([("42".to_string(), Some(7))]);

        apply_xtream_archive_flags(&mut channels, &flags);

        assert_eq!(channels[0].catchup, None);
        assert_eq!(channels[0].catchup_days, None);
        assert_eq!(
            channels[0].extinf_line,
            "#EXTINF:-1 catchup=\"false\",No archive"
        );
    }

    #[test]
    fn generated_xtream_entries_escape_provider_supplied_extinf_values() {
        let streams = vec![serde_json::json!({
            "name": "News \"HD\"\n#EXT-X-KEY",
            "stream_id": 42,
            "epg_channel_id": "news\"id",
            "stream_icon": "https://example.com/logo\".png",
            "category_id": "1"
        })];
        let categories = HashMap::from([("1".to_string(), "World\nInjected".to_string())]);
        let mut m3u = String::new();

        let count = append_xtream_streams_to_m3u(
            &mut m3u,
            &streams,
            &categories,
            "https://example.com/live/user/pass/",
            "ts",
        );

        assert_eq!(count, 1);
        assert_eq!(m3u.lines().count(), 2);
        assert!(m3u.contains("tvg-id=\"news\\\"id\""));
        assert!(m3u.contains("tvg-logo=\"https://example.com/logo\\\".png\""));
        assert!(m3u.contains("group-title=\"World Injected\""));
        assert!(m3u.contains(",News \"HD\" #EXT-X-KEY"));
    }

    #[test]
    fn normalize_xtream_server_trims_get_php_and_trailing_slash() {
        let server = normalize_xtream_server("https://demo.example.com:8080/get.php/")
            .expect("server should normalize");
        assert_eq!(server.to_string(), "https://demo.example.com:8080/");
    }

    #[test]
    fn builds_xtream_xmltv_url_with_encoded_credentials() {
        let server = Url::parse("https://demo.example.com/provider/").expect("server URL");
        let url = build_xtream_xmltv_url(&server, "user@example.com", "p&ss");

        assert_eq!(
            url.as_str(),
            "https://demo.example.com/provider/xmltv.php?username=user%40example.com&password=p%26ss"
        );
    }

    #[test]
    fn normalize_xtream_server_rejects_invalid_scheme() {
        let error = normalize_xtream_server("ftp://demo.example.com")
            .expect_err("invalid scheme should fail");
        assert!(error.to_string().contains("must use http:// or https://"));
    }

    #[test]
    fn normalize_xtream_server_accepts_http() {
        let server = normalize_xtream_server("http://demo.example.com")
            .expect("HTTP Xtream servers should remain supported");
        assert_eq!(server.to_string(), "http://demo.example.com/");
    }

    #[test]
    fn build_xtream_download_url_uses_expected_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_download_url(&server, "demo_user", "demo_pass");
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/get.php?username=demo_user&password=demo_pass&type=m3u_plus&output=ts"
        );
    }

    #[test]
    fn build_xtream_player_api_url_uses_expected_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_player_api_url(&server, "demo_user", "demo_pass");
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/player_api.php?username=demo_user&password=demo_pass"
        );
    }

    #[test]
    fn build_xtream_player_api_action_url_appends_action_query() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let url = build_xtream_player_api_action_url(
            &server,
            "demo_user",
            "demo_pass",
            "get_account_info",
        );
        assert_eq!(
            url.as_str(),
            "https://demo.example.com:8080/player_api.php?username=demo_user&password=demo_pass&action=get_account_info"
        );
    }

    #[test]
    fn build_xtream_source_key_excludes_password() {
        let server =
            normalize_xtream_server("https://demo.example.com:8080/").expect("valid server");
        let key = build_xtream_source_key(&server, "demo_user");
        assert_eq!(
            key,
            "xtream:https://demo.example.com:8080|demo_user|m3u_plus|ts"
        );
        assert!(!key.contains("demo_pass"));
    }

    #[test]
    fn extract_xtream_max_connections_parses_user_info_string() {
        let payload = serde_json::json!({
            "user_info": {
                "max_connections": "4"
            }
        });
        assert_eq!(extract_xtream_max_connections(&payload), Some(4));
    }

    #[test]
    fn extract_xtream_max_connections_parses_numeric_fallback() {
        let payload = serde_json::json!({
            "max_connections": 2
        });
        assert_eq!(extract_xtream_max_connections(&payload), Some(2));
    }

    #[test]
    fn extract_xtream_account_info_parses_subscription_fields() {
        let payload = serde_json::json!({
            "user_info": {
                "status": "Active",
                "exp_date": "1735689600",
                "created_at": "1704067200",
                "is_trial": "1",
                "active_cons": "2",
                "max_connections": "4"
            }
        });
        let info = extract_xtream_account_info(&payload).expect("account info should parse");
        assert_eq!(info.status.as_deref(), Some("Active"));
        assert_eq!(info.expires_at_epoch, Some(1_735_689_600));
        assert_eq!(info.created_at_epoch, Some(1_704_067_200));
        assert_eq!(info.is_trial, Some(true));
        assert_eq!(info.active_connections, Some(2));
        assert_eq!(info.max_connections, Some(4));
    }
}
