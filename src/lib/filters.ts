import { archiveSortValue, hasArchive } from "./archive";
import type { ArchiveProbeEntry } from "./archiveProbe";
import { type ArchiveVerdict, archiveVerdict } from "./archiveVerification";
import { getChannelErrorReason } from "./channelResults";
import type { ChannelResult, ChannelStatus } from "./types";

export type ArchiveProbes = Record<number, ArchiveProbeEntry>;

/** Status-filter values that select catch-up channels by verification verdict. */
export const CATCHUP_VERDICT_FILTERS: Record<string, ArchiveVerdict> = {
  catchup_real: "verified",
  catchup_shallower: "shallower",
  catchup_fake: "fake",
  catchup_untested: "advertised",
};

export function isCatchupStatusFilter(statusFilter: string): boolean {
  return statusFilter === "catchup" || statusFilter in CATCHUP_VERDICT_FILTERS;
}

export type SortField =
  | "index"
  | "playlist"
  | "name"
  | "url"
  | "group"
  | "status"
  | "resolution"
  | "codec"
  | "hdr"
  | "fps"
  | "latency"
  | "bitrate"
  | "audio"
  | "audio_codec"
  | "audio_layout"
  | "catchup"
  | "error";

export type SortDirection = "asc" | "desc";

export type SearchTextCache = WeakMap<ChannelResult, string>;

export interface StatusOptionCounts {
  [key: string]: number;
  all: number;
  alive: number;
  drm: number;
  dead: number;
  placeholder: number;
  geoblocked: number;
  mislabeled: number;
  audio_only: number;
  duplicates: number;
  pending: number;
  catchup: number;
  catchup_real: number;
  catchup_shallower: number;
  catchup_fake: number;
  catchup_untested: number;
}

const STATUS_ORDER: Record<ChannelStatus, number> = {
  alive: 0,
  drm: 1,
  geoblocked: 2,
  geoblocked_confirmed: 2,
  geoblocked_unconfirmed: 2,
  placeholder: 2.5,
  dead: 3,
  checking: 4,
  pending: 5,
};

function parseBitrateKbps(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/\d+(\.\d+)?/);
  if (!match) return null;

  const numeric = Number.parseFloat(match[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseAudioLayout(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "stereo") return 2;
  if (trimmed === "mono") return 1;

  const numeric = trimmed.endsWith(" ch")
    ? Number.parseFloat(trimmed.slice(0, -3))
    : Number.parseFloat(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function compareOptionalNumber(
  left: number | null,
  right: number | null,
  dir: 1 | -1,
  leftIndex: number,
  rightIndex: number,
): number {
  if (left == null && right == null) {
    return (leftIndex - rightIndex) * dir;
  }
  if (left == null) return 1;
  if (right == null) return -1;
  if (left === right) {
    return (leftIndex - rightIndex) * dir;
  }
  return (left - right) * dir;
}

function compareOptionalText(
  left: string | null | undefined,
  right: string | null | undefined,
  dir: 1 | -1,
  leftIndex: number,
  rightIndex: number,
): number {
  const leftValue = left?.trim() || null;
  const rightValue = right?.trim() || null;

  if (leftValue == null && rightValue == null) {
    return (leftIndex - rightIndex) * dir;
  }
  if (leftValue == null) return 1;
  if (rightValue == null) return -1;

  const compared = leftValue.localeCompare(rightValue) * dir;
  if (compared === 0) {
    return (leftIndex - rightIndex) * dir;
  }
  return compared;
}

function getSearchHaystack(result: ChannelResult, searchTextCache?: SearchTextCache): string {
  let haystack = searchTextCache?.get(result);
  if (!haystack) {
    haystack = `${result.name}\n${result.playlist}\n${result.group}`.toLowerCase();
    searchTextCache?.set(result, haystack);
  }
  return haystack;
}

function matchesBaseFilters(
  result: ChannelResult,
  normalizedSearch: string,
  hasSearch: boolean,
  groupFilter: string,
  hasGroupFilter: boolean,
  searchTextCache?: SearchTextCache,
): boolean {
  if (hasSearch) {
    const haystack = getSearchHaystack(result, searchTextCache);
    if (!haystack.includes(normalizedSearch)) {
      return false;
    }
  }

  if (hasGroupFilter && result.group !== groupFilter) {
    return false;
  }

  return true;
}

function matchesStatusFilter(
  result: ChannelResult,
  statusFilter: string,
  duplicateIndices?: Set<number>,
  separatePlaceholder?: boolean,
  archiveProbes?: ArchiveProbes,
): boolean {
  if (statusFilter === "" || statusFilter === "all") {
    return true;
  }
  if (statusFilter === "duplicates") {
    return duplicateIndices?.has(result.index) ?? false;
  }
  if (statusFilter === "audio_only") {
    return result.audio_only;
  }
  if (statusFilter === "catchup") {
    return hasArchive(result);
  }
  const verdictFilter = CATCHUP_VERDICT_FILTERS[statusFilter];
  if (verdictFilter) {
    return (
      hasArchive(result) && archiveVerdict(result, archiveProbes?.[result.index]) === verdictFilter
    );
  }
  if (statusFilter === "mislabeled") {
    return result.label_mismatches.length > 0;
  }
  if (statusFilter === "geoblocked") {
    return (
      result.status === "geoblocked" ||
      result.status === "geoblocked_confirmed" ||
      result.status === "geoblocked_unconfirmed"
    );
  }
  if (statusFilter === "dead" && !separatePlaceholder) {
    return result.status === "dead" || result.status === "placeholder";
  }
  return result.status === statusFilter;
}

export function sortResults(
  results: ChannelResult[],
  field: SortField,
  direction: SortDirection,
): ChannelResult[] {
  if (results.length <= 1) {
    return results;
  }

  if (field === "index") {
    if (direction === "asc") {
      return results;
    }
    return [...results].reverse();
  }

  const sorted = [...results];
  const dir = direction === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    switch (field) {
      case "playlist":
        return a.playlist.localeCompare(b.playlist) * dir;
      case "name":
        return a.name.localeCompare(b.name) * dir;
      case "url":
        return a.url.localeCompare(b.url) * dir;
      case "group":
        return a.group.localeCompare(b.group) * dir;
      case "status":
        return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * dir;
      case "resolution": {
        const resOrder: Record<string, number> = {
          "4K": 0,
          "1080p": 1,
          "720p": 2,
          SD: 3,
          Unknown: 4,
        };
        const aVal = resOrder[a.resolution ?? "Unknown"] ?? 4;
        const bVal = resOrder[b.resolution ?? "Unknown"] ?? 4;
        return (aVal - bVal) * dir;
      }
      case "codec":
        return (a.codec ?? "").localeCompare(b.codec ?? "") * dir;
      case "hdr":
        return compareOptionalText(a.hdr_format, b.hdr_format, dir, a.index, b.index);
      case "fps":
        return ((a.fps ?? 0) - (b.fps ?? 0)) * dir;
      case "latency": {
        const aLatency = a.latency_ms;
        const bLatency = b.latency_ms;
        if (aLatency == null && bLatency == null) {
          return (a.index - b.index) * dir;
        }
        if (aLatency == null) return 1;
        if (bLatency == null) return -1;
        if (aLatency === bLatency) {
          return (a.index - b.index) * dir;
        }
        return (aLatency - bLatency) * dir;
      }
      case "bitrate":
        return compareOptionalNumber(
          parseBitrateKbps(a.video_bitrate),
          parseBitrateKbps(b.video_bitrate),
          dir,
          a.index,
          b.index,
        );
      case "audio":
        return compareOptionalNumber(
          parseBitrateKbps(a.audio_bitrate),
          parseBitrateKbps(b.audio_bitrate),
          dir,
          a.index,
          b.index,
        );
      case "audio_codec":
        return (a.audio_codec ?? "").localeCompare(b.audio_codec ?? "") * dir;
      case "audio_layout":
        return compareOptionalNumber(
          parseAudioLayout(a.audio_channel_layout),
          parseAudioLayout(b.audio_channel_layout),
          dir,
          a.index,
          b.index,
        );
      case "catchup":
        return compareOptionalNumber(
          archiveSortValue(a),
          archiveSortValue(b),
          dir,
          a.index,
          b.index,
        );
      case "error":
        return compareOptionalText(
          getChannelErrorReason(a),
          getChannelErrorReason(b),
          dir,
          a.index,
          b.index,
        );
      default:
        return 0;
    }
  });

  return sorted;
}

export function filterResults(
  results: ChannelResult[],
  search: string,
  groupFilter: string,
  statusFilter: string,
  duplicateIndices?: Set<number>,
  searchTextCache?: SearchTextCache,
  separatePlaceholder?: boolean,
  archiveProbes?: ArchiveProbes,
): ChannelResult[] {
  const normalizedSearch = search.trim().toLowerCase();
  const hasSearch = normalizedSearch.length > 0;
  const hasGroupFilter = groupFilter !== "" && groupFilter !== "all";
  const hasStatusFilter = statusFilter !== "" && statusFilter !== "all";

  if (!hasSearch && !hasGroupFilter && !hasStatusFilter) {
    return results;
  }

  return results.filter((r) => {
    if (
      !matchesBaseFilters(
        r,
        normalizedSearch,
        hasSearch,
        groupFilter,
        hasGroupFilter,
        searchTextCache,
      )
    ) {
      return false;
    }
    if (
      hasStatusFilter &&
      !matchesStatusFilter(r, statusFilter, duplicateIndices, separatePlaceholder, archiveProbes)
    ) {
      return false;
    }
    return true;
  });
}

// Single-entry memo shared by every component that filters the live result
// set (ChannelTable, Toolbar). During a scan each rAF flush replaces
// flatResults, and without this each consumer re-ran its own full filter
// pass over the same inputs. The search-text cache is shared for the same
// reason. Sort remains per-consumer (only the table sorts).
export const sharedSearchTextCache: SearchTextCache = new WeakMap();

type SharedFilterKey = {
  results: ChannelResult[];
  search: string;
  groupFilter: string;
  statusFilter: string;
  duplicateIndices: Set<number> | undefined;
  separatePlaceholder: boolean | undefined;
  archiveProbes: ArchiveProbes | undefined;
};

let sharedFilterKey: SharedFilterKey | null = null;
let sharedFilterValue: ChannelResult[] = [];

export function filterResultsShared(
  results: ChannelResult[],
  search: string,
  groupFilter: string,
  statusFilter: string,
  duplicateIndices?: Set<number>,
  separatePlaceholder?: boolean,
  archiveProbes?: ArchiveProbes,
): ChannelResult[] {
  // Verdict filters are the only ones that read probes, so probe churn during
  // verification must not invalidate the memo for every other filter.
  const probesKey = statusFilter in CATCHUP_VERDICT_FILTERS ? archiveProbes : undefined;
  const key = sharedFilterKey;
  if (
    key &&
    key.results === results &&
    key.search === search &&
    key.groupFilter === groupFilter &&
    key.statusFilter === statusFilter &&
    key.duplicateIndices === duplicateIndices &&
    key.separatePlaceholder === separatePlaceholder &&
    key.archiveProbes === probesKey
  ) {
    return sharedFilterValue;
  }

  const value = filterResults(
    results,
    search,
    groupFilter,
    statusFilter,
    duplicateIndices,
    sharedSearchTextCache,
    separatePlaceholder,
    probesKey,
  );
  sharedFilterKey = {
    results,
    search,
    groupFilter,
    statusFilter,
    duplicateIndices,
    separatePlaceholder,
    archiveProbes: probesKey,
  };
  sharedFilterValue = value;
  return value;
}

export function countStatusOptions(
  results: ChannelResult[],
  search: string,
  groupFilter: string,
  duplicateIndices?: Set<number>,
  searchTextCache?: SearchTextCache,
  separatePlaceholder?: boolean,
  archiveProbes?: ArchiveProbes,
): StatusOptionCounts {
  const normalizedSearch = search.trim().toLowerCase();
  const hasSearch = normalizedSearch.length > 0;
  const hasGroupFilter = groupFilter !== "" && groupFilter !== "all";
  const counts: StatusOptionCounts = {
    all: 0,
    alive: 0,
    drm: 0,
    dead: 0,
    placeholder: 0,
    geoblocked: 0,
    mislabeled: 0,
    audio_only: 0,
    duplicates: 0,
    pending: 0,
    catchup: 0,
    catchup_real: 0,
    catchup_shallower: 0,
    catchup_fake: 0,
    catchup_untested: 0,
  };

  for (const result of results) {
    if (
      !matchesBaseFilters(
        result,
        normalizedSearch,
        hasSearch,
        groupFilter,
        hasGroupFilter,
        searchTextCache,
      )
    ) {
      continue;
    }

    counts.all += 1;
    if (result.status === "alive") {
      counts.alive += 1;
    } else if (result.status === "drm") {
      counts.drm += 1;
    } else if (result.status === "dead") {
      counts.dead += 1;
    } else if (result.status === "placeholder") {
      if (separatePlaceholder) {
        counts.placeholder += 1;
      } else {
        counts.dead += 1;
      }
    } else if (result.status === "pending") {
      counts.pending += 1;
    }

    if (
      result.status === "geoblocked" ||
      result.status === "geoblocked_confirmed" ||
      result.status === "geoblocked_unconfirmed"
    ) {
      counts.geoblocked += 1;
    }

    if (result.label_mismatches.length > 0) {
      counts.mislabeled += 1;
    }

    if (result.audio_only) {
      counts.audio_only += 1;
    }

    if (hasArchive(result)) {
      counts.catchup += 1;
      switch (archiveVerdict(result, archiveProbes?.[result.index])) {
        case "verified":
          counts.catchup_real += 1;
          break;
        case "shallower":
          counts.catchup_shallower += 1;
          break;
        case "fake":
          counts.catchup_fake += 1;
          break;
        default:
          counts.catchup_untested += 1;
      }
    }

    if (duplicateIndices?.has(result.index)) {
      counts.duplicates += 1;
    }
  }

  return counts;
}
