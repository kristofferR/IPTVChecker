import { memo, useMemo } from "react";
import { BarChart3, X } from "lucide-react";
import type {
  ChannelResult,
  PlaylistPreview,
  PlaylistScore,
  ScanProgress,
  ScanSummary,
} from "../lib/types";
import type { ScanState } from "../hooks/useScan";
import { summarizeLanguageDistribution } from "../lib/languageDistribution";
import { summarizeEpgCoverage } from "../lib/epgCoverage";
import {
  hasScanStarted,
  shouldShowContentCounts,
  shouldShowLanguageDistribution,
} from "../lib/playlistReportVisibility";

interface PlaylistReportPanelProps {
  playlist: PlaylistPreview;
  results: ChannelResult[];
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  scanState: ScanState;
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
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
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
  if (resolution.includes("2160") || resolution.includes("4k") || resolution.includes("uhd")) return "uhd4k";
  if (resolution.includes("1080")) return "hd1080";
  if (resolution.includes("720")) return "hd720";
  return "sd";
}

function codecTier(codec: string | null): number {
  const value = codec?.toLowerCase() ?? "";
  if (!value) return 0.4;
  if (value.includes("hevc") || value.includes("h265") || value.includes("h.265") || value.includes("av1")) {
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
  const epgCoverage = results.filter((result) => (result.tvg_id ?? "").trim().length > 0).length / total;
  const contentScore = clampScore10((aliveRatio * 0.6 + diversity * 0.2 + epgCoverage * 0.2) * 10);

  let qualityScore = 0;
  if (alive.length > 0) {
    const hdRatio = alive.filter((result) => isHdOrUhd(result)).length / alive.length;
    const codecAvg = alive.reduce((sum, result) => sum + codecTier(result.codec), 0) / alive.length;
    const fpsKnown = alive.filter((result) => typeof result.fps === "number").length;
    const fpsRatio = fpsKnown === 0
      ? 0
      : alive.filter((result) => (result.fps ?? 0) >= 25).length / fpsKnown;
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
  playlist,
  results,
  progress,
  summary,
  scanState,
  placement = "left",
  widthPx = 330,
  onResizeStart,
  onClose,
}: PlaylistReportPanelProps) {
  const statusSnapshot = summary ?? progress;

  const latencyStats = useMemo(() => {
    const aliveLatencies = results
      .filter(isAliveResult)
      .map((result) => result.latency_ms)
      .filter((value): value is number => typeof value === "number");
    if (aliveLatencies.length === 0) {
      return { average: null as number | null, p50: null as number | null };
    }
    const average =
      aliveLatencies.reduce((sum, value) => sum + value, 0) / aliveLatencies.length;
    return { average, p50: median(aliveLatencies) };
  }, [results]);

  const languageSummary = useMemo(
    () => summarizeLanguageDistribution(playlist.channels.map((channel) => ({ language: channel.language })), 5),
    [playlist.channels],
  );

  const showHealthScore = hasScanStarted(scanState);
  const showContentCounts = shouldShowContentCounts(
    playlist.movie_count,
    playlist.series_count,
  );
  const showLanguageDistribution = shouldShowLanguageDistribution(
    playlist.channels.map((channel) => ({ language: channel.language })),
  );

  const epgSummary = useMemo(
    () => summarizeEpgCoverage(playlist.channels.map((channel) => ({ tvg_id: channel.tvg_id }))),
    [playlist.channels],
  );

  const protocolSummary = useMemo(() => {
    let http = 0;
    let https = 0;
    for (const channel of playlist.channels) {
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
  }, [playlist.channels]);

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
    () => computeLiveScore(results, playlist.total_channels),
    [results, playlist.total_channels],
  );
  const displayScore = summary?.playlist_score ?? computedScore;
  const ringScore = displayScore?.overall ?? 0;
  const ringPercent = clamp01(ringScore / 10);
  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;

  const aliveOrDrm = (statusSnapshot?.alive ?? 0) + (statusSnapshot?.drm ?? 0);
  const statusLabel = aliveOrDrm > 0 ? "Active" : "Inactive";
  const statusClass = aliveOrDrm > 0 ? "text-emerald-300" : "text-red-300";

  return (
    <aside
      className={`relative h-full shrink-0 ${
        placement === "right" ? "border-l report-panel-enter-right" : "border-r report-panel-enter-left"
      } border-border-app bg-panel/70 backdrop-blur-sm overflow-auto select-none`}
      style={{ width: `${widthPx}px` }}
    >
      {onResizeStart && (
        <div
          onMouseDown={onResizeStart}
          className={`absolute top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors ${
            placement === "right"
              ? "left-0 -translate-x-1/2"
              : "right-0 translate-x-1/2"
          }`}
        />
      )}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-border-app bg-panel/85 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">Playlist Report</p>
            <div className="flex items-center gap-2 mt-1">
              <BarChart3 className="w-4 h-4 text-blue-300" />
              <p className="text-[14px] font-semibold text-text-primary truncate" title={playlist.file_name}>
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
          <span className="text-text-tertiary">•</span>
          <span className="text-text-secondary truncate" title={playlist.server_location ?? "Unknown location"}>
            {playlist.server_location ?? "Unknown location"}
          </span>
          <span className="text-text-tertiary">•</span>
          <span className="text-text-secondary">
            {latencyStats.average == null ? "Ping N/A" : `Avg ${Math.round(latencyStats.average)} ms`}
          </span>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {showHealthScore && (
          <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">Health Score</p>
            <div className="flex items-center gap-3">
              <div className="relative w-24 h-24 shrink-0">
                <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                  <circle cx="50" cy="50" r={ringRadius} stroke="rgba(148,163,184,0.22)" strokeWidth="9" fill="none" />
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
                  <span className="text-text-primary">{(displayScore?.content ?? 0).toFixed(1)}</span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
                  <span className="text-text-tertiary">Quality</span>
                  <span className="text-text-primary">{(displayScore?.quality ?? 0).toFixed(1)}</span>
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
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">Content Counts</p>
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
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">Language Distribution</p>
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
                  <p className="text-[11px] text-text-tertiary">Other: {languageSummary.otherPercentage.toFixed(1)}%</p>
                )}
              </div>
            )}
          </section>
        )}

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">Video Quality Distribution</p>
          <div className="flex h-3 rounded-full overflow-hidden bg-input">
            {([
              ["uhd4k", "#0ea5e9"],
              ["hd1080", "#22c55e"],
              ["hd720", "#f59e0b"],
              ["sd", "#f87171"],
            ] as const).map(([key, color]) => {
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
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">EPG Coverage</p>
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
              <p className="text-text-secondary">{epgSummary.channelsWithEpg} / {epgSummary.totalChannels} channels</p>
              <p className="text-text-secondary">Unique EPG IDs: {epgSummary.uniqueEpgSources}</p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">Technical Details</p>
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
                {protocolSummary.httpsPct >= 80 ? "Mostly secure" : protocolSummary.httpsPct > 0 ? "Mixed" : "Insecure"}
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
                {statusSnapshot?.alive ?? 0} / {statusSnapshot?.dead ?? 0} / {statusSnapshot?.geoblocked ?? 0}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-tertiary">Ping P50</span>
              <span className="text-text-primary">
                {latencyStats.p50 == null ? "N/A" : `${Math.round(latencyStats.p50)} ms`}
              </span>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border-app bg-panel-subtle p-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-2">Codec Distribution</p>
          {quality.codecEntries.length === 0 ? (
            <p className="text-[12px] text-text-tertiary">No codec data yet.</p>
          ) : (
            <div className="space-y-1 text-[12px]">
              {quality.codecEntries.slice(0, 5).map(([codec, count]) => (
                <div key={codec} className="flex items-center justify-between rounded-md bg-input/60 px-2 py-1">
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
