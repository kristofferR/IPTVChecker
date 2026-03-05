<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="IPTV Checker icon">
</p>

<h1 align="center">IPTV Checker</h1>

<p align="center">
  A fast, lightweight desktop app for validating IPTV playlists.<br>
  Check which channels are alive, dead, or geoblocked — with stream thumbnails, detailed codec info, and powerful export options.
</p>

<p align="center">
  Built with <strong>Tauri v2</strong> (Rust backend, web frontend) — runs on macOS, Windows, and Linux.
</p>

---

## Features

### Playlist Support
- **M3U / M3U8 files** — open from disk or load from URL
- **Xtream Codes** — connect directly with server, username, and password
- **Folder scanning** — batch-load all playlists from a directory
- **File association** — set as default app for `.m3u` / `.m3u8` files

### Stream Checking
- **HTTP / HLS validation** — verifies streams by downloading real data
- **Geoblock detection** — identifies region-locked channels with multi-probe verification
- **Redirect following** — resolves nested playlists and HTTP redirects
- **ffmpeg integration** — captures stream thumbnails, codec, resolution, FPS, and bitrate info
- **Bitrate profiling** — measures actual video and audio bitrates
- **Label mismatch warnings** — flags channels where metadata doesn't match the actual stream
- **Low framerate detection** — highlights channels below a configurable FPS threshold
- **Configurable retries** — with none, linear, or exponential backoff strategies
- **Proxy support** — route checks through HTTP, HTTPS, SOCKS4, or SOCKS5 proxies (load from file)

### Interface
- **Virtualized table** — handles playlists with thousands of channels smoothly
- **Real-time results** — channels update live as they're checked
- **Group and search filtering** — filter by group, search by name with regex support
- **Pre-scan filtering** — narrow scope before scanning to save time
- **Column customization** — show/hide and reorder columns
- **Row selection** — click, shift-click, cmd/ctrl-click, select all
- **Stream thumbnails** — preview panel with lightbox zoom, arrow key navigation between channels, and space to toggle
- **Scan history** — track results over time and compare diffs between runs
- **Pause / resume** — pause a running scan and pick up where you left off
- **Desktop notifications** — get notified when a scan completes
- **Keyboard shortcuts** — full keyboard navigation
- **macOS Liquid Glass** — native vibrancy and haptic feedback on supported systems
- **Dark / Light / System theme**

### Export
- **CSV** — full results with codec, resolution, latency, and bitrate data
- **M3U** — filtered playlist with only alive channels
- **Split M3U** — one M3U file per group
- **Renamed M3U** — clean up channel names
- **Scan log (JSON)** — detailed machine-readable log of every check attempt

Export scope is flexible: export all results, only alive channels, or just your current selection.

### Playback
- **Double-click to play** — opens the stream in your system's default media player (VLC, IINA, mpv, etc.)

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) (JavaScript runtime and package manager)
- [ffmpeg + ffprobe](https://ffmpeg.org/) — optional but recommended for thumbnails and codec detection

## Getting Started

```bash
# Clone the repo
git clone https://github.com/kristofferR/IPTVChecker.git
cd IPTVChecker

# Install frontend dependencies
bun install

# (Optional) Download ffmpeg/ffprobe binaries for your platform
bun run setup:ffmpeg

# Run in development mode
bun tauri dev
```

## Building

```bash
# Production build (creates platform-specific installer)
bun tauri build
```

## Backend Benchmark Harness

Deterministic local scan/check throughput benchmark (mock local HTTP stream server):

```bash
# Runs Rust backend benchmark binary
bun run perf:backend-scan -- --channels 2000 --concurrency 16 --timeout-secs 2.0 --payload-kb 600
```

Outputs JSON with:
- `time_to_first_result_ms`
- `throughput_channels_per_sec`
- `total_elapsed_ms`
- status buckets (`alive`, `drm`, `dead`, `geoblocked`, `errors`)

## Project Structure

```
src/                    Frontend (React + TypeScript)
├── components/         UI components (Toolbar, ChannelTable, FilterBar, etc.)
├── hooks/              React hooks (useScan, useSettings, useScreenshot)
└── lib/                Types, Tauri IPC wrappers, formatting, sort/filter logic

src-tauri/src/          Backend (Rust)
├── engine/             Core logic: parser, checker, ffmpeg, proxy, resume
├── commands/           Tauri IPC commands: playlist, scan, export, settings
├── models/             Data types: Channel, ChannelResult, AppSettings, etc.
├── state.rs            App state management
└── error.rs            Error types
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Tauri v2](https://v2.tauri.app/) |
| Backend | Rust (tokio, reqwest, serde) |
| Frontend | React 19, TypeScript, Vite 7 |
| Styling | Tailwind CSS v4 |
| Table | [@tanstack/react-virtual](https://tanstack.com/virtual) |
| Icons | [lucide-react](https://lucide.dev/) |

## License

[MIT](LICENSE)
