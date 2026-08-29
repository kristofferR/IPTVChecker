import { useAppStore } from "../store";
import { hasArchive } from "./archive";
import { logger } from "./logger";
import { getEpgProgrammes, loadEpg } from "./tauri";
import type { EpgProgramme } from "./types";

// The EPG download can be hundreds of MB, so it loads lazily the first time a
// catch-up surface opens, once per playlist+sources combination.
let epgLoad: { key: string; promise: Promise<void> } | null = null;
// Programme window cache; invalidated together with the load key.
let programmeCache = new Map<string, Promise<EpgProgramme[]>>();

function currentEpgKey(): string | null {
  const state = useAppStore.getState();
  const sources = state.playlist?.epg_sources ?? [];
  if (sources.length === 0) {
    return null;
  }
  return `${state.playlist?.source_identity ?? state.playlist?.file_path ?? ""}|${sources.join(",")}`;
}

export function ensureEpgLoaded(): Promise<void> {
  const key = currentEpgKey();
  if (key == null) {
    return Promise.resolve();
  }
  if (epgLoad?.key === key) {
    return epgLoad.promise;
  }
  const state = useAppStore.getState();
  const tvgIds = [
    ...new Set(
      state.flatResults
        .filter(hasArchive)
        .map((result) => result.tvg_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const promise = loadEpg(state.playlist?.epg_sources ?? [], tvgIds).then(
    (summary) => {
      useAppStore.getState().setEpgLoadSummary(summary);
      logger.info(
        "[EPG] Loaded",
        summary.programme_count,
        "programmes for",
        summary.channels_matched,
        "channels",
      );
    },
    (error) => {
      logger.warn("[EPG] Load failed:", error);
    },
  );
  epgLoad = { key, promise };
  programmeCache = new Map();
  return promise;
}

/** Programmes for one channel in a window, deduped across concurrent callers. */
export function fetchGuideProgrammes(
  tvgId: string,
  from: number,
  to: number,
): Promise<EpgProgramme[]> {
  const cacheKey = `${tvgId}|${from}|${to}`;
  const cached = programmeCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = ensureEpgLoaded()
    .then(() => getEpgProgrammes(tvgId, from, to))
    .catch(() => [] as EpgProgramme[]);
  programmeCache.set(cacheKey, promise);
  return promise;
}
