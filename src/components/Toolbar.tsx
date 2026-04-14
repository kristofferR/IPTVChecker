import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BarChart3,
  BookmarkPlus,
  History,
  Folder,
  FolderOpen,
  Library,
  Link2,
  Pause,
  Play,
  Radar,
  Square,
  Settings,
  Search,
} from "lucide-react";
import {
  SFPlayFill,
  SFPauseFill,
  SFStopFill,
  SFDocumentViewfinder,
  SFFolder,
  SFLink,
  SFGearshape,
  SFClockArrow,
} from "./SFSymbols";
import type { PointerEvent, RefObject } from "react";
import type { ChannelResult } from "../lib/types";
import type { ExportScope } from "../lib/exportScope";
import {
  countStatusOptions,
  filterResults,
  type SearchTextCache,
} from "../lib/filters";
import { measureUiPerf } from "../lib/perf";
import { validateSourceFilterPattern } from "../lib/sourceFilter";
import { ExportMenu } from "./ExportMenu";
import { useAppStore } from "../store";

interface ToolbarProps {
  onOpen: () => void;
  onOpenFolder: () => void;
  onOpenUrl: () => void;
  onSavePlaylist: () => void;
  onManageSavedPlaylists: () => void;
  onStartScan: () => void;
  onPauseScan: () => void;
  onResumeScan: () => void;
  onStopScan: () => void;
  onOpenSettings: () => void;
  onToggleReport: () => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

const toolbarBtn =
  "flex items-center gap-2 px-3 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const toolbarBtnMac =
  "flex items-center justify-center px-3 py-[6px] toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const toolbarBtnMacText =
  "flex items-center gap-2 px-3 py-[6px] text-[13px] toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const dragIgnoreSelector =
  "button, input, textarea, select, a, [role='button'], [contenteditable='true'], [data-no-window-drag]";

const EMPTY_GROUPS: string[] = [];

export const Toolbar = memo(function Toolbar({
  onOpen,
  onOpenFolder,
  onOpenUrl,
  onSavePlaylist,
  onManageSavedPlaylists,
  onStartScan,
  onPauseScan,
  onResumeScan,
  onStopScan,
  onOpenSettings,
  onToggleReport,
  searchInputRef,
}: ToolbarProps) {
  // --- Store reads ---
  const platform = useAppStore((s) => s.platform);
  const scanState = useAppStore((s) => s.scanState);
  const search = useAppStore((s) => s.search);
  const deferredSearch = useDeferredValue(search);
  const channelSearch = useAppStore((s) => s.channelSearch);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const statusFilter = useAppStore((s) => s.statusFilter);
  const completedResults = useAppStore((s) => s.flatResults);
  const duplicateIndices = useAppStore((s) => s.duplicateIndices);
  const menuExportRequest = useAppStore((s) => s.menuExportRequest);
  const showReport = useAppStore(
    (s) => s.playlist !== null && s.showReportPanel,
  );
  const hasPlaylist = useAppStore((s) => s.playlist !== null);
  const playlistName = useAppStore((s) => s.playlist?.file_name ?? "");
  const playlistPath = useAppStore((s) => s.playlist?.file_path ?? "");
  const groups = useAppStore((s) => s.playlist?.groups ?? EMPTY_GROUPS);
  const selectedIndices = useAppStore((s) => s.selectedChannelIndices);
  const separatePlaceholder = useAppStore(
    (s) => s.settings.separate_placeholder_status,
  );
  const showHeaderButtonText = useAppStore(
    (s) => s.settings.show_header_button_text,
  );
  const searchTextCacheRef = useRef<SearchTextCache>(new WeakMap());

  const filteredExportResults = useMemo(
    () =>
      measureUiPerf(
        "toolbar.export-filter",
        () =>
          filterResults(
            completedResults,
            deferredSearch,
            groupFilter,
            statusFilter,
            duplicateIndices,
            searchTextCacheRef.current,
            separatePlaceholder,
          ),
        {
          rows: completedResults.length,
          search: deferredSearch.length,
          group: groupFilter,
          status: statusFilter,
        },
      ),
    [
      completedResults,
      deferredSearch,
      groupFilter,
      statusFilter,
      duplicateIndices,
      separatePlaceholder,
    ],
  );

  const statusOptionCounts = useMemo(
    () =>
      countStatusOptions(
        completedResults,
        deferredSearch,
        groupFilter,
        duplicateIndices,
        searchTextCacheRef.current,
        separatePlaceholder,
      ),
    [
      completedResults,
      deferredSearch,
      groupFilter,
      duplicateIndices,
      separatePlaceholder,
    ],
  );

  const exportContextRef = useRef({
    all: completedResults,
    filtered: filteredExportResults,
    selectedIndices,
  });

  useEffect(() => {
    exportContextRef.current = {
      all: completedResults,
      filtered: filteredExportResults,
      selectedIndices,
    };
  }, [completedResults, filteredExportResults, selectedIndices]);

  const resolveExportScopeResults = useCallback(
    (scope: ExportScope): ChannelResult[] => {
      const context = exportContextRef.current;
      if (scope === "all") {
        return context.all;
      }
      if (scope === "filtered") {
        return context.filtered;
      }
      if (context.selectedIndices.length === 0) {
        return [];
      }
      const selectedSet = new Set(context.selectedIndices);
      return context.all.filter((result) => selectedSet.has(result.index));
    },
    [],
  );

  const exportScopeCounts = useMemo(
    () => ({
      all: completedResults.length,
      filtered: filteredExportResults.length,
      selected: selectedIndices.length,
    }),
    [completedResults.length, filteredExportResults.length, selectedIndices.length],
  );

  // --- Derived values ---
  const useWindowDragRegion = platform !== "linux";
  const scanBlockedReason = useMemo(() => {
    const err = validateSourceFilterPattern(channelSearch);
    return err ? `Invalid source filter regex: ${err}` : null;
  }, [channelSearch]);

  const isMac = platform === "macos";
  const showButtonText = showHeaderButtonText;
  const scanning = scanState === "scanning";
  const paused = scanState === "paused";
  const inScanSession = scanning || paused;
  const hasResults = exportScopeCounts.all > 0;
  const scanLabel =
    selectedIndices.length > 0
      ? `Scan Selected (${selectedIndices.length})`
      : "Scan";
  const scanDisabledReason = !hasPlaylist
    ? "Open a playlist first"
    : scanBlockedReason;
  const filtersDisabled = !hasPlaylist;
  const statusLabel = (value: string, label: string) =>
    hasPlaylist ? `${label} (${statusOptionCounts[value] ?? 0})` : label;

  // Platform-appropriate icons
  const IconOpen = isMac ? SFDocumentViewfinder : FolderOpen;
  const IconFolder = isMac ? SFFolder : Folder;
  const IconLink = isMac ? SFLink : Link2;
  const IconSavePlaylist = BookmarkPlus;
  const IconSavedPlaylists = Library;
  const IconPlay = isMac ? SFPlayFill : Play;
  const IconScan = Radar;
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

  const handleSearchChange = (value: string) => {
    useAppStore.getState().setSearch(value);
  };

  const handleGroupChange = (value: string) => {
    startTransition(() => {
      useAppStore.getState().setGroupFilter(value);
    });
  };

  const handleStatusChange = (value: string) => {
    startTransition(() => {
      useAppStore.getState().setStatusFilter(value);
    });
  };

  const handleOpenHistory = () => {
    useAppStore.getState().setShowHistory(true);
  };

  const dragRegionAttr = useWindowDragRegion ? true : undefined;
  const btn = showButtonText
    ? isMac
      ? toolbarBtnMacText
      : toolbarBtn
    : isMac
      ? toolbarBtnMac
      : `${toolbarBtn} justify-center px-2.5`;
  const btnWithOptionalText = (extraClasses = "") =>
    `${btn} ${extraClasses}`.trim();
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
      className={`flex items-center px-3 ${toolbarSurface} ${toolbarPadding} pl-[var(--toolbar-pl)] pr-[var(--toolbar-pr,0.75rem)] relative ${isMac ? "gap-3" : "gap-1.5"}`}
    >
      {/* Scan group: Scan / Pause+Stop — under traffic lights on macOS */}
      <div className={isMac ? "toolbar-group toolbar-group-prominent -ml-[calc(var(--toolbar-pl)-0.75rem)] mr-2" : "flex items-center gap-1.5"}>
        {inScanSession ? (
          <>
            {scanning ? (
              <button
                onClick={onPauseScan}
                className={btnWithOptionalText()}
                title="Pause Scan"
                aria-label="Pause Scan"
              >
                <IconPause className="w-[22px] h-[22px]" />
                {showButtonText && "Pause"}
              </button>
            ) : (
              <button
                onClick={onResumeScan}
                className={btnWithOptionalText("toolbar-btn-primary")}
                title="Resume Scan"
                aria-label="Resume Scan"
              >
                <IconPlay className="w-[22px] h-[22px]" />
                {showButtonText && "Resume"}
              </button>
            )}
            <button
              onClick={onStopScan}
              className={btnWithOptionalText("toolbar-btn-stop")}
              title="Stop Scan"
              aria-label="Stop Scan"
            >
              <IconStop className="w-[19px] h-[19px]" />
              {showButtonText && "Stop"}
            </button>
          </>
        ) : (
          <button
            onClick={onStartScan}
            disabled={scanDisabledReason !== null}
            title={scanDisabledReason ?? "Scan"}
            className={btnWithOptionalText("toolbar-btn-primary")}
            aria-label={scanLabel}
          >
            <IconScan className="w-[22px] h-[22px]" />
            {showButtonText && scanLabel}
          </button>
        )}
      </div>

      {/* Source group: Open actions */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
        <button
          onClick={onOpen}
          disabled={inScanSession}
          className={btnWithOptionalText()}
          title="Open File"
          aria-label="Open File"
        >
          <IconOpen className="w-[22px] h-[22px]" />
          {showButtonText && "Open"}
        </button>

        <button
          onClick={onOpenFolder}
          disabled={inScanSession}
          className={btnWithOptionalText()}
          title="Open Folder"
          aria-label="Open Folder"
        >
          <IconFolder className="w-[22px] h-[22px]" />
          {showButtonText && "Open Folder"}
        </button>

        <button
          onClick={onOpenUrl}
          disabled={inScanSession}
          className={btnWithOptionalText()}
          title="Open URL"
          aria-label="Open URL"
        >
          <IconLink className="w-[22px] h-[22px]" />
          {showButtonText && "Open URL"}
        </button>
      </div>

      {/* Source group: saved playlist actions */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
        <button
          onClick={onSavePlaylist}
          disabled={!hasPlaylist || inScanSession}
          className={btnWithOptionalText()}
          title="Save Playlist"
          aria-label="Save Playlist"
        >
          <IconSavePlaylist className="w-[22px] h-[22px]" />
          {showButtonText && "Save"}
        </button>

        <button
          onClick={onManageSavedPlaylists}
          disabled={inScanSession}
          className={btnWithOptionalText()}
          title="Saved Playlists"
          aria-label="Saved Playlists"
        >
          <IconSavedPlaylists className="w-[22px] h-[22px]" />
          {showButtonText && "Saved"}
        </button>
      </div>

      {/* macOS: playlist name centered in title bar area */}
      {playlistName && isMac && (
        <span
          data-tauri-drag-region
          className="absolute top-[6px] left-1/2 -translate-x-1/2 text-[13px] text-text-tertiary truncate max-w-[40%] pointer-events-none"
          title={playlistName}
        >
          {playlistName}
        </span>
      )}

      {/* Non-macOS: playlist name inline */}
      {playlistName && !isMac && (
        <span
          className="text-[13px] text-text-tertiary truncate max-w-64 ml-1"
          title={playlistName}
        >
          {playlistName}
        </span>
      )}

      <div data-tauri-drag-region={dragRegionAttr} className="flex-1" />

      {/* Filters: Group, Status, Search */}
      <div
        className={`flex items-center gap-[clamp(0.35rem,0.8vw,0.85rem)] ${filtersDisabled ? "opacity-50" : ""}`}
        data-no-window-drag
      >
        <select
          value={groupFilter}
          disabled={filtersDisabled}
          onChange={(e) => handleGroupChange(e.target.value)}
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
          onChange={(e) => handleStatusChange(e.target.value)}
          className="native-field h-7 text-[12px] px-2 bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
        >
          <option value="all">{statusLabel("all", "All Status")}</option>
          <option value="alive">{statusLabel("alive", "Alive")}</option>
          <option value="drm">{statusLabel("drm", "DRM")}</option>
          <option value="dead">{statusLabel("dead", "Dead")}</option>
          <option value="geoblocked">{statusLabel("geoblocked", "Geoblocked")}</option>
          {(statusOptionCounts.placeholder ?? 0) > 0 && (
            <option value="placeholder">{statusLabel("placeholder", "Placeholder")}</option>
          )}
          <option value="mislabeled">{statusLabel("mislabeled", "Mislabeled")}</option>
          <option value="audio_only">{statusLabel("audio_only", "Audio Only")}</option>
          <option value="duplicates">{statusLabel("duplicates", "Duplicates")}</option>
          <option value="pending">{statusLabel("pending", "Pending")}</option>
        </select>
        <div className="relative ml-[clamp(0.15rem,0.5vw,0.6rem)]">
          <Search className="search-icon absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Search..."
            value={search}
            disabled={filtersDisabled}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="native-field h-7 w-[clamp(9rem,16vw,12.5rem)] pl-7 pr-2 text-[12px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* Actions group: Export, History, Settings */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
        <ExportMenu
          scopeCounts={exportScopeCounts}
          resolveScopeResults={resolveExportScopeResults}
          playlistName={playlistName}
          playlistPath={playlistPath}
          disabled={!hasResults}
          showButtonText={showButtonText}
          menuRequest={menuExportRequest}
          scanState={scanState}
          isMac={isMac}
        />

        <button
          onClick={onToggleReport}
          disabled={!hasPlaylist}
          className={`${btnWithOptionalText()} ${showReport ? "toolbar-btn-primary" : ""}`.trim()}
          title={showReport ? "Hide Report" : "Show Report"}
          aria-label={showReport ? "Hide Report" : "Show Report"}
        >
          <IconReport className="w-[22px] h-[22px]" />
          {showButtonText && "Report"}
        </button>

        <button
          onClick={handleOpenHistory}
          disabled={!hasPlaylist}
          className={btnWithOptionalText()}
          title="History"
          aria-label="History"
        >
          <IconHistory className="w-[22px] h-[22px]" />
          {showButtonText && "History"}
        </button>

        <button
          onClick={onOpenSettings}
          className={btnWithOptionalText("min-w-9")}
          title="Settings"
          aria-label="Settings"
        >
          <IconSettings className="w-[22px] h-[22px]" />
          {showButtonText && "Settings"}
        </button>
      </div>
    </div>
  );
});
