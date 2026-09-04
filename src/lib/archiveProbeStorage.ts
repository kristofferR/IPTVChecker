import type { ArchiveProbeEntry } from "./archiveProbe";
import type { ChannelResult, PlaylistPreview } from "./types";

// Verification verdicts survive reopening a playlist. Entries are stored with
// the channel URL they were measured for, so a re-downloaded list whose
// indices shifted never shows another channel's verdict.

const STORAGE_PREFIX = "catchup-verdicts:";
const MAX_STORED_BYTES = 2 * 1024 * 1024;

interface StoredProbe {
  url: string;
  entry: ArchiveProbeEntry;
}

export function archiveProbeStorageKey(
  playlist: Pick<PlaylistPreview, "source_identity" | "file_path">,
): string {
  return `${STORAGE_PREFIX}${playlist.source_identity ?? playlist.file_path}`;
}

/** Persist completed probe entries for the playlist; skips oversized sets. */
export function saveArchiveProbes(
  key: string,
  probes: Record<number, ArchiveProbeEntry>,
  results: Pick<ChannelResult, "index" | "url">[],
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): void {
  const urlByIndex = new Map(results.map((result) => [result.index, result.url]));
  const stored: Record<string, StoredProbe> = {};
  for (const [index, entry] of Object.entries(probes)) {
    const url = urlByIndex.get(Number(index));
    if (!url || entry.running || entry.checkedAt == null) continue;
    stored[index] = { url, entry };
  }
  try {
    if (Object.keys(stored).length === 0) {
      storage.removeItem(key);
      return;
    }
    const json = JSON.stringify(stored);
    if (json.length > MAX_STORED_BYTES) return;
    storage.setItem(key, json);
  } catch {
    // Quota or serialization failure: verdicts simply do not persist.
  }
}

/** Restore stored entries whose channel URL still matches the loaded list. */
export function loadArchiveProbes(
  key: string,
  results: Pick<ChannelResult, "index" | "url">[],
  storage: Pick<Storage, "getItem"> = localStorage,
): Record<number, ArchiveProbeEntry> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: Record<string, StoredProbe>;
  try {
    parsed = JSON.parse(raw) as Record<string, StoredProbe>;
  } catch {
    return null;
  }
  const restored: Record<number, ArchiveProbeEntry> = {};
  for (const result of results) {
    const stored = parsed[String(result.index)];
    if (stored?.url === result.url && Array.isArray(stored.entry?.outcomes)) {
      restored[result.index] = { ...stored.entry, running: false };
    }
  }
  return Object.keys(restored).length > 0 ? restored : null;
}
