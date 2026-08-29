import { BarChart3, X } from "lucide-react";
import { memo, useMemo } from "react";
import { hasArchive } from "../lib/archive";
import { archiveVerdict, measuredDepthDays } from "../lib/archiveVerification";
import { cancelArchiveVerification, verifyAllArchives } from "../lib/archiveVerifyRun";
import { blendOverallScore, computeCatchupScore } from "../lib/catchupScore";
import { summarizeEpgCoverage } from "../lib/epgCoverage";
import { summarizeLanguageDistribution } from "../lib/languageDistribution";
import { isSingleConnectionPlaylist } from "../lib/playback";
import {
  hasScanStarted,
  shouldShowContentCounts,
  shouldShowLanguageDistribution,
} from "../lib/playlistReportVisibility";
import { isScanActive } from "../lib/scanState";
import type { ChannelResult, PlaylistScore } from "../lib/types";
import { useAppStore } from "../store";

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
  if (!epoch) return "N/A";
  const date = new Date(epoch * 1000);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleDateString(undefined, {
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
    let broken = 0;
    const depths: number[] = [];
    const latencies: number[] = [];
    for (const channel of channels) {
      const entry = archiveProbes[channel.index];
      const verdict = archiveVerdict(channel, entry);
      if (verdict === "verified") {
        verified += 1;
        depths.push(Math.min(channel.catchup_days ?? measuredDepthDays(entry) ?? 1, 14));
      } else if (verdict === "shallower") {
        shallower += 1;
        const measured = measuredDepthDays(entry);
        if (measured != null) depths.push(Math.min(measured, 14));
      } else if (verdict === "broken") {
        broken += 1;
      }
      for (const outcome of entry?.outcomes ?? []) {
        if (outcome.ok && outcome.latencyMs != null) latencies.push(outcome.latencyMs);
      }
    }
    const buckets: Array<{ label: string; count: number }> = [
      { label: "<1 d", count: depths.filter((d) => d < 1).length },
      { label: "1-2 d", count: depths.filter((d) => d >= 1 && d < 3).length },
      { label: "3-6 d", count: depths.filter((d) => d >= 3 && d < 7).length },
      { label: "7 d", count: depths.filter((d) => d >= 7 && d < 8).length },
      { label: "8+ d", count: depths.filter((d) => d >= 8).length },
    ];
    const medianLatency = median(latencies);
    return {
      advertised: channels.length,
      verified,
      shallower,
      broken,
      tested: verified + shallower + broken,
      buckets,
      medianLatency,
    };
  }, [results, archiveProbes]);

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
      const codec = (result.codec ?? "Unknown").trim() || "Unknown";
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
  const displayScore = summary?.playlist_score ?? computedScore;
  const ringScore = displayScore ? blendOverallScore(displayScore, catchupScore) : 0;
  const ringPercent = clamp01(ringScore / 10);
  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;

  const aliveOrDrm = (statusSnapshot?.alive ?? 0) + (statusSnapshot?.drm ?? 0);
  const statusLabel = aliveOrDrm > 0 ? "Active" : "Inactive";
  const statusClass = aliveOrDrm > 0 ? "text-emerald-300" : "text-red-300";

  return (
    <aside
      className={`relative h-full shrink-0 ${
        placement === "right"
          ? "border-l report-panel-enter-right"
          : "border-r report-panel-enter-left"
      } border-border-app bg-panel/70 backdrop-blur-sm overflow-auto select-none`}
      style={{ width: `${widthPx}px` }}
    >
      {onResizeStart && (
        <div
          onMouseDown={onResizeStart}
          className={`absolute top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors ${
            placement === "right" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"
          }`}
        />
      )}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-border-app bg-panel/85 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
              Playlist Report
            </p>
            <div className="flex items-center gap-2 mt-1">
              <BarChart3 className="w-4 h-4 text-blue-300" />
              <p
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
            title="Hide report"
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
              ? "Ping N/A"
              : `Avg ${Math.round(latencyStats.average)} ms`}
          </span>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {showHealthScore && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
              Health Score
            </p>
            <div className="flex items-center gap-3">
              <div className="relative w-24 h-24 shrink-0">
                <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
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
                  {ringScore.toFixed(1)}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-1 text-[12px] flex-1">
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">Ping</span>
                  <span className="text-text-primary">{(displayScore?.ping ?? 0).toFixed(1)}</span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">Content</span>
                  <span className="text-text-primary">
                    {(displayScore?.content ?? 0).toFixed(1)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">Quality</span>
                  <span className="text-text-primary">
                    {(displayScore?.quality ?? 0).toFixed(1)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1 ring-1 ring-violet-500/25">
                  <span className="text-violet-400">Catch-up</span>
                  <span className={catchupScore != null ? "text-violet-300" : "text-text-tertiary"}>
                    {catchupScore != null ? catchupScore.toFixed(1) : "N/A"}
                  </span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-text-tertiary">
              {scanState === "complete" ? "Final score" : "Live estimate during scan"}
            </p>
          </section>
        )}

        {showContentCounts && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
              Content Counts
            </p>
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">Live</p>
                <p className="text-text-primary font-medium">{playlist.live_count}</p>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">Movies</p>
                <p className="text-text-primary font-medium">{playlist.movie_count}</p>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">Series</p>
                <p className="text-text-primary font-medium">{playlist.series_count}</p>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <p className="text-text-tertiary">Total</p>
                <p className="text-text-primary font-medium">{playlist.total_channels}</p>
              </div>
            </div>
          </section>
        )}

        {showLanguageDistribution && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
              Language Distribution
            </p>
            {languageSummary.entries.length === 0 ? (
              <p className="text-[12px] text-text-tertiary">No language metadata detected.</p>
            ) : (
              <div className="space-y-1.5">
                {languageSummary.entries.map((entry, index) => (
                  <div key={entry.language}>
                    <div className="flex items-center justify-between text-[11px] mb-0.5">
                      <span className="text-text-secondary">{entry.language}</span>
                      <span className="text-text-tertiary">{entry.percentage.toFixed(1)}%</span>
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
                    Other: {languageSummary.otherPercentage.toFixed(1)}%
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            Video Quality Distribution
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
            <div className="rounded-md bg-input/60 px-2 py-1">4K: {quality.buckets.uhd4k}</div>
            <div className="rounded-md bg-input/60 px-2 py-1">1080p: {quality.buckets.hd1080}</div>
            <div className="rounded-md bg-input/60 px-2 py-1">720p: {quality.buckets.hd720}</div>
            <div className="rounded-md bg-input/60 px-2 py-1">SD: {quality.buckets.sd}</div>
          </div>
        </section>

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            EPG Coverage
          </p>
          <div className="flex items-center gap-3">
            <div
              className="w-20 h-20 rounded-full relative"
              style={{
                background: `conic-gradient(#10b981 ${(epgSummary.coveragePercent).toFixed(2)}%, rgba(148,163,184,0.2) 0)`,
              }}
            >
              <div className="absolute inset-[14px] rounded-full bg-panel flex items-center justify-center text-[11px] text-text-primary">
                {epgSummary.coveragePercent.toFixed(0)}%
              </div>
            </div>
            <div className="text-[12px] space-y-1">
              <p className="text-text-secondary">
                {epgSummary.channelsWithEpg} / {epgSummary.totalChannels} channels
              </p>
              <p className="text-text-secondary">Unique EPG IDs: {epgSummary.uniqueEpgSources}</p>
              {epgLoadSummary && (
                <p className="text-text-secondary">
                  Programme data: {epgLoadSummary.channels_matched} channels ·{" "}
                  {epgLoadSummary.programme_count.toLocaleString()} programmes
                </p>
              )}
            </div>
          </div>
        </section>

        {catchupStats && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">Catch-up</p>
              {archiveVerifyRun ? (
                <button
                  type="button"
                  onClick={cancelArchiveVerification}
                  className="rounded-md border border-border-app bg-btn px-2 py-0.5 text-[11px] text-text-primary hover:bg-btn-hover transition-colors"
                >
                  {archiveVerifyRun.done}/{archiveVerifyRun.total} · Cancel
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
                      ? "Stop playback before verifying catch-up"
                      : isScanActive(scanState)
                        ? "Wait for the scan to finish"
                        : archiveGuideTestRunning || archiveProbeRunning
                          ? "Another catch-up verification is running"
                          : undefined
                  }
                  className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/20 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  Verify ({catchupStats.advertised})
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-violet-300 tabular-nums">
                  {catchupStats.advertised}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  advertised
                </span>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-green-400 tabular-nums">
                  {catchupStats.verified}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  verified
                </span>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-amber-400 tabular-nums">
                  {catchupStats.shallower}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  shallower
                </span>
              </div>
              <div className="rounded-md bg-input/60 px-2 py-1.5">
                <span className="block text-[15px] font-semibold text-red-400 tabular-nums">
                  {catchupStats.broken}
                </span>
                <span className="text-text-tertiary uppercase text-[9px] tracking-[0.04em]">
                  broken
                </span>
              </div>
            </div>
            {catchupStats.tested > 0 && (
              <>
                <p className="mt-3 mb-1 text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
                  Verified depth
                </p>
                {catchupStats.buckets.map((bucket) => {
                  const maxCount = Math.max(1, ...catchupStats.buckets.map((b) => b.count));
                  return (
                    <div key={bucket.label} className="mb-1 flex items-center gap-2 text-[10px]">
                      <span className="w-8 shrink-0 text-right text-text-secondary tabular-nums">
                        {bucket.label}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-btn/40">
                        <div
                          className="h-full rounded-full bg-violet-500"
                          style={{ width: `${(bucket.count / maxCount) * 100}%` }}
                        />
                      </div>
                      <span className="w-7 shrink-0 text-text-tertiary tabular-nums">
                        {bucket.count}
                      </span>
                    </div>
                  );
                })}
                <div className="mt-2 space-y-1 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-text-tertiary">Median archive start</span>
                    <span className="text-text-primary tabular-nums">
                      {catchupStats.medianLatency != null
                        ? `${Math.round(catchupStats.medianLatency)} ms`
                        : "N/A"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-tertiary">Average live start</span>
                    <span className="text-text-primary tabular-nums">
                      {latencyStats.average != null
                        ? `${Math.round(latencyStats.average)} ms`
                        : "N/A"}
                    </span>
                  </div>
                </div>
              </>
            )}
          </section>
        )}

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            Technical Details
          </p>
          <div className="space-y-1 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Quality (HD+4K)</span>
              <span className="text-text-primary">
                {quality.aliveCount === 0
                  ? "N/A"
                  : `${(((quality.buckets.uhd4k + quality.buckets.hd1080 + quality.buckets.hd720) / quality.aliveCount) * 100).toFixed(1)}%`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Protocol</span>
              <span className="text-text-primary">
                HTTPS {protocolSummary.https} / HTTP {protocolSummary.http}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Security</span>
              <span className="text-text-primary">
                {protocolSummary.httpsPct >= 80
                  ? "Mostly secure"
                  : protocolSummary.httpsPct > 0
                    ? "Mixed"
                    : "Insecure"}
              </span>
            </div>
            {playlist.xtream_account_info && (
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary">Xtream Expiration</span>
                <span className="text-text-primary">
                  {formatEpoch(playlist.xtream_account_info.expires_at_epoch)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Total content</span>
              <span className="text-text-primary">{playlist.total_channels}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Alive / Dead / Geo</span>
              <span className="text-text-primary">
                {statusSnapshot?.alive ?? 0} / {statusSnapshot?.dead ?? 0} /{" "}
                {statusSnapshot?.geoblocked ?? 0}
              </span>
            </div>
            {(statusSnapshot?.placeholder ?? 0) > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary">Placeholder</span>
                <span className="text-orange-400">{statusSnapshot?.placeholder}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Ping P50</span>
              <span className="text-text-primary">
                {latencyStats.p50 == null ? "N/A" : `${Math.round(latencyStats.p50)} ms`}
              </span>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">
            Codec Distribution
          </p>
          {quality.codecEntries.length === 0 ? (
            <p className="text-[12px] text-text-tertiary">No codec data yet.</p>
          ) : (
            <div className="space-y-1 text-[12px]">
              {quality.codecEntries.slice(0, 5).map(([codec, count]) => (
                <div
                  key={codec}
                  className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1"
                >
                  <span className="text-text-secondary truncate mr-2">{codec}</span>
                  <span className="text-text-primary">{count}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
});
