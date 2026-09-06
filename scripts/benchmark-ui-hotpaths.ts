import { toPendingChannelResult } from "../src/lib/channelResults";
import { sortResults } from "../src/lib/filters";
import { timeLabel } from "../src/lib/timeFormat";

// Deterministic, shuffled values exercise actual comparison work on large playlists.
const results = Array.from({ length: 50_000 }, (_, index) => ({
  ...toPendingChannelResult({
    index,
    playlist: "benchmark.m3u",
    name: `Channel ${index}`,
    group: "Group",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    catchup: null,
    catchup_days: null,
    catchup_source: null,
    url: `https://example.com/${index}`,
    content_type: "live",
    extinf_line: `#EXTINF:-1,Channel ${index}`,
    metadata_lines: [],
  }),
  video_bitrate: index % 19 === 0 ? null : `${(index * 7919) % 20_000} kbps`,
  audio_bitrate: `${(index * 97) % 320} kbps`,
  audio_channel_layout: ["stereo", "mono", "5.1", "7.1", "6 ch", null][index % 6],
}));

function measure(label: string, run: () => void) {
  for (let i = 0; i < 5; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${label}: median=${samples[12].toFixed(2)}ms p95=${samples[23].toFixed(2)}ms`);
}

for (const field of ["bitrate", "audio", "audio_layout"] as const) {
  measure(`Sort 50,000 channels by ${field}`, () => {
    if (sortResults(results, field, "asc").length !== results.length) {
      throw new Error("Sort lost results");
    }
  });
}

measure("Format 1,000 guide time labels", () => {
  for (let i = 0; i < 1_000; i++) timeLabel(1_783_339_200 + i * 1800);
});
