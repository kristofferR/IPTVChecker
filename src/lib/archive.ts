import type { ChannelResult } from "./types";

// "Archive" = provider catch-up/replay of past programmes (issue #229). Named
// archive rather than catch-up because playback.ts already uses "catch-up"
// for its live-buffer drift helpers.

type ArchiveFields = Pick<ChannelResult, "catchup" | "catchup_days">;

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
  return `Catch-up: ${type} · ${depth}`;
}

/** Sort key: advertised depth in days; depth-less catch-up sorts below dated ones. */
export function archiveSortValue(result: ArchiveFields): number | null {
  if (!hasArchive(result)) return null;
  return result.catchup_days ?? 0;
}
