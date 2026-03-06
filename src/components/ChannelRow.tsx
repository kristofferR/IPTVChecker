import { memo, useEffect, useMemo, useState } from "react";
import type { ChannelLogoSize, ChannelResult } from "../lib/types";
import type { ColumnDefinition } from "../lib/tableColumns";
import { Radio, Tv } from "lucide-react";
import { getChannelErrorReason } from "../lib/channelResults";
import { StatusBadge } from "./StatusBadge";
import { extractTvgLogoUrl } from "../lib/extinf";
import { channelLogoPixels, channelRowHeightPixels } from "../lib/channelLogoSize";
import { detectChannelProtocol } from "../lib/streamProtocol";

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
  const logoUrl = useMemo(() => extractTvgLogoUrl(result.extinf_line), [result.extinf_line]);
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoSizePx = useMemo(() => channelLogoPixels(channelLogoSize), [channelLogoSize]);
  const rowHeightPx = useMemo(() => channelRowHeightPixels(channelLogoSize), [channelLogoSize]);
  const kindIconSizePx = useMemo(
    () => Math.max(14, Math.round(logoSizePx * 0.78)),
    [logoSizePx],
  );
  const errorReason = getChannelErrorReason(result);
  const drmStatusTitle = result.drm_system
    ? `DRM: ${result.drm_system}`
    : "DRM-protected stream";
  const streamProtocol = useMemo(() => detectChannelProtocol(result), [result]);

  useEffect(() => {
    setLogoLoadFailed(false);
  }, [logoUrl]);

  const renderCell = (column: ColumnDefinition) => {
    switch (column.key) {
      case "index":
        return (
          <span className="text-text-tertiary tabular-nums">
            {result.index + 1}
          </span>
        );
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
        const ChannelKindIcon = result.audio_only ? Radio : Tv;
        const kindLabel = result.audio_only ? "Audio-only stream" : "Video stream";
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5 px-2 font-medium">
            {logoUrl && !logoLoadFailed ? (
              <img
                src={logoUrl}
                alt={`${result.name} logo`}
                className="shrink-0 rounded-sm object-contain ring-1 ring-border-subtle bg-panel-subtle"
                style={{ width: `${logoSizePx}px`, height: `${logoSizePx}px` }}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => {
                  setLogoLoadFailed(true);
                }}
              />
            ) : (
              <span
                className={`shrink-0 ${
                  result.audio_only ? "text-cyan-400" : "text-text-tertiary"
                }`}
                aria-label={kindLabel}
                title={kindLabel}
              >
                <ChannelKindIcon size={kindIconSizePx} aria-hidden="true" />
              </span>
            )}
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
        return (
          <span className="truncate px-2 text-text-secondary">
            {result.group}
          </span>
        );
      case "resolution":
        return (
          <span className="text-text-secondary tabular-nums">
            {isAlive ? (result.resolution ?? "—") : "—"}
          </span>
        );
      case "codec":
        return (
          <span className="text-text-secondary">
            {isAlive ? (result.codec ?? "—") : "—"}
          </span>
        );
      case "fps":
        return (
          <span className="text-text-secondary tabular-nums">
            {isAlive && result.fps ? result.fps : "—"}
          </span>
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
            {isAlive && result.video_bitrate ? result.video_bitrate : "—"}
          </span>
        );
      case "audio":
        return (
          <span className="text-text-secondary tabular-nums">
            {isAlive && result.audio_bitrate
              ? `${result.audio_bitrate} kbps`
              : "—"}
          </span>
        );
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
          <div
            key={column.key}
            className={`h-full flex items-center ${alignClass}`}
          >
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
