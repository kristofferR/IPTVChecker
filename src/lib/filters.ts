import type { ChannelResult, ChannelStatus } from "./types";

export type SortField =
  | "index"
  | "playlist"
  | "name"
  | "url"
  | "group"
  | "status"
  | "resolution"
  | "codec"
  | "fps"
  | "latency"
  | "bitrate"
  | "audio"
  | "error";

export type SortDirection = "asc" | "desc";

export type SearchTextCache = WeakMap<ChannelResult, string>;

const STATUS_ORDER: Record<ChannelStatus, number> = {
  alive: 0,
  geoblocked: 1,
  geoblocked_confirmed: 1,
  geoblocked_unconfirmed: 1,
  dead: 2,
  checking: 3,
  pending: 4,
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
      case "error":
        return compareOptionalText(
          a.error_reason ?? a.last_error_reason,
          b.error_reason ?? b.last_error_reason,
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
): ChannelResult[] {
  const normalizedSearch = search.trim().toLowerCase();
  const hasSearch = normalizedSearch.length > 0;
  const hasGroupFilter = groupFilter !== "" && groupFilter !== "all";
  const hasStatusFilter = statusFilter !== "" && statusFilter !== "all";

  if (!hasSearch && !hasGroupFilter && !hasStatusFilter) {
    return results;
  }

  return results.filter((r) => {
    if (hasSearch) {
      let haystack = searchTextCache?.get(r);
      if (!haystack) {
        haystack = `${r.name}\n${r.playlist}\n${r.group}`.toLowerCase();
        searchTextCache?.set(r, haystack);
      }
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    if (hasGroupFilter) {
      if (r.group !== groupFilter) return false;
    }
    if (hasStatusFilter) {
      if (statusFilter === "duplicates") {
        return duplicateIndices?.has(r.index) ?? false;
      }
      if (statusFilter === "audio_only") {
        return r.audio_only;
      }
      if (statusFilter === "geoblocked") {
        if (
          r.status !== "geoblocked" &&
          r.status !== "geoblocked_confirmed" &&
          r.status !== "geoblocked_unconfirmed"
        ) {
          return false;
        }
      } else if (r.status !== statusFilter) {
        return false;
      }
    }
    return true;
  });
}
