import type { ChannelResult, PlaylistPreview, XtreamArchiveChannelUpdate } from "./types";

// "Archive" = provider catch-up/replay of past programmes (issue #229). Named
// archive rather than catch-up because playback.ts already uses "catch-up"
// for its live-buffer drift helpers.

type ArchiveFields = Pick<ChannelResult, "catchup" | "catchup_days" | "catchup_source">;

export const MAX_CATCHUP_DAYS = 31;

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

// ---------------------------------------------------------------------------
// Archive URL construction
// ---------------------------------------------------------------------------

export interface ArchiveWindow {
  /** Where playback should start, unix epoch seconds. */
  startEpochS: number;
  /** Window length in seconds (a programme's runtime, or start→now). */
  durationS: number;
  /** Current time; offset-style templates need it. */
  nowEpochS: number;
}

export interface ArchivePlaybackRange {
  startEpochS: number;
  endEpochS?: number;
}

export interface ResolvedArchivePlayback {
  url: string;
  startEpochS: number;
  windowEndEpochS: number;
}

type ArchiveUrlFields = Pick<ChannelResult, "url" | "catchup" | "catchup_days" | "catchup_source">;

/**
 * Fill catch-up placeholder variables. Both `${var}` and `{var}` forms occur
 * in the wild; supported names follow the common catchup-source conventions.
 */
export function substituteArchiveTemplate(template: string, window: ArchiveWindow): string {
  const start = Math.floor(window.startEpochS);
  const now = Math.floor(window.nowEpochS);
  const duration = Math.max(0, Math.floor(window.durationS));
  const values: Record<string, number> = {
    start,
    utc: start,
    timestamp: now,
    lutc: now,
    now,
    end: start + duration,
    utcend: start + duration,
    duration,
    offset: Math.max(0, now - start),
  };
  return template.replace(
    /\$?\{(start|utc|timestamp|lutc|now|end|utcend|duration|offset)\}/g,
    (_match, name: string) => String(values[name]),
  );
}

function appendQuery(url: string, query: string): string {
  const fragmentStart = url.indexOf("#");
  const requestUrl = fragmentStart === -1 ? url : url.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? "" : url.slice(fragmentStart);
  return `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}${query}${fragment}`;
}

/** "YYYY-MM-DD:HH-MM" in UTC, the start format Xtream timeshift URLs expect. */
function formatXtreamStart(epochS: number): string {
  const date = new Date(epochS * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}:${pad(
    date.getUTCHours(),
  )}-${pad(date.getUTCMinutes())}`;
}

/** `http(s)://host[/prefix][/live]/user/pass/id[.ext]` — Xtream live URL shape. */
const XTREAM_LIVE_URL =
  /^(https?:\/\/[^/]+)((?:\/[^/]+)*?)(?:\/live)?\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/i;

function defaultArchiveUrl(url: string, window: ArchiveWindow): string {
  return appendQuery(url, substituteArchiveTemplate("utc=${start}&lutc=${now}", window));
}

/**
 * Build a playable archive URL for a catch-up channel, or null when the
 * channel does not advertise catch-up. Falls back to the standard
 * `utc`/`lutc` query form whenever a more specific scheme cannot apply.
 */
export function buildArchiveUrl(channel: ArchiveUrlFields, window: ArchiveWindow): string | null {
  if (!hasArchive(channel)) return null;

  const source = channel.catchup_source?.trim();
  if (source) {
    const resolved = substituteArchiveTemplate(source, window).replace(/&amp;/g, "&");
    if (/^https?:\/\//i.test(resolved)) return resolved;
    if (resolved.startsWith("?") || resolved.startsWith("&")) {
      return appendQuery(channel.url, resolved.slice(1));
    }
    // Relative templates (catchup="append" and friends) attach to the URL.
    const fragmentStart = channel.url.indexOf("#");
    const withoutFragment =
      fragmentStart === -1 ? channel.url : channel.url.slice(0, fragmentStart);
    const fragment = fragmentStart === -1 ? "" : channel.url.slice(fragmentStart);
    const queryStart = withoutFragment.indexOf("?");
    const path = queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart);
    const query = queryStart === -1 ? "" : withoutFragment.slice(queryStart);
    return `${path}${resolved}${query}${fragment}`;
  }

  switch (channel.catchup) {
    case "xc": {
      const suffixStart = channel.url.search(/[?#]/);
      const streamUrl = suffixStart === -1 ? channel.url : channel.url.slice(0, suffixStart);
      const suffix = suffixStart === -1 ? "" : channel.url.slice(suffixStart);
      const match = streamUrl.match(XTREAM_LIVE_URL);
      if (!match) return defaultArchiveUrl(channel.url, window);
      const [, base, prefix, user, pass, id] = match;
      const durationMinutes = Math.max(1, Math.ceil(window.durationS / 60));
      return `${base}${prefix}/timeshift/${user}/${pass}/${durationMinutes}/${formatXtreamStart(
        window.startEpochS,
      )}/${id}.m3u8${suffix}`;
    }
    case "flussonic": {
      const start = Math.floor(window.startEpochS);
      const duration = Math.max(1, Math.floor(window.durationS));
      if (/\.m3u8([?#]|$)/.test(channel.url)) {
        return channel.url.replace(
          /\/[^/?#]+\.m3u8([?#]|$)/,
          `/archive-${start}-${duration}.m3u8$1`,
        );
      }
      if (/\.ts([?#]|$)/.test(channel.url)) {
        return channel.url.replace(/\/[^/?#]+\.ts([?#]|$)/, `/archive-${start}-${duration}.ts$1`);
      }
      return defaultArchiveUrl(channel.url, window);
    }
    default:
      // "default", "shift", "append"-without-source, and unknown types all
      // use the standard utc/lutc query convention.
      return defaultArchiveUrl(channel.url, window);
  }
}

/** How far back the sidebar picker starts: just under an hour ago. */
export const ARCHIVE_PICKER_DEFAULT_BACK_S = 59 * 60 + 30;

/**
 * Default picker position: 59:30 before `now`, expressed as the day offset
 * and local HH:MM the picker's controls use. A start in the future can never
 * play, so the default always lands inside the archive.
 */
export function archivePickerDefault(now: Date = new Date()): { daysBack: number; time: string } {
  const start = new Date(now.getTime() - ARCHIVE_PICKER_DEFAULT_BACK_S * 1000);
  const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysBack = Math.round((dayOf(now).getTime() - dayOf(start).getTime()) / 86_400_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return { daysBack, time: `${pad(start.getHours())}:${pad(start.getMinutes())}` };
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

/** Resolve the bounded archive window shared by local and cast playback. */
export function resolveArchivePlayback(
  channel: ArchiveUrlFields,
  range: ArchivePlaybackRange,
  nowEpochS: number = Math.floor(Date.now() / 1000),
): ResolvedArchivePlayback | null {
  const windowEndEpochS = Math.min(range.endEpochS ?? nowEpochS, nowEpochS);
  const requestedStartEpochS = Math.min(Math.floor(range.startEpochS), windowEndEpochS - 1);
  const durationS = Math.max(60, windowEndEpochS - requestedStartEpochS);
  const startEpochS = windowEndEpochS - durationS;
  const url = buildArchiveUrl(channel, { startEpochS, durationS, nowEpochS });
  return url ? { url, startEpochS, windowEndEpochS } : null;
}
