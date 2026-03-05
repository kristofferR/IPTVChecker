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

## Disk Usage

The Rust/Tauri build cache (`src-tauri/target/`) can grow to 20-30 GB. Clean it periodically:
```
rm -rf src-tauri/target
```
This is safe — it just rebuilds on next `bun tauri dev` or `bun tauri build`. Clean it at the start of sessions when disk space is low, or after finishing major work.

## Coding Conventions
- Rust: snake_case, 4-space indentation, thiserror for errors, serde for serialization
- TypeScript: strict mode, no unused locals/params, types in `lib/types.ts` mirror Rust models
- Components: functional with hooks, Tailwind for styling, no CSS-in-JS

## MCP Tools (tauri-plugin-mcp)

Debug-only Tauri plugin that exposes the app's webview to Claude Code via MCP tools (`mcp__tauri-mcp__*`). Requires `bun tauri dev` to be running (creates IPC socket at `/tmp/tauri-mcp-iptv-checker.sock`).

### Available tools and usage patterns

**Inspecting the app:**
- `query_page(mode='app_info')` — app version, windows, monitors
- `query_page(mode='state')` — URL, title, scroll position, viewport size
- `query_page(mode='map', interactive_only=true)` — get numbered refs for all buttons/inputs/selects
- `query_page(mode='find_element', selector_type='ref', selector_value='N')` — get CSS pixel coordinates for a ref
- `execute_js(code='...')` — run arbitrary JS in the webview (most flexible inspection tool)
- `take_screenshot(inline=true)` — captures frontmost screen window, so focus the app first with `manage_window(action='focus')`

**Interacting with the app:**
- `click(selector_type='ref', selector_value='N')` — click an element by ref from map
- `type_text(selector_type='ref', selector_value='N', text='...')` — type into an input (cannot send empty string; use `execute_js` to clear)
- `mouse_action(action='scroll', direction='down', amount=200)` — scroll the page
- `navigate(action='reload')` — reload; also supports `goto`, `back`, `forward`

**Waiting and state:**
- `wait_for(text='...', state='visible', timeout_ms=5000)` — wait for text to appear/disappear
- `manage_storage(store='local_storage', action='keys')` — list/get/set localStorage keys
- `manage_window(action='focus')` — focus, resize, position, zoom, devtools, bounds

### Workflow
1. `query_page(mode='map', interactive_only=true)` to discover elements and get refs
2. `click`/`type_text` using refs to interact
3. `execute_js` for anything the structured tools can't do
4. `wait_for` after actions that trigger async updates
5. `take_screenshot` to visually verify (focus app window first)
