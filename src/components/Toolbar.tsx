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
  Network,
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
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatCount, type MessageKey, t } from "../i18n";
import { hasArchive } from "../lib/archive";
import { type ArchiveVerifyMode, archiveVerdict } from "../lib/archiveVerification";
import {
  readArchiveVerifyMode,
  storeArchiveVerifyMode,
  verifyArchives,
} from "../lib/archiveVerifyRun";
import {
  DISPATCHARR_STATUS_FILTERS,
  type DispatcharrStatusFilter,
  dispatcharrChannelRows,
  filterDispatcharrPrimaries,
  getDispatcharrView,
  isDispatcharrPreview,
  matchesDispatcharrStatus,
} from "../lib/dispatcharr";
import type { ExportScope } from "../lib/exportScope";
import {
  CATCHUP_VERDICT_FILTERS,
  countStatusOptions,
  filterResultsShared,
  sharedSearchTextCache,
} from "../lib/filters";
import { measureUiPerf } from "../lib/perf";
import { validateSourceFilterPattern } from "../lib/sourceFilter";
import type { ChannelResult } from "../lib/types";
import { useAppStore } from "../store";
import { DispatcharrFindButton } from "./DispatcharrFindPanel";
import { DispatcharrFixAll } from "./DispatcharrFixAll";
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
  onOpenDispatcharr: () => void;
  onSavePlaylist: () => void;
  onManageSavedPlaylists: () => void;
  onStartScan: (verifyCatchup?: boolean) => void;
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
const DISPATCHARR_STATUS_LABELS = {
  primary_dead: "toolbar.status.primaryDead",
  has_dead: "toolbar.status.hasDead",
  all_dead: "toolbar.status.allDead",
} as const satisfies Record<DispatcharrStatusFilter, MessageKey>;
const CATCHUP_VERDICT_INDENT = "\u00a0\u00a0\u00a0\u00a0";
export const Toolbar = memo(function Toolbar({
  onOpen,
  onOpenFolder,
  onOpenUrl,
  onOpenXtream,
  onOpenDispatcharr,
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
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const archiveVerifyRun = useAppStore((s) => s.archiveVerifyRun);
  const archiveGuideTestRunning = useAppStore((s) => s.archiveGuideTestRunning);
  const archiveProbeRunning = useAppStore((s) =>
    Object.values(s.archiveProbes).some((entry) => entry.running),
  );
  const archiveProbes = useAppStore((s) => s.archiveProbes);
  const completedResults = useAppStore((s) => s.flatResults);
  const duplicateIndices = useAppStore((s) => s.duplicateIndices);
  const menuExportRequest = useAppStore((s) => s.menuExportRequest);
  const showReport = useAppStore((s) => s.playlist !== null && s.showReportPanel);
  const hasPlaylist = useAppStore((s) => s.playlist !== null);
  // A reopened Dispatcharr export shows channels but cannot write to them.
  const dispatcharrConnected = useAppStore((s) => isDispatcharrPreview(s.playlist));
  const currentSourceDescriptor = useAppStore((s) => s.currentSourceDescriptor);
  const playlistName = useAppStore((s) => s.playlist?.file_name ?? "");
  const playlistPath = useAppStore((s) => s.playlist?.file_path ?? "");
  const groups = useAppStore((s) => s.playlist?.groups ?? EMPTY_GROUPS);
  const selectedIndices = useAppStore((s) => s.selectedChannelIndices);
  const separatePlaceholder = useAppStore((s) => s.settings.separate_placeholder_status);
  const showHeaderButtonText = useAppStore((s) => s.settings.show_header_button_text);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  const [openMenuVisible, setOpenMenuVisible] = useState(false);
  const scanMenuRef = useRef<HTMLDivElement | null>(null);
  const scanMenuId = useId();
  const [scanMenuVisible, setScanMenuVisible] = useState(false);
  const verifyMenuRef = useRef<HTMLDivElement | null>(null);
  const verifyPopoverRef = useRef<HTMLDivElement | null>(null);
  const [verifyPosition, setVerifyPosition] = useState<{ top: number; left: number } | null>(null);
  const [verifyMenuVisible, setVerifyMenuVisible] = useState(false);
  const [verifyMode, setVerifyMode] = useState<ArchiveVerifyMode>(readArchiveVerifyMode);
  const [verifyScope, setVerifyScope] = useState<ExportScope>("all");

  const dispatcharrOrders = useAppStore((s) => s.dispatcharrOrders);
  const dispatcharrView = useMemo(
    () => getDispatcharrView(completedResults, dispatcharrOrders),
    [completedResults, dispatcharrOrders],
  );
  // Dispatcharr sources filter channels (by their primary stream).
  const visibleDispatcharrPrimaries = useMemo(
    () =>
      dispatcharrView
        ? filterDispatcharrPrimaries(
            dispatcharrView,
            deferredSearch,
            groupFilter,
            statusFilter,
            duplicateIndices,
            separatePlaceholder,
            archiveProbes,
          )
        : null,
    [
      dispatcharrView,
      deferredSearch,
      groupFilter,
      statusFilter,
      duplicateIndices,
      separatePlaceholder,
      archiveProbes,
    ],
  );

  const filteredExportResults = useMemo(
    () =>
      measureUiPerf(
        "toolbar.export-filter",
        () =>
          dispatcharrView && visibleDispatcharrPrimaries
            ? // "Filtered" covers every stream of the visible channels.
              visibleDispatcharrPrimaries.flatMap((primary) => {
                const channel = dispatcharrView.byPrimaryIndex.get(primary.index);
                return channel ? dispatcharrChannelRows(channel) : [];
              })
            : filterResultsShared(
                completedResults,
                deferredSearch,
                groupFilter,
                statusFilter,
                duplicateIndices,
                separatePlaceholder,
                archiveProbes,
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
      dispatcharrView,
      visibleDispatcharrPrimaries,
      deferredSearch,
      groupFilter,
      statusFilter,
      duplicateIndices,
      separatePlaceholder,
      archiveProbes,
    ],
  );

  const statusOptionCounts = useMemo(() => {
    const counts = countStatusOptions(
      dispatcharrView?.primaries ?? completedResults,
      deferredSearch,
      groupFilter,
      duplicateIndices,
      sharedSearchTextCache,
      separatePlaceholder,
      archiveProbes,
    );
    if (dispatcharrView) {
      const channels = filterResultsShared(
        dispatcharrView.primaries,
        deferredSearch,
        groupFilter,
        "all",
        duplicateIndices,
        separatePlaceholder,
        archiveProbes,
      ).flatMap((primary) => dispatcharrView.byPrimaryIndex.get(primary.index) ?? []);
      for (const filter of Object.keys(DISPATCHARR_STATUS_FILTERS) as DispatcharrStatusFilter[]) {
        counts[filter] = channels.filter((channel) =>
          matchesDispatcharrStatus(channel, filter),
        ).length;
      }
    }
    return counts;
  }, [
    completedResults,
    dispatcharrView,
    deferredSearch,
    groupFilter,
    duplicateIndices,
    separatePlaceholder,
    archiveProbes,
  ]);
  const catchupChannelCount = useMemo(
    () => completedResults.filter(hasArchive).length,
    [completedResults],
  );
  const catchupVerdictsAvailable = useMemo(
    () =>
      completedResults.some(
        (result) =>
          hasArchive(result) &&
          archiveVerdict(result, archiveProbes[result.index]) !== "advertised",
      ),
    [completedResults, archiveProbes],
  );
  const verifyScopeCounts = useMemo(() => {
    const selected = new Set(selectedIndices);
    return {
      all: catchupChannelCount,
      filtered: filteredExportResults.filter(hasArchive).length,
      selected: completedResults.filter(
        (result) => selected.has(result.index) && hasArchive(result),
      ).length,
    };
  }, [catchupChannelCount, filteredExportResults, completedResults, selectedIndices]);
  const startVerification = () => {
    setVerifyMenuVisible(false);
    const selected = new Set(selectedIndices);
    const targets =
      verifyScope === "all"
        ? completedResults
        : verifyScope === "filtered"
          ? filteredExportResults
          : completedResults.filter((result) => selected.has(result.index));
    void verifyArchives(targets, verifyMode);
  };

  // Dispatcharr exports follow the channels' current order and leave out
  // streams unlinked this session.
  const exportAllResults = useMemo(
    () =>
      dispatcharrView ? dispatcharrView.channels.flatMap(dispatcharrChannelRows) : completedResults,
    [dispatcharrView, completedResults],
  );

  // The table already expands a selected channel to its streams (and keeps a
  // lone primary-stream selection to that stream).
  const exportSelectedIndices = selectedIndices;
  const exportContextRef = useRef({
    all: exportAllResults,
    filtered: filteredExportResults,
    selectedIndices,
  });

  useEffect(() => {
    exportContextRef.current = {
      all: exportAllResults,
      filtered: filteredExportResults,
      selectedIndices: exportSelectedIndices,
    };
  }, [exportAllResults, filteredExportResults, exportSelectedIndices]);

  useLayoutEffect(() => {
    if (!verifyMenuVisible) {
      setVerifyPosition(null);
      return;
    }
    const anchor = verifyMenuRef.current;
    const popover = verifyPopoverRef.current;
    if (!anchor || !popover) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setVerifyPosition({
        top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - popover.offsetHeight - 8)),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8)),
      });
    };
    update();
    const focusFrame = requestAnimationFrame(() => {
      popover.querySelector<HTMLButtonElement>("button")?.focus();
    });
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    observer.observe(popover);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [verifyMenuVisible]);

  useEffect(() => {
    const handlePointerDownOutside = (event: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(event.target as Node)) {
        setOpenMenuVisible(false);
      }
      if (scanMenuRef.current && !scanMenuRef.current.contains(event.target as Node)) {
        setScanMenuVisible(false);
      }
      if (
        verifyMenuRef.current &&
        !verifyMenuRef.current.contains(event.target as Node) &&
        !verifyPopoverRef.current?.contains(event.target as Node)
      ) {
        setVerifyMenuVisible(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (verifyPopoverRef.current) {
          verifyMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
        setOpenMenuVisible(false);
        setScanMenuVisible(false);
        setVerifyMenuVisible(false);
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

  const exportScopeCounts = useMemo(() => {
    // Count what "selected" exports: selected rows still in the export set.
    const selected = new Set(exportSelectedIndices);
    return {
      all: exportAllResults.length,
      filtered: filteredExportResults.length,
      selected: exportAllResults.filter((result) => selected.has(result.index)).length,
    };
  }, [exportAllResults, filteredExportResults.length, exportSelectedIndices]);

  // --- Derived values ---
  const useWindowDragRegion = platform !== "linux";
  const scanBlockedReason = useMemo(() => {
    const err = validateSourceFilterPattern(channelSearch);
    return err ? t("toolbar.scan.invalidSourceFilter", { error: err }) : null;
  }, [channelSearch]);

  const isMac = platform === "macos";
  const showButtonText = showHeaderButtonText;
  const scanning = scanState === "scanning";
  const paused = scanState === "paused";
  const cancelling = scanState === "cancelling";
  const inScanSession = scanning || paused || cancelling;
  const hasResults = exportScopeCounts.all > 0;
  const scanLabel =
    selectedIndices.length > 0
      ? t("toolbar.scan.scanSelected", { count: selectedIndices.length })
      : t("toolbar.scan.scan");
  const scanDisabledReason = !hasPlaylist
    ? t("toolbar.scan.openPlaylistFirst")
    : archiveVerifyRun || archiveGuideTestRunning || archiveProbeRunning
      ? t("toolbar.scan.waitForVerification")
      : scanBlockedReason;
  const verifyDisabledReason = archiveVerifyRun
    ? t("toolbar.verify.busyVerifying")
    : inScanSession
      ? t("toolbar.verify.busyScanning")
      : archiveGuideTestRunning || archiveProbeRunning
        ? t("toolbar.verify.busyOtherTest")
        : null;
  const canSavePlaylist =
    hasPlaylist && currentSourceDescriptor !== null && currentSourceDescriptor.kind !== "stalker";
  const statusLabel = (value: string, label: string) =>
    hasPlaylist
      ? t("toolbar.statusWithCount", { label, count: statusOptionCounts[value] ?? 0 })
      : label;

  useEffect(() => {
    if (inScanSession) {
      setOpenMenuVisible(false);
    }
  }, [inScanSession]);

  useEffect(() => {
    if (inScanSession || scanDisabledReason !== null) {
      setScanMenuVisible(false);
    }
  }, [inScanSession, scanDisabledReason]);

  // Platform-appropriate icons
  const IconOpen = isMac ? SFDocumentViewfinder : FolderOpen;
  const IconChevron = isMac ? SFChevronDown : ChevronDown;
  const IconFolder = isMac ? SFFolder : Folder;
  const IconLink = isMac ? SFLink : Link2;
  const IconSavePlaylist = BookmarkPlus;
  const IconSavedPlaylists = Library;
  const IconPlay = isMac ? SFPlayFill : Play;
  const IconScan = Radar;
  const IconVerify = History;
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

  const handleOpenAction = (action: "file" | "folder" | "url" | "xtream" | "dispatcharr") => {
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
    if (action === "dispatcharr") {
      onOpenDispatcharr();
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
  const selectedGroupTitle = groupFilter === "all" ? t("toolbar.allGroups") : groupFilter;

  return (
    <div
      onPointerDown={handlePointerDown}
      data-tauri-drag-region={dragRegionAttr}
      className={`relative toolbar-layout ${toolbarSurface}`}
    >
      <div
        data-tauri-drag-region={dragRegionAttr}
        className={`toolbar-actions flex flex-wrap items-center ${toolbarPadding} ${toolbarHorizontalPadding} ${isMac ? "gap-3" : "gap-1.5"}`}
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
                  title={t("toolbar.scan.stopping")}
                  aria-label={t("toolbar.scan.stopping")}
                >
                  <Loader2 className="w-[19px] h-[19px] animate-spin" />
                  {showButtonText && t("toolbar.scan.stoppingShort")}
                </button>
              ) : scanning ? (
                <button
                  onClick={onPauseScan}
                  className={btnWithOptionalText()}
                  title={t("toolbar.scan.pause")}
                  aria-label={t("toolbar.scan.pause")}
                >
                  <IconPause className="w-[22px] h-[22px]" />
                  {showButtonText && t("toolbar.scan.pauseShort")}
                </button>
              ) : (
                <button
                  onClick={onResumeScan}
                  className={btnWithOptionalText("toolbar-btn-primary")}
                  title={t("toolbar.scan.resume")}
                  aria-label={t("toolbar.scan.resume")}
                >
                  <IconPlay className="w-[22px] h-[22px]" />
                  {showButtonText && t("toolbar.scan.resumeShort")}
                </button>
              )}
              {!cancelling && (
                <button
                  onClick={onStopScan}
                  className={btnWithOptionalText("toolbar-btn-stop")}
                  title={t("toolbar.scan.stop")}
                  aria-label={t("toolbar.scan.stop")}
                >
                  <IconStop className="w-[19px] h-[19px]" />
                  {showButtonText && t("toolbar.scan.stopShort")}
                </button>
              )}
            </>
          ) : (
            <div className="relative flex items-center" ref={scanMenuRef} data-no-window-drag>
              <button
                onClick={() => onStartScan(false)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (scanDisabledReason === null && catchupChannelCount > 0) {
                    setScanMenuVisible(true);
                  }
                }}
                disabled={scanDisabledReason !== null}
                title={scanDisabledReason ?? t("toolbar.scan.scan")}
                className={btnWithOptionalText("toolbar-btn-primary")}
                aria-label={scanLabel}
              >
                <IconScan className="w-[22px] h-[22px]" />
                {showButtonText ? (
                  <span className="inline-flex items-center gap-1 leading-none">
                    <span>{scanLabel}</span>
                    {catchupChannelCount > 0 && <span aria-hidden="true" className="h-3 w-3" />}
                  </span>
                ) : catchupChannelCount > 0 ? (
                  <span aria-hidden="true" className="h-3.5 w-3.5" />
                ) : null}
              </button>
              {catchupChannelCount > 0 && (
                <button
                  type="button"
                  onClick={() => setScanMenuVisible((visible) => !visible)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (scanDisabledReason === null) setScanMenuVisible(true);
                  }}
                  disabled={scanDisabledReason !== null}
                  className={`toolbar-scan-options absolute flex items-center justify-center rounded-sm hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none ${isMac ? "text-text-primary" : "text-white"} ${showButtonText ? "bottom-0.5 right-2 h-5 w-5" : "right-1.5 top-1/2 h-6 w-6 -translate-y-1/2"}`}
                  title={t("toolbar.scan.options")}
                  aria-label={t("toolbar.scan.options")}
                  aria-controls={scanMenuId}
                  aria-expanded={scanMenuVisible}
                >
                  <IconChevron
                    className={showButtonText ? "h-3 w-3 opacity-70" : "h-3.5 w-3.5 opacity-70"}
                  />
                </button>
              )}
              {scanMenuVisible && (
                <div
                  id={scanMenuId}
                  className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border-app bg-dropdown py-1 shadow-2xl"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setScanMenuVisible(false);
                      onStartScan(false);
                    }}
                    className="w-full px-3 py-2 text-left text-[13px] hover:bg-btn-hover"
                  >
                    {t("toolbar.scan.scan")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScanMenuVisible(false);
                      onStartScan(true);
                    }}
                    className="w-full px-3 py-2 text-left text-[13px] hover:bg-btn-hover"
                  >
                    {t("toolbar.scan.scanAndVerify", { count: catchupChannelCount })}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Catch-up verification: real vs fake, scoped like Scan */}
        {hasPlaylist && catchupChannelCount > 0 && (
          <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
            <div className="relative flex items-center" ref={verifyMenuRef} data-no-window-drag>
              <button
                type="button"
                onClick={() => setVerifyMenuVisible((visible) => !visible)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (verifyDisabledReason === null) setVerifyMenuVisible(true);
                }}
                disabled={verifyDisabledReason !== null}
                title={verifyDisabledReason ?? t("toolbar.verify.title")}
                className={btnWithOptionalText("gap-1.5")}
                aria-label={t("toolbar.verify.label")}
                aria-haspopup="dialog"
                aria-expanded={verifyMenuVisible}
              >
                <IconVerify className="w-[22px] h-[22px]" />
                {showButtonText && (
                  <span className="inline-flex items-center gap-1 leading-none">
                    <span>
                      {archiveVerifyRun ? t("toolbar.verify.running") : t("toolbar.verify.button")}
                    </span>
                    {!archiveVerifyRun && <IconChevron className="h-3 w-3 opacity-70" />}
                  </span>
                )}
              </button>
              {verifyMenuVisible &&
                createPortal(
                  <div
                    ref={verifyPopoverRef}
                    data-no-window-drag
                    className="macos-popover fixed z-50 w-96 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-border-app bg-dropdown py-1 shadow-2xl text-[13px]"
                    style={{
                      top: verifyPosition?.top ?? 0,
                      left: verifyPosition?.left ?? 0,
                      visibility: verifyPosition ? "visible" : "hidden",
                    }}
                    role="dialog"
                    aria-label={t("toolbar.verify.label")}
                  >
                    <p className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                      {t("toolbar.verify.mode")}
                    </p>
                    {(
                      [
                        ["quick", "toolbar.verify.modeQuick", "toolbar.verify.modeQuickCost"],
                        ["full", "toolbar.verify.modeFull", "toolbar.verify.modeFullCost"],
                      ] as const
                    ).map(([value, label, cost]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={verifyMode === value}
                        onClick={() => {
                          setVerifyMode(value);
                          storeArchiveVerifyMode(value);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-btn-hover"
                      >
                        <span
                          className={`h-3 w-3 rounded-full border ${
                            verifyMode === value
                              ? "border-violet-400 bg-violet-500 ring-2 ring-inset ring-dropdown"
                              : "border-text-tertiary"
                          }`}
                        />
                        <span className="flex-1">{t(label)}</span>
                        <span className="text-[11px] text-text-tertiary">{t(cost)}</span>
                      </button>
                    ))}
                    <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                      {t("toolbar.verify.scope")}
                    </p>
                    {(
                      [
                        ["all", "toolbar.verify.scopeAll"],
                        ["filtered", "toolbar.verify.scopeFiltered"],
                        ["selected", "toolbar.verify.scopeSelected"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={verifyScope === value}
                        onClick={() => setVerifyScope(value)}
                        disabled={verifyScopeCounts[value] === 0}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-btn-hover disabled:opacity-40 disabled:pointer-events-none"
                      >
                        <span
                          className={`h-3 w-3 rounded-full border ${
                            verifyScope === value
                              ? "border-violet-400 bg-violet-500 ring-2 ring-inset ring-dropdown"
                              : "border-text-tertiary"
                          }`}
                        />
                        <span className="flex-1">{t(label)}</span>
                        <span className="text-[11px] tabular-nums text-text-tertiary">
                          {value === verifyScope &&
                          verifyMode === "quick" &&
                          verifyScopeCounts[value] > 0
                            ? t("toolbar.verify.countWithEstimate", {
                                count: verifyScopeCounts[value],
                                minutes: formatCount(
                                  Math.max(1, Math.round(verifyScopeCounts[value] / 60)),
                                ),
                              })
                            : formatCount(verifyScopeCounts[value])}
                        </span>
                      </button>
                    ))}
                    <div className="px-2 pt-2 pb-1">
                      <button
                        type="button"
                        onClick={startVerification}
                        disabled={verifyScopeCounts[verifyScope] === 0}
                        className="w-full rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-500 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                      >
                        {t("toolbar.verify.start", { count: verifyScopeCounts[verifyScope] })}
                      </button>
                    </div>
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        )}

        {/* Source group: Open actions */}
        <div className={isMac ? "toolbar-group" : "flex items-center gap-1.5"}>
          <div className="relative" ref={openMenuRef} data-no-window-drag>
            <button
              type="button"
              onClick={() => setOpenMenuVisible((visible) => !visible)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!inScanSession) setOpenMenuVisible(true);
              }}
              disabled={inScanSession}
              className={btnWithOptionalText("gap-1.5")}
              title={t("toolbar.open.title")}
              aria-label={t("toolbar.open.title")}
              aria-haspopup="menu"
              aria-expanded={openMenuVisible}
            >
              <IconOpen className="w-[22px] h-[22px]" />
              {showButtonText ? (
                <span className="inline-flex items-center gap-1 leading-none">
                  <span>{t("common.open")}</span>
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
                aria-label={t("toolbar.open.menuLabel")}
              >
                <button
                  type="button"
                  onClick={() => handleOpenAction("file")}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                  role="menuitem"
                >
                  <IconOpen className="h-4 w-4 shrink-0" />
                  <span>{t("toolbar.open.file")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenAction("folder")}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                  role="menuitem"
                >
                  <IconFolder className="h-4 w-4 shrink-0" />
                  <span>{t("toolbar.open.folder")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenAction("url")}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                  role="menuitem"
                >
                  <IconLink className="h-4 w-4 shrink-0" />
                  <span>{t("toolbar.open.url")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenAction("xtream")}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                  role="menuitem"
                >
                  <KeyRound className="h-4 w-4 shrink-0" />
                  <span>{t("toolbar.open.xtream")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenAction("dispatcharr")}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-btn-hover"
                  role="menuitem"
                >
                  <Network className="h-4 w-4 shrink-0" />
                  <span>{t("toolbar.open.dispatcharr")}</span>
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
            title={t("toolbar.savePlaylist")}
            aria-label={t("toolbar.savePlaylist")}
          >
            <IconSavePlaylist className="w-[22px] h-[22px]" />
            {showButtonText && t("toolbar.saveShort")}
          </button>

          <button
            onClick={onManageSavedPlaylists}
            disabled={inScanSession}
            className={btnWithOptionalText()}
            title={t("toolbar.savedPlaylists")}
            aria-label={t("toolbar.savedPlaylists")}
          >
            <IconSavedPlaylists className="w-[22px] h-[22px]" />
            {showButtonText && t("toolbar.savedShort")}
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

        {/* Actions group: Export, History, Settings */}
        <div
          className={`${isMac ? "toolbar-group" : "flex items-center gap-1.5"} ml-auto shrink-0`}
        >
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
            archiveProbes={archiveProbes}
            catchupVerdictsAvailable={catchupVerdictsAvailable}
          />

          <button
            onClick={onToggleReport}
            disabled={!hasPlaylist}
            className={`${btnWithOptionalText()} ${showReport ? "toolbar-btn-primary" : ""}`.trim()}
            title={showReport ? t("toolbar.hideReport") : t("toolbar.showReport")}
            aria-label={showReport ? t("toolbar.hideReport") : t("toolbar.showReport")}
          >
            <IconReport className="w-[22px] h-[22px]" />
            {showButtonText && t("toolbar.report")}
          </button>

          <button
            onClick={handleOpenHistory}
            disabled={!hasPlaylist}
            className={btnWithOptionalText()}
            title={t("toolbar.history")}
            aria-label={t("toolbar.history")}
          >
            <IconHistory className="w-[22px] h-[22px]" />
            {showButtonText && t("toolbar.history")}
          </button>

          <button
            onClick={onOpenSettings}
            className={btnWithOptionalText("min-w-9")}
            title={t("toolbar.settings")}
            aria-label={t("toolbar.settings")}
          >
            <IconSettings className="w-[22px] h-[22px]" />
            {showButtonText && t("toolbar.settings")}
          </button>
        </div>
      </div>
      {hasPlaylist && (
        <div
          data-no-window-drag
          className={`toolbar-filters ${dispatcharrView ? "has-action" : ""}`}
        >
          {/* Table / Guide mode switch */}
          <div
            data-no-window-drag
            className="toolbar-view-switch flex shrink-0 items-center gap-0.5 rounded-lg border border-border-app bg-input p-0.5"
          >
            <button
              type="button"
              onClick={() => setViewMode("table")}
              aria-pressed={viewMode === "table"}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                viewMode === "table"
                  ? "bg-btn text-text-primary font-medium"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t("toolbar.viewTable")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("guide")}
              aria-pressed={viewMode === "guide"}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                viewMode === "guide"
                  ? "bg-violet-600 text-white font-medium"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t("toolbar.viewGuide")}
            </button>
          </div>

          <select
            aria-label={t("toolbar.groupFilterLabel")}
            value={groupFilter}
            title={selectedGroupTitle}
            onChange={(e) => handleGroupChange(e.target.value)}
            className="toolbar-select native-field h-7 w-full min-w-0 pl-2.5 pr-7 bg-input border border-border-app rounded-md text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
          >
            <option value="all">{t("toolbar.allGroups")}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select
            aria-label={t("toolbar.statusFilterLabel")}
            value={statusFilter}
            onChange={(e) => handleStatusChange(e.target.value)}
            className="toolbar-select native-field h-7 w-full min-w-0 pl-2.5 pr-7 bg-input border border-border-app rounded-md text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed"
          >
            <option value="all">{statusLabel("all", t("toolbar.status.all"))}</option>
            <option value="alive">{statusLabel("alive", t("toolbar.status.alive"))}</option>
            <option value="drm">{statusLabel("drm", t("toolbar.status.drm"))}</option>
            <option value="dead">{statusLabel("dead", t("toolbar.status.dead"))}</option>
            <option value="geoblocked">
              {statusLabel("geoblocked", t("toolbar.status.geoblocked"))}
            </option>
            {dispatcharrView &&
              Object.entries(DISPATCHARR_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {statusLabel(value, t(label))}
                </option>
              ))}
            {(statusOptionCounts.placeholder ?? 0) > 0 && (
              <option value="placeholder">
                {statusLabel("placeholder", t("toolbar.status.placeholder"))}
              </option>
            )}
            {((statusOptionCounts.catchup ?? 0) > 0 ||
              statusFilter === "catchup" ||
              catchupVerdictsAvailable ||
              statusFilter in CATCHUP_VERDICT_FILTERS) && (
              <option value="catchup">{statusLabel("catchup", t("toolbar.status.catchup"))}</option>
            )}
            {(catchupVerdictsAvailable || statusFilter in CATCHUP_VERDICT_FILTERS) && (
              <>
                <option value="catchup_real">
                  {statusLabel(
                    "catchup_real",
                    CATCHUP_VERDICT_INDENT + t("toolbar.status.catchupReal"),
                  )}
                </option>
                <option value="catchup_shallower">
                  {statusLabel(
                    "catchup_shallower",
                    CATCHUP_VERDICT_INDENT + t("toolbar.status.catchupShallower"),
                  )}
                </option>
                <option value="catchup_fake">
                  {statusLabel(
                    "catchup_fake",
                    CATCHUP_VERDICT_INDENT + t("toolbar.status.catchupFake"),
                  )}
                </option>
                <option value="catchup_untested">
                  {statusLabel(
                    "catchup_untested",
                    CATCHUP_VERDICT_INDENT + t("toolbar.status.catchupUntested"),
                  )}
                </option>
              </>
            )}
            <option value="mislabeled">
              {statusLabel("mislabeled", t("toolbar.status.mislabeled"))}
            </option>
            <option value="audio_only">
              {statusLabel("audio_only", t("toolbar.status.audioOnly"))}
            </option>
            <option value="duplicates">
              {statusLabel("duplicates", t("toolbar.status.duplicates"))}
            </option>
            <option value="pending">{statusLabel("pending", t("toolbar.status.pending"))}</option>
          </select>
          <div className="relative min-w-0">
            <Search className="search-icon absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
            <input
              ref={searchInputRef}
              type="search"
              aria-label={t("toolbar.searchLabel")}
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("toolbar.searchPlaceholder")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="native-field h-7 w-full min-w-0 pl-7 pr-2 text-[12px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed"
            />
          </div>
          {dispatcharrView && dispatcharrConnected && (
            <div className="flex shrink-0 items-center gap-2">
              <DispatcharrFindButton view={dispatcharrView} />
              {visibleDispatcharrPrimaries && (
                <DispatcharrFixAll
                  view={dispatcharrView}
                  visiblePrimaries={visibleDispatcharrPrimaries}
                  filtered={
                    deferredSearch.trim() !== "" || groupFilter !== "all" || statusFilter !== "all"
                  }
                  disabled={inScanSession}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
