import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterResults, sortResults, type SortDirection, type SortField } from "../src/lib/filters";
import type { ChannelResult, ChannelStatus } from "../src/lib/types";

interface PlaylistCase {
  label: string;
  path: string;
}

interface BenchmarkCase {
  label: string;
  search: string;
  groupFilter: string;
  statusFilter: string;
  sortField: SortField;
  sortDirection: SortDirection;
}

const PLAYLIST_CASES: PlaylistCase[] = [
  { label: "iptv-org-english", path: "test-playlists/iptv-org-english.m3u" },
  { label: "free-tv", path: "test-playlists/free-tv.m3u8" },
  { label: "iptv-org-usa", path: "test-playlists/iptv-org-usa.m3u" },
];

const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    label: "default-filters",
    search: "",
    groupFilter: "all",
    statusFilter: "all",
    sortField: "index",
    sortDirection: "asc",
  },
  {
    label: "search-news-sort-name",
    search: "news",
    groupFilter: "all",
    statusFilter: "all",
    sortField: "name",
    sortDirection: "asc",
  },
  {
    label: "alive-only-sort-latency",
    search: "",
    groupFilter: "all",
    statusFilter: "alive",
    sortField: "latency",
    sortDirection: "asc",
  },
];

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(0, Math.min(values.length - 1, Math.floor(values.length * q)));
  return values[index];
}

function summarize(values: number[]): { avgMs: number; p50Ms: number; p95Ms: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    avgMs: total / sorted.length,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
  };
}

function statusForIndex(index: number): ChannelStatus {
  const mod = index % 5;
  if (mod === 0) return "alive";
  if (mod === 1) return "dead";
  if (mod === 2) return "geoblocked";
  if (mod === 3) return "checking";
  return "pending";
}

function parsePlaylist(filePath: string): ChannelResult[] {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const results: ChannelResult[] = [];
  let extinfLine = "#EXTINF:-1,Unknown";
  let name = "Unknown";
  let group = "Ungrouped";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      extinfLine = trimmed;
      const nameIndex = trimmed.lastIndexOf(",");
      name = nameIndex >= 0 ? trimmed.slice(nameIndex + 1).trim() || "Unknown" : "Unknown";
      const groupMatch = trimmed.match(/group-title="([^"]+)"/i);
      group = groupMatch?.[1]?.trim() || "Ungrouped";
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    const index = results.length;
    const status = statusForIndex(index);
    results.push({
      index,
      playlist: "benchmark",
      name,
      group,
      url: trimmed,
      status,
      codec: status === "alive" ? "h264" : null,
      resolution: status === "alive" ? "1080p" : null,
      width: status === "alive" ? 1920 : null,
      height: status === "alive" ? 1080 : null,
      fps: status === "alive" ? 25 : null,
      latency_ms: status === "alive" ? 120 + (index % 1200) : null,
      video_bitrate: status === "alive" ? `${1500 + (index % 3000)} kbps` : null,
      audio_bitrate: status === "alive" ? `${96 + (index % 192)} kbps` : null,
      audio_codec: status === "alive" ? "aac" : null,
      audio_only: false,
      screenshot_path: null,
      label_mismatches: index % 17 === 0 ? ["mismatch"] : [],
      low_framerate: index % 23 === 0,
      error_message: null,
      channel_id: String(index),
      extinf_line: extinfLine,
      metadata_lines: [],
      stream_url: null,
      retry_count: null,
      error_reason: status === "dead" ? "timeout" : null,
      last_error_reason: null,
    });
  }

  return results;
}

function runFilterSortBenchmark(
  input: ChannelResult[],
  benchCase: BenchmarkCase,
  iterations: number,
): { avgMs: number; p50Ms: number; p95Ms: number; outputCount: number } {
  const samples: number[] = [];
  let outputCount = 0;

  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now();
    const filtered = filterResults(
      input,
      benchCase.search,
      benchCase.groupFilter,
      benchCase.statusFilter,
    );
    const sorted = sortResults(filtered, benchCase.sortField, benchCase.sortDirection);
    outputCount = sorted.length;
    samples.push(performance.now() - startedAt);
  }

  const summary = summarize(samples);
  return {
    ...summary,
    outputCount,
  };
}

function main(): void {
  const iterations = 240;

  console.log("UI filter/sort benchmark");
  console.log(`Iterations per case: ${iterations}`);
  console.log("");

  for (const playlistCase of PLAYLIST_CASES) {
    const absolutePath = resolve(process.cwd(), playlistCase.path);
    const channels = parsePlaylist(absolutePath);
    console.log(`Playlist: ${playlistCase.label} (${channels.length} channels)`);

    for (const benchCase of BENCHMARK_CASES) {
      const result = runFilterSortBenchmark(channels, benchCase, iterations);
      console.log(
        [
          `  ${benchCase.label.padEnd(26, " ")}`,
          `count=${String(result.outputCount).padStart(4, " ")}`,
          `avg=${result.avgMs.toFixed(2).padStart(6, " ")}ms`,
          `p50=${result.p50Ms.toFixed(2).padStart(6, " ")}ms`,
          `p95=${result.p95Ms.toFixed(2).padStart(6, " ")}ms`,
        ].join("  "),
      );
    }
    console.log("");
  }
}

main();
