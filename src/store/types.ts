import type { ScanUiMetrics } from "../hooks/useScan.helpers";
import type { ArchiveDownload } from "../lib/archiveDownload";
import type { ArchiveProbeEntry } from "../lib/archiveProbe";
import type { ArchiveVerifyRun } from "../lib/archiveVerifyRun";
import type { DispatcharrOrders } from "../lib/dispatcharr";
import type { OrderChange } from "../lib/dispatcharrEdits";
import type { Platform } from "../lib/platform";
import type { ScanState } from "../lib/scanState";
import type {
  AppSettings,
  ChannelResult,
  CurrentSourceDescriptor,
  DispatcharrOpenRequest,
  EpgLoadSummary,
  PlaylistLoadProgress,
  PlaylistPreview,
  RecentPlaylistEntry,
  SavedPlaylistEntry,
  ScanHistoryItem,
  ScanProgress,
  ScanSummary,
  StalkerOpenRequest,
  XtreamRecentSource,
} from "../lib/types";
import type { UpdateNotice, UpdatePhase } from "../lib/updateState";

// ---------------------------------------------------------------------------
// Playlist
// ---------------------------------------------------------------------------

export interface PlaylistSlice {
  playlist: PlaylistPreview | null;
  cachedSourcePreview: PlaylistPreview | null;
  playlistLoading: boolean;
  playlistLoadProgress: PlaylistLoadProgress | null;
  playlistOpenError: string | null;
  recentPlaylists: RecentPlaylistEntry[];
  savedPlaylists: SavedPlaylistEntry[];
  currentSourceDescriptor: CurrentSourceDescriptor | null;
  lastAppliedSourceFilter: string;

  setPlaylist: (playlist: PlaylistPreview | null) => void;
  setCachedSourcePreview: (preview: PlaylistPreview | null) => void;
  setPlaylistLoading: (loading: boolean) => void;
  setPlaylistLoadProgress: (progress: PlaylistLoadProgress | null) => void;
  setPlaylistOpenError: (error: string | null) => void;
  setRecentPlaylists: (entries: RecentPlaylistEntry[]) => void;
  setSavedPlaylists: (entries: SavedPlaylistEntry[]) => void;
  setCurrentSourceDescriptor: (descriptor: CurrentSourceDescriptor | null) => void;
  setLastAppliedSourceFilter: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface ScanTelemetry {
  throughputChannelsPerSecond: number | null;
  etaSeconds: number | null;
}

export interface ScanCollectionsUpdate {
  flatResults: ChannelResult[];
  resultPositions: Map<number, number>;
  uiMetrics: ScanUiMetrics;
}

export interface ScanRuntimeUpdate {
  duplicateIndices?: Set<number>;
  progress?: ScanProgress | null;
  summary?: ScanSummary | null;
  scanState?: ScanState;
  scanError?: string | null;
  telemetry?: ScanTelemetry;
  screenshotsPaused?: boolean;
  networkPaused?: boolean;
  busyAccounts?: string[];
}

export interface ScanSlice {
  flatResults: ChannelResult[];
  /** Channel index -> position in `flatResults`. Mutated in place as results
   *  arrive, so subscribe to `flatResults` to observe changes. */
  resultPositions: Map<number, number>;
  uiMetrics: ScanUiMetrics;
  duplicateIndices: Set<number>;
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  scanState: ScanState;
  scanError: string | null;
  telemetry: ScanTelemetry;
  screenshotsPaused: boolean;
  networkPaused: boolean;
  /** Dispatcharr accounts whose rows wait because viewers hold every
   *  connection. */
  busyAccounts: string[];

  applyScanCollections: (update: ScanCollectionsUpdate) => void;
  applyScanRuntime: (update: ScanRuntimeUpdate) => void;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface FilterSlice {
  search: string;
  channelSearch: string;
  groupFilter: string;
  statusFilter: string;

  setSearch: (value: string) => void;
  setChannelSearch: (value: string) => void;
  setGroupFilter: (value: string) => void;
  setStatusFilter: (value: string) => void;
  clearAllFilters: () => void;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ArchiveSlice {
  /** Session-only spot-probe results for catch-up channels, keyed by channel index. */
  archiveProbes: Record<number, ArchiveProbeEntry>;
  /** Changes whenever per-playlist archive state is reset. */
  archiveProbeGeneration: number;
  /** Whether a programme selected in the Guide is being tested. */
  archiveGuideTestRunning: boolean;
  /** Result of the most recent XMLTV load for the current playlist. */
  epgLoadSummary: EpgLoadSummary | null;
  /** Progress of a playlist-wide catch-up verification run. */
  archiveVerifyRun: ArchiveVerifyRun | null;
  /** When set, a full verification pass starts after the scan completes. */
  verifyCatchupAfterScan: boolean;
  /** Programme recordings in flight or recently finished, keyed by id. */
  archiveDownloads: Record<string, ArchiveDownload>;

  setArchiveProbe: (generation: number, index: number, entry: ArchiveProbeEntry) => void;
  setArchiveGuideTestRunning: (running: boolean) => void;
  setEpgLoadSummary: (summary: EpgLoadSummary | null) => void;
  setArchiveVerifyRun: (run: ArchiveVerifyRun | null) => void;
  setVerifyCatchupAfterScan: (value: boolean) => void;
  upsertArchiveDownload: (download: ArchiveDownload) => void;
  patchArchiveDownload: (id: string, patch: Partial<ArchiveDownload>) => void;
  removeArchiveDownload: (id: string) => void;
  /** Reset all per-playlist archive state (probes and EPG summary). */
  clearArchiveProbes: () => void;
}

export interface SelectionSlice {
  selectedChannel: ChannelResult | null;
  selectedChannelIndices: number[];

  setSelectedChannel: (channel: ChannelResult | null) => void;
  setSelectedChannelIndices: (indices: number[]) => void;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type OpenSourceMode = "url" | "xtream" | "stalker" | "dispatcharr";

export interface OpenSourceDialogState {
  mode: OpenSourceMode;
  initialUrl: string;
  initialXtream: XtreamRecentSource | null;
  initialStalker: StalkerOpenRequest | null;
  initialDispatcharr: DispatcharrOpenRequest | null;
  /** Saved playlist that a successful Dispatcharr open replaces. */
  convertSaved?: { id: string; name: string } | null;
}

export interface MenuExportRequest {
  id: number;
  action: "csv" | "split" | "renamed" | "m3u" | "scanlog";
}

export type { UpdateNotice, UpdatePhase } from "../lib/updateState";

export type MainViewMode = "table" | "guide";

export interface UiSlice {
  platform: Platform;
  /** Table shows all channels; guide is the catch-up EPG grid. */
  viewMode: MainViewMode;
  /** Channel the guide should scroll to when opened via right-click. */
  guideFocusChannelIndex: number | null;
  isMac: boolean;
  sidebarHidden: boolean;
  sidebarWidth: number;
  showReportPanel: boolean;
  reportAutoRevealBlocked: boolean;
  reportAutoRevealDone: boolean;
  reportWasAutoShown: boolean;
  reportSidebarWidth: number;
  lightboxOpen: boolean;
  showKeyboardShortcuts: boolean;
  isDragOver: boolean;
  ffmpegWarning: boolean;
  errorDismissed: boolean;
  playbackError: string | null;
  scanInputError: string | null;
  menuInfo: string | null;
  menuInfoPersistent: boolean;
  menuExportRequest: MenuExportRequest | null;
  updateNotice: UpdateNotice | null;
  updatePhase: UpdatePhase;
  appVersion: string;
  openSourceDialogState: OpenSourceDialogState | null;

  setPlatform: (platform: Platform) => void;
  setSidebarHidden: (hidden: boolean) => void;
  setViewMode: (mode: MainViewMode) => void;
  setGuideFocusChannelIndex: (index: number | null) => void;
  setSidebarWidth: (width: number) => void;
  toggleReportPanel: () => void;
  setReportPanelManually: (visible: boolean) => void;
  resetReportAutoReveal: () => void;
  prepareReportAutoRevealForScanStart: () => void;
  autoRevealReportPanel: () => void;
  setShowReportPanel: (show: boolean) => void;
  setReportSidebarWidth: (width: number) => void;
  setLightboxOpen: (open: boolean) => void;
  toggleLightboxOpen: () => void;
  setShowKeyboardShortcuts: (show: boolean) => void;
  setIsDragOver: (over: boolean) => void;
  setFfmpegWarning: (warn: boolean) => void;
  setErrorDismissed: (dismissed: boolean) => void;
  setPlaybackError: (error: string | null) => void;
  setScanInputError: (error: string | null) => void;
  setMenuInfo: (
    info: string | null,
    logLevel?: "info" | "warn" | "error",
    persistent?: boolean,
  ) => void;
  setMenuExportRequest: (request: MenuExportRequest | null) => void;
  queueMenuExportRequest: (action: MenuExportRequest["action"]) => void;
  setUpdateNotice: (notice: UpdateNotice | null) => void;
  setUpdatePhase: (phase: UpdatePhase) => void;
  setAppVersion: (version: string) => void;
  setOpenSourceDialogState: (state: OpenSourceDialogState | null) => void;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface PlayerSlice {
  playIntentActive: boolean;
  castActive: boolean;
  externalPlaybackActive: boolean;
  pendingPlaybackChannel: ChannelResult | null;

  setPlayIntentActive: (active: boolean) => void;
  setCastActive: (active: boolean) => void;
  setExternalPlaybackActive: (active: boolean) => void;
  setPendingPlaybackChannel: (channel: ChannelResult | null) => void;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistorySlice {
  showHistory: boolean;
  historyEntries: ScanHistoryItem[];
  historyLoading: boolean;
  historyError: string | null;
  historyClearing: boolean;

  setShowHistory: (show: boolean) => void;
  setHistoryEntries: (entries: ScanHistoryItem[]) => void;
  setHistoryLoading: (loading: boolean) => void;
  setHistoryError: (error: string | null) => void;
  setHistoryClearing: (clearing: boolean) => void;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsSlice {
  settings: AppSettings;
  settingsLoading: boolean;
  settingsHydrated: boolean;

  setSettings: (settings: AppSettings) => void;
  setSettingsLoading: (loading: boolean) => void;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Dispatcharr edits
// ---------------------------------------------------------------------------

export type DispatcharrRowState =
  | { kind: "writing" }
  | { kind: "fixed"; label?: string }
  | { kind: "failed"; error: string; retry: { from: number[]; to: number[] } };

export interface DispatcharrToast {
  fixed: number;
  removed: number;
  failed: number;
  /** The bulk fix's own writes; "Undo all" reverses exactly these. */
  changes: OrderChange[];
}

/** The Find streams panel: the channel it searches for, and whether it steps
 *  through every channel whose streams are all dead. */
export interface DispatcharrFind {
  channelId: number;
  queue: boolean;
}

export interface DispatcharrSlice {
  /** Stream orders written to Dispatcharr this session, keyed by channel id. */
  dispatcharrOrders: DispatcharrOrders;
  /** Order each edited channel had before its last write, for Undo. */
  dispatcharrUndo: DispatcharrOrders;
  dispatcharrRowStates: Record<number, DispatcharrRowState>;
  dispatcharrToast: DispatcharrToast | null;
  dispatcharrFind: DispatcharrFind | null;
  /** Every stream row linked from Find streams since the source loaded. The
   *  source has no row for them, so a reapplied filter restores them from
   *  here. */
  dispatcharrAddedRows: ChannelResult[];
  /** Bumped on every fresh load, so a write that started before it is not
   *  applied to the rows loaded after. */
  dispatcharrEditEpoch: number;

  setDispatcharrRowState: (channelId: number, state: DispatcharrRowState | null) => void;
  /** Record a written order; `undoOrder` null clears the channel's undo. */
  commitDispatcharrOrder: (channelId: number, order: number[], undoOrder: number[] | null) => void;
  setDispatcharrToast: (toast: DispatcharrToast | null) => void;
  setDispatcharrFind: (find: DispatcharrFind | null) => void;
  addDispatcharrRows: (rows: ChannelResult[]) => void;
  resetDispatcharrEdits: () => void;
}

// ---------------------------------------------------------------------------
// Combined store
// ---------------------------------------------------------------------------

export type AppStore = PlaylistSlice &
  ScanSlice &
  FilterSlice &
  SelectionSlice &
  UiSlice &
  PlayerSlice &
  HistorySlice &
  SettingsSlice &
  ArchiveSlice &
  DispatcharrSlice;
