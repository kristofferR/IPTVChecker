import { ChevronRight, CircleCheck, CircleX, LoaderCircle, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDisclosure } from "../hooks/useDisclosure";
import type { ArchivePlayOptions, ArchiveSession } from "../hooks/useStreamPlayer";
import { formatCount, getFormatLocale, t } from "../i18n";
import { translateReason } from "../i18n/reasons";
import { archivePickerDefault, archiveTitle, hasArchive, MAX_CATCHUP_DAYS } from "../lib/archive";
import type { ArchiveProbeOutcome } from "../lib/archiveProbe";
import { probeChannelArchive } from "../lib/archiveProbe";
import { archiveFailure, archiveFailureSentence, archiveVerdict } from "../lib/archiveVerification";
import { ensureEpgLoaded, epgSourcesFor } from "../lib/epgLoader";
import { isSingleConnectionPlaylist } from "../lib/playback";
import { isScanActive } from "../lib/scanState";
import { getEpgProgrammes } from "../lib/tauri";
import { dayLabel } from "../lib/timeFormat";
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

function timeLabel(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString(getFormatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Probe point name; derived from depth so the stored label stays a stable key. */
function outcomePointLabel(outcome: ArchiveProbeOutcome): string {
  return outcome.daysBack <= 0
    ? t("archive.outcome.pointNear")
    : t("archive.outcome.pointDays", { days: formatCount(outcome.daysBack) });
}

function ArchiveProbe({ result, isCasting }: Pick<ArchiveCardProps, "result" | "isCasting">) {
  const entry = useAppStore((state) => state.archiveProbes[result.index]);
  const setArchiveProbe = useAppStore((state) => state.setArchiveProbe);
  const scanState = useAppStore((state) => state.scanState);
  const archiveGuideTestRunning = useAppStore((state) => state.archiveGuideTestRunning);
  const playlist = useAppStore((state) => state.playlist);
  const playIntentActive = useAppStore((state) => state.playIntentActive);
  const castActive = useAppStore((state) => state.castActive);
  const externalPlaybackActive = useAppStore((state) => state.externalPlaybackActive);
  const captureHoldsConnection = useAppStore(
    (state) => state.sampleCaptureActive && isSingleConnectionPlaylist(state.playlist),
  );
  const anotherProbeRunning = useAppStore((state) =>
    Object.values(state.archiveProbes).some((probe) => probe.running),
  );
  const running = entry?.running ?? false;
  const playbackBlocksProbe = playIntentActive || castActive || isCasting || captureHoldsConnection;
  const disabled =
    archiveGuideTestRunning ||
    anotherProbeRunning ||
    isScanActive(scanState) ||
    playbackBlocksProbe;
  const outcomes = entry?.outcomes ?? [];
  const failure = archiveVerdict(result, entry) === "fake" ? archiveFailure(entry) : null;

  const runProbe = () => {
    const state = useAppStore.getState();
    if (
      isScanActive(state.scanState) ||
      state.archiveGuideTestRunning ||
      Object.values(state.archiveProbes).some((probe) => probe.running) ||
      state.playIntentActive ||
      state.castActive ||
      isCasting ||
      (state.sampleCaptureActive && isSingleConnectionPlaylist(state.playlist))
    ) {
      return;
    }
    if (
      state.externalPlaybackActive &&
      isSingleConnectionPlaylist(state.playlist) &&
      !window.confirm(t("archive.confirmCloseExternalPlayerTest"))
    ) {
      return;
    }
    state.setExternalPlaybackActive(false);
    const playlistAtStart = state.playlist;
    const generation = state.archiveProbeGeneration;
    void probeChannelArchive(
      result,
      (update) => {
        if (useAppStore.getState().playlist === playlistAtStart) {
          setArchiveProbe(generation, result.index, update);
        }
      },
      () => {
        const latest = useAppStore.getState();
        return (
          latest.playlist === playlistAtStart &&
          latest.archiveProbeGeneration === generation &&
          !isScanActive(latest.scanState) &&
          !latest.archiveGuideTestRunning &&
          !latest.playIntentActive &&
          !latest.castActive &&
          !latest.externalPlaybackActive
        );
      },
    );
  };

  return (
    <div className="mt-2 border-t border-violet-500/15 pt-2">
      <button
        type="button"
        disabled={disabled}
        title={
          isScanActive(scanState)
            ? t("archive.card.waitForScan")
            : playbackBlocksProbe
              ? t("archive.card.stopPlaybackFirst")
              : externalPlaybackActive && isSingleConnectionPlaylist(playlist)
                ? t("archive.card.confirmExternalPlayerClosed")
                : undefined
        }
        onClick={runProbe}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-btn px-3 py-1.5 text-[12px] font-medium text-text-primary border border-border-app shadow-sm hover:bg-btn-hover transition-colors disabled:opacity-40"
      >
        {running && <LoaderCircle className="h-3 w-3 animate-spin" />}
        {running ? t("archive.card.testing") : t("archive.card.test")}
      </button>
      {failure && (
        <p className="mt-2 text-[11px] leading-snug text-red-300">
          <span className="font-semibold">{t("archive.card.fake")}</span>{" "}
          {archiveFailureSentence(failure)}
        </p>
      )}
      {outcomes.map((outcome) => {
        const latency = outcome.latencyMs != null ? formatCount(outcome.latencyMs) : null;
        const error = outcome.error != null ? translateReason(outcome.error) : null;
        return (
          <div
            key={outcome.label}
            className="mt-1.5 flex items-center justify-between gap-2 text-[11px]"
          >
            <span className="text-text-secondary">{outcomePointLabel(outcome)}</span>
            {outcome.ok && outcome.depthVerified ? (
              <span className="flex items-center gap-1 font-medium text-green-400">
                <CircleCheck className="h-3 w-3" />
                {latency != null
                  ? t("archive.outcome.okWithLatency", { latency })
                  : t("archive.outcome.ok")}
              </span>
            ) : outcome.ok ? (
              <span className="flex items-center gap-1 font-medium text-amber-400">
                <CircleCheck className="h-3 w-3" />
                {outcome.depthUnknown
                  ? latency != null
                    ? t("archive.outcome.reachableWithLatency", { latency })
                    : t("archive.outcome.reachable")
                  : latency != null
                    ? t("archive.outcome.unverifiedWithLatency", { latency })
                    : t("archive.outcome.unverified")}
              </span>
            ) : (
              <span
                className="flex min-w-0 items-center gap-1 font-medium text-red-400"
                title={error ?? undefined}
              >
                <CircleX className="h-3 w-3 shrink-0" />
                <span className="truncate">{error ?? t("archive.outcome.failed")}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ArchivePicker({
  result,
  onPlayArchive,
}: Pick<ArchiveCardProps, "result" | "onPlayArchive">) {
  const depthDays = Math.min(MAX_CATCHUP_DAYS, Math.max(1, result.catchup_days ?? 1));
  const [daysBack, setDaysBack] = useState(() => archivePickerDefault().daysBack);
  const [time, setTime] = useState(() => archivePickerDefault().time);
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
          className="native-field h-7 flex-1 min-w-0 rounded-md border border-border-app bg-input ps-2 pe-6 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        {t("archive.card.watchFromHere")}
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
  const [expanded, setExpanded] = useDisclosure("archive-expanded");
  const [hasOpened, setHasOpened] = useState(expanded);
  const [programmes, setProgrammes] = useState<EpgProgramme[] | null>(null);
  const depthDays = Math.min(MAX_CATCHUP_DAYS, Math.max(1, result.catchup_days ?? 7));

  useEffect(() => {
    if (!hasOpened || !hasArchive(result)) {
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
  }, [depthDays, result, hasOpened]);

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
    <details
      open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setExpanded(next);
        if (next) setHasOpened(true);
      }}
      className="group/archive rounded bg-violet-500/10 border border-violet-500/20"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 p-2 text-[12px] font-medium text-violet-300 [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-blue-500">
        <span className="min-w-0" title={archiveTitle(result) ?? undefined}>
          {t("archive.card.heading")}
          <span className="ms-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-violet-300/80">
            {result.catchup ?? "default"}
            {result.catchup_days != null
              ? ` · ${t("archive.card.depthDays", { days: formatCount(result.catchup_days) })}`
              : ""}
          </span>
        </span>
        <ChevronRight className="ms-auto h-3.5 w-3.5 shrink-0 group-open/archive:rotate-90" />
      </summary>
      <div className="px-2 pb-2">
        {programmes === null ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
            <LoaderCircle className="h-3 w-3 animate-spin" />
            {t("archive.card.loadingGuide")}
          </div>
        ) : dayGroups.length > 0 ? (
          <section
            className="mt-1 max-h-80 overflow-y-auto pe-1"
            aria-label={t("archive.card.programmesLabel")}
          >
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
                      className={`flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-start text-[11px] transition-colors ${
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
          </section>
        ) : (
          <ArchivePicker result={result} onPlayArchive={onPlayArchive} />
        )}

        <ArchiveProbe result={result} isCasting={isCasting} />
      </div>
    </details>
  );
}
