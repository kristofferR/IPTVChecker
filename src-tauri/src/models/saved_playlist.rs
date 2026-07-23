use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedPlaylistKind {
    File,
    Url,
    Xtream,
}

/// Saved playlist sources, persisted in settings.json in the app data dir.
///
/// Deliberate trade-off: Xtream credentials are stored in plaintext rather
/// than the OS keychain. IPTV portal credentials are low-sensitivity (shared
/// provider logins already embedded in M3U URLs), and keychain prompts on
/// every launch would hurt more than they protect. Revisit if the app ever
/// stores credentials that unlock anything beyond the playlists themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SavedPlaylistSource {
    File {
        path: String,
    },
    Url {
        url: String,
    },
    Xtream {
        servers: Vec<String>,
        preferred_server: Option<String>,
        username: String,
        #[serde(default)]
        password: Option<String>,
    },
}

impl SavedPlaylistSource {
    pub fn kind(&self) -> SavedPlaylistKind {
        match self {
            Self::File { .. } => SavedPlaylistKind::File,
            Self::Url { .. } => SavedPlaylistKind::Url,
            Self::Xtream { .. } => SavedPlaylistKind::Xtream,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPlaylistEntry {
    pub id: String,
    pub display_name: String,
    #[serde(flatten)]
    pub source: SavedPlaylistSource,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SavedPlaylistDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub display_name: String,
    #[serde(flatten)]
    pub source: SavedPlaylistSource,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedPlaylistUpsertResult {
    pub entry: SavedPlaylistEntry,
    pub entries: Vec<SavedPlaylistEntry>,
}
