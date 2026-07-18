import type { RecentPlaylistEntry, XtreamRecentSource } from "./types";

/** Helpers for encoding/labeling recent-playlist entries (Xtream sources are
 *  stored as JSON in the entry value). */

export function serializeXtreamRecent(source: XtreamRecentSource): string {
  const obj: Record<string, string> = {
    server: source.server.trim(),
    username: source.username.trim(),
  };
  if (source.password) {
    obj.password = source.password;
  }
  return JSON.stringify(obj);
}

export function parseXtreamRecent(value: string): XtreamRecentSource | null {
  try {
    const parsed = JSON.parse(value) as Partial<XtreamRecentSource>;
    const server = typeof parsed.server === "string" ? parsed.server.trim() : "";
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    if (!server || !username) {
      return null;
    }
    const password =
      typeof parsed.password === "string" && parsed.password
        ? parsed.password
        : undefined;
    return { server, username, password };
  } catch {
    return null;
  }
}

export function recentValueLabel(entry: RecentPlaylistEntry): string {
  if (entry.kind === "file") {
    return `Path - ${entry.value}`;
  }
  if (entry.kind === "url") {
    return `URL - ${entry.value}`;
  }
  const source = parseXtreamRecent(entry.value);
  if (!source) {
    return "Xtream - Invalid source";
  }
  return `Xtream - ${source.server} (${source.username})`;
}

export function recentTitle(entry: RecentPlaylistEntry): string {
  if (entry.kind !== "xtream") {
    return entry.value;
  }
  const source = parseXtreamRecent(entry.value);
  if (!source) {
    return entry.value;
  }
  return `${source.server} (${source.username})`;
}
