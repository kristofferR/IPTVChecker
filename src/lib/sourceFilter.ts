import type { CurrentSourceDescriptor } from "./types";

export function normalizeSourceFilter(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function hasDirtySourceFilter(
  channelSearch: string | null | undefined,
  lastAppliedSourceFilter: string | null | undefined,
  currentSourceDescriptor: CurrentSourceDescriptor | null,
): boolean {
  if (!currentSourceDescriptor) {
    return false;
  }

  return (
    normalizeSourceFilter(channelSearch) !==
    normalizeSourceFilter(lastAppliedSourceFilter)
  );
}

export function resolvePreservedGroupFilter(
  currentGroupFilter: string,
  groups: string[],
): string {
  if (currentGroupFilter === "all") {
    return "all";
  }

  const normalizedCurrent = currentGroupFilter.trim().toLowerCase();
  return groups.some((group) => group.trim().toLowerCase() === normalizedCurrent)
    ? currentGroupFilter
    : "all";
}
