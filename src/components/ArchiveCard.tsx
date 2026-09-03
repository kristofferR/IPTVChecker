import { CircleCheck, CircleX, LoaderCircle, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchivePlayOptions, ArchiveSession } from "../hooks/useStreamPlayer";
import { archiveTitle, hasArchive, MAX_CATCHUP_DAYS } from "../lib/archive";
import { probeChannelArchive } from "../lib/archiveProbe";
import { ensureEpgLoaded, epgSourcesFor } from "../lib/epgLoader";
import { isScanActive } from "../lib/scanState";
import { getEpgProgrammes } from "../lib/tauri";
import type { ChannelResult, EpgProgramme } from "../lib/types";
import { useAppStore } from "../store";

interface ArchiveCardProps {
  result: ChannelResult;
  archiveSession: ArchiveSession | null;
  isCasting: boolean;
  onPlayArchive: (result: ChannelResult, options: ArchivePlayOptions) => void;
}

// The EPG download can be hundreds of MB, so it loads lazily the first time a
// catch-up channel's card opens, once per playlist, sources, and indexed IDs.

const MAX_RENDERED_PROGRAMMES = 2_000;

function dayLabel(epochS: number, now: Date): string {
  const date = new Date(epochS * 1000);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function timeLabel(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ArchiveProbe({ result, isCasting }: Pick<ArchiveCardProps, "result" | "isCasting">) {
  const entry = useAppStore((state) => state.archiveProbes[result.index]);
  const probeActive = useAppStore((state) =>
    Object.values(state.archiveProbes).some((probe) => probe.running),
  );
  const setArchiveProbe = useAppStore((state) => state.setArchiveProbe);
  const scanState = useAppStore((state) => state.scanState);
  const singleProvider = useAppStore((state) => state.playlist?.single_provider ?? false);
  const isPlaying = useAppStore((state) => state.playIntentActive);
  const running = entry?.running ?? false;
  const scanActive = isScanActive(scanState);
  const streamActive = singleProvider && (isPlaying || isCasting);
  const outcomes = entry?.outcomes ?? [];
  const isCastingRef = useRef(isCasting);
  useEffect(() => {
    isCastingRef.current = isCasting;
  }, [isCasting]);

  const runProbe = () => {
    const initialState = useAppStore.getState();
    if (
      isScanActive(initialState.scanState) ||
      Object.values(initialState.archiveProbes).some((probe) => probe.running) ||
      (initialState.playlist?.single_provider &&
        (initialState.playIntentActive || isCastingRef.current))
    ) {
      return;
    }
    const playlist = initialState.playlist;
    void probeChannelArchive(
      result,
      (update) => {
        if (useAppStore.getState().playlist === playlist) {
          setArchiveProbe(result.index, update);
        }
      },
      () => {
        const state = useAppStore.getState();
        return (
          state.playlist === playlist &&
          !isScanActive(state.scanState) &&
          !(state.playlist?.single_provider && (state.playIntentActive || isCastingRef.current))
        );
      },
    );
  };

  return (
    <div className="mt-2 border-t border-violet-500/15 pt-2">
      <button
        type="button"
        disabled={probeActive || scanActive || streamActive}
        onClick={runProbe}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-btn px-3 py-1.5 text-[12px] font-medium text-text-primary border border-border-app shadow-sm hover:bg-btn-hover transition-colors disabled:opacity-40"
      >
        {running && <LoaderCircle className="h-3 w-3 animate-spin" />}
        {running ? "Testing catch-up..." : "Test catch-up"}
      </button>
      {outcomes.map((outcome) => (
        <div
          key={outcome.label}
          className="mt-1.5 flex items-center justify-between gap-2 text-[11px]"
        >
          <span className="text-text-secondary">{outcome.label}</span>
          {outcome.ok ? (
            <span className="flex items-center gap-1 font-medium text-green-400">
              <CircleCheck className="h-3 w-3" />
              OK{outcome.latencyMs != null ? ` \u00b7 ${outcome.latencyMs} ms` : ""}
            </span>
          ) : (
            <span
              className="flex min-w-0 items-center gap-1 font-medium text-red-400"
              title={outcome.error ?? undefined}
            >
              <CircleX className="h-3 w-3 shrink-0" />
              <span className="truncate">{outcome.error ?? "Failed"}</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ArchivePicker({
  result,
  onPlayArchive,
}: Pick<ArchiveCardProps, "result" | "onPlayArchive">) {
  const depthDays = Math.min(MAX_CATCHUP_DAYS, Math.max(1, result.catchup_days ?? 1));
  const [daysBack, setDaysBack] = useState(0);
  const [time, setTime] = useState("20:00");
  const now = new Date();

  const watchFrom = () => {
    const [hours, minutes] = time.split(":").map((part) => Number.parseInt(part, 10));
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
    date.setHours(hours || 0, minutes || 0, 0, 0);
    const nowEpochS = Math.floor(Date.now() / 1000);
    const startEpochS = Math.max(
      nowEpochS - depthDays * 86_400,
      Math.min(Math.floor(date.getTime() / 1000), nowEpochS - 60),
    );
    onPlayArchive(result, { startEpochS });
  };

  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        <select
          value={daysBack}
          onChange={(e) => setDaysBack(Number.parseInt(e.target.value, 10))}
          className="native-field h-7 flex-1 min-w-0 rounded-md border border-border-app bg-input pl-2 pr-6 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {Array.from({ length: depthDays + 1 }, (_, daysAgo) => {
            const label = dayLabel(Date.now() / 1000 - daysAgo * 86_400, now);
            return (
              <option key={label} value={daysAgo}>
                {label}
              </option>
            );
          })}
        </select>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="native-field h-7 w-[5.5rem] rounded-md border border-border-app bg-input px-1.5 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <button
        type="button"
        onClick={watchFrom}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm hover:bg-blue-500 transition-colors"
      >
        <Play className="h-3 w-3" />
        Watch from here
      </button>
    </div>
  );
}

export function ArchiveCard({
  result,
  archiveSession,
  isCasting,
  onPlayArchive,
}: ArchiveCardProps) {
  const [programmes, setProgrammes] = useState<EpgProgramme[] | null>(null);
  const depthDays = Math.min(MAX_CATCHUP_DAYS, Math.max(1, result.catchup_days ?? 7));

  useEffect(() => {
    if (!hasArchive(result)) {
      return;
    }
    let stale = false;
    setProgrammes(null);
    const load = async () => {
      if (!result.tvg_id) {
        if (!stale) setProgrammes([]);
        return;
      }
      try {
        await ensureEpgLoaded();
      } catch {
        if (!stale) setProgrammes([]);
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const list = await getEpgProgrammes(
        epgSourcesFor(result),
        result.tvg_id,
        now - depthDays * 86_400,
        now,
      ).catch(() => [] as EpgProgramme[]);
      if (!stale) setProgrammes(list);
    };
    void load();
    return () => {
      stale = true;
    };
  }, [depthDays, result]);

  const dayGroups = useMemo(() => {
    if (!programmes || programmes.length === 0) return [];
    const now = new Date();
    const nowEpochS = Math.floor(now.getTime() / 1000);
    const retentionStartEpochS = nowEpochS - depthDays * 86_400;
    const groups: Array<{ label: string; entries: EpgProgramme[] }> = [];
    const visibleProgrammes = programmes
      .filter(
        (programme) => programme.start >= retentionStartEpochS && programme.start <= nowEpochS,
      )
      .slice(-MAX_RENDERED_PROGRAMMES);
    // Newest day first, programmes within a day in airing order.
    for (const programme of visibleProgrammes) {
      const label = dayLabel(programme.start, now);
      const group = groups.find((candidate) => candidate.label === label);
      if (group) {
        group.entries.push(programme);
      } else {
        groups.push({ label, entries: [programme] });
      }
    }
    groups.reverse();
    return groups;
  }, [depthDays, programmes]);

  if (!hasArchive(result)) {
    return null;
  }

  const playingStart =
    archiveSession && archiveSession.baseResult.index === result.index
      ? archiveSession.windowStartEpochS
      : null;

  return (
    <div className="p-2 rounded bg-violet-500/10 border border-violet-500/20">
      <p
        className="text-[12px] font-medium text-violet-300"
        title={archiveTitle(result) ?? undefined}
      >
        Archive
        <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-violet-300/80">
          {result.catchup ?? "default"}
          {result.catchup_days != null ? ` · ${result.catchup_days} d` : ""}
        </span>
      </p>

      {programmes === null ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          Loading guide...
        </div>
      ) : dayGroups.length > 0 ? (
        <div className="mt-1">
          {dayGroups.map((group) => (
            <div key={group.label}>
              <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {group.label}
              </p>
              {group.entries.map((programme) => {
                const playing = playingStart === programme.start;
                return (
                  <button
                    key={`${programme.start}-${programme.stop}-${programme.title}`}
                    type="button"
                    onClick={() =>
                      onPlayArchive(result, {
                        startEpochS: programme.start,
                        endEpochS: programme.stop,
                        title: programme.title,
                      })
                    }
                    className={`flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-[11px] transition-colors ${
                      playing
                        ? "bg-violet-500/20 text-violet-200"
                        : "text-text-secondary hover:bg-panel-subtle hover:text-text-primary"
                    }`}
                  >
                    <span className="shrink-0 tabular-nums text-text-tertiary">
                      {timeLabel(programme.start)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{programme.title}</span>
                    <Play className="h-2.5 w-2.5 shrink-0 opacity-60" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <ArchivePicker result={result} onPlayArchive={onPlayArchive} />
      )}

      <ArchiveProbe result={result} isCasting={isCasting} />
    </div>
  );
}
