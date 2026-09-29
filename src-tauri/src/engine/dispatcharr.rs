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
pub(crate) const ATTR_ACCOUNT_ID: &str = "x-dispatcharr-account-id";
pub(crate) const ATTR_MAX_STREAMS: &str = "x-dispatcharr-max-streams";

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

    fn identity_label(&self) -> String {
        match self {
            Self::ApiKey(_) => "api-key".to_string(),
            Self::Login { username, .. } => username.clone(),
        }
    }
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
    let lower = path.to_ascii_lowercase();
    let prefix_end = ["/proxy/", "/output/", "/api/"]
        .iter()
        .filter_map(|marker| lower.find(marker))
        .min()
        .unwrap_or(path.len());
    let prefix = path[..prefix_end].trim_end_matches('/');
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
    format!(
        "dispatcharr:{}|{}",
        base_string(base),
        auth.identity_label()
    )
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

    fn tvg_id(&self) -> Option<&str> {
        self.effective_tvg_id
            .as_deref()
            .or(self.tvg_id.as_deref())
            .filter(|value| !value.is_empty())
    }

    fn logo_id(&self) -> Option<i64> {
        self.effective_logo_id.or(self.logo_id)
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct DispatcharrStream {
    pub id: i64,
    pub name: String,
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
                return Ok(response);
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

    pub(crate) async fn fetch_streams_by_ids(
        &self,
        ids: &[i64],
    ) -> Result<Vec<DispatcharrStream>, AppError> {
        let mut streams = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(STREAMS_BY_IDS_CHUNK) {
            let page: ListPage<DispatcharrStream> = self
                .json(
                    Method::POST,
                    "/api/channels/streams/by-ids/",
                    Some(&json!({ "ids": chunk })),
                )
                .await?;
            streams.extend(match page {
                ListPage::Bare(items) | ListPage::Paginated { results: items, .. } => items,
            });
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
        let group = channel
            .group_id()
            .and_then(|id| groups.get(&id))
            .map(String::as_str)
            .unwrap_or("");
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
            let title = if count > 1 {
                format!(
                    "{} [{}/{}] {}",
                    channel.display_name(),
                    order + 1,
                    count,
                    stream.name
                )
            } else {
                channel.display_name().to_string()
            };

            m3u.push_str("#EXTINF:-1");
            let mut attr = |key: &str, value: &str| {
                m3u.push_str(&format!(" {}=\"{}\"", key, escape_extinf_value(value)));
            };
            if let Some(tvg_id) = channel.tvg_id() {
                attr("tvg-id", tvg_id);
            }
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
            if let Some(uuid) = channel.uuid.as_deref() {
                attr(ATTR_CHANNEL_UUID, uuid);
            }
            match account {
                Some(account) => {
                    attr(ATTR_ACCOUNT, &account.name);
                    attr(ATTR_ACCOUNT_ID, &account.id.to_string());
                    if account.max_streams > 0 {
                        attr(ATTR_MAX_STREAMS, &account.max_streams.to_string());
                    }
                }
                None if stream.is_custom => attr(ATTR_ACCOUNT, "Custom"),
                None => {}
            }
            m3u.push(',');
            m3u.push_str(&flatten_extinf_title(&title));
            m3u.push('\n');
            m3u.push_str(&url.replace(['\r', '\n'], ""));
            m3u.push('\n');
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
                tvg_id: Some("news.one".into()),
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
        assert_eq!(single.tvg_id.as_deref(), Some("news.one"));

        let multi = &preview.channels[1];
        assert_eq!(multi.name, "Sports \"2\" [1/3] Feed B");
        assert_eq!(multi.group, "Sports");
        assert_eq!(multi.tvg_chno.as_deref(), Some("2"));
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
        assert_eq!(dispatcharr_connection_limit(&multi.extinf_line), None);
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
