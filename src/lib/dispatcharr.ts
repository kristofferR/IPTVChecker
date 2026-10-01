import { type MessageKey, t } from "../i18n";
import { type ArchiveProbes, filterResultsShared } from "./filters";
import type {
  AppSettings,
  ChannelResult,
  ChannelStatus,
  DispatcharrRankSignal,
  DispatcharrTarget,
  PlaylistPreview,
} from "./types";

/** Dispatcharr IDs embedded as `x-dispatcharr-*` EXTINF attributes by the
 *  backend's M3U synthesis (mirror of `dispatcharr_ids_from_extinf`). */
export interface DispatcharrStreamRef {
  channelId: number;
  streamId: number;
  /** Position in the channel's failover order, 0 = primary. */
  streamOrder: number;
  streamCount: number;
  channelUuid: string | null;
  account: string | null;
  accountId: number | null;
  /** Linked from Find streams this session; its channel's source has no row
   *  for it until reloaded, so scans leave it alone. */
  added: boolean;
  /** The placeholder row of a channel with no playable stream. */
  empty: boolean;
  /** The provider stream's own name (rows are titled with the channel). */
  streamName: string | null;
  /** The Dispatcharr server the row came from; ids are only unique there. */
  server: string | null;
  /** The channel's complete stream order at load, including streams that
   *  have no row (no URL). */
  channelStreams: number[] | null;
}

/** Where a pasted Dispatcharr endpoint ("/proxy/ts/...", "/output/m3u",
 *  "/api/channels/...", or a bare trailing "/api") starts in a URL path. A
 *  segment such as "/api/" not followed by a Dispatcharr endpoint belongs to
 *  a reverse-proxy prefix ("/api/dispatcharr") and is kept. Mirrors the
 *  backend. */
function dispatcharrEndpointStart(path: string): number | null {
  const endpoints: Array<[string, string[]]> = [
    ["/proxy/", ["ts/", "hls/", "vod/"]],
    ["/output/", ["m3u", "epg"]],
    [
      "/api/",
      [
        "channels/",
        "m3u/",
        "epg/",
        "accounts/",
        "core/",
        "hdhr/",
        "vod/",
        "catchup/",
        "connect/",
        "plugins/",
        "schema/",
      ],
    ],
  ];
  // Trailing slash so a path ending in a marker ("/dispatcharr/api") matches.
  const lower = `${path.toLowerCase()}/`;
  let start: number | null = null;
  for (const [marker, next] of endpoints) {
    for (let at = lower.indexOf(marker); at >= 0; at = lower.indexOf(marker, at + 1)) {
      const rest = lower.slice(at + marker.length);
      // Only slashes left: a bare "/api/" ending the URL.
      const bare = rest.replaceAll("/", "") === "";
      if ((bare || next.some((segment) => rest.startsWith(segment))) && at > (start ?? -1)) {
        start = at;
      }
    }
  }
  return start;
}

/** Base URL of a Dispatcharr instance, accepting pasted proxy, output, or API
 *  URLs and keeping any reverse-proxy path prefix. */
export function normalizeDispatcharrServer(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    const cut = dispatcharrEndpointStart(parsed.pathname);
    const prefix = parsed.pathname.slice(0, cut ?? undefined);
    return `${parsed.origin}${prefix.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function extinfAttribute(extinfLine: string, key: string): string | null {
  const match = new RegExp(`\\s${key}="((?:\\\\.|[^"\\\\])*)"`).exec(extinfLine);
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

const ADDED_ATTR = "x-dispatcharr-added";

/** A candidate's row as linked to `channel` this session: titled and grouped
 *  like the channel's other rows, and marked as added. */
export function addedStreamRow(
  result: ChannelResult,
  channel: DispatcharrChannelView,
  index: number,
): ChannelResult {
  // The title starts after the first comma outside a quoted attribute.
  let cut = result.extinf_line.length;
  let quoted = false;
  for (let i = 0; i < result.extinf_line.length; i++) {
    const c = result.extinf_line[i];
    if (c === "\\" && quoted) i++;
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      cut = i;
      break;
    }
  }
  const marked = `${result.extinf_line.slice(0, cut)} ${ADDED_ATTR}="1"${result.extinf_line.slice(cut)}`;
  return {
    ...result,
    index,
    playlist: channel.primary.playlist,
    name: channel.name,
    group: channel.group,
    // Found streams come without the channel's group; exports read it here.
    extinf_line: setAttribute(marked, "group-title", escapeAttribute(channel.group)),
  };
}

/** Loaded streams of a channel that are no longer linked to it (unlinked
 *  this session), with their results. */
export function unlinkedStreams(
  results: ChannelResult[],
  channel: DispatcharrChannelView,
): DispatcharrStreamEntry[] {
  const seen = new Set(channel.order);
  const entries: DispatcharrStreamEntry[] = [];
  for (const result of results) {
    const ref = cachedIds(result.extinf_line);
    if (!ref || ref.empty || ref.channelId !== channel.channelId || seen.has(ref.streamId)) {
      continue;
    }
    seen.add(ref.streamId);
    entries.push({ ref, result, providerDown: false });
  }
  return entries;
}

export function parseDispatcharrIds(extinfLine: string): DispatcharrStreamRef | null {
  if (!extinfLine.includes("x-dispatcharr-stream-id")) return null;
  const number = (key: string) => {
    const raw = extinfAttribute(extinfLine, key);
    const value = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isInteger(value) ? value : null;
  };
  const channelId = number("x-dispatcharr-channel-id");
  const streamId = number("x-dispatcharr-stream-id");
  if (channelId === null || streamId === null) return null;
  return {
    channelId,
    streamId,
    streamOrder: number("x-dispatcharr-stream-order") ?? 0,
    streamCount: number("x-dispatcharr-stream-count") ?? 1,
    channelUuid: extinfAttribute(extinfLine, "x-dispatcharr-channel-uuid") || null,
    account: extinfAttribute(extinfLine, "x-dispatcharr-account") || null,
    accountId: number("x-dispatcharr-account-id"),
    added: extinfAttribute(extinfLine, ADDED_ATTR) === "1",
    empty: extinfAttribute(extinfLine, "x-dispatcharr-empty") === "1",
    streamName: extinfAttribute(extinfLine, "x-dispatcharr-stream-name") || null,
    server: extinfAttribute(extinfLine, "x-dispatcharr-server") || null,
    channelStreams:
      extinfAttribute(extinfLine, "x-dispatcharr-channel-streams")
        ?.split(",")
        // An empty list (a channel with no streams) has no ids, not a 0.
        .filter((id) => id.trim() !== "")
        .map(Number)
        .filter(Number.isInteger) ?? null,
  };
}

/** Where writes for the loaded Dispatcharr source go, or null. */
export function dispatcharrTarget(preview: PlaylistPreview | null): DispatcharrTarget | null {
  const sourceIdentity = preview?.source_identity;
  const connection = preview?.dispatcharr_connection;
  return sourceIdentity && connection ? { sourceIdentity, connection } : null;
}

/** A native Dispatcharr source: the backend records its connection. */
export function isDispatcharrPreview(preview: PlaylistPreview | null): boolean {
  return Boolean(preview?.dispatcharr_connection);
}

export interface DispatcharrStreamEntry {
  ref: DispatcharrStreamRef;
  result: ChannelResult;
  /** Failed while its whole provider account was down: says nothing about
   *  the stream, so it counts as untested. */
  providerDown: boolean;
}

/** A provider account whose scanned streams nearly all failed the same way. */
export interface DownAccount {
  accountId: number;
  account: string;
  failed: number;
  scanned: number;
  /** The shared failure for display, e.g. "HTTP 502" or "timeouts". */
  error: string;
}

export interface DispatcharrChannelView {
  channelId: number;
  /** Channel name without the "[n/m] stream" suffix of multi-stream rows. */
  name: string;
  group: string;
  /** Streams in the channel's current failover order in Dispatcharr. */
  streams: DispatcharrStreamEntry[];
  /** Dispatcharr's complete stream order, including streams with no row.
   *  Writes compare against and preserve it. */
  order: number[];
  /** The primary stream's result: what viewers get. */
  primary: ChannelResult;
  alive: number;
  /** Dead streams exclude those of down provider accounts. */
  primaryDead: boolean;
  hasDead: boolean;
  allDead: boolean;
  /** The primary failed because its provider account is down. */
  primaryProviderDown: boolean;
  /** Scanned, and not one stream works (dead, or its provider is down), or
   *  the channel has no streams at all. */
  noWorking: boolean;
  /** No playable stream: shown through its placeholder row. */
  empty: boolean;
}

export interface DispatcharrView {
  channels: DispatcharrChannelView[];
  /** One result per channel (its primary), in load order. */
  primaries: ChannelResult[];
  byChannelId: Map<number, DispatcharrChannelView>;
  byPrimaryIndex: Map<number, DispatcharrChannelView>;
  /** Channel of every loaded stream row by result index, including rows
   *  unlinked this session, so a selection can follow its channel. */
  byStreamIndex: Map<number, DispatcharrChannelView>;
  downAccounts: DownAccount[];
}

/** Stream orders written to Dispatcharr this session, keyed by channel id.
 *  They override the order embedded in the loaded rows. */
export type DispatcharrOrders = Record<number, number[]>;

const refCache = new Map<string, DispatcharrStreamRef | null>();

function cachedIds(extinfLine: string): DispatcharrStreamRef | null {
  let ref = refCache.get(extinfLine);
  if (ref === undefined) {
    ref = parseDispatcharrIds(extinfLine);
    if (refCache.size > 50_000) refCache.clear();
    refCache.set(extinfLine, ref);
  }
  return ref;
}

/** The stand-in row of a channel with no streams: selectable (Find streams),
 *  never played. */
export function isDispatcharrPlaceholder(result: Pick<ChannelResult, "extinf_line">): boolean {
  return cachedIds(result.extinf_line)?.empty === true;
}

export function dispatcharrStreamName(entry: DispatcharrStreamEntry): string {
  return entry.ref.streamName ?? entry.result.name;
}

export function isDeadStatus(status: ChannelResult["status"]): boolean {
  return status === "dead";
}

export function isUntestedStatus(status: ChannelResult["status"]): boolean {
  return status === "pending" || status === "checking";
}

const STATUS_LABELS = {
  alive: "dispatcharr.streamStatus.alive",
  dead: "dispatcharr.streamStatus.dead",
  pending: "dispatcharr.streamStatus.pending",
  checking: "dispatcharr.streamStatus.checking",
  drm: "dispatcharr.streamStatus.drm",
  placeholder: "dispatcharr.streamStatus.placeholder",
  geoblocked: "dispatcharr.streamStatus.geoblocked",
  geoblocked_confirmed: "dispatcharr.streamStatus.geoblockedConfirmed",
  geoblocked_unconfirmed: "dispatcharr.streamStatus.geoblockedUnconfirmed",
} as const satisfies Record<ChannelStatus, MessageKey>;

/** A stream's raw status for display. */
export function dispatcharrStatusLabel(status: ChannelStatus): string {
  return t(STATUS_LABELS[status]);
}

/** Fewest scanned streams before an account can count as down. */
const DOWN_ACCOUNT_MIN_STREAMS = 5;
/** Share of scanned streams that failed, and share of failures with the
 *  same cause, for an account to count as down. */
const DOWN_ACCOUNT_FAILED_SHARE = 0.9;
const DOWN_ACCOUNT_SAME_CAUSE_SHARE = 0.8;

/** A failure's cause at the level a whole provider fails with. */
export function failureCause(result: ChannelResult): string | null {
  const reason = `${result.error_reason ?? ""} ${result.error_message ?? ""}`;
  const http = /\bHTTP (\d{3})\b/.exec(reason);
  if (http) return `HTTP ${http[1]}`;
  if (/timed out|timeout/i.test(reason)) return "timeouts";
  if (/error sending request|connect|refused|dns|resolve/i.test(reason)) {
    return "connection errors";
  }
  return null;
}

/** A `failureCause` for display; HTTP codes read the same in every language. */
function describeFailureCause(cause: string): string {
  if (cause === "timeouts") return t("dispatcharr.failureCause.timeouts");
  if (cause === "connection errors") return t("dispatcharr.failureCause.connectionErrors");
  return cause;
}

/** Accounts whose scanned streams nearly all failed with one cause: the
 *  provider is down, not each stream. */
export function findDownAccounts(entries: DispatcharrStreamEntry[]): DownAccount[] {
  const byAccount = new Map<number, DispatcharrStreamEntry[]>();
  // A stream linked to several channels is still one provider stream.
  const seen = new Set<number>();
  for (const entry of entries) {
    if (entry.ref.accountId === null || seen.has(entry.ref.streamId)) continue;
    seen.add(entry.ref.streamId);
    const list = byAccount.get(entry.ref.accountId) ?? [];
    list.push(entry);
    byAccount.set(entry.ref.accountId, list);
  }
  const down: DownAccount[] = [];
  for (const [accountId, list] of byAccount) {
    const scanned = list.filter((entry) => !isUntestedStatus(entry.result.status));
    const failed = scanned.filter((entry) => isDeadStatus(entry.result.status));
    if (
      scanned.length < DOWN_ACCOUNT_MIN_STREAMS ||
      failed.length < scanned.length * DOWN_ACCOUNT_FAILED_SHARE
    ) {
      continue;
    }
    const causes = new Map<string, number>();
    for (const entry of failed) {
      const cause = failureCause(entry.result);
      if (cause) causes.set(cause, (causes.get(cause) ?? 0) + 1);
    }
    const [error, count] = [...causes].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (count < failed.length * DOWN_ACCOUNT_SAME_CAUSE_SHARE) continue;
    down.push({
      accountId,
      account: list[0].ref.account ?? t("dispatcharr.accountFallback", { id: accountId }),
      failed: failed.length,
      scanned: scanned.length,
      error: describeFailureCause(error),
    });
  }
  return down;
}

/** A reopened export titles each row "Channel [n/m] Stream" (see
 *  `dispatcharrChannelRows`). Strip that suffix only when it matches the
 *  row's own position and stream name, so a real name that merely looks like
 *  one stays whole. */
function exportedChannelName(name: string, ref: DispatcharrStreamRef): string {
  const marker = ` [${ref.streamOrder + 1}/${ref.streamCount}] `;
  if (ref.streamName !== null) {
    const suffix = `${marker}${ref.streamName}`;
    return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  }
  // Without a stream name the export repeats the channel's: "X [n/m] X".
  const channelName = name.slice(0, (name.length - marker.length) / 2);
  return name === `${channelName}${marker}${channelName}` ? channelName : name;
}

function buildView(results: ChannelResult[], orders: DispatcharrOrders): DispatcharrView | null {
  const byChannel = new Map<
    number,
    {
      name: string;
      group: string;
      streams: DispatcharrStreamEntry[];
      placeholder?: DispatcharrStreamEntry;
    }
  >();
  const playlist = results[0]?.playlist;
  const server = results[0] && cachedIds(results[0].extinf_line)?.server;
  for (const result of results) {
    const ref = cachedIds(result.extinf_line);
    // Channel-first mode needs one pure Dispatcharr source: a mixed playlist
    // (a folder, or an export merged with other rows) stays a plain table,
    // and channel ids are only unique within one server.
    if (!ref || result.playlist !== playlist || ref.server !== server) return null;
    let channel = byChannel.get(ref.channelId);
    if (!channel) {
      channel = { name: exportedChannelName(result.name, ref), group: result.group, streams: [] };
      byChannel.set(ref.channelId, channel);
    }
    if (ref.empty) channel.placeholder = { ref, result, providerDown: false };
    else if (!channel.streams.some((entry) => entry.ref.streamId === ref.streamId)) {
      channel.streams.push({ ref, result, providerDown: false });
    }
  }
  if (byChannel.size === 0) return null;

  const allEntries = [...byChannel.values()].flatMap((channel) => channel.streams);
  const downAccounts = findDownAccounts(allEntries);
  const downIds = new Set(downAccounts.map((account) => account.accountId));
  for (const entry of allEntries) {
    entry.providerDown =
      isDeadStatus(entry.result.status) &&
      entry.ref.accountId !== null &&
      downIds.has(entry.ref.accountId);
  }
  const isDead = (entry: DispatcharrStreamEntry) =>
    isDeadStatus(entry.result.status) && !entry.providerDown;

  const channels: DispatcharrChannelView[] = [];
  const byStreamIndex = new Map<number, DispatcharrChannelView>();
  for (const [channelId, channel] of byChannel) {
    const loaded = [...channel.streams].sort((a, b) => a.ref.streamOrder - b.ref.streamOrder);
    const order =
      orders[channelId] ??
      loaded[0]?.ref.channelStreams ??
      channel.placeholder?.ref.channelStreams ??
      loaded.map((entry) => entry.ref.streamId);
    const byStream = new Map(channel.streams.map((entry) => [entry.ref.streamId, entry]));
    const streams = order.flatMap((streamId) => byStream.get(streamId) ?? []);
    if (streams.length === 0) {
      // No playable stream: the channel shows through its placeholder so
      // Find streams can give it some.
      if (!channel.placeholder) continue;
      const view: DispatcharrChannelView = {
        channelId,
        name: channel.name,
        group: channel.group,
        streams: [],
        order,
        primary: channel.placeholder.result,
        alive: 0,
        primaryDead: false,
        hasDead: false,
        allDead: false,
        primaryProviderDown: false,
        noWorking: true,
        empty: true,
      };
      channels.push(view);
      byStreamIndex.set(channel.placeholder.result.index, view);
      for (const entry of channel.streams) byStreamIndex.set(entry.result.index, view);
      continue;
    }
    const dead = streams.filter(isDead).length;
    const view: DispatcharrChannelView = {
      channelId,
      name: channel.name,
      group: channel.group,
      streams,
      order,
      primary: streams[0].result,
      alive: streams.filter((entry) => entry.result.status === "alive").length,
      primaryDead: isDead(streams[0]),
      hasDead: dead > 0,
      allDead: dead === streams.length,
      primaryProviderDown: streams[0].providerDown,
      noWorking:
        streams.every((entry) => entry.result.status !== "alive") &&
        streams.every((entry) => !isUntestedStatus(entry.result.status)),
      empty: false,
    };
    channels.push(view);
    for (const entry of channel.streams) byStreamIndex.set(entry.result.index, view);
    if (channel.placeholder) byStreamIndex.set(channel.placeholder.result.index, view);
  }
  return {
    channels,
    primaries: channels.map((channel) => channel.primary),
    byChannelId: new Map(channels.map((channel) => [channel.channelId, channel])),
    byPrimaryIndex: new Map(channels.map((channel) => [channel.primary.index, channel])),
    byStreamIndex,
    downAccounts,
  };
}

// Single-entry memo: the table, toolbar, and stats bar all read the same view,
// and scans replace the results array on every flush.
let viewKey: { results: ChannelResult[]; orders: DispatcharrOrders } | null = null;
let viewValue: DispatcharrView | null = null;

/** Channel-first view of a Dispatcharr source, or null for other sources. */
export function getDispatcharrView(
  results: ChannelResult[],
  orders: DispatcharrOrders,
): DispatcharrView | null {
  if (viewKey?.results === results && viewKey.orders === orders) return viewValue;
  viewKey = { results, orders };
  viewValue =
    results.length > 0 && cachedIds(results[0].extinf_line) ? buildView(results, orders) : null;
  return viewValue;
}

/** Channel-level status filters, only offered for Dispatcharr sources. Keys
 *  are filter values; labels are translated once, at module load. */
export const DISPATCHARR_STATUS_FILTERS = {
  primary_dead: t("dispatcharr.statusFilters.primaryDead"),
  has_dead: t("dispatcharr.statusFilters.hasDead"),
  all_dead: t("dispatcharr.statusFilters.allDead"),
};

export type DispatcharrStatusFilter = keyof typeof DISPATCHARR_STATUS_FILTERS;

export function isDispatcharrStatusFilter(value: string): value is DispatcharrStatusFilter {
  return value in DISPATCHARR_STATUS_FILTERS;
}

export function matchesDispatcharrStatus(
  channel: DispatcharrChannelView,
  filter: DispatcharrStatusFilter,
): boolean {
  switch (filter) {
    case "primary_dead":
      return channel.primaryDead;
    case "has_dead":
      return channel.hasDead;
    case "all_dead":
      return channel.allDead;
  }
}

export type FixProposal =
  | { kind: "none" }
  | { kind: "all_dead" }
  | { kind: "change"; order: number[]; removed: number };

/** How Fix order ranks streams (Settings > Dispatcharr). */
export interface FixPreferences {
  /** Signals compared in order; a tie on one falls through to the next. */
  rankOrder: DispatcharrRankSignal[];
  deadStreams: "unlink" | "move_to_end";
}

const RANK_SIGNALS: DispatcharrRankSignal[] = [
  "resolution",
  "frame_rate",
  "bitrate",
  "latency",
  "audio_bitrate",
];

export const DEFAULT_FIX_PREFERENCES: FixPreferences = {
  rankOrder: RANK_SIGNALS,
  deadStreams: "unlink",
};

/** Preferences from settings, with the rank order deduplicated and any
 *  missing signal appended, so an old or edited settings file still ranks
 *  on every signal. */
export function fixPreferencesFrom(
  settings: Pick<AppSettings, "dispatcharr_rank_order" | "dispatcharr_dead_streams">,
): FixPreferences {
  const chosen = (settings.dispatcharr_rank_order ?? []).filter((signal) =>
    RANK_SIGNALS.includes(signal),
  );
  const rankOrder = [...new Set([...chosen, ...RANK_SIGNALS])];
  return { rankOrder, deadStreams: settings.dispatcharr_dead_streams ?? "unlink" };
}

function kbps(bitrate: string | null): number {
  const value = Number.parseFloat(bitrate ?? "");
  return Number.isFinite(value) ? value : 0;
}

/** Higher is better for every signal. Bitrates and latency compare in steps
 *  (500 kbps, 32 kbps, 250 ms) so scan-to-scan noise does not reshuffle
 *  channels. Audio rounds to the nearest step: common rates are multiples of
 *  32 kbps, so a 95 kbps measurement still ties with 96. */
const SIGNAL_SCORE: Record<DispatcharrRankSignal, (result: ChannelResult) => number> = {
  resolution: (result) => result.height ?? 0,
  frame_rate: (result) => result.fps ?? 0,
  bitrate: (result) => Math.floor(kbps(result.video_bitrate) / 500),
  latency: (result) =>
    result.latency_ms == null ? -Number.MAX_SAFE_INTEGER : -Math.floor(result.latency_ms / 250),
  audio_bitrate: (result) => Math.round(kbps(result.audio_bitrate) / 32),
};

/** Working streams first, ranked by the preferred signals (remaining ties
 *  keep their order), then untested ones, then geoblocked, DRM, and
 *  placeholder. Dead streams leave the channel or move to the end. A channel
 *  whose streams are all dead is left alone. */
export function proposeFixOrder(
  channel: DispatcharrChannelView,
  preferences: FixPreferences = DEFAULT_FIX_PREFERENCES,
): FixProposal {
  if (channel.allDead) return { kind: "all_dead" };
  const alive: DispatcharrStreamEntry[] = [];
  const untested: DispatcharrStreamEntry[] = [];
  const other: DispatcharrStreamEntry[] = [];
  const dead: DispatcharrStreamEntry[] = [];
  for (const entry of channel.streams) {
    const { status } = entry.result;
    if (status === "alive") alive.push(entry);
    else if (isUntestedStatus(status) || entry.providerDown) untested.push(entry);
    else if (isDeadStatus(status)) dead.push(entry);
    else other.push(entry);
  }
  alive.sort((a, b) => {
    for (const signal of preferences.rankOrder) {
      const score = SIGNAL_SCORE[signal];
      const difference = score(b.result) - score(a.result);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  const kept = preferences.deadStreams === "move_to_end" ? [...other, ...dead] : other;
  const order = [...alive, ...untested, ...kept].map((entry) => entry.ref.streamId);
  // Compared with hidden streams in place: one ahead of the working streams
  // is what Dispatcharr actually plays first.
  const proposed = withHiddenStreams(channel, order);
  if (
    proposed.length === channel.order.length &&
    proposed.every((id, i) => id === channel.order[i])
  ) {
    return { kind: "none" };
  }
  return { kind: "change", order, removed: channel.streams.length - order.length };
}

/** The visible channels' primary results under the table filters. Standard
 *  status filters apply to the primary stream, channel-level ones to the
 *  whole channel. */
export function filterDispatcharrPrimaries(
  view: DispatcharrView,
  search: string,
  groupFilter: string,
  statusFilter: string,
  duplicateIndices?: Set<number>,
  separatePlaceholder?: boolean,
  archiveProbes?: ArchiveProbes,
): ChannelResult[] {
  if (!isDispatcharrStatusFilter(statusFilter)) {
    return filterResultsShared(
      view.primaries,
      search,
      groupFilter,
      statusFilter,
      duplicateIndices,
      separatePlaceholder,
      archiveProbes,
    );
  }
  return filterResultsShared(
    view.primaries,
    search,
    groupFilter,
    "all",
    duplicateIndices,
    separatePlaceholder,
    archiveProbes,
  ).filter((primary) => {
    const channel = view.byPrimaryIndex.get(primary.index);
    return channel != null && matchesDispatcharrStatus(channel, statusFilter);
  });
}

/** Selected row indices with each selected channel (its primary) standing
 *  for all of its streams, sorted. */
export function expandDispatcharrSelection(
  view: DispatcharrView | null,
  indices: Iterable<number>,
): number[] {
  const expanded = view
    ? new Set(
        Array.from(indices).flatMap((index) => {
          const channel = view.byPrimaryIndex.get(index);
          return channel ? channel.streams.map((entry) => entry.result.index) : [index];
        }),
      )
    : new Set(indices);
  return Array.from(expanded).sort((a, b) => a - b);
}

const PROXY_STREAM_PATH = /\/proxy\/(?:ts|hls)\/stream\//i;

function isProxyStreamUrl(url: string): boolean {
  try {
    return PROXY_STREAM_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Same short, non-reversible key fingerprint the backend puts in source
 *  identities (first 12 hex digits of the key's SHA-256). */
export async function apiKeyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The Dispatcharr server behind a plain M3U export, or null. Every channel
 *  must be a proxy URL of that one server: converting replaces the whole
 *  source, so a mixed playlist would lose its other channels. */
export function dispatcharrServerOfProxyPlaylist(preview: PlaylistPreview | null): string | null {
  if (!preview || preview.channels.length === 0 || isDispatcharrPreview(preview)) return null;
  const server = normalizeDispatcharrServer(preview.channels[0].url);
  if (!server) return null;
  const allFromServer = preview.channels.every(
    (channel) =>
      isProxyStreamUrl(channel.url) && normalizeDispatcharrServer(channel.url) === server,
  );
  return allFromServer ? server : null;
}

/** A full order for Dispatcharr from a new order of the visible streams:
 *  streams without a row keep their place at the end. */
export function withHiddenStreams(channel: DispatcharrChannelView, visible: number[]): number[] {
  const shown = new Set(channel.streams.map((entry) => entry.ref.streamId));
  return [...visible, ...channel.order.filter((id) => !shown.has(id))];
}

/** Rows a full scan should cover once streams were unlinked this session:
 *  only streams still in their channels. Null when nothing was unlinked. */
export function dispatcharrLinkedIndices(
  results: ChannelResult[],
  orders: DispatcharrOrders,
): number[] | null {
  const view = getDispatcharrView(results, orders);
  if (!view) return null;
  // Streams linked from Find streams have no row in the source yet.
  const linked = view.channels.flatMap((channel) =>
    channel.streams.filter((entry) => !entry.ref.added).map((entry) => entry.result.index),
  );
  return linked.length < results.length ? linked.sort((a, b) => a - b) : null;
}

/** An EXTINF attribute value with quotes and backslashes escaped. */
function escapeAttribute(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

function setAttribute(extinfLine: string, key: string, value: string): string {
  // A callback keeps "$1" or "$&" in the value literal.
  return extinfLine.replace(
    new RegExp(`(\\s${key}=)"(?:\\\\.|[^"\\\\])*"`),
    (_match, prefix: string) => `${prefix}"${value}"`,
  );
}

/** A channel's streams as playlist rows in its current Dispatcharr order,
 *  with titles and order attributes rewritten to match (for export). */
export function dispatcharrChannelRows(channel: DispatcharrChannelView): ChannelResult[] {
  const count = channel.streams.length;
  return channel.streams.map((entry, position) => {
    const { result } = entry;
    const name =
      count > 1
        ? `${channel.name} [${position + 1}/${count}] ${dispatcharrStreamName(entry)}`
        : channel.name;
    let extinfLine = setAttribute(result.extinf_line, "x-dispatcharr-stream-order", `${position}`);
    extinfLine = setAttribute(extinfLine, "x-dispatcharr-stream-count", `${count}`);
    extinfLine = setAttribute(extinfLine, "x-dispatcharr-channel-streams", channel.order.join(","));
    if (extinfLine.endsWith(result.name)) {
      extinfLine = extinfLine.slice(0, extinfLine.length - result.name.length) + name;
    }
    return { ...result, name, extinf_line: extinfLine };
  });
}
