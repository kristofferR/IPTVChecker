import type { ChannelResult } from "../lib/types";
import type {
  ColumnDefinition,
  ColumnKey,
} from "../lib/tableColumns";
import { Radio, Tv } from "lucide-react";
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
  result: ChannelResult;
  onClick: (
    event: React.MouseEvent<HTMLDivElement>,
    result: ChannelResult,
  ) => void;
  selected: boolean;
  duplicate?: boolean;
  focused?: boolean;
  columns: ColumnDefinition[];
  columnWidths: Record<ColumnKey, number>;
  onDoubleClick?: (result: ChannelResult) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export function ChannelRow({
  result,
  onClick,
  selected,
  duplicate,
  focused,
  columns,
  columnWidths,
  onDoubleClick,
  onContextMenu,
}: ChannelRowProps) {
  const isAlive = result.status === "alive";
  const gridTemplateColumns = columns
    .map((column) => `${columnWidths[column.key]}px`)
    .join(" ");
  const tableWidth = columns.reduce(
    (sum, column) => sum + columnWidths[column.key],
    0,
  );

  const renderCell = (column: ColumnDefinition) => {
    switch (column.key) {
      case "index":
        return (
          <span className="text-text-tertiary tabular-nums">
            {result.index + 1}
          </span>
        );
      case "status":
        return <StatusBadge status={result.status} />;
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
            <span
              className={`shrink-0 ${
                result.audio_only ? "text-cyan-400" : "text-text-tertiary"
              }`}
              aria-label={kindLabel}
              title={kindLabel}
            >
              <ChannelKindIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="truncate">{result.name}</span>
          </span>
        );
      }
      case "url":
        return (
          <span className="truncate px-2 text-text-secondary" title={result.url}>
            {result.url}
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
      className={`channel-row select-none grid items-center h-[34px] px-4 text-sm border-b border-border-subtle cursor-pointer hover:bg-panel-subtle ${
        selected ? "selected bg-panel-subtle" : ""
      } ${duplicate && !selected ? "bg-amber-500/8" : ""} ${
        duplicate ? "ring-1 ring-amber-500/20" : ""
      } ${focused ? "ring-1 ring-border-app" : ""}`}
      style={{
        gridTemplateColumns,
        width: `${tableWidth}px`,
        minWidth: `${tableWidth}px`,
      }}
      onClick={(event) => onClick(event, result)}
      onDoubleClick={() => onDoubleClick?.(result)}
      onContextMenu={onContextMenu}
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
