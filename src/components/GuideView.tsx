import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, CircleCheck, CircleX, LoaderCircle, Play } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ArchivePlayOptions } from "../hooks/useStreamPlayer";
import { archiveBadgeText, hasArchive } from "../lib/archive";
import { type ArchiveProbeOutcome, probeArchivePoint } from "../lib/archiveProbe";
import { fetchGuideProgrammes } from "../lib/epgLoader";
import { filterResultsShared } from "../lib/filters";
import { isScanActive } from "../lib/scanState";
import { isInputLikeTarget } from "../lib/shortcuts";
import { dayLabel, startOfDayEpochS, timeLabel } from "../lib/timeFormat";
import type { ChannelResult, EpgProgramme } from "../lib/types";
import { useAppStore } from "../store";

const ROW_HEIGHT_PX = 32;
const WINDOW_HOURS = 6;
const MAX_GUIDE_DEPTH_DAYS = 14;

interface GuideSelection {
  result: ChannelResult;
  programme: EpgProgramme;
}

function selectionKey(selection: GuideSelection | null): string | null {
  return selection ? `${selection.result.index}:${selection.programme.start}` : null;
}

interface GuideRowProps {
  result: ChannelResult;
  windowFrom: number;
  windowTo: number;
  nowEpochS: number;
  selectedKey: string | null;
  onSelect: (selection: GuideSelection) => void;
  onActivate: (selection: GuideSelection) => void;
}

const GuideRow = memo(function GuideRow({
  result,
  windowFrom,
  windowTo,
  nowEpochS,
  selectedKey,
  onSelect,
  onActivate,
}: GuideRowProps) {
  const [programmes, setProgrammes] = useState<EpgProgramme[] | null>(null);

  useEffect(() => {
    let stale = false;
    setProgrammes(null);
    if (!result.tvg_id) {
      setProgrammes([]);
      return;
    }
    fetchGuideProgrammes(result.tvg_id, windowFrom, windowTo).then((list) => {
      if (!stale) setProgrammes(list);
    });
    return () => {
      stale = true;
    };
  }, [result.tvg_id, windowFrom, windowTo]);

  const windowLength = windowTo - windowFrom;
  const earliestPlayable =
    result.catchup_days != null ? nowEpochS - result.catchup_days * 86_400 : null;

  return (
    <div className="flex h-full items-stretch border-b border-border-subtle">
      <div className="flex w-[150px] shrink-0 items-center gap-1.5 border-r border-border-subtle px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{result.name}</span>
        <span className="shrink-0 text-[9px] font-bold uppercase text-violet-400">
          {archiveBadgeText(result)}
        </span>
      </div>
      <div className="relative min-w-0 flex-1">
        {programmes === null ? (
          <div className="flex h-full items-center px-2 text-[10px] text-text-tertiary">
            <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" /> Loading...
          </div>
        ) : programmes.length === 0 ? (
          <div className="flex h-full items-center px-2 text-[10px] text-text-tertiary">
            {result.tvg_id ? "No programme data" : "No EPG id"}
          </div>
        ) : (
          programmes.map((programme) => {
            const left = Math.max(0, (programme.start - windowFrom) / windowLength);
            const right = Math.min(1, (programme.stop - windowFrom) / windowLength);
            const width = right - left;
            if (width <= 0.005) return null;
            const playable =
              programme.start <= nowEpochS &&
              (earliestPlayable == null || programme.start >= earliestPlayable);
            const selection: GuideSelection = { result, programme };
            const selected = selectedKey === `${result.index}:${programme.start}`;
            return (
              <button
                key={programme.start}
                type="button"
                onClick={() => onSelect(selection)}
                onDoubleClick={() => playable && onActivate(selection)}
                title={`${timeLabel(programme.start)}–${timeLabel(programme.stop)} ${programme.title}${playable ? "" : " (unavailable)"}`}
                className={`absolute inset-y-[3px] flex items-center gap-1 overflow-hidden rounded px-1.5 text-left text-[10.5px] transition-colors ${
                  selected
                    ? "bg-violet-500/35 text-violet-100 ring-1 ring-violet-400/70"
                    : playable
                      ? "bg-violet-500/12 text-text-primary ring-1 ring-violet-500/20 hover:bg-violet-500/25"
                      : "bg-panel-subtle text-text-tertiary ring-1 ring-border-subtle"
                }`}
                style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
              >
                <span className="shrink-0 text-[9px] tabular-nums opacity-70">
                  {timeLabel(programme.start)}
                </span>
                <span className="truncate">{programme.title}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
});

export function GuideView({
  onPlayArchive,
}: {
  onPlayArchive: (result: ChannelResult, options: ArchivePlayOptions) => void;
}) {
  const flatResults = useAppStore((s) => s.flatResults);
  const search = useAppStore((s) => s.search);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const guideFocusChannelIndex = useAppStore((s) => s.guideFocusChannelIndex);
  const setGuideFocusChannelIndex = useAppStore((s) => s.setGuideFocusChannelIndex);
  const scanState = useAppStore((s) => s.scanState);
  const archiveVerifyRun = useAppStore((s) => s.archiveVerifyRun);
  const archiveProbeRunning = useAppStore((s) =>
    Object.values(s.archiveProbes).some((entry) => entry.running),
  );

  const nowEpochS = useMemo(() => Math.floor(Date.now() / 1000), []);

  const channels = useMemo(
    () => filterResultsShared(flatResults, search, groupFilter, "all").filter(hasArchive),
    [flatResults, search, groupFilter],
  );

  const maxDepthDays = useMemo(() => {
    const deepest = channels.reduce((max, channel) => Math.max(max, channel.catchup_days ?? 1), 1);
    return Math.min(MAX_GUIDE_DEPTH_DAYS, deepest);
  }, [channels]);

  const [daysAgo, setDaysAgo] = useState(0);
  const [windowStartHour, setWindowStartHour] = useState(() => {
    const hour = new Date().getHours();
    return Math.floor(hour / WINDOW_HOURS) * WINDOW_HOURS;
  });
  const [selection, setSelection] = useState<GuideSelection | null>(null);
  const [testOutcome, setTestOutcome] = useState<ArchiveProbeOutcome | null>(null);
  const [testing, setTesting] = useState(false);

  const windowFrom = startOfDayEpochS(daysAgo) + windowStartHour * 3600;
  const windowTo = windowFrom + WINDOW_HOURS * 3600;

  const shiftWindow = (direction: -1 | 1) => {
    const nextHour = windowStartHour + direction * WINDOW_HOURS;
    if (nextHour < 0) {
      if (daysAgo < maxDepthDays) {
        setDaysAgo(daysAgo + 1);
        setWindowStartHour(24 - WINDOW_HOURS);
      }
    } else if (nextHour >= 24) {
      if (daysAgo > 0) {
        setDaysAgo(daysAgo - 1);
        setWindowStartHour(0);
      }
    } else {
      setWindowStartHour(nextHour);
    }
  };

  // Esc returns to the table view.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isInputLikeTarget(event.target)) {
        setViewMode("table");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setViewMode]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  // Right-click "Browse Catch-up" lands on the requested channel.
  useEffect(() => {
    if (guideFocusChannelIndex == null) return;
    const rowIndex = channels.findIndex((channel) => channel.index === guideFocusChannelIndex);
    if (rowIndex >= 0) {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    }
    setGuideFocusChannelIndex(null);
  }, [guideFocusChannelIndex, channels, virtualizer, setGuideFocusChannelIndex]);

  const activate = (target: GuideSelection) => {
    onPlayArchive(target.result, {
      startEpochS: target.programme.start,
      endEpochS: target.programme.stop,
      title: target.programme.title,
    });
  };

  const runTest = async () => {
    if (!selection) return;
    const state = useAppStore.getState();
    if (
      isScanActive(state.scanState) ||
      state.archiveVerifyRun ||
      Object.values(state.archiveProbes).some((entry) => entry.running)
    ) {
      return;
    }
    const target = selection;
    setTesting(true);
    setTestOutcome(null);
    state.setArchiveProbe(target.result.index, {
      running: true,
      outcomes: [],
      checkedAt: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const outcome = await probeArchivePoint(
      target.result,
      {
        label: timeLabel(target.programme.start),
        daysBack: Math.max(0, Math.round((now - target.programme.start) / 86_400)),
        startEpochS: target.programme.start,
      },
      now,
    );
    useAppStore.getState().setArchiveProbe(target.result.index, {
      running: false,
      outcomes: outcome ? [outcome] : [],
      checkedAt: now,
    });
    setTestOutcome(outcome);
    setTesting(false);
  };

  const testBlocked =
    testing || isScanActive(scanState) || archiveVerifyRun !== null || archiveProbeRunning;

  const hourLabels = Array.from(
    { length: WINDOW_HOURS },
    (_, index) => `${String(windowStartHour + index).padStart(2, "0")}:00`,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Control strip: date tabs, window pager, selection actions */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-panel-muted px-3 py-1.5">
        <div className="flex max-w-[40%] items-center gap-1 overflow-x-auto">
          {Array.from({ length: maxDepthDays + 1 }, (_, index) => maxDepthDays - index).map(
            (offset) => (
              <button
                key={offset}
                type="button"
                onClick={() => setDaysAgo(offset)}
                className={`shrink-0 rounded-md px-2.5 py-0.5 text-[11px] transition-colors ${
                  offset === daysAgo
                    ? "bg-btn text-text-primary"
                    : "text-text-secondary hover:bg-panel-subtle"
                }`}
              >
                {dayLabel(startOfDayEpochS(offset) + 43_200)}
              </button>
            ),
          )}
        </div>
        <div className="flex items-center gap-0.5 text-[11px] text-text-tertiary">
          <button
            type="button"
            onClick={() => shiftWindow(-1)}
            className="rounded p-0.5 hover:bg-panel-subtle hover:text-text-primary"
            title="Earlier"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="tabular-nums">
            {hourLabels[0]} – {String((windowStartHour + WINDOW_HOURS) % 24 || 24).padStart(2, "0")}
            :00
          </span>
          <button
            type="button"
            onClick={() => shiftWindow(1)}
            className="rounded p-0.5 hover:bg-panel-subtle hover:text-text-primary"
            title="Later"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {testOutcome &&
            (testOutcome.ok ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-green-400">
                <CircleCheck className="h-3 w-3" />
                OK{testOutcome.latencyMs != null ? ` · ${testOutcome.latencyMs} ms` : ""}
              </span>
            ) : (
              <span
                className="flex items-center gap-1 text-[11px] font-medium text-red-400"
                title={testOutcome.error ?? undefined}
              >
                <CircleX className="h-3 w-3" />
                Failed
              </span>
            ))}
          {selection && (
            <>
              <span className="min-w-0 truncate text-[11px] text-text-secondary">
                <span className="font-medium text-violet-300">{selection.programme.title}</span> ·{" "}
                {selection.result.name} · {timeLabel(selection.programme.start)}
              </span>
              <button
                type="button"
                onClick={() => activate(selection)}
                className="flex shrink-0 items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 transition-colors"
              >
                <Play className="h-3 w-3" />
                Play
              </button>
              <button
                type="button"
                disabled={testBlocked}
                onClick={runTest}
                className="shrink-0 rounded-md border border-border-app bg-btn px-2.5 py-1 text-[11px] font-medium text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-40"
              >
                {testing ? "Testing..." : "Test"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Time axis */}
      <div className="flex shrink-0 border-b border-border-subtle bg-panel-muted pl-[150px] text-[9px] text-text-tertiary">
        {hourLabels.map((label) => (
          <span key={label} className="flex-1 border-l border-border-subtle/50 px-1 py-0.5">
            {label}
          </span>
        ))}
      </div>

      {channels.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
          No catch-up channels match the current filters
        </div>
      ) : (
        <div ref={parentRef} className="native-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const channel = channels[virtualRow.index];
              return (
                <div
                  key={channel.index}
                  className="absolute inset-x-0"
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <GuideRow
                    result={channel}
                    windowFrom={windowFrom}
                    windowTo={windowTo}
                    nowEpochS={nowEpochS}
                    selectedKey={selectionKey(selection)}
                    onSelect={(next) => {
                      setSelection(next);
                      setTestOutcome(null);
                    }}
                    onActivate={activate}
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
