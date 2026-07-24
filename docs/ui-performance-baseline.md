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

## 3) Runtime UI Sampling (Dev Builds)

In dev builds, the app records UI perf samples in memory:

- `table.filter-sort` (ChannelTable filter+sort pipeline)
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

## 4) Manual UI Checks

1. Start app: `bun tauri dev`
2. Open each baseline playlist
3. During active scan, verify:
   - continuous wheel/trackpad scrolling in table stays responsive
   - search typing remains responsive
   - no sustained long tasks (`longtask` spikes)
