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

export interface DispatcharrChannelGroup {
  channelId: number;
  /** Channel name without the "[n/m] stream" suffix of multi-stream rows. */
  name: string;
  group: string;
  /** Streams in the failover order seen at load time. */
  streams: DispatcharrStreamEntry[];
}

/** Group scan results by Dispatcharr channel, keeping channel order as it
 *  first appears and streams in their loaded failover order. */
export function groupResultsByDispatcharrChannel(
  results: ChannelResult[],
): DispatcharrChannelGroup[] {
  const groups = new Map<number, DispatcharrChannelGroup>();
  for (const result of results) {
    const ref = parseDispatcharrIds(result.extinf_line);
    if (!ref) continue;
    let group = groups.get(ref.channelId);
    if (!group) {
      const suffix = ` [${ref.streamOrder + 1}/${ref.streamCount}]`;
      const cut = ref.streamCount > 1 ? result.name.indexOf(suffix) : -1;
      group = {
        channelId: ref.channelId,
        name: cut >= 0 ? result.name.slice(0, cut) : result.name,
        group: result.group,
        streams: [],
      };
      groups.set(ref.channelId, group);
    }
    if (!group.streams.some((entry) => entry.ref.streamId === ref.streamId)) {
      group.streams.push({ ref, result });
    }
  }
  for (const group of groups.values()) {
    group.streams.sort((a, b) => a.ref.streamOrder - b.ref.streamOrder);
  }
  return [...groups.values()];
}
