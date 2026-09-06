import { memo, useMemo } from "react";
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
import { detectChannelProtocol } from "../lib/streamProtocol";
import type { ColumnDefinition } from "../lib/tableColumns";
import type { ChannelLogoSize, ChannelResult } from "../lib/types";
import { useAppStore } from "../store";
import { ChannelLogo } from "./ChannelLogo";
import { StatusBadge } from "./StatusBadge";

function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) {
    return `${latencyMs} ms`;
  }
  return `${(latencyMs / 1000).toFixed(1)} s`;
}

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
}

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
}: ChannelRowProps) {
  const isAlive = result.status === "alive";
  const logoSizePx = useMemo(() => channelLogoPixels(channelLogoSize), [channelLogoSize]);
  const rowHeightPx = useMemo(() => channelRowHeightPixels(channelLogoSize), [channelLogoSize]);
  const errorReason = getChannelErrorReason(result);
  const drmStatusTitle = result.drm_system ? `DRM: ${result.drm_system}` : "DRM-protected stream";
  const streamProtocol = useMemo(() => detectChannelProtocol(result), [result]);
  const probeEntry = useAppStore((s) => s.archiveProbes[result.index]);

  const renderCell = (column: ColumnDefinition) => {
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
                duplicate
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
            {result.audio_bitrate ? `${result.audio_bitrate} kbps` : "—"}
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
        const measuredLabel = measured != null && measured < 1 ? "<1" : measured;
        const chipText =
          verdict === "verified"
            ? `✓ ${badge}`
            : verdict === "shallower"
              ? `⚠ ${measuredLabel ?? "?"}/${result.catchup_days ?? "?"}d`
              : verdict === "fake"
                ? `✕ ${failure ? archiveFailureLabel(failure) : badge}`
                : badge;
        const verdictTitle =
          verdict === "advertised"
            ? null
            : verdict === "shallower"
              ? measured != null && measured < 1
                ? `Verified depth less than 1 of ${result.catchup_days ?? "?"} days`
                : `Verified depth ${measured ?? "?"} of ${result.catchup_days ?? "?"} days`
              : verdict === "fake"
                ? `Fake catch-up: ${failure ? archiveFailureSentence(failure) : "the archive does not answer"}`
                : archiveDepthMeasured(probeEntry)
                  ? "Archive verified at the advertised depth"
                  : "Archive verified one hour back (quick check)";
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
      className={`channel-row select-none grid items-center px-4 text-sm border-b hover:bg-panel-subtle ${
        selected ? "selected bg-panel-subtle border-transparent" : "border-border-subtle"
      } ${duplicate && !selected ? "bg-amber-500/8" : ""} ${
        duplicate ? "ring-1 ring-amber-500/20" : ""
      } ${focused ? "ring-1 ring-border-app" : ""}`}
      style={{
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
            ? "justify-end text-right"
            : column.align === "center"
              ? "justify-center text-center"
              : "justify-start text-left";

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
    previous.onRowContextMenu === next.onRowContextMenu
  );
}

export const ChannelRow = memo(ChannelRowImpl, equalChannelRowProps);
