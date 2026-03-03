# IPTV Checker GUI

## Project Overview
Cross-platform GUI application for validating IPTV playlists. Built with Tauri v2 (Rust backend) + React 19 + TypeScript + Tailwind CSS v4.

Ports all functionality from the CLI tool at `/Users/kristoffer/Code/Scripts/IPTV_checker/IPTV_checker.py`.

## GitHub
- **Repo:** `kristofferR/IPTVChecker`
- **Git identity:** kristofferR (`git use-personal`)

## Stack
- **Backend:** Tauri v2 (Rust) — handles HTTP stream checking, M3U parsing, ffmpeg integration, proxy support
- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS v4
- **Package manager:** bun
- **Type checking:** tsgo (TypeScript 7 via `@typescript/native-preview`)
- **Icons:** lucide-react
- **Virtualization:** @tanstack/react-virtual

## Project Structure

### Rust Backend (`src-tauri/src/`)
```
models/     — Data types: Channel, ChannelResult, AppSettings, ScanConfig, etc.
engine/     — Core logic: parser.rs, checker.rs, ffmpeg.rs, proxy.rs, resume.rs
commands/   — Tauri IPC commands: playlist, scan, export, settings
state.rs    — AppState (settings, cancel token, scanning flag)
error.rs    — AppError enum (thiserror)
lib.rs      — Plugin registration and command handler setup
```

### Frontend (`src/`)
```
components/ — React components: Toolbar, ChannelTable, FilterBar, SettingsPanel, etc.
hooks/      — useScan (event batching), useSettings, useScreenshot
lib/        — Types, Tauri invoke wrappers, formatting helpers, sort/filter logic
```

## Key Architecture Decisions
- **Concurrency defaults to 1** (sequential) — most IPTV servers enforce single-connection limits
- **Event-driven scanning** — Rust emits `scan://channel-result` events per channel, batched with requestAnimationFrame
- **Virtualized table** — @tanstack/react-virtual for 1000+ channel playlists
- **ffmpeg via system PATH** — sidecars optional, graceful degradation if missing

## Commands
- `bun install` — install frontend dependencies
- `bun run setup:ffmpeg` — download ffmpeg/ffprobe binaries for the current platform
- `bun tauri dev` — run in dev mode (hot-reload frontend + Rust rebuild)
- `bun tauri build` — production build
- `cd src-tauri && cargo test` — run Rust tests
- `bun run typecheck` — TypeScript type checking via tsgo

## Coding Conventions
- Rust: snake_case, 4-space indentation, thiserror for errors, serde for serialization
- TypeScript: strict mode, no unused locals/params, types in `lib/types.ts` mirror Rust models
- Components: functional with hooks, Tailwind for styling, no CSS-in-JS
