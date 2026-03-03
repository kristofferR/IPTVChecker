import type { ChannelResult, ChannelStatus } from "./types";

export type SortField =
  | "index"
  | "name"
  | "url"
  | "group"
  | "status"
  | "resolution"
  | "codec"
  | "fps"
  | "bitrate"
  | "audio";

export type SortDirection = "asc" | "desc";

const STATUS_ORDER: Record<ChannelStatus, number> = {
  alive: 0,
  geoblocked: 1,
  geoblocked_confirmed: 1,
  geoblocked_unconfirmed: 1,
  dead: 2,
  checking: 3,
  pending: 4,
};

export function sortResults(
  results: ChannelResult[],
  field: SortField,
  direction: SortDirection,
): ChannelResult[] {
  const sorted = [...results];
  const dir = direction === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    switch (field) {
      case "index":
        return (a.index - b.index) * dir;
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
      case "bitrate":
        return (
          (parseInt(a.video_bitrate ?? "0") -
            parseInt(b.video_bitrate ?? "0")) *
          dir
        );
      case "audio":
        return (
          (parseInt(a.audio_bitrate ?? "0") -
            parseInt(b.audio_bitrate ?? "0")) *
          dir
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
): ChannelResult[] {
  return results.filter((r) => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !r.name.toLowerCase().includes(q) &&
        !r.group.toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    if (groupFilter && groupFilter !== "all") {
      if (r.group !== groupFilter) return false;
    }
    if (statusFilter && statusFilter !== "all") {
      if (statusFilter === "duplicates") {
        return duplicateIndices?.has(r.index) ?? false;
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
