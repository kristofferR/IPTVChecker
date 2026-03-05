# Backend Performance Baseline

This document defines the deterministic local benchmark flow for backend scan/check throughput and responsiveness.

## Benchmark Harness

The harness runs a mock local HTTP stream server and checks a configurable number of channels using the backend checker path.

Command:

```bash
bun run perf:backend-scan -- --channels 2000 --concurrency 16 --timeout-secs 2.0 --payload-kb 600
```

Parameters:
- `--channels` number of synthetic channels to check
- `--concurrency` worker concurrency for the harness run
- `--timeout-secs` per-channel check timeout
- `--payload-kb` stream payload size (must stay above checker threshold; default `600`)

## Metrics Captured

The harness prints one JSON object containing:
- `time_to_first_result_ms`
- `throughput_channels_per_sec`
- `total_elapsed_ms`
- `alive`, `drm`, `dead`, `geoblocked`, `errors`
- run parameters (`channels`, `concurrency`, `timeout_secs`, `payload_kb`)

## Baseline Recording

When recording baseline numbers:
1. Run each scenario at least 3 times.
2. Keep machine load stable between runs.
3. Record median values for:
   - `time_to_first_result_ms`
   - `throughput_channels_per_sec`
   - `total_elapsed_ms`
4. Keep the full JSON outputs in the issue thread for traceability.
