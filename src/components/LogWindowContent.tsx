import { useVirtualizer } from "@tanstack/react-virtual";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogLevel } from "@tauri-apps/plugin-log";
import { ArrowDown, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_LOG_CLEAR_EVENT,
  APP_LOG_ENTRY_EVENT,
  APP_LOG_HISTORY_EVENT,
  APP_LOG_HISTORY_REQUEST_EVENT,
  type AppLogHistoryRequest,
  type AppLogHistoryResponse,
} from "../lib/logBridge";
import { type AppLogEntry, MAX_LOG_ENTRIES, mergeLogEntries } from "../lib/logEntries";

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

function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function LogWindowContent() {
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(() => new Set(DEFAULT_ENABLED));
  const [searchText, setSearchText] = useState("");

  const bufferRef = useRef<AppLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedThroughIdRef = useRef(-1);
  const activeHistoryRequestIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
    void emitTo("main", APP_LOG_CLEAR_EVENT).catch(() => {});
  }, [entries]);

  const filteredCount = filteredEntries.length;
  const totalCount = entries.length;

  return (
    <div className="flex flex-col h-screen bg-overlay">
      {/* Toolbar */}
      <div
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

      {/* Log list */}
      <div
        ref={scrollContainerRef}
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
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="flex items-baseline gap-2 px-3 py-px hover:bg-btn-hover/50"
              >
                <span className="text-text-tertiary shrink-0 select-all">
                  {formatTimestamp(entry.timestampMs)}
                </span>
                <span className={`${meta.color} font-semibold shrink-0 w-[5ch] text-right`}>
                  {meta.label}
                </span>
                <span className="text-text-primary break-all select-all">{entry.message}</span>
              </div>
            );
          })}
        </div>
      </div>

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
