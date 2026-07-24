import type {
  AppSettings,
  ChannelResult,
  CurrentSourceDescriptor,
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
import type { Platform } from "../lib/platform";
import type { ScanState } from "../lib/scanState";
import type { UpdateNotice, UpdatePhase } from "../lib/updateState";
import type { ScanUiMetrics } from "../hooks/useScan.helpers";

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

export type ScanResultLookup = Record<number, ChannelResult | undefined>;

export interface ScanCollectionsUpdate {
  results: ScanResultLookup;
  flatResults: ChannelResult[];
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
}

export interface ScanSlice {
  results: ScanResultLookup;
  flatResults: ChannelResult[];
  uiMetrics: ScanUiMetrics;
  duplicateIndices: Set<number>;
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  scanState: ScanState;
  scanError: string | null;
  telemetry: ScanTelemetry;
  screenshotsPaused: boolean;
  networkPaused: boolean;

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

export interface SelectionSlice {
  selectedChannel: ChannelResult | null;
  selectedChannelIndices: number[];

  setSelectedChannel: (channel: ChannelResult | null) => void;
  setSelectedChannelIndices: (indices: number[]) => void;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type OpenSourceMode = "url" | "xtream" | "stalker";

export interface OpenSourceDialogState {
  mode: OpenSourceMode;
  initialUrl: string;
  initialXtream: XtreamRecentSource | null;
  initialStalker: StalkerOpenRequest | null;
}

export interface MenuExportRequest {
  id: number;
  action: "csv" | "split" | "renamed" | "m3u" | "scanlog";
}

export type { UpdateNotice, UpdatePhase } from "../lib/updateState";

export interface UiSlice {
  platform: Platform;
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
  menuExportRequest: MenuExportRequest | null;
  updateNotice: UpdateNotice | null;
  updatePhase: UpdatePhase;
  appVersion: string;
  openSourceDialogState: OpenSourceDialogState | null;

  setPlatform: (platform: Platform) => void;
  setSidebarHidden: (hidden: boolean) => void;
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
  setMenuInfo: (info: string | null) => void;
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
  pendingPlaybackChannel: ChannelResult | null;

  setPlayIntentActive: (active: boolean) => void;
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
// Combined store
// ---------------------------------------------------------------------------

export type AppStore = PlaylistSlice &
  ScanSlice &
  FilterSlice &
  SelectionSlice &
  UiSlice &
  PlayerSlice &
  HistorySlice &
  SettingsSlice;
