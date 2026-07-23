//! Canonical URL-identity helpers.
//!
//! Scan dedup keys, history identity keys, saved-playlist source keys, and
//! shared-URL result caching all rely on the same canonical form: fragment
//! stripped, default http/https ports dropped. Keep the logic here so those
//! keys can never drift apart.

use url::Url;

/// Canonical identity string for an already-parsed URL: drops the fragment
/// and the scheme's default port.
pub fn normalize_url_identity(url: &Url) -> String {
    let mut normalized = url.clone();
    normalized.set_fragment(None);
    if (normalized.scheme() == "http" && normalized.port() == Some(80))
        || (normalized.scheme() == "https" && normalized.port() == Some(443))
    {
        let _ = normalized.set_port(None);
    }
    normalized.to_string()
}

/// Canonical identity for a raw stream URL string. Unparseable input falls
/// back to the trimmed original so it still forms a stable (if opaque) key.
pub fn canonicalize_stream_url(url: &str) -> String {
    let trimmed = url.trim();
    let Ok(parsed) = Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    normalize_url_identity(&parsed)
}

/// Like [`canonicalize_stream_url`] but only accepts http/https URLs,
/// returning `None` for anything else (used for history identity keys).
pub fn normalize_http_url_identity(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(normalize_url_identity(&parsed))
}
