import type { ChannelResult, PlaylistPreview, XtreamArchiveChannelUpdate } from "./types";

// "Archive" = provider catch-up/replay of past programmes (issue #229). Named
// archive rather than catch-up because playback.ts already uses "catch-up"
// for its live-buffer drift helpers.

type ArchiveFields = Pick<ChannelResult, "catchup" | "catchup_days" | "catchup_source">;

export function hasArchive(result: ArchiveFields): boolean {
  return result.catchup != null || result.catchup_days != null;
}

/** Short table-chip text, e.g. "7d", or the raw type when depth is unknown. */
export function archiveBadgeText(result: ArchiveFields): string | null {
  if (!hasArchive(result)) return null;
  if (result.catchup_days != null) return `${result.catchup_days}d`;
  return result.catchup === "default" ? "yes" : (result.catchup ?? "yes");
}

export function archiveTitle(result: ArchiveFields): string | null {
  if (!hasArchive(result)) return null;
  const type = result.catchup ?? "default";
  const depth =
    result.catchup_days != null
      ? `${result.catchup_days} day${result.catchup_days === 1 ? "" : "s"}`
      : "unknown depth";
  const source = result.catchup_source ? ` · Source: ${result.catchup_source}` : "";
  return `Catch-up: ${type} · ${depth}${source}`;
}

/** Sort key: advertised depth in days; depth-less catch-up sorts below dated ones. */
export function archiveSortValue(result: ArchiveFields): number | null {
  if (!hasArchive(result)) return null;
  return result.catchup_days ?? 0;
}

type ArchiveUpdateTarget = Pick<
  ChannelResult,
  "index" | "catchup" | "catchup_days" | "extinf_line"
>;

export function applyXtreamArchiveUpdates<T extends ArchiveUpdateTarget>(
  items: T[],
  updates: XtreamArchiveChannelUpdate[],
): T[] {
  if (updates.length === 0) return items;

  const updatesByIndex = new Map(updates.map((update) => [update.index, update]));
  let changed = false;
  const next = items.map((item) => {
    const update = updatesByIndex.get(item.index);
    if (
      !update ||
      (item.catchup === update.catchup &&
        item.catchup_days === update.catchup_days &&
        item.extinf_line === update.extinf_line)
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      catchup: update.catchup,
      catchup_days: update.catchup_days,
      extinf_line: update.extinf_line,
    };
  });
  return changed ? next : items;
}

export function applyXtreamArchiveUpdatesToPreview(
  preview: PlaylistPreview,
  updates: XtreamArchiveChannelUpdate[],
): PlaylistPreview {
  const channels = applyXtreamArchiveUpdates(preview.channels, updates);
  return channels === preview.channels ? preview : { ...preview, channels };
}
