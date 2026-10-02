import { memo, type ReactNode, startTransition, useDeferredValue, useMemo } from "react";
import { formatCount, getFormatLocale, t } from "../i18n";
import { hasArchive } from "../lib/archive";
import { archiveVerdict } from "../lib/archiveVerification";
import { computeCatchupScore, withCatchupScore } from "../lib/catchupScore";
import {
  filterDispatcharrPrimaries,
  getDispatcharrView,
  isUntestedStatus,
  matchesDispatcharrChannel,
} from "../lib/dispatcharr";
import { filterResultsShared, isCatchupStatusFilter } from "../lib/filters";
import type { Channel } from "../lib/types";
import { useAppStore } from "../store";
import {
  SFCheckmarkCircleFill,
  SFClockArrow,
  SFDocOnDocFill,
  SFExclamationTriangleFill,
  SFListNumber,
  SFLockFill,
  SFPhotoFill,
  SFShieldFill,
  SFTagFill,
  SFXmarkCircleFill,
} from "./SFSymbols";

function Pill({
  icon,
  label,
  color,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const colorMap: Record<string, { base: string; active: string }> = {
    neutral: {
      base: "text-text-secondary bg-btn/60",
      active: "text-text-primary bg-btn ring-1 ring-text-secondary",
    },
    green: {
      base: "text-green-400 bg-green-400/10",
      active: "text-green-300 bg-green-400/25 ring-1 ring-green-400/50",
    },
    red: {
      base: "text-red-400 bg-red-400/10",
      active: "text-red-300 bg-red-400/25 ring-1 ring-red-400/50",
    },
    yellow: {
      base: "text-yellow-400 bg-yellow-400/10",
      active: "text-yellow-300 bg-yellow-400/25 ring-1 ring-yellow-400/50",
    },
    cyan: {
      base: "text-cyan-400 bg-cyan-400/10",
      active: "text-cyan-300 bg-cyan-400/25 ring-1 ring-cyan-400/50",
    },
    blue: {
      base: "text-blue-400 bg-blue-400/10",
      active: "text-blue-300 bg-blue-400/25 ring-1 ring-blue-400/50",
    },
    orange: {
      base: "text-orange-400 bg-orange-400/10",
      active: "text-orange-300 bg-orange-400/25 ring-1 ring-orange-400/50",
    },
    violet: {
      base: "text-violet-400 bg-violet-400/10",
      active: "text-violet-300 bg-violet-400/25 ring-1 ring-violet-400/50",
    },
  };

  const colors = colorMap[color] ?? colorMap.neutral;
  const clickable = onClick != null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] tabular-nums select-none transition-colors ${
        active ? colors.active : colors.base
      } ${clickable ? "cursor-pointer hover:brightness-125" : "cursor-default"}`}
    >
      {icon}
      {label}
    </button>
  );
}

const iconSize = "w-3 h-3";
const noChannels: Channel[] = [];

export const StatsPanel = memo(function StatsPanel() {
  const progress = useAppStore((s) => s.progress);
  const summary = useAppStore((s) => s.summary);
  const playlist = useAppStore((s) => s.playlist);
  const results = useAppStore((s) => s.flatResults);
  const archiveProbes = useAppStore((s) => s.archiveProbes);
  const totalChannels = playlist?.total_channels ?? 0;
  const channels = playlist?.channels ?? noChannels;
  const scanState = useAppStore((s) => s.scanState);
  const lowFpsCount = useAppStore((s) => s.uiMetrics.lowFpsCount);
  const mislabeledCount = useAppStore((s) => s.uiMetrics.mislabeledCount);
  const duplicateCount = useAppStore((s) => s.duplicateIndices.size);
  const duplicateIndices = useAppStore((s) => s.duplicateIndices);
  const completedResults = useAppStore((s) => s.flatResults);
  const statusFilter = useAppStore((s) => s.statusFilter);
  const setStatusFilter = useAppStore((s) => s.setStatusFilter);
  const toggleReportPanel = useAppStore((s) => s.toggleReportPanel);
  const selectedChannelIndices = useAppStore((s) => s.selectedChannelIndices);
  const search = useDeferredValue(useAppStore((s) => s.search));
  const groupFilter = useAppStore((s) => s.groupFilter);
  const separatePlaceholder = useAppStore((s) => s.settings.separate_placeholder_status);
  const stats = summary ?? progress;
  const dispatcharrOrders = useAppStore((s) => s.dispatcharrOrders);
  const dispatcharrView = useMemo(
    () => getDispatcharrView(results, dispatcharrOrders),
    [results, dispatcharrOrders],
  );
  // Dispatcharr sources count channels rather than streams.
  const channelStats = useMemo(() => {
    const view = dispatcharrView;
    if (!view) return null;
    const tally = { alive: 0, primaryDead: 0, hasDead: 0, allDead: 0, checked: 0, streams: 0 };
    for (const channel of view.channels) {
      if (channel.primary.status === "alive") tally.alive += 1;
      if (channel.primaryDead) tally.primaryDead += 1;
      if (channel.hasDead) tally.hasDead += 1;
      if (channel.allDead) tally.allDead += 1;
      tally.streams += channel.streams.length;
      tally.checked += channel.streams.filter(
        (entry) => !isUntestedStatus(entry.result.status),
      ).length;
    }
    return { channels: view.channels.length, ...tally };
  }, [dispatcharrView]);
  const effectiveLowFpsCount = summary?.low_framerate ?? lowFpsCount;
  const effectiveMislabeledCount = summary?.mislabeled ?? mislabeledCount;
  const displayScore = useMemo(() => {
    if (!summary?.playlist_score) return null;
    return withCatchupScore(summary.playlist_score, computeCatchupScore(results, archiveProbes));
  }, [summary?.playlist_score, results, archiveProbes]);

  // Dispatcharr channels count once, matching the status filter's counts.
  const catchupChannels = useMemo(
    () =>
      dispatcharrView?.channels.filter((channel) =>
        matchesDispatcharrChannel(channel, "catchup", archiveProbes),
      ) ?? null,
    [dispatcharrView, archiveProbes],
  );
  const catchupCount = useMemo(
    () => catchupChannels?.length ?? channels.filter(hasArchive).length,
    [catchupChannels, channels],
  );
  const visibleCatchupCount = useMemo(() => {
    if (dispatcharrView) {
      return filterDispatcharrPrimaries(
        dispatcharrView,
        search,
        groupFilter,
        statusFilter,
        duplicateIndices,
        separatePlaceholder,
        archiveProbes,
      ).filter((primary) => {
        const channel = dispatcharrView.byPrimaryIndex.get(primary.index);
        return channel != null && matchesDispatcharrChannel(channel, "catchup", archiveProbes);
      }).length;
    }
    return filterResultsShared(
      completedResults,
      search,
      groupFilter,
      statusFilter,
      duplicateIndices,
      separatePlaceholder,
      archiveProbes,
    ).filter(hasArchive).length;
  }, [
    dispatcharrView,
    completedResults,
    search,
    groupFilter,
    statusFilter,
    duplicateIndices,
    separatePlaceholder,
    archiveProbes,
  ]);
  const verdictTally = useMemo(() => {
    if (catchupChannels) {
      const count = (filter: string) =>
        catchupChannels.filter((channel) =>
          matchesDispatcharrChannel(channel, filter, archiveProbes),
        ).length;
      const real = count("catchup_real");
      const shallower = count("catchup_shallower");
      const fake = count("catchup_fake");
      const untested = count("catchup_untested");
      return { real, shallower, fake, untested, tested: real + shallower + fake };
    }
    let real = 0;
    let shallower = 0;
    let fake = 0;
    let untested = 0;
    for (const channel of channels) {
      if (!hasArchive(channel)) continue;
      const verdict = archiveVerdict(channel, archiveProbes[channel.index]);
      if (verdict === "verified") real += 1;
      else if (verdict === "shallower") shallower += 1;
      else if (verdict === "fake") fake += 1;
      else untested += 1;
    }
    return { real, shallower, fake, untested, tested: real + shallower + fake };
  }, [catchupChannels, channels, archiveProbes]);

  const selectedCatchupCount = useMemo(() => {
    if (selectedChannelIndices.length < 2) return 0;
    const selected = new Set(selectedChannelIndices);
    let count = 0;
    for (const channel of channels) {
      if (selected.has(channel.index) && hasArchive(channel)) count += 1;
    }
    return count;
  }, [channels, selectedChannelIndices]);
  const catchupLabel =
    verdictTally.tested > 0
      ? [
          t("stats.catchup.real", { count: verdictTally.real }),
          verdictTally.shallower > 0 &&
            t("stats.catchup.shallower", { count: verdictTally.shallower }),
          t("stats.catchup.fake", { count: verdictTally.fake }),
          verdictTally.untested > 0 &&
            t("stats.catchup.untested", { count: verdictTally.untested }),
        ]
          .filter(Boolean)
          .join(" · ")
      : visibleCatchupCount === catchupCount
        ? t("stats.catchup.all", { count: catchupCount })
        : t("stats.catchup.visible", {
            visible: formatCount(visibleCatchupCount),
            count: catchupCount,
          });
  // Before verification the pill toggles the catch-up filter; after it, clicks
  // cycle through the real and fake verdicts.
  const cycleCatchupFilter = () => {
    if (verdictTally.tested === 0) {
      toggleFilter("catchup");
      return;
    }
    const cycle = ["catchup_real", "catchup_shallower", "catchup_fake"].filter(
      (filter) => filter !== "catchup_shallower" || verdictTally.shallower > 0,
    );
    const position = cycle.indexOf(statusFilter);
    const next = position === -1 ? cycle[0] : (cycle[position + 1] ?? "all");
    startTransition(() => setStatusFilter(next));
  };

  const showSelectionInfo = selectedChannelIndices.length > 1 && catchupCount > 0;
  const showRightStatus =
    scanState === "cancelling" ||
    scanState === "paused" ||
    effectiveLowFpsCount > 0 ||
    effectiveMislabeledCount > 0 ||
    duplicateCount > 0 ||
    showSelectionInfo;

  function handleStatusChange(value: string) {
    startTransition(() => setStatusFilter(value));
  }

  function toggleFilter(value: string) {
    handleStatusChange(statusFilter === value ? "all" : value);
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border-app bg-panel-subtle glass-material select-none">
      <Pill
        icon={<SFListNumber className={iconSize} />}
        label={
          channelStats
            ? t("stats.channels", { count: channelStats.channels })
            : t("stats.total", { count: totalChannels })
        }
        color="neutral"
        active={statusFilter === "all"}
        onClick={() => handleStatusChange("all")}
      />
      {channelStats && stats && (
        <>
          <Pill
            icon={<SFCheckmarkCircleFill className={iconSize} />}
            label={formatCount(channelStats.alive)}
            color="green"
            active={statusFilter === "alive"}
            onClick={() => toggleFilter("alive")}
          />
          {channelStats.primaryDead > 0 && (
            <Pill
              icon={<SFXmarkCircleFill className={iconSize} />}
              label={t("stats.primaryDead", { count: channelStats.primaryDead })}
              color="red"
              active={statusFilter === "primary_dead"}
              onClick={() => toggleFilter("primary_dead")}
            />
          )}
          {channelStats.hasDead > 0 && (
            <Pill
              icon={<SFExclamationTriangleFill className={iconSize} />}
              label={t("stats.withDeadStreams", { count: channelStats.hasDead })}
              color="orange"
              active={statusFilter === "has_dead"}
              onClick={() => toggleFilter("has_dead")}
            />
          )}
          {channelStats.allDead > 0 && (
            <Pill
              icon={<SFXmarkCircleFill className={iconSize} />}
              label={t("stats.allDead", { count: channelStats.allDead })}
              color="red"
              active={statusFilter === "all_dead"}
              onClick={() => toggleFilter("all_dead")}
            />
          )}
        </>
      )}
      {!channelStats && stats && (
        <>
          <Pill
            icon={<SFCheckmarkCircleFill className={iconSize} />}
            label={formatCount(stats.alive)}
            color="green"
            active={statusFilter === "alive"}
            onClick={() => toggleFilter("alive")}
          />
          {stats.drm > 0 && (
            <Pill
              icon={<SFShieldFill className={iconSize} />}
              label={formatCount(stats.drm)}
              color="cyan"
              active={statusFilter === "drm"}
              onClick={() => toggleFilter("drm")}
            />
          )}
          <Pill
            icon={<SFXmarkCircleFill className={iconSize} />}
            label={formatCount(stats.dead)}
            color="red"
            active={statusFilter === "dead"}
            onClick={() => toggleFilter("dead")}
          />
          <Pill
            icon={<SFLockFill className={iconSize} />}
            label={formatCount(stats.geoblocked)}
            color="yellow"
            active={statusFilter === "geoblocked"}
            onClick={() => toggleFilter("geoblocked")}
          />
          {stats.placeholder > 0 && (
            <Pill
              icon={<SFPhotoFill className={iconSize} />}
              label={formatCount(stats.placeholder)}
              color="orange"
              active={statusFilter === "placeholder"}
              onClick={() => toggleFilter("placeholder")}
            />
          )}
        </>
      )}
      {catchupCount > 0 && (
        <Pill
          icon={<SFClockArrow className={`${iconSize} rtl:-scale-x-100`} />}
          label={catchupLabel}
          color="violet"
          active={isCatchupStatusFilter(statusFilter)}
          onClick={cycleCatchupFilter}
        />
      )}
      {displayScore && (
        <Pill
          icon={null}
          label={t("stats.score", {
            score: displayScore.overall.toLocaleString(getFormatLocale(), {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }),
          })}
          color="blue"
          onClick={toggleReportPanel}
        />
      )}
      {channelStats && stats && (
        <span className="text-[12px] text-text-tertiary tabular-nums">
          {t("stats.streamsChecked", {
            checked: formatCount(channelStats.checked),
            count: channelStats.streams,
          })}
        </span>
      )}
      {showRightStatus && (
        <div className="ms-auto flex items-center gap-2">
          {showSelectionInfo && (
            <span className="text-[12px] text-text-tertiary tabular-nums">
              {t("stats.selected", { count: selectedChannelIndices.length })} ·{" "}
              <span className="text-violet-400">
                {t("stats.withCatchup", { count: selectedCatchupCount })}
              </span>
            </span>
          )}
          {scanState === "paused" && (
            <span className="text-[12px] text-yellow-400 font-medium uppercase tracking-[0.04em]">
              {t("stats.paused")}
            </span>
          )}
          {scanState === "cancelling" && (
            <span className="text-[12px] text-orange-400 font-medium uppercase tracking-[0.04em]">
              {t("stats.stopping")}
            </span>
          )}
          {effectiveLowFpsCount > 0 && (
            <Pill
              icon={<SFExclamationTriangleFill className={iconSize} />}
              label={t("stats.lowFps", { count: effectiveLowFpsCount })}
              color="orange"
            />
          )}
          {effectiveMislabeledCount > 0 && (
            <Pill
              icon={<SFTagFill className={iconSize} />}
              label={t("stats.mislabeled", { count: effectiveMislabeledCount })}
              color="orange"
              active={statusFilter === "mislabeled"}
              onClick={() => toggleFilter("mislabeled")}
            />
          )}
          {duplicateCount > 0 && (
            <Pill
              icon={<SFDocOnDocFill className={iconSize} />}
              label={t("stats.duplicates", { count: duplicateCount })}
              color="orange"
              active={statusFilter === "duplicates"}
              onClick={() => toggleFilter("duplicates")}
            />
          )}
        </div>
      )}
    </div>
  );
});
