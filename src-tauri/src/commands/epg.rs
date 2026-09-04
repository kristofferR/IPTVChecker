use std::collections::HashSet;
use std::io::Read;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

use crate::engine::epg::{self, EpgIndex, EpgProgramme};
use crate::error::AppError;
use crate::state::AppState;

const MAX_EPG_SOURCES_PER_LOAD: usize = 32;

struct CancellableReader<R> {
    inner: R,
    cancel: CancellationToken,
}

impl<R: Read> Read for CancellableReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            // Not `Interrupted`: BufReader and the XML parser retry that kind
            // forever, which kept a superseded load spinning while holding
            // the load lock.
            return Err(std::io::Error::other("EPG load superseded"));
        }
        self.inner.read(buffer)
    }
}

fn superseded_error() -> AppError {
    AppError::Other("EPG load superseded".to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct EpgLoadSummary {
    pub sources_requested: usize,
    pub sources_loaded: usize,
    pub failed_sources: Vec<String>,
    pub channels_matched: usize,
    pub programme_count: usize,
}

fn epg_cache_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("iptv-checker"))
        .join("epg")
}

/// Download and index the given XMLTV sources, keeping only programmes for
/// the supplied tvg-ids. Replaces the app-wide EPG index.
#[tauri::command]
pub async fn load_epg(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    sources: Vec<String>,
    tvg_ids: Vec<String>,
    force_refresh: bool,
) -> Result<EpgLoadSummary, AppError> {
    if sources.len() > MAX_EPG_SOURCES_PER_LOAD {
        return Err(AppError::Other(format!(
            "EPG source count exceeds the limit of {MAX_EPG_SOURCES_PER_LOAD}"
        )));
    }

    let cancel = {
        let mut current = state.epg_load_cancel.lock().await;
        current.cancel();
        *current = CancellationToken::new();
        current.clone()
    };
    let _guard = tokio::select! {
        _ = cancel.cancelled() => return Err(superseded_error()),
        guard = state.epg_load_lock.lock() => guard,
    };
    let sources_requested = sources.len();
    let wanted: HashSet<String> = tvg_ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect();
    if wanted.is_empty() {
        *state.epg.lock().await = Some(Arc::new(EpgIndex::default()));
        return Ok(EpgLoadSummary {
            sources_requested,
            sources_loaded: 0,
            failed_sources: Vec::new(),
            channels_matched: 0,
            programme_count: 0,
        });
    }

    let accept_invalid_certs = state.settings.lock().await.accept_invalid_certs;
    let cache_dir = epg_cache_dir(&app);

    let mut index = EpgIndex::default();
    let mut failed_sources = Vec::new();
    let mut failed_source_ids = HashSet::new();
    let mut loaded_source_ids = HashSet::new();
    let mut sources_loaded = 0usize;

    for source in sources {
        if cancel.is_cancelled() {
            return Err(superseded_error());
        }
        let outcome = async {
            let path = epg::download_epg_source(
                &source,
                &cache_dir,
                accept_invalid_certs,
                force_refresh,
                &cancel,
            )
            .await?;
            let wanted = wanted.clone();
            let source_identity = source.clone();
            let parse_path = path.clone();
            let parse_cancel = cancel.clone();
            let parse_result = match tokio::task::spawn_blocking(move || {
                let mut partial = EpgIndex::default();
                let reader = epg::open_guide_file(&parse_path)?;
                epg::parse_xmltv_into_with_source(
                    CancellableReader {
                        inner: reader,
                        cancel: parse_cancel,
                    },
                    &wanted,
                    &source_identity,
                    &mut partial,
                )?;
                Ok::<EpgIndex, AppError>(partial)
            })
            .await
            {
                Ok(result) => result,
                Err(error) => Err(AppError::Other(format!("EPG parse task failed: {error}"))),
            };
            if cancel.is_cancelled() {
                return Err(superseded_error());
            }
            if parse_result.is_err() {
                let _ = std::fs::remove_file(path);
            }
            parse_result
        }
        .await;

        if cancel.is_cancelled() {
            return Err(superseded_error());
        }
        match outcome {
            Ok(partial) => {
                index.merge(partial);
                loaded_source_ids.insert(source);
                sources_loaded += 1;
            }
            Err(error) => {
                failed_source_ids.insert(source.clone());
                let redacted_source = epg::redact_epg_source(&source);
                log::warn!("EPG source {redacted_source} failed: {error}");
                failed_sources.push(redacted_source);
            }
        }
    }

    if cancel.is_cancelled() {
        return Err(superseded_error());
    }

    if sources_loaded > 0 {
        failed_source_ids.retain(|source| !loaded_source_ids.contains(source));
        if !failed_source_ids.is_empty() {
            let previous = state.epg.lock().await.clone();
            if let Some(previous) = previous {
                index.merge_sources_from(&previous, &failed_source_ids, &wanted);
            }
        }
    }

    let retained_index = if sources_requested > 0 && sources_loaded == 0 {
        state.epg.lock().await.clone()
    } else {
        None
    };
    let summary_index = retained_index.as_deref().unwrap_or(&index);
    let summary = EpgLoadSummary {
        sources_requested,
        sources_loaded,
        failed_sources,
        channels_matched: summary_index.matched_channel_count(&tvg_ids),
        programme_count: summary_index.programme_count(),
    };
    log::info!(
        "EPG loaded: {} sources, {} channels, {} programmes",
        summary.sources_loaded,
        summary.channels_matched,
        summary.programme_count
    );
    if sources_requested == 0 || sources_loaded > 0 {
        *state.epg.lock().await = Some(Arc::new(index));
    } else {
        log::warn!("All EPG sources failed; retaining the previously loaded guide");
    }
    Ok(summary)
}

#[tauri::command]
pub async fn cancel_epg_load(state: tauri::State<'_, Arc<AppState>>) -> Result<(), AppError> {
    state.epg_load_cancel.lock().await.cancel();
    Ok(())
}

/// Programmes for one channel overlapping `[from, to)` (epoch seconds).
#[tauri::command]
pub async fn get_epg_programmes(
    state: tauri::State<'_, Arc<AppState>>,
    sources: Vec<String>,
    tvg_id: String,
    from: i64,
    to: i64,
) -> Result<Vec<EpgProgramme>, AppError> {
    let index = state.epg.lock().await.clone();
    Ok(index
        .map(|index| index.programmes_for_sources(&sources, &tvg_id, from, to))
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    #[test]
    fn cancelled_reader_fails_instead_of_retrying() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut reader = std::io::BufReader::new(CancellableReader {
            inner: std::io::Cursor::new(b"<tv></tv>".to_vec()),
            cancel,
        });
        let error = reader.fill_buf().err().expect("cancelled read must fail");
        assert_ne!(error.kind(), std::io::ErrorKind::Interrupted);
    }
}
