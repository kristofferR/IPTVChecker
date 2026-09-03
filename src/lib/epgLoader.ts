import { useAppStore } from "../store";
import { hasArchive } from "./archive";
import { logger } from "./logger";
import { getEpgProgrammes, loadEpg } from "./tauri";
import type { ChannelResult, EpgLoadSummary, EpgProgramme } from "./types";

// Shared by the sidebar Archive card and the Guide view so one XMLTV download
// backs both surfaces; provider guides run to hundreds of megabytes.
let epgLoad: {
  key: string;
  promise: Promise<void>;
  summary: EpgLoadSummary | null;
  loadedAt: number | null;
} | null = null;
const EPG_LOAD_TTL_MS = 6 * 60 * 60 * 1_000;

function epgLoadRequest() {
  const state = useAppStore.getState();
  const sources = state.playlist?.epg_sources ?? [];
  const tvgIds = state.flatResults
    .filter(hasArchive)
    .map((result) => result.tvg_id)
    .filter((id): id is string => !!id)
    .sort();
  const key = JSON.stringify([
    state.playlist?.source_identity ?? state.playlist?.file_path ?? "",
    sources,
    tvgIds,
  ]);
  return { key, sources, tvgIds };
}

export function ensureEpgLoaded(): Promise<void> {
  const { key, sources, tvgIds } = epgLoadRequest();
  if (
    epgLoad?.key === key &&
    (epgLoad.loadedAt == null || Date.now() - epgLoad.loadedAt < EPG_LOAD_TTL_MS)
  ) {
    if (epgLoad.summary) {
      useAppStore.getState().setEpgLoadSummary(epgLoad.summary);
    }
    return epgLoad.promise;
  }
  const promise = loadEpg(sources, tvgIds).then(
    (summary) => {
      if (epgLoad?.key !== key || epgLoadRequest().key !== key) {
        return;
      }
      epgLoad.summary = summary;
      epgLoad.loadedAt = Date.now();
      useAppStore.getState().setEpgLoadSummary(summary);
      logger.info(
        "[EPG] Loaded",
        summary.programme_count,
        "programmes for",
        summary.channels_matched,
        "channels",
      );
      if (summary.failed_sources.length > 0) {
        logger.warn("[EPG] Some sources failed to load:", summary.failed_sources.length);
        if (summary.sources_loaded === 0 && epgLoad?.key === key) {
          epgLoad = null;
        }
      }
    },
    (error) => {
      if (epgLoad?.key !== key || epgLoadRequest().key !== key) {
        return;
      }
      logger.warn("[EPG] Load failed:", error);
      if (epgLoad?.key === key) {
        epgLoad = null;
      }
    },
  );
  epgLoad = { key, promise, summary: null, loadedAt: null };
  return promise;
}

/** EPG sources for a channel: its own playlist's, falling back to the set. */
export function epgSourcesFor(result: ChannelResult): string[] {
  const playlist = useAppStore.getState().playlist;
  return playlist?.epg_sources_by_playlist[result.playlist] ?? playlist?.epg_sources ?? [];
}

/** Programmes for one channel in a window, after the guide has loaded. */
export function fetchGuideProgrammes(
  result: ChannelResult,
  from: number,
  to: number,
): Promise<EpgProgramme[]> {
  if (!result.tvg_id) {
    return Promise.resolve([]);
  }
  const tvgId = result.tvg_id;
  return ensureEpgLoaded()
    .then(() => getEpgProgrammes(epgSourcesFor(result), tvgId, from, to))
    .catch(() => [] as EpgProgramme[]);
}
