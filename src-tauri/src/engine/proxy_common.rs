//! Helpers shared by the playback stream proxy, the cast proxy, and the
//! checker for talking to untrusted upstream media servers.

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
