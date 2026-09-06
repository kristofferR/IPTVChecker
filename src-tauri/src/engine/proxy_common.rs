//! Helpers shared by the playback stream proxy, the cast proxy, and the
//! checker for talking to untrusted upstream media servers.

use url::Url;

/// Generous ceiling for JSON API responses (Xtream catalogs, Stalker portal
/// replies). Large providers ship tens of MB of listing JSON; nothing
/// legitimate approaches this, but a hostile or broken server must not be
/// able to buffer unbounded data.
pub const MAX_JSON_API_BYTES: u64 = 64 * 1024 * 1024;

/// Whether a response is an HLS manifest, by content type or .m3u8 path.
pub fn is_m3u8_response(content_type: &str, url: &str) -> bool {
    let ct = content_type.to_lowercase();
    // Panels also serve playlists as audio/x-mpegurl, audio/mpegurl, or
    // video/x-mpegurl; anything mpegurl-flavoured is a manifest.
    if ct.contains("mpegurl") {
        return true;
    }
    if let Ok(parsed) = Url::parse(url) {
        if parsed.path().to_lowercase().ends_with(".m3u8") {
            return true;
        }
    }
    false
}

/// Rewrite URIs in an HLS manifest so they route back through a proxy.
///
/// Handles bare URI lines (segment and playlist references) and URI="..."
/// attributes in #EXT-X-MAP, #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-SESSION-KEY.
/// `map_uri` receives each URI resolved against the manifest base and returns
/// the replacement, or `None` to leave the reference unrewritten (e.g. an
/// out-of-origin target the caller refuses to proxy).
pub fn rewrite_hls_manifest(
    body: &str,
    base_url: &str,
    map_uri: &dyn Fn(&Url) -> Option<String>,
) -> String {
    let base = match Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return body.to_string(),
    };

    let mut output = String::with_capacity(body.len());
    for line in body.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            output.push('\n');
            continue;
        }

        if trimmed.starts_with('#') {
            let upper = trimmed.to_ascii_uppercase();
            if (upper.starts_with("#EXT-X-MAP:")
                || upper.starts_with("#EXT-X-KEY:")
                || upper.starts_with("#EXT-X-MEDIA:")
                || upper.starts_with("#EXT-X-SESSION-KEY:"))
                && trimmed.contains("URI=")
            {
                output.push_str(&rewrite_tag_uri(trimmed, &base, map_uri));
            } else {
                output.push_str(line);
            }
            output.push('\n');
            continue;
        }

        // Non-comment, non-empty line: a URI reference
        match base.join(trimmed).ok().and_then(|u| map_uri(&u)) {
            Some(replacement) => output.push_str(&replacement),
            None => output.push_str(line),
        }
        output.push('\n');
    }

    output
}

/// Rewrite the URI="..." value inside an HLS tag line.
fn rewrite_tag_uri(line: &str, base: &Url, map_uri: &dyn Fn(&Url) -> Option<String>) -> String {
    let upper = line.to_ascii_uppercase();
    let Some(uri_pos) = upper.find("URI=") else {
        return line.to_string();
    };

    let after_uri_eq = &line[uri_pos + 4..];

    let (quote, uri_start, uri_end) = if let Some(inner) = after_uri_eq.strip_prefix('"') {
        let end = inner.find('"').unwrap_or(inner.len());
        (Some('"'), 1, 1 + end)
    } else if let Some(inner) = after_uri_eq.strip_prefix('\'') {
        let end = inner.find('\'').unwrap_or(inner.len());
        (Some('\''), 1, 1 + end)
    } else {
        let end = after_uri_eq
            .find(|c: char| c == ',' || c.is_whitespace())
            .unwrap_or(after_uri_eq.len());
        (None, 0, end)
    };

    let original_uri = &after_uri_eq[uri_start..uri_end];
    let Some(new_uri) = base.join(original_uri).ok().and_then(|u| map_uri(&u)) else {
        return line.to_string();
    };

    let mut result = String::with_capacity(line.len() + new_uri.len());
    result.push_str(&line[..uri_pos + 4]);
    if let Some(q) = quote {
        result.push(q);
        result.push_str(&new_uri);
        result.push(q);
    } else {
        result.push_str(&new_uri);
    }
    let remainder_offset = uri_pos + 4 + uri_end + if quote.is_some() { 1 } else { 0 };
    if remainder_offset < line.len() {
        result.push_str(&line[remainder_offset..]);
    }
    result
}

/// Read an HTTP request head from a raw socket until the `\r\n\r\n`
/// terminator, bounded at `max_bytes`. A single `read()` is not enough: the
/// request line and headers can arrive split across TCP segments (seen with
/// some Cast receivers sending Range headers), which would silently drop
/// headers or fail parsing. Returns `None` if the connection closed before
/// any data arrived; otherwise returns what was read (callers parse it and
/// reject if incomplete).
pub async fn read_http_request_head(
    socket: &mut tokio::net::TcpStream,
    max_bytes: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    use tokio::io::AsyncReadExt;

    // Absolute deadline for the whole header read: a peer trickling one byte
    // at a time (or going silent mid-header) must not pin the task forever.
    const REQUEST_HEAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

    let read_head = async {
        let mut buf = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        loop {
            let n = socket.read(&mut chunk).await?;
            if n == 0 {
                return Ok(if buf.is_empty() { None } else { Some(buf) });
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() >= max_bytes {
                return Ok(Some(buf));
            }
        }
    };

    match tokio::time::timeout(REQUEST_HEAD_DEADLINE, read_head).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out reading HTTP request head",
        )),
    }
}

#[derive(Debug)]
pub enum ReadCappedError {
    TooLarge,
    Read(reqwest::Error),
}

/// Streams a reqwest response body into memory with a hard byte cap. Returns
/// `TooLarge` as soon as accumulated bytes exceed `cap` so a malicious or
/// misclassified upstream (chunked / no Content-Length / declared smaller than
/// actual) can't OOM the process.
pub async fn read_capped(
    response: reqwest::Response,
    cap: u64,
) -> Result<Vec<u8>, ReadCappedError> {
    use futures::StreamExt;

    let mut buf: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ReadCappedError::Read)?;
        total = total.saturating_add(chunk.len() as u64);
        if total > cap {
            return Err(ReadCappedError::TooLarge);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}
