import { useAppStore } from "../store";
import {
  type DispatcharrView,
  getDispatcharrView,
  proposeFixOrder,
  withHiddenStreams,
} from "./dispatcharr";
import { errorToString } from "./errors";
import { dispatcharrGetChannelStreams, dispatcharrSetChannelStreams } from "./tauri";
import type { ChannelResult } from "./types";

/** A channel's stream order as loaded (`from`) and as intended (`to`). */
export interface OrderChange {
  channelId: number;
  from: number[];
  to: number[];
}

export interface ApplyOutcome {
  applied: OrderChange[];
  failed: number;
}

const WRITE_CONCURRENCY = 4;

function currentPrimary(channelId: number): ChannelResult | undefined {
  const { flatResults, dispatcharrOrders } = useAppStore.getState();
  return getDispatcharrView(flatResults, dispatcharrOrders)?.byChannelId.get(channelId)?.primary;
}

/** A selected channel is its primary stream; keep the selection (sidebar,
 *  Play) on the channel when a write changes which stream that is. */
function followPrimary(before: ChannelResult | undefined, after: ChannelResult | undefined) {
  const store = useAppStore.getState();
  if (before && after && before !== after && store.selectedChannel?.index === before.index) {
    store.setSelectedChannel(after);
  }
}

const sameOrder = (a: number[], b: number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Write stream orders to Dispatcharr. Each channel is re-fetched first and
 *  refused if it no longer matches `from`, so edits made in Dispatcharr since
 *  load are never overwritten. A failed channel never stops the others. */
async function writeOrders(requested: OrderChange[], undoing: boolean): Promise<ApplyOutcome> {
  const store = useAppStore.getState();
  const sourceIdentity = store.playlist?.source_identity;
  // A channel already being written keeps its first write; a second one
  // would start from the same stale order.
  const changes = requested.filter(
    (change) => store.dispatcharrRowStates[change.channelId]?.kind !== "writing",
  );
  // Results that land after the user opened another source are dropped.
  const stillCurrent = () => useAppStore.getState().playlist?.source_identity === sourceIdentity;
  const fail = (change: OrderChange, error: string) =>
    store.setDispatcharrRowState(change.channelId, {
      kind: "failed",
      error,
      retry: { from: change.from, to: change.to },
    });
  if (!sourceIdentity || changes.length === 0) {
    for (const change of changes) fail(change, "Not connected to Dispatcharr");
    return { applied: [], failed: changes.length };
  }

  for (const change of changes) {
    store.setDispatcharrRowState(change.channelId, { kind: "writing" });
  }

  let current: Map<number, number[]>;
  try {
    const fresh = await dispatcharrGetChannelStreams(
      sourceIdentity,
      changes.map((change) => change.channelId),
    );
    current = new Map(fresh.map((channel) => [channel.channel_id, channel.stream_ids]));
  } catch (error) {
    const message = errorToString(error);
    if (stillCurrent()) for (const change of changes) fail(change, message);
    return { applied: [], failed: changes.length };
  }
  if (!stillCurrent()) return { applied: [], failed: 0 };

  const applied: OrderChange[] = [];
  let failed = 0;
  const queue = [...changes];
  const worker = async () => {
    for (let change = queue.shift(); change; change = queue.shift()) {
      const server = current.get(change.channelId);
      if (!server) {
        fail(change, "Channel no longer exists in Dispatcharr");
        failed += 1;
        continue;
      }
      if (!sameOrder(server, change.from)) {
        fail(change, "Changed in Dispatcharr. Reload first.");
        failed += 1;
        continue;
      }
      try {
        await dispatcharrSetChannelStreams(sourceIdentity, change.channelId, change.to);
        if (!stillCurrent()) return;
        const primaryBefore = currentPrimary(change.channelId);
        store.commitDispatcharrOrder(change.channelId, change.to, undoing ? null : change.from);
        store.setDispatcharrRowState(change.channelId, undoing ? null : { kind: "fixed" });
        followPrimary(primaryBefore, currentPrimary(change.channelId));
        applied.push(change);
      } catch (error) {
        if (!stillCurrent()) return;
        fail(change, errorToString(error));
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, changes.length) }, worker));
  return { applied, failed };
}

export function applyOrderChanges(changes: OrderChange[]): Promise<ApplyOutcome> {
  return writeOrders(changes, false);
}

/** Restore the order each channel had before its last edit. The drift check
 *  compares against the order that was written, which can hold streams the
 *  loaded playlist has no row for. */
export async function undoChannels(channelIds: number[]): Promise<ApplyOutcome> {
  const { dispatcharrUndo, dispatcharrOrders } = useAppStore.getState();
  const changes = channelIds.flatMap((channelId) => {
    const previous = dispatcharrUndo[channelId];
    const written = dispatcharrOrders[channelId];
    return previous && written ? [{ channelId, from: written, to: previous }] : [];
  });
  return writeOrders(changes, true);
}

/** Reverse the given writes. A channel already back at its earlier order is
 *  skipped; one edited since is refused by the drift check. */
export function reverseChanges(changes: OrderChange[]): Promise<ApplyOutcome> {
  const orders = useAppStore.getState().dispatcharrOrders;
  const pending = changes.filter((change) => {
    const current = orders[change.channelId];
    return !(current && sameOrder(current, change.from));
  });
  return writeOrders(
    pending.map((change) => ({ channelId: change.channelId, from: change.to, to: change.from })),
    true,
  );
}

export interface FixPlan {
  changes: OrderChange[];
  reordered: number;
  removed: number;
  skippedAllDead: number;
}

/** Fix-order changes for the given channels (see `proposeFixOrder`). */
export function planFix(view: DispatcharrView, channelIds: Iterable<number>): FixPlan {
  const plan: FixPlan = { changes: [], reordered: 0, removed: 0, skippedAllDead: 0 };
  for (const channelId of channelIds) {
    const channel = view.byChannelId.get(channelId);
    if (!channel) continue;
    const proposal = proposeFixOrder(channel);
    if (proposal.kind === "all_dead") {
      plan.skippedAllDead += 1;
    } else if (proposal.kind === "change") {
      const visible = channel.streams.map((entry) => entry.ref.streamId);
      plan.changes.push({
        channelId,
        from: channel.order,
        to: withHiddenStreams(channel, proposal.order),
      });
      plan.removed += proposal.removed;
      // Reordered when the streams that stay change their relative order.
      const kept = visible.filter((id) => proposal.order.includes(id));
      if (!sameOrder(kept, proposal.order)) plan.reordered += 1;
    }
  }
  return plan;
}

/** Apply a bulk fix and summarize it in the toast. */
export async function applyFixPlan(plan: FixPlan): Promise<void> {
  const { applied, failed } = await applyOrderChanges(plan.changes);
  const removed = applied.reduce(
    (sum, change) => sum + change.from.filter((id) => !change.to.includes(id)).length,
    0,
  );
  useAppStore.getState().setDispatcharrToast({
    fixed: applied.length,
    removed,
    failed,
    changes: applied,
  });
}
