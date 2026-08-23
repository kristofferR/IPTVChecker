import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { resultAtIndex } from "../hooks/useScan.helpers";
import { channelRowHeightPixels } from "../lib/channelLogoSize";
import { getChannelErrorReason } from "../lib/channelResults";
import { getChannelTableLayout } from "../lib/channelTableLayout";
import type { SortDirection, SortField } from "../lib/filters";
import { filterResultsShared, sortResults } from "../lib/filters";
import { statusLabel } from "../lib/format";
import { measureUiPerf } from "../lib/perf";
import { isScanActive } from "../lib/scanState";
import { isInputLikeTarget, isPrimaryModifierPressed } from "../lib/shortcuts";
import { detectChannelProtocol } from "../lib/streamProtocol";
import {
  COLUMN_DEFINITION_MAP,
  COLUMN_DEFINITIONS,
  COLUMN_ORDER_STORAGE_KEY,
  COLUMN_WIDTH_STORAGE_KEY,
  type ColumnKey,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMN_ORDER,
  parseStoredColumnOrder,
  parseStoredColumnWidths,
} from "../lib/tableColumns";
import type { ChannelResult } from "../lib/types";
import { useAppStore } from "../store";
import { ChannelRow } from "./ChannelRow";

interface ChannelTableProps {
  onSelectChannel: (result: ChannelResult) => void;
  onOpenChannel?: (result: ChannelResult) => void;
  onOpenExternal?: (result: ChannelResult) => void;
  onScanSelected?: (selectedIndices: number[]) => void;
  /**
   * True when a Chromecast session is active. Enables arrow-key auto-open as
   * a "channel-surfing" redirect of the cast (debounced) even when no local
   * playback is in progress.
   */
  isCasting?: boolean;
  headerPortalRef?: RefObject<HTMLDivElement | null>;
  toolbarHeight: number;
}

/** ms to coalesce rapid arrow-key presses into one cast redirect. */
const CAST_REDIRECT_DEBOUNCE_MS = 300;

type CopyAction = "name" | "url" | "m3u" | "metadata";

function noopRowEvent(_event: React.MouseEvent<HTMLDivElement>) {}

function buildM3uEntryText(channel: ChannelResult): string {
  return [channel.extinf_line, ...channel.metadata_lines, channel.url].join("\n");
}

const DEFAULT_VISIBLE_SINGLE_PLAYLIST_COLUMN_ORDER: ColumnKey[] =
  DEFAULT_VISIBLE_COLUMN_ORDER.filter((key) => key !== "playlist");

function buildChannelMetadataSummary(channel: ChannelResult): string {
  const videoBitrate = channel.video_bitrate ?? "Unknown";
  const audioBitrate = channel.audio_bitrate ? `${channel.audio_bitrate} kbps` : "Unknown";
  const audioCodec = channel.audio_codec ?? "Unknown";
  const hdrFormat = channel.hdr_format ?? "Unknown";
  const audioLayout = channel.audio_channel_layout ?? "Unknown";
  const resolvedStreamUrl = channel.stream_url?.trim() || null;
  const hasResolvedStreamUrl = !!resolvedStreamUrl && resolvedStreamUrl !== channel.url;
  const protocol = detectChannelProtocol(channel) ?? "Unknown";
  const errorReason = getChannelErrorReason(channel) ?? "N/A";

  const lines = [
    `Name: ${channel.name}`,
    `Group: ${channel.group}`,
    `Playlist: ${channel.playlist}`,
    `Status: ${statusLabel(channel.status)}`,
    `Protocol: ${protocol.toUpperCase()}`,
    `Error Reason: ${errorReason}`,
    `URL: ${channel.url}`,
    `Codec: ${channel.codec ?? "Unknown"}`,
    `HDR: ${hdrFormat}`,
    `Resolution: ${channel.resolution ?? "Unknown"}`,
    `Video Bitrate: ${videoBitrate}`,
    `Audio: ${audioBitrate} ${audioCodec}`,
    `Audio Layout: ${audioLayout}`,
  ];

  if (hasResolvedStreamUrl) {
    lines.splice(7, 0, `Resolved URL: ${resolvedStreamUrl}`);
  }

  return lines.join("\n");
}

function columnOrderMatchesDefaults(columnOrder: ColumnKey[], defaults: ColumnKey[]): boolean {
  if (columnOrder.length !== defaults.length) return false;
  return defaults.every((key, index) => columnOrder[index] === key);
}

function columnWidthsMatchDefaults(widths: Record<ColumnKey, number>): boolean {
  return DEFAULT_COLUMN_ORDER.every((key) => widths[key] === DEFAULT_COLUMN_WIDTHS[key]);
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
  onSelectChannel,
  onOpenChannel,
  onOpenExternal,
  onScanSelected,
  isCasting = false,
  headerPortalRef,
  toolbarHeight,
}: ChannelTableProps) {
  const completedResults = useAppStore((s) => s.flatResults);
  const resultPositions = useAppStore((s) => s.resultPositions);
  const duplicateIndices = useAppStore((s) => s.duplicateIndices);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const statusFilter = useAppStore((s) => s.statusFilter);
  const scanState = useAppStore((s) => s.scanState);
  const isMac = useAppStore((s) => s.isMac);
  const channelLogoSize = useAppStore((s) => s.settings.channel_logo_size);
  const isPlaying = useAppStore((s) => s.playIntentActive);
  const separatePlaceholder = useAppStore((s) => s.settings.separate_placeholder_status);
  const onSelectionChange = useAppStore((s) => s.setSelectedChannelIndices);
  const rawSearch = useAppStore((s) => s.search);
  const search = useDeferredValue(rawSearch);
  const parentRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const columnHeaderRefs = useRef<Partial<Record<ColumnKey, HTMLDivElement | null>>>({});
  const [sortField, setSortField] = useState<SortField>("index");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const focusedRowRef = useRef<number | null>(null);
  const updateFocusedRow = useCallback((next: number | null) => {
    focusedRowRef.current = next;
    setFocusedRow(next);
  }, []);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() => new Set());
  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    channel: ChannelResult;
  } | null>(null);
  const [copiedAction, setCopiedAction] = useState<CopyAction | null>(null);
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
  const [revealScrollState, setRevealScrollState] = useState({
    scrollTop: 0,
    scrollLeft: 0,
  });
  const [columnOrder, setColumnOrder] = useState<ColumnKey[]>(() =>
    parseStoredColumnOrder(
      localStorage.getItem(COLUMN_ORDER_STORAGE_KEY),
      DEFAULT_VISIBLE_SINGLE_PLAYLIST_COLUMN_ORDER,
    ),
  );
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(() =>
    parseStoredColumnWidths(localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY)),
  );
  const filteredResultsRef = useRef<ChannelResult[]>([]);
  const selectedIndicesRef = useRef(selectedIndices);
  const contextMenuOpenRef = useRef(contextMenuState !== null);
  const uniquePlaylistCount = useMemo(
    () =>
      new Set(
        completedResults
          .map((result) => result.playlist.trim())
          .filter((value) => value.length > 0),
      ).size,
    [completedResults],
  );
  const defaultVisibleColumnOrder = useMemo(
    () =>
      uniquePlaylistCount > 1
        ? DEFAULT_VISIBLE_COLUMN_ORDER
        : DEFAULT_VISIBLE_SINGLE_PLAYLIST_COLUMN_ORDER,
    [uniquePlaylistCount],
  );

  useEffect(() => {
    if (columnOrderMatchesDefaults(columnOrder, defaultVisibleColumnOrder)) {
      localStorage.removeItem(COLUMN_ORDER_STORAGE_KEY);
      return;
    }
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder, defaultVisibleColumnOrder]);

  useEffect(() => {
    if (columnOrderMatchesDefaults(columnOrder, defaultVisibleColumnOrder)) return;
    // Only skip the reset if the user has genuinely customized the column order
    // (i.e. it doesn't match either of the two known defaults).
    const stored = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (stored !== null) {
      const parsed = parseStoredColumnOrder(stored, defaultVisibleColumnOrder);
      const isOtherDefault =
        columnOrderMatchesDefaults(parsed, DEFAULT_VISIBLE_COLUMN_ORDER) ||
        columnOrderMatchesDefaults(parsed, DEFAULT_VISIBLE_SINGLE_PLAYLIST_COLUMN_ORDER);
      if (!isOtherDefault) return;
    }
    setColumnOrder([...defaultVisibleColumnOrder]);
  }, [columnOrder, defaultVisibleColumnOrder]);

  useEffect(() => {
    if (columnWidthsMatchDefaults(columnWidths)) {
      localStorage.removeItem(COLUMN_WIDTH_STORAGE_KEY);
      return;
    }
    localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  const hasColumnCustomizations = useMemo(
    () =>
      !columnOrderMatchesDefaults(columnOrder, defaultVisibleColumnOrder) ||
      !columnWidthsMatchDefaults(columnWidths),
    [columnOrder, defaultVisibleColumnOrder, columnWidths],
  );

  const columns = useMemo(
    () => columnOrder.map((key) => COLUMN_DEFINITION_MAP[key]),
    [columnOrder],
  );

  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const updateContainerSize = () => {
      setContainerWidth(el.clientWidth);
      setContainerHeight(el.clientHeight);
    };

    updateContainerSize();

    const ro = new ResizeObserver(() => {
      updateContainerSize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const effectiveNameWidth = useMemo(() => {
    if (!columnOrder.includes("name") || containerWidth === 0) {
      return columnWidths.name;
    }
    const sumOther = columns.reduce(
      (sum, col) => sum + (col.key === "name" ? 0 : columnWidths[col.key]),
      0,
    );
    const autoWidth = containerWidth - sumOther - 32; // px-4 padding on each side
    return Math.max(columnWidths.name, autoWidth);
  }, [columns, columnOrder, columnWidths, containerWidth]);

  const gridTemplateColumns = useMemo(
    () =>
      columns
        .map(
          (column) => `${column.key === "name" ? effectiveNameWidth : columnWidths[column.key]}px`,
        )
        .join(" "),
    [columns, columnWidths, effectiveNameWidth],
  );

  const ROW_PADDING_PX = 32; // px-4 on each side
  const tableWidth = useMemo(
    () =>
      columns.reduce(
        (sum, column) =>
          sum + (column.key === "name" ? effectiveNameWidth : columnWidths[column.key]),
        0,
      ) + ROW_PADDING_PX,
    [columns, columnWidths, effectiveNameWidth],
  );

  const filteredResults = useMemo(
    () =>
      measureUiPerf(
        "table.filter-sort",
        () => {
          const filtered = filterResultsShared(
            completedResults,
            search,
            groupFilter,
            statusFilter,
            duplicateIndices,
            separatePlaceholder,
          );
          return sortResults(filtered, sortField, sortDir);
        },
        {
          rows: completedResults.length,
          search: search.length,
          group: groupFilter,
          status: statusFilter,
          sort: `${sortField}:${sortDir}`,
        },
      ),
    [
      completedResults,
      search,
      groupFilter,
      statusFilter,
      duplicateIndices,
      sortField,
      sortDir,
      separatePlaceholder,
    ],
  );

  const estimatedRowHeight = channelRowHeightPixels(channelLogoSize);
  const getVirtualItemKey = useCallback(
    (index: number) => filteredResults[index]?.index ?? index,
    // TanStack Virtual memoizes its key map by callback identity. Filters and
    // sorting can reorder rows without changing the item count, so the
    // callback must change with the ordered results.
    [filteredResults],
  );

  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    getItemKey: getVirtualItemKey,
    estimateSize: () => estimatedRowHeight,
    // Rows rendered beyond each viewport edge. Keep this small — it's a row
    // count, and every mounted row gets reconciled on each scan batch flush.
    // The mac header-reveal band only needs a few rows above the viewport
    // (it filters virtualItems to within toolbarHeight of the top edge).
    overscan: 20,
    isScrollingResetDelay: 300,
    useFlushSync: false,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [channelLogoSize, virtualizer]);

  filteredResultsRef.current = filteredResults;
  selectedIndicesRef.current = selectedIndices;
  contextMenuOpenRef.current = contextMenuState !== null;

  const emitSelection = useCallback(
    (next: Set<number>) => {
      const ordered = Array.from(next).sort((a, b) => a - b);
      onSelectionChange?.(ordered);
    },
    [onSelectionChange],
  );

  // Compute the next selection outside the setState updater: updaters must be
  // pure (StrictMode double-invokes them, which would double-emit selection).
  // selectedIndicesRef mirrors state and is updated eagerly so back-to-back
  // calls in the same frame see each other's result.
  const updateSelection = useCallback(
    (updater: (prev: Set<number>) => Set<number>) => {
      const prev = selectedIndicesRef.current;
      const next = updater(prev);
      if (next === prev) return;
      selectedIndicesRef.current = next;
      setSelectedIndices(next);
      emitSelection(next);
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

    setSelectionAnchor((prev) => (prev !== null && visible.has(prev) ? prev : null));

    const previous = focusedRowRef.current;
    const next =
      filteredResults.length === 0 ? null : Math.min(previous ?? 0, filteredResults.length - 1);
    if (next !== previous) updateFocusedRow(next);
  }, [filteredResults, updateFocusedRow, updateSelection]);

  useEffect(() => {
    if (!contextMenuState) {
      setCopiedAction(null);
      return;
    }

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

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  const markCopied = useCallback((action: CopyAction) => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopiedAction(action);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopiedAction(null);
      copyFeedbackTimerRef.current = null;
    }, 1200);
  }, []);

  const copyText = useCallback(
    async (action: CopyAction, text: string) => {
      await navigator.clipboard.writeText(text);
      markCopied(action);
    },
    [markCopied],
  );

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
      updateFocusedRow(rowIndex);
      onSelectChannel(result);
    },
    [emitSelection, onSelectChannel, updateFocusedRow],
  );

  const selectRange = useCallback(
    (clickedResult: ChannelResult, clickedRow: number) => {
      if (selectionAnchor === null) {
        selectSingle(clickedResult, clickedRow);
        return;
      }

      const anchorRow = filteredResults.findIndex((result) => result.index === selectionAnchor);
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
      updateFocusedRow(clickedRow);
      onSelectChannel(clickedResult);
    },
    [
      selectionAnchor,
      filteredResults,
      selectSingle,
      emitSelection,
      onSelectChannel,
      updateFocusedRow,
    ],
  );

  const selectAllVisible = useCallback(() => {
    if (filteredResults.length === 0) return;
    const next = new Set(filteredResults.map((result) => result.index));
    setSelectedIndices(next);
    emitSelection(next);
    setSelectionAnchor(filteredResults[0].index);
    updateFocusedRow(0);
    onSelectChannel(filteredResults[0]);
  }, [filteredResults, emitSelection, onSelectChannel, updateFocusedRow]);

  const clearSelection = useCallback(() => {
    const next = new Set<number>();
    setSelectedIndices(next);
    emitSelection(next);
    setSelectionAnchor(null);
    setContextMenuState(null);
  }, [emitSelection]);

  const selectAllVisibleRef = useRef(selectAllVisible);
  useEffect(() => {
    selectAllVisibleRef.current = selectAllVisible;
  }, [selectAllVisible]);

  const clearSelectionRef = useRef(clearSelection);
  useEffect(() => {
    clearSelectionRef.current = clearSelection;
  }, [clearSelection]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isInputLikeTarget(event.target)) return;

      if (
        isPrimaryModifierPressed(event, isMac) &&
        !event.altKey &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        selectAllVisibleRef.current();
        return;
      }

      if (event.key === "Escape") {
        if (selectedIndicesRef.current.size > 0 || contextMenuOpenRef.current) {
          event.preventDefault();
          clearSelectionRef.current();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac]);

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
      next.sort((a, b) => DEFAULT_COLUMN_ORDER.indexOf(a) - DEFAULT_COLUMN_ORDER.indexOf(b));
      return next;
    });
  }, []);

  const resetColumnsToDefaults = useCallback(() => {
    if (hasColumnCustomizations) {
      const confirmed = window.confirm(
        "Reset table columns to defaults? This restores default order, widths, and visibility.",
      );
      if (!confirmed) return;
    }

    localStorage.removeItem(COLUMN_ORDER_STORAGE_KEY);
    localStorage.removeItem(COLUMN_WIDTH_STORAGE_KEY);
    setColumnOrder([...defaultVisibleColumnOrder]);
    setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
    setColumnMenuState(null);
  }, [defaultVisibleColumnOrder, hasColumnCustomizations]);

  // Debounce timer for arrow-key cast redirects. Each tap clears the previous
  // timer and schedules a new one, so a key burst coalesces into a single
  // backend cast_to_device call instead of one per keystroke.
  const castRedirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (castRedirectTimerRef.current) {
        clearTimeout(castRedirectTimerRef.current);
        castRedirectTimerRef.current = null;
      }
    };
  }, []);

  const moveFocusBy = useCallback(
    (delta: number) => {
      if (filteredResults.length === 0) return;

      // All side effects (selection emit, playback/cast redirect, scroll) run
      // outside the focused-row state update — updaters must stay pure, and
      // StrictMode double-invocation here used to double-start playback.
      const selectedRow = filteredResults.findIndex((result) => selectedIndices.has(result.index));
      const current = focusedRowRef.current ?? (selectedRow >= 0 ? selectedRow : 0);
      const next = Math.min(filteredResults.length - 1, Math.max(0, current + delta));

      const result = filteredResults[next];
      if (result) {
        const selected = new Set<number>([result.index]);
        selectedIndicesRef.current = selected;
        setSelectedIndices(selected);
        emitSelection(selected);
        setSelectionAnchor(result.index);
        onSelectChannel(result);
        if ((isPlaying || isCasting) && !isScanActive(scanState)) {
          if (isCasting) {
            // Coalesce key bursts so each press doesn't fire a full cast
            // re-handshake (~300ms backend round-trip).
            if (castRedirectTimerRef.current) {
              clearTimeout(castRedirectTimerRef.current);
            }
            castRedirectTimerRef.current = setTimeout(() => {
              castRedirectTimerRef.current = null;
              onOpenChannel?.(result);
            }, CAST_REDIRECT_DEBOUNCE_MS);
          } else {
            onOpenChannel?.(result);
          }
        }
      }

      virtualizer.scrollToIndex(next, { align: "auto" });
      updateFocusedRow(next);
    },
    [
      filteredResults,
      selectedIndices,
      emitSelection,
      onSelectChannel,
      onOpenChannel,
      isPlaying,
      isCasting,
      scanState,
      updateFocusedRow,
      virtualizer,
    ],
  );

  const moveFocusByRef = useRef(moveFocusBy);
  useEffect(() => {
    moveFocusByRef.current = moveFocusBy;
  }, [moveFocusBy]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isInputLikeTarget(event.target)) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocusByRef.current(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocusByRef.current(-1);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (filteredResults.length === 0) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocusBy(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocusBy(-1);
      } else if (event.key === "Enter" && focusedRowRef.current !== null) {
        const result = filteredResults[focusedRowRef.current];
        if (result) onSelectChannel(result);
      }
    },
    [filteredResults, onSelectChannel, moveFocusBy],
  );

  const handleRowClickAt = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, result: ChannelResult, rowIndex: number) => {
      setContextMenuState(null);
      setColumnMenuState(null);

      if (event.shiftKey) {
        selectRange(result, rowIndex);
        return;
      }

      if (isPrimaryModifierPressed(event, isMac)) {
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
        updateFocusedRow(rowIndex);
        onSelectChannel(result);
        return;
      }

      // Clicking the same single-selected row toggles back to no selection.
      const currentSelection = selectedIndicesRef.current;
      if (currentSelection.size === 1 && currentSelection.has(result.index)) {
        clearSelection();
        updateFocusedRow(rowIndex);
        return;
      }

      selectSingle(result, rowIndex);

      // Plain row click while casting → redirect the cast (same debounce as
      // arrow-key channel surfing so a click burst doesn't fan out into
      // multiple cast_to_device calls).
      if (isCasting && !isScanActive(scanState)) {
        if (castRedirectTimerRef.current) {
          clearTimeout(castRedirectTimerRef.current);
        }
        castRedirectTimerRef.current = setTimeout(() => {
          castRedirectTimerRef.current = null;
          onOpenChannel?.(result);
        }, CAST_REDIRECT_DEBOUNCE_MS);
      }
    },
    [
      isMac,
      selectRange,
      updateSelection,
      onSelectChannel,
      onOpenChannel,
      clearSelection,
      selectSingle,
      isCasting,
      scanState,
      updateFocusedRow,
    ],
  );

  const handleRowContextMenuAt = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, result: ChannelResult, rowIndex: number) => {
      event.preventDefault();
      setColumnMenuState(null);

      if (!selectedIndicesRef.current.has(result.index)) {
        selectSingle(result, rowIndex);
      }

      setCopiedAction(null);
      setContextMenuState({
        x: event.clientX,
        y: event.clientY,
        channel: result,
      });
    },
    [selectSingle],
  );

  const getRowFromEvent = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
    ): { rowIndex: number; result: ChannelResult } | null => {
      const rowIndexRaw = event.currentTarget.dataset.rowIndex;
      const rowIndex = rowIndexRaw ? Number.parseInt(rowIndexRaw, 10) : Number.NaN;
      if (!Number.isFinite(rowIndex)) {
        return null;
      }
      const result = filteredResultsRef.current[rowIndex];
      if (!result) {
        return null;
      }
      return { rowIndex, result };
    },
    [],
  );

  const handleRowClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const row = getRowFromEvent(event);
      if (!row) return;
      handleRowClickAt(event, row.result, row.rowIndex);
    },
    [getRowFromEvent, handleRowClickAt],
  );

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const row = getRowFromEvent(event);
      if (!row) return;
      handleRowContextMenuAt(event, row.result, row.rowIndex);
    },
    [getRowFromEvent, handleRowContextMenuAt],
  );

  const handleRowDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const row = getRowFromEvent(event);
      if (!row) return;
      // Cancel any pending arrow-key debounce so the immediate action wins.
      if (castRedirectTimerRef.current) {
        clearTimeout(castRedirectTimerRef.current);
        castRedirectTimerRef.current = null;
      }
      onOpenChannel?.(row.result);
    },
    [getRowFromEvent, onOpenChannel],
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

  const getSelectedChannels = useCallback((): ChannelResult[] => {
    if (selectedIndices.size <= 1 && contextMenuState) {
      return [contextMenuState.channel];
    }
    const indexSet = selectedIndices;
    return completedResults.filter((r) => indexSet.has(r.index)).sort((a, b) => a.index - b.index);
  }, [selectedIndices, contextMenuState, completedResults]);

  const handleCopyChannelName = useCallback(async () => {
    if (!contextMenuState) return;
    const channels = getSelectedChannels();
    await copyText("name", channels.map((c) => c.name).join("\n"));
  }, [contextMenuState, copyText, getSelectedChannels]);

  const handleCopyChannelUrl = useCallback(async () => {
    if (!contextMenuState) return;
    const channels = getSelectedChannels();
    await copyText("url", channels.map((c) => c.url).join("\n"));
  }, [contextMenuState, copyText, getSelectedChannels]);

  const handleCopyM3uEntry = useCallback(async () => {
    if (!contextMenuState) return;
    const channels = getSelectedChannels();
    await copyText("m3u", channels.map(buildM3uEntryText).join("\n"));
  }, [contextMenuState, copyText, getSelectedChannels]);

  const handleCopyAllMetadata = useCallback(async () => {
    if (!contextMenuState) return;
    const channels = getSelectedChannels();
    await copyText("metadata", channels.map(buildChannelMetadataSummary).join("\n\n"));
  }, [contextMenuState, copyText, getSelectedChannels]);

  const handlePreviewChannel = useCallback(() => {
    if (!contextMenuState) return;
    if (castRedirectTimerRef.current) {
      clearTimeout(castRedirectTimerRef.current);
      castRedirectTimerRef.current = null;
    }
    onOpenChannel?.(contextMenuState.channel);
    setContextMenuState(null);
  }, [contextMenuState, onOpenChannel]);

  const handleOpenInExternalPlayer = useCallback(() => {
    if (!contextMenuState) return;
    onOpenExternal?.(contextMenuState.channel);
    setContextMenuState(null);
  }, [contextMenuState, onOpenExternal]);

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
      const previewWidth = Math.max(72, Math.round(sourceRect?.width ?? columnWidths[key]));

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

  const headerRef = useRef<HTMLDivElement>(null);
  const scrollSyncRafRef = useRef<number | null>(null);
  const lastRevealScrollStateRef = useRef(revealScrollState);
  const portalTarget = headerPortalRef?.current;
  const hasMacHeaderReveal = isMac && Boolean(portalTarget) && toolbarHeight > 0;

  const handleTableScroll = useCallback(() => {
    if (scrollSyncRafRef.current !== null) {
      return;
    }
    scrollSyncRafRef.current = window.requestAnimationFrame(() => {
      scrollSyncRafRef.current = null;
      const scrollElement = parentRef.current;
      if (!scrollElement) {
        return;
      }

      const nextScrollTop = scrollElement.scrollTop;
      const nextScrollLeft = scrollElement.scrollLeft;

      if (headerRef.current && headerRef.current.scrollLeft !== nextScrollLeft) {
        headerRef.current.scrollLeft = nextScrollLeft;
      }

      if (!hasMacHeaderReveal) {
        return;
      }

      const previous = lastRevealScrollStateRef.current;
      if (previous.scrollTop === nextScrollTop && previous.scrollLeft === nextScrollLeft) {
        return;
      }

      const nextRevealScrollState = {
        scrollTop: nextScrollTop,
        scrollLeft: nextScrollLeft,
      };
      lastRevealScrollStateRef.current = nextRevealScrollState;
      setRevealScrollState(nextRevealScrollState);
    });
  }, [hasMacHeaderReveal]);

  useEffect(
    () => () => {
      if (scrollSyncRafRef.current !== null) {
        window.cancelAnimationFrame(scrollSyncRafRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!hasMacHeaderReveal) {
      if (
        lastRevealScrollStateRef.current.scrollTop !== 0 ||
        lastRevealScrollStateRef.current.scrollLeft !== 0
      ) {
        lastRevealScrollStateRef.current = { scrollTop: 0, scrollLeft: 0 };
        setRevealScrollState({ scrollTop: 0, scrollLeft: 0 });
      }
      return;
    }

    const scrollElement = parentRef.current;
    if (!scrollElement) {
      return;
    }

    const nextRevealScrollState = {
      scrollTop: scrollElement.scrollTop,
      scrollLeft: scrollElement.scrollLeft,
    };

    if (headerRef.current && headerRef.current.scrollLeft !== nextRevealScrollState.scrollLeft) {
      headerRef.current.scrollLeft = nextRevealScrollState.scrollLeft;
    }

    lastRevealScrollStateRef.current = nextRevealScrollState;
    setRevealScrollState((prev) =>
      prev.scrollTop === nextRevealScrollState.scrollTop &&
      prev.scrollLeft === nextRevealScrollState.scrollLeft
        ? prev
        : nextRevealScrollState,
    );
  }, [hasMacHeaderReveal, toolbarHeight]);

  const virtualItems = virtualizer.getVirtualItems();
  const isTableScrolling = virtualizer.isScrolling;
  const revealVirtualItems = hasMacHeaderReveal
    ? virtualItems.filter((virtualRow) => {
        const rowStart = virtualRow.start;
        const rowEnd = virtualRow.start + virtualRow.size;
        return (
          rowEnd - revealScrollState.scrollTop > -toolbarHeight &&
          rowStart - revealScrollState.scrollTop < 0
        );
      })
    : [];
  const { scrollContainerTop } = getChannelTableLayout({
    hasPortaledHeader: Boolean(portalTarget),
  });

  const renderVirtualRows = useCallback(
    (items: typeof virtualItems, mode: "main" | "reveal") =>
      items.map((virtualRow) => {
        const result = filteredResults[virtualRow.index];
        if (!result) {
          return null;
        }

        const rowTop =
          mode === "main"
            ? hasMacHeaderReveal
              ? virtualRow.start - revealScrollState.scrollTop
              : virtualRow.start
            : virtualRow.start - revealScrollState.scrollTop + toolbarHeight;

        return (
          <div
            key={mode === "main" ? virtualRow.key : `reveal-${virtualRow.key}`}
            style={{
              position: "absolute",
              top: `${rowTop}px`,
              left: 0,
              width: `${tableWidth}px`,
              height: `${virtualRow.size}px`,
            }}
          >
            <ChannelRow
              rowIndex={virtualRow.index}
              result={result}
              channelLogoSize={channelLogoSize}
              onRowClick={mode === "main" ? handleRowClick : noopRowEvent}
              onRowDoubleClick={mode === "main" ? handleRowDoubleClick : noopRowEvent}
              onRowContextMenu={mode === "main" ? handleRowContextMenu : noopRowEvent}
              selected={selectedIndices.has(result.index)}
              duplicate={duplicateIndices.has(result.index)}
              focused={focusedRow === virtualRow.index}
              columns={columns}
              gridTemplateColumns={gridTemplateColumns}
              tableWidth={tableWidth}
            />
          </div>
        );
      }),
    [
      channelLogoSize,
      columns,
      duplicateIndices,
      filteredResults,
      focusedRow,
      gridTemplateColumns,
      handleRowClick,
      handleRowContextMenu,
      handleRowDoubleClick,
      hasMacHeaderReveal,
      revealScrollState.scrollTop,
      selectedIndices,
      tableWidth,
      toolbarHeight,
    ],
  );

  const headerElement = (
    <div
      ref={headerRef}
      className={
        portalTarget
          ? "h-8 select-none overflow-hidden"
          : "absolute top-0 left-0 right-0 z-10 h-8 bg-panel select-none overflow-hidden"
      }
      style={
        portalTarget
          ? {
              maskImage:
                "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
            }
          : undefined
      }
    >
      <div
        className="grid items-center h-8 px-4 text-[11px] font-semibold text-text-secondary"
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
              onPointerDown={(event) => handleColumnPointerDown(column.key, event)}
              className={`relative flex items-center h-full w-full ${alignClass} ${
                draggedColumn === column.key ? "opacity-45" : ""
              } ${
                dragOverColumn === column.key ? "bg-blue-500/10 rounded-sm" : ""
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
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 relative">
      {/* Column header — portaled into toolbar on macOS, or inline fallback */}
      {portalTarget ? createPortal(headerElement, portalTarget) : headerElement}

      {hasMacHeaderReveal && revealVirtualItems.length > 0 && (
        <div
          aria-hidden="true"
          className="channel-table-reveal absolute left-0 right-0 overflow-hidden pointer-events-none"
          style={{
            top: `${-toolbarHeight}px`,
            height: `${toolbarHeight}px`,
          }}
        >
          <div
            style={{
              position: "relative",
              width: `${tableWidth}px`,
              minWidth: `${tableWidth}px`,
              height: "100%",
              transform: `translateX(-${revealScrollState.scrollLeft}px)`,
            }}
          >
            {renderVirtualRows(revealVirtualItems, "reveal")}
          </div>
        </div>
      )}

      {/* Scroll container — main viewport owns the native scrollbar */}
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => event.preventDefault()}
        onScroll={handleTableScroll}
        className={`channel-table-body native-scroll absolute left-0 right-0 bottom-0 overflow-auto focus:outline-none ${
          isTableScrolling ? "is-scrolling" : ""
        }`}
        style={{ top: scrollContainerTop }}
      >
        <div
          style={{
            minWidth: `${tableWidth}px`,
            minHeight: "100%",
          }}
        >
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
              {hasMacHeaderReveal ? (
                <div className="sticky top-0 left-0 h-0 overflow-visible">
                  <div
                    className="channel-table-viewport"
                    style={{
                      position: "relative",
                      width: `${tableWidth}px`,
                      minWidth: `${tableWidth}px`,
                      height: `${containerHeight}px`,
                      overflow: "hidden",
                    }}
                  >
                    {renderVirtualRows(virtualItems, "main")}
                  </div>
                </div>
              ) : (
                renderVirtualRows(virtualItems, "main")
              )}
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
            onClick={handleScanSelected}
            disabled={selectedIndices.size === 0 || isScanActive(scanState)}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
            type="button"
          >
            {selectedIndices.size > 0 &&
            Array.from(selectedIndices).every((idx) => {
              const r = resultAtIndex(
                { flatResults: completedResults, positions: resultPositions },
                idx,
              );
              return r != null && r.status !== "pending" && r.status !== "checking";
            })
              ? "Rescan"
              : "Scan"}{" "}
            Selected ({selectedIndices.size})
          </button>
          <div className="h-px my-1 bg-border-subtle" />
          <button
            onClick={handlePreviewChannel}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            Preview
          </button>
          <button
            onClick={handleOpenInExternalPlayer}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            Open in External Player
          </button>
          <button
            onClick={handleCopyChannelName}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            {copiedAction === "name"
              ? "Copied!"
              : selectedIndices.size > 1
                ? `Copy ${selectedIndices.size} Names`
                : "Copy Channel Name"}
          </button>
          <button
            onClick={handleCopyChannelUrl}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            {copiedAction === "url"
              ? "Copied!"
              : selectedIndices.size > 1
                ? `Copy ${selectedIndices.size} URLs`
                : "Copy URL"}
          </button>
          <button
            onClick={handleCopyM3uEntry}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            {copiedAction === "m3u"
              ? "Copied!"
              : selectedIndices.size > 1
                ? `Copy ${selectedIndices.size} M3U Entries`
                : "Copy M3U Entry"}
          </button>
          <button
            onClick={handleCopyAllMetadata}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover"
            type="button"
          >
            {copiedAction === "metadata"
              ? "Copied!"
              : selectedIndices.size > 1
                ? `Copy ${selectedIndices.size} Metadata`
                : "Copy All Metadata"}
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
          <div className="h-px my-1 bg-border-subtle" />
          <button
            onClick={resetColumnsToDefaults}
            disabled={!hasColumnCustomizations}
            className="w-full text-left px-3 py-2 text-[13px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
            type="button"
          >
            Reset to Defaults
          </button>
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
