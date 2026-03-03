import { useRef, useState, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChannelResult } from "../lib/types";
import type { SortDirection, SortField } from "../lib/filters";
import { filterResults, sortResults } from "../lib/filters";
import { ChannelRow } from "./ChannelRow";
import { ArrowDown, ArrowUp } from "lucide-react";

interface ChannelTableProps {
  results: (ChannelResult | null)[];
  search: string;
  groupFilter: string;
  statusFilter: string;
  onSelectChannel: (result: ChannelResult) => void;
  selectedIndex: number | null;
}

const COLUMNS: { key: SortField; label: string; className: string }[] = [
  { key: "index", label: "#", className: "w-12" },
  { key: "status", label: "St", className: "w-8" },
  { key: "name", label: "Channel Name", className: "flex-1 min-w-0 px-2" },
  { key: "group", label: "Group", className: "w-32 px-2" },
  { key: "resolution", label: "Res", className: "w-16 text-center" },
  { key: "codec", label: "Codec", className: "w-16 text-center" },
  { key: "fps", label: "FPS", className: "w-12 text-center" },
  { key: "audio", label: "Audio", className: "w-20 text-right" },
];

export function ChannelTable({
  results,
  search,
  groupFilter,
  statusFilter,
  onSelectChannel,
  selectedIndex,
}: ChannelTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sortField, setSortField] = useState<SortField>("index");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const filteredResults = useMemo(() => {
    const nonNull = results.filter((r): r is ChannelResult => r !== null);
    const filtered = filterResults(nonNull, search, groupFilter, statusFilter);
    return sortResults(filtered, sortField, sortDir);
  }, [results, search, groupFilter, statusFilter, sortField, sortDir]);

  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
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
          virtualizer.scrollToIndex(next);
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const next = prev === null ? 0 : Math.max(prev - 1, 0);
          virtualizer.scrollToIndex(next);
          return next;
        });
      } else if (e.key === "Enter" && focusedIndex !== null) {
        const result = filteredResults[focusedIndex];
        if (result) onSelectChannel(result);
      }
    },
    [filteredResults, focusedIndex, onSelectChannel, virtualizer],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center h-9 px-4 text-xs font-medium text-zinc-500 uppercase tracking-wider border-b border-zinc-700 bg-zinc-800/50 select-none">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            className={`${col.className} hover:text-zinc-300 transition-colors flex items-center gap-1`}
            onClick={() => handleSort(col.key)}
          >
            {col.label}
            {sortField === col.key &&
              (sortDir === "asc" ? (
                <ArrowUp className="w-3 h-3" />
              ) : (
                <ArrowDown className="w-3 h-3" />
              ))}
          </button>
        ))}
      </div>
      {/* Virtualized rows */}
      {filteredResults.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
          No channels match the current filters
        </div>
      ) : (
        <div ref={parentRef} tabIndex={0} onKeyDown={handleKeyDown} className="flex-1 overflow-auto focus:outline-none">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
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
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <ChannelRow
                    result={result}
                    index={result?.index ?? virtualRow.index}
                    onClick={onSelectChannel}
                    selected={selectedIndex === result?.index}
                    focused={focusedIndex === virtualRow.index}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
