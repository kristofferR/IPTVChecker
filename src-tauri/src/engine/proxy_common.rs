//! Helpers shared by the playback stream proxy, the cast proxy, and the
//! checker for talking to untrusted upstream media servers.

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
