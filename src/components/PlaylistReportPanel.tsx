import { save } from "@tauri-apps/plugin-dialog";
import { BarChart3, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { formatCount, getFormatLocale, t } from "../i18n";
import { hasArchive } from "../lib/archive";
import { realCatchupResults, stripFakeCatchupResults } from "../lib/archiveExport";
import {
  type ArchiveFailure,
  archiveFailure,
  archiveVerdict,
  measuredDepthDays,
} from "../lib/archiveVerification";
import { cancelArchiveVerification, verifyAllArchives } from "../lib/archiveVerifyRun";
import { computeCatchupScore, withCatchupScore } from "../lib/catchupScore";
import { summarizeEpgCoverage } from "../lib/epgCoverage";
import { summarizeLanguageDistribution } from "../lib/languageDistribution";
import { logger } from "../lib/logger";
import { isSingleConnectionPlaylist } from "../lib/playback";
import {
  hasScanStarted,
  shouldShowContentCounts,
  shouldShowLanguageDistribution,
} from "../lib/playlistReportVisibility";
import { isScanActive } from "../lib/scanState";
import { exportM3u } from "../lib/tauri";
import type { ChannelResult, PlaylistScore } from "../lib/types";
import { useAppStore } from "../store";
import { PlaybackReportSummary } from "./PlaybackDiagnostics";

interface PlaylistReportPanelProps {
  placement?: "left" | "right";
  widthPx?: number;
  onResizeStart?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClose: () => void;
}

interface QualityBuckets {
  uhd4k: number;
  hd1080: number;
  hd720: number;
  sd: number;
}

/** Verified catch-up depth buckets, in days. */
const DEPTH_BUCKETS = [
  ["underOneDay", (days: number) => days < 1],
  ["oneToTwoDays", (days: number) => days >= 1 && days < 3],
  ["threeToSixDays", (days: number) => days >= 3 && days < 7],
  ["sevenDays", (days: number) => days >= 7 && days < 8],
  ["eightPlusDays", (days: number) => days >= 8],
] as const;

const CHART_COLORS = ["#38bdf8", "#22d3ee", "#4ade80", "#f59e0b", "#fb7185", "#a78bfa"];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampScore10(value: number): number {
  return Math.max(0, Math.min(10, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatDecimal(value: number, digits = 1): string {
  return value.toLocaleString(getFormatLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** `value` is 0-100, as computed by the summaries. */
function formatPercent(value: number, digits = 1): string {
  return (value / 100).toLocaleString(getFormatLocale(), {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatMs(value: number | null): string {
  return value == null
    ? t("report.notAvailable")
    : t("report.milliseconds", { ms: formatCount(Math.round(value)) });
}

function formatVerifiedAt(epochS: number): string {
  const date = new Date(epochS * 1000);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(getFormatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return sameDay
    ? t("report.catchup.verifiedToday", { time })
    : t("report.catchup.verifiedOn", {
        date: date.toLocaleDateString(getFormatLocale(), { day: "numeric", month: "short" }),
        time,
      });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isAliveResult(result: ChannelResult): boolean {
  return result.status === "alive";
}

function isHdOrUhd(result: ChannelResult): boolean {
  if (typeof result.width === "number" && typeof result.height === "number") {
    if (result.width >= 1280 && result.height >= 720) return true;
  }
  const resolution = result.resolution?.toLowerCase() ?? "";
  return (
    resolution.includes("720") ||
    resolution.includes("1080") ||
    resolution.includes("1440") ||
    resolution.includes("2160") ||
    resolution.includes("4k") ||
    resolution.includes("uhd")
  );
}

function qualityBucket(result: ChannelResult): keyof QualityBuckets {
  if (typeof result.width === "number" && typeof result.height === "number") {
    if (result.width >= 3840 || result.height >= 2160) return "uhd4k";
    if (result.width >= 1920 || result.height >= 1080) return "hd1080";
    if (result.width >= 1280 || result.height >= 720) return "hd720";
    return "sd";
  }

  const resolution = result.resolution?.toLowerCase() ?? "";
  if (resolution.includes("2160") || resolution.includes("4k") || resolution.includes("uhd"))
    return "uhd4k";
  if (resolution.includes("1080")) return "hd1080";
  if (resolution.includes("720")) return "hd720";
  return "sd";
}

function codecTier(codec: string | null): number {
  const value = codec?.toLowerCase() ?? "";
  if (!value) return 0.4;
  if (
    value.includes("hevc") ||
    value.includes("h265") ||
    value.includes("h.265") ||
    value.includes("av1")
  ) {
    return 1;
  }
  if (value.includes("h264") || value.includes("h.264") || value.includes("avc")) {
    return 0.8;
  }
  if (value.includes("mpeg") || value.includes("vp9")) {
    return 0.6;
  }
  return 0.5;
}

function computeLiveScore(results: ChannelResult[], total: number): PlaylistScore | null {
  if (total <= 0) return null;

  const alive = results.filter(isAliveResult);
  const latencies = alive
    .map((result) => result.latency_ms)
    .filter((value): value is number => typeof value === "number");
  const p50 = median(latencies);
  const pingScore = clampScore10(p50 == null ? 0 : ((1200 - p50) / 1100) * 10);

  const aliveRatio = alive.length / total;
  const uniqueGroups = new Set(
    results.map((result) => result.group.trim().toLowerCase()).filter(Boolean),
  ).size;
  const diversity = clamp01(uniqueGroups / 20);
  const epgCoverage =
    results.filter((result) => (result.tvg_id ?? "").trim().length > 0).length / total;
  const contentScore = clampScore10((aliveRatio * 0.6 + diversity * 0.2 + epgCoverage * 0.2) * 10);

  let qualityScore = 0;
  if (alive.length > 0) {
    const hdRatio = alive.filter((result) => isHdOrUhd(result)).length / alive.length;
    const codecAvg = alive.reduce((sum, result) => sum + codecTier(result.codec), 0) / alive.length;
    const fpsKnown = alive.filter((result) => typeof result.fps === "number").length;
    const fpsRatio =
      fpsKnown === 0 ? 0 : alive.filter((result) => (result.fps ?? 0) >= 25).length / fpsKnown;
    qualityScore = clampScore10((hdRatio * 0.5 + codecAvg * 0.3 + fpsRatio * 0.2) * 10);
  }

  const overall = clampScore10(pingScore * 0.25 + contentScore * 0.4 + qualityScore * 0.35);
  return {
    overall: round1(overall),
    ping: round1(pingScore),
    content: round1(contentScore),
    quality: round1(qualityScore),
  };
}

function formatEpoch(epoch: number | null | undefined): string {
  if (!epoch) return t("report.notAvailable");
  const date = new Date(epoch * 1000);
  if (Number.isNaN(date.getTime())) return t("report.notAvailable");
  return date.toLocaleDateString(getFormatLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export const PlaylistReportPanel = memo(function PlaylistReportPanel({
  placement = "left",
  widthPx = 330,
  onResizeStart,
  onClose,
}: PlaylistReportPanelProps) {
  const playlist = useAppStore((s) => s.playlist);
  const results = useAppStore((s) => s.flatResults);
  const progress = useAppStore((s) => s.progress);
  const epgLoadSummary = useAppStore((s) => s.epgLoadSummary);
  const archiveProbes = useAppStore((s) => s.archiveProbes);
  const archiveVerifyRun = useAppStore((s) => s.archiveVerifyRun);
  const archiveGuideTestRunning = useAppStore((s) => s.archiveGuideTestRunning);
  const playIntentActive = useAppStore((s) => s.playIntentActive);
  const castActive = useAppStore((s) => s.castActive);
  const archiveProbeRunning = Object.values(archiveProbes).some((entry) => entry.running);
  const playbackBlocksVerification =
    (playIntentActive || castActive) && isSingleConnectionPlaylist(playlist);
  const summary = useAppStore((s) => s.summary);
  const scanState = useAppStore((s) => s.scanState);
  // Every hook below must run unconditionally: the "no playlist" early return
  // lives after them, because bailing out first would change the hook count
  // between renders as soon as a playlist loads.
  const channels = playlist?.channels;

  const latencyStats = useMemo(() => {
    const aliveLatencies = results
      .filter(isAliveResult)
      .map((result) => result.latency_ms)
      .filter((value): value is number => typeof value === "number");
    if (aliveLatencies.length === 0) {
      return { average: null as number | null, p50: null as number | null };
    }
    const average = aliveLatencies.reduce((sum, value) => sum + value, 0) / aliveLatencies.length;
    return { average, p50: median(aliveLatencies) };
  }, [results]);

  const languageSummary = useMemo(
    () =>
      summarizeLanguageDistribution(
        (channels ?? []).map((channel) => ({ language: channel.language })),
        5,
      ),
    [channels],
  );

  const epgSummary = useMemo(
    () => summarizeEpgCoverage((channels ?? []).map((channel) => ({ tvg_id: channel.tvg_id }))),
    [channels],
  );

  const catchupScore = useMemo(
    () => computeCatchupScore(results, archiveProbes),
    [results, archiveProbes],
  );

  const catchupStats = useMemo(() => {
    const channels = results.filter(hasArchive);
    if (channels.length === 0) return null;
    let verified = 0;
    let shallower = 0;
    let fake = 0;
    let verifiedAt: number | null = null;
    const failures: Record<ArchiveFailure["kind"], number> = {
      empty: 0,
      live: 0,
      http: 0,
      timeout: 0,
      unreachable: 0,
    };
    const depths: number[] = [];
    const latencies: number[] = [];
    for (const channel of channels) {
      const entry = archiveProbes[channel.index];
      const verdict = archiveVerdict(channel, entry);
      if (verdict !== "advertised" && entry?.checkedAt != null) {
        verifiedAt = Math.max(verifiedAt ?? 0, entry.checkedAt);
      }
      if (verdict === "verified") {
        verified += 1;
        depths.push(Math.min(channel.catchup_days ?? measuredDepthDays(entry) ?? 1, 14));
      } else if (verdict === "shallower") {
        shallower += 1;
        const measured = measuredDepthDays(entry);
        if (measured != null) depths.push(Math.min(measured, 14));
      } else if (verdict === "fake") {
        fake += 1;
        const failure = archiveFailure(entry);
        if (failure) failures[failure.kind] += 1;
      }
      for (const outcome of entry?.outcomes ?? []) {
        if (outcome.ok && outcome.latencyMs != null) latencies.push(outcome.latencyMs);
      }
    }
    const buckets = DEPTH_BUCKETS.map(([id, inBucket]) => ({
      id,
      count: depths.filter(inBucket).length,
    }));
    const fakeReasons = (Object.keys(failures) as Array<ArchiveFailure["kind"]>)
      .map((kind) => ({ kind, count: failures[kind] }))
      .filter((reason) => reason.count > 0);
    const medianLatency = median(latencies);
    return {
      advertised: channels.length,
      verified,
      shallower,
      fake,
      tested: verified + shallower + fake,
      verifiedAt,
      fakeReasons,
      buckets,
      medianLatency,
    };
  }, [results, archiveProbes]);

  const [catchupExportBusy, setCatchupExportBusy] = useState(false);
  const exportCatchupPlaylist = async (variant: "real" | "stripped") => {
    if (!playlist || catchupExportBusy) return;
    const exported =
      variant === "real"
        ? realCatchupResults(results, archiveProbes)
        : stripFakeCatchupResults(results, archiveProbes);
    if (exported.length === 0) return;
    const stem = playlist.file_name.replace(/\.[^.]+$/, "") || "playlist";
    const path = await save({
      defaultPath: `${stem}_${variant === "real" ? "real-catchup" : "no-fake-catchup"}.m3u8`,
      filters: [{ name: t("report.catchup.m3uFilterName"), extensions: ["m3u8", "m3u"] }],
    });
    if (!path) return;
    setCatchupExportBusy(true);
    try {
      await exportM3u(exported, path);
      logger.info(`[Export] Wrote ${exported.length} channels (${variant} catch-up) to ${path}`);
    } catch (error) {
      logger.warn(`[Export] Catch-up export failed: ${String(error)}`);
    } finally {
      setCatchupExportBusy(false);
    }
  };

  const protocolSummary = useMemo(() => {
    let http = 0;
    let https = 0;
    for (const channel of channels ?? []) {
      const lower = channel.url.trim().toLowerCase();
      if (lower.startsWith("https://")) {
        https += 1;
      } else if (lower.startsWith("http://")) {
        http += 1;
      }
    }
    const total = http + https;
    const httpsPct = total > 0 ? (https / total) * 100 : 0;
    return { http, https, total, httpsPct };
  }, [channels]);

  const quality = useMemo(() => {
    const alive = results.filter(isAliveResult);
    const buckets: QualityBuckets = { uhd4k: 0, hd1080: 0, hd720: 0, sd: 0 };
    const codecs = new Map<string, number>();

    for (const result of alive) {
      buckets[qualityBucket(result)] += 1;
      // "" groups channels without a codec; labelled at render.
      const codec = result.codec?.trim() ?? "";
      codecs.set(codec, (codecs.get(codec) ?? 0) + 1);
    }

    return {
      aliveCount: alive.length,
      buckets,
      codecEntries: Array.from(codecs.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [results]);

  const computedScore = useMemo(
    () => computeLiveScore(results, playlist?.total_channels ?? 0),
    [results, playlist?.total_channels],
  );

  if (!playlist) {
    return null;
  }

  const statusSnapshot = summary ?? progress;
  const showHealthScore = hasScanStarted(scanState);
  const showContentCounts = shouldShowContentCounts(playlist.movie_count, playlist.series_count);
  const showLanguageDistribution = shouldShowLanguageDistribution(
    playlist.channels.map((channel) => ({ language: channel.language })),
  );
  const baseScore = summary?.playlist_score ?? computedScore;
  const displayScore = baseScore ? withCatchupScore(baseScore, catchupScore) : null;
  const ringScore = displayScore?.overall ?? 0;
  const ringPercent = clamp01(ringScore / 10);
  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;

  const aliveOrDrm = (statusSnapshot?.alive ?? 0) + (statusSnapshot?.drm ?? 0);
  const statusLabel = aliveOrDrm > 0 ? t("report.status.active") : t("report.status.inactive");
  const statusClass = aliveOrDrm > 0 ? "text-emerald-300" : "text-red-300";

  return (
    <aside
      className={`relative h-full shrink-0 ${
        placement === "right"
          ? "border-s report-panel-enter-right"
          : "border-e report-panel-enter-left"
      } border-border-app bg-panel/70 backdrop-blur-sm overflow-auto select-none`}
      style={{ width: `${widthPx}px` }}
    >
      {onResizeStart && (
        <div
          onMouseDown={onResizeStart}
          className={`absolute top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors ${
            placement === "right"
              ? "start-0 -translate-x-1/2 rtl:translate-x-1/2"
              : "end-0 translate-x-1/2 rtl:-translate-x-1/2"
          }`}
        />
      )}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-border-app bg-panel/85 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
              {t("report.title")}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <BarChart3 className="w-4 h-4 text-blue-300" />
              <p
                dir="ltr"
                className="text-[14px] font-semibold text-text-primary truncate"
                title={playlist.file_name}
              >
                {playlist.file_name}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-btn-hover text-text-tertiary hover:text-text-primary transition-colors"
            type="button"
            title={t("report.hide")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className={`font-medium ${statusClass}`}>{statusLabel}</span>
          {playlist.server_location && (
            <>
              <span className="text-text-tertiary">•</span>
              <span className="text-text-secondary truncate" title={playlist.server_location}>
                {playlist.server_location}
              </span>
            </>
          )}
          <span className="text-text-tertiary">•</span>
          <span className="text-text-secondary">
            {latencyStats.average == null
              ? t("report.pingNotAvailable")
              : t("report.averagePing", { ms: formatCount(Math.round(latencyStats.average)) })}
          </span>
        </div>
      </div>

      <div className="p-4 space-y-5">
        <PlaybackReportSummary />
        {showHealthScore && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
              {t("report.health.title")}
            </p>
            <div className="flex items-center gap-3">
              <div className="relative w-24 h-24 shrink-0">
                {/* Starts at 12 o'clock and fills toward the inline end. */}
                <svg
                  viewBox="0 0 100 100"
                  className="w-full h-full -rotate-90 rtl:rotate-90 rtl:-scale-x-100"
                >
                  <circle
                    cx="50"
                    cy="50"
                    r={ringRadius}
                    stroke="rgba(148,163,184,0.22)"
                    strokeWidth="9"
                    fill="none"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r={ringRadius}
                    stroke="#38bdf8"
                    strokeWidth="9"
                    strokeLinecap="round"
                    strokeDasharray={`${ringCircumference} ${ringCircumference}`}
                    strokeDashoffset={ringCircumference * (1 - ringPercent)}
                    style={{ transition: "stroke-dashoffset 240ms ease" }}
                    fill="none"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-[18px] font-semibold text-text-primary">
                  {formatDecimal(ringScore)}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-1 text-[12px] flex-1">
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">{t("report.health.ping")}</span>
                  <span className="text-text-primary">
                    {formatDecimal(displayScore?.ping ?? 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">{t("report.health.content")}</span>
                  <span className="text-text-primary">
                    {formatDecimal(displayScore?.content ?? 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">{t("report.health.quality")}</span>
                  <span className="text-text-primary">
                    {formatDecimal(displayScore?.quality ?? 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1 ring-1 ring-violet-500/25">
                  <span className="text-violet-400">{t("report.health.catchup")}</span>
                  <span className={catchupScore != null ? "text-violet-300" : "text-text-tertiary"}>
                    {catchupScore != null ? formatDecimal(catchupScore) : t("report.notAvailable")}
                  </span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-text-tertiary">
              {scanState === "complete"
                ? t("report.health.finalScore")
                : t("report.health.liveEstimate")}
            </p>
          </section>
        )}

        {showContentCounts && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
              {t("report.contentCounts.title")}
            </p>
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">{t("report.contentCounts.live")}</p>
                <p className="text-text-primary font-medium">{formatCount(playlist.live_count)}</p>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">{t("report.contentCounts.movies")}</p>
                <p className="text-text-primary font-medium">{formatCount(playlist.movie_count)}</p>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">{t("report.contentCounts.series")}</p>
                <p className="text-text-primary font-medium">
                  {formatCount(playlist.series_count)}
                </p>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">{t("report.contentCounts.total")}</p>
                <p className="text-text-primary font-medium">
                  {formatCount(playlist.total_channels)}
                </p>
              </div>
            </div>
          </section>
        )}

        {showLanguageDistribution && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
              {t("report.languages.title")}
            </p>
            {languageSummary.entries.length === 0 ? (
              <p className="text-[12px] text-text-tertiary">{t("report.languages.empty")}</p>
            ) : (
              <div className="space-y-1.5">
                {languageSummary.entries.map((entry, index) => (
                  <div key={entry.language}>
                    <div className="flex items-center justify-between text-[11px] mb-0.5">
                      <span dir="auto" className="text-text-secondary">
                        {entry.language}
                      </span>
                      <span className="text-text-tertiary">{formatPercent(entry.percentage)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-input overflow-hidden">
                      <div
                        className="h-full"
                        style={{
                          width: `${entry.percentage}%`,
                          backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                ))}
                {languageSummary.otherCount > 0 && (
                  <p className="text-[11px] text-text-tertiary">
                    {t("report.languages.otherShare", {
                      percent: formatPercent(languageSummary.otherPercentage),
                    })}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            {t("report.videoQuality.title")}
          </p>
          <div className="flex h-3 rounded-full overflow-hidden bg-input">
            {(
              [
                ["uhd4k", "#0ea5e9"],
                ["hd1080", "#22c55e"],
                ["hd720", "#f59e0b"],
                ["sd", "#f87171"],
              ] as const
            ).map(([key, color]) => {
              const total = Math.max(1, quality.aliveCount);
              const value = quality.buckets[key];
              const width = (value / total) * 100;
              return <div key={key} style={{ width: `${width}%`, backgroundColor: color }} />;
            })}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            {(
              [
                ["uhd4k", "4K"],
                ["hd1080", "1080p"],
                ["hd720", "720p"],
                ["sd", "SD"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="rounded-md bg-input/60 px-2 py-1">
                {t("report.videoQuality.bucket", {
                  label,
                  count: formatCount(quality.buckets[key]),
                })}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            {t("report.epg.title")}
          </p>
          <div className="flex items-center gap-3">
            <div className="w-20 h-20 rounded-full relative">
              <div
                className="absolute inset-0 rounded-full rtl:-scale-x-100"
                style={{
                  background: `conic-gradient(#10b981 ${(epgSummary.coveragePercent).toFixed(2)}%, rgba(148,163,184,0.2) 0)`,
                }}
              />
              <div className="absolute inset-[14px] rounded-full bg-panel flex items-center justify-center text-[11px] text-text-primary">
                {formatPercent(epgSummary.coveragePercent, 0)}
              </div>
            </div>
            <div className="text-[12px] space-y-1">
              <p className="text-text-secondary">
                {t("report.epg.channelsWithEpg", {
                  covered: formatCount(epgSummary.channelsWithEpg),
                  count: epgSummary.totalChannels,
                })}
              </p>
              <p className="text-text-secondary">
                {t("report.epg.uniqueIds", { count: formatCount(epgSummary.uniqueEpgSources) })}
              </p>
              {epgLoadSummary && (
                <p className="text-text-secondary">
                  {t("report.epg.programmeData", {
                    channels: formatCount(epgLoadSummary.channels_matched),
                    programmes: formatCount(epgLoadSummary.programme_count),
                  })}
                </p>
              )}
            </div>
          </div>
        </section>

        {catchupStats && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
                {t("report.catchup.title")}
                {catchupStats.verifiedAt != null && (
                  <span className="normal-case tracking-normal text-text-tertiary/80">
                    {" "}
                    ·{" "}
                    {t("report.catchup.verifiedAt", {
                      when: formatVerifiedAt(catchupStats.verifiedAt),
                    })}
                  </span>
                )}
              </p>
              {archiveVerifyRun ? (
                <button
                  type="button"
                  onClick={cancelArchiveVerification}
                  className="rounded-md border border-border-app bg-btn px-2 py-0.5 text-[11px] text-text-primary hover:bg-btn-hover transition-colors"
                >
                  {t("report.catchup.cancelProgress", {
                    done: formatCount(archiveVerifyRun.done),
                    total: formatCount(archiveVerifyRun.total),
                  })}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void verifyAllArchives()}
                  disabled={
                    playbackBlocksVerification ||
                    isScanActive(scanState) ||
                    archiveGuideTestRunning ||
                    archiveProbeRunning
                  }
                  title={
                    playbackBlocksVerification
                      ? t("report.catchup.stopPlaybackFirst")
                      : isScanActive(scanState)
                        ? t("report.catchup.waitForScan")
                        : archiveGuideTestRunning || archiveProbeRunning
                          ? t("report.catchup.otherVerificationRunning")
                          : undefined
                  }
                  className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/20 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  {t("report.catchup.verifyAll", {
                    count: formatCount(catchupStats.advertised),
                  })}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-green-400 tabular-nums">
                  {formatCount(catchupStats.verified)}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  {t("report.catchup.real")}
                </span>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-red-400 tabular-nums">
                  {formatCount(catchupStats.fake)}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  {t("report.catchup.fake")}
                </span>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-amber-400 tabular-nums">
                  {formatCount(catchupStats.shallower)}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  {t("report.catchup.shallower")}
                </span>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-violet-300 tabular-nums">
                  {formatCount(catchupStats.advertised)}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  {t("report.catchup.advertised")}
                </span>
              </div>
            </div>
            {catchupStats.fakeReasons.length > 0 && (
              <>
                <p className="mt-3 mb-1 text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
                  {t("report.catchup.whyFake")}
                </p>
                {catchupStats.fakeReasons.map((reason) => (
                  <div key={reason.kind} className="mb-1 flex items-center gap-2 text-[10px]">
                    <span className="w-14 shrink-0 text-end text-text-secondary">
                      {t(`report.catchup.fakeReasons.${reason.kind}`)}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-btn/40">
                      <div
                        className="h-full rounded-full bg-red-500"
                        style={{ width: `${(reason.count / catchupStats.fake) * 100}%` }}
                      />
                    </div>
                    <span className="w-7 shrink-0 text-text-tertiary tabular-nums">
                      {formatCount(reason.count)}
                    </span>
                  </div>
                ))}
              </>
            )}
            {catchupStats.tested > 0 && (
              <>
                <p className="mt-3 mb-1 text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
                  {t("report.catchup.verifiedDepth")}
                </p>
                {catchupStats.buckets.map((bucket) => {
                  const maxCount = Math.max(1, ...catchupStats.buckets.map((b) => b.count));
                  return (
                    <div key={bucket.id} className="mb-1 flex items-center gap-2 text-[10px]">
                      <span className="w-8 shrink-0 text-end text-text-secondary tabular-nums">
                        {t(`report.catchup.depthBuckets.${bucket.id}`)}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-btn/40">
                        <div
                          className="h-full rounded-full bg-violet-500"
                          style={{ width: `${(bucket.count / maxCount) * 100}%` }}
                        />
                      </div>
                      <span className="w-7 shrink-0 text-text-tertiary tabular-nums">
                        {formatCount(bucket.count)}
                      </span>
                    </div>
                  );
                })}
                <div className="mt-2 space-y-1 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-text-tertiary">
                      {t("report.catchup.medianArchiveStart")}
                    </span>
                    <span className="text-text-primary tabular-nums">
                      {formatMs(catchupStats.medianLatency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-tertiary">
                      {t("report.catchup.averageLiveStart")}
                    </span>
                    <span className="text-text-primary tabular-nums">
                      {formatMs(latencyStats.average)}
                    </span>
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  <button
                    type="button"
                    disabled={
                      catchupExportBusy || catchupStats.verified + catchupStats.shallower === 0
                    }
                    onClick={() => void exportCatchupPlaylist("real")}
                    title={t("report.catchup.exportRealTitle")}
                    className="w-full rounded-md border border-border-app bg-btn px-2 py-1.5 text-[11.5px] font-medium text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {t("report.catchup.exportReal", {
                      count: formatCount(catchupStats.verified + catchupStats.shallower),
                    })}
                  </button>
                  <button
                    type="button"
                    disabled={catchupExportBusy || catchupStats.fake === 0}
                    onClick={() => void exportCatchupPlaylist("stripped")}
                    title={t("report.catchup.exportStrippedTitle")}
                    className="w-full rounded-md border border-border-app bg-btn px-2 py-1.5 text-[11.5px] font-medium text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {t("report.catchup.exportStripped")}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            {t("report.technical.title")}
          </p>
          <div className="space-y-1 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">{t("report.technical.quality")}</span>
              <span className="text-text-primary">
                {quality.aliveCount === 0
                  ? t("report.notAvailable")
                  : formatPercent(
                      ((quality.buckets.uhd4k + quality.buckets.hd1080 + quality.buckets.hd720) /
                        quality.aliveCount) *
                        100,
                    )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">{t("report.technical.protocol")}</span>
              <span className="text-text-primary">
                {t("report.technical.protocolCounts", {
                  https: formatCount(protocolSummary.https),
                  http: formatCount(protocolSummary.http),
                })}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">{t("report.technical.security")}</span>
              <span className="text-text-primary">
                {protocolSummary.httpsPct >= 80
                  ? t("report.technical.mostlySecure")
                  : protocolSummary.httpsPct > 0
                    ? t("report.technical.mixed")
                    : t("report.technical.insecure")}
              </span>
            </div>
            {playlist.xtream_account_info && (
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary">{t("report.technical.xtreamExpiration")}</span>
                <span className="text-text-primary">
                  {formatEpoch(playlist.xtream_account_info.expires_at_epoch)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">{t("report.technical.totalContent")}</span>
              <span className="text-text-primary">{formatCount(playlist.total_channels)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">{t("report.technical.statusLabel")}</span>
              <span className="text-text-primary">
                {t("report.technical.statusCounts", {
                  alive: formatCount(statusSnapshot?.alive ?? 0),
                  dead: formatCount(statusSnapshot?.dead ?? 0),
                  geo: formatCount(statusSnapshot?.geoblocked ?? 0),
                })}
              </span>
            </div>
            {(statusSnapshot?.placeholder ?? 0) > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary">{t("report.technical.placeholder")}</span>
                <span className="text-orange-400">
                  {formatCount(statusSnapshot?.placeholder ?? 0)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">{t("report.technical.pingP50")}</span>
              <span className="text-text-primary">{formatMs(latencyStats.p50)}</span>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            {t("report.codecs.title")}
          </p>
          {quality.codecEntries.length === 0 ? (
            <p className="text-[12px] text-text-tertiary">{t("report.codecs.empty")}</p>
          ) : (
            <div className="space-y-1 text-[12px]">
              {quality.codecEntries.slice(0, 5).map(([codec, count]) => (
                <div
                  key={codec}
                  className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1"
                >
                  <span
                    dir={codec ? "ltr" : undefined}
                    className="text-text-secondary truncate me-2"
                  >
                    {codec || t("common.unknown")}
                  </span>
                  <span className="text-text-primary">{formatCount(count)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
});
