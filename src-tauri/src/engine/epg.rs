//! XMLTV EPG store: streamed download with a disk cache, gzip-aware parsing,
//! and an in-memory programme index filtered to the playlist's tvg-ids so a
//! multi-hundred-MB provider guide does not balloon into memory.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

const EPG_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const EPG_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const EPG_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// Hard cap on a single downloaded guide; anything larger is a broken feed.
const EPG_MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;

/// One XMLTV programme; times are unix epoch seconds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EpgProgramme {
    pub start: i64,
    pub stop: i64,
    pub title: String,
}

#[derive(Debug, Default)]
pub struct EpgIndex {
    programmes: HashMap<String, Vec<EpgProgramme>>,
}

impl EpgIndex {
    pub fn channel_count(&self) -> usize {
        self.programmes.len()
    }

    pub fn programme_count(&self) -> usize {
        self.programmes.values().map(Vec::len).sum()
    }

    pub fn has_channel(&self, tvg_id: &str) -> bool {
        self.programmes.contains_key(tvg_id)
    }

    pub fn matched_channel_ids(&self) -> Vec<String> {
        self.programmes.keys().cloned().collect()
    }

    /// Programmes overlapping `[from, to)`, oldest first.
    pub fn programmes_for(&self, tvg_id: &str, from: i64, to: i64) -> Vec<EpgProgramme> {
        let Some(programmes) = self.programmes.get(tvg_id) else {
            return Vec::new();
        };
        programmes
            .iter()
            .filter(|programme| programme.stop > from && programme.start < to)
            .cloned()
            .collect()
    }

    pub fn merge(&mut self, other: EpgIndex) {
        for (channel, mut programmes) in other.programmes {
            self.programmes
                .entry(channel)
                .or_default()
                .append(&mut programmes);
        }
        self.finalize();
    }

    fn finalize(&mut self) {
        for programmes in self.programmes.values_mut() {
            programmes.sort_by_key(|programme| programme.start);
            programmes.dedup();
        }
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
    let mut reader = Reader::from_reader(BufReader::new(source));
    reader.config_mut().trim_text(true);

    let mut buffer = Vec::new();
    let mut current: Option<(String, i64, i64)> = None;
    let mut current_title: Option<String> = None;
    let mut in_title = false;

    loop {
        buffer.clear();
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => match element.name().as_ref() {
                b"programme" => {
                    let mut channel = None;
                    let mut start = None;
                    let mut stop = None;
                    for attribute in element.attributes().flatten() {
                        let value = attribute.unescape_value().unwrap_or_default();
                        match attribute.key.as_ref() {
                            b"channel" => channel = Some(value.into_owned()),
                            b"start" => start = parse_xmltv_time(&value),
                            b"stop" => stop = parse_xmltv_time(&value),
                            _ => {}
                        }
                    }
                    current = match (channel, start, stop) {
                        (Some(channel), Some(start), Some(stop))
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
            },
            Ok(Event::Text(text)) => {
                if in_title {
                    let value = text.unescape().unwrap_or_default().into_owned();
                    if !value.trim().is_empty() {
                        current_title = Some(value.trim().to_string());
                    }
                    in_title = false;
                }
            }
            Ok(Event::End(element)) => match element.name().as_ref() {
                b"programme" => {
                    if let Some((channel, start, stop)) = current.take() {
                        if stop > start {
                            index
                                .programmes
                                .entry(channel)
                                .or_default()
                                .push(EpgProgramme {
                                    start,
                                    stop,
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
            },
            Ok(Event::Eof) => break,
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
        Ok(Box::new(flate2::read::GzDecoder::new(file)))
    } else {
        Ok(Box::new(file))
    }
}

pub fn cache_path_for(cache_dir: &Path, url: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hash = hasher.finalize();
    let hex: String = hash.iter().take(16).map(|b| format!("{b:02x}")).collect();
    cache_dir.join(format!("epg-{hex}.bin"))
}

fn cache_is_fresh(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < EPG_CACHE_TTL)
}

/// Download one EPG source into the cache (streamed), reusing a fresh copy.
pub async fn download_epg_source(
    url: &str,
    cache_dir: &Path,
    accept_invalid_certs: bool,
    force_refresh: bool,
) -> Result<PathBuf, AppError> {
    let target = cache_path_for(cache_dir, url);
    if !force_refresh && cache_is_fresh(&target) {
        log::info!("EPG cache hit for {url}");
        return Ok(target);
    }

    std::fs::create_dir_all(cache_dir).map_err(AppError::Io)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(EPG_DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(EPG_DOWNLOAD_TIMEOUT)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|error| AppError::Other(format!("Failed to build HTTP client: {error}")))?;

    let response = client.get(url).send().await.map_err(|error| {
        AppError::Other(format!("EPG download failed: {}", error.without_url()))
    })?;
    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "EPG download failed: HTTP {}",
            response.status()
        )));
    }

    let temp = target.with_extension("part");
    let mut file = std::fs::File::create(&temp).map_err(AppError::Io)?;
    let mut downloaded: u64 = 0;
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| AppError::Other(format!("EPG download failed: {}", error.without_url())))?
    {
        downloaded += chunk.len() as u64;
        if downloaded > EPG_MAX_DOWNLOAD_BYTES {
            let _ = std::fs::remove_file(&temp);
            return Err(AppError::Other(format!(
                "EPG source exceeds {} MB limit",
                EPG_MAX_DOWNLOAD_BYTES / (1024 * 1024)
            )));
        }
        file.write_all(&chunk).map_err(AppError::Io)?;
    }
    file.flush().map_err(AppError::Io)?;
    drop(file);
    std::fs::rename(&temp, &target).map_err(AppError::Io)?;
    log::info!("Downloaded EPG {url} ({downloaded} bytes)");
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
