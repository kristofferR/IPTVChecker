//! Dispatcharr REST API client.
//!
//! Dispatcharr channels each carry an ordered list of provider streams
//! (first wins, the rest are failovers). Loading synthesizes an M3U with one
//! entry per channel x stream, carrying the Dispatcharr IDs as custom
//! `x-dispatcharr-*` EXTINF attributes so they survive the normal parse,
//! cache, and scan pipeline unchanged. The write-back helpers (stats, stream
//! order, deletes) key off those IDs.

use crate::engine::parser::{escape_extinf_value, flatten_extinf_title, parse_extinf_attributes};
use crate::engine::remote_cache::{
    parse_http_url, PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT, PLAYLIST_DOWNLOAD_USER_AGENT,
};
use crate::error::AppError;
use crate::models::channel::ChannelResult;
use futures::stream::{self, StreamExt};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use url::Url;

pub(crate) const DISPATCHARR_API_TIMEOUT: Duration = Duration::from_secs(30);
/// Access tokens live 30 minutes upstream; refresh a little early.
const ACCESS_TOKEN_LIFETIME: Duration = Duration::from_secs(25 * 60);
/// Hard ceiling on followed `next` links, guarding against pagination loops.
const MAX_PAGES: usize = 500;
const STREAMS_BY_IDS_CHUNK: usize = 500;
const CHANNEL_STREAMS_CONCURRENCY: usize = 8;

pub(crate) const ATTR_CHANNEL_ID: &str = "x-dispatcharr-channel-id";
pub(crate) const ATTR_STREAM_ID: &str = "x-dispatcharr-stream-id";
pub(crate) const ATTR_STREAM_ORDER: &str = "x-dispatcharr-stream-order";
pub(crate) const ATTR_STREAM_COUNT: &str = "x-dispatcharr-stream-count";
pub(crate) const ATTR_CHANNEL_UUID: &str = "x-dispatcharr-channel-uuid";
pub(crate) const ATTR_ACCOUNT: &str = "x-dispatcharr-account";
/// The provider stream's own name. Row titles are the channel name, so the
/// source filter and search match whole channels.
pub(crate) const ATTR_STREAM_NAME: &str = "x-dispatcharr-stream-name";
pub(crate) const ATTR_ACCOUNT_ID: &str = "x-dispatcharr-account-id";
pub(crate) const ATTR_MAX_STREAMS: &str = "x-dispatcharr-max-streams";
/// The Dispatcharr server a row came from, so connection limits are shared
/// per server and account across every scan in the app.
pub(crate) const ATTR_SERVER: &str = "x-dispatcharr-server";
/// The channel's complete stream order, including streams without a row
/// (no URL), so edits can be checked against Dispatcharr's full list.
pub(crate) const ATTR_CHANNEL_STREAMS: &str = "x-dispatcharr-channel-streams";
/// Marks the one row of a channel that has no playable stream, so the
/// channel still shows (and can be given streams). Never probed.
pub(crate) const ATTR_EMPTY: &str = "x-dispatcharr-empty";

/// A channel's no-streams placeholder row (see `ATTR_EMPTY`).
pub(crate) fn is_empty_channel_row(extinf_line: &str) -> bool {
    extinf_line.contains(ATTR_EMPTY)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DispatcharrAuth {
    ApiKey(String),
    Login { username: String, password: String },
}

impl DispatcharrAuth {
    /// API key wins when both are supplied: it is stateless and needs no
    /// token refresh.
    pub(crate) fn from_parts(
        username: Option<&str>,
        password: Option<&str>,
        api_key: Option<&str>,
    ) -> Result<Self, AppError> {
        let clean = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        };
        if let Some(api_key) = clean(api_key) {
            return Ok(Self::ApiKey(api_key));
        }
        match (clean(username), clean(password)) {
            (Some(username), Some(password)) => Ok(Self::Login { username, password }),
            _ => Err(AppError::Validation(
                "Dispatcharr needs an API key or a username and password".to_string(),
            )),
        }
    }

    /// Account part of the source identity. API keys contribute a short
    /// fingerprint, so two keys on one server stay separate sources.
    pub(crate) fn identity_label(&self) -> String {
        match self {
            Self::ApiKey(key) => format!("api-key:{}", api_key_fingerprint(key)),
            Self::Login { username, .. } => username.clone(),
        }
    }
}

/// Short, non-reversible fingerprint of an API key (first 12 hex digits of
/// its SHA-256). The frontend computes the same value for recents that do not
/// remember the key.
pub(crate) fn api_key_fingerprint(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

/// Where a pasted Dispatcharr endpoint ("/proxy/ts/...", "/output/m3u",
/// "/api/channels/...", or a bare trailing "/api") starts in a URL path. A
/// segment such as "/api/" that is not followed by a Dispatcharr endpoint
/// belongs to a reverse-proxy prefix ("/api/dispatcharr") and is kept.
fn dispatcharr_endpoint_start(path: &str) -> Option<usize> {
    const ENDPOINTS: &[(&str, &[&str])] = &[
        ("/proxy/", &["ts/", "hls/", "vod/"]),
        ("/output/", &["m3u", "epg"]),
        (
            "/api/",
            &[
                "channels/",
                "m3u/",
                "epg/",
                "accounts/",
                "core/",
                "hdhr/",
                "vod/",
                "catchup/",
                "connect/",
                "plugins/",
                "schema/",
            ],
        ),
    ];
    // Trailing slash so a path ending in a marker ("/dispatcharr/api") matches.
    let lower = format!("{}/", path.to_ascii_lowercase());
    let mut start = None;
    for (marker, next) in ENDPOINTS {
        for (at, _) in lower.match_indices(marker) {
            let rest = &lower[at + marker.len()..];
            // Only slashes left: a bare "/api/" ending the URL.
            if rest.trim_matches('/').is_empty()
                || next.iter().any(|segment| rest.starts_with(segment))
            {
                start = start.max(Some(at));
            }
        }
    }
    start
}

/// Normalize a Dispatcharr base URL. Accepts pasted proxy/output/API URLs and
/// keeps any reverse-proxy path prefix in front of them.
pub(crate) fn normalize_dispatcharr_server(server: &str) -> Result<Url, AppError> {
    let mut parsed = parse_http_url(server, "Invalid Dispatcharr server URL")?;
    if parsed.host_str().is_none() {
        return Err(AppError::Parse(
            "Invalid Dispatcharr server URL: missing host".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Parse(
            "Dispatcharr server URL must not include credentials".to_string(),
        ));
    }
    let path = parsed.path().to_string();
    let prefix_end = dispatcharr_endpoint_start(&path).unwrap_or(path.len());
    let prefix = path[..prefix_end.min(path.len())].trim_end_matches('/');
    parsed.set_path(if prefix.is_empty() { "/" } else { prefix });
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

/// Base URL without a trailing slash, for joining API paths.
fn base_string(base: &Url) -> String {
    base.as_str().trim_end_matches('/').to_string()
}

pub(crate) fn build_dispatcharr_source_key(base: &Url, auth: &DispatcharrAuth) -> String {
    dispatcharr_source_key(base, &auth.identity_label())
}

/// Identity from an already computed account label.
pub(crate) fn dispatcharr_source_key(base: &Url, account_label: &str) -> String {
    format!("dispatcharr:{}|{}", base_string(base), account_label)
}

/// "host:port" (or bare host) display label.
pub(crate) fn dispatcharr_host_label(base: &Url) -> String {
    match (base.host_str(), base.port()) {
        (Some(host), Some(port)) => format!("{}:{}", host, port),
        (Some(host), None) => host.to_string(),
        _ => base.to_string(),
    }
}

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct DispatcharrChannel {
    pub id: i64,
    pub uuid: Option<String>,
    pub name: String,
    pub channel_number: Option<f64>,
    pub channel_group_id: Option<i64>,
    pub tvg_id: Option<String>,
    pub logo_id: Option<i64>,
    /// Stream IDs in failover order.
    pub streams: Vec<i64>,
    pub effective_name: Option<String>,
    pub effective_channel_number: Option<f64>,
    pub effective_channel_group_id: Option<i64>,
    pub effective_tvg_id: Option<String>,
    pub effective_logo_id: Option<i64>,
}

impl DispatcharrChannel {
    fn display_name(&self) -> &str {
        self.effective_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&self.name)
    }

    fn number(&self) -> Option<f64> {
        self.effective_channel_number.or(self.channel_number)
    }

    fn group_id(&self) -> Option<i64> {
        self.effective_channel_group_id.or(self.channel_group_id)
    }

    /// The channel's ID in Dispatcharr's `/output/epg`, which by default
    /// (`tvg_id_source=channel_number`) keys channels by number, falling back
    /// to the channel ID.
    fn guide_id(&self) -> String {
        self.number()
            .map(format_channel_number)
            .unwrap_or_else(|| self.id.to_string())
    }

    fn logo_id(&self) -> Option<i64> {
        self.effective_logo_id.or(self.logo_id)
    }

    /// The EPG ID the channel is matched to guide data with, if any.
    fn epg_id(&self) -> Option<&str> {
        [&self.effective_tvg_id, &self.tvg_id]
            .into_iter()
            .flatten()
            .map(|value| value.trim())
            .find(|value| !value.is_empty())
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct DispatcharrStream {
    pub id: i64,
    pub name: String,
    pub tvg_id: Option<String>,
    pub url: Option<String>,
    pub m3u_account: Option<i64>,
    pub is_custom: bool,
    pub is_stale: bool,
    pub stream_stats: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct DispatcharrGroup {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct DispatcharrM3uAccount {
    pub id: i64,
    pub name: String,
    /// Concurrent streams the provider allows; 0 means unlimited.
    pub max_streams: u32,
    /// Connection profiles (for example extra logins). Dispatcharr streams
    /// through the active ones, each with its own limit.
    pub profiles: Vec<DispatcharrM3uProfile>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct DispatcharrM3uProfile {
    pub id: i64,
    pub max_streams: u32,
    pub is_active: bool,
}

impl DispatcharrM3uAccount {
    /// Concurrent streams across the account's active profiles, 0 when any
    /// of them is unlimited. Falls back to the account's own limit when it
    /// reports no active profiles.
    pub(crate) fn connection_limit(&self) -> u32 {
        let active = self
            .profiles
            .iter()
            .filter(|profile| profile.is_active)
            .collect::<Vec<_>>();
        if active.is_empty() {
            return self.max_streams;
        }
        if active.iter().any(|profile| profile.max_streams == 0) {
            return 0;
        }
        active.iter().map(|profile| profile.max_streams).sum()
    }
}

/// A channel Dispatcharr is streaming right now (`/proxy/ts/status`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct ActiveChannel {
    m3u_profile_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct ProxyStatus {
    channels: Vec<ActiveChannel>,
}

/// DRF list endpoints answer either with a bare array or a paginated page.
#[derive(Deserialize)]
#[serde(untagged)]
enum ListPage<T> {
    Paginated {
        results: Vec<T>,
        #[serde(default)]
        next: Option<String>,
    },
    Bare(Vec<T>),
}

// ── Client ──────────────────────────────────────────────────────────────────

struct JwtTokens {
    access: String,
    refresh: Option<String>,
    expires_at: Instant,
}

pub(crate) struct DispatcharrClient {
    base: Url,
    auth: DispatcharrAuth,
    http: reqwest::Client,
    tokens: tokio::sync::Mutex<Option<JwtTokens>>,
}

impl DispatcharrClient {
    pub(crate) fn new(
        base: Url,
        auth: DispatcharrAuth,
        accept_invalid_certs: bool,
    ) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(PLAYLIST_DOWNLOAD_CONNECT_TIMEOUT)
            .timeout(DISPATCHARR_API_TIMEOUT)
            .danger_accept_invalid_certs(accept_invalid_certs)
            .build()
            .map_err(|error| {
                AppError::Other(format!(
                    "Failed to initialize HTTP client for Dispatcharr: {}",
                    error
                ))
            })?;
        Ok(Self {
            base,
            auth,
            http,
            tokens: tokio::sync::Mutex::new(None),
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url, AppError> {
        Url::parse(&format!("{}{}", base_string(&self.base), path)).map_err(|error| {
            AppError::Other(format!("Invalid Dispatcharr endpoint {}: {}", path, error))
        })
    }

    /// Move a pagination `next` link onto our base URL. Behind a reverse
    /// proxy Django reports its internal host (and no path prefix).
    fn rewrite_next(&self, next: &str) -> Option<Url> {
        let parsed = Url::parse(next)
            .ok()
            .or_else(|| self.base.join(next).ok())?;
        let prefix = self.base.path().trim_end_matches('/');
        let path = if prefix.is_empty() || parsed.path().starts_with(&format!("{}/", prefix)) {
            parsed.path().to_string()
        } else {
            format!("{}{}", prefix, parsed.path())
        };
        let mut rewritten = self.base.clone();
        rewritten.set_path(&path);
        rewritten.set_query(parsed.query());
        Some(rewritten)
    }

    async fn post_token(&self, path: &str, body: Value) -> Result<JwtTokens, AppError> {
        let response = self
            .http
            .post(self.endpoint(path)?)
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(if status == StatusCode::UNAUTHORIZED {
                AppError::Other("Dispatcharr rejected the username or password".to_string())
            } else {
                status_error(path, status, response).await
            });
        }
        let payload: Value = response.json().await?;
        let access = payload
            .get("access")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Other("Dispatcharr login returned no token".to_string()))?;
        Ok(JwtTokens {
            access: access.to_string(),
            refresh: payload
                .get("refresh")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            expires_at: Instant::now() + ACCESS_TOKEN_LIFETIME,
        })
    }

    /// Current `Authorization` header value: the API key, or a JWT that is
    /// refreshed on expiry and re-issued by a full login when refresh fails.
    async fn authorization(&self, force_login: bool) -> Result<String, AppError> {
        let (username, password) = match &self.auth {
            DispatcharrAuth::ApiKey(key) => return Ok(format!("ApiKey {}", key)),
            DispatcharrAuth::Login { username, password } => (username, password),
        };
        let mut tokens = self.tokens.lock().await;
        if force_login {
            *tokens = None;
        }
        if let Some(current) = tokens.as_ref() {
            if Instant::now() < current.expires_at {
                return Ok(format!("Bearer {}", current.access));
            }
        }
        let refresh = tokens.as_ref().and_then(|current| current.refresh.clone());
        let refreshed = match refresh {
            Some(refresh) => self
                .post_token(
                    "/api/accounts/token/refresh/",
                    json!({ "refresh": refresh }),
                )
                .await
                .map(|mut fresh| {
                    // Refresh responses only rotate the refresh token when
                    // the server is configured to; keep the old one otherwise.
                    fresh.refresh = fresh.refresh.or(Some(refresh));
                    fresh
                })
                .ok(),
            None => None,
        };
        let fresh = match refreshed {
            Some(fresh) => fresh,
            None => {
                self.post_token(
                    "/api/accounts/token/",
                    json!({ "username": username, "password": password }),
                )
                .await?
            }
        };
        let header = format!("Bearer {}", fresh.access);
        *tokens = Some(fresh);
        Ok(header)
    }

    /// Send an authenticated request, retrying once with a fresh login when a
    /// JWT is rejected. Non-2xx responses become errors.
    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<reqwest::Response, AppError> {
        self.send_checked(method, url, body, false)
            .await?
            .ok_or_else(|| AppError::Other("Dispatcharr returned HTTP 404".to_string()))
    }

    /// `send`, but a 404 is `Ok(None)` when `not_found_ok` is set.
    async fn send_checked(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        not_found_ok: bool,
    ) -> Result<Option<reqwest::Response>, AppError> {
        let mut force_login = false;
        loop {
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(
                    reqwest::header::AUTHORIZATION,
                    self.authorization(force_login).await?,
                );
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = request.send().await?;
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED
                && !force_login
                && matches!(self.auth, DispatcharrAuth::Login { .. })
            {
                force_login = true;
                continue;
            }
            if status.is_success() {
                return Ok(Some(response));
            }
            if not_found_ok && status == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(AppError::Other(match self.auth {
                    DispatcharrAuth::ApiKey(_) => format!(
                        "Dispatcharr rejected the API key (HTTP {})",
                        status.as_u16()
                    ),
                    DispatcharrAuth::Login { .. } => {
                        format!("Dispatcharr rejected the login (HTTP {})", status.as_u16())
                    }
                }));
            }
            return Err(status_error(url.path(), status, response).await);
        }
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, AppError> {
        let response = self.send(method, self.endpoint(path)?, body).await?;
        let bytes = response.bytes().await?;
        serde_json::from_slice(&bytes).map_err(|error| {
            AppError::Parse(format!(
                "Unexpected Dispatcharr response from {}: {}",
                path, error
            ))
        })
    }

    /// GET every item of a list endpoint, following DRF pagination.
    async fn fetch_all<T: DeserializeOwned>(&self, path: &str) -> Result<Vec<T>, AppError> {
        let mut items = Vec::new();
        let mut url = Some(self.endpoint(path)?);
        let mut pages = 0;
        while let Some(current) = url.take() {
            pages += 1;
            if pages > MAX_PAGES {
                return Err(AppError::Other(format!(
                    "Dispatcharr {} exceeded {} pages",
                    path, MAX_PAGES
                )));
            }
            let bytes = self.send(Method::GET, current, None).await?.bytes().await?;
            match serde_json::from_slice::<ListPage<T>>(&bytes).map_err(|error| {
                AppError::Parse(format!(
                    "Unexpected Dispatcharr response from {}: {}",
                    path, error
                ))
            })? {
                ListPage::Bare(page) => items.extend(page),
                ListPage::Paginated { results, next } => {
                    items.extend(results);
                    url = next.as_deref().and_then(|next| self.rewrite_next(next));
                }
            }
        }
        Ok(items)
    }

    pub(crate) async fn fetch_channels(&self) -> Result<Vec<DispatcharrChannel>, AppError> {
        self.fetch_all("/api/channels/channels/").await
    }

    pub(crate) async fn fetch_groups(&self) -> Result<Vec<DispatcharrGroup>, AppError> {
        self.fetch_all("/api/channels/groups/").await
    }

    pub(crate) async fn fetch_m3u_accounts(&self) -> Result<Vec<DispatcharrM3uAccount>, AppError> {
        self.fetch_all("/api/m3u/accounts/").await
    }

    pub(crate) fn base(&self) -> &Url {
        &self.base
    }

    /// Provider streams that could replace a channel's streams: those with
    /// the channel's EPG ID, then those whose names match, best first.
    /// Streams already linked to the channel are left out.
    pub(crate) async fn find_candidate_streams(
        &self,
        channel: &DispatcharrChannel,
        query: Option<&str>,
    ) -> Result<Vec<(DispatcharrStream, CandidateMatch)>, AppError> {
        let wanted = query
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .map(normalize_stream_name)
            .unwrap_or_else(|| normalize_stream_name(channel.display_name()));
        let epg_id = channel.epg_id();
        let mut searches = Vec::new();
        if !wanted.is_empty() {
            searches.push(("search", wanted.as_str()));
        }
        if let Some(epg_id) = epg_id {
            searches.push(("tvg_id", epg_id));
        }
        let mut found = HashMap::<i64, DispatcharrStream>::new();
        for (key, value) in searches {
            let mut url = self.endpoint("/api/channels/streams/")?;
            url.query_pairs_mut()
                .append_pair("hide_stale", "true")
                .append_pair("page_size", &CANDIDATE_SEARCH_LIMIT.to_string())
                .append_pair(key, value);
            let bytes = self.send(Method::GET, url, None).await?.bytes().await?;
            let page =
                serde_json::from_slice::<ListPage<DispatcharrStream>>(&bytes).map_err(|error| {
                    AppError::Parse(format!("Unexpected Dispatcharr stream search: {}", error))
                })?;
            let streams = match page {
                ListPage::Paginated { results, .. } => results,
                ListPage::Bare(items) => items,
            };
            for stream in streams {
                found.entry(stream.id).or_insert(stream);
            }
        }
        // Countries the channel is known under: its streams' name tags and its
        // EPG ID's suffix. "GB" and "UK" name the same country.
        let normalize_country = |country: String| {
            if country == "GB" {
                "UK".to_string()
            } else {
                country
            }
        };
        let linked = if channel.streams.is_empty() {
            Vec::new()
        } else {
            self.fetch_streams_by_ids(&channel.streams)
                .await
                .inspect_err(|error| {
                    log::warn!(
                        "[dispatcharr] linked stream lookup for country ranking failed: {}",
                        error
                    )
                })
                .unwrap_or_default()
        };
        let mut countries = linked
            .iter()
            .filter_map(|stream| name_country(&stream.name))
            .map(normalize_country)
            .collect::<std::collections::HashSet<_>>();
        countries.extend(epg_id.and_then(epg_country).map(normalize_country));
        let mut candidates = found
            .into_values()
            .filter(|stream| !channel.streams.contains(&stream.id))
            .filter(|stream| {
                stream
                    .url
                    .as_deref()
                    .is_some_and(|url| !url.trim().is_empty())
            })
            .map(|stream| {
                let matched = CandidateMatch {
                    epg: epg_id.is_some_and(|epg_id| {
                        stream
                            .tvg_id
                            .as_deref()
                            .is_some_and(|tvg_id| tvg_id.trim().eq_ignore_ascii_case(epg_id))
                    }),
                    similarity: name_similarity(&wanted, &normalize_stream_name(&stream.name)),
                    other_country: name_country(&stream.name)
                        .map(normalize_country)
                        .filter(|country| !countries.is_empty() && !countries.contains(country)),
                };
                (stream, matched)
            })
            .filter(|(_, matched)| matched.epg || matched.similarity >= CANDIDATE_MIN_SIMILARITY)
            .collect::<Vec<_>>();
        let rank = |matched: &CandidateMatch| {
            let penalty = if matched.other_country.is_some() {
                OTHER_COUNTRY_PENALTY
            } else {
                0
            };
            matched.similarity.saturating_sub(penalty)
        };
        candidates.sort_by(|(a, am), (b, bm)| {
            bm.epg
                .cmp(&am.epg)
                .then(rank(bm).cmp(&rank(am)))
                .then_with(|| a.name.cmp(&b.name))
        });
        candidates.truncate(CANDIDATE_LIMIT);
        Ok(candidates)
    }

    /// Provider connections Dispatcharr's viewers hold, per M3U account.
    pub(crate) async fn fetch_account_viewers(&self) -> Result<HashMap<i64, usize>, AppError> {
        let accounts = self.fetch_m3u_accounts().await?;
        let account_of = accounts
            .iter()
            .flat_map(|account| {
                account
                    .profiles
                    .iter()
                    .map(move |profile| (profile.id, account.id))
            })
            .collect::<HashMap<_, _>>();
        let status: ProxyStatus = self.json(Method::GET, "/proxy/ts/status", None).await?;
        let mut viewers = HashMap::new();
        for account in status
            .channels
            .iter()
            .filter_map(|channel| account_of.get(&channel.m3u_profile_id?))
        {
            *viewers.entry(*account).or_insert(0) += 1;
        }
        Ok(viewers)
    }

    /// Ask Dispatcharr to re-fetch an M3U account's playlist.
    pub(crate) async fn refresh_m3u_account(&self, account_id: i64) -> Result<(), AppError> {
        self.send(
            Method::POST,
            self.endpoint(&format!("/api/m3u/refresh/{}/", account_id))?,
            None,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn fetch_streams_by_ids(
        &self,
        ids: &[i64],
    ) -> Result<Vec<DispatcharrStream>, AppError> {
        let mut streams = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(STREAMS_BY_IDS_CHUNK) {
            let body = json!({ "ids": chunk });
            // Current servers answer with a bare list; follow pages in case
            // a server paginates, repeating the request body for each page.
            let mut url = Some(self.endpoint("/api/channels/streams/by-ids/")?);
            let mut pages = 0;
            while let Some(current) = url.take() {
                pages += 1;
                if pages > MAX_PAGES {
                    return Err(AppError::Other(format!(
                        "Dispatcharr stream lookup exceeded {} pages",
                        MAX_PAGES
                    )));
                }
                let bytes = self
                    .send(Method::POST, current, Some(&body))
                    .await?
                    .bytes()
                    .await?;
                match serde_json::from_slice::<ListPage<DispatcharrStream>>(&bytes).map_err(
                    |error| {
                        AppError::Parse(format!("Unexpected Dispatcharr stream lookup: {}", error))
                    },
                )? {
                    ListPage::Bare(items) => streams.extend(items),
                    ListPage::Paginated { results, next } => {
                        streams.extend(results);
                        url = next.as_deref().and_then(|next| self.rewrite_next(next));
                    }
                }
            }
        }
        Ok(streams)
    }

    /// Streams for every channel, keyed by stream id. Uses the bulk endpoint
    /// and falls back to per-channel requests on servers that lack it.
    pub(crate) async fn fetch_channel_streams(
        &self,
        channels: &[DispatcharrChannel],
    ) -> Result<HashMap<i64, DispatcharrStream>, AppError> {
        let mut ids = channels
            .iter()
            .flat_map(|channel| channel.streams.iter().copied())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        match self.fetch_streams_by_ids(&ids).await {
            Ok(streams) => return Ok(streams.into_iter().map(|s| (s.id, s)).collect()),
            Err(error) => log::info!(
                "[dispatcharr] bulk stream fetch failed ({}), falling back to per-channel",
                error
            ),
        }
        let channel_ids = channels
            .iter()
            .filter(|channel| !channel.streams.is_empty())
            .map(|channel| format!("/api/channels/channels/{}/streams/", channel.id))
            .collect::<Vec<_>>();
        let results = stream::iter(channel_ids)
            .map(|path| async move { self.fetch_all::<DispatcharrStream>(&path).await })
            .buffer_unordered(CHANNEL_STREAMS_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let mut streams = HashMap::new();
        for result in results {
            for stream in result? {
                streams.insert(stream.id, stream);
            }
        }
        Ok(streams)
    }

    /// Replace a stream's stats; returns the stats Dispatcharr stored.
    pub(crate) async fn patch_stream_stats(
        &self,
        stream_id: i64,
        stats: &Map<String, Value>,
        updated_at: &str,
    ) -> Result<Option<Value>, AppError> {
        let stream: DispatcharrStream = self
            .json(
                Method::PATCH,
                &format!("/api/channels/streams/{}/", stream_id),
                Some(&json!({
                    "stream_stats": stats,
                    "stream_stats_updated_at": updated_at,
                })),
            )
            .await?;
        Ok(stream.stream_stats)
    }

    /// Merge `update` into a stream's current stats and store the result.
    /// The PATCH replaces the whole object, so the stream is read right
    /// before writing to keep fields Dispatcharr updated meanwhile.
    pub(crate) async fn write_stream_stats(
        &self,
        stream_id: i64,
        update: &Map<String, Value>,
        updated_at: &str,
    ) -> Result<Option<Value>, AppError> {
        let current: DispatcharrStream = self
            .json(
                Method::GET,
                &format!("/api/channels/streams/{}/", stream_id),
                None,
            )
            .await?;
        let merged = merge_stream_stats(current.stream_stats.as_ref(), update);
        self.patch_stream_stats(stream_id, &merged, updated_at)
            .await
    }

    /// One channel read fresh, or `None` when Dispatcharr no longer has it.
    pub(crate) async fn fetch_channel(
        &self,
        channel_id: i64,
    ) -> Result<Option<DispatcharrChannel>, AppError> {
        let path = format!("/api/channels/channels/{}/", channel_id);
        let Some(response) = self
            .send_checked(Method::GET, self.endpoint(&path)?, None, true)
            .await?
        else {
            return Ok(None);
        };
        let bytes = response.bytes().await?;
        serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            AppError::Parse(format!(
                "Unexpected Dispatcharr response from {}: {}",
                path, error
            ))
        })
    }

    /// Set a channel's complete ordered stream list. Dispatcharr deletes the
    /// links missing from the list, so this covers remove, reorder, and
    /// promote. Returns the order Dispatcharr stored.
    pub(crate) async fn set_channel_streams(
        &self,
        channel_id: i64,
        stream_ids: &[i64],
    ) -> Result<Vec<i64>, AppError> {
        let channel: DispatcharrChannel = self
            .json(
                Method::PATCH,
                &format!("/api/channels/channels/{}/", channel_id),
                Some(&json!({ "streams": stream_ids })),
            )
            .await?;
        Ok(channel.streams)
    }
}

async fn status_error(path: &str, status: StatusCode, response: reqwest::Response) -> AppError {
    let body = response.text().await.unwrap_or_default();
    let snippet = body.trim().chars().take(200).collect::<String>();
    if snippet.is_empty() {
        AppError::Other(format!(
            "Dispatcharr {} returned HTTP {}",
            path,
            status.as_u16()
        ))
    } else {
        AppError::Other(format!(
            "Dispatcharr {} returned HTTP {}: {}",
            path,
            status.as_u16(),
            snippet
        ))
    }
}

// ── Sessions ────────────────────────────────────────────────────────────────

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<DispatcharrClient>>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Arc<DispatcharrClient>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Connection slots of one provider account, shared by every scan in the
/// app (several windows can scan the same source at once), so together they
/// never exceed the account's stream limit. Keyed by Dispatcharr server and
/// account; a changed limit resizes the existing pool rather than adding a
/// second one.
pub(crate) fn account_connection_slots(
    extinf_line: &str,
    account_id: i64,
    limit: usize,
) -> Arc<tokio::sync::Semaphore> {
    type Pools = HashMap<String, (Arc<tokio::sync::Semaphore>, usize)>;
    static SLOTS: OnceLock<Mutex<Pools>> = OnceLock::new();
    let key = format!("{}|{}", dispatcharr_server(extinf_line), account_id);
    let mut slots = SLOTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (pool, current) = slots
        .entry(key)
        .or_insert_with(|| (Arc::new(tokio::sync::Semaphore::new(limit)), limit));
    if limit > *current {
        pool.add_permits(limit - *current);
    } else if limit < *current {
        let excess = *current - limit;
        let retired = pool.forget_permits(excess);
        if retired < excess {
            // Retire permits still in use as they come back. The semaphore is
            // fair, so this queues ahead of later callers and the smaller
            // limit holds from now on.
            let pool = Arc::clone(pool);
            let pending = u32::try_from(excess - retired).unwrap_or(u32::MAX);
            tauri::async_runtime::spawn(async move {
                if let Ok(permits) = pool.acquire_many_owned(pending).await {
                    permits.forget();
                }
            });
        }
    }
    *current = limit;
    Arc::clone(pool)
}

// ── Replacement candidates ───────────────────────────────────────────────────

/// Provider streams fetched per search.
const CANDIDATE_SEARCH_LIMIT: usize = 200;
/// Candidates offered for one channel.
const CANDIDATE_LIMIT: usize = 40;
/// Name similarity (percent) a candidate needs without an EPG match.
const CANDIDATE_MIN_SIMILARITY: u8 = 60;

/// Why a provider stream is offered for a channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct CandidateMatch {
    /// Carries the channel's EPG ID.
    pub epg: bool,
    /// Name similarity with the channel, 0 to 100.
    pub similarity: u8,
    /// Country tag from the stream name ("CH" in "CH: News One"), when it
    /// differs from every country the channel is known under. The same
    /// name in another country is often a different channel.
    pub other_country: Option<String>,
}

/// Similarity points a candidate tagged with another country gives up when
/// ranked, so a same-country match of almost the same name comes first.
const OTHER_COUNTRY_PENALTY: u8 = 15;

/// Country tag of a provider stream name: its short letter prefix ("UK" in
/// "UK: Name", "US" in "US| NAME").
pub(crate) fn name_country(name: &str) -> Option<String> {
    let name = name.trim();
    ["|", ":", " - "].iter().find_map(|separator| {
        let (prefix, rest) = name.split_once(separator)?;
        let prefix = prefix.trim();
        (!rest.trim().is_empty()
            && (2..=3).contains(&prefix.chars().count())
            && prefix.chars().all(|c| c.is_ascii_alphabetic()))
        .then(|| prefix.to_ascii_uppercase())
    })
}

/// Country of an EPG ID such as "NewsOne.uk" or "Channel.uk@HD".
fn epg_country(epg_id: &str) -> Option<String> {
    let base = epg_id.split('@').next()?;
    let (_, suffix) = base.rsplit_once('.')?;
    ((2..=3).contains(&suffix.len()) && suffix.chars().all(|c| c.is_ascii_alphabetic()))
        .then(|| suffix.to_ascii_uppercase())
}

/// Tags that say how a stream is delivered, not what it is.
const NAME_NOISE: &[&str] = &[
    "hd", "fhd", "uhd", "sd", "4k", "8k", "hevc", "h264", "h265", "hdr", "raw", "backup", "vip",
    "1080p", "1080i", "720p", "2160p", "576p", "480p", "50fps", "60fps",
];

/// A stream or channel name reduced to what identifies the channel: no
/// provider prefix ("US|", "UK:", "EN -"), bracketed notes, or quality tags.
pub(crate) fn normalize_stream_name(name: &str) -> String {
    let mut rest = name.trim();
    for separator in ["|", ":", " - "] {
        if let Some((prefix, tail)) = rest.split_once(separator) {
            if prefix.trim().chars().count() <= 5 && !tail.trim().is_empty() {
                rest = tail;
                break;
            }
        }
    }
    let mut cleaned = String::with_capacity(rest.len());
    let mut depth = 0usize;
    for c in rest.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => cleaned.push(c),
            _ => {}
        }
    }
    cleaned
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '+')
        .filter(|token| !token.is_empty() && !NAME_NOISE.contains(token))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Dice similarity of two normalized names over character pairs, 0 to 100.
pub(crate) fn name_similarity(a: &str, b: &str) -> u8 {
    fn pairs(value: &str) -> Vec<(char, char)> {
        let chars = value
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<Vec<_>>();
        chars.windows(2).map(|pair| (pair[0], pair[1])).collect()
    }
    if a == b {
        return if a.is_empty() { 0 } else { 100 };
    }
    let (left, mut right) = (pairs(a), pairs(b));
    if left.is_empty() || right.is_empty() {
        return 0;
    }
    let total = left.len() + right.len();
    let mut shared = 0;
    for pair in left {
        if let Some(position) = right.iter().position(|other| *other == pair) {
            right.swap_remove(position);
            shared += 1;
        }
    }
    ((200 * shared) / total).min(100) as u8
}

/// How long a read of Dispatcharr's live connections stays current.
const VIEWERS_TTL: Duration = Duration::from_secs(5);

/// Viewers on one Dispatcharr server, per M3U account. Shared by every scan
/// and cached briefly, so waiting rows don't flood the API.
pub(crate) struct AccountViewers {
    client: Arc<DispatcharrClient>,
    counts: tokio::sync::Mutex<Option<(Instant, HashMap<i64, usize>)>>,
}

impl AccountViewers {
    /// Viewers holding `account_id`'s connections, re-read when `fresh` or
    /// when the last read is old. A failed read counts as none, so an
    /// unreachable status endpoint never stalls a scan.
    pub(crate) async fn on_account(&self, account_id: i64, fresh: bool) -> usize {
        let mut counts = self.counts.lock().await;
        if fresh
            || counts
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed() >= VIEWERS_TTL)
        {
            let read = self
                .client
                .fetch_account_viewers()
                .await
                .inspect_err(|error| {
                    log::warn!("[dispatcharr] live connection read failed: {}", error)
                })
                .unwrap_or_default();
            *counts = Some((Instant::now(), read));
        }
        counts
            .as_ref()
            .and_then(|(_, read)| read.get(&account_id).copied())
            .unwrap_or(0)
    }
}

/// Viewer counts for a loaded Dispatcharr connection, read through that
/// connection's own session. `None` when the session is gone.
pub(crate) fn account_viewers(connection: &str) -> Option<Arc<AccountViewers>> {
    type Registry = HashMap<String, Arc<AccountViewers>>;
    static VIEWERS: OnceLock<Mutex<Registry>> = OnceLock::new();
    let client = get_session(connection)?;
    let mut registry = VIEWERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = registry.entry(connection.to_string()).or_insert_with(|| {
        Arc::new(AccountViewers {
            client: Arc::clone(&client),
            counts: tokio::sync::Mutex::new(None),
        })
    });
    // A reopened source replaces its session.
    if !Arc::ptr_eq(&entry.client, &client) {
        *entry = Arc::new(AccountViewers {
            client,
            counts: tokio::sync::Mutex::new(None),
        });
    }
    Some(Arc::clone(entry))
}

pub(crate) fn register_session(source_identity: &str, client: Arc<DispatcharrClient>) {
    if let Ok(mut sessions) = sessions().lock() {
        sessions.insert(source_identity.to_string(), client);
    }
}

pub(crate) fn get_session(source_identity: &str) -> Option<Arc<DispatcharrClient>> {
    sessions().lock().ok()?.get(source_identity).cloned()
}

// ── M3U synthesis ───────────────────────────────────────────────────────────

/// IDs embedded in a synthesized EXTINF line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct DispatcharrStreamRef {
    pub channel_id: i64,
    pub stream_id: i64,
    pub stream_order: usize,
    pub stream_count: usize,
    pub channel_uuid: Option<String>,
}

pub(crate) fn is_dispatcharr_row(extinf_line: &str) -> bool {
    extinf_line.contains(ATTR_STREAM_ID)
}

pub(crate) fn dispatcharr_ids_from_extinf(extinf_line: &str) -> Option<DispatcharrStreamRef> {
    if !extinf_line.contains(ATTR_STREAM_ID) {
        return None;
    }
    let attrs = parse_extinf_attributes(extinf_line)
        .into_iter()
        .collect::<HashMap<_, _>>();
    let number = |key: &str| attrs.get(key).and_then(|value| value.trim().parse().ok());
    Some(DispatcharrStreamRef {
        channel_id: number(ATTR_CHANNEL_ID)?,
        stream_id: number(ATTR_STREAM_ID)?,
        stream_order: number(ATTR_STREAM_ORDER).unwrap_or(0) as usize,
        stream_count: number(ATTR_STREAM_COUNT).unwrap_or(1) as usize,
        channel_uuid: attrs
            .get(ATTR_CHANNEL_UUID)
            .filter(|value| !value.is_empty())
            .cloned(),
    })
}

/// The Dispatcharr server a row came from (empty when it carries none).
pub(crate) fn dispatcharr_server(extinf_line: &str) -> String {
    parse_extinf_attributes(extinf_line)
        .into_iter()
        .find_map(|(key, value)| (key == ATTR_SERVER).then_some(value))
        .unwrap_or_default()
}

/// A row's provider account name, for messages.
pub(crate) fn account_label(extinf_line: &str) -> String {
    let attrs = parse_extinf_attributes(extinf_line)
        .into_iter()
        .collect::<HashMap<_, _>>();
    attrs
        .get(ATTR_ACCOUNT)
        .cloned()
        .or_else(|| {
            attrs
                .get(ATTR_ACCOUNT_ID)
                .map(|id| format!("Account {}", id))
        })
        .unwrap_or_else(|| "Provider".to_string())
}

/// The provider account a row streams from and how many concurrent streams
/// it allows, when Dispatcharr reports a limit.
pub(crate) fn dispatcharr_connection_limit(extinf_line: &str) -> Option<(i64, usize)> {
    if !extinf_line.contains(ATTR_MAX_STREAMS) {
        return None;
    }
    let attrs = parse_extinf_attributes(extinf_line)
        .into_iter()
        .collect::<HashMap<_, _>>();
    let account_id = attrs.get(ATTR_ACCOUNT_ID)?.trim().parse().ok()?;
    let limit = attrs
        .get(ATTR_MAX_STREAMS)?
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|limit| *limit > 0)?;
    Some((account_id, limit))
}

fn format_channel_number(number: f64) -> String {
    if number.fract() == 0.0 {
        format!("{}", number as i64)
    } else {
        format!("{}", number)
    }
}

/// Build an M3U with one entry per channel x stream, in channel-number order
/// and failover order within each channel.
pub(crate) fn build_m3u(
    base: &Url,
    channels: &[DispatcharrChannel],
    streams: &HashMap<i64, DispatcharrStream>,
    groups: &HashMap<i64, String>,
    accounts: &HashMap<i64, DispatcharrM3uAccount>,
) -> String {
    let base = base_string(base);
    let mut ordered = channels.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| {
        a.number()
            .unwrap_or(f64::MAX)
            .total_cmp(&b.number().unwrap_or(f64::MAX))
            .then_with(|| a.display_name().cmp(b.display_name()))
    });

    let mut m3u = format!(
        "#EXTM3U x-tvg-url=\"{}\"\n",
        escape_extinf_value(&format!("{}/output/epg", base))
    );
    for channel in ordered {
        let count = channel.streams.len();
        let channel_streams = channel
            .streams
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let group = channel
            .group_id()
            .and_then(|id| groups.get(&id))
            .map(String::as_str)
            .unwrap_or("");
        let mut rows = 0;
        for (order, stream_id) in channel.streams.iter().enumerate() {
            let Some(stream) = streams.get(stream_id) else {
                continue;
            };
            let Some(url) = stream
                .url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
            else {
                continue;
            };
            let account = stream.m3u_account.and_then(|id| accounts.get(&id));
            let title = channel.display_name();

            m3u.push_str("#EXTINF:-1");
            let mut attr = |key: &str, value: &str| {
                m3u.push_str(&format!(" {}=\"{}\"", key, escape_extinf_value(value)));
            };
            attr("tvg-id", &channel.guide_id());
            if let Some(number) = channel.number() {
                attr("tvg-chno", &format_channel_number(number));
            }
            if let Some(logo_id) = channel.logo_id() {
                attr(
                    "tvg-logo",
                    &format!("{}/api/channels/logos/{}/cache/", base, logo_id),
                );
            }
            attr("group-title", group);
            attr(ATTR_CHANNEL_ID, &channel.id.to_string());
            attr(ATTR_STREAM_ID, &stream.id.to_string());
            attr(ATTR_STREAM_ORDER, &order.to_string());
            attr(ATTR_STREAM_COUNT, &count.to_string());
            attr(ATTR_STREAM_NAME, &stream.name);
            if let Some(uuid) = channel.uuid.as_deref() {
                attr(ATTR_CHANNEL_UUID, uuid);
            }
            attr(ATTR_CHANNEL_STREAMS, &channel_streams);
            match (account, stream.m3u_account) {
                (Some(account), _) => {
                    attr(ATTR_SERVER, &base);
                    attr(ATTR_ACCOUNT, &account.name);
                    attr(ATTR_ACCOUNT_ID, &account.id.to_string());
                    let limit = account.connection_limit();
                    if limit > 0 {
                        attr(ATTR_MAX_STREAMS, &limit.to_string());
                    }
                }
                // Account details did not load: assume the strictest limit
                // rather than scanning the provider without one.
                (None, Some(account_id)) => {
                    attr(ATTR_SERVER, &base);
                    attr(ATTR_ACCOUNT_ID, &account_id.to_string());
                    attr(ATTR_MAX_STREAMS, "1");
                }
                (None, None) if stream.is_custom => attr(ATTR_ACCOUNT, "Custom"),
                (None, None) => {}
            }
            m3u.push(',');
            m3u.push_str(&flatten_extinf_title(title));
            m3u.push('\n');
            m3u.push_str(&url.replace(['\r', '\n'], ""));
            m3u.push('\n');
            rows += 1;
        }
        // A channel with no playable stream still gets one row, so it shows
        // and Find streams can give it some. Its URL is the channel's own
        // Dispatcharr proxy link; scans never probe it.
        if rows == 0 {
            m3u.push_str("#EXTINF:-1");
            let mut attr = |key: &str, value: &str| {
                m3u.push_str(&format!(" {}=\"{}\"", key, escape_extinf_value(value)));
            };
            attr("tvg-id", &channel.guide_id());
            if let Some(number) = channel.number() {
                attr("tvg-chno", &format_channel_number(number));
            }
            if let Some(logo_id) = channel.logo_id() {
                attr(
                    "tvg-logo",
                    &format!("{}/api/channels/logos/{}/cache/", base, logo_id),
                );
            }
            attr("group-title", group);
            attr(ATTR_CHANNEL_ID, &channel.id.to_string());
            attr(ATTR_STREAM_ID, "0");
            attr(ATTR_STREAM_ORDER, "0");
            attr(ATTR_STREAM_COUNT, "0");
            if let Some(uuid) = channel.uuid.as_deref() {
                attr(ATTR_CHANNEL_UUID, uuid);
            }
            attr(ATTR_CHANNEL_STREAMS, &channel_streams);
            attr(ATTR_EMPTY, "1");
            m3u.push(',');
            m3u.push_str(&flatten_extinf_title(channel.display_name()));
            m3u.push('\n');
            let key = channel
                .uuid
                .clone()
                .unwrap_or_else(|| format!("channel-{}", channel.id));
            m3u.push_str(&format!("{}/proxy/ts/stream/{}\n", base, key));
        }
    }
    m3u
}

// ── Stats ───────────────────────────────────────────────────────────────────

/// Leading number of a "4500 kbps" style bitrate string.
fn parse_kbps(value: Option<&str>) -> Option<f64> {
    let number = value?
        .trim()
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .next()?;
    number.parse::<f64>().ok().filter(|kbps| *kbps > 0.0)
}

/// Probe stats in Dispatcharr's own `stream_stats` keys, so its UI renders
/// them. Unknown values are omitted rather than written as null.
pub(crate) fn stream_stats_from_result(result: &ChannelResult) -> Map<String, Value> {
    let mut stats = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            stats.insert(key.to_string(), value);
        }
    };
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Value::from(value.to_ascii_lowercase()))
    };
    put("video_codec", text(&result.codec));
    put("audio_codec", text(&result.audio_codec));
    put("audio_channels", text(&result.audio_channel_layout));
    if let (Some(width), Some(height)) = (result.width, result.height) {
        put(
            "resolution",
            Some(Value::from(format!("{}x{}", width, height))),
        );
        put("width", Some(Value::from(width)));
        put("height", Some(Value::from(height)));
    }
    put(
        "source_fps",
        result
            .fps
            .filter(|fps| *fps > 0)
            .map(|fps| Value::from(fps as f64)),
    );
    put(
        "video_bitrate",
        parse_kbps(result.video_bitrate.as_deref()).map(Value::from),
    );
    put(
        "audio_bitrate",
        parse_kbps(result.audio_bitrate.as_deref()).map(Value::from),
    );
    stats
}

/// Overlay new stats on the existing ones, as Dispatcharr's own proxy does,
/// so keys we don't measure (pixel format, sample rate) survive.
pub(crate) fn merge_stream_stats(
    existing: Option<&Value>,
    update: &Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in update {
        merged.insert(key.clone(), value.clone());
    }
    merged
}

/// True when every key we sent came back with the same value.
pub(crate) fn stats_stuck(stored: Option<&Value>, sent: &Map<String, Value>) -> bool {
    let Some(stored) = stored.and_then(Value::as_object) else {
        return sent.is_empty();
    };
    sent.iter()
        .all(|(key, value)| stored.get(key) == Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::channel::{ChannelStatus, ContentType};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Request {
        method: String,
        path: String,
        headers: String,
        body: String,
    }

    type Handler = Arc<dyn Fn(&Request) -> (u16, String) + Send + Sync>;

    /// Minimal HTTP/1.1 server that hands each request (method, path,
    /// headers, body) to `handler` and answers with a JSON body.
    async fn spawn_server(handler: Handler) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let (head_end, content_length) = loop {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..read]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                            let length = head
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:"))
                                .and_then(|value| value.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (pos + 4, length);
                        }
                    };
                    while buf.len() < head_end + content_length {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..read]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut first = head.lines().next().unwrap_or("").split_whitespace();
                    let request = Request {
                        method: first.next().unwrap_or("").to_string(),
                        path: first.next().unwrap_or("").to_string(),
                        headers: head.to_ascii_lowercase(),
                        body: String::from_utf8_lossy(&buf[head_end..]).to_string(),
                    };
                    let (status, body) = handler(&request);
                    let response = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{}", addr)
    }

    fn client(base: &str, auth: DispatcharrAuth) -> DispatcharrClient {
        DispatcharrClient::new(normalize_dispatcharr_server(base).unwrap(), auth, false).unwrap()
    }

    fn login() -> DispatcharrAuth {
        DispatcharrAuth::Login {
            username: "admin".to_string(),
            password: "secret".to_string(),
        }
    }

    #[test]
    fn normalize_strips_pasted_paths_but_keeps_prefix() {
        let cases = [
            ("http://dvr.example:9191", "http://dvr.example:9191/"),
            (
                "http://dvr.example:9191/proxy/ts/stream/abc",
                "http://dvr.example:9191/",
            ),
            (
                "https://example.com/dispatcharr/output/m3u?x=1",
                "https://example.com/dispatcharr",
            ),
            (
                "https://example.com/dispatcharr/api/channels/",
                "https://example.com/dispatcharr",
            ),
            (
                "https://example.com/dispatcharr/api",
                "https://example.com/dispatcharr",
            ),
            (
                "https://example.com/api/dispatcharr/proxy/ts/stream/abc",
                "https://example.com/api/dispatcharr",
            ),
            (
                "https://example.com/api/dispatcharr",
                "https://example.com/api/dispatcharr",
            ),
            (
                "https://example.com/dispatcharr/api/",
                "https://example.com/dispatcharr",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                normalize_dispatcharr_server(input).unwrap().as_str(),
                expected
            );
        }
        assert!(normalize_dispatcharr_server("http://u:p@dvr.example").is_err());
    }

    #[test]
    fn api_keys_on_one_server_are_separate_sources() {
        let base = Url::parse("http://dvr.example/").unwrap();
        let key = |k: &str| build_dispatcharr_source_key(&base, &DispatcharrAuth::ApiKey(k.into()));
        assert_eq!(key("one"), key("one"));
        assert_ne!(key("one"), key("two"));
        assert!(!key("one").contains("one"));
    }

    #[test]
    fn auth_prefers_api_key_and_requires_credentials() {
        assert_eq!(
            DispatcharrAuth::from_parts(Some("a"), Some("b"), Some(" key ")).unwrap(),
            DispatcharrAuth::ApiKey("key".to_string())
        );
        assert!(DispatcharrAuth::from_parts(Some("a"), None, Some("  ")).is_err());
    }

    #[tokio::test]
    async fn api_key_is_sent_and_pagination_rewrites_internal_host() {
        let base = spawn_server(Arc::new(|req: &Request| {
            assert!(req.headers.contains("authorization: apikey k1"));
            if req.path == "/api/channels/channels/?page=2" {
                (200, r#"{"count":2,"next":null,"results":[{"id":2,"name":"B"}]}"#.into())
            } else {
                assert_eq!(req.path, "/api/channels/channels/");
                // Django behind a reverse proxy advertises its internal host.
                (
                    200,
                    r#"{"count":2,"next":"http://internal:8000/api/channels/channels/?page=2","results":[{"id":1,"name":"A"}]}"#.into(),
                )
            }
        }))
        .await;
        let channels = client(&base, DispatcharrAuth::ApiKey("k1".into()))
            .fetch_channels()
            .await
            .unwrap();
        assert_eq!(
            channels.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[tokio::test]
    async fn bulk_stream_lookup_follows_pages() {
        let base = spawn_server(Arc::new(|req: &Request| {
            assert_eq!(req.method, "POST");
            assert!(req.body.contains("\"ids\":[1,2]"));
            if req.path.ends_with("?page=2") {
                (200, r#"{"next":null,"results":[{"id":2}]}"#.into())
            } else {
                (
                    200,
                    r#"{"next":"http://internal/api/channels/streams/by-ids/?page=2","results":[{"id":1}]}"#
                        .into(),
                )
            }
        }))
        .await;
        let streams = client(&base, DispatcharrAuth::ApiKey("k".into()))
            .fetch_streams_by_ids(&[1, 2])
            .await
            .unwrap();
        assert_eq!(streams.iter().map(|s| s.id).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn a_channel_without_playable_streams_keeps_one_placeholder_row() {
        let channels = [DispatcharrChannel {
            id: 30,
            uuid: Some("uuid-30".into()),
            name: "Empty One".into(),
            channel_number: Some(3.0),
            streams: vec![],
            ..Default::default()
        }];
        let base = Url::parse("http://dvr.example:9191/").unwrap();
        let m3u = build_m3u(
            &base,
            &channels,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );
        let preview =
            crate::engine::parser::parse_m3u(m3u.as_bytes(), "fixture.m3u8", &None, &None).unwrap();
        assert_eq!(preview.channels.len(), 1);
        let row = &preview.channels[0];
        assert_eq!(row.name, "Empty One");
        assert!(is_empty_channel_row(&row.extinf_line));
        assert_eq!(
            dispatcharr_ids_from_extinf(&row.extinf_line)
                .unwrap()
                .channel_id,
            30
        );
        assert_eq!(row.url, "http://dvr.example:9191/proxy/ts/stream/uuid-30");
    }

    #[test]
    fn names_reduce_to_the_channel_they_carry() {
        assert_eq!(normalize_stream_name("US| KIDS ZONE HD"), "kids zone");
        assert_eq!(
            normalize_stream_name("EN - Kids Zone (backup)"),
            "kids zone"
        );
        assert_eq!(
            normalize_stream_name("UK: Kids Zone +1 [720p]"),
            "kids zone +1"
        );
        // A long first word before a colon is part of the name.
        assert_eq!(
            normalize_stream_name("Channel: The Series"),
            "channel the series"
        );
        assert_eq!(name_similarity("kids zone", "kids zone"), 100);
        assert!(name_similarity("kids zone", "kids zone +1") > 80);
        assert!(name_similarity("kids zone", "news one") < CANDIDATE_MIN_SIMILARITY);
    }

    #[tokio::test]
    async fn candidates_skip_linked_streams_and_rank_epg_matches_first() {
        let base = spawn_server(Arc::new(|req: &Request| {
            if req.path == "/api/channels/streams/by-ids/" {
                return (200, r#"[{"id":2,"name":"US| Kids Zone"}]"#.into());
            }
            assert!(req.path.starts_with("/api/channels/streams/?hide_stale=true"));
            if req.path.contains("tvg_id=kidszone.us") {
                (200, r#"{"next":null,"results":[{"id":4,"name":"KZ East","tvg_id":"KidsZone.us","url":"http://p/4"}]}"#.into())
            } else {
                assert!(req.path.contains("search=kids+zone"));
                (
                    200,
                    r#"{"next":null,"results":[
                        {"id":7,"name":"CH: Kids Zone","url":"http://p/7"},
                        {"id":1,"name":"US| KIDS ZONE HD","url":"http://p/1"},
                        {"id":2,"name":"Kids Zone","url":"http://p/2"},
                        {"id":3,"name":"Kids Zone Plus","url":"http://p/3"},
                        {"id":5,"name":"Zone Radio","url":"http://p/5"},
                        {"id":6,"name":"Kids Zone","url":""}
                    ]}"#
                    .into(),
                )
            }
        }))
        .await;
        let channel = DispatcharrChannel {
            id: 9,
            name: "Kids Zone".into(),
            tvg_id: Some("kidszone.us".into()),
            streams: vec![2],
            ..Default::default()
        };
        let found = client(&base, DispatcharrAuth::ApiKey("k".into()))
            .find_candidate_streams(&channel, None)
            .await
            .unwrap();
        let ranked = found
            .iter()
            .map(|(stream, matched)| (stream.id, matched.epg, matched.other_country.as_deref()))
            .collect::<Vec<_>>();
        // EPG match first; the same name from another country (7) after this
        // country's; linked (2), URL-less (6) and unlike (5) left out.
        assert_eq!(
            ranked,
            vec![
                (4, true, None),
                (1, false, None),
                (7, false, Some("CH")),
                (3, false, None)
            ]
        );
    }

    #[test]
    fn account_limit_adds_up_active_profiles() {
        let profile = |id, max_streams, is_active| DispatcharrM3uProfile {
            id,
            max_streams,
            is_active,
        };
        let account = |profiles| DispatcharrM3uAccount {
            max_streams: 1,
            profiles,
            ..Default::default()
        };
        assert_eq!(account(vec![]).connection_limit(), 1);
        assert_eq!(
            account(vec![
                profile(1, 1, true),
                profile(2, 2, true),
                profile(3, 5, false)
            ])
            .connection_limit(),
            3
        );
        // One unlimited active profile makes the account unlimited.
        assert_eq!(
            account(vec![profile(1, 1, true), profile(2, 0, true)]).connection_limit(),
            0
        );
    }

    #[tokio::test]
    async fn viewers_are_counted_per_account_through_profiles() {
        let base = spawn_server(Arc::new(|req: &Request| match req.path.as_str() {
            "/api/m3u/accounts/" => (
                200,
                r#"[{"id":7,"profiles":[{"id":70},{"id":71}]},{"id":8,"profiles":[{"id":80}]}]"#
                    .into(),
            ),
            "/proxy/ts/status" => (
                200,
                r#"{"count":3,"channels":[{"m3u_profile_id":70},{"m3u_profile_id":71},{"channel_id":"x"}]}"#
                    .into(),
            ),
            _ => (404, "{}".into()),
        }))
        .await;
        let viewers = client(&base, DispatcharrAuth::ApiKey("k".into()))
            .fetch_account_viewers()
            .await
            .unwrap();
        assert_eq!(viewers, HashMap::from([(7, 2)]));
    }

    #[tokio::test]
    async fn a_deleted_channel_reads_as_none() {
        let base = spawn_server(Arc::new(|req: &Request| match req.path.as_str() {
            "/api/channels/channels/5/" => (200, r#"{"id":5,"streams":[2,1]}"#.into()),
            _ => (404, r#"{"detail":"Not found."}"#.into()),
        }))
        .await;
        let client = client(&base, DispatcharrAuth::ApiKey("k".into()));
        assert_eq!(
            client.fetch_channel(5).await.unwrap().unwrap().streams,
            vec![2, 1]
        );
        assert!(client.fetch_channel(6).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn bare_array_lists_parse() {
        let base = spawn_server(Arc::new(|_: &Request| {
            (200, r#"[{"id":7,"name":"Group"}]"#.into())
        }))
        .await;
        let groups = client(&base, DispatcharrAuth::ApiKey("k".into()))
            .fetch_groups()
            .await
            .unwrap();
        assert_eq!(groups[0].name, "Group");
    }

    #[tokio::test]
    async fn jwt_logs_in_once_and_relogs_after_401() {
        let logins = Arc::new(AtomicUsize::new(0));
        let rejected = Arc::new(AtomicUsize::new(0));
        let (l, r) = (Arc::clone(&logins), Arc::clone(&rejected));
        let base = spawn_server(Arc::new(move |req: &Request| {
            if req.path == "/api/accounts/token/" {
                assert_eq!(req.method, "POST");
                assert!(req.body.contains(r#""username":"admin""#));
                let n = l.fetch_add(1, Ordering::SeqCst) + 1;
                return (200, format!(r#"{{"access":"t{}","refresh":"r{}"}}"#, n, n));
            }
            // The first token is revoked server-side after one request.
            if req.headers.contains("authorization: bearer t1")
                && r.fetch_add(1, Ordering::SeqCst) >= 1
            {
                return (401, r#"{"detail":"expired"}"#.into());
            }
            (200, "[]".into())
        }))
        .await;
        let client = client(&base, login());
        client.fetch_groups().await.unwrap();
        client.fetch_groups().await.unwrap();
        assert_eq!(logins.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn bad_login_reports_credentials() {
        let base = spawn_server(Arc::new(|_: &Request| {
            (401, r#"{"detail":"No active account"}"#.into())
        }))
        .await;
        let error = client(&base, login()).fetch_groups().await.unwrap_err();
        assert!(error.to_string().contains("username or password"));
    }

    #[tokio::test]
    async fn write_payloads_have_expected_shapes() {
        let bodies = Arc::new(Mutex::new(Vec::<(String, String, String)>::new()));
        let seen = Arc::clone(&bodies);
        let base = spawn_server(Arc::new(move |req: &Request| {
            seen.lock()
                .unwrap()
                .push((req.method.clone(), req.path.clone(), req.body.clone()));
            match req.path.as_str() {
                "/api/channels/channels/5/" => (200, r#"{"id":5,"streams":[3,1]}"#.into()),
                "/api/channels/streams/3/" => {
                    let body: Value = serde_json::from_str(&req.body).unwrap();
                    (
                        200,
                        json!({"id":3,"stream_stats": body["stream_stats"]}).to_string(),
                    )
                }
                _ => (204, String::new()),
            }
        }))
        .await;
        let client = client(&base, DispatcharrAuth::ApiKey("k".into()));
        assert_eq!(
            client.set_channel_streams(5, &[3, 1]).await.unwrap(),
            vec![3, 1]
        );
        let mut stats = Map::new();
        stats.insert("video_codec".into(), json!("h264"));
        let stored = client
            .patch_stream_stats(3, &stats, "2026-09-29T10:00:00Z")
            .await
            .unwrap();
        assert!(stats_stuck(stored.as_ref(), &stats));

        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies[0].0, "PATCH");
        assert_eq!(
            serde_json::from_str::<Value>(&bodies[0].2).unwrap(),
            json!({"streams":[3,1]})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&bodies[1].2).unwrap(),
            json!({"stream_stats":{"video_codec":"h264"},"stream_stats_updated_at":"2026-09-29T10:00:00Z"})
        );
    }

    #[tokio::test]
    async fn stats_writes_merge_onto_a_fresh_read() {
        let patched = Arc::new(Mutex::new(String::new()));
        let seen = Arc::clone(&patched);
        let base = spawn_server(Arc::new(move |req: &Request| {
            if req.method == "GET" {
                return (
                    200,
                    r#"{"id":3,"stream_stats":{"pixel_format":"yuv420p","video_codec":"mpeg2"}}"#
                        .into(),
                );
            }
            *seen.lock().unwrap() = req.body.clone();
            let body: Value = serde_json::from_str(&req.body).unwrap();
            (
                200,
                json!({"id":3,"stream_stats": body["stream_stats"]}).to_string(),
            )
        }))
        .await;
        let mut update = Map::new();
        update.insert("video_codec".into(), json!("h264"));
        client(&base, DispatcharrAuth::ApiKey("k".into()))
            .write_stream_stats(3, &update, "2026-09-29T10:00:00Z")
            .await
            .unwrap();
        let sent: Value = serde_json::from_str(&patched.lock().unwrap()).unwrap();
        assert_eq!(
            sent["stream_stats"],
            json!({"pixel_format":"yuv420p","video_codec":"h264"})
        );
    }

    fn fixture_channels() -> (Vec<DispatcharrChannel>, HashMap<i64, DispatcharrStream>) {
        let channels = vec![
            DispatcharrChannel {
                id: 20,
                uuid: Some("uuid-20".into()),
                name: "Sports \"2\"".into(),
                channel_number: Some(2.0),
                channel_group_id: Some(1),
                logo_id: Some(4),
                streams: vec![102, 101, 999],
                ..Default::default()
            },
            DispatcharrChannel {
                id: 10,
                name: "News One".into(),
                channel_number: Some(1.5),
                streams: vec![101],
                ..Default::default()
            },
        ];
        let stream = |id: i64, name: &str, account: Option<i64>| DispatcharrStream {
            id,
            name: name.into(),
            url: Some(format!("http://provider.example/live/{}.ts", id)),
            m3u_account: account,
            ..Default::default()
        };
        let streams = [stream(101, "Feed A", Some(7)), stream(102, "Feed B", None)]
            .into_iter()
            .map(|s| (s.id, s))
            .collect();
        (channels, streams)
    }

    #[test]
    fn build_m3u_round_trips_ids_through_the_parser() {
        let (channels, streams) = fixture_channels();
        let groups = HashMap::from([(1, "Sports".to_string())]);
        let accounts = HashMap::from([(
            7,
            DispatcharrM3uAccount {
                id: 7,
                name: "Provider A".to_string(),
                max_streams: 2,
                ..Default::default()
            },
        )]);
        let base = Url::parse("http://dvr.example:9191/").unwrap();
        let m3u = build_m3u(&base, &channels, &streams, &groups, &accounts);
        assert!(m3u.starts_with("#EXTM3U x-tvg-url=\"http://dvr.example:9191/output/epg\""));

        let dir = std::env::temp_dir().join(format!("dispatcharr-m3u-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.m3u");
        std::fs::write(&path, &m3u).unwrap();
        let preview =
            crate::engine::parser::parse_playlist(path.to_str().unwrap(), &None, &None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        // Channel-number order, failover order within a channel, missing
        // stream 999 skipped.
        let refs = preview
            .channels
            .iter()
            .map(|c| dispatcharr_ids_from_extinf(&c.extinf_line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            refs.iter()
                .map(|r| (r.channel_id, r.stream_id, r.stream_order, r.stream_count))
                .collect::<Vec<_>>(),
            vec![(10, 101, 0, 1), (20, 102, 0, 3), (20, 101, 1, 3)]
        );
        assert_eq!(refs[1].channel_uuid.as_deref(), Some("uuid-20"));

        let single = &preview.channels[0];
        assert_eq!(single.name, "News One");
        assert_eq!(single.tvg_chno.as_deref(), Some("1.5"));
        // Matches the channel IDs in Dispatcharr's EPG output.
        assert_eq!(single.tvg_id.as_deref(), Some("1.5"));

        let multi = &preview.channels[1];
        assert_eq!(multi.name, "Sports \"2\"");
        assert!(multi
            .extinf_line
            .contains("x-dispatcharr-stream-name=\"Feed B\""));
        assert_eq!(multi.group, "Sports");
        assert_eq!(multi.tvg_chno.as_deref(), Some("2"));
        assert_eq!(multi.tvg_id.as_deref(), Some("2"));
        assert_eq!(
            multi.tvg_logo.as_deref(),
            Some("http://dvr.example:9191/api/channels/logos/4/cache/")
        );
        assert!(preview.channels[2]
            .extinf_line
            .contains("x-dispatcharr-account=\"Provider A\""));
        assert_eq!(
            dispatcharr_connection_limit(&preview.channels[2].extinf_line),
            Some((7, 2))
        );
        // Stream 102 has no M3U account, so no provider limit.
        assert_eq!(dispatcharr_connection_limit(&multi.extinf_line), None);
        assert!(multi
            .extinf_line
            .contains("x-dispatcharr-channel-streams=\"102,101,999\""));
    }

    #[test]
    fn unknown_accounts_get_the_strictest_limit() {
        let (channels, streams) = fixture_channels();
        let base = Url::parse("http://dvr.example:9191/").unwrap();
        let m3u = build_m3u(&base, &channels, &streams, &HashMap::new(), &HashMap::new());
        let feed_a = m3u
            .lines()
            .find(|line| line.contains("x-dispatcharr-stream-id=\"101\""))
            .unwrap();
        assert_eq!(dispatcharr_connection_limit(feed_a), Some((7, 1)));
    }

    #[test]
    fn dispatcharr_rows_are_live_whatever_the_url() {
        let playlist = "#EXTM3U\n#EXTINF:-1 x-dispatcharr-channel-id=\"1\" x-dispatcharr-stream-id=\"2\",Movies 24/7\nhttp://provider.example/movie/1.mp4\n";
        let preview =
            crate::engine::parser::parse_m3u(playlist.as_bytes(), "fixture.m3u8", &None, &None)
                .unwrap();
        assert_eq!(preview.channels[0].content_type, ContentType::Live);
        assert_eq!(preview.live_count, 1);
    }

    #[test]
    fn account_slots_are_shared_per_server_and_account() {
        let row = |server: &str| {
            format!(
                "#EXTINF:-1 x-dispatcharr-server=\"{server}\" x-dispatcharr-account-id=\"9901\",N"
            )
        };
        let first = account_connection_slots(&row("http://dvr-a.example"), 9901, 1);
        // Same account on another stream host, or with a changed limit:
        // still one pool, resized.
        let resized = account_connection_slots(&row("http://dvr-a.example"), 9901, 2);
        assert!(Arc::ptr_eq(&first, &resized));
        assert_eq!(resized.available_permits(), 2);
        let other_server = account_connection_slots(&row("http://dvr-b.example"), 9901, 1);
        assert!(!Arc::ptr_eq(&first, &other_server));
    }

    #[tokio::test]
    async fn shrinking_account_slots_retires_permits_in_use() {
        let row = "#EXTINF:-1 x-dispatcharr-server=\"http://dvr-c.example\",N";
        let pool = account_connection_slots(row, 9902, 3);
        let held = Arc::clone(&pool).acquire_many_owned(3).await.unwrap();
        account_connection_slots(row, 9902, 1);
        drop(held);
        for _ in 0..100 {
            if pool.available_permits() == 1 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("pool kept {} permits", pool.available_permits());
    }

    #[test]
    fn extinf_without_ids_is_not_dispatcharr() {
        assert_eq!(
            dispatcharr_ids_from_extinf("#EXTINF:-1 tvg-id=\"a\",Name"),
            None
        );
    }

    fn result_fixture() -> ChannelResult {
        let mut result: ChannelResult = serde_json::from_value(json!({
            "index": 0, "playlist": "p", "name": "n", "group": "g", "url": "http://x/1.ts",
            "status": "alive", "codec": null, "resolution": null, "width": null, "height": null,
            "fps": null, "latency_ms": null, "video_bitrate": null, "audio_bitrate": null,
            "audio_codec": null, "screenshot_path": null, "label_mismatches": [],
            "low_framerate": false, "error_message": null, "channel_id": "1",
            "extinf_line": "#EXTINF:-1,n", "metadata_lines": [], "stream_url": null
        }))
        .unwrap();
        result.content_type = ContentType::Live;
        result.status = ChannelStatus::Alive;
        result
    }

    #[test]
    fn stats_use_dispatcharr_keys_and_omit_unknowns() {
        let mut result = result_fixture();
        result.codec = Some("H264".into());
        result.width = Some(1920);
        result.height = Some(1080);
        result.fps = Some(50);
        result.video_bitrate = Some("4500 kbps".into());
        result.audio_bitrate = Some("128.5 kbps".into());
        result.audio_codec = Some("aac".into());
        result.audio_channel_layout = Some("stereo".into());
        assert_eq!(
            Value::Object(stream_stats_from_result(&result)),
            json!({
                "video_codec": "h264", "resolution": "1920x1080", "width": 1920,
                "height": 1080, "source_fps": 50.0, "video_bitrate": 4500.0,
                "audio_bitrate": 128.5, "audio_codec": "aac", "audio_channels": "stereo"
            })
        );
        assert!(stream_stats_from_result(&result_fixture()).is_empty());
    }

    #[test]
    fn merge_keeps_unmeasured_keys() {
        let mut update = Map::new();
        update.insert("video_codec".into(), json!("hevc"));
        let merged = merge_stream_stats(
            Some(&json!({"video_codec": "h264", "pixel_format": "yuv420p"})),
            &update,
        );
        assert_eq!(
            Value::Object(merged),
            json!({"video_codec": "hevc", "pixel_format": "yuv420p"})
        );
    }
}
