//! Playlist health scoring.
//!
//! Pure functions over finished scan results: no IO, no app state. Kept out of
//! the scan orchestrator so the weightings can be read and tested on their own.
//!
//! The score has three components, combined as
//! `0.25 * ping + 0.40 * content + 0.35 * quality`, each on a 0..10 scale.

use std::collections::HashSet;

use crate::models::channel::{ChannelResult, ChannelStatus};
use crate::models::scan::PlaylistScore;

fn clamp_01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn clamp_score_10(value: f64) -> f64 {
    value.clamp(0.0, 10.0)
}

fn round_to_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn median_u64(values: &[u64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        Some(sorted[mid] as f64)
    } else {
        Some((sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0)
    }
}

fn is_hd_or_uhd(result: &ChannelResult) -> bool {
    if let (Some(width), Some(height)) = (result.width, result.height) {
        if width >= 1280 && height >= 720 {
            return true;
        }
    }
    if let Some(resolution) = result.resolution.as_ref() {
        let normalized = resolution.to_ascii_lowercase();
        return normalized.contains("720")
            || normalized.contains("1080")
            || normalized.contains("1440")
            || normalized.contains("2160")
            || normalized.contains("4k")
            || normalized.contains("uhd");
    }
    false
}

fn codec_tier_score(codec: Option<&str>) -> f64 {
    let Some(codec) = codec else {
        return 0.4;
    };
    let normalized = codec.to_ascii_lowercase();
    if normalized.contains("hevc") || normalized.contains("h265") || normalized.contains("h.265") {
        return 1.0;
    }
    if normalized.contains("av1") {
        return 1.0;
    }
    if normalized.contains("h264") || normalized.contains("h.264") || normalized.contains("avc") {
        return 0.8;
    }
    if normalized.contains("mpeg") || normalized.contains("vp9") {
        return 0.6;
    }
    0.5
}

pub fn compute_playlist_score(
    results: &[ChannelResult],
    total_channels: usize,
) -> Option<PlaylistScore> {
    if total_channels == 0 {
        return None;
    }

    let alive_results = results
        .iter()
        .filter(|result| result.status == ChannelStatus::Alive)
        .collect::<Vec<_>>();
    let alive_count = alive_results.len();

    let ping_score = {
        let latencies = alive_results
            .iter()
            .filter_map(|result| result.latency_ms)
            .collect::<Vec<_>>();
        let p50 = median_u64(&latencies);
        let raw = if let Some(p50) = p50 {
            // 100ms ~= excellent (10), 1200ms ~= poor (0)
            (1200.0 - p50) / 1100.0 * 10.0
        } else {
            0.0
        };
        clamp_score_10(raw)
    };

    let content_score = {
        let alive_ratio = alive_count as f64 / total_channels as f64;
        let unique_groups = results
            .iter()
            .map(|result| result.group.trim().to_ascii_lowercase())
            .filter(|group| !group.is_empty())
            .collect::<HashSet<_>>()
            .len();
        let diversity_ratio = clamp_01(unique_groups as f64 / 20.0);
        let epg_covered = results
            .iter()
            .filter(|result| {
                result
                    .tvg_id
                    .as_deref()
                    .map(str::trim)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
            })
            .count();
        let epg_ratio = epg_covered as f64 / total_channels as f64;

        clamp_score_10((alive_ratio * 0.6 + diversity_ratio * 0.2 + epg_ratio * 0.2) * 10.0)
    };

    let quality_score = {
        if alive_results.is_empty() {
            0.0
        } else {
            let hd_ratio = alive_results
                .iter()
                .filter(|result| is_hd_or_uhd(result))
                .count() as f64
                / alive_results.len() as f64;

            let codec_avg = alive_results
                .iter()
                .map(|result| codec_tier_score(result.codec.as_deref()))
                .sum::<f64>()
                / alive_results.len() as f64;

            let fps_known = alive_results
                .iter()
                .filter(|result| result.fps.is_some())
                .count();
            let fps_ratio = if fps_known == 0 {
                0.0
            } else {
                alive_results
                    .iter()
                    .filter(|result| result.fps.unwrap_or_default() >= 25)
                    .count() as f64
                    / fps_known as f64
            };

            clamp_score_10((hd_ratio * 0.5 + codec_avg * 0.3 + fps_ratio * 0.2) * 10.0)
        }
    };

    let overall_score =
        clamp_score_10(ping_score * 0.25 + content_score * 0.40 + quality_score * 0.35);

    Some(PlaylistScore {
        overall: round_to_tenth(overall_score),
        ping: round_to_tenth(ping_score),
        content: round_to_tenth(content_score),
        quality: round_to_tenth(quality_score),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::channel::ContentType;

    /// Minimal alive/dead result; each test sets only the fields it scores on.
    fn result(index: usize, status: ChannelStatus, group: &str) -> ChannelResult {
        ChannelResult {
            index,
            playlist: "fixture.m3u8".to_string(),
            name: format!("Channel {index}"),
            group: group.to_string(),
            language: None,
            tvg_id: None,
            tvg_name: None,
            tvg_logo: None,
            tvg_chno: None,
            url: format!("http://example.com/{index}.m3u8"),
            content_type: ContentType::Live,
            status,
            codec: None,
            resolution: None,
            width: None,
            height: None,
            fps: None,
            latency_ms: None,
            hdr_format: None,
            video_bitrate: None,
            audio_bitrate: None,
            audio_codec: None,
            audio_channel_layout: None,
            audio_only: false,
            screenshot_path: None,
            screenshot_error_reason: None,
            label_mismatches: Vec::new(),
            low_framerate: false,
            error_message: None,
            channel_id: "id".to_string(),
            extinf_line: "#EXTINF:-1,Test".to_string(),
            metadata_lines: Vec::new(),
            stream_url: None,
            retry_count: None,
            error_reason: None,
            drm_system: None,
        }
    }

    #[test]
    fn returns_none_for_empty_scans() {
        assert!(compute_playlist_score(&[], 0).is_none());
    }

    #[test]
    fn builds_weighted_subscores() {
        let mut first = result(0, ChannelStatus::Alive, "Sports");
        first.latency_ms = Some(150);
        first.tvg_id = Some("epg-a".to_string());
        first.width = Some(1920);
        first.height = Some(1080);
        first.codec = Some("h264".to_string());
        first.fps = Some(30);

        let mut second = result(1, ChannelStatus::Alive, "Movies");
        second.latency_ms = Some(300);
        second.tvg_id = Some("epg-b".to_string());
        second.width = Some(3840);
        second.height = Some(2160);
        second.codec = Some("hevc".to_string());
        second.fps = Some(50);

        let third = result(2, ChannelStatus::Dead, "Kids");

        let score = compute_playlist_score(&[first, second, third], 3)
            .expect("score should be present for non-empty scans");

        // p50 latency of 150/300 is 225ms -> (1200-225)/1100*10.
        assert_eq!(score.ping, round_to_tenth((1200.0 - 225.0) / 1100.0 * 10.0));
        // 2/3 alive, 3 groups of the 20 needed for full diversity, 2/3 with EPG.
        let expected_content = ((2.0 / 3.0) * 0.6 + (3.0 / 20.0) * 0.2 + (2.0 / 3.0) * 0.2) * 10.0;
        assert_eq!(score.content, round_to_tenth(expected_content));
        // Both alive channels are HD+, h264 (0.8) and hevc (1.0), both >= 25fps.
        let expected_quality = (1.0 * 0.5 + 0.9 * 0.3 + 1.0 * 0.2) * 10.0;
        assert_eq!(score.quality, round_to_tenth(expected_quality));
        assert!(score.overall > 0.0 && score.overall <= 10.0);
    }

    #[test]
    fn dead_only_scans_score_zero_on_ping_and_quality() {
        let results = [result(0, ChannelStatus::Dead, "News")];
        let score = compute_playlist_score(&results, 1).expect("score for a non-empty scan");
        assert_eq!(score.ping, 0.0);
        assert_eq!(score.quality, 0.0);
    }

    #[test]
    fn resolution_text_stands_in_for_missing_dimensions() {
        let mut tagged = result(0, ChannelStatus::Alive, "News");
        tagged.resolution = Some("1080p".to_string());
        assert!(is_hd_or_uhd(&tagged));

        let mut sd = result(1, ChannelStatus::Alive, "News");
        sd.resolution = Some("480p".to_string());
        assert!(!is_hd_or_uhd(&sd));
    }

    #[test]
    fn codec_tiers_rank_modern_codecs_higher() {
        assert_eq!(codec_tier_score(Some("hevc")), 1.0);
        assert_eq!(codec_tier_score(Some("AV1")), 1.0);
        assert_eq!(codec_tier_score(Some("h.264")), 0.8);
        assert_eq!(codec_tier_score(Some("mpeg2video")), 0.6);
        assert_eq!(codec_tier_score(Some("something-else")), 0.5);
        // An unreported codec scores below every known one.
        assert_eq!(codec_tier_score(None), 0.4);
    }

    #[test]
    fn median_handles_even_and_odd_lengths() {
        assert_eq!(median_u64(&[]), None);
        assert_eq!(median_u64(&[5]), Some(5.0));
        assert_eq!(median_u64(&[10, 20]), Some(15.0));
        // Input order must not matter.
        assert_eq!(median_u64(&[30, 10, 20]), Some(20.0));
    }
}
