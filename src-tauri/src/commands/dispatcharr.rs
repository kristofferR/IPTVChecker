//! Dispatcharr write-back commands: push probe stats into each stream's
//! `stream_stats`, rewrite a channel's ordered stream list, and find provider
//! streams to link. Batches report per-item outcomes; one failure never
//! aborts the rest.

use crate::engine::dispatcharr::{
    build_dispatcharr_source_key, build_m3u, dispatcharr_ids_from_extinf, get_session,
    normalize_dispatcharr_server, register_session, stats_stuck, stream_stats_from_result,
    CandidateMatch, DispatcharrAuth, DispatcharrChannel, DispatcharrClient,
};
use crate::error::AppError;
use crate::models::channel::{Channel, ChannelResult, ChannelStatus};
use crate::models::saved_playlist::SavedPlaylistSource;
use crate::state::AppState;
use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::Manager;

const STATS_PUSH_CONCURRENCY: usize = 4;

type StatsUpdate = (i64, Map<String, Value>);

/// The client for the connection the source was loaded from. After an app
/// restart a saved source is rebuilt from its stored credentials, but only
/// while the saved entry still points at that same connection.
async fn resolve_session(
    app: &tauri::AppHandle,
    source_identity: &str,
    connection: &str,
) -> Result<Arc<DispatcharrClient>, AppError> {
    if let Some(client) = get_session(connection) {
        return Ok(client);
    }
    if let Some(saved_id) = source_identity.strip_prefix("saved:") {
        if let Some(SavedPlaylistSource::Dispatcharr {
            server,
            username,
            password,
            api_key,
        }) = crate::commands::saved::saved_playlist_by_id(app, saved_id)?.map(|e| e.source)
        {
            let base = normalize_dispatcharr_server(&server)?;
            let auth = DispatcharrAuth::from_parts(
                username.as_deref(),
                password.as_deref(),
                api_key.as_deref(),
            )?;
            if build_dispatcharr_source_key(&base, &auth) != connection {
                return Err(AppError::State(
                    "This saved Dispatcharr source now points elsewhere. Reload it to sync."
                        .to_string(),
                ));
            }
            let accept_invalid_certs = app
                .state::<Arc<AppState>>()
                .settings
                .lock()
                .await
                .accept_invalid_certs;
            let client = Arc::new(DispatcharrClient::new(base, auth, accept_invalid_certs)?);
            register_session(connection, Arc::clone(&client));
            return Ok(client);
        }
    }
    Err(AppError::State(
        "Not connected to Dispatcharr. Reload the source to sync.".to_string(),
    ))
}

#[derive(Debug, Serialize)]
pub struct DispatcharrItemFailure {
    pub id: i64,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct DispatcharrStatsPushReport {
    pub updated: Vec<i64>,
    pub failed: Vec<DispatcharrItemFailure>,
    /// Results that were not alive, had no Dispatcharr IDs, or no stats.
    pub skipped: usize,
    /// Dispatcharr accepted the first write but did not store the stats.
    /// Later releases may make `stream_stats` read-only; nothing else is sent.
    pub rejected: bool,
}

/// Alive results with Dispatcharr IDs and at least one stat, one per stream.
fn collect_stream_stats(results: &[ChannelResult]) -> (Vec<StatsUpdate>, usize) {
    let mut seen = HashSet::new();
    let mut updates = Vec::new();
    let mut skipped = 0;
    for result in results {
        let stream_id = (result.status == ChannelStatus::Alive)
            .then(|| dispatcharr_ids_from_extinf(&result.extinf_line))
            .flatten()
            .map(|ids| ids.stream_id);
        let stats = stream_stats_from_result(result);
        match stream_id {
            Some(stream_id) if !stats.is_empty() => {
                if seen.insert(stream_id) {
                    updates.push((stream_id, stats));
                }
            }
            _ => skipped += 1,
        }
    }
    (updates, skipped)
}

#[tauri::command]
pub async fn dispatcharr_push_stream_stats(
    app: tauri::AppHandle,
    source_identity: String,
    connection: String,
    results: Vec<ChannelResult>,
) -> Result<DispatcharrStatsPushReport, AppError> {
    // One push per connection at a time, across windows, so an older scan's
    // writes never land after a newer one's.
    let push_lock = {
        type Locks = HashMap<String, Arc<tokio::sync::Mutex<()>>>;
        static LOCKS: std::sync::OnceLock<std::sync::Mutex<Locks>> = std::sync::OnceLock::new();
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(locks.entry(connection.clone()).or_default())
    };
    let _pushing = push_lock.lock().await;
    let client = resolve_session(&app, &source_identity, &connection).await?;
    let (updates, skipped) = collect_stream_stats(&results);
    let mut report = DispatcharrStatsPushReport {
        skipped,
        ..Default::default()
    };
    if updates.is_empty() {
        return Ok(report);
    }

    let updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut pending = updates.into_iter();

    // Verify that a write sticks before sending the rest; a failed write
    // proves nothing, so keep probing until one succeeds.
    for (stream_id, stats) in pending.by_ref() {
        match client
            .write_stream_stats(stream_id, &stats, &updated_at)
            .await
        {
            Ok(stored) if stats_stuck(stored.as_ref(), &stats) => {
                report.updated.push(stream_id);
                break;
            }
            Ok(_) => {
                report.rejected = true;
                return Ok(report);
            }
            Err(error) => report.failed.push(DispatcharrItemFailure {
                id: stream_id,
                error: error.to_string(),
            }),
        }
    }

    let client = &client;
    let updated_at = updated_at.as_str();
    let outcomes = stream::iter(pending)
        .map(|(stream_id, stats)| async move {
            (
                stream_id,
                client
                    .write_stream_stats(stream_id, &stats, updated_at)
                    .await,
            )
        })
        .buffer_unordered(STATS_PUSH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for (stream_id, outcome) in outcomes {
        match outcome {
            Ok(_) => report.updated.push(stream_id),
            Err(error) => report.failed.push(DispatcharrItemFailure {
                id: stream_id,
                error: error.to_string(),
            }),
        }
    }
    Ok(report)
}

fn validate_stream_list(stream_ids: &[i64], allow_empty: bool) -> Result<(), AppError> {
    if stream_ids.is_empty() && !allow_empty {
        return Err(AppError::Validation(
            "Refusing to remove every stream from a channel".to_string(),
        ));
    }
    let mut seen = HashSet::new();
    if let Some(duplicate) = stream_ids.iter().find(|id| !seen.insert(**id)) {
        return Err(AppError::Validation(format!(
            "Stream {} is listed twice",
            duplicate
        )));
    }
    Ok(())
}

/// Replace a channel's streams with `stream_ids`, in order. This must be the
/// complete intended list: Dispatcharr unlinks every stream left out.
#[tauri::command]
pub async fn dispatcharr_set_channel_streams(
    app: tauri::AppHandle,
    source_identity: String,
    connection: String,
    channel_id: i64,
    stream_ids: Vec<i64>,
    allow_empty: Option<bool>,
    expected: Option<Vec<i64>>,
) -> Result<Vec<i64>, AppError> {
    validate_stream_list(&stream_ids, allow_empty.unwrap_or(false))?;
    let client = resolve_session(&app, &source_identity, &connection).await?;
    // Check and write as one step per channel, across windows: an edit made
    // meanwhile (here or in Dispatcharr) is refused, never overwritten.
    let channel_lock = {
        type Locks = HashMap<String, Arc<tokio::sync::Mutex<()>>>;
        static LOCKS: std::sync::OnceLock<std::sync::Mutex<Locks>> = std::sync::OnceLock::new();
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(
            locks
                .entry(format!("{}#{}", connection, channel_id))
                .or_default(),
        )
    };
    let _writing = channel_lock.lock().await;
    if let Some(expected) = expected {
        let current = client.fetch_channel(channel_id).await?.ok_or_else(|| {
            AppError::Other("Channel no longer exists in Dispatcharr".to_string())
        })?;
        if current.streams != expected {
            return Err(AppError::Other(
                "Changed in Dispatcharr. Reload first.".to_string(),
            ));
        }
    }
    let stored = client.set_channel_streams(channel_id, &stream_ids).await?;
    if stored != stream_ids {
        return Err(AppError::Other(format!(
            "Dispatcharr stored a different stream order for channel {}",
            channel_id
        )));
    }
    Ok(stored)
}

/// A provider stream offered for a channel, as the row it would load as.
#[derive(Debug, Serialize)]
pub struct DispatcharrCandidate {
    pub(crate) channel: Channel,
    pub(crate) stream_id: i64,
    #[serde(flatten)]
    pub(crate) matched: CandidateMatch,
}

/// Provider streams that could be linked to a channel, best match first.
/// `query` replaces the channel name as the search text.
#[tauri::command]
pub async fn dispatcharr_find_streams(
    app: tauri::AppHandle,
    source_identity: String,
    connection: String,
    channel_id: i64,
    query: Option<String>,
) -> Result<Vec<DispatcharrCandidate>, AppError> {
    let client = resolve_session(&app, &source_identity, &connection).await?;
    let channel = client
        .fetch_channel(channel_id)
        .await?
        .ok_or_else(|| AppError::Other("Channel no longer exists in Dispatcharr".to_string()))?;
    let found = client
        .find_candidate_streams(&channel, query.as_deref())
        .await?;
    let accounts = client
        .fetch_m3u_accounts()
        .await
        .inspect_err(|error| log::warn!("[dispatcharr] M3U account fetch failed: {}", error))
        .unwrap_or_default()
        .into_iter()
        .map(|account| (account.id, account))
        .collect::<HashMap<_, _>>();
    // Build the rows the loader would, so probes respect account limits and
    // linked streams read like loaded ones.
    let listing = DispatcharrChannel {
        streams: found.iter().map(|(stream, _)| stream.id).collect(),
        ..channel
    };
    let mut matches = HashMap::new();
    let mut streams = HashMap::new();
    for (stream, matched) in found {
        matches.insert(stream.id, matched);
        streams.insert(stream.id, stream);
    }
    let m3u = build_m3u(
        client.base(),
        &[listing],
        &streams,
        &HashMap::new(),
        &accounts,
    );
    let preview =
        crate::engine::parser::parse_m3u(m3u.as_bytes(), "dispatcharr-candidates", &None, &None)?;
    Ok(preview
        .channels
        .into_iter()
        .filter_map(|channel| {
            let stream_id = dispatcharr_ids_from_extinf(&channel.extinf_line)?.stream_id;
            let matched = matches.remove(&stream_id)?;
            Some(DispatcharrCandidate {
                channel,
                stream_id,
                matched,
            })
        })
        .collect())
}

/// Ask Dispatcharr to re-fetch a provider account's playlist.
#[tauri::command]
pub async fn dispatcharr_refresh_account(
    app: tauri::AppHandle,
    source_identity: String,
    connection: String,
    account_id: i64,
) -> Result<(), AppError> {
    let client = resolve_session(&app, &source_identity, &connection).await?;
    client.refresh_m3u_account(account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(status: ChannelStatus, extinf: &str, codec: Option<&str>) -> ChannelResult {
        let mut result: ChannelResult = serde_json::from_value(serde_json::json!({
            "index": 0, "playlist": "p", "name": "n", "group": "g", "url": "http://x/1.ts",
            "status": "alive", "codec": codec, "resolution": null, "width": null,
            "height": null, "fps": null, "latency_ms": null, "video_bitrate": null,
            "audio_bitrate": null, "audio_codec": null, "screenshot_path": null,
            "label_mismatches": [], "low_framerate": false, "error_message": null,
            "channel_id": "1", "extinf_line": extinf, "metadata_lines": [],
            "stream_url": null
        }))
        .unwrap();
        result.status = status;
        result
    }

    #[test]
    fn collects_alive_results_with_ids_once_per_stream() {
        let ids = r#"#EXTINF:-1 x-dispatcharr-channel-id="1" x-dispatcharr-stream-id="9",N"#;
        let (updates, skipped) = collect_stream_stats(&[
            result(ChannelStatus::Alive, ids, Some("h264")),
            // The same provider stream linked from a second channel.
            result(ChannelStatus::Alive, ids, Some("h264")),
            result(ChannelStatus::Dead, ids, Some("h264")),
            result(ChannelStatus::Alive, ids, None),
            result(ChannelStatus::Alive, "#EXTINF:-1,Plain", Some("h264")),
        ]);
        assert_eq!(
            updates.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![9]
        );
        assert_eq!(skipped, 3);
    }

    #[test]
    fn stream_lists_must_be_non_empty_and_unique() {
        assert!(validate_stream_list(&[], false).is_err());
        assert!(validate_stream_list(&[], true).is_ok());
        assert!(validate_stream_list(&[1, 2, 1], false).is_err());
        assert!(validate_stream_list(&[2, 1], false).is_ok());
    }
}
