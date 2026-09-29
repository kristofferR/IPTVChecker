import { ArrowDown, ArrowUp, ChevronRight, X } from "lucide-react";
import { useMemo } from "react";
import { useFixPreferences } from "../hooks/useFixPreferences";
import {
  type DispatcharrChannelView,
  type DispatcharrStreamEntry,
  dispatcharrStreamName,
  proposeFixOrder,
} from "../lib/dispatcharr";
import type { ChannelStatus } from "../lib/types";
import type { DispatcharrRowState } from "../store/types";

export type StreamAction = "primary" | "up" | "down" | "remove";

export type DispatcharrRowMeta =
  | { kind: "channel"; channel: DispatcharrChannelView; expanded: boolean }
  | {
      kind: "stream";
      channel: DispatcharrChannelView;
      entry: DispatcharrStreamEntry;
      position: number;
    };

export interface DispatcharrRowActions {
  /** Edits wait while a scan runs, since orders are judged on its results. */
  disabled: boolean;
  onToggleExpand: (channelId: number) => void;
  onFix: (channel: DispatcharrChannelView) => void;
  onUndo: (channel: DispatcharrChannelView) => void;
  onRetry: (channel: DispatcharrChannelView) => void;
  onStreamAction: (channel: DispatcharrChannelView, position: number, action: StreamAction) => void;
}

const BAR_COLOR: Record<ChannelStatus, string> = {
  alive: "bg-green-500",
  dead: "bg-red-500",
  pending: "bg-zinc-500",
  checking: "bg-blue-400",
  drm: "bg-cyan-500",
  placeholder: "bg-orange-500",
  geoblocked: "bg-yellow-500",
  geoblocked_confirmed: "bg-yellow-500",
  geoblocked_unconfirmed: "bg-yellow-500",
};

const buttonClass =
  "shrink-0 rounded-md border border-border-app bg-btn px-2 py-0.5 text-[11px] text-text-primary hover:bg-btn-hover disabled:opacity-40 disabled:pointer-events-none";
const iconButtonClass =
  "rounded-md border border-border-app bg-btn p-0.5 text-text-secondary hover:bg-btn-hover hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none";
const linkClass = "shrink-0 text-[12px] text-blue-400 hover:text-blue-300";

/** Row handlers already ignore clicks on buttons; this also keeps the
 *  table's own focus and context handling out of it. */
const stop = (event: React.MouseEvent) => event.stopPropagation();

/** One bar per stream in failover order (the primary wider and set apart),
 *  then alive/total. */
export function ChannelHealth({ channel }: { channel: DispatcharrChannelView }) {
  const countTone = channel.allDead
    ? "text-red-400"
    : channel.primaryDead
      ? "text-yellow-400"
      : "text-text-secondary";
  const title = channel.streams
    .map(
      (entry, i) =>
        `${i + 1}. ${dispatcharrStreamName(entry)}: ${
          entry.providerDown ? "provider down" : entry.result.status
        }`,
    )
    .join("\n");
  return (
    <span className="inline-flex min-w-0 items-center gap-2 px-2" title={title}>
      <span
        className={`flex h-3 w-16 shrink-0 items-stretch ${
          channel.streams.length > 12 ? "" : "gap-[2px]"
        }`}
      >
        {channel.streams.map((entry, i) => (
          <i
            key={entry.ref.streamId}
            className={`rounded-[1px] ${entry.providerDown ? "bg-amber-500" : BAR_COLOR[entry.result.status]} ${
              i === 0 ? "mr-[3px] w-[6px] shrink-0" : "min-w-px max-w-[4px] flex-1"
            }`}
          />
        ))}
      </span>
      <span className={`text-[12px] tabular-nums ${countTone}`}>
        {channel.alive}/{channel.streams.length}
      </span>
    </span>
  );
}

function ChannelRowStatus({
  channel,
  rowState,
  actions,
}: {
  channel: DispatcharrChannelView;
  rowState: DispatcharrRowState | undefined;
  actions: DispatcharrRowActions | undefined;
}) {
  switch (rowState?.kind) {
    case "writing":
      return <span className="text-[12px] text-text-tertiary">Saving...</span>;
    case "fixed":
      return (
        <>
          <span className="shrink-0 text-[12px] text-green-400">Fixed</span>
          {actions && (
            <button
              type="button"
              className={linkClass}
              disabled={actions.disabled}
              onClick={(event) => {
                stop(event);
                actions.onUndo(channel);
              }}
            >
              Undo
            </button>
          )}
        </>
      );
    case "failed":
      return (
        <>
          <span className="truncate text-[12px] text-red-400" title={rowState.error}>
            {rowState.error}
          </span>
          {actions && (
            <button
              type="button"
              className={linkClass}
              disabled={actions.disabled}
              onClick={(event) => {
                stop(event);
                actions.onRetry(channel);
              }}
            >
              Retry
            </button>
          )}
        </>
      );
    default:
      if (channel.allDead) return <span className="text-[12px] text-red-400">All dead</span>;
      if (channel.primaryDead)
        return <span className="text-[12px] text-red-400">Primary dead</span>;
      if (channel.primaryProviderDown)
        return <span className="text-[12px] text-amber-400">Provider down</span>;
      return null;
  }
}

export function ChannelNameCell({
  channel,
  expanded,
  rowState,
  actions,
  logo,
}: {
  channel: DispatcharrChannelView;
  expanded: boolean;
  rowState: DispatcharrRowState | undefined;
  actions: DispatcharrRowActions | undefined;
  logo: React.ReactNode;
}) {
  const preferences = useFixPreferences();
  const canFix = useMemo(
    () => proposeFixOrder(channel, preferences).kind === "change",
    [channel, preferences],
  );
  const busy = rowState?.kind === "writing";
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
      <button
        type="button"
        aria-label={expanded ? `Collapse ${channel.name}` : `Expand ${channel.name}`}
        aria-expanded={expanded}
        onClick={(event) => {
          stop(event);
          actions?.onToggleExpand(channel.channelId);
        }}
        className="-ml-1 shrink-0 rounded p-0.5 text-text-tertiary hover:text-text-primary"
      >
        <ChevronRight className={`h-3.5 w-3.5 ${expanded ? "rotate-90" : ""}`} />
      </button>
      {logo}
      <span className="min-w-24 truncate font-medium">{channel.name}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2 pl-2">
        <ChannelRowStatus channel={channel} rowState={rowState} actions={actions} />
        {actions && canFix && !busy && rowState?.kind !== "failed" && (
          <button
            type="button"
            className={`${buttonClass} ${expanded ? "" : "sr-only group-hover:not-sr-only focus:not-sr-only"}`}
            disabled={actions.disabled}
            title={actions.disabled ? "Available when the scan finishes" : undefined}
            onClick={(event) => {
              stop(event);
              actions.onFix(channel);
            }}
          >
            Fix order
          </button>
        )}
      </span>
    </span>
  );
}

export function StreamNameCell({
  channel,
  entry,
  position,
  actions,
}: {
  channel: DispatcharrChannelView;
  entry: DispatcharrStreamEntry;
  position: number;
  actions: DispatcharrRowActions | undefined;
}) {
  const last = position === channel.streams.length - 1;
  const act = (action: StreamAction) => (event: React.MouseEvent) => {
    stop(event);
    actions?.onStreamAction(channel, position, action);
  };
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 pl-8 pr-2">
      <span className="shrink-0 text-text-primary">{entry.ref.account ?? "Unknown"}</span>
      <span className="truncate text-text-tertiary">{dispatcharrStreamName(entry)}</span>
      {position === 0 && (
        <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-text-tertiary">
          Primary
        </span>
      )}
      {actions && (
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 sr-only group-hover:not-sr-only focus-within:not-sr-only">
          {position > 0 && (
            <button
              type="button"
              className={buttonClass}
              disabled={actions.disabled}
              onClick={act("primary")}
            >
              Make primary
            </button>
          )}
          <button
            type="button"
            aria-label="Move up"
            className={iconButtonClass}
            disabled={actions.disabled || position === 0}
            onClick={act("up")}
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Move down"
            className={iconButtonClass}
            disabled={actions.disabled || last}
            onClick={act("down")}
          >
            <ArrowDown className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Remove from channel"
            title="Remove from channel"
            className={iconButtonClass}
            disabled={actions.disabled || channel.streams.length === 1}
            onClick={act("remove")}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </span>
  );
}
