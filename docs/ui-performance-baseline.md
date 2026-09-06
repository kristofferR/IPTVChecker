# UI Performance Baseline

This document captures the baseline workflow for UI-only performance checks.

## 1) Filter/Sort Microbenchmark

Run:

```bash
bun run perf:ui-filter
```

This benchmark uses:
- `test-playlists/iptv-org-english.m3u` (2001 channels)
- `test-playlists/free-tv.m3u8` (1887 channels)
- `test-playlists/iptv-org-usa.m3u` (1141 channels)

It reports `avg`, `p50`, and `p95` timings for common filter/sort cases.

## 2) Result Batching Microbenchmark

Run:

```bash
bun run perf:ui-batching
```

Replays a whole scan through `applyResultUpdates` one 16-result batch at a
time — the path every `scan://channel-result` batch takes — and reports total
and per-batch cost at 1k, 10k, and 50k channels.

This exists because the fold used to be quadratic: the UI kept results twice,
once in `flatResults` and once in an index-keyed object that was spread on
every batch. Dropping the second copy (results now live only in `flatResults`,
with an append-only index → position map) took a 50k-channel scan from ~13.8s
of pure store bookkeeping to ~0.2s:

| Channels | Before | After |
|---------:|-------:|------:|
| 1,000 | 3.0 ms | 0.4 ms |
| 10,000 | 445 ms | 17.6 ms |
| 50,000 | 13,761 ms | 213 ms |

Measured on an Apple Silicon dev machine; treat the ratio, not the absolute
numbers, as the baseline.

## 3) Numeric Sorting and Guide Labels

Run:

```bash
bun run scripts/benchmark-ui-hotpaths.ts
```

Uses 50,000 synthetic channels with deterministic, shuffled bitrates and mixed
audio layouts, plus 1,000 guide time labels. Each case warms up five times and
reports the median and p95 of 25 iterations.

Measured on the Linux workstation with Bun 1.4.2, comparing the implementation
at `147bab0` with parsing numeric sort keys once per channel and reusing guide
date/time formatters:

| Operation | Before median | After median |
|-----------|--------------:|-------------:|
| Sort video bitrate | 74.29 ms | 9.33 ms |
| Sort audio bitrate | 58.04 ms | 7.12 ms |
| Sort audio layout | 11.87 ms | 4.02 ms |
| Format 1,000 time labels | 12.24 ms | 0.27 ms |

These measure JavaScript functions in Bun, not native webview frame times or
network scan throughput. Compare runs on the same machine and runtime.

Table filtering and sorting are also memoized separately: probe updates that
leave ordinary filters unchanged retain the sorted array and virtualizer keys.
The selection visibility index is built only when there is a selection or anchor
to reconcile.

## 4) Guide Scrolling

Run the programme-window microbenchmark:

```bash
bun run scripts/benchmark-guide-window.ts
```

It compares a full-history scan with indexed window selection over 60 rows,
14 days of 15-minute programmes per row, and 120 horizontal windows. The indexed
case includes constructing the index. On the Linux workstation with Bun 1.4.2,
median time fell from **20.05 ms to 1.64 ms**, returning the same 302,400 listings
over the full run. This measures selection work, not rendering.

A separate headless Chromium check mounted the actual `GuideView` in Vite dev
mode with mocked Tauri EPG responses: 1,000 channels, a 14-day archive depth,
15-minute programmes, and a 1440×900 viewport. Each pass used 120 animation-frame
steps, moving 40 px horizontally or 160 px vertically. Results below are medians
of three passes, comparing `a124122` with the guide changes:

| Measurement per pass | Before | After |
|----------------------|-------:|------:|
| Horizontal React render time | 686 ms | 323 ms |
| Vertical React commits | 241 | 198 |
| Redundant EPG summary store updates during vertical scrolling | 600 | 0 |
| Vertical frame interval p95 | 23.9 ms | 23.9 ms |
| Frames with gaps in mounted row coverage | 0 | 0 |

Programme indexing alone changed horizontal render time only modestly; retaining
unchanged programme buttons with `memo` produced most of the rendering reduction.
Vertical frame timing did not materially improve in this fixture. The extra
memoized cell components also add mounting work: median vertical React render
time was 642 ms before and 697 ms after. These development-mode measurements do
not establish native WebKit frame rates or real-provider loading performance.

Browser interaction checks covered day/Now jumps, changing selection between
rows, playback arguments, context-menu dismissal, resizing, filters that replace
a row without changing the row count, and remounting after an empty filter.

## 5) Runtime UI Sampling (Dev Builds)

In dev builds, the app records UI perf samples in memory:

- `table.filter` (ChannelTable filtering)
- `table.sort` (ChannelTable sorting, only when filtered results or sort order change)
- `app.completed-results`
- `app.duplicate-detection`
- `app.export-filter`
- `react.commit`
- `longtask`

Samples are buffered in:

```js
window.__iptvUiPerfSamples
```

To disable sampling in dev for comparison:

```js
localStorage.setItem("iptv-checker.ui-perf.disabled", "1")
```

To re-enable:

```js
localStorage.removeItem("iptv-checker.ui-perf.disabled")
```

## 6) Manual UI Checks

1. Start app: `bun tauri dev`
2. Open each baseline playlist
3. During active scan, verify:
   - continuous wheel/trackpad scrolling in table stays responsive
   - search typing remains responsive
   - no sustained long tasks (`longtask` spikes)
