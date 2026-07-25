import type { Channel, CurrentSourceDescriptor, PlaylistPreview } from "./types";

const LEADING_CASE_INSENSITIVE_PREFIX = /^(?:\(\?i\))+/i;

function stripLeadingCaseInsensitivePrefix(pattern: string): string {
  return pattern.replace(LEADING_CASE_INSENSITIVE_PREFIX, "");
}

function contentTypeTotals(channels: Channel[]): {
  live_count: number;
  movie_count: number;
  series_count: number;
} {
  let liveCount = 0;
  let movieCount = 0;
  let seriesCount = 0;

  for (const channel of channels) {
    switch (channel.content_type) {
      case "live":
        liveCount += 1;
        break;
      case "movie":
        movieCount += 1;
        break;
      case "series":
        seriesCount += 1;
        break;
    }
  }

  return {
    live_count: liveCount,
    movie_count: movieCount,
    series_count: seriesCount,
  };
}

function visibleGroups(channels: Channel[]): string[] {
  return Array.from(new Set(channels.map((channel) => channel.group)))
    .filter((group) => group.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeSourceFilter(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function compileSourceFilterRegex(value: string | null | undefined): RegExp | null {
  const normalized = normalizeSourceFilter(value);
  if (!normalized) {
    return null;
  }

  return new RegExp(stripLeadingCaseInsensitivePrefix(normalized), "i");
}

export function validateSourceFilterPattern(value: string | null | undefined): string | null {
  try {
    compileSourceFilterRegex(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function applySourceFilterToPreview(
  preview: PlaylistPreview,
  value: string | null | undefined,
): PlaylistPreview {
  const matcher = compileSourceFilterRegex(value);
  if (!matcher) {
    return preview;
  }

  const channels = preview.channels.filter((channel) => matcher.test(channel.name));
  const totals = contentTypeTotals(channels);

  return {
    ...preview,
    total_channels: channels.length,
    live_count: totals.live_count,
    movie_count: totals.movie_count,
    series_count: totals.series_count,
    channels,
    // Keep the full group list to mirror backend source-filter semantics.
    groups: [...preview.groups],
  };
}

export function applyContentVisibilityToPreview(
  preview: PlaylistPreview,
  hideVodContent: boolean,
): PlaylistPreview {
  if (!hideVodContent) {
    return preview;
  }

  const channels = preview.channels.filter((channel) => channel.content_type === "live");
  const totals = contentTypeTotals(channels);

  return {
    ...preview,
    total_channels: channels.length,
    live_count: totals.live_count,
    movie_count: totals.movie_count,
    series_count: totals.series_count,
    groups: visibleGroups(channels),
    channels,
  };
}

export function hasDirtySourceFilter(
  channelSearch: string | null | undefined,
  lastAppliedSourceFilter: string | null | undefined,
  currentSourceDescriptor: CurrentSourceDescriptor | null,
): boolean {
  if (!currentSourceDescriptor) {
    return false;
  }

  return normalizeSourceFilter(channelSearch) !== normalizeSourceFilter(lastAppliedSourceFilter);
}

export function resolvePreservedGroupFilter(currentGroupFilter: string, groups: string[]): string {
  if (currentGroupFilter === "all") {
    return "all";
  }

  const normalizedCurrent = currentGroupFilter.trim().toLowerCase();
  return groups.some((group) => group.trim().toLowerCase() === normalizedCurrent)
    ? currentGroupFilter
    : "all";
}
