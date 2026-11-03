use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::channel::Channel;

/// Whether an Xtream account can still be used, as judged when its account
/// info was fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum XtreamAccountState {
    /// Nothing in the account info points to a problem.
    #[default]
    Ok,
    /// Still active, but the subscription ends within a week.
    ExpiringSoon,
    /// The panel reports the subscription as expired, or its end date passed.
    Expired,
    /// The panel reports the account as banned or disabled.
    Disabled,
    /// The panel rejected the username and password (`auth: 0`).
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamAccountInfo {
    #[serde(default)]
    pub state: XtreamAccountState,
    /// `user_info.auth`; panels answer `false` for unknown or deleted logins.
    #[serde(default)]
    pub auth: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub expires_at_epoch: Option<u64>,
    #[serde(default)]
    pub created_at_epoch: Option<u64>,
    #[serde(default)]
    pub is_trial: Option<bool>,
    #[serde(default)]
    pub active_connections: Option<u32>,
    #[serde(default)]
    pub max_connections: Option<u32>,
    /// Panel timezone from `server_info`; Xtream timeshift starts are
    /// interpreted in this zone, not UTC.
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistPreview {
    pub file_path: String,
    pub file_name: String,
    pub source_identity: Option<String>,
    #[serde(default)]
    pub saved_playlist_id: Option<String>,
    #[serde(default)]
    pub server_location: Option<String>,
    #[serde(default)]
    pub single_provider: bool,
    #[serde(default)]
    pub xtream_max_connections: Option<u32>,
    #[serde(default)]
    pub xtream_account_info: Option<XtreamAccountInfo>,
    /// Server and account a Dispatcharr source was loaded from. Write-back
    /// targets exactly this connection, even for saved sources.
    #[serde(default)]
    pub dispatcharr_connection: Option<String>,
    /// A Dispatcharr source with provider accounts that cap concurrent
    /// streams. Playback then shares those slots with a running scan.
    #[serde(default)]
    pub dispatcharr_limited_accounts: bool,
    pub total_channels: usize,
    #[serde(default)]
    pub live_count: usize,
    #[serde(default)]
    pub movie_count: usize,
    #[serde(default)]
    pub series_count: usize,
    pub groups: Vec<String>,
    /// XMLTV EPG URLs advertised by the playlist header (`x-tvg-url` / `url-tvg`).
    #[serde(default)]
    pub epg_sources: Vec<String>,
    /// XMLTV EPG sources keyed by the playlist each channel came from.
    #[serde(default)]
    pub epg_sources_by_playlist: BTreeMap<String, Vec<String>>,
    pub channels: Vec<Channel>,
}
