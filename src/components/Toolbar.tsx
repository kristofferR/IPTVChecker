import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  History,
  Folder,
  FolderOpen,
  Link2,
  Pause,
  Play,
  Square,
  Settings,
} from "lucide-react";
import {
  SFPlayFill,
  SFPauseFill,
  SFStopFill,
  SFFolder,
  SFFolderFill,
  SFLink,
  SFGearshape,
  SFClockArrow,
} from "./SFSymbols";
import type { PointerEvent } from "react";
import type { ChannelResult } from "../lib/types";
import type { ScanState } from "../hooks/useScan";
import { ExportMenu } from "./ExportMenu";

export interface MenuExportRequest {
  id: number;
  action: "csv" | "split" | "renamed" | "m3u" | "scanlog";
}

interface ToolbarProps {
  useWindowDragRegion: boolean;
  onOpen: () => void;
  onOpenFolder: () => void;
  onOpenUrl: () => void;
  onStartScan: () => void;
  onPauseScan: () => void;
  onResumeScan: () => void;
  onStopScan: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  scanState: ScanState;
  hasPlaylist: boolean;
  results: ChannelResult[];
  filteredResults: ChannelResult[];
  selectedResults: ChannelResult[];
  playlistName: string;
  playlistPath: string;
  selectedCount: number;
  menuExportRequest: MenuExportRequest | null;
  scanBlockedReason: string | null;
}

const toolbarBtn =
  "flex items-center gap-2 px-3 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const dragIgnoreSelector =
  "button, input, textarea, select, a, [role='button'], [contenteditable='true'], [data-no-window-drag]";

export function Toolbar({
  useWindowDragRegion,
  onOpen,
  onOpenFolder,
  onOpenUrl,
  onStartScan,
  onPauseScan,
  onResumeScan,
  onStopScan,
  onOpenHistory,
  onOpenSettings,
  scanState,
  hasPlaylist,
  results,
  filteredResults,
  selectedResults,
  playlistName,
  playlistPath,
  selectedCount,
  menuExportRequest,
  scanBlockedReason,
}: ToolbarProps) {
  const appWindow = getCurrentWindow();
  const isMac = useWindowDragRegion;
  const scanning = scanState === "scanning";
  const paused = scanState === "paused";
  const inScanSession = scanning || paused;
  const hasResults = results.length > 0;
  const scanLabel = selectedCount > 0 ? `Scan Selected (${selectedCount})` : "Scan";
  const scanDisabledReason = !hasPlaylist
    ? "Open a playlist first"
    : scanBlockedReason;

  // Platform-appropriate icons
  const IconOpen = isMac ? SFFolder : FolderOpen;
  const IconFolder = isMac ? SFFolderFill : Folder;
  const IconLink = isMac ? SFLink : Link2;
  const IconPlay = isMac ? SFPlayFill : Play;
  const IconPause = isMac ? SFPauseFill : Pause;
  const IconStop = isMac ? SFStopFill : Square;
  const IconSettings = isMac ? SFGearshape : Settings;
  const IconHistory = isMac ? SFClockArrow : History;

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!useWindowDragRegion) return;
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest(dragIgnoreSelector)) return;

    event.preventDefault();
    void appWindow.startDragging();
  };

  const dragRegionAttr = useWindowDragRegion ? true : undefined;

  return (
    <div
      onPointerDown={handlePointerDown}
      data-tauri-drag-region={dragRegionAttr}
      className="flex items-center gap-1.5 px-3 border-b border-border-app bg-panel pt-[var(--toolbar-pt)] pb-2 pl-[var(--toolbar-pl)]"
    >
      <button
        onClick={onOpen}
        disabled={inScanSession}
        className={toolbarBtn}
      >
        <IconOpen className="w-4 h-4" />
        Open
      </button>

      <button
        onClick={onOpenFolder}
        disabled={inScanSession}
        className={toolbarBtn}
      >
        <IconFolder className="w-4 h-4" />
        Open Folder
      </button>

      <button
        onClick={onOpenUrl}
        disabled={inScanSession}
        className={toolbarBtn}
      >
        <IconLink className="w-4 h-4" />
        Open URL
      </button>

      {inScanSession ? (
        <>
          {scanning ? (
            <button
              onClick={onPauseScan}
              className={toolbarBtn}
            >
              <IconPause className="w-4 h-4" />
              Pause
            </button>
          ) : (
            <button
              onClick={onResumeScan}
              className={`${toolbarBtn} toolbar-btn-primary`}
            >
              <IconPlay className="w-4 h-4" />
              Resume
            </button>
          )}
          <button
            onClick={onStopScan}
            className={`${toolbarBtn} toolbar-btn-stop`}
          >
            <IconStop className="w-3.5 h-3.5" />
            Stop
          </button>
        </>
      ) : (
        <button
          onClick={onStartScan}
          disabled={scanDisabledReason !== null}
          title={scanDisabledReason ?? undefined}
          className={`${toolbarBtn} toolbar-btn-primary`}
        >
          <IconPlay className="w-4 h-4" />
          {scanLabel}
        </button>
      )}

      {playlistName && (
        <span
          data-tauri-drag-region={dragRegionAttr}
          className="text-[13px] text-text-tertiary truncate max-w-64 ml-1"
          title={playlistName}
        >
          {playlistName}
        </span>
      )}

      <div data-tauri-drag-region={dragRegionAttr} className="flex-1" />

      <ExportMenu
        results={results}
        filteredResults={filteredResults}
        selectedResults={selectedResults}
        playlistName={playlistName}
        playlistPath={playlistPath}
        disabled={!hasResults || inScanSession}
        menuRequest={menuExportRequest}
        scanState={scanState}
        isMac={isMac}
      />

      <button
        onClick={onOpenHistory}
        disabled={!hasPlaylist}
        className={`${toolbarBtn} px-2.5`}
      >
        <IconHistory className="w-4 h-4" />
        History
      </button>

      <button
        onClick={onOpenSettings}
        className={`${toolbarBtn} px-2 min-w-9 justify-center`}
      >
        <IconSettings className="w-4 h-4" />
      </button>
    </div>
  );
}
