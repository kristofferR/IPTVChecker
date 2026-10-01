import { t } from "../i18n";
import { useAppStore } from "../store";
import {
  addedStreamRow,
  DEFAULT_FIX_PREFERENCES,
  type DispatcharrChannelView,
  type DispatcharrView,
  dispatcharrTarget,
  type FixPreferences,
  getDispatcharrView,
  parseDispatcharrIds,
  proposeFixOrder,
  withHiddenStreams,
} from "./dispatcharr";
import { errorToString } from "./errors";
import { dispatcharrSetChannelStreams } from "./tauri";
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

/** Keep the selection (sidebar, Play) on the channel after a write: move
 *  it to the new primary when the selected stream was the old primary or is
 *  no longer linked. */
function followSelection(change: OrderChange, primaryBefore: ChannelResult | undefined) {
  const store = useAppStore.getState();
  const selected = store.selectedChannel;
  const ids = selected ? parseDispatcharrIds(selected.extinf_line) : null;
  if (!selected || !ids || ids.channelId !== change.channelId) return;
  const primaryAfter = currentPrimary(change.channelId);
  if (!primaryAfter || primaryAfter.index === selected.index) return;
  const wasPrimary = primaryBefore?.index === selected.index;
  if (wasPrimary || !change.to.includes(ids.streamId)) {
    store.setSelectedChannel(primaryAfter);
  }
}

const sameOrder = (a: number[], b: number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Write stream orders to Dispatcharr. Each channel is re-read just before
 *  its write and refused if it no longer matches `from`, so edits made in Dispatcharr since
 *  load are never overwritten. A failed channel never stops the others. */
async function writeOrders(
  requested: OrderChange[],
  undoing: boolean,
  label?: string,
): Promise<ApplyOutcome> {
  const store = useAppStore.getState();
  const target = dispatcharrTarget(store.playlist);
  // A channel already being written keeps its first write; a second one
  // would start from the same stale order.
  const changes = requested.filter(
    (change) => store.dispatcharrRowStates[change.channelId]?.kind !== "writing",
  );
  // Results that land after the user opened another source, or reloaded
  // this one, are dropped.
  const epoch = store.dispatcharrEditEpoch;
  const stillCurrent = () => {
    const now = useAppStore.getState();
    const nowTarget = dispatcharrTarget(now.playlist);
    return (
      now.dispatcharrEditEpoch === epoch &&
      nowTarget?.connection === target?.connection &&
      nowTarget?.sourceIdentity === target?.sourceIdentity
    );
  };
  // A source loading replaces the rows the channel ids came from.
  if (store.playlistLoading) {
    return { applied: [], failed: changes.length };
  }
  const fail = (change: OrderChange, error: string) =>
    store.setDispatcharrRowState(change.channelId, {
      kind: "failed",
      error,
      retry: { from: change.from, to: change.to },
    });
  if (!target || changes.length === 0) {
    for (const change of changes) fail(change, t("dispatcharr.notConnected"));
    return { applied: [], failed: changes.length };
  }

  for (const change of changes) {
    store.setDispatcharrRowState(change.channelId, { kind: "writing" });
  }

  const applied: OrderChange[] = [];
  let failed = 0;
  const queue = [...changes];
  const worker = async () => {
    for (let change = queue.shift(); change; change = queue.shift()) {
      try {
        // The backend re-reads the channel and refuses the write if it no
        // longer has `from`, so edits made meanwhile are never overwritten.
        await dispatcharrSetChannelStreams(
          target,
          change.channelId,
          change.to,
          change.from,
          // Undo restores an earlier order, empty only if the channel was.
          undoing,
        );
        if (!stillCurrent()) return;
        const primaryBefore = currentPrimary(change.channelId);
        store.commitDispatcharrOrder(change.channelId, change.to, undoing ? null : change.from);
        store.setDispatcharrRowState(change.channelId, undoing ? null : { kind: "fixed", label });
        followSelection(change, primaryBefore);
        applied.push(change);
      } catch (error) {
        if (!stillCurrent()) return;
        fail(change, errorToString(error));
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, changes.length) }, worker));
  // Writes to a source that is no longer open have nothing left to show
  // or undo here.
  if (!stillCurrent()) return { applied: [], failed: 0 };
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

/** Append rows (streams linked from Find streams), numbered after the
 *  loaded ones. */
export function appendStreamRows(rows: ChannelResult[]): void {
  if (rows.length === 0) return;
  const store = useAppStore.getState();
  let next = store.flatResults.reduce((max, result) => Math.max(max, result.index), -1) + 1;
  const added = rows.map((row) => ({ ...row, index: next++ }));
  const flatResults = [...store.flatResults, ...added];
  store.applyScanCollections({
    flatResults,
    resultPositions: new Map(flatResults.map((result, position) => [result.index, position])),
    uiMetrics: {
      presentCount: flatResults.length,
      lowFpsCount: store.uiMetrics.lowFpsCount + added.filter((row) => row.low_framerate).length,
      mislabeledCount:
        store.uiMetrics.mislabeledCount +
        added.filter((row) => row.label_mismatches.length > 0).length,
    },
  });
}

/** Put back rows linked from Find streams after the results were rebuilt
 *  from the source (a source filter or Hide VOD), for channels still shown. */
export function restoreAddedRows(): void {
  const { flatResults, dispatcharrAddedRows } = useAppStore.getState();
  if (dispatcharrAddedRows.length === 0) return;
  const channels = new Set<number>();
  const streams = new Set<string>();
  for (const row of flatResults) {
    const ref = parseDispatcharrIds(row.extinf_line);
    if (!ref) continue;
    channels.add(ref.channelId);
    streams.add(`${ref.channelId}:${ref.streamId}`);
  }
  appendStreamRows(
    dispatcharrAddedRows.filter((row) => {
      const ref = parseDispatcharrIds(row.extinf_line);
      return ref && channels.has(ref.channelId) && !streams.has(`${ref.channelId}:${ref.streamId}`);
    }),
  );
}

/** Link found provider streams to a channel, first or last in its order.
 *  Streams without a loaded row get one, so the channel shows them now. */
export async function linkStreams(
  channel: DispatcharrChannelView,
  picked: ChannelResult[],
  position: "primary" | "end",
): Promise<boolean> {
  // Only streams found for this channel, never one left over from another.
  const ids = picked.flatMap((result) => {
    const ref = parseDispatcharrIds(result.extinf_line);
    return ref && ref.channelId === channel.channelId ? [ref.streamId] : [];
  });
  if (ids.length === 0) return false;
  const rest = channel.order.filter((id) => !ids.includes(id));
  const to = position === "primary" ? [...ids, ...rest] : [...rest, ...ids];
  const { applied } = await writeOrders(
    [{ channelId: channel.channelId, from: channel.order, to }],
    false,
    t("dispatcharr.cells.linked", { count: ids.length }),
  );
  if (applied.length === 0) return false;

  const loaded = new Set(
    useAppStore.getState().flatResults.flatMap((result) => {
      const ref = parseDispatcharrIds(result.extinf_line);
      return ref?.channelId === channel.channelId ? [ref.streamId] : [];
    }),
  );
  const rows = picked
    .filter((result) => {
      const ref = parseDispatcharrIds(result.extinf_line);
      return ref && !loaded.has(ref.streamId);
    })
    .map((result) => addedStreamRow(result, channel, 0));
  useAppStore.getState().addDispatcharrRows(rows);
  appendStreamRows(rows);
  // The new primary had no row when the write moved the selection; follow it now.
  const store = useAppStore.getState();
  const selected = store.selectedChannel;
  const primary = currentPrimary(channel.channelId);
  if (
    position === "primary" &&
    selected &&
    primary &&
    parseDispatcharrIds(selected.extinf_line)?.channelId === channel.channelId &&
    selected.index !== primary.index
  ) {
    store.setSelectedChannel(primary);
  }
  return true;
}

export interface FixPlan {
  changes: OrderChange[];
  reordered: number;
  removed: number;
  /** Dead streams moved to the end instead (when preferred). */
  movedDead: number;
  skippedAllDead: number;
}

/** Fix-order changes for the given channels (see `proposeFixOrder`). */
export function planFix(
  view: DispatcharrView,
  channelIds: Iterable<number>,
  preferences: FixPreferences = DEFAULT_FIX_PREFERENCES,
): FixPlan {
  const plan: FixPlan = {
    changes: [],
    reordered: 0,
    removed: 0,
    movedDead: 0,
    skippedAllDead: 0,
  };
  for (const channelId of channelIds) {
    const channel = view.byChannelId.get(channelId);
    if (!channel) continue;
    const proposal = proposeFixOrder(channel, preferences);
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
      if (preferences.deadStreams === "move_to_end") {
        plan.movedDead += channel.streams.filter((entry) => entry.result.status === "dead").length;
      }
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
  if (applied.length === 0 && failed === 0) return;
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
