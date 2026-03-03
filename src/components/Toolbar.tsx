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
      className="flex items-center gap-2 pr-4 border-b border-border-app bg-panel pt-[var(--toolbar-pt)] pb-2 pl-[var(--toolbar-pl)]"
    >
      <button
        onClick={onOpen}
        disabled={scanning}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-btn hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
      >
        <FolderOpen className="w-4 h-4" />
        Open
      </button>

      {scanning ? (
        <button
          onClick={onStopScan}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 rounded-md transition-colors"
        >
          <Square className="w-4 h-4" />
          Stop
        </button>
      ) : (
        <button
          onClick={onStartScan}
          disabled={!hasPlaylist}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
        >
          <Play className="w-4 h-4" />
          Start Scan
        </button>
      )}

      {playlistName && (
        <span className="text-sm text-text-secondary truncate max-w-48" title={playlistName}>
          {playlistName}
        </span>
      )}

      <div className="flex-1" />

      <ExportMenu
        results={results}
        playlistName={playlistName}
        playlistPath={playlistPath}
        disabled={!hasResults || scanning}
      />

      <button
        onClick={onOpenSettings}
        className="p-1.5 hover:bg-btn-hover rounded-md transition-colors"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
