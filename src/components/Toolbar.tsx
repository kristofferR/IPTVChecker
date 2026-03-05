import { memo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BarChart3,
  History,
  Folder,
  FolderOpen,
  Link2,
  Pause,
  Play,
  Square,
  Settings,
  Search,
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
import type { PointerEvent, RefObject } from "react";
import type { ChannelResult } from "../lib/types";
import type { ScanState } from "../hooks/useScan";
import { ExportMenu } from "./ExportMenu";
import type { ExportScope } from "../lib/exportScope";

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
  onToggleReport: () => void;
  scanState: ScanState;
  hasPlaylist: boolean;
  showReport: boolean;
  exportScopeCounts: Record<ExportScope, number>;
  resolveExportScopeResults: (scope: ExportScope) => ChannelResult[];
  playlistName: string;
  playlistPath: string;
  selectedCount: number;
  menuExportRequest: MenuExportRequest | null;
  scanBlockedReason: string | null;
  search: string;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  groups: string[];
  groupFilter: string;
  onGroupChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  filteredCount: number;
  totalCount: number;
}

const toolbarBtn =
  "flex items-center gap-2 px-3 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const toolbarBtnMac =
  "flex items-center justify-center px-3 py-[6px] toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const dragIgnoreSelector =
  "button, input, textarea, select, a, [role='button'], [contenteditable='true'], [data-no-window-drag]";

export const Toolbar = memo(function Toolbar({
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
  onToggleReport,
  scanState,
  hasPlaylist,
  showReport,
  exportScopeCounts,
  resolveExportScopeResults,
  playlistName,
  playlistPath,
  selectedCount,
  menuExportRequest,
  scanBlockedReason,
  search,
  searchInputRef,
  onSearchChange,
  groups,
  groupFilter,
  onGroupChange,
  statusFilter,
  onStatusChange,
  filteredCount,
  totalCount,
}: ToolbarProps) {
  const isMac = useWindowDragRegion;
  const scanning = scanState === "scanning";
  const paused = scanState === "paused";
  const inScanSession = scanning || paused;
  const hasResults = exportScopeCounts.all > 0;
  const scanLabel = selectedCount > 0 ? `Scan Selected (${selectedCount})` : "Scan";
  const scanDisabledReason = !hasPlaylist
    ? "Open a playlist first"
    : scanBlockedReason;
  const filtersDisabled = !hasPlaylist;
  const filtersActive =
    search.trim().length > 0 || groupFilter !== "all" || statusFilter !== "all";
  const filterCountLabel = filtersActive
    ? `${filteredCount} of ${totalCount} channels`
    : `${totalCount} channels`;

  // Platform-appropriate icons
  const IconOpen = isMac ? SFFolder : FolderOpen;
  const IconFolder = isMac ? SFFolderFill : Folder;
  const IconLink = isMac ? SFLink : Link2;
  const IconPlay = isMac ? SFPlayFill : Play;
  const IconPause = isMac ? SFPauseFill : Pause;
  const IconStop = isMac ? SFStopFill : Square;
  const IconSettings = isMac ? SFGearshape : Settings;
  const IconHistory = isMac ? SFClockArrow : History;
  const IconReport = isMac ? BarChart3 : BarChart3;

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!useWindowDragRegion) return;
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest(dragIgnoreSelector)) return;

    // Keep native drag-region behavior intact for secondary windows.
    void getCurrentWindow().startDragging();
  };

  const dragRegionAttr = useWindowDragRegion ? true : undefined;
  const btn = isMac ? toolbarBtnMac : toolbarBtn;
  const toolbarPadding = hasPlaylist
    ? "pt-[var(--toolbar-pt)] pb-2"
    : isMac
      ? "pt-[calc(var(--toolbar-pt)-0.5rem)] pb-1"
      : "pt-[var(--toolbar-pt)] pb-1";
  const toolbarSurface = isMac ? "" : "bg-panel";

  return (
    <div
      onPointerDown={handlePointerDown}
      data-tauri-drag-region={dragRegionAttr}
      className={`flex items-center px-3 ${toolbarSurface} ${toolbarPadding} pl-[var(--toolbar-pl)] relative ${isMac ? "gap-3" : "gap-1.5"}`}
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

      {/* Filters: Search, Group, Status */}
      <div
        className={`flex items-center gap-1.5 ${filtersDisabled ? "opacity-50" : ""}`}
        data-no-window-drag
      >
        <div className="relative">
          <Search className="search-icon absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Search..."
            value={search}
            disabled={filtersDisabled}
            onChange={(e) => onSearchChange(e.target.value)}
            className="native-field h-7 w-40 pl-7 pr-2 text-[12px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed"
          />
        </div>
        <select
          value={groupFilter}
          disabled={filtersDisabled}
          onChange={(e) => onGroupChange(e.target.value)}
          className="native-field h-7 text-[12px] px-2 bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
        >
          <option value="all">All Groups</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          disabled={filtersDisabled}
          onChange={(e) => onStatusChange(e.target.value)}
          className="native-field h-7 text-[12px] px-2 bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
        >
          <option value="all">All Status</option>
          <option value="alive">Alive</option>
          <option value="drm">DRM</option>
          <option value="dead">Dead</option>
          <option value="geoblocked">Geoblocked</option>
          <option value="mislabeled">Mislabeled</option>
          <option value="audio_only">Audio Only</option>
          <option value="duplicates">Duplicates</option>
          <option value="pending">Pending</option>
        </select>
        {hasPlaylist && (
          <span className="text-[11px] text-text-tertiary px-1 whitespace-nowrap">
            {filterCountLabel}
          </span>
        )}
      </div>

      {/* Actions group: Export, History, Settings */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
        <ExportMenu
          scopeCounts={exportScopeCounts}
          resolveScopeResults={resolveExportScopeResults}
          playlistName={playlistName}
          playlistPath={playlistPath}
          disabled={!hasResults || inScanSession}
          menuRequest={menuExportRequest}
          scanState={scanState}
          isMac={isMac}
        />

        <button
          onClick={onToggleReport}
          disabled={!hasPlaylist}
          className={`${isMac ? btn : `${btn} px-2.5`} ${showReport ? "toolbar-btn-primary" : ""}`}
          title={showReport ? "Hide Report" : "Show Report"}
        >
          <IconReport className="w-[22px] h-[22px]" />
          {!isMac && "Report"}
        </button>

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
});
