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
}

/** Base URL of a Dispatcharr instance, accepting pasted proxy, output, or API
 *  URLs and keeping any reverse-proxy path prefix. */
export function normalizeDispatcharrServer(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    const lower = parsed.pathname.toLowerCase();
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

function channelNameOf(result: ChannelResult, ref: DispatcharrStreamRef): string {
  if (ref.streamCount <= 1) return result.name;
  const cut = result.name.indexOf(` [${ref.streamOrder + 1}/${ref.streamCount}]`);
  return cut >= 0 ? result.name.slice(0, cut) : result.name;
}

/** Stream name without the "Channel [n/m] " prefix. */
export function dispatcharrStreamName(entry: DispatcharrStreamEntry): string {
  const { result, ref } = entry;
  if (ref.streamCount <= 1) return result.name;
  const marker = ` [${ref.streamOrder + 1}/${ref.streamCount}] `;
  const cut = result.name.indexOf(marker);
  return cut >= 0 ? result.name.slice(cut + marker.length) : result.name;
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
      channel = { name: channelNameOf(result, ref), group: result.group, streams: [] };
      byChannel.set(ref.channelId, channel);
    }
    if (!channel.streams.some((entry) => entry.ref.streamId === ref.streamId)) {
      channel.streams.push({ ref, result });
    }
  }
  if (byChannel.size === 0) return null;

  const channels: DispatcharrChannelView[] = [];
  for (const [channelId, channel] of byChannel) {
    const order = orders[channelId];
    let streams: DispatcharrStreamEntry[];
    if (order) {
      const byStream = new Map(channel.streams.map((entry) => [entry.ref.streamId, entry]));
      streams = order.flatMap((streamId) => byStream.get(streamId) ?? []);
    } else {
      streams = channel.streams.sort((a, b) => a.ref.streamOrder - b.ref.streamOrder);
    }
    if (streams.length === 0) continue;
    const dead = streams.filter((entry) => isDeadStatus(entry.result.status)).length;
    channels.push({
      channelId,
      name: channel.name,
      group: channel.group,
      streams,
      primary: streams[0].result,
      alive: streams.filter((entry) => entry.result.status === "alive").length,
      primaryDead: isDeadStatus(streams[0].result.status),
      hasDead: dead > 0,
      allDead: dead === streams.length,
    });
  }
  return {
    channels,
    primaries: channels.map((channel) => channel.primary),
    byChannelId: new Map(channels.map((channel) => [channel.channelId, channel])),
    byPrimaryIndex: new Map(channels.map((channel) => [channel.primary.index, channel])),
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
