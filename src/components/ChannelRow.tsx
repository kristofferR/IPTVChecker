import { memo, useMemo } from "react";
import { formatCount, t } from "../i18n";
import { translateReason } from "../i18n/reasons";
import { archiveBadgeText, archiveTitle } from "../lib/archive";
import {
  archiveDepthMeasured,
  archiveFailure,
  archiveFailureLabel,
  archiveFailureSentence,
  archiveVerdict,
  measuredDepthDays,
} from "../lib/archiveVerification";
import { channelLogoPixels, channelRowHeightPixels } from "../lib/channelLogoSize";
import { getChannelErrorReason } from "../lib/channelResults";
import { formatLatency } from "../lib/format";
import { detectChannelProtocol } from "../lib/streamProtocol";
import type { ColumnDefinition } from "../lib/tableColumns";
import type { ChannelLogoSize, ChannelResult } from "../lib/types";
import { useAppStore } from "../store";
import type { DispatcharrRowState } from "../store/types";
import { ChannelLogo } from "./ChannelLogo";
import {
  ChannelHealth,
  ChannelNameCell,
  type DispatcharrRowActions,
  type DispatcharrRowMeta,
  StreamNameCell,
} from "./DispatcharrCells";
import { StatusBadge } from "./StatusBadge";

function latencyTone(latencyMs: number): string {
  if (latencyMs < 500) {
    return "text-green-400";
  }
  if (latencyMs <= 2000) {
    return "text-yellow-400";
  }
  return "text-red-400";
}

interface ChannelRowProps {
  rowIndex: number;
  result: ChannelResult;
  channelLogoSize: ChannelLogoSize;
  onRowClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  selected: boolean;
  duplicate?: boolean;
  focused?: boolean;
  columns: ColumnDefinition[];
  gridTemplateColumns: string;
  tableWidth: number;
  onRowDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRowContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** Set for Dispatcharr sources: a channel row or one of its streams. */
  dispatcharr?: DispatcharrRowMeta;
  dispatcharrRowState?: DispatcharrRowState;
  dispatcharrActions?: DispatcharrRowActions;
  /** A stream row being dragged, or the drop point before/after it. */
  dragState?: "dragging" | "before" | "after";
}

export type { DispatcharrRowMeta, StreamAction } from "./DispatcharrCells";

function ChannelRowImpl({
  rowIndex,
  result,
  channelLogoSize,
  onRowClick,
  selected,
  duplicate,
  focused,
  columns,
  gridTemplateColumns,
  tableWidth,
  onRowDoubleClick,
  onRowContextMenu,
  dispatcharr,
  dispatcharrRowState,
  dispatcharrActions,
  dragState,
}: ChannelRowProps) {
  const isAlive = result.status === "alive";
  const logoSizePx = useMemo(() => channelLogoPixels(channelLogoSize), [channelLogoSize]);
  const rowHeightPx = useMemo(() => channelRowHeightPixels(channelLogoSize), [channelLogoSize]);
  const rawErrorReason = getChannelErrorReason(result);
  const errorReason = rawErrorReason ? translateReason(rawErrorReason) : null;
  const drmStatusTitle = result.drm_system
    ? t("table.drmSystem", { system: translateReason(result.drm_system) })
    : t("table.drmProtected");
  const streamProtocol = useMemo(() => detectChannelProtocol(result), [result]);
  const probeEntry = useAppStore((s) => s.archiveProbes[result.index]);

  const renderDispatcharrCell = (column: ColumnDefinition, meta: DispatcharrRowMeta) => {
    const isChannel = meta.kind === "channel";
    switch (column.key) {
      case "index":
        return isChannel ? (
          <span className="text-text-tertiary tabular-nums">
            {result.tvg_chno ?? result.index + 1}
          </span>
        ) : (
          <span className="ps-3 text-text-tertiary tabular-nums">{meta.position + 1}</span>
        );
      case "status":
        return isChannel ? <ChannelHealth channel={meta.channel} /> : undefined;
      case "name":
        return isChannel ? (
          <ChannelNameCell
            channel={meta.channel}
            expanded={meta.expanded}
            rowState={dispatcharrRowState}
            actions={dispatcharrActions}
            logo={<ChannelLogo result={result} size={logoSizePx} />}
          />
        ) : (
          <StreamNameCell
            channel={meta.channel}
            entry={meta.entry}
            position={meta.position}
            actions={dispatcharrActions}
          />
        );
      case "group":
        return isChannel ? undefined : null;
      default:
        return undefined;
    }
  };

  const renderCell = (column: ColumnDefinition) => {
    if (dispatcharr) {
      const cell = renderDispatcharrCell(column, dispatcharr);
      if (cell !== undefined) return cell;
    }
    switch (column.key) {
      case "index":
        return <span className="text-text-tertiary tabular-nums">{result.index + 1}</span>;
      case "status":
        return (
          <StatusBadge
            status={result.status}
            title={
              result.status === "dead"
                ? (errorReason ?? undefined)
                : result.status === "drm"
                  ? drmStatusTitle
                  : undefined
            }
          />
        );
      case "error":
        return (
          <span className="truncate px-2 text-text-secondary" title={errorReason ?? undefined}>
            {isAlive ? "—" : (errorReason ?? "—")}
          </span>
        );
      case "playlist":
        return (
          <span className="truncate px-2 text-text-secondary" title={result.playlist}>
            {result.playlist}
          </span>
        );
      case "name": {
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5 px-2 font-medium">
            <ChannelLogo result={result} size={logoSizePx} />
            <span className="truncate">{result.name}</span>
          </span>
        );
      }
      case "url":
        return (
          <span className="flex min-w-0 items-center gap-2 px-2">
            {duplicate && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-300 ring-1 ring-amber-500/30">
                {t("table.duplicate")}
              </span>
            )}
            {streamProtocol && (
              <span className="rounded bg-panel-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-text-tertiary ring-1 ring-border-subtle">
                {streamProtocol}
              </span>
            )}
            <span className="truncate text-text-secondary" title={result.url}>
              {result.url}
            </span>
          </span>
        );
      case "group":
        return <span className="truncate px-2 text-text-secondary">{result.group}</span>;
      case "resolution":
        return <span className="text-text-secondary tabular-nums">{result.resolution ?? "—"}</span>;
      case "codec":
        return <span className="text-text-secondary">{result.codec ?? "—"}</span>;
      case "hdr":
        return <span className="text-text-secondary">{result.hdr_format ?? "—"}</span>;
      case "fps":
        return (
          <span className="text-text-secondary tabular-nums">{result.fps ? result.fps : "—"}</span>
        );
      case "latency": {
        if (result.latency_ms == null) {
          return <span className="text-text-secondary tabular-nums">—</span>;
        }
        return (
          <span className={`tabular-nums ${latencyTone(result.latency_ms)}`}>
            {formatLatency(result.latency_ms)}
          </span>
        );
      }
      case "bitrate":
        return (
          <span className="text-text-secondary tabular-nums">
            {result.video_bitrate ? result.video_bitrate : "—"}
          </span>
        );
      case "audio":
        return (
          <span className="text-text-secondary tabular-nums">
            {result.audio_bitrate ? t("format.kbps", { value: result.audio_bitrate }) : "—"}
          </span>
        );
      case "audio_codec":
        return (
          <span className="text-text-secondary">
            {result.audio_codec && result.audio_codec !== "Unknown" ? result.audio_codec : "—"}
          </span>
        );
      case "audio_layout":
        return <span className="text-text-secondary">{result.audio_channel_layout ?? "—"}</span>;
      case "catchup": {
        const badge = archiveBadgeText(result);
        if (!badge) {
          return <span className="text-text-secondary tabular-nums">—</span>;
        }
        const verdict = archiveVerdict(result, probeEntry);
        const failure = verdict === "fake" ? archiveFailure(probeEntry) : null;
        const chipClass = {
          advertised: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
          verified: "bg-green-500/15 text-green-300 ring-green-500/30",
          shallower: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
          fake: "bg-red-500/15 text-red-300 ring-red-500/30",
        }[verdict];
        const measured = verdict === "shallower" ? measuredDepthDays(probeEntry) : null;
        const measuredText = measured == null ? "?" : formatCount(measured);
        const days = result.catchup_days == null ? "?" : formatCount(result.catchup_days);
        const chipText =
          verdict === "verified"
            ? `✓ ${badge}`
            : verdict === "shallower"
              ? t("table.catchup.shallowerChip", {
                  measured: measured != null && measured < 1 ? "<1" : measuredText,
                  days,
                })
              : verdict === "fake"
                ? `✕ ${failure ? archiveFailureLabel(failure) : badge}`
                : badge;
        const verdictTitle =
          verdict === "advertised"
            ? null
            : verdict === "shallower"
              ? measured != null && measured < 1
                ? t("table.catchup.depthBelowOne", { days })
                : t("table.catchup.depth", { measured: measuredText, days })
              : verdict === "fake"
                ? failure
                  ? t("table.catchup.fake", { reason: archiveFailureSentence(failure) })
                  : t("table.catchup.fakeNoAnswer")
                : archiveDepthMeasured(probeEntry)
                  ? t("table.catchup.verifiedFull")
                  : t("table.catchup.verifiedQuick");
        return (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ring-1 tabular-nums ${chipClass}`}
            title={[archiveTitle(result), verdictTitle].filter(Boolean).join(" · ") || undefined}
          >
            {chipText}
          </span>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div
      data-row-index={rowIndex}
      className={`channel-row group select-none grid items-center px-4 text-sm border-b hover:bg-panel-subtle ${
        dispatcharr?.kind === "stream" ? "bg-black/15" : ""
      } ${dispatcharrRowState?.kind === "fixed" && !selected ? "bg-green-500/5" : ""} ${
        selected ? "selected bg-panel-subtle border-transparent" : "border-border-subtle"
      } ${duplicate && !selected ? "bg-amber-500/8" : ""} ${
        duplicate ? "ring-1 ring-amber-500/20" : ""
      } ${focused ? "ring-1 ring-border-app" : ""} ${dragState === "dragging" ? "opacity-40" : ""} ${
        dispatcharr?.kind === "stream" &&
        dispatcharrActions?.canWrite &&
        !dispatcharrActions.disabled
          ? "cursor-grab"
          : ""
      }`}
      style={{
        boxShadow:
          dragState === "before"
            ? "inset 0 2px 0 rgb(59 130 246)"
            : dragState === "after"
              ? "inset 0 -2px 0 rgb(59 130 246)"
              : undefined,
        gridTemplateColumns,
        width: `${tableWidth}px`,
        minWidth: `${tableWidth}px`,
        height: `${rowHeightPx}px`,
      }}
      onClick={onRowClick}
      onDoubleClick={onRowDoubleClick}
      onContextMenu={onRowContextMenu}
    >
      {columns.map((column) => {
        const alignClass =
          column.align === "right"
            ? "justify-end text-end"
            : column.align === "center"
              ? "justify-center text-center"
              : "justify-start text-start";

        return (
          <div key={column.key} className={`h-full flex items-center ${alignClass}`}>
            {renderCell(column)}
          </div>
        );
      })}
    </div>
  );
}

function equalChannelRowProps(
  previous: Readonly<ChannelRowProps>,
  next: Readonly<ChannelRowProps>,
): boolean {
  return (
    previous.rowIndex === next.rowIndex &&
    previous.result === next.result &&
    previous.channelLogoSize === next.channelLogoSize &&
    previous.selected === next.selected &&
    previous.duplicate === next.duplicate &&
    previous.focused === next.focused &&
    previous.columns === next.columns &&
    previous.gridTemplateColumns === next.gridTemplateColumns &&
    previous.tableWidth === next.tableWidth &&
    previous.onRowClick === next.onRowClick &&
    previous.onRowDoubleClick === next.onRowDoubleClick &&
    previous.onRowContextMenu === next.onRowContextMenu &&
    previous.dispatcharr === next.dispatcharr &&
    previous.dispatcharrRowState === next.dispatcharrRowState &&
    previous.dispatcharrActions === next.dispatcharrActions &&
    previous.dragState === next.dragState
  );
}

export const ChannelRow = memo(ChannelRowImpl, equalChannelRowProps);
