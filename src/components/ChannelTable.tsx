import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChannelResult } from "../lib/types";
import type { SortDirection, SortField } from "../lib/filters";
import { filterResults, sortResults } from "../lib/filters";
import {
  COLUMN_DEFINITION_MAP,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  type ColumnKey,
} from "../lib/tableColumns";
import { ChannelRow } from "./ChannelRow";
import { ArrowDown, ArrowUp } from "lucide-react";

interface ChannelTableProps {
  results: (ChannelResult | null)[];
  search: string;
  groupFilter: string;
  statusFilter: string;
  onSelectChannel: (result: ChannelResult) => void;
  onOpenChannel?: (result: ChannelResult) => void;
  selectedIndex: number | null;
}

const ORDER_STORAGE_KEY = "iptv-checker.column-order.v1";
const WIDTH_STORAGE_KEY = "iptv-checker.column-widths.v1";

function parseStoredOrder(raw: string | null): ColumnKey[] {
  if (!raw) return DEFAULT_COLUMN_ORDER;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COLUMN_ORDER;

    const known = new Set(DEFAULT_COLUMN_ORDER);
    const deduped: ColumnKey[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      if (!known.has(item as ColumnKey)) continue;
      if (deduped.includes(item as ColumnKey)) continue;
      deduped.push(item as ColumnKey);
    }

    if (deduped.length !== DEFAULT_COLUMN_ORDER.length) {
      for (const key of DEFAULT_COLUMN_ORDER) {
        if (!deduped.includes(key)) deduped.push(key);
      }
    }
    return deduped;
  } catch {
    return DEFAULT_COLUMN_ORDER;
  }
}

function parseStoredWidths(raw: string | null): Record<ColumnKey, number> {
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  if (!raw) return widths;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return widths;

    for (const key of DEFAULT_COLUMN_ORDER) {
      const maybeWidth = parsed[key];
      const minWidth = COLUMN_DEFINITION_MAP[key].minWidth;
      if (typeof maybeWidth === "number" && Number.isFinite(maybeWidth)) {
        widths[key] = Math.max(minWidth, Math.round(maybeWidth));
      }
    }
  } catch {
    // Ignore malformed persisted values.
  }

  return widths;
}

export function ChannelTable({
  results,
  search,
  groupFilter,
  statusFilter,
  onSelectChannel,
  onOpenChannel,
  selectedIndex,
}: ChannelTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sortField, setSortField] = useState<SortField>("index");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<ColumnKey | null>(null);
  const [columnOrder, setColumnOrder] = useState<ColumnKey[]>(() =>
    parseStoredOrder(globalThis.localStorage?.getItem(ORDER_STORAGE_KEY) ?? null),
  );
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(
    () =>
      parseStoredWidths(
        globalThis.localStorage?.getItem(WIDTH_STORAGE_KEY) ?? null,
      ),
  );

  useEffect(() => {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  useEffect(() => {
    localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  const columns = useMemo(
    () => columnOrder.map((key) => COLUMN_DEFINITION_MAP[key]),
    [columnOrder],
  );

  const gridTemplateColumns = useMemo(
    () => columns.map((column) => `${columnWidths[column.key]}px`).join(" "),
    [columns, columnWidths],
  );

  const tableWidth = useMemo(
    () =>
      columns.reduce((sum, column) => sum + columnWidths[column.key], 0),
    [columns, columnWidths],
  );

  const filteredResults = useMemo(() => {
    const nonNull = results.filter((r): r is ChannelResult => r != null);
    const filtered = filterResults(nonNull, search, groupFilter, statusFilter);
    return sortResults(filtered, sortField, sortDir);
  }, [results, search, groupFilter, statusFilter, sortField, sortDir]);

  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 20,
  });

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filteredResults.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const next =
            prev === null ? 0 : Math.min(prev + 1, filteredResults.length - 1);
          virtualizer.scrollToIndex(next, { align: "auto" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const next = prev === null ? 0 : Math.max(prev - 1, 0);
          virtualizer.scrollToIndex(next, { align: "auto" });
          return next;
        });
      } else if (e.key === "Enter" && focusedIndex !== null) {
        const result = filteredResults[focusedIndex];
        if (result) onSelectChannel(result);
      }
    },
    [filteredResults, focusedIndex, onSelectChannel, virtualizer],
  );

  const handleColumnDragStart = useCallback(
    (key: ColumnKey, event: React.DragEvent<HTMLDivElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
      setDraggedColumn(key);
    },
    [],
  );

  const handleColumnDrop = useCallback(
    (targetKey: ColumnKey) => {
      setColumnOrder((prev) => {
        if (!draggedColumn || draggedColumn === targetKey) return prev;

        const fromIndex = prev.indexOf(draggedColumn);
        const toIndex = prev.indexOf(targetKey);
        if (fromIndex < 0 || toIndex < 0) return prev;

        const next = [...prev];
        next.splice(fromIndex, 1);
        next.splice(toIndex, 0, draggedColumn);
        return next;
      });
      setDraggedColumn(null);
    },
    [draggedColumn],
  );

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, key: ColumnKey) => {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = columnWidths[key];
      const minWidth = COLUMN_DEFINITION_MAP[key].minWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        setColumnWidths((prev) => ({
          ...prev,
          [key]: Math.max(minWidth, Math.round(startWidth + deltaX)),
        }));
      };

      const onMouseUp = () => {
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [columnWidths],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="native-scroll flex-1 overflow-auto focus:outline-none"
      >
        <div style={{ minWidth: `${tableWidth}px`, minHeight: "100%" }}>
          <div
            className="sticky top-0 z-10 grid items-center h-8 px-4 text-[11px] font-semibold text-text-secondary border-b border-border-app bg-panel-subtle select-none"
            style={{
              gridTemplateColumns,
              width: `${tableWidth}px`,
              minWidth: `${tableWidth}px`,
            }}
          >
            {columns.map((column) => {
              const alignClass =
                column.align === "right"
                  ? "justify-self-end"
                  : column.align === "center"
                    ? "justify-self-center"
                    : "justify-self-start";

              return (
                <div
                  key={column.key}
                  draggable
                  onDragStart={(event) =>
                    handleColumnDragStart(column.key, event)
                  }
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleColumnDrop(column.key);
                  }}
                  onDragEnd={() => setDraggedColumn(null)}
                  className={`relative flex items-center h-full ${alignClass} ${
                    draggedColumn === column.key ? "opacity-50" : ""
                  }`}
                >
                  <button
                    className="h-full px-2 hover:text-text-primary flex items-center gap-1 cursor-pointer"
                    onClick={() => handleSort(column.key)}
                    type="button"
                  >
                    {column.label}
                    {sortField === column.key &&
                      (sortDir === "asc" ? (
                        <ArrowUp className="w-3 h-3" />
                      ) : (
                        <ArrowDown className="w-3 h-3" />
                      ))}
                  </button>
                  <div
                    role="separator"
                    aria-label={`Resize ${column.label} column`}
                    className="absolute top-0 right-0 h-full w-2 cursor-col-resize hover:bg-blue-500/20"
                    onMouseDown={(event) => handleResizeStart(event, column.key)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>

          {filteredResults.length === 0 ? (
            <div className="flex items-center justify-center text-text-tertiary text-sm min-h-64">
              No channels match the current filters
            </div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: `${tableWidth}px`,
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const result = filteredResults[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: `${tableWidth}px`,
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <ChannelRow
                      result={result}
                      onClick={onSelectChannel}
                      onDoubleClick={onOpenChannel}
                      selected={selectedIndex === result.index}
                      focused={focusedIndex === virtualRow.index}
                      columns={columns}
                      columnWidths={columnWidths}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
