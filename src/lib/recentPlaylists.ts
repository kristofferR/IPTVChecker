import type { DispatcharrOpenRequest, RecentPlaylistEntry, XtreamRecentSource } from "./types";

/** Helpers for encoding/labeling recent-playlist entries (Xtream and
 *  Dispatcharr sources are stored as JSON in the entry value). */

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
    const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
    if (!server || !username) {
      return null;
    }
    const password =
      typeof parsed.password === "string" && parsed.password ? parsed.password : undefined;
    return { server, username, password };
  } catch {
    return null;
  }
}

/** Only the fields present are stored, so leave secrets out unless the user
 *  asked to remember them. */
export function serializeDispatcharrRecent(
  source: DispatcharrOpenRequest,
  keyFingerprint: string | null = null,
): string {
  const obj: Record<string, string> = { server: source.server.trim() };
  for (const key of ["username", "password", "api_key"] as const) {
    const value = source[key]?.trim();
    if (value) obj[key] = value;
  }
  if (keyFingerprint && !obj.api_key) obj.key_fingerprint = keyFingerprint;
  return JSON.stringify(obj);
}

export function parseDispatcharrRecent(value: string): DispatcharrOpenRequest | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const text = (key: string) =>
      typeof parsed[key] === "string" && parsed[key] ? (parsed[key] as string) : null;
    const server = text("server")?.trim();
    if (!server) return null;
    return {
      server,
      username: text("username"),
      password: text("password"),
      api_key: text("api_key"),
    };
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
  if (entry.kind === "dispatcharr") {
    const source = parseDispatcharrRecent(entry.value);
    return source ? `Dispatcharr - ${source.server}` : "Dispatcharr - Invalid source";
  }
  const source = parseXtreamRecent(entry.value);
  if (!source) {
    return "Xtream - Invalid source";
  }
  return `Xtream - ${source.server} (${source.username})`;
}

export function recentTitle(entry: RecentPlaylistEntry): string {
  if (entry.kind === "dispatcharr") {
    return parseDispatcharrRecent(entry.value)?.server ?? entry.value;
  }
  if (entry.kind !== "xtream") {
    return entry.value;
  }
  const source = parseXtreamRecent(entry.value);
  if (!source) {
    return entry.value;
  }
  return `${source.server} (${source.username})`;
}
