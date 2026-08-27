import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BarChart3,
  BookmarkPlus,
  ChevronDown,
  Folder,
  FolderOpen,
  History,
  KeyRound,
  Library,
  Link2,
  Loader2,
  Pause,
  Play,
  Radar,
  Search,
  Settings,
  Square,
} from "lucide-react";
import type { PointerEvent, RefObject } from "react";
import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ExportScope } from "../lib/exportScope";
import { countStatusOptions, filterResultsShared, sharedSearchTextCache } from "../lib/filters";
import { measureUiPerf } from "../lib/perf";
import { validateSourceFilterPattern } from "../lib/sourceFilter";
import type { ChannelResult } from "../lib/types";
import { useAppStore } from "../store";
import { ExportMenu } from "./ExportMenu";
import {
  SFChevronDown,
  SFClockArrow,
  SFDocumentViewfinder,
  SFFolder,
  SFGearshape,
  SFLink,
  SFPauseFill,
  SFPlayFill,
  SFStopFill,
} from "./SFSymbols";

interface ToolbarProps {
  onOpen: () => void;
  onOpenFolder: () => void;
  onOpenUrl: () => void;
  onOpenXtream: () => void;
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

const toolbarBtnText =
  "flex flex-col items-center justify-center gap-1 px-3 py-1.5 min-h-[3.15rem] text-[11px] leading-none text-center whitespace-nowrap rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const toolbarBtnMac =
  "flex items-center justify-center px-3 py-[6px] toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const toolbarBtnMacText =
  "flex flex-col items-center justify-center gap-1 px-3 py-[6px] min-h-[3.05rem] text-[11px] leading-none text-center whitespace-nowrap toolbar-btn disabled:opacity-40 disabled:pointer-events-none";

const dragIgnoreSelector =
  "button, input, textarea, select, a, [role='button'], [contenteditable='true'], [data-no-window-drag]";

const EMPTY_GROUPS: string[] = [];
const GROUP_FILTER_LABEL = "All Groups";
const GROUP_SELECT_CHROME_WIDTH = 28;
const DEFAULT_FILTER_SELECT_WIDTH = "clamp(8.75rem,12vw,10.5rem)";

function measureGroupSelectWidth(
  select: HTMLSelectElement,
  labels: readonly string[],
): number | null {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    return null;
  }

  const computedStyle = window.getComputedStyle(select);
  context.font =
    computedStyle.font ||
    `${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;

  const widestLabel = labels.reduce((maxWidth, label) => {
    const width = context.measureText(label).width;
    return width > maxWidth ? width : maxWidth;
  }, 0);

  const horizontalPadding =
    Number.parseFloat(computedStyle.paddingLeft) + Number.parseFloat(computedStyle.paddingRight);
  const horizontalBorder =
    Number.parseFloat(computedStyle.borderLeftWidth) +
    Number.parseFloat(computedStyle.borderRightWidth);

  return Math.ceil(widestLabel + horizontalPadding + horizontalBorder + GROUP_SELECT_CHROME_WIDTH);
}

export const Toolbar = memo(function Toolbar({
  onOpen,
  onOpenFolder,
  onOpenUrl,
  onOpenXtream,
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
  const showReport = useAppStore((s) => s.playlist !== null && s.showReportPanel);
  const hasPlaylist = useAppStore((s) => s.playlist !== null);
  const currentSourceDescriptor = useAppStore((s) => s.currentSourceDescriptor);
  const playlistName = useAppStore((s) => s.playlist?.file_name ?? "");
  const playlistPath = useAppStore((s) => s.playlist?.file_path ?? "");
  const groups = useAppStore((s) => s.playlist?.groups ?? EMPTY_GROUPS);
  const selectedIndices = useAppStore((s) => s.selectedChannelIndices);
  const separatePlaceholder = useAppStore((s) => s.settings.separate_placeholder_status);
  const showHeaderButtonText = useAppStore((s) => s.settings.show_header_button_text);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  const groupSelectRef = useRef<HTMLSelectElement | null>(null);
  const [openMenuVisible, setOpenMenuVisible] = useState(false);
  const [groupSelectWidth, setGroupSelectWidth] = useState<number | null>(null);

  const filteredExportResults = useMemo(
    () =>
      measureUiPerf(
        "toolbar.export-filter",
        () =>
          filterResultsShared(
            completedResults,
            deferredSearch,
            groupFilter,
            statusFilter,
            duplicateIndices,
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
        sharedSearchTextCache,
        separatePlaceholder,
      ),
    [completedResults, deferredSearch, groupFilter, duplicateIndices, separatePlaceholder],
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

  useEffect(() => {
    const handlePointerDownOutside = (event: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(event.target as Node)) {
        setOpenMenuVisible(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuVisible(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDownOutside);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const resolveExportScopeResults = useCallback((scope: ExportScope): ChannelResult[] => {
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
  }, []);

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
  const cancelling = scanState === "cancelling";
  const inScanSession = scanning || paused || cancelling;
  const hasResults = exportScopeCounts.all > 0;
  const scanLabel =
    selectedIndices.length > 0 ? `Scan Selected (${selectedIndices.length})` : "Scan";
  const scanDisabledReason = !hasPlaylist ? "Open a playlist first" : scanBlockedReason;
  const canSavePlaylist =
    hasPlaylist && currentSourceDescriptor !== null && currentSourceDescriptor.kind !== "stalker";
  const filtersDisabled = !hasPlaylist;
  const statusLabel = (value: string, label: string) =>
    hasPlaylist ? `${label} (${statusOptionCounts[value] ?? 0})` : label;

  useEffect(() => {
    if (inScanSession) {
      setOpenMenuVisible(false);
    }
  }, [inScanSession]);

  useLayoutEffect(() => {
    const select = groupSelectRef.current;
    if (!select) {
      return;
    }

    if (!hasPlaylist) {
      setGroupSelectWidth(null);
      return;
    }

    let disposed = false;
    const labels = [GROUP_FILTER_LABEL, ...groups];

    const updateWidth = () => {
      if (disposed) {
        return;
      }

      const nextWidth = measureGroupSelectWidth(select, labels);
      setGroupSelectWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth,
      );
    };

    updateWidth();
    void document.fonts?.ready.then(updateWidth);
    return () => {
      disposed = true;
    };
  }, [groups, hasPlaylist, platform]);

  // Platform-appropriate icons
  const IconOpen = isMac ? SFDocumentViewfinder : FolderOpen;
  const IconChevron = isMac ? SFChevronDown : ChevronDown;
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

  const handleOpenAction = (action: "file" | "folder" | "url" | "xtream") => {
    setOpenMenuVisible(false);
    if (action === "file") {
      onOpen();
      return;
    }
    if (action === "folder") {
      onOpenFolder();
      return;
    }
    if (action === "xtream") {
      onOpenXtream();
      return;
    }
    onOpenUrl();
  };

  const dragRegionAttr = useWindowDragRegion ? true : undefined;
  const btn = showButtonText
    ? isMac
      ? toolbarBtnMacText
      : toolbarBtnText
    : isMac
      ? toolbarBtnMac
      : `${toolbarBtn} justify-center px-2.5`;
  const btnWithOptionalText = (extraClasses = "") => `${btn} ${extraClasses}`.trim();
  const toolbarPadding = hasPlaylist
    ? "pt-[var(--toolbar-pt)] pb-2"
    : isMac
      ? "pt-[var(--toolbar-pt)] pb-1"
      : "pt-[var(--toolbar-pt)] pb-1";
  const toolbarSurface = isMac ? "" : "bg-panel";
  const toolbarHorizontalPadding = isMac
    ? "pl-[var(--toolbar-pl)] pr-[var(--toolbar-pr,0.75rem)]"
    : "pl-[var(--toolbar-pl)] pr-3";
  const inlinePlaylistNameClass = isMac
    ? "absolute top-[6px] left-1/2 max-w-[40%] -translate-x-1/2 truncate text-[13px] text-text-tertiary pointer-events-none"
    : "ml-1 max-w-64 truncate text-[13px] text-text-tertiary";
  const rightControlsClass =
    "ml-auto flex flex-1 min-w-0 items-center justify-end gap-[clamp(0.45rem,0.9vw,1rem)]";
  const filtersClass = `flex min-w-0 flex-1 items-center justify-end gap-[clamp(0.5rem,0.95vw,1rem)] ${filtersDisabled ? "opacity-50" : ""}`;
  const selectedGroupTitle = groupFilter === "all" ? GROUP_FILTER_LABEL : groupFilter;
  const groupSelectStyle =
    groupSelectWidth === null
      ? {
          flexBasis: DEFAULT_FILTER_SELECT_WIDTH,
          maxWidth: DEFAULT_FILTER_SELECT_WIDTH,
        }
      : {
          flexBasis: `${groupSelectWidth}px`,
          maxWidth: `${groupSelectWidth}px`,
        };

  return (
    <div
      onPointerDown={handlePointerDown}
      data-tauri-drag-region={dragRegionAttr}
      className={`relative flex items-center px-3 ${toolbarSurface} ${toolbarPadding} ${toolbarHorizontalPadding} ${isMac ? "gap-3" : "gap-1.5"}`}
    >
      {/* Scan group: Scan / Pause+Stop — under traffic lights on macOS */}
      <div
        className={
          isMac
            ? "toolbar-group toolbar-group-prominent -ml-[calc(var(--toolbar-pl)-0.75rem)] mr-2"
            : "flex items-center gap-1.5"
        }
      >
        {inScanSession ? (
          <>
            {cancelling ? (
              <button
                disabled
                className={btnWithOptionalText("toolbar-btn-stop")}
                title="Stopping Scan"
                aria-label="Stopping Scan"
              >
                <Loader2 className="w-[19px] h-[19px] animate-spin" />
                {showButtonText && "Stopping…"}
              </button>
            ) : scanning ? (
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
            {!cancelling && (
              <button
                onClick={onStopScan}
                className={btnWithOptionalText("toolbar-btn-stop")}
                title="Stop Scan"
                aria-label="Stop Scan"
              >
                <IconStop className="w-[19px] h-[19px]" />
                {showButtonText && "Stop"}
              </button>
            )}
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
        <div className="relative" ref={openMenuRef} data-no-window-drag>
          <button
            type="button"
            onClick={() => setOpenMenuVisible((visible) => !visible)}
            disabled={inScanSession}
            className={btnWithOptionalText("gap-1.5")}
            title="Open Playlist Source"
            aria-label="Open Playlist Source"
            aria-haspopup="menu"
            aria-expanded={openMenuVisible}
          >
            <IconOpen className="w-[22px] h-[22px]" />
            {showButtonText ? (
              <span className="inline-flex items-center gap-1 leading-none">
                <span>Open</span>
                <IconChevron className="h-3 w-3 opacity-70" />
              </span>
            ) : (
              <IconChevron className="h-3.5 w-3.5 opacity-70" />
            )}
          </button>

          {openMenuVisible && (
            <div
              className={
                isMac
                  ? "macos-popover absolute left-0 top-full mt-1 z-50 w-52 rounded-lg border border-border-app bg-dropdown py-1 shadow-xl backdrop-blur-xl"
                  : "absolute left-0 top-full mt-1 z-50 w-52 rounded-lg border border-border-app bg-dropdown/95 p-1.5 shadow-xl backdrop-blur-xl"
              }
              role="menu"
              aria-label="Open playlist source"
            >
              <button
                type="button"
                onClick={() => handleOpenAction("file")}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                role="menuitem"
              >
                <IconOpen className="h-4 w-4 shrink-0" />
                <span>Open File</span>
              </button>
              <button
                type="button"
                onClick={() => handleOpenAction("folder")}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                role="menuitem"
              >
                <IconFolder className="h-4 w-4 shrink-0" />
                <span>Open Folder</span>
              </button>
              <button
                type="button"
                onClick={() => handleOpenAction("url")}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                role="menuitem"
              >
                <IconLink className="h-4 w-4 shrink-0" />
                <span>Open URL</span>
              </button>
              <button
                type="button"
                onClick={() => handleOpenAction("xtream")}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                role="menuitem"
              >
                <KeyRound className="h-4 w-4 shrink-0" />
                <span>Open Xtream</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Source group: saved playlist actions */}
      <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
        <button
          onClick={onSavePlaylist}
          disabled={!canSavePlaylist || inScanSession}
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
        <span data-tauri-drag-region className={inlinePlaylistNameClass} title={playlistName}>
          {playlistName}
        </span>
      )}

      {/* Non-macOS: playlist name inline */}
      {playlistName && !isMac && (
        <span className={inlinePlaylistNameClass} title={playlistName}>
          {playlistName}
        </span>
      )}

      <div data-tauri-drag-region={dragRegionAttr} className={rightControlsClass}>
        {/* Filters: Group, Status, Search */}
        <div className={filtersClass} data-no-window-drag>
          <div className="flex min-w-0 items-center gap-[clamp(0.5rem,0.95vw,1rem)]">
            <div className="min-w-0 shrink" style={groupSelectStyle}>
              <select
                ref={groupSelectRef}
                value={groupFilter}
                title={selectedGroupTitle}
                disabled={filtersDisabled}
                onChange={(e) => handleGroupChange(e.target.value)}
                className="toolbar-select native-field h-7 w-full min-w-0 pl-2.5 pr-7 bg-input border border-border-app rounded-md text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
              >
                <option value="all">{GROUP_FILTER_LABEL}</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <select
              value={statusFilter}
              disabled={filtersDisabled}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="toolbar-select native-field h-7 w-[clamp(8.75rem,12vw,10.5rem)] shrink-0 pl-2.5 pr-7 bg-input border border-border-app rounded-md text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
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
          </div>
          <div className="relative ml-[clamp(0.35rem,0.75vw,0.85rem)] min-w-[6rem] flex-[0_1_clamp(8.5rem,15vw,12.5rem)]">
            <Search className="search-icon absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
            <input
              ref={searchInputRef}
              type="search"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Search..."
              value={search}
              disabled={filtersDisabled}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="native-field h-7 w-full min-w-0 pl-7 pr-2 text-[12px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed"
            />
          </div>
        </div>

        {/* Actions group: Export, History, Settings */}
        <div className={`${isMac ? "toolbar-group" : "flex items-center gap-1.5"} shrink-0`}>
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
    </div>
  );
});
