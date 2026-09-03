import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleCheck, CircleX, Download, LoaderCircle, Play } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ArchivePlayOptions } from "../hooks/useStreamPlayer";
import { archiveBadgeText, hasArchive, resolveArchivePlayback } from "../lib/archive";
import { startArchiveDownload } from "../lib/archiveDownload";
import {
  type ArchiveProbeOutcome,
  probeArchivePoint,
  verifyArchivePointResponse,
} from "../lib/archiveProbe";
import { fetchGuideProgrammes } from "../lib/epgLoader";
import { filterResultsShared } from "../lib/filters";
import { isSingleConnectionPlaylist } from "../lib/playback";
import { isScanActive } from "../lib/scanState";
import { isInputLikeTarget } from "../lib/shortcuts";
import { dayLabel, startOfDayEpochS, timeLabel } from "../lib/timeFormat";
import type { ChannelResult, EpgProgramme } from "../lib/types";
import { useAppStore } from "../store";

// The guide is one continuous canvas: trackpad scrolling moves through time
// horizontally (left = into the past) and through channels vertically. The
// channel column and the time axis stay pinned with position: sticky.
const ROW_HEIGHT_PX = 32;
const AXIS_HEIGHT_PX = 22;
const CHANNEL_COL_PX = 150;
const PX_PER_HOUR = 240;
const MAX_GUIDE_DEPTH_DAYS = 14;
const GUIDE_CLOCK_INTERVAL_MS = 30_000;
/** Programmes outside the viewport by more than this are not rendered. */
const RENDER_BUFFER_S = 2 * 3600;
/** Visible-range changes are quantized so scrolling does not re-render rows every frame. */
const RENDER_STEP_S = 1800;

interface GuideSelection {
  result: ChannelResult;
  programme: EpgProgramme;
}

function isProgrammePlayable(selection: GuideSelection, nowEpochS: number): boolean {
  const earliestPlayable =
    selection.result.catchup_days != null
      ? nowEpochS - selection.result.catchup_days * 86_400
      : null;
  return (
    selection.programme.start <= nowEpochS &&
    (earliestPlayable == null || selection.programme.start >= earliestPlayable)
  );
}

function selectionKey(selection: GuideSelection | null): string | null {
  return selection ? `${selection.result.index}:${selection.programme.start}` : null;
}

function playOptionsFor(selection: GuideSelection): ArchivePlayOptions {
  return {
    startEpochS: selection.programme.start,
    endEpochS: selection.programme.stop,
    title: selection.programme.title,
  };
}

interface GuideRowProps {
  result: ChannelResult;
  spanFrom: number;
  spanTo: number;
  renderFrom: number;
  renderTo: number;
  nowEpochS: number;
  selectedKey: string | null;
  onSelect: (selection: GuideSelection) => void;
  onActivate: (selection: GuideSelection) => void;
  onContextMenu: (selection: GuideSelection, x: number, y: number) => void;
}

const GuideRow = memo(function GuideRow({
  result,
  spanFrom,
  spanTo,
  renderFrom,
  renderTo,
  nowEpochS,
  selectedKey,
  onSelect,
  onActivate,
  onContextMenu,
}: GuideRowProps) {
  const [programmes, setProgrammes] = useState<EpgProgramme[] | null>(null);
  const epgSourceKey = useAppStore((state) =>
    JSON.stringify(
      state.playlist?.epg_sources_by_playlist[result.playlist] ?? state.playlist?.epg_sources ?? [],
    ),
  );

  useEffect(() => {
    let stale = false;
    setProgrammes(null);
    if (!result.tvg_id) {
      setProgrammes([]);
      return;
    }
    fetchGuideProgrammes(result, spanFrom, spanTo).then((list) => {
      if (!stale) setProgrammes(list);
    });
    return () => {
      stale = true;
    };
  }, [result.playlist, result.tvg_id, epgSourceKey, spanFrom, spanTo]);

  const earliestPlayable =
    result.catchup_days != null ? nowEpochS - result.catchup_days * 86_400 : null;
  const xOf = (epochS: number) => CHANNEL_COL_PX + ((epochS - spanFrom) / 3600) * PX_PER_HOUR;

  return (
    <div className="flex h-full items-stretch border-b border-border-subtle">
      <div
        className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-border-subtle bg-content px-2"
        style={{ width: `${CHANNEL_COL_PX}px` }}
      >
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{result.name}</span>
        <span className="shrink-0 text-[9px] font-bold uppercase text-violet-400">
          {archiveBadgeText(result)}
        </span>
      </div>
      <div className="relative min-w-0 flex-1">
        {programmes === null ? (
          <div
            className="sticky flex h-full w-max items-center px-2 text-[10px] text-text-tertiary"
            style={{ left: `${CHANNEL_COL_PX}px` }}
          >
            <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" /> Loading...
          </div>
        ) : programmes.length === 0 ? (
          <div
            className="sticky flex h-full w-max items-center px-2 text-[10px] text-text-tertiary"
            style={{ left: `${CHANNEL_COL_PX}px` }}
          >
            {result.tvg_id ? "No programme data" : "No EPG id"}
          </div>
        ) : (
          programmes.map((programme) => {
            if (programme.stop < renderFrom || programme.start > renderTo) return null;
            const left = xOf(Math.max(programme.start, spanFrom)) - CHANNEL_COL_PX;
            const width = xOf(Math.min(programme.stop, spanTo)) - CHANNEL_COL_PX - left;
            if (width < 2) return null;
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(selection);
                  onContextMenu(selection, event.clientX, event.clientY);
                }}
                title={`${timeLabel(programme.start)}–${timeLabel(programme.stop)} ${programme.title}${playable ? "" : " (unavailable)"}`}
                className={`absolute inset-y-[3px] flex items-center gap-1 overflow-hidden rounded px-1.5 text-left text-[10.5px] transition-colors ${
                  selected
                    ? "bg-violet-500/35 text-violet-100 ring-1 ring-violet-400/70"
                    : playable
                      ? "bg-violet-500/12 text-text-primary ring-1 ring-violet-500/20 hover:bg-violet-500/25"
                      : "bg-panel-subtle text-text-tertiary ring-1 ring-border-subtle"
                }`}
                style={{ left: `${left}px`, width: `${width - 1}px` }}
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

interface ProgrammeMenuState {
  selection: GuideSelection;
  x: number;
  y: number;
}

export function GuideView({
  onPlayArchive,
}: {
  onPlayArchive: (result: ChannelResult, options: ArchivePlayOptions) => void;
}) {
  const flatResults = useAppStore((s) => s.flatResults);
  const playlist = useAppStore((s) => s.playlist);
  const search = useAppStore((s) => s.search);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const guideFocusChannelIndex = useAppStore((s) => s.guideFocusChannelIndex);
  const setGuideFocusChannelIndex = useAppStore((s) => s.setGuideFocusChannelIndex);
  const scanState = useAppStore((s) => s.scanState);
  const archiveVerifyRun = useAppStore((s) => s.archiveVerifyRun);
  const archiveGuideTestRunning = useAppStore((s) => s.archiveGuideTestRunning);
  const archiveProbeRunning = useAppStore((s) =>
    Object.values(s.archiveProbes).some((entry) => entry.running),
  );
  const playIntentActive = useAppStore((s) => s.playIntentActive);
  const castActive = useAppStore((s) => s.castActive);

  const [nowEpochS, setNowEpochS] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = window.setInterval(
      () => setNowEpochS(Math.floor(Date.now() / 1000)),
      GUIDE_CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, []);

  const channels = useMemo(
    () => filterResultsShared(flatResults, search, groupFilter, "all").filter(hasArchive),
    [flatResults, search, groupFilter],
  );

  const maxDepthDays = useMemo(() => {
    const deepest = channels.reduce((max, channel) => Math.max(max, channel.catchup_days ?? 1), 1);
    return Math.min(MAX_GUIDE_DEPTH_DAYS, deepest);
  }, [channels]);

  // The canvas spans local midnight `maxDepthDays` ago through the end of today.
  const spanFrom = useMemo(() => startOfDayEpochS(maxDepthDays), [maxDepthDays]);
  const spanTo = useMemo(() => startOfDayEpochS(0) + 86_400, []);
  const totalWidthPx = CHANNEL_COL_PX + ((spanTo - spanFrom) / 3600) * PX_PER_HOUR;
  const xOf = useCallback(
    (epochS: number) => CHANNEL_COL_PX + ((epochS - spanFrom) / 3600) * PX_PER_HOUR,
    [spanFrom],
  );

  const [selection, setSelection] = useState<GuideSelection | null>(null);
  const [menu, setMenu] = useState<ProgrammeMenuState | null>(null);
  const [testOutcome, setTestOutcome] = useState<ArchiveProbeOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const testRequestRef = useRef(0);
  const selectionRef = useRef<GuideSelection | null>(null);

  useEffect(() => {
    testRequestRef.current += 1;
    selectionRef.current = null;
    setSelection(null);
    setMenu(null);
    setTestOutcome(null);
  }, [playlist]);

  // Esc closes the menu, then returns to the table view.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isInputLikeTarget(event.target)) return;
      if (menu) {
        setMenu(null);
        return;
      }
      setViewMode("table");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setViewMode, menu]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
    scrollMargin: AXIS_HEIGHT_PX,
  });

  // Horizontal window actually rendered, quantized to keep row props stable.
  const [renderRange, setRenderRange] = useState<{ from: number; to: number }>(() => ({
    from: spanFrom,
    to: spanTo,
  }));
  const updateRenderRange = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const fromS = spanFrom + ((el.scrollLeft - CHANNEL_COL_PX) / PX_PER_HOUR) * 3600;
    const toS = spanFrom + ((el.scrollLeft + el.clientWidth) / PX_PER_HOUR) * 3600;
    const from = Math.floor((fromS - RENDER_BUFFER_S) / RENDER_STEP_S) * RENDER_STEP_S;
    const to = Math.ceil((toS + RENDER_BUFFER_S) / RENDER_STEP_S) * RENDER_STEP_S;
    setRenderRange((prev) => (prev.from === from && prev.to === to ? prev : { from, to }));
  }, [spanFrom]);

  const scrollFrameRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    setMenu(null);
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateRenderRange();
    });
  }, [updateRenderRange]);
  useEffect(
    () => () => {
      if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );

  const scrollToTime = useCallback(
    (epochS: number, fraction = 0.7) => {
      const el = parentRef.current;
      if (!el) return;
      const viewport = Math.max(0, el.clientWidth - CHANNEL_COL_PX);
      el.scrollLeft = Math.max(0, xOf(epochS) - CHANNEL_COL_PX - viewport * fraction);
      updateRenderRange();
    },
    [xOf, updateRenderRange],
  );

  // First paint: put "now" toward the right edge so the recent past fills the view.
  const initialScrollDone = useRef(false);
  useLayoutEffect(() => {
    if (initialScrollDone.current) return;
    initialScrollDone.current = true;
    scrollToTime(Math.floor(Date.now() / 1000));
  }, [scrollToTime]);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateRenderRange);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateRenderRange]);

  // Right-click "Browse Catch-up" lands on the requested channel.
  useEffect(() => {
    if (guideFocusChannelIndex == null) return;
    const rowIndex = channels.findIndex((channel) => channel.index === guideFocusChannelIndex);
    if (rowIndex >= 0) {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    }
    setGuideFocusChannelIndex(null);
  }, [guideFocusChannelIndex, channels, virtualizer, setGuideFocusChannelIndex]);

  // Close the programme menu on outside clicks.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menu]);

  const activate = (target: GuideSelection) => {
    if (testing) return;
    if (!isProgrammePlayable(target, Math.floor(Date.now() / 1000))) return;
    onPlayArchive(target.result, playOptionsFor(target));
  };

  const runTest = async (target: GuideSelection | null = selection) => {
    if (!target) return;
    const state = useAppStore.getState();
    if (
      isScanActive(state.scanState) ||
      state.archiveVerifyRun ||
      state.archiveGuideTestRunning ||
      Object.values(state.archiveProbes).some((entry) => entry.running) ||
      ((state.playIntentActive || state.castActive) && isSingleConnectionPlaylist(state.playlist))
    ) {
      return;
    }
    if (
      state.externalPlaybackActive &&
      isSingleConnectionPlaylist(state.playlist) &&
      !window.confirm("Close the external player before testing catch-up. Continue?")
    ) {
      return;
    }
    const testedSelectionKey = selectionKey(target);
    const requestId = ++testRequestRef.current;
    const playlistAtStart = state.playlist;
    const now = Math.floor(Date.now() / 1000);
    if (target.programme.start > now) return;
    state.setExternalPlaybackActive(false);
    setTesting(true);
    setTestOutcome(null);
    state.setArchiveGuideTestRunning(true);
    const point = {
      label: timeLabel(target.programme.start),
      daysBack: Math.round((now - target.programme.start) / 86_400),
      startEpochS: target.programme.start,
    };
    let outcome: ArchiveProbeOutcome | null = null;
    try {
      const probed = await probeArchivePoint(target.result, point, now);
      outcome = probed ? verifyArchivePointResponse(probed) : null;
    } catch (error) {
      outcome = {
        label: point.label,
        daysBack: point.daysBack,
        ok: false,
        depthVerified: false,
        requestedStartEpochS: point.startEpochS,
        requestUrl: target.result.url,
        responseUrl: null,
        latencyMs: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      const currentState = useAppStore.getState();
      currentState.setArchiveGuideTestRunning(false);
      if (
        currentState.playlist === playlistAtStart &&
        requestId === testRequestRef.current &&
        selectionKey(selectionRef.current) === testedSelectionKey
      ) {
        setTestOutcome(outcome);
      }
      setTesting(false);
    }
  };

  const copyArchiveUrl = async (target: GuideSelection) => {
    const resolved = resolveArchivePlayback(target.result, {
      startEpochS: target.programme.start,
      endEpochS: target.programme.stop,
    });
    if (resolved) await navigator.clipboard.writeText(resolved.url);
  };

  const testBlocked =
    testing ||
    isScanActive(scanState) ||
    archiveVerifyRun !== null ||
    archiveGuideTestRunning ||
    archiveProbeRunning ||
    ((playIntentActive || castActive) && isSingleConnectionPlaylist(playlist));
  const selectionPlayable = selection != null && isProgrammePlayable(selection, nowEpochS);
  const menuPlayable = menu != null && isProgrammePlayable(menu.selection, nowEpochS);

  const select = (next: GuideSelection) => {
    testRequestRef.current += 1;
    selectionRef.current = next;
    setSelection(next);
    setTestOutcome(null);
    setTesting(false);
  };

  // Hour ticks and day boundaries across the whole span.
  const axis = useMemo(() => {
    const hours: number[] = [];
    for (let t = spanFrom; t < spanTo; t += 3600) hours.push(t);
    const days: number[] = [];
    for (let offset = maxDepthDays; offset >= 0; offset -= 1) days.push(startOfDayEpochS(offset));
    return { hours, days };
  }, [spanFrom, spanTo, maxDepthDays]);

  const dayTabs = useMemo(
    () => Array.from({ length: maxDepthDays + 1 }, (_, index) => maxDepthDays - index),
    [maxDepthDays],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Control strip: day jumps, selection actions */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-panel-muted px-3 py-1.5">
        <div className="flex max-w-[55%] items-center gap-1 overflow-x-auto">
          {dayTabs.map((offset) => (
            <button
              key={offset}
              type="button"
              onClick={() =>
                offset === 0
                  ? scrollToTime(nowEpochS)
                  : scrollToTime(startOfDayEpochS(offset) + 6 * 3600, 0)
              }
              className="shrink-0 rounded-md px-2.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-panel-subtle hover:text-text-primary"
            >
              {dayLabel(startOfDayEpochS(offset) + 43_200)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => scrollToTime(nowEpochS)}
            className="shrink-0 rounded-md bg-btn px-2.5 py-0.5 text-[11px] text-text-primary hover:bg-btn-hover"
          >
            Now
          </button>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {testOutcome &&
            (testOutcome.ok && testOutcome.depthVerified ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-green-400">
                <CircleCheck className="h-3 w-3" />
                OK{testOutcome.latencyMs != null ? ` · ${testOutcome.latencyMs} ms` : ""}
              </span>
            ) : testOutcome.ok ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-amber-400">
                <CircleCheck className="h-3 w-3" />
                Unverified{testOutcome.latencyMs != null ? ` · ${testOutcome.latencyMs} ms` : ""}
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
                {selection.result.name} · {dayLabel(selection.programme.start)}{" "}
                {timeLabel(selection.programme.start)}
              </span>
              <button
                type="button"
                disabled={!selectionPlayable || testing}
                onClick={() => activate(selection)}
                title={selectionPlayable ? undefined : "This programme is outside catch-up range"}
                className="flex shrink-0 items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play className="h-3 w-3" />
                Play
              </button>
              <button
                type="button"
                disabled={testBlocked}
                onClick={() => void runTest()}
                className="shrink-0 rounded-md border border-border-app bg-btn px-2.5 py-1 text-[11px] font-medium text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-40"
              >
                {testing ? "Testing..." : "Test"}
              </button>
            </>
          )}
        </div>
      </div>

      {channels.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
          No catch-up channels match the current filters
        </div>
      ) : (
        <div
          ref={parentRef}
          onScroll={handleScroll}
          onContextMenu={(event) => event.preventDefault()}
          className="native-scroll relative min-h-0 flex-1 overflow-auto"
        >
          <div style={{ width: `${totalWidthPx}px` }}>
            {/* Time axis, pinned to the top while channels scroll */}
            <div
              className="sticky top-0 z-20 flex border-b border-border-subtle bg-panel-muted text-[9px] text-text-tertiary"
              style={{ height: `${AXIS_HEIGHT_PX}px` }}
            >
              <div
                className="sticky left-0 z-30 shrink-0 border-r border-border-subtle bg-panel-muted"
                style={{ width: `${CHANNEL_COL_PX}px` }}
              />
              <div className="relative flex-1">
                {axis.hours.map((hour) => (
                  <span
                    key={hour}
                    className="absolute top-0 flex h-full items-end border-l border-border-subtle/50 px-1 pb-0.5 tabular-nums"
                    style={{ left: `${xOf(hour) - CHANNEL_COL_PX}px` }}
                  >
                    {timeLabel(hour)}
                  </span>
                ))}
                {axis.days.map((day) => (
                  <span
                    key={day}
                    className="absolute top-0 border-l border-border-app px-1 text-[9px] font-semibold text-text-secondary"
                    style={{ left: `${xOf(day) - CHANNEL_COL_PX}px` }}
                  >
                    {dayLabel(day + 43_200)}
                  </span>
                ))}
              </div>
            </div>

            {/* Channel rows */}
            <div className="relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {/* Now marker */}
              {nowEpochS >= spanFrom && nowEpochS <= spanTo && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 z-[5] w-px bg-violet-400/80"
                  style={{ left: `${xOf(nowEpochS)}px` }}
                />
              )}
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const channel = channels[virtualRow.index];
                return (
                  <div
                    key={channel.index}
                    className="absolute inset-x-0"
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    <GuideRow
                      result={channel}
                      spanFrom={spanFrom}
                      spanTo={spanTo}
                      renderFrom={renderRange.from}
                      renderTo={renderRange.to}
                      nowEpochS={nowEpochS}
                      selectedKey={selectionKey(selection)}
                      onSelect={select}
                      onActivate={activate}
                      onContextMenu={(target, x, y) => setMenu({ selection: target, x, y })}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          data-no-window-drag
          className="fixed z-50 w-56 rounded-lg border border-border-app bg-dropdown py-1 shadow-2xl"
          style={{
            top: `${Math.min(menu.y, window.innerHeight - 180)}px`,
            left: `${Math.min(menu.x, window.innerWidth - 232)}px`,
          }}
        >
          <div className="truncate px-3 pb-1 pt-1.5 text-[11px] text-text-tertiary">
            {menu.selection.programme.title} · {timeLabel(menu.selection.programme.start)}
          </div>
          <button
            type="button"
            disabled={!menuPlayable || testing}
            onClick={() => {
              const target = menu.selection;
              setMenu(null);
              activate(target);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-btn-hover disabled:pointer-events-none disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> Play
          </button>
          <button
            type="button"
            disabled={!menuPlayable}
            onClick={() => {
              const target = menu.selection;
              setMenu(null);
              void startArchiveDownload(target.result, playOptionsFor(target));
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-btn-hover disabled:pointer-events-none disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Download…
          </button>
          <div className="my-1 h-px bg-border-subtle" />
          <button
            type="button"
            disabled={testBlocked || !menuPlayable}
            onClick={() => {
              const target = menu.selection;
              setMenu(null);
              void runTest(target);
            }}
            className="w-full px-3 py-2 text-left text-[13px] hover:bg-btn-hover disabled:pointer-events-none disabled:opacity-50"
          >
            Test Catch-up
          </button>
          <button
            type="button"
            onClick={() => {
              const target = menu.selection;
              setMenu(null);
              void copyArchiveUrl(target);
            }}
            className="w-full px-3 py-2 text-left text-[13px] hover:bg-btn-hover"
          >
            Copy Archive URL
          </button>
        </div>
      )}
    </div>
  );
}
