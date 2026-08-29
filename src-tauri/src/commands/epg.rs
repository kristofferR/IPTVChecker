use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;

use crate::engine::epg::{self, EpgIndex, EpgProgramme};
use crate::error::AppError;
use crate::state::AppState;

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
    let _guard = state.epg_load_lock.lock().await;
    let accept_invalid_certs = state.settings.lock().await.accept_invalid_certs;
    let cache_dir = epg_cache_dir(&app);
    let wanted: HashSet<String> = tvg_ids.into_iter().filter(|id| !id.is_empty()).collect();

    let sources_requested = sources.len();
    let mut index = EpgIndex::default();
    let mut failed_sources = Vec::new();
    let mut sources_loaded = 0usize;

    for source in sources {
        let outcome = async {
            let path =
                epg::download_epg_source(&source, &cache_dir, accept_invalid_certs, force_refresh)
                    .await?;
            let wanted = wanted.clone();
            tokio::task::spawn_blocking(move || {
                let mut partial = EpgIndex::default();
                let reader = epg::open_guide_file(&path)?;
                epg::parse_xmltv_into(reader, &wanted, &mut partial)?;
                Ok::<EpgIndex, AppError>(partial)
            })
            .await
            .map_err(|error| AppError::Other(format!("EPG parse task failed: {error}")))?
        }
        .await;

        match outcome {
            Ok(partial) => {
                index.merge(partial);
                sources_loaded += 1;
            }
            Err(error) => {
                log::warn!("EPG source {source} failed: {error}");
                failed_sources.push(source);
            }
        }
    }

    let summary = EpgLoadSummary {
        sources_requested,
        sources_loaded,
        failed_sources,
        channels_matched: index.channel_count(),
        programme_count: index.programme_count(),
    };
    log::info!(
        "EPG loaded: {} sources, {} channels, {} programmes",
        summary.sources_loaded,
        summary.channels_matched,
        summary.programme_count
    );
    *state.epg.lock().await = Some(Arc::new(index));
    Ok(summary)
}

/// Programmes for one channel overlapping `[from, to)` (epoch seconds).
#[tauri::command]
pub async fn get_epg_programmes(
    state: tauri::State<'_, Arc<AppState>>,
    tvg_id: String,
    from: i64,
    to: i64,
) -> Result<Vec<EpgProgramme>, AppError> {
    let index = state.epg.lock().await.clone();
    Ok(index
        .map(|index| index.programmes_for(&tvg_id, from, to))
        .unwrap_or_default())
}
