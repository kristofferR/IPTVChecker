import {
  FolderOpen,
  Play,
  Square,
  Settings,
} from "lucide-react";
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
  "flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

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

  return (
    <div
      data-tauri-drag-region
      className="flex items-center gap-1 px-3 border-b border-border-app bg-panel pt-[var(--toolbar-pt)] pb-1.5 pl-[var(--toolbar-pl)]"
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
        <span data-tauri-drag-region className="text-xs text-text-tertiary truncate max-w-48 ml-1" title={playlistName}>
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
        className={`${toolbarBtn} px-1.5`}
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
