//! XMLTV EPG store: streamed download with a disk cache, gzip-aware parsing,
//! and an in-memory programme index filtered to the playlist's tvg-ids so a
//! multi-hundred-MB provider guide does not balloon into memory.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::engine::remote_cache::PLAYLIST_DOWNLOAD_USER_AGENT;
use crate::error::AppError;

const EPG_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const EPG_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const EPG_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// Hard cap on a single downloaded guide; anything larger is a broken feed.
const EPG_MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
/// Prevent compressed XMLTV feeds from expanding without bound while parsing.
const EPG_MAX_DECOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
/// Missing XMLTV stop times use the following programme, or this fallback.
const EPG_MISSING_STOP_FALLBACK: i64 = 6 * 60 * 60;
/// Keep recently used EPG downloads bounded across distinct playlist sources.
const EPG_CACHE_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

struct PartialEpgDownload {
    path: PathBuf,
}

impl Drop for PartialEpgDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

struct LimitedReader<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> LimitedReader<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            remaining: limit,
        }
    }
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0u8; 1];
            return match self.inner.read(&mut extra)? {
                0 => Ok(0),
                _ => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "EPG source exceeds decompressed size limit",
                )),
            };
        }
        let readable = buffer.len().min(self.remaining as usize);
        let read = self.inner.read(&mut buffer[..readable])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

/// One XMLTV programme; times are unix epoch seconds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EpgProgramme {
    pub start: i64,
    pub stop: i64,
    pub title: String,
}

#[derive(Debug, Default)]
pub struct EpgIndex {
    programmes: HashMap<(String, String), Vec<EpgProgramme>>,
}

impl EpgIndex {
    pub fn channel_count(&self) -> usize {
        self.programmes
            .keys()
            .map(|(_, tvg_id)| tvg_id)
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn matched_channel_count(&self, tvg_ids: &[String]) -> usize {
        let matched_ids = self
            .programmes
            .keys()
            .map(|(_, tvg_id)| tvg_id.as_str())
            .collect::<HashSet<_>>();
        tvg_ids
            .iter()
            .filter(|tvg_id| matched_ids.contains(tvg_id.as_str()))
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn programme_count(&self) -> usize {
        self.programmes.values().map(Vec::len).sum()
    }

    pub fn has_channel(&self, tvg_id: &str) -> bool {
        self.programmes.keys().any(|(_, id)| id == tvg_id)
    }

    pub fn matched_channel_ids(&self) -> Vec<String> {
        self.programmes
            .keys()
            .map(|(_, tvg_id)| tvg_id.clone())
            .collect()
    }

    /// Programmes overlapping `[from, to)`, oldest first.
    pub fn programmes_for(&self, tvg_id: &str, from: i64, to: i64) -> Vec<EpgProgramme> {
        self.programmes_for_sources(&[], tvg_id, from, to)
    }

    pub fn programmes_for_sources(
        &self,
        sources: &[String],
        tvg_id: &str,
        from: i64,
        to: i64,
    ) -> Vec<EpgProgramme> {
        let default_source = String::new();
        let requested_sources = if sources.is_empty() {
            std::slice::from_ref(&default_source)
        } else {
            sources
        };
        let tvg_id = tvg_id.to_string();
        let mut programmes = requested_sources
            .iter()
            .filter_map(|source| self.programmes.get(&(source.clone(), tvg_id.clone())))
            .flat_map(|programmes| programmes.iter())
            .filter(|programme| programme.stop > from && programme.start < to)
            .cloned()
            .collect::<Vec<_>>();
        programmes.sort_by_key(|programme| programme.start);
        programmes.dedup();
        Self::drop_overlaps(&mut programmes);
        programmes
    }

    /// Guides sometimes list a slot twice with slightly different times (two
    /// listings merged, or a provider's own duplicates). Keep the earlier
    /// entry and drop anything that starts inside it; a minute of overlap is
    /// tolerated as rounding.
    fn drop_overlaps(programmes: &mut Vec<EpgProgramme>) {
        const OVERLAP_TOLERANCE_S: i64 = 60;
        let mut last_stop = i64::MIN;
        programmes.retain(|programme| {
            if programme.start < last_stop.saturating_sub(OVERLAP_TOLERANCE_S) {
                return false;
            }
            last_stop = last_stop.max(programme.stop);
            true
        });
    }

    pub fn merge(&mut self, other: EpgIndex) {
        for (channel, mut programmes) in other.programmes {
            let merged = self.programmes.entry(channel).or_default();
            merged.append(&mut programmes);
            Self::finalize_programmes(merged);
        }
    }

    pub fn merge_sources_from(
        &mut self,
        other: &Self,
        sources: &HashSet<String>,
        tvg_ids: &HashSet<String>,
    ) {
        self.programmes.extend(
            other
                .programmes
                .iter()
                .filter(|((source, tvg_id), _)| {
                    sources.contains(source) && tvg_ids.contains(tvg_id)
                })
                .map(|(channel, programmes)| (channel.clone(), programmes.clone())),
        );
    }

    fn finalize(&mut self) {
        for programmes in self.programmes.values_mut() {
            Self::finalize_programmes(programmes);
        }
    }

    fn finalize_programmes(programmes: &mut Vec<EpgProgramme>) {
        programmes.sort_by_key(|programme| programme.start);
        for index in 0..programmes.len() {
            if programmes[index].stop == programmes[index].start {
                let start = programmes[index].start;
                let stop = programmes[index + 1..]
                    .iter()
                    .find(|programme| programme.start > start)
                    .map(|programme| programme.start)
                    .unwrap_or(start.saturating_add(EPG_MISSING_STOP_FALLBACK));
                programmes[index].stop = stop;
            }
        }
        programmes.dedup();
    }
}

/// Howard Hinnant's days-from-civil: days since 1970-01-01 for a Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

/// Parse an XMLTV timestamp (`YYYYMMDDHHMMSS ±HHMM`, seconds and offset
/// optional) into unix epoch seconds. Timestamps without an offset are UTC.
pub fn parse_xmltv_time(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    // The offset starts at the first space or sign after the date digits.
    let (digits, offset) = match raw.find([' ', '+', '-']) {
        Some(position) if position >= 12 => (&raw[..position], raw[position..].trim()),
        _ => (raw, ""),
    };

    if digits.len() < 12 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let field = |from: usize, to: usize| digits[from..to].parse::<i64>().ok();
    let year = field(0, 4)?;
    let month = field(4, 6)?;
    let day = field(6, 8)?;
    let hour = field(8, 10)?;
    let minute = field(10, 12)?;
    let second = if digits.len() >= 14 {
        field(12, 14)?
    } else {
        0
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }

    let mut epoch =
        days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;

    // Offset formats: "+0200", "-0530", "0200" (sign consumed by split above).
    let offset = offset.trim();
    if !offset.is_empty() {
        let (sign, body) = match offset.as_bytes()[0] {
            b'-' => (-1, &offset[1..]),
            b'+' => (1, &offset[1..]),
            _ => (1, offset),
        };
        if body.len() == 4 && body.chars().all(|c| c.is_ascii_digit()) {
            let hours = body[0..2].parse::<i64>().ok()?;
            let minutes = body[2..4].parse::<i64>().ok()?;
            epoch -= sign * (hours * 3_600 + minutes * 60);
        }
    }
    Some(epoch)
}

/// Parse an XMLTV document into `index`, keeping only programmes whose
/// `channel` is in `wanted` (an empty filter keeps everything).
pub fn parse_xmltv_into<R: Read>(
    source: R,
    wanted: &HashSet<String>,
    index: &mut EpgIndex,
) -> Result<(), AppError> {
    parse_xmltv_into_with_source(source, wanted, "", index)
}

/// Parse one XMLTV source while retaining the source identity in the index.
pub fn parse_xmltv_into_with_source<R: Read>(
    source: R,
    wanted: &HashSet<String>,
    source_identity: &str,
    index: &mut EpgIndex,
) -> Result<(), AppError> {
    let mut reader = Reader::from_reader(BufReader::new(source));
    reader.config_mut().trim_text(true);

    let mut buffer = Vec::new();
    let mut current: Option<(String, i64, Option<i64>)> = None;
    let mut current_title: Option<String> = None;
    let mut in_title = false;
    let mut saw_xmltv_root = false;
    let mut closed_xmltv_root = false;
    let mut element_depth = 0usize;

    loop {
        buffer.clear();
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => {
                if !saw_xmltv_root {
                    if element.name().as_ref() != b"tv" {
                        return Err(AppError::Other(
                            "Failed to parse XMLTV: document root is not <tv>".to_string(),
                        ));
                    }
                    saw_xmltv_root = true;
                }
                element_depth += 1;

                match element.name().as_ref() {
                    b"programme" => {
                        let mut channel = None;
                        let mut start = None;
                        let mut stop = None;
                        for attribute in element.attributes().flatten() {
                            let value = attribute
                                .decode_and_unescape_value(reader.decoder())
                                .unwrap_or_default();
                            match attribute.key.as_ref() {
                                b"channel" => channel = Some(value.into_owned()),
                                b"start" => start = parse_xmltv_time(&value),
                                b"stop" => stop = parse_xmltv_time(&value),
                                _ => {}
                            }
                        }
                        current = match (channel, start, stop) {
                            (Some(channel), Some(start), stop)
                                if wanted.is_empty() || wanted.contains(&channel) =>
                            {
                                Some((channel, start, stop))
                            }
                            _ => None,
                        };
                        current_title = None;
                    }
                    b"title" if current.is_some() && current_title.is_none() => {
                        in_title = true;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(element)) => {
                if !saw_xmltv_root {
                    if element.name().as_ref() != b"tv" {
                        return Err(AppError::Other(
                            "Failed to parse XMLTV: document root is not <tv>".to_string(),
                        ));
                    }
                    saw_xmltv_root = true;
                    closed_xmltv_root = true;
                }
            }
            Ok(Event::Text(text)) => {
                if in_title {
                    let value = text.unescape().unwrap_or_default().into_owned();
                    if !value.trim().is_empty() {
                        current_title = Some(value.trim().to_string());
                    }
                    in_title = false;
                }
            }
            Ok(Event::CData(text)) => {
                if in_title {
                    let value = text.decode().unwrap_or_default().into_owned();
                    if !value.trim().is_empty() {
                        current_title = Some(value.trim().to_string());
                    }
                    in_title = false;
                }
            }
            Ok(Event::End(element)) => {
                let closes_root = element_depth == 1 && element.name().as_ref() == b"tv";
                match element.name().as_ref() {
                    b"programme" => {
                        if let Some((channel, start, stop)) = current.take() {
                            if stop.is_none_or(|stop| stop > start) {
                                index
                                    .programmes
                                    .entry((source_identity.to_string(), channel))
                                    .or_default()
                                    .push(EpgProgramme {
                                        start,
                                        // `start` is an internal sentinel for an omitted stop time;
                                        // finalize replaces it with the following programme or fallback.
                                        stop: stop.unwrap_or(start),
                                        title: current_title
                                            .take()
                                            .unwrap_or_else(|| "Untitled".to_string()),
                                    });
                            }
                        }
                        in_title = false;
                    }
                    b"title" => in_title = false,
                    _ => {}
                }
                if closes_root {
                    closed_xmltv_root = true;
                }
                element_depth = element_depth.saturating_sub(1);
            }
            Ok(Event::Eof) => {
                if !saw_xmltv_root {
                    return Err(AppError::Other(
                        "Failed to parse XMLTV: missing <tv> root".to_string(),
                    ));
                }
                if !closed_xmltv_root {
                    return Err(AppError::Other(
                        "Failed to parse XMLTV: document ended before </tv>".to_string(),
                    ));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => {
                return Err(AppError::Other(format!("Failed to parse XMLTV: {error}")));
            }
        }
    }

    index.finalize();
    Ok(())
}

/// Open a cached guide file, transparently gunzipping `.gz` payloads.
pub fn open_guide_file(path: &Path) -> Result<Box<dyn Read + Send>, AppError> {
    let mut file = std::fs::File::open(path).map_err(AppError::Io)?;
    let mut magic = [0u8; 2];
    let read = std::io::Read::read(&mut file, &mut magic).map_err(AppError::Io)?;
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(AppError::Io)?;
    if read == 2 && magic == [0x1f, 0x8b] {
        Ok(Box::new(LimitedReader::new(
            flate2::read::MultiGzDecoder::new(file),
            EPG_MAX_DECOMPRESSED_BYTES,
        )))
    } else {
        Ok(Box::new(LimitedReader::new(
            file,
            EPG_MAX_DECOMPRESSED_BYTES,
        )))
    }
}

pub fn cache_path_for(cache_dir: &Path, url: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hash = hasher.finalize();
    let hex: String = hash.iter().take(16).map(|b| format!("{b:02x}")).collect();
    cache_dir.join(format!("epg-{hex}.bin"))
}

/// Return a safe source label for logs and UI-visible failure summaries.
pub fn redact_epg_source(source: &str) -> String {
    let Ok(mut url) = url::Url::parse(source) else {
        return "<invalid EPG source>".to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn cache_is_fresh(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < EPG_CACHE_TTL)
}

fn temporary_cache_path(target: &Path) -> PathBuf {
    let id = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
    target.with_extension(format!("{}.{}.part", std::process::id(), id))
}

fn remove_stale_partial_downloads(cache_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("epg-") || !name.ends_with(".part") {
            continue;
        }
        let is_stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= EPG_DOWNLOAD_TIMEOUT);
        if is_stale {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!(
                    "Failed to remove stale partial EPG download {}: {error}",
                    path.display()
                );
            }
        }
    }
}

fn prune_epg_cache(cache_dir: &Path, keep: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut cached = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if path == keep || !name.starts_with("epg-") || !name.ends_with(".bin") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((
                metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                metadata.len(),
                path,
            ))
        })
        .collect::<Vec<_>>();
    let mut total_bytes = cached.iter().map(|(_, size, _)| size).sum::<u64>();
    total_bytes += std::fs::metadata(keep)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    cached.sort_by_key(|(modified, _, _)| *modified);

    for (_, size, path) in cached {
        if total_bytes <= max_bytes {
            break;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => total_bytes = total_bytes.saturating_sub(size),
            Err(error) => log::warn!("Failed to prune EPG cache {}: {error}", path.display()),
        }
    }
}

/// Download one EPG source into the cache (streamed), reusing a fresh copy.
pub async fn download_epg_source(
    url: &str,
    cache_dir: &Path,
    accept_invalid_certs: bool,
    force_refresh: bool,
    cancel: &CancellationToken,
) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(cache_dir).map_err(AppError::Io)?;
    remove_stale_partial_downloads(cache_dir);
    let target = cache_path_for(cache_dir, url);
    if !force_refresh && cache_is_fresh(&target) {
        log::info!("EPG cache hit for {}", redact_epg_source(url));
        return Ok(target);
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(EPG_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(EPG_DOWNLOAD_TIMEOUT)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|error| AppError::Other(format!("Failed to build HTTP client: {error}")))?;

    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(AppError::Other("EPG load superseded".to_string())),
        response = client
            .get(url)
            .header(reqwest::header::USER_AGENT, PLAYLIST_DOWNLOAD_USER_AGENT)
            .send() => response.map_err(|error| {
            AppError::Other(format!("EPG download failed: {}", error.without_url()))
        })?,
    };
    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "EPG download failed: HTTP {}",
            response.status()
        )));
    }

    let temp = temporary_cache_path(&target);
    let _partial_download = PartialEpgDownload { path: temp.clone() };
    let mut file = tokio::fs::File::create(&temp).await.map_err(AppError::Io)?;
    let mut downloaded: u64 = 0;
    let mut stream = response;
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::Other("EPG load superseded".to_string())),
            chunk = stream.chunk() => chunk.map_err(|error| {
                AppError::Other(format!("EPG download failed: {}", error.without_url()))
            })?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        downloaded += chunk.len() as u64;
        if downloaded > EPG_MAX_DOWNLOAD_BYTES {
            return Err(AppError::Other(format!(
                "EPG source exceeds {} MB limit",
                EPG_MAX_DOWNLOAD_BYTES / (1024 * 1024)
            )));
        }
        file.write_all(&chunk).await.map_err(AppError::Io)?;
    }
    file.flush().await.map_err(AppError::Io)?;
    drop(file);
    crate::engine::disk::atomic_rename(&target, &temp)?;
    prune_epg_cache(cache_dir, &target, EPG_CACHE_MAX_BYTES);
    log::info!(
        "Downloaded EPG {} ({downloaded} bytes)",
        redact_epg_source(url)
    );
    Ok(target)
}

#[cfg(test)]
mod tests {
    #[test]
    fn overlapping_listings_keep_the_earlier_entry() {
        let mut programmes = vec![
            EpgProgramme {
                start: 100,
                stop: 200,
                title: "A".into(),
            },
            EpgProgramme {
                start: 130,
                stop: 220,
                title: "A again".into(),
            },
            EpgProgramme {
                start: 199,
                stop: 300,
                title: "B (rounded)".into(),
            },
            EpgProgramme {
                start: 300,
                stop: 400,
                title: "C".into(),
            },
        ];
        EpgIndex::drop_overlaps(&mut programmes);
        let titles: Vec<&str> = programmes.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, vec!["A", "B (rounded)", "C"]);
    }

    use super::*;
    use std::io::Write;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn parses_xmltv_timestamps_with_and_without_offsets() {
        // 2026-08-29 06:30:00 UTC
        assert_eq!(parse_xmltv_time("20260829063000"), Some(1_787_985_000));
        // Same instant expressed with +02:00
        assert_eq!(
            parse_xmltv_time("20260829083000 +0200"),
            Some(1_787_985_000)
        );
        assert_eq!(
            parse_xmltv_time("20260829043000 -0200"),
            Some(1_787_985_000)
        );
        // Minute precision only
        assert_eq!(parse_xmltv_time("202608290630"), Some(1_787_985_000));
        assert_eq!(parse_xmltv_time("garbage"), None);
        assert_eq!(parse_xmltv_time(""), None);
    }

    #[test]
    fn parses_programmes_filtered_by_channel() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="nrk1.no"><display-name>NRK1</display-name></channel>
  <programme start="20260828200000 +0000" stop="20260828210000 +0000" channel="nrk1.no">
    <title lang="no">Dagsrevyen</title>
    <desc>News broadcast</desc>
  </programme>
  <programme start="20260828210000 +0000" stop="20260828220000 +0000" channel="nrk1.no">
    <title>Exit</title>
  </programme>
  <programme start="20260828200000 +0000" stop="20260828210000 +0000" channel="unwanted.tv">
    <title>Skipped</title>
  </programme>
</tv>"#;

        let wanted = HashSet::from(["nrk1.no".to_string()]);
        let mut index = EpgIndex::default();
        parse_xmltv_into(xml.as_bytes(), &wanted, &mut index).expect("xmltv should parse");

        assert_eq!(index.channel_count(), 1);
        assert_eq!(
            index.matched_channel_count(&[
                "nrk1.no".to_string(),
                "nrk1.no".to_string(),
                "unwanted.tv".to_string(),
            ]),
            1
        );
        assert_eq!(index.programme_count(), 2);
        let programmes = index.programmes_for("nrk1.no", 0, i64::MAX);
        assert_eq!(programmes[0].title, "Dagsrevyen");
        assert_eq!(programmes[1].title, "Exit");
        assert_eq!(programmes[1].stop - programmes[1].start, 3600);

        // Window queries clip to overlapping programmes.
        let start = programmes[0].start;
        let only_first = index.programmes_for("nrk1.no", start, start + 1800);
        assert_eq!(only_first.len(), 1);
        assert!(index.programmes_for("unwanted.tv", 0, i64::MAX).is_empty());
    }

    #[test]
    fn infers_missing_programme_stop_times() {
        let xml = r#"<tv>
  <programme start="20260828200000" channel="nrk1.no"><title>News</title></programme>
  <programme start="20260828210000" stop="20260828211000" channel="nrk1.no"><title>Weather</title></programme>
  <programme start="20260828220000" channel="nrk1.no"><title>Late</title></programme>
</tv>"#;
        let mut index = EpgIndex::default();

        parse_xmltv_into(xml.as_bytes(), &HashSet::new(), &mut index).expect("xmltv should parse");

        let programmes = index.programmes_for("nrk1.no", 0, i64::MAX);
        assert_eq!(programmes.len(), 3);
        assert_eq!(programmes[0].stop, programmes[1].start);
        assert_eq!(
            programmes[2].stop - programmes[2].start,
            EPG_MISSING_STOP_FALLBACK
        );
    }

    #[test]
    fn parses_cdata_programme_titles() {
        let xml = r#"<tv><programme start="20260828200000" stop="20260828210000" channel="nrk1.no"><title><![CDATA[News & Weather]]></title></programme></tv>"#;
        let mut index = EpgIndex::default();
        parse_xmltv_into(xml.as_bytes(), &HashSet::new(), &mut index).expect("xmltv should parse");

        let programmes = index.programmes_for("nrk1.no", 0, i64::MAX);
        assert_eq!(programmes[0].title, "News & Weather");
    }

    #[test]
    fn accepts_an_empty_xmltv_guide() {
        let mut index = EpgIndex::default();

        parse_xmltv_into("<tv/>".as_bytes(), &HashSet::new(), &mut index)
            .expect("empty XMLTV guide should parse");

        assert_eq!(index.programme_count(), 0);
    }

    #[test]
    fn rejects_documents_without_an_xmltv_root() {
        for document in ["", "<html><body>Sign in</body></html>"] {
            let mut index = EpgIndex::default();

            let error = parse_xmltv_into(document.as_bytes(), &HashSet::new(), &mut index)
                .expect_err("non-XMLTV document should fail");

            assert!(error.to_string().contains("XMLTV"));
        }
    }

    #[test]
    fn rejects_xmltv_documents_with_an_unclosed_root() {
        let xml = r#"<tv><programme start="20260828200000" stop="20260828210000" channel="news"><title>News</title></programme>"#;
        let mut index = EpgIndex::default();

        let error = parse_xmltv_into(xml.as_bytes(), &HashSet::new(), &mut index)
            .expect_err("truncated XMLTV document should fail");

        assert!(error.to_string().contains("before </tv>"));
    }

    #[test]
    fn parses_windows_1252_channel_ids_and_titles() {
        let xml = b"<?xml version=\"1.0\" encoding=\"windows-1252\"?><tv><programme start=\"20260828200000\" stop=\"20260828210000\" channel=\"caf\xe9\"><title>Caf\xe9 News</title></programme></tv>";
        let wanted = HashSet::from(["café".to_string()]);
        let mut index = EpgIndex::default();

        parse_xmltv_into(xml.as_slice(), &wanted, &mut index).expect("xmltv should parse");

        let programmes = index.programmes_for("café", 0, i64::MAX);
        assert_eq!(programmes[0].title, "Café News");
    }

    #[test]
    fn keeps_programmes_with_matching_ids_scoped_to_their_source() {
        let first = r#"<tv><programme start="20260828200000" stop="20260828210000" channel="news"><title>Provider A</title></programme></tv>"#;
        let second = r#"<tv><programme start="20260828200000" stop="20260828210000" channel="news"><title>Provider B</title></programme></tv>"#;
        let wanted = HashSet::from(["news".to_string()]);
        let first_source = "https://provider-a.example/epg.xml".to_string();
        let second_source = "https://provider-b.example/epg.xml".to_string();
        let mut index = EpgIndex::default();

        parse_xmltv_into_with_source(first.as_bytes(), &wanted, &first_source, &mut index)
            .expect("first source should parse");
        parse_xmltv_into_with_source(second.as_bytes(), &wanted, &second_source, &mut index)
            .expect("second source should parse");

        assert_eq!(index.channel_count(), 1);
        assert_eq!(
            index.programmes_for_sources(&[first_source], "news", 0, i64::MAX)[0].title,
            "Provider A"
        );
        assert_eq!(
            index.programmes_for_sources(&[second_source], "news", 0, i64::MAX)[0].title,
            "Provider B"
        );
    }

    #[test]
    fn merges_only_programmes_from_requested_sources() {
        let parsed_ids = HashSet::from(["news".to_string(), "old".to_string()]);
        let retained_source = "https://failed.example/epg.xml".to_string();
        let replaced_source = "https://loaded.example/epg.xml".to_string();
        let mut previous = EpgIndex::default();
        parse_xmltv_into_with_source(
            r#"<tv><programme start="20260828200000" stop="20260828210000" channel="news"><title>Retained</title></programme><programme start="20260828200000" stop="20260828210000" channel="old"><title>Stale</title></programme></tv>"#.as_bytes(),
            &parsed_ids,
            &retained_source,
            &mut previous,
        )
        .expect("retained source should parse");
        parse_xmltv_into_with_source(
            r#"<tv><programme start="20260828200000" stop="20260828210000" channel="news"><title>Old</title></programme></tv>"#.as_bytes(),
            &parsed_ids,
            &replaced_source,
            &mut previous,
        )
        .expect("replaced source should parse");

        let mut refreshed = EpgIndex::default();
        refreshed.merge_sources_from(
            &previous,
            &HashSet::from([retained_source.clone()]),
            &HashSet::from(["news".to_string()]),
        );

        assert_eq!(
            refreshed.programmes_for_sources(
                std::slice::from_ref(&retained_source),
                "news",
                0,
                i64::MAX,
            )[0]
            .title,
            "Retained"
        );
        assert!(refreshed
            .programmes_for_sources(std::slice::from_ref(&replaced_source), "news", 0, i64::MAX,)
            .is_empty());
        assert!(refreshed
            .programmes_for_sources(std::slice::from_ref(&retained_source), "old", 0, i64::MAX,)
            .is_empty());
    }

    #[test]
    fn redacts_epg_source_credentials() {
        assert_eq!(
            redact_epg_source(
                "https://alice:secret@example.com/xmltv.php?username=alice&password=secret"
            ),
            "https://example.com/"
        );
        assert_eq!(
            redact_epg_source("https://example.com/xmltv/alice/secret"),
            "https://example.com/"
        );
    }

    #[test]
    fn uses_unique_temporary_cache_paths() {
        let target = Path::new("epg-cache.bin");

        assert_ne!(temporary_cache_path(target), temporary_cache_path(target));
    }

    #[test]
    fn rejects_readers_that_exceed_the_decompressed_limit() {
        let mut reader = LimitedReader::new("too long".as_bytes(), 3);
        let mut output = Vec::new();

        let error = reader
            .read_to_end(&mut output)
            .expect_err("should exceed limit");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(output, b"too");
    }

    #[test]
    fn prunes_old_epg_cache_entries_but_keeps_current_download() {
        let dir = std::env::temp_dir().join(format!(
            "iptv-epg-cache-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let oldest = dir.join("epg-oldest.bin");
        let newest = dir.join("epg-newest.bin");
        let keep = dir.join("epg-keep.bin");
        std::fs::write(&oldest, [0; 4]).expect("write oldest");
        std::fs::write(&newest, [0; 4]).expect("write newest");
        std::fs::write(&keep, [0; 4]).expect("write keep");
        std::fs::File::open(&oldest)
            .expect("open oldest")
            .set_modified(std::time::SystemTime::UNIX_EPOCH)
            .expect("age oldest");

        prune_epg_cache(&dir, &keep, 8);

        assert!(!oldest.exists());
        assert!(newest.exists());
        assert!(keep.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn removes_stale_partial_epg_downloads() {
        let dir = std::env::temp_dir().join(format!(
            "iptv-epg-partial-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let stale = dir.join("epg-stale.1.0.part");
        let unrelated = dir.join("other-stale.part");
        std::fs::write(&stale, [0; 4]).expect("write stale partial");
        std::fs::write(&unrelated, [0; 4]).expect("write unrelated partial");
        std::fs::File::open(&stale)
            .expect("open stale partial")
            .set_modified(std::time::SystemTime::UNIX_EPOCH)
            .expect("age stale partial");

        remove_stale_partial_downloads(&dir);

        assert!(!stale.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[tokio::test]
    async fn cancels_epg_downloads_before_connecting() {
        let dir = std::env::temp_dir().join(format!(
            "iptv-epg-cancel-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = download_epg_source(
            "https://example.invalid/guide.xml",
            &dir,
            false,
            false,
            &cancel,
        )
        .await
        .expect_err("cancelled EPG download should stop");

        assert!(error.to_string().contains("superseded"));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[tokio::test]
    async fn downloads_epg_with_iptv_user_agent() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server should have local address");
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("test server should accept");
            let mut request = Vec::new();
            loop {
                let mut chunk = [0u8; 1024];
                let read = socket
                    .read(&mut chunk)
                    .await
                    .expect("test server should read request");
                request.extend_from_slice(&chunk[..read]);
                if read == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = request_tx.send(String::from_utf8_lossy(&request).into_owned());
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n<tv/>",
                )
                .await
                .expect("test server should write response");
        });

        let dir = std::env::temp_dir().join(format!(
            "iptv-epg-user-agent-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let cancel = CancellationToken::new();
        download_epg_source(
            &format!("http://{address}/guide.xml"),
            &dir,
            false,
            false,
            &cancel,
        )
        .await
        .expect("EPG should download");

        let request = request_rx.await.expect("request should be captured");
        assert!(request.to_ascii_lowercase().contains(&format!(
            "user-agent: {}",
            PLAYLIST_DOWNLOAD_USER_AGENT.to_ascii_lowercase()
        )));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn gunzips_cached_guides_transparently() {
        let xml = "<tv><programme start=\"20260828200000\" stop=\"20260828210000\" channel=\"a\"><title>T</title></programme></tv>";
        let dir = std::env::temp_dir().join(format!(
            "iptv-epg-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("guide.xml.gz");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(xml.as_bytes()).expect("gzip write");
        std::fs::write(&path, encoder.finish().expect("gzip finish")).expect("write");

        let mut index = EpgIndex::default();
        parse_xmltv_into(
            open_guide_file(&path).expect("open"),
            &HashSet::new(),
            &mut index,
        )
        .expect("parse");
        assert_eq!(index.programme_count(), 1);

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn gunzips_concatenated_cached_guides_transparently() {
        let chunks = [
            "<tv><programme start=\"20260828200000\" stop=\"20260828210000\" channel=\"a\">",
            "<title>T</title></programme></tv>",
        ];
        let compressed = chunks
            .into_iter()
            .flat_map(|chunk| {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(chunk.as_bytes()).expect("gzip write");
                encoder.finish().expect("gzip finish")
            })
            .collect::<Vec<_>>();
        let dir = std::env::temp_dir().join(format!(
            "iptv-epg-multigzip-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("guide.xml.gz");
        std::fs::write(&path, compressed).expect("write");

        let mut index = EpgIndex::default();
        parse_xmltv_into(
            open_guide_file(&path).expect("open"),
            &HashSet::new(),
            &mut index,
        )
        .expect("parse");
        assert_eq!(index.programme_count(), 1);

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
