import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChannelResult } from "../lib/types";
import type { SortDirection, SortField } from "../lib/filters";
import { filterResults, sortResults } from "../lib/filters";
import {
  COLUMN_ORDER_STORAGE_KEY,
  COLUMN_WIDTH_STORAGE_KEY,
  COLUMN_DEFINITIONS,
  COLUMN_DEFINITION_MAP,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_VISIBLE_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  type ColumnKey,
} from "../lib/tableColumns";
import { ChannelRow } from "./ChannelRow";
import { ArrowDown, ArrowUp } from "lucide-react";

interface ChannelTableProps {
  results: (ChannelResult | null)[];
  duplicateIndices: Set<number>;
  search: string;
  groupFilter: string;
  statusFilter: string;
  onSelectChannel: (result: ChannelResult) => void;
  onOpenChannel?: (result: ChannelResult) => void;
  onSelectionChange?: (selectedIndices: number[]) => void;
  onScanSelected?: (selectedIndices: number[]) => void;
}

function parseStoredOrder(raw: string | null): ColumnKey[] {
  if (!raw) return DEFAULT_VISIBLE_COLUMN_ORDER;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VISIBLE_COLUMN_ORDER;

    const known = new Set(DEFAULT_COLUMN_ORDER);
    const deduped: ColumnKey[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      if (!known.has(item as ColumnKey)) continue;
      if (deduped.includes(item as ColumnKey)) continue;
      deduped.push(item as ColumnKey);
    }

    if (deduped.length === 0) {
      return DEFAULT_VISIBLE_COLUMN_ORDER;
    }

    for (const key of DEFAULT_VISIBLE_COLUMN_ORDER) {
      if (!deduped.includes(key)) deduped.push(key);
    }
    return deduped;
  } catch {
    return DEFAULT_VISIBLE_COLUMN_ORDER;
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

function isInputLikeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

function keepMenuInViewport(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
): { x: number; y: number } {
  const padding = 8;
  const maxX = Math.max(padding, window.innerWidth - menuWidth - padding);
  const maxY = Math.max(padding, window.innerHeight - menuHeight - padding);
  return {
    x: Math.min(Math.max(x, padding), maxX),
    y: Math.min(Math.max(y, padding), maxY),
  };
}

export function ChannelTable({
  results,
  duplicateIndices,
  search,
  groupFilter,
  statusFilter,
  onSelectChannel,
  onOpenChannel,
  onSelectionChange,
  onScanSelected,
}: ChannelTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const columnHeaderRefs = useRef<
    Partial<Record<ColumnKey, HTMLDivElement | null>>
  >({});
  const [sortField, setSortField] = useState<SortField>("index");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    () => new Set(),
  );
  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    channel: ChannelResult;
  } | null>(null);
  const [columnMenuState, setColumnMenuState] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<ColumnKey | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnKey | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    x: number;
    y: number;
    key: ColumnKey;
    width: number;
  } | null>(null);
  const [columnOrder, setColumnOrder] = useState<ColumnKey[]>(() =>
    parseStoredOrder(localStorage.getItem(COLUMN_ORDER_STORAGE_KEY)),
  );
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(
    () => parseStoredWidths(localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY)),
  );

  useEffect(() => {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  useEffect(() => {
    localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
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
    const filtered = filterResults(
      nonNull,
      search,
      groupFilter,
      statusFilter,
      duplicateIndices,
    );
    return sortResults(filtered, sortField, sortDir);
  }, [results, search, groupFilter, statusFilter, duplicateIndices, sortField, sortDir]);

  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 20,
  });

  const emitSelection = useCallback(
    (next: Set<number>) => {
      const ordered = Array.from(next).sort((a, b) => a - b);
      onSelectionChange?.(ordered);
    },
    [onSelectionChange],
  );

  const updateSelection = useCallback(
    (updater: (prev: Set<number>) => Set<number>) => {
      setSelectedIndices((prev) => {
        const next = updater(prev);
        if (next === prev) return prev;
        emitSelection(next);
        return next;
      });
    },
    [emitSelection],
  );

  useEffect(() => {
    const visible = new Set(filteredResults.map((r) => r.index));

    updateSelection((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(Array.from(prev).filter((idx) => visible.has(idx)));
      return next.size === prev.size ? prev : next;
    });

    setSelectionAnchor((prev) =>
      prev !== null && visible.has(prev) ? prev : null,
    );

    setFocusedRow((prev) => {
      if (filteredResults.length === 0) return null;
      if (prev === null) return 0;
      return Math.min(prev, filteredResults.length - 1);
    });
  }, [filteredResults, updateSelection]);

  useEffect(() => {
    if (!contextMenuState) return;

    const menu = contextMenuRef.current;
    if (menu) {
      const rect = menu.getBoundingClientRect();
      const next = keepMenuInViewport(
        contextMenuState.x,
        contextMenuState.y,
        rect.width,
        rect.height,
      );
      if (next.x !== contextMenuState.x || next.y !== contextMenuState.y) {
        setContextMenuState((prev) =>
          prev
            ? {
                ...prev,
                x: next.x,
                y: next.y,
              }
            : prev,
        );
      }
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!contextMenuRef.current) return;
      const target = event.target as Node;
      if (!contextMenuRef.current.contains(target)) {
        setContextMenuState(null);
      }
    };

    const handleScroll = () => setContextMenuState(null);
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [contextMenuState]);

  useEffect(() => {
    if (!columnMenuState) return;

    const menu = columnMenuRef.current;
    if (menu) {
      const rect = menu.getBoundingClientRect();
      const next = keepMenuInViewport(
        columnMenuState.x,
        columnMenuState.y,
        rect.width,
        rect.height,
      );
      if (next.x !== columnMenuState.x || next.y !== columnMenuState.y) {
        setColumnMenuState(next);
      }
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!columnMenuRef.current) return;
      const target = event.target as Node;
      if (!columnMenuRef.current.contains(target)) {
        setColumnMenuState(null);
      }
    };

    const handleScroll = () => setColumnMenuState(null);
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [columnMenuState]);

  const selectSingle = useCallback(
    (result: ChannelResult, rowIndex: number) => {
      const next = new Set<number>([result.index]);
      setSelectedIndices(next);
      emitSelection(next);
      setSelectionAnchor(result.index);
      setFocusedRow(rowIndex);
      onSelectChannel(result);
    },
    [emitSelection, onSelectChannel],
  );

  const selectRange = useCallback(
    (clickedResult: ChannelResult, clickedRow: number) => {
      if (selectionAnchor === null) {
        selectSingle(clickedResult, clickedRow);
        return;
      }

      const anchorRow = filteredResults.findIndex(
        (result) => result.index === selectionAnchor,
      );
      if (anchorRow < 0) {
        selectSingle(clickedResult, clickedRow);
        return;
      }

      const start = Math.min(anchorRow, clickedRow);
      const end = Math.max(anchorRow, clickedRow);
      const next = new Set<number>();
      for (let i = start; i <= end; i += 1) {
        next.add(filteredResults[i].index);
      }

      setSelectedIndices(next);
      emitSelection(next);
      setFocusedRow(clickedRow);
      onSelectChannel(clickedResult);
    },
    [selectionAnchor, filteredResults, selectSingle, emitSelection, onSelectChannel],
  );

  const selectAllVisible = useCallback(() => {
    if (filteredResults.length === 0) return;
    const next = new Set(filteredResults.map((result) => result.index));
    setSelectedIndices(next);
    emitSelection(next);
    setSelectionAnchor(filteredResults[0].index);
    setFocusedRow(0);
    onSelectChannel(filteredResults[0]);
  }, [filteredResults, emitSelection, onSelectChannel]);

  const clearSelection = useCallback(() => {
    const next = new Set<number>();
    setSelectedIndices(next);
    emitSelection(next);
    setSelectionAnchor(null);
    setContextMenuState(null);
  }, [emitSelection]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isInputLikeTarget(event.target)) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAllVisible();
        return;
      }

      if (event.key === "Escape") {
        if (selectedIndices.size > 0 || contextMenuState) {
          event.preventDefault();
          clearSelection();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectAllVisible, selectedIndices.size, contextMenuState, clearSelection]);

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

  const toggleColumnVisibility = useCallback((key: ColumnKey) => {
    setColumnOrder((prev) => {
      if (prev.includes(key)) {
        if (prev.length <= 1) return prev;
        return prev.filter((columnKey) => columnKey !== key);
      }

      const next = [...prev, key];
      next.sort(
        (a, b) =>
          DEFAULT_COLUMN_ORDER.indexOf(a) - DEFAULT_COLUMN_ORDER.indexOf(b),
      );
      return next;
    });
  }, []);

  const moveFocusBy = useCallback(
    (delta: number) => {
      if (filteredResults.length === 0) return;

      setFocusedRow((prev) => {
        const selectedRow = filteredResults.findIndex((result) =>
          selectedIndices.has(result.index),
        );
        const current = prev ?? (selectedRow >= 0 ? selectedRow : 0);
        const next = Math.min(
          filteredResults.length - 1,
          Math.max(0, current + delta),
        );

        const result = filteredResults[next];
        if (result) {
          const selected = new Set<number>([result.index]);
          setSelectedIndices(selected);
          emitSelection(selected);
          setSelectionAnchor(result.index);
          onSelectChannel(result);
        }

        virtualizer.scrollToIndex(next, { align: "auto" });
        return next;
      });
    },
    [
      filteredResults,
      selectedIndices,
      emitSelection,
      onSelectChannel,
      virtualizer,
    ],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isInputLikeTarget(event.target)) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocusBy(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocusBy(-1);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [moveFocusBy]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (filteredResults.length === 0) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocusBy(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocusBy(-1);
      } else if (event.key === "Enter" && focusedRow !== null) {
        const result = filteredResults[focusedRow];
        if (result) onSelectChannel(result);
      }
    },
    [filteredResults, focusedRow, onSelectChannel, moveFocusBy],
  );

  const handleRowClick = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      result: ChannelResult,
      rowIndex: number,
    ) => {
      setContextMenuState(null);
      setColumnMenuState(null);

      if (event.shiftKey) {
        selectRange(result, rowIndex);
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        updateSelection((prev) => {
          const next = new Set(prev);
          if (next.has(result.index)) {
            next.delete(result.index);
          } else {
            next.add(result.index);
          }
          return next;
        });
        setSelectionAnchor(result.index);
        setFocusedRow(rowIndex);
        onSelectChannel(result);
        return;
      }

      // Clicking the same single-selected row toggles back to no selection.
      if (selectedIndices.size === 1 && selectedIndices.has(result.index)) {
        clearSelection();
        setFocusedRow(rowIndex);
        return;
      }

      selectSingle(result, rowIndex);
    },
    [
      selectRange,
      updateSelection,
      onSelectChannel,
      selectedIndices,
      clearSelection,
      selectSingle,
    ],
  );

  const handleRowContextMenu = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      result: ChannelResult,
      rowIndex: number,
    ) => {
      event.preventDefault();
      setColumnMenuState(null);

      if (!selectedIndices.has(result.index)) {
        selectSingle(result, rowIndex);
      }

      setContextMenuState({
        x: event.clientX,
        y: event.clientY,
        channel: result,
      });
    },
    [selectedIndices, selectSingle],
  );

  const handleScanSelected = useCallback(() => {
    const ordered = Array.from(selectedIndices).sort((a, b) => a - b);
    if (ordered.length === 0) {
      setContextMenuState(null);
      return;
    }

    onScanSelected?.(ordered);
    setContextMenuState(null);
  }, [selectedIndices, onScanSelected]);

  const handleCopyChannelName = useCallback(async () => {
    if (!contextMenuState) return;
    await navigator.clipboard.writeText(contextMenuState.channel.name);
    setContextMenuState(null);
  }, [contextMenuState]);

  const handleCopyChannelUrl = useCallback(async () => {
    if (!contextMenuState) return;
    await navigator.clipboard.writeText(contextMenuState.channel.url);
    setContextMenuState(null);
  }, [contextMenuState]);

  const handleOpenInPlayer = useCallback(() => {
    if (!contextMenuState) return;
    onOpenChannel?.(contextMenuState.channel);
    setContextMenuState(null);
  }, [contextMenuState, onOpenChannel]);

  const findColumnAtX = useCallback(
    (x: number): ColumnKey | null => {
      for (const column of columns) {
        const node = columnHeaderRefs.current[column.key];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right) {
          return column.key;
        }
      }
      return null;
    },
    [columns],
  );

  const handleColumnPointerDown = useCallback(
    (key: ColumnKey, event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-col-resize='true']")) return;

      const startX = event.clientX;
      let moved = false;
      let dropTarget: ColumnKey | null = null;
      const sourceNode = columnHeaderRefs.current[key];
      const sourceRect = sourceNode?.getBoundingClientRect();
      const previewWidth = Math.max(
        72,
        Math.round(sourceRect?.width ?? columnWidths[key]),
      );

      const onMove = (moveEvent: PointerEvent) => {
        const delta = Math.abs(moveEvent.clientX - startX);
        if (!moved && delta < 4) return;

        if (!moved) {
          moved = true;
          document.body.style.cursor = "none";
          document.body.style.userSelect = "none";
          setDraggedColumn(key);
        }

        const over = findColumnAtX(moveEvent.clientX);
        dropTarget = over && over !== key ? over : null;
        setDragOverColumn(dropTarget);
        setDragPreview({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          key,
          width: previewWidth,
        });
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setDraggedColumn(null);
        setDragOverColumn(null);
        setDragPreview(null);
      };

      const onUp = () => {
        if (moved && dropTarget) {
          setColumnOrder((prev) => {
            const fromIndex = prev.indexOf(key);
            const toIndex = prev.indexOf(dropTarget as ColumnKey);
            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
              return prev;
            }

            const next = [...prev];
            next.splice(fromIndex, 1);
            next.splice(toIndex, 0, key);
            return next;
          });
        }
        cleanup();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [findColumnAtX, columnWidths],
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
        onContextMenu={(event) => event.preventDefault()}
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
                  ? "justify-end"
                  : column.align === "center"
                    ? "justify-center"
                    : "justify-start";

              return (
                <div
                  key={column.key}
                  ref={(node) => {
                    columnHeaderRefs.current[column.key] = node;
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenuState(null);
                    setColumnMenuState({
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onPointerDown={(event) =>
                    handleColumnPointerDown(column.key, event)
                  }
                  className={`relative flex items-center h-full w-full ${alignClass} ${
                    draggedColumn === column.key ? "opacity-45" : ""
                  } ${
                    dragOverColumn === column.key
                      ? "bg-blue-500/10 rounded-sm"
                      : ""
                  } cursor-grab active:cursor-grabbing`}
                  title={`Drag to reorder ${column.label}. Right-click for column visibility.`}
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
                    draggable={false}
                    data-col-resize="true"
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
                      onClick={(event, clickedResult) =>
                        handleRowClick(event, clickedResult, virtualRow.index)
                      }
                      onDoubleClick={onOpenChannel}
                      onContextMenu={(event) =>
                        handleRowContextMenu(event, result, virtualRow.index)
                      }
                      selected={selectedIndices.has(result.index)}
                      duplicate={duplicateIndices.has(result.index)}
                      focused={focusedRow === virtualRow.index}
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

      {contextMenuState && (
        <div
          ref={contextMenuRef}
          data-no-window-drag
          className="fixed z-50 w-56 rounded-lg border border-border-app bg-dropdown shadow-2xl py-1"
          style={{
            top: `${contextMenuState.y}px`,
            left: `${contextMenuState.x}px`,
          }}
        >
          <button
            onClick={handleOpenInPlayer}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            Open in Default Player
          </button>
          <button
            onClick={handleCopyChannelName}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            Copy Channel Name
          </button>
          <button
            onClick={handleCopyChannelUrl}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            Copy Channel URL
          </button>
          <div className="h-px my-1 bg-border-subtle" />
          <button
            onClick={handleScanSelected}
            disabled={selectedIndices.size === 0}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
            type="button"
          >
            Scan selected ({selectedIndices.size})
          </button>
        </div>
      )}

      {columnMenuState && (
        <div
          ref={columnMenuRef}
          data-no-window-drag
          className="fixed z-50 w-56 rounded-lg border border-border-app bg-dropdown shadow-2xl py-1"
          style={{
            top: `${columnMenuState.y}px`,
            left: `${columnMenuState.x}px`,
          }}
        >
          <p className="px-3 py-2 text-[11px] uppercase tracking-[0.06em] text-text-tertiary">
            Visible Columns
          </p>
          {COLUMN_DEFINITIONS.map((column) => {
            const checked = columnOrder.includes(column.key);
            const disableHide = checked && columnOrder.length <= 1;
            return (
              <button
                key={column.key}
                onClick={() => toggleColumnVisibility(column.key)}
                disabled={disableHide}
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none flex items-center justify-between"
                type="button"
              >
                <span>{column.label}</span>
                <span className="text-[11px] text-text-tertiary">{checked ? "On" : "Off"}</span>
              </button>
            );
          })}
        </div>
      )}

      {dragPreview && (
        <div
          className="fixed z-[70] pointer-events-none h-8 px-2 text-[11px] font-semibold text-text-secondary border border-border-app rounded-md bg-panel-subtle/95 backdrop-blur-md shadow-lg flex items-center justify-start select-none"
          style={{
            left: `${dragPreview.x}px`,
            top: `${dragPreview.y}px`,
            width: `${dragPreview.width}px`,
            transform: "translate(-50%, -50%)",
          }}
        >
          {COLUMN_DEFINITION_MAP[dragPreview.key].label}
          {sortField === dragPreview.key &&
            (sortDir === "asc" ? (
              <ArrowUp className="w-3 h-3 ml-1.5" />
            ) : (
              <ArrowDown className="w-3 h-3 ml-1.5" />
            ))}
        </div>
      )}
    </div>
  );
}
