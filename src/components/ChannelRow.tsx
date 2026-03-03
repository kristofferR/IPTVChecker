import type { ChannelResult } from "../lib/types";
import type {
  ColumnDefinition,
  ColumnKey,
} from "../lib/tableColumns";
import { StatusBadge } from "./StatusBadge";

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
      case "name":
        return (
          <span className="truncate px-2 font-medium">
            {result.name}
          </span>
        );
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
