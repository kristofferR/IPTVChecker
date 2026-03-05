# Parser Fuzzing (CI-owned)

This directory contains `cargo-fuzz` targets for the M3U parser.

## Targets

- `parse_m3u` — fuzzes in-memory playlist parsing with arbitrary bytes
- `extinf_attributes` — fuzzes `#EXTINF` attribute extraction and related helpers
- `playlist_discovery_depth` — fuzzes recursive playlist file discovery paths

## Local Development

Fuzz smoke runs are handled in CI. Local development does not require `cargo-fuzz`.

If local fuzz build artifacts were generated, clean them with:

```bash
bun run clean:fuzz-local
```

Interesting crashing inputs can still be kept under `fuzz/corpus/<target>/` for regression coverage.
