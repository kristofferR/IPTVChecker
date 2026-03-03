import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FolderOpen,
  Play,
  Square,
  Settings,
} from "lucide-react";
import type { PointerEvent } from "react";
import type { ChannelResult } from "../lib/types";
import type { ScanState } from "../hooks/useScan";
import { ExportMenu } from "./ExportMenu";

interface ToolbarProps {
  onOpen: () => void;
  onStartScan: () => void;
  onStopScan: () => void;
  onOpenSettings: () => void;
  scanState: ScanState;
  hasPlaylist: boolean;
  results: ChannelResult[];
  playlistName: string;
  playlistPath: string;
}

const toolbarBtn =
  "flex items-center gap-2 px-3 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const appWindow = getCurrentWindow();
const dragIgnoreSelector =
  "button, input, textarea, select, a, [role='button'], [contenteditable='true'], [data-no-window-drag]";

export function Toolbar({
  onOpen,
  onStartScan,
  onStopScan,
  onOpenSettings,
  scanState,
  hasPlaylist,
  results,
  playlistName,
  playlistPath,
}: ToolbarProps) {
  const scanning = scanState === "scanning";
  const hasResults = results.length > 0;

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest(dragIgnoreSelector)) return;

    event.preventDefault();
    void appWindow.startDragging();
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      data-tauri-drag-region
      className="flex items-center gap-1.5 px-3 border-b border-border-app bg-panel pt-[var(--toolbar-pt)] pb-2 pl-[var(--toolbar-pl)]"
    >
      <button
        onClick={onOpen}
        disabled={scanning}
        className={toolbarBtn}
      >
        <FolderOpen className="w-4 h-4" />
        Open
      </button>

      {scanning ? (
        <button
          onClick={onStopScan}
          className={`${toolbarBtn} toolbar-btn-stop`}
        >
          <Square className="w-3.5 h-3.5" />
          Stop
        </button>
      ) : (
        <button
          onClick={onStartScan}
          disabled={!hasPlaylist}
          className={`${toolbarBtn} toolbar-btn-primary`}
        >
          <Play className="w-4 h-4" />
          Scan
        </button>
      )}

      {playlistName && (
        <span data-tauri-drag-region className="text-[13px] text-text-tertiary truncate max-w-64 ml-1" title={playlistName}>
          {playlistName}
        </span>
      )}

      <div data-tauri-drag-region className="flex-1" />

      <ExportMenu
        results={results}
        playlistName={playlistName}
        playlistPath={playlistPath}
        disabled={!hasResults || scanning}
      />

      <button
        onClick={onOpenSettings}
        className={`${toolbarBtn} px-2 min-w-9 justify-center`}
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
