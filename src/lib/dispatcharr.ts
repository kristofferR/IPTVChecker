import { type ArchiveProbes, filterResultsShared } from "./filters";
import type { ChannelResult, PlaylistPreview } from "./types";

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
  /** The provider stream's own name (rows are titled with the channel). */
  streamName: string | null;
  /** The channel's complete stream order at load, including streams that
   *  have no row (no URL). */
  channelStreams: number[] | null;
}

/** Base URL of a Dispatcharr instance, accepting pasted proxy, output, or API
 *  URLs and keeping any reverse-proxy path prefix. */
export function normalizeDispatcharrServer(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    // Trailing slash so a path ending in a marker ("/dispatcharr/api") matches.
    const lower = `${parsed.pathname.toLowerCase()}/`;
    const cut = ["/proxy/", "/output/", "/api/"]
      .map((marker) => lower.indexOf(marker))
      .filter((index) => index >= 0);
    const prefix = parsed.pathname.slice(0, cut.length ? Math.min(...cut) : undefined);
    return `${parsed.origin}${prefix.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function extinfAttribute(extinfLine: string, key: string): string | null {
  const match = new RegExp(`\\s${key}="((?:\\\\.|[^"\\\\])*)"`).exec(extinfLine);
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

export function parseDispatcharrIds(extinfLine: string): DispatcharrStreamRef | null {
  if (!extinfLine.includes("x-dispatcharr-stream-id")) return null;
  const number = (key: string) => {
    const value = Number(extinfAttribute(extinfLine, key));
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
    streamName: extinfAttribute(extinfLine, "x-dispatcharr-stream-name") || null,
    channelStreams:
      extinfAttribute(extinfLine, "x-dispatcharr-channel-streams")
        ?.split(",")
        .map(Number)
        .filter(Number.isInteger) ?? null,
  };
}

/** Every row of a Dispatcharr source carries the IDs, so the first suffices. */
export function isDispatcharrPreview(preview: PlaylistPreview | null): boolean {
  const first = preview?.channels[0];
  return first != null && parseDispatcharrIds(first.extinf_line) !== null;
}

export interface DispatcharrStreamEntry {
  ref: DispatcharrStreamRef;
  result: ChannelResult;
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
  primaryDead: boolean;
  hasDead: boolean;
  allDead: boolean;
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

export function dispatcharrStreamName(entry: DispatcharrStreamEntry): string {
  return entry.ref.streamName ?? entry.result.name;
}

export function isDeadStatus(status: ChannelResult["status"]): boolean {
  return status === "dead";
}

export function isUntestedStatus(status: ChannelResult["status"]): boolean {
  return status === "pending" || status === "checking";
}

function buildView(results: ChannelResult[], orders: DispatcharrOrders): DispatcharrView | null {
  const byChannel = new Map<
    number,
    { name: string; group: string; streams: DispatcharrStreamEntry[] }
  >();
  for (const result of results) {
    const ref = cachedIds(result.extinf_line);
    if (!ref) continue;
    let channel = byChannel.get(ref.channelId);
    if (!channel) {
      channel = { name: result.name, group: result.group, streams: [] };
      byChannel.set(ref.channelId, channel);
    }
    if (!channel.streams.some((entry) => entry.ref.streamId === ref.streamId)) {
      channel.streams.push({ ref, result });
    }
  }
  if (byChannel.size === 0) return null;

  const channels: DispatcharrChannelView[] = [];
  const byStreamIndex = new Map<number, DispatcharrChannelView>();
  for (const [channelId, channel] of byChannel) {
    const loaded = [...channel.streams].sort((a, b) => a.ref.streamOrder - b.ref.streamOrder);
    const order =
      orders[channelId] ??
      loaded[0]?.ref.channelStreams ??
      loaded.map((entry) => entry.ref.streamId);
    const byStream = new Map(channel.streams.map((entry) => [entry.ref.streamId, entry]));
    const streams = order.flatMap((streamId) => byStream.get(streamId) ?? []);
    if (streams.length === 0) continue;
    const dead = streams.filter((entry) => isDeadStatus(entry.result.status)).length;
    const view: DispatcharrChannelView = {
      channelId,
      name: channel.name,
      group: channel.group,
      streams,
      order,
      primary: streams[0].result,
      alive: streams.filter((entry) => entry.result.status === "alive").length,
      primaryDead: isDeadStatus(streams[0].result.status),
      hasDead: dead > 0,
      allDead: dead === streams.length,
    };
    channels.push(view);
    for (const entry of channel.streams) byStreamIndex.set(entry.result.index, view);
  }
  return {
    channels,
    primaries: channels.map((channel) => channel.primary),
    byChannelId: new Map(channels.map((channel) => [channel.channelId, channel])),
    byPrimaryIndex: new Map(channels.map((channel) => [channel.primary.index, channel])),
    byStreamIndex,
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

/** Channel-level status filters, only offered for Dispatcharr sources. */
export const DISPATCHARR_STATUS_FILTERS = {
  primary_dead: "Primary dead",
  has_dead: "Has dead streams",
  all_dead: "All dead",
} as const;

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

/** Working streams first by resolution (ties keep their order), then
 *  untested ones, then geoblocked, DRM, and placeholder. Dead streams leave
 *  the channel, except when every stream is dead: that channel is left alone. */
export function proposeFixOrder(channel: DispatcharrChannelView): FixProposal {
  if (channel.allDead) return { kind: "all_dead" };
  const alive: DispatcharrStreamEntry[] = [];
  const untested: DispatcharrStreamEntry[] = [];
  const other: DispatcharrStreamEntry[] = [];
  for (const entry of channel.streams) {
    const { status } = entry.result;
    if (status === "alive") alive.push(entry);
    else if (isUntestedStatus(status)) untested.push(entry);
    else if (!isDeadStatus(status)) other.push(entry);
  }
  alive.sort((a, b) => (b.result.height ?? 0) - (a.result.height ?? 0));
  const order = [...alive, ...untested, ...other].map((entry) => entry.ref.streamId);
  const current = channel.streams.map((entry) => entry.ref.streamId);
  if (order.length === current.length && order.every((id, i) => id === current[i])) {
    return { kind: "none" };
  }
  return { kind: "change", order, removed: current.length - order.length };
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
  if (Object.keys(orders).length === 0) return null;
  const view = getDispatcharrView(results, orders);
  if (!view) return null;
  const linked = view.channels.flatMap((channel) =>
    channel.streams.map((entry) => entry.result.index),
  );
  return linked.length < results.length ? linked.sort((a, b) => a - b) : null;
}

function setAttribute(extinfLine: string, key: string, value: string): string {
  return extinfLine.replace(new RegExp(`(\\s${key}=)"(?:\\\\.|[^"\\\\])*"`), `$1"${value}"`);
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
