/**
 * Measures the per-batch cost of folding incoming scan results into the store's
 * collections — the path every `scan://channel-result` batch takes.
 *
 * Run: bun run perf:ui-batching
 */
import {
  applyResultUpdates,
  emptyResultCollections,
  type ScanResultCollections,
} from "../src/hooks/useScan.helpers";
import type { ChannelResult } from "../src/lib/types";

const CHANNEL_COUNTS = [1_000, 10_000, 50_000];
const BATCH_SIZE = 16;

function makeResult(index: number): ChannelResult {
  return {
    index,
    playlist: "bench.m3u",
    name: `Channel ${index}`,
    group: `Group ${index % 40}`,
    language: null,
    tvg_id: index % 3 === 0 ? `epg-${index}` : null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: `http://example.com/${index}.m3u8`,
    content_type: "live",
    status: index % 5 === 0 ? "dead" : "alive",
    codec: "h264",
    resolution: "1920x1080",
    width: 1920,
    height: 1080,
    fps: 50,
    latency_ms: 120,
    hdr_format: null,
    video_bitrate: null,
    audio_bitrate: null,
    audio_codec: null,
    audio_channel_layout: null,
    audio_only: false,
    screenshot_path: null,
    label_mismatches: index % 11 === 0 ? ["Label mismatch"] : [],
    low_framerate: index % 7 === 0,
    error_message: null,
    channel_id: `id-${index}`,
    extinf_line: `#EXTINF:-1,Channel ${index}`,
    metadata_lines: [],
    stream_url: null,
  };
}

/** Replays a whole scan one batch at a time, as the rAF batching does. */
function runScan(total: number): { totalMs: number; batches: number } {
  const results = Array.from({ length: total }, (_, i) => makeResult(i));
  let collections: ScanResultCollections = emptyResultCollections();
  let batches = 0;

  const started = performance.now();
  for (let offset = 0; offset < results.length; offset += BATCH_SIZE) {
    collections = applyResultUpdates(collections, results.slice(offset, offset + BATCH_SIZE));
    batches += 1;
  }
  const totalMs = performance.now() - started;

  if (collections.flatResults.length !== total) {
    throw new Error(`expected ${total} results, folded ${collections.flatResults.length}`);
  }
  return { totalMs, batches };
}

function main(): void {
  console.log(`Result batching (batch size ${BATCH_SIZE})\n`);
  for (const total of CHANNEL_COUNTS) {
    runScan(Math.min(total, 1_000)); // warm up
    const { totalMs, batches } = runScan(total);
    console.log(
      [
        `  ${String(total).padStart(6, " ")} channels`,
        `batches=${String(batches).padStart(5, " ")}`,
        `total=${totalMs.toFixed(1).padStart(8, " ")}ms`,
        `per-batch=${(totalMs / batches).toFixed(3).padStart(7, " ")}ms`,
      ].join("  "),
    );
  }
}

main();
