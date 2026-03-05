# Parser Fuzzing

This directory contains `cargo-fuzz` targets for the M3U parser.

## Targets

- `parse_m3u` — fuzzes in-memory playlist parsing with arbitrary bytes
- `extinf_attributes` — fuzzes `#EXTINF` attribute extraction and related helpers
- `playlist_discovery_depth` — fuzzes recursive playlist file discovery paths

## Run locally

```bash
cd src-tauri
cargo install cargo-fuzz
cargo fuzz run parse_m3u --sanitizer none -- -max_total_time=60
cargo fuzz run extinf_attributes --sanitizer none -- -max_total_time=60
cargo fuzz run playlist_discovery_depth --sanitizer none -- -max_total_time=60
```

Interesting crashing inputs can be kept under `fuzz/corpus/<target>/` for regression coverage.
