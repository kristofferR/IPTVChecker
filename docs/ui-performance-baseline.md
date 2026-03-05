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

## 2) Runtime UI Sampling (Dev Builds)

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

## 3) Manual UI Checks

1. Start app: `bun tauri dev`
2. Open each baseline playlist
3. During active scan, verify:
   - continuous wheel/trackpad scrolling in table stays responsive
   - search typing remains responsive
   - no sustained long tasks (`longtask` spikes)
