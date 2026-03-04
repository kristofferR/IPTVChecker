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

const toolbarBtnMac =
  "flex items-center justify-center px-3 py-[6px] toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

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
  const btn = isMac ? toolbarBtnMac : toolbarBtn;

  return (
    <div
      onPointerDown={handlePointerDown}
      data-tauri-drag-region={dragRegionAttr}
      className={`flex items-center px-3 border-b border-border-app bg-panel pt-[var(--toolbar-pt)] pb-2 pl-[var(--toolbar-pl)] ${isMac ? "gap-3" : "gap-1.5"}`}
    >
      {/* Source group: Open, Open Folder, Open URL */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
        <button
          onClick={onOpen}
          disabled={inScanSession}
          className={btn}
          title="Open File"
        >
          <IconOpen className="w-[22px] h-[22px]" />
          {!isMac && "Open"}
        </button>

        <button
          onClick={onOpenFolder}
          disabled={inScanSession}
          className={btn}
          title="Open Folder"
        >
          <IconFolder className="w-[22px] h-[22px]" />
          {!isMac && "Open Folder"}
        </button>

        <button
          onClick={onOpenUrl}
          disabled={inScanSession}
          className={btn}
          title="Open URL"
        >
          <IconLink className="w-[22px] h-[22px]" />
          {!isMac && "Open URL"}
        </button>
      </div>

      {/* Scan group: Scan / Pause+Stop */}
      <div className={isMac ? "toolbar-group toolbar-group-prominent" : "flex items-center gap-1.5"}>
        {inScanSession ? (
          <>
            {scanning ? (
              <button
                onClick={onPauseScan}
                className={btn}
                title="Pause Scan"
              >
                <IconPause className="w-[22px] h-[22px]" />
                {!isMac && "Pause"}
              </button>
            ) : (
              <button
                onClick={onResumeScan}
                className={isMac ? btn : `${btn} toolbar-btn-primary`}
                title="Resume Scan"
              >
                <IconPlay className="w-[22px] h-[22px]" />
                {!isMac && "Resume"}
              </button>
            )}
            <button
              onClick={onStopScan}
              className={`${btn} toolbar-btn-stop`}
              title="Stop Scan"
            >
              <IconStop className="w-[19px] h-[19px]" />
              {!isMac && "Stop"}
            </button>
          </>
        ) : (
          <button
            onClick={onStartScan}
            disabled={scanDisabledReason !== null}
            title={scanDisabledReason ?? (isMac ? "Scan" : undefined)}
            className={isMac ? btn : `${btn} toolbar-btn-primary`}
          >
            <IconPlay className="w-[22px] h-[22px]" />
            {!isMac && scanLabel}
          </button>
        )}
      </div>

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

      {/* Actions group: Export, History, Settings */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
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
          className={isMac ? btn : `${btn} px-2.5`}
          title="History"
        >
          <IconHistory className="w-[22px] h-[22px]" />
          {!isMac && "History"}
        </button>

        <button
          onClick={onOpenSettings}
          className={isMac ? btn : `${btn} px-2 min-w-9 justify-center`}
          title="Settings"
        >
          <IconSettings className="w-[22px] h-[22px]" />
        </button>
      </div>
    </div>
  );
}
