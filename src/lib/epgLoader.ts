import { useAppStore } from "../store";
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

// Every guide row asks for the load key on mount; deriving it means walking
// tens of thousands of results, so it is cached per results array identity.
let requestCache: {
  playlist: unknown;
  results: unknown;
  value: { key: string; sources: string[]; tvgIds: string[] };
} | null = null;

function epgLoadRequest() {
  const state = useAppStore.getState();
  if (
    requestCache &&
    requestCache.playlist === state.playlist &&
    requestCache.results === state.flatResults
  ) {
    return requestCache.value;
  }
  const sources = state.playlist?.epg_sources ?? [];
  // The guide lists every channel, so the index must cover all of them.
  const tvgIds = Array.from(
    new Set(
      state.flatResults
        .filter((result) => result.content_type === "live")
        .map((result) => result.tvg_id)
        .filter((id): id is string => !!id),
    ),
  ).sort();
  const key = JSON.stringify([
    state.playlist?.source_identity ?? state.playlist?.file_path ?? "",
    sources,
    tvgIds,
  ]);
  const value = { key, sources, tvgIds };
  requestCache = { playlist: state.playlist, results: state.flatResults, value };
  return value;
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
      throw error;
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

// Guide rows unmount and remount while scrolling; answering repeats from
// memory avoids an IPC round trip per row. Scoped to the current load.
const PROGRAMME_CACHE_LIMIT = 4000;
let programmeCache: { loadKey: string; entries: Map<string, EpgProgramme[]> } | null = null;

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
    .then(async () => {
      const loadKey = epgLoadRequest().key;
      if (programmeCache?.loadKey !== loadKey) {
        programmeCache = { loadKey, entries: new Map() };
      }
      const cacheKey = `${result.playlist}\u0000${tvgId}\u0000${from}\u0000${to}`;
      const cached = programmeCache.entries.get(cacheKey);
      if (cached) return cached;
      const programmes = await getEpgProgrammes(epgSourcesFor(result), tvgId, from, to);
      if (programmeCache.entries.size >= PROGRAMME_CACHE_LIMIT) {
        programmeCache.entries.clear();
      }
      programmeCache.entries.set(cacheKey, programmes);
      return programmes;
    })
    .catch(() => [] as EpgProgramme[]);
}
