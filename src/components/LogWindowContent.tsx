import { useVirtualizer } from "@tanstack/react-virtual";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogLevel } from "@tauri-apps/plugin-log";
import { ArrowDown, Download, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_LOG_CLEAR_EVENT,
  APP_LOG_ENTRY_EVENT,
  APP_LOG_HISTORY_EVENT,
  APP_LOG_HISTORY_REQUEST_EVENT,
  type AppLogHistoryRequest,
  type AppLogHistoryResponse,
} from "../lib/logBridge";
import {
  type AppLogEntry,
  formatLogEntries,
  formatLogTimestamp,
  MAX_LOG_ENTRIES,
  mergeLogEntries,
} from "../lib/logEntries";
import { exportAppLog } from "../lib/tauri";

const LEVEL_META: Record<LogLevel, { label: string; color: string; activeColor: string }> = {
  [LogLevel.Trace]: {
    label: "TRACE",
    color: "text-zinc-500",
    activeColor: "bg-zinc-500/15 text-zinc-500 ring-zinc-500/30",
  },
  [LogLevel.Debug]: {
    label: "DEBUG",
    color: "text-zinc-400",
    activeColor: "bg-zinc-400/15 text-zinc-400 ring-zinc-400/30",
  },
  [LogLevel.Info]: {
    label: "INFO",
    color: "text-blue-400",
    activeColor: "bg-blue-500/15 text-blue-400 ring-blue-400/30",
  },
  [LogLevel.Warn]: {
    label: "WARN",
    color: "text-amber-400",
    activeColor: "bg-amber-500/15 text-amber-400 ring-amber-400/30",
  },
  [LogLevel.Error]: {
    label: "ERROR",
    color: "text-red-400",
    activeColor: "bg-red-500/15 text-red-400 ring-red-400/30",
  },
};

const ALL_LEVELS: LogLevel[] = [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error];

const DEFAULT_ENABLED = new Set([LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error]);

let nextHistoryRequestId = 0;

function createHistoryRequestId(): string {
  nextHistoryRequestId += 1;
  return `${Date.now()}:${nextHistoryRequestId}`;
}

export function LogWindowContent() {
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(() => new Set(DEFAULT_ENABLED));
  const [searchText, setSearchText] = useState("");
  const [selectedEntries, setSelectedEntries] = useState<AppLogEntry[]>([]);
  const selectionAnchorRef = useRef<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const bufferRef = useRef<AppLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedThroughIdRef = useRef(-1);
  const activeHistoryRequestIdRef = useRef<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement>(null);
  const autoScrollRef = useRef(true);
  const [autoScroll, setAutoScroll] = useState(true);

  // The main window owns the log subscription and backlog. Listen before
  // requesting history so live entries racing the response can be deduplicated.
  useEffect(() => {
    let cancelled = false;
    let unlisten: Array<() => void> = [];

    const queueEntries = (incoming: AppLogEntry[]) => {
      if (cancelled) return;
      bufferRef.current.push(...incoming.filter((entry) => entry.id > clearedThroughIdRef.current));
      if (timerRef.current === null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const batch = bufferRef.current;
          bufferRef.current = [];
          if (batch.length === 0) return;
          setEntries((previous) => mergeLogEntries(previous, batch, MAX_LOG_ENTRIES));
        }, 32);
      }
    };

    const setupListeners = async () => {
      const listeners: Array<() => void> = [];
      try {
        listeners.push(
          await listen<AppLogEntry>(APP_LOG_ENTRY_EVENT, (event) => queueEntries([event.payload])),
        );
        listeners.push(
          await listen<AppLogHistoryResponse>(APP_LOG_HISTORY_EVENT, (event) => {
            if (event.payload.requestId !== activeHistoryRequestIdRef.current) return;
            queueEntries(event.payload.entries);
          }),
        );

        if (cancelled) {
          for (const off of listeners) off();
          return;
        }
        unlisten = listeners;
        const request: AppLogHistoryRequest = { requestId: createHistoryRequestId() };
        activeHistoryRequestIdRef.current = request.requestId;
        await emitTo("main", APP_LOG_HISTORY_REQUEST_EVENT, request);
      } catch (error) {
        for (const off of listeners) off();
        console.error("[LogWindow] Failed to connect to log history", error);
      }
    };
    void setupListeners();

    return () => {
      cancelled = true;
      for (const off of unlisten) off();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const searchLower = searchText.toLowerCase();
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (!levelFilter.has(entry.level)) return false;
      if (searchLower && !entry.message.toLowerCase().includes(searchLower)) return false;
      return true;
    });
  }, [entries, levelFilter, searchLower]);

  const selectedIds = useMemo(
    () => new Set(selectedEntries.map((entry) => entry.id)),
    [selectedEntries],
  );

  useEffect(() => {
    const isEditing = () => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        (active.matches("input, textarea") || active.isContentEditable)
      );
    };
    const clearSelection = () => {
      setSelectedEntries([]);
      selectionAnchorRef.current = null;
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const container = scrollContainerRef.current;
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-log-entry-id]")
          : null;
      if (!row || !container?.contains(row)) {
        clearSelection();
        return;
      }
      const clickedId = Number(row.dataset.logEntryId);
      if (!event.shiftKey) {
        setSelectedEntries([]);
        selectionAnchorRef.current = clickedId;
        return;
      }
      const clickedIndex = filteredEntries.findIndex((entry) => entry.id === clickedId);
      if (clickedIndex === -1) return;
      const anchorIndex = filteredEntries.findIndex(
        (entry) => entry.id === selectionAnchorRef.current,
      );
      if (anchorIndex === -1) selectionAnchorRef.current = clickedId;
      const start = Math.min(anchorIndex === -1 ? clickedIndex : anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex === -1 ? clickedIndex : anchorIndex, clickedIndex);
      event.preventDefault();
      setSelectedEntries(filteredEntries.slice(start, end + 1));
      container.focus({ preventScroll: true });

      // Native selection enables Edit > Copy; selectedEntries supplies offscreen rows.
      const rendered = Array.from(container.querySelectorAll<HTMLElement>("[data-index]")).filter(
        (element) => Number(element.dataset.index) >= start && Number(element.dataset.index) <= end,
      );
      const first = rendered[0];
      const last = rendered[rendered.length - 1];
      if (first && last) {
        const range = document.createRange();
        range.setStartBefore(first);
        range.setEndAfter(last);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    };
    const selectAllEntries = () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      container.focus({ preventScroll: true });
      setSelectedEntries(filteredEntries);
      selectionAnchorRef.current = filteredEntries[0]?.id ?? null;
      // Keep a native selection so Edit > Copy works; the copy handler includes
      // the selected entries that virtualization has kept out of the DOM.
      const range = document.createRange();
      range.selectNodeContents(container);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditing()) return;
      if (event.key === "Escape") {
        clearSelection();
        window.getSelection()?.removeAllRanges();
        return;
      }
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "a"
      )
        return;
      event.preventDefault();
      selectAllEntries();
    };
    const handleSelectionChange = () => {
      // Native Edit > Select All can bypass keydown on macOS. Recognize its
      // document-wide selection and scope it to the complete log instead.
      if (isEditing()) return;
      const selection = window.getSelection();
      const toolbar = toolbarRef.current;
      const container = scrollContainerRef.current;
      if (
        toolbar &&
        container &&
        selection?.containsNode(toolbar, true) &&
        selection.containsNode(container, true)
      ) {
        selectAllEntries();
      }
    };
    const handleCopy = (event: ClipboardEvent) => {
      if (isEditing() || selectedEntries.length === 0 || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", formatLogEntries(selectedEntries));
      event.preventDefault();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("copy", handleCopy);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [filteredEntries, selectedEntries]);

  useEffect(() => {
    setSelectedEntries([]);
    selectionAnchorRef.current = null;
  }, [levelFilter, searchText]);

  const handleExport = async () => {
    if (exporting || filteredEntries.length === 0) return;
    const text = formatLogEntries(filteredEntries);
    setExporting(true);
    setExportError(null);
    try {
      await exportAppLog(`${text}\n`);
    } catch (error) {
      setExportError(`Could not export log: ${String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const getItemKey = useCallback(
    (index: number) => filteredEntries[index]?.id ?? index,
    [filteredEntries],
  );

  const virtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 22,
    overscan: 50,
    getItemKey,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Auto-scroll when new entries arrive
  const lastFilteredEntryId = filteredEntries[filteredEntries.length - 1]?.id ?? null;

  useEffect(() => {
    if (autoScrollRef.current && filteredEntries.length > 0) {
      virtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
    }
  }, [lastFilteredEntryId, filteredEntries.length, virtualizer]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScrollRef.current = isAtBottom;
    setAutoScroll(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setAutoScroll(true);
    if (filteredEntries.length > 0) {
      virtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
    }
  }, [filteredEntries.length, virtualizer]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const clearEntries = useCallback(() => {
    const latestVisibleId = entries[entries.length - 1]?.id ?? -1;
    const latestBufferedId = bufferRef.current[bufferRef.current.length - 1]?.id ?? -1;
    clearedThroughIdRef.current = Math.max(latestVisibleId, latestBufferedId);
    activeHistoryRequestIdRef.current = null;
    bufferRef.current = [];
    setEntries([]);
    setSelectedEntries([]);
    selectionAnchorRef.current = null;
    void emitTo("main", APP_LOG_CLEAR_EVENT).catch(() => {});
  }, [entries]);

  const filteredCount = filteredEntries.length;
  const totalCount = entries.length;

  return (
    <div className="flex flex-col h-screen bg-overlay">
      {/* Toolbar */}
      <div
        ref={toolbarRef}
        data-tauri-drag-region
        className="shrink-0 border-b border-border-app bg-panel-subtle"
        style={{
          paddingTop: "var(--toolbar-pt)",
          paddingLeft: "var(--toolbar-pl)",
        }}
      >
        <div className="flex items-center gap-2 px-3 pb-2.5">
          {/* Level filter pills */}
          <div className="flex items-center gap-1">
            {ALL_LEVELS.map((level) => {
              const meta = LEVEL_META[level];
              const active = levelFilter.has(level);
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => toggleLevel(level)}
                  className={`px-2 py-0.5 rounded-md text-[11px] font-semibold tracking-wide transition-colors cursor-default ${
                    active
                      ? `${meta.activeColor} ring-1 ring-inset`
                      : "text-text-tertiary opacity-40 hover:opacity-70"
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>

          {/* Search input */}
          <div className="relative flex-1 min-w-[120px] max-w-[280px] ml-2">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary pointer-events-none" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Filter logs..."
              className="w-full pl-7 pr-2 py-1 rounded-md border border-border-app bg-input text-text-primary text-[12px] placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
          </div>

          {/* Entry count */}
          <span className="text-[11px] text-text-tertiary whitespace-nowrap ml-auto">
            {filteredCount === totalCount
              ? `${totalCount} entries`
              : `${filteredCount} / ${totalCount}`}
          </span>

          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || filteredCount === 0}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] text-text-secondary hover:bg-btn-hover disabled:opacity-40 transition-colors cursor-default whitespace-nowrap"
            title="Save matching log entries as a file"
          >
            <Download className="w-3.5 h-3.5" />
            {exporting ? "Exporting…" : "Export Log…"}
          </button>

          {/* Clear button */}
          <button
            type="button"
            onClick={clearEntries}
            className="p-1.5 rounded-md text-text-tertiary hover:bg-btn-hover transition-colors cursor-default"
            title="Clear log"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {exportError && (
        <div role="alert" className="shrink-0 px-3 py-2 text-[12px] text-red-400">
          {exportError}
        </div>
      )}

      {/* Log list */}
      <section
        ref={scrollContainerRef}
        aria-label="Log entries"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable logs need keyboard focus for scrolling and copying.
        tabIndex={0}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-[12px] leading-[22px]"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = filteredEntries[virtualRow.index];
            const meta = LEVEL_META[entry.level];
            return (
              <div
                key={entry.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-log-entry-id={entry.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={`flex items-baseline gap-2 px-3 py-px ${selectedIds.has(entry.id) ? "bg-blue-500/25" : "hover:bg-btn-hover/50"}`}
              >
                <span className="text-text-tertiary shrink-0 select-all">
                  {formatLogTimestamp(entry.timestampMs)}
                </span>
                <span className={`${meta.color} font-semibold shrink-0 w-[5ch] text-right`}>
                  {meta.label}
                </span>
                <span className="text-text-primary break-all select-all">{entry.message}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Scroll-to-bottom FAB */}
      {!autoScroll && filteredEntries.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 p-2 rounded-full bg-panel border border-border-app shadow-lg text-text-secondary hover:bg-btn-hover transition-colors cursor-default"
          title="Scroll to bottom"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
