import {
  lazy,
  Profiler,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ProfilerOnRenderCallback,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { setLiquidGlassEffect } from "tauri-plugin-liquid-glass-api";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type {
  ChannelResult,
  CurrentSourceDescriptor,
  RecentPlaylistEntry,
  ScanConfig,
  PlaylistPreview,
  SavedPlaylistDraft,
  SavedPlaylistEntry,
  StalkerOpenRequest,
  XtreamOpenRequest,
  XtreamRecentSource,
  AppSettings,
} from "./lib/types";
import {
  addRecentPlaylist,
  clearRecentPlaylists,
  clearScanHistory,
  deleteSavedPlaylist,
  getSavedPlaylists,
  getRecentPlaylists,
  getScanHistory,
  openPlaylist,
  openSavedPlaylist,
  openPlaylistStalker,
  openPlaylistXtream,
  openPlaylistUrl,
  checkFfmpegAvailable,
  readScreenshot,
  openChannelInPlayer,
  quickCheckChannel,
  upsertSavedPlaylist,
} from "./lib/tauri";
import { useScan } from "./hooks/useScan";
import { useSettings } from "./hooks/useSettings";
import { useChromecast, type UseChromecastResult } from "./hooks/useChromecast";
import { useStreamPlayer } from "./hooks/useStreamPlayer";
import { buildCastRequest, isCastSessionActive } from "./lib/cast";
import type { ChromecastDevice } from "./lib/types";
import { useAppStore } from "./store";
import type { AppStore, OpenSourceDialogState, UpdateNotice } from "./store/types";
import { Toolbar } from "./components/Toolbar";
import { FilterBar } from "./components/FilterBar";
import { ChannelTable } from "./components/ChannelTable";
import { PlaylistReportPanel } from "./components/PlaylistReportPanel";
import { ThumbnailPanel } from "./components/ThumbnailPanel";
import { StatsPanel } from "./components/StatsPanel";
import { ProgressBar } from "./components/ProgressBar";
const KeyboardShortcutsDialog = lazy(() => import("./components/KeyboardShortcutsDialog"));
const HistoryPanel = lazy(() => import("./components/HistoryPanel"));
const OpenSourceDialog = lazy(() => import("./components/OpenSourceDialog"));
const XtreamServerTestDialog = lazy(() =>
  import("./components/OpenSourceDialog").then((module) => ({
    default: module.ServerTestModal,
  })),
);
const SavedPlaylistsDialog = lazy(() => import("./components/SavedPlaylistsDialog"));
const SavedPlaylistEditorDialog = lazy(
  () => import("./components/SavedPlaylistEditorDialog"),
);
import { AlertTriangle, ExternalLink, FolderOpen, Info, Loader2, X } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { detectPlatform } from "./lib/platform";
import { logger } from "./lib/logger";
import { HapticFeedbackPattern, PerformanceTime, triggerHaptic } from "./lib/haptics";
import { toPendingChannelResult } from "./lib/channelResults";
import { isScanActive } from "./lib/scanState";
import { isInputLikeTarget, isPrimaryModifierPressed } from "./lib/shortcuts";
import { recordUiPerf, startLongTaskObserver, uiPerfEnabled } from "./lib/perf";
import { shouldAutoRevealReportPanel } from "./lib/playlistReportVisibility";
import {
  applyContentVisibilityToPreview,
  applySourceFilterToPreview,
  hasDirtySourceFilter,
  normalizeSourceFilter,
  resolvePreservedGroupFilter,
  validateSourceFilterPattern,
} from "./lib/sourceFilter";
import {
  buildSavedPlaylistDraftFromSource,
  findSavedPlaylistForCurrentSource,
  savedPlaylistSecondaryLabel,
  savedEntryToSourceDescriptor,
} from "./lib/savedPlaylists";

function errorToString(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function formatPlaylistOpenError(err: unknown): string {
  const raw = errorToString(err).replace(/^error:\s*/i, "").trim();
  if (!raw || raw === "[object Object]") {
    return "Failed to open playlist. Please verify the file path and playlist format.";
  }
  return raw.toLowerCase().startsWith("failed to open playlist")
    ? raw
    : `Failed to open playlist: ${raw}`;
}

function formatSourceReloadError(err: unknown): string {
  const raw = errorToString(err).replace(/^error:\s*/i, "").trim();
  const normalized = raw.replace(/^failed to open playlist:\s*/i, "").trim();

  if (!normalized || normalized === "[object Object]") {
    return "Failed to reload source. Please verify the source settings and filter.";
  }

  return raw.toLowerCase().startsWith("failed to reload source")
    ? raw
    : `Failed to reload source: ${normalized}`;
}

async function restoreAndFocusWindow(window: {
  unminimize: () => Promise<void>;
  show: () => Promise<void>;
  setFocus: () => Promise<void>;
}): Promise<void> {
  await window.unminimize().catch(() => {});
  await window.show().catch(() => {});
  await window.setFocus();
}

function isPlaylistLikePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.endsWith(".m3u") || normalized.endsWith(".m3u8");
}

const UPDATE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const OS_PROGRESS_UPDATE_INTERVAL_MS = 2000;
const UPDATE_LAST_CHECK_KEY = "updates:last-check-epoch-ms";
const UPDATE_CACHE_KEY = "updates:last-available-release";
const START_SCREEN_RECENT_LIMIT = 5;
const TABLE_PROFILER_ROW_LIMIT = 50_000;
const GITHUB_LATEST_RELEASE_API =
  "https://api.github.com/repos/kristofferR/IPTVChecker/releases/latest";
const GITHUB_RELEASES_PAGE =
  "https://github.com/kristofferR/IPTVChecker/releases";

type SourceLoadMode = "freshOpen" | "reapplySourceFilter";

type LoadAndCommitSourceResult =
  | {
      ok: true;
      preview: PlaylistPreview;
    }
  | {
      ok: false;
      error: string;
    };

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function parseVersionParts(version: string): number[] {
  const numeric = normalizeVersion(version)
    .split(".")
    .map((part) => {
      const matched = part.match(/^\d+/);
      return matched ? Number.parseInt(matched[0], 10) : 0;
    });
  return numeric.length > 0 ? numeric : [0];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }

  return 0;
}

function readCachedUpdateNotice(): UpdateNotice | null {
  const raw = localStorage.getItem(UPDATE_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UpdateNotice;
    if (!parsed.latest_version || !parsed.release_url) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

function formatScanNotificationBody(stats: {
  alive: number;
  drm: number;
  dead: number;
  geoblocked: number;
  playlist_score?: { overall: number } | null;
}): string {
  const parts = [
    `Alive ${stats.alive}`,
    ...(stats.drm > 0 ? [`DRM ${stats.drm}`] : []),
    `Dead ${stats.dead}`,
    `Geoblocked ${stats.geoblocked}`,
  ];
  const base = parts.join(" | ");
  if (!stats.playlist_score) {
    return base;
  }
  return `${base} | Score ${stats.playlist_score.overall.toFixed(1)}/10`;
}

async function canSendNotifications(requiresPermission: boolean): Promise<boolean> {
  if (!requiresPermission) {
    return true;
  }

  try {
    if (await isPermissionGranted()) {
      return true;
    }
    const permission = await requestPermission();
    return permission === "granted";
  } catch {
    return false;
  }
}

function shouldSkipUpdateCheck(
  force: boolean,
  now: number,
  lastCheckedRaw: string | null,
): boolean {
  const lastChecked = lastCheckedRaw
    ? Number.parseInt(lastCheckedRaw, 10)
    : Number.NaN;
  return (
    !force &&
    Number.isFinite(lastChecked) &&
    now - lastChecked < UPDATE_CHECK_COOLDOWN_MS
  );
}

function serializeXtreamRecent(source: XtreamRecentSource): string {
  const obj: Record<string, string> = {
    server: source.server.trim(),
    username: source.username.trim(),
  };
  if (source.password) {
    obj.password = source.password;
  }
  return JSON.stringify(obj);
}

function parseXtreamRecent(value: string): XtreamRecentSource | null {
  try {
    const parsed = JSON.parse(value) as Partial<XtreamRecentSource>;
    const server = typeof parsed.server === "string" ? parsed.server.trim() : "";
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    if (!server || !username) {
      return null;
    }
    const password =
      typeof parsed.password === "string" && parsed.password
        ? parsed.password
        : undefined;
    return { server, username, password };
  } catch {
    return null;
  }
}

function recentValueLabel(entry: RecentPlaylistEntry): string {
  if (entry.kind === "file") {
    return `Path - ${entry.value}`;
  }
  if (entry.kind === "url") {
    return `URL - ${entry.value}`;
  }
  const source = parseXtreamRecent(entry.value);
  if (!source) {
    return "Xtream - Invalid source";
  }
  return `Xtream - ${source.server} (${source.username})`;
}

function recentTitle(entry: RecentPlaylistEntry): string {
  if (entry.kind !== "xtream") {
    return entry.value;
  }
  const source = parseXtreamRecent(entry.value);
  if (!source) {
    return entry.value;
  }
  return `${source.server} (${source.username})`;
}

function applyDisplayNameToPreview(
  preview: PlaylistPreview,
  displayName: string,
  savedPlaylistId?: string | null,
): PlaylistPreview {
  const uniquePlaylistLabels = new Set(
    preview.channels
      .map((channel) => channel.playlist.trim())
      .filter((value) => value.length > 0),
  );
  const shouldRewriteChannelPlaylists = uniquePlaylistLabels.size <= 1;

  return {
    ...preview,
    file_name: displayName,
    saved_playlist_id: savedPlaylistId ?? null,
    channels: shouldRewriteChannelPlaylists
      ? preview.channels.map((channel) => ({
          ...channel,
          playlist: displayName,
        }))
      : preview.channels,
  };
}

function buildVisiblePlaylistPreview(
  preview: PlaylistPreview,
  sourceFilter: string,
  hideVodContent: boolean,
): PlaylistPreview {
  return applyContentVisibilityToPreview(
    applySourceFilterToPreview(preview, sourceFilter),
    hideVodContent,
  );
}

function savedEntryToDraft(entry: SavedPlaylistEntry): SavedPlaylistDraft {
  switch (entry.kind) {
    case "file":
      return {
        id: entry.id,
        kind: "file",
        display_name: entry.display_name,
        path: entry.path,
      };
    case "url":
      return {
        id: entry.id,
        kind: "url",
        display_name: entry.display_name,
        url: entry.url,
      };
    case "xtream":
      return {
        id: entry.id,
        kind: "xtream",
        display_name: entry.display_name,
        servers: [...entry.servers],
        preferred_server: entry.preferred_server,
        username: entry.username,
        password: entry.password,
      };
  }
}

const selectLiveSelectedChannel = (state: AppStore): ChannelResult | null => {
  const selected = state.selectedChannel;
  return selected ? (state.results[selected.index] ?? selected) : null;
};

type StreamPlayerController = ReturnType<typeof useStreamPlayer>;

function ScanPauseBanners() {
  const scanState = useAppStore((s) => s.scanState);
  const screenshotsPaused = useAppStore((s) => s.screenshotsPaused);
  const networkPaused = useAppStore((s) => s.networkPaused);

  return (
    <>
      {screenshotsPaused && isScanActive(scanState) && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-[13px]">
          <span className="flex-1">Screenshot capture paused — low disk space</span>
        </div>
      )}

      {networkPaused && isScanActive(scanState) && (
        <div className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 border-b border-orange-500/20 text-orange-400 text-[13px]">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">Scan paused — network connectivity lost. Waiting for recovery...</span>
        </div>
      )}
    </>
  );
}

function SelectedChannelSidebar({
  sidebarWidth,
  onResizeStart,
  streamPlayer,
  chromecast,
  onPlayChannel,
  onScanChannel,
  onStopPlayer,
  onOpenExternal,
  onPip,
}: {
  sidebarWidth: number;
  onResizeStart: (event: React.MouseEvent) => void;
  streamPlayer: StreamPlayerController;
  chromecast: UseChromecastResult;
  onPlayChannel: (result: ChannelResult) => void;
  onScanChannel: (indices: number[]) => void;
  onStopPlayer: () => void;
  onOpenExternal: (result: ChannelResult) => void;
  onPip?: () => void;
}) {
  const liveSelectedChannel = useAppStore(selectLiveSelectedChannel);
  const playlist = useAppStore((s) => s.playlist);
  const scanState = useAppStore((s) => s.scanState);
  const lightboxOpen = useAppStore((s) => s.lightboxOpen);
  const screenshotsEnabled = useAppStore((s) => !s.settings.skip_screenshots);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotLoadError, setScreenshotLoadError] = useState(false);
  const screenshotPathRef = useRef<string | null>(null);
  const screenshotCacheRef = useRef(new Map<string, string>());

  useEffect(() => {
    screenshotCacheRef.current.clear();
  }, [playlist]);

  useEffect(() => {
    const path = liveSelectedChannel?.screenshot_path?.trim() || null;
    if (path === screenshotPathRef.current) return;
    screenshotPathRef.current = path;

    if (!path) {
      setScreenshotUrl(null);
      setScreenshotLoading(false);
      setScreenshotLoadError(false);
      return;
    }

    const cached = screenshotCacheRef.current.get(path);
    if (cached) {
      setScreenshotUrl(cached);
      setScreenshotLoading(false);
      setScreenshotLoadError(false);
      return;
    }

    let stale = false;
    setScreenshotLoading(true);
    setScreenshotLoadError(false);
    readScreenshot(path)
      .then((dataUrl) => {
        if (!stale) {
          screenshotCacheRef.current.set(path, dataUrl);
          setScreenshotUrl(dataUrl);
          setScreenshotLoading(false);
          setScreenshotLoadError(false);
        }
      })
      .catch(() => {
        if (!stale) {
          setScreenshotUrl(null);
          setScreenshotLoading(false);
          setScreenshotLoadError(true);
        }
      });
    return () => {
      stale = true;
    };
  }, [liveSelectedChannel?.screenshot_path]);

  if (!liveSelectedChannel) {
    return null;
  }

  return (
    <div
      className="relative border-r border-border-app bg-panel-muted shrink-0"
      style={{ width: `${sidebarWidth}px` }}
    >
      <div
        onMouseDown={onResizeStart}
        className="absolute right-0 top-0 bottom-0 w-1 translate-x-1/2 cursor-col-resize z-10 hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors"
      />
      <ThumbnailPanel
        result={liveSelectedChannel}
        screenshotUrl={screenshotUrl}
        screenshotLoading={screenshotLoading}
        screenshotLoadError={screenshotLoadError}
        screenshotsEnabled={screenshotsEnabled}
        scanState={scanState}
        lightboxOpen={lightboxOpen}
        onLightboxChange={(value) => getStore().setLightboxOpen(value)}
        onPlayChannel={onPlayChannel}
        onScanChannel={onScanChannel}
        chromecast={chromecast}
        isPlaying={streamPlayer.playerState !== "idle"}
        playerState={streamPlayer.playerState}
        errorMessage={streamPlayer.errorMessage}
        isPaused={streamPlayer.isPaused}
        isRecovering={streamPlayer.isRecovering}
        recoveryAttempt={streamPlayer.recoveryAttempt}
        recoveryMessage={streamPlayer.recoveryMessage}
        volume={streamPlayer.volume}
        muted={streamPlayer.muted}
        videoElement={streamPlayer.videoElement}
        onTogglePause={streamPlayer.togglePause}
        onStopPlayer={onStopPlayer}
        onSetVolume={streamPlayer.setVolume}
        onToggleMute={streamPlayer.toggleMute}
        onOpenExternal={onOpenExternal}
        onRetryPlay={(result) => streamPlayer.play(result)}
        onPip={document.pictureInPictureEnabled ? onPip : undefined}
      />
    </div>
  );
}

function ScanRuntimeEffects({
  refreshHistory,
  reportAutoRevealBlockedRef,
  reportAutoRevealDoneRef,
  reportWasAutoShownRef,
}: {
  refreshHistory: () => Promise<void>;
  reportAutoRevealBlockedRef: { current: boolean };
  reportAutoRevealDoneRef: { current: boolean };
  reportWasAutoShownRef: { current: boolean };
}) {
  const playlist = useAppStore((s) => s.playlist);
  const progress = useAppStore((s) => s.progress);
  const summary = useAppStore((s) => s.summary);
  const scanState = useAppStore((s) => s.scanState);
  const isMac = useAppStore((s) => s.isMac);
  const networkPaused = useAppStore((s) => s.networkPaused);
  const scanNotifications = useAppStore((s) => s.settings.scan_notifications);
  const reportAutoReveal = useAppStore((s) => s.settings.report_auto_reveal);
  const showReportPanel = useAppStore((s) => s.showReportPanel);
  const previousScanStateRef = useRef(scanState);
  const reportAutoRevealPreviousScanStateRef = useRef(scanState);
  const osProgressTimerRef = useRef<number | null>(null);
  const lastOsProgressUpdateMsRef = useRef(0);

  useEffect(() => {
    reportAutoRevealBlockedRef.current = false;
    reportAutoRevealDoneRef.current = false;
    reportWasAutoShownRef.current = false;
    getStore().setShowReportPanel(false);
  }, [playlist, reportAutoRevealBlockedRef, reportAutoRevealDoneRef, reportWasAutoShownRef]);

  useEffect(() => {
    const previous = reportAutoRevealPreviousScanStateRef.current;
    const scanJustStarted =
      scanState === "scanning" &&
      !isScanActive(previous);

    if (scanJustStarted) {
      reportAutoRevealBlockedRef.current = false;
      reportAutoRevealDoneRef.current = false;
      if (reportWasAutoShownRef.current && showReportPanel) {
        getStore().setShowReportPanel(false);
      }
      reportWasAutoShownRef.current = false;
    }

    reportAutoRevealPreviousScanStateRef.current = scanState;
  }, [
    reportAutoRevealBlockedRef,
    reportAutoRevealDoneRef,
    reportWasAutoShownRef,
    scanState,
    showReportPanel,
  ]);

  useEffect(() => {
    if (!playlist || showReportPanel) {
      return;
    }
    if (!reportAutoReveal) {
      return;
    }
    if (reportAutoRevealBlockedRef.current || reportAutoRevealDoneRef.current) {
      return;
    }

    const active =
      scanState === "scanning" ||
      scanState === "paused" ||
      scanState === "complete";
    if (!active) {
      return;
    }
    if (!shouldAutoRevealReportPanel(progress, playlist.total_channels)) {
      return;
    }

    reportAutoRevealDoneRef.current = true;
    reportWasAutoShownRef.current = true;
    getStore().setShowReportPanel(true);
  }, [
    playlist,
    progress,
    reportAutoReveal,
    reportAutoRevealBlockedRef,
    reportAutoRevealDoneRef,
    reportWasAutoShownRef,
    scanState,
    showReportPanel,
  ]);

  useEffect(() => {
    const previousScanState = previousScanStateRef.current;
    previousScanStateRef.current = scanState;
    const justFinished = isScanActive(previousScanState);

    if (scanState === "complete" && playlist) {
      void refreshHistory();
    }

    if (!justFinished) return;

    if (scanState === "complete") {
      void triggerHaptic(
        HapticFeedbackPattern.Generic,
        PerformanceTime.DrawCompleted,
      );
    }

    if (!scanNotifications || !summary) return;
    if (scanState !== "complete" && scanState !== "cancelled") return;

    const title = scanState === "complete" ? "Scan complete" : "Scan cancelled";
    const playlistPrefix = playlist ? `${playlist.file_name} | ` : "";
    const body = `${playlistPrefix}${formatScanNotificationBody(summary)}`;

    void (async () => {
      if (!(await canSendNotifications(isMac))) return;

      try {
        sendNotification({
          title,
          body,
          autoCancel: true,
        });
      } catch (error) {
        logger.warn("Failed to send scan notification", error);
      }
    })();
  }, [scanNotifications, scanState, summary, playlist, refreshHistory, isMac]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const clearScheduledUpdate = () => {
      if (osProgressTimerRef.current !== null) {
        window.clearTimeout(osProgressTimerRef.current);
        osProgressTimerRef.current = null;
      }
    };

    const applyNativeProgressIndicators = () => {
      const progressPercent =
        progress && progress.total > 0
          ? Math.min(100, Math.max(0, (progress.completed / progress.total) * 100))
          : 0;
      const status =
        networkPaused
          ? ProgressBarStatus.Error
          : scanState === "paused"
            ? ProgressBarStatus.Paused
            : progress
              ? ProgressBarStatus.Normal
              : ProgressBarStatus.Indeterminate;

      void appWindow
        .setProgressBar({
          status,
          progress: progressPercent,
        })
        .catch(() => {});

      if (isMac) {
        const badgeLabel = progress
          ? `${progress.alive + progress.drm}/${progress.dead}`
          : "...";
        void appWindow.setBadgeLabel(badgeLabel).catch(() => {});
      }
    };

    const clearNativeProgressIndicators = () => {
      clearScheduledUpdate();
      lastOsProgressUpdateMsRef.current = 0;

      void appWindow
        .setProgressBar({
          status: ProgressBarStatus.None,
        })
        .catch(() => {});

      if (isMac) {
        void appWindow.setBadgeLabel(undefined).catch(() => {});
      }
    };

    if (isScanActive(scanState)) {
      const now = Date.now();
      const elapsed = now - lastOsProgressUpdateMsRef.current;
      const shouldUpdateNow =
        lastOsProgressUpdateMsRef.current === 0 ||
        elapsed >= OS_PROGRESS_UPDATE_INTERVAL_MS;

      clearScheduledUpdate();
      if (shouldUpdateNow) {
        lastOsProgressUpdateMsRef.current = now;
        applyNativeProgressIndicators();
      } else {
        osProgressTimerRef.current = window.setTimeout(() => {
          lastOsProgressUpdateMsRef.current = Date.now();
          osProgressTimerRef.current = null;
          applyNativeProgressIndicators();
        }, OS_PROGRESS_UPDATE_INTERVAL_MS - elapsed);
      }

      return clearScheduledUpdate;
    }

    clearNativeProgressIndicators();
    return clearScheduledUpdate;
  }, [scanState, progress, isMac, networkPaused]);

  return null;
}

/** Resolve concurrency for a scan.
 *  0 = auto: 10 for multi-server, xtream max for xtream, 1 for single-server.
 *  1-20 = explicit user choice (but still capped at xtream max if applicable). */
function resolveSmartConcurrency(
  settingsConcurrency: number,
  singleProvider: boolean,
  xtreamMaxConnections: number | null,
): number {
  const auto = settingsConcurrency === 0;
  const clampedSettings = Math.max(1, Math.min(20, Math.round(settingsConcurrency)));

  if (
    xtreamMaxConnections != null &&
    Number.isFinite(xtreamMaxConnections) &&
    xtreamMaxConnections > 0
  ) {
    const xtreamMax = Math.max(1, Math.min(20, Math.round(xtreamMaxConnections)));
    if (auto) return xtreamMax;
    return Math.min(clampedSettings, xtreamMax);
  }

  if (auto) {
    return singleProvider ? 1 : 10;
  }

  return clampedSettings;
}

export default function App() {
  // Individual selectors — only re-render when the specific value changes
  const playlist = useAppStore((s) => s.playlist);
  const playlistLoading = useAppStore((s) => s.playlistLoading);
  const playlistLoadProgress = useAppStore((s) => s.playlistLoadProgress);
  const playlistOpenError = useAppStore((s) => s.playlistOpenError);
  const recentPlaylists = useAppStore((s) => s.recentPlaylists);
  const savedPlaylists = useAppStore((s) => s.savedPlaylists);
  const channelSearch = useAppStore((s) => s.channelSearch);
  const platform = useAppStore((s) => s.platform);
  const isMac = useAppStore((s) => s.isMac);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const showReportPanel = useAppStore((s) => s.showReportPanel);
  const reportSidebarWidth = useAppStore((s) => s.reportSidebarWidth);
  const lightboxOpen = useAppStore((s) => s.lightboxOpen);
  const showKeyboardShortcuts = useAppStore((s) => s.showKeyboardShortcuts);
  const isDragOver = useAppStore((s) => s.isDragOver);
  const ffmpegWarning = useAppStore((s) => s.ffmpegWarning);
  const errorDismissed = useAppStore((s) => s.errorDismissed);
  const playbackError = useAppStore((s) => s.playbackError);
  const scanInputError = useAppStore((s) => s.scanInputError);
  const menuInfo = useAppStore((s) => s.menuInfo);
  const updateNotice = useAppStore((s) => s.updateNotice);
  const appVersion = useAppStore((s) => s.appVersion);
  const openSourceDialogState = useAppStore((s) => s.openSourceDialogState);
  const pendingPlaybackChannel = useAppStore((s) => s.pendingPlaybackChannel);
  const liveSelectedChannel = useAppStore(selectLiveSelectedChannel);
  const scanError = useAppStore((s) => s.scanError);
  const showHistory = useAppStore((s) => s.showHistory);
  const historyEntries = useAppStore((s) => s.historyEntries);
  const historyLoading = useAppStore((s) => s.historyLoading);
  const historyError = useAppStore((s) => s.historyError);
  const historyClearing = useAppStore((s) => s.historyClearing);
  const settingsHydrated = useAppStore((s) => s.settingsHydrated);
  const hideVodContent = useAppStore((s) => s.settings.hide_vod_content);
  const modKey = isMac ? "Cmd" : "Ctrl";
  const [savedPlaylistsDialogOpen, setSavedPlaylistsDialogOpen] = useState(false);
  const [savedPlaylistEditorDraft, setSavedPlaylistEditorDraft] =
    useState<SavedPlaylistDraft | null>(null);
  const [savedXtreamTestEntry, setSavedXtreamTestEntry] =
    useState<SavedPlaylistEntry | null>(null);

  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const reportSidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handlePlaybackFailedRef = useRef<((result: ChannelResult) => void) | undefined>(undefined);
  const streamPlayer = useStreamPlayer({
    onPlaybackFailed: (result) => handlePlaybackFailedRef.current?.(result),
  });
  const {
    activeChannelIndex: playbackChannelIndex,
    play: playStream,
    stop: stopStream,
    videoElement: playbackVideoElement,
  } = streamPlayer;

  const baseChromecast = useChromecast();
  // mDNS discovery is best-effort; the device list can drop a device between
  // scans even while a cast is live. Stash the device every time we cast so
  // redirect attempts can fall back to it instead of giving up.
  const lastCastDeviceRef = useRef<ChromecastDevice | null>(null);
  const baseCastFn = baseChromecast.cast;
  const wrappedCast = useCallback<UseChromecastResult["cast"]>(
    async (device, request) => {
      lastCastDeviceRef.current = device;
      await baseCastFn(device, request);
    },
    [baseCastFn],
  );
  const chromecast = useMemo<UseChromecastResult>(
    () => ({ ...baseChromecast, cast: wrappedCast }),
    [baseChromecast, wrappedCast],
  );
  const chromecastRef = useRef(chromecast);
  useEffect(() => {
    chromecastRef.current = chromecast;
  }, [chromecast]);
  const castSession = chromecast.session;
  const isCasting = isCastSessionActive(castSession);

  const { settings, save: saveSettings, applyExternal: applyExternalSettings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const saveSettingsRef = useRef(saveSettings);
  saveSettingsRef.current = saveSettings;
  const {
    start,
    cancel,
    pause,
    resume,
    initFromPlaylist,
    syncFromPlaylist,
    updateResult,
  } = useScan();
  const channelSearchError = useMemo(
    () => validateSourceFilterPattern(channelSearch),
    [channelSearch],
  );
  const reportAutoRevealBlockedRef = useRef(false);
  const reportAutoRevealDoneRef = useRef(false);
  const reportWasAutoShownRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.platform = platform;
    if (platform !== "macos") return;

    let cancelled = false;
    const applyLiquidGlass = (attempt = 0) => {
      setLiquidGlassEffect({}).catch(() => {
        if (cancelled || attempt >= 5) return;
        window.setTimeout(() => applyLiquidGlass(attempt + 1), 120 * (attempt + 1));
      });
    };

    applyLiquidGlass();
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    const title = playlist ? `${playlist.file_name} | IPTV Checker` : "IPTV Checker";
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [playlist]);

  // Detect platform via native plugin and refresh the initial fallback.
  useEffect(() => {
    detectPlatform()
      .then((p) => {
        getStore().setPlatform(p);
      })
      .catch(() => {
        // Keep navigator-based fallback when plugin-os isn't available yet.
      });
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("no-transitions");
    document.documentElement.dataset.theme = settings.theme;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }, [settings.theme]);

  // Sync settings changes from the settings window
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<AppSettings>("settings-changed", (event) => {
      applyExternalSettings(event.payload);
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => off?.();
  }, [applyExternalSettings]);

  useEffect(() => {
    startLongTaskObserver();
  }, []);

  // Check ffmpeg on mount
  useEffect(() => {
    checkFfmpegAvailable().then(([ffmpeg, ffprobe]) => {
      if (!ffmpeg || !ffprobe) {
        getStore().setFfmpegWarning(true);
      }
    });
  }, []);

  // Auto-dismiss error banner after 10 seconds
  useEffect(() => {
    if (scanError) {
      getStore().setErrorDismissed(false);
      const timer = setTimeout(() => getStore().setErrorDismissed(true), 10000);
      return () => clearTimeout(timer);
    }
  }, [scanError]);

  useEffect(() => {
    if (!playbackError) return;
    const timer = setTimeout(() => getStore().setPlaybackError(null), 10000);
    return () => clearTimeout(timer);
  }, [playbackError]);

  useEffect(() => {
    if (!playlistOpenError) return;
    const timer = setTimeout(() => getStore().setPlaylistOpenError(null), 10000);
    return () => clearTimeout(timer);
  }, [playlistOpenError]);

  useEffect(() => {
    if (!scanInputError) return;
    const timer = setTimeout(() => getStore().setScanInputError(null), 8000);
    return () => clearTimeout(timer);
  }, [scanInputError]);

  useEffect(() => {
    if (!channelSearchError) {
      getStore().setScanInputError(null);
    }
  }, [channelSearchError]);

  useEffect(() => {
    if (!menuInfo) return;
    const timer = setTimeout(() => getStore().setMenuInfo(null), 8000);
    return () => clearTimeout(timer);
  }, [menuInfo]);

  const refreshRecentPlaylists = useCallback(async () => {
    try {
      const entries = await getRecentPlaylists();
      getStore().setRecentPlaylists(entries);
    } catch {
      // Ignore recent-list load failures.
    }
  }, []);

  const refreshSavedPlaylists = useCallback(async (): Promise<SavedPlaylistEntry[]> => {
    try {
      const entries = await getSavedPlaylists();
      getStore().setSavedPlaylists(entries);
      return entries;
    } catch {
      return [];
    }
  }, []);

  const handleClearRecentPlaylists = useCallback(async () => {
    try {
      const entries = await clearRecentPlaylists();
      getStore().setRecentPlaylists(entries);
    } catch {
      // Ignore clear failures.
    }
  }, []);

  useEffect(() => {
    void refreshRecentPlaylists();
  }, [refreshRecentPlaylists]);

  useEffect(() => {
    void refreshSavedPlaylists();
  }, [refreshSavedPlaylists]);

  const checkForUpdates = useCallback(
    async (force: boolean, knownCurrentVersion?: string) => {
      const now = Date.now();
      const lastCheckedRaw = localStorage.getItem(UPDATE_LAST_CHECK_KEY);
      if (shouldSkipUpdateCheck(force, now, lastCheckedRaw)) {
        return;
      }

      try {
        const currentVersion = normalizeVersion(
          knownCurrentVersion ?? (await getVersion()),
        );
        getStore().setAppVersion(currentVersion);

        const response = await fetch(GITHUB_LATEST_RELEASE_API, {
          headers: {
            Accept: "application/vnd.github+json",
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const release = (await response.json()) as {
          tag_name?: string;
          html_url?: string;
        };

        const latestVersion = normalizeVersion(release.tag_name ?? "");
        if (!latestVersion) {
          throw new Error("Latest release version is missing");
        }

        localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(now));

        if (compareVersions(latestVersion, currentVersion) > 0) {
          const notice: UpdateNotice = {
            latest_version: latestVersion,
            release_url: release.html_url || GITHUB_RELEASES_PAGE,
            checked_at_epoch_ms: now,
          };
          getStore().setUpdateNotice(notice);
          localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(notice));
          return;
        }

        getStore().setUpdateNotice(null);
        localStorage.removeItem(UPDATE_CACHE_KEY);
        if (force) {
          getStore().setMenuInfo(`You're up to date (v${currentVersion}).`);
        }
      } catch (err) {
        if (force) {
          getStore().setMenuInfo(`Update check failed: ${errorToString(err)}`);
        }
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const runInitialUpdateCheck = async () => {
      let currentVersion = "";
      try {
        currentVersion = normalizeVersion(await getVersion());
        if (!cancelled) {
          getStore().setAppVersion(currentVersion);
        }
      } catch {
        currentVersion = "";
      }

      if (cancelled) return;

      const cachedNotice = readCachedUpdateNotice();
      if (
        cachedNotice &&
        currentVersion &&
        compareVersions(cachedNotice.latest_version, currentVersion) > 0
      ) {
        getStore().setUpdateNotice(cachedNotice);
      } else if (cachedNotice) {
        localStorage.removeItem(UPDATE_CACHE_KEY);
      }

      await checkForUpdates(false, currentVersion || undefined);
    };

    void runInitialUpdateCheck();
    return () => {
      cancelled = true;
    };
  }, [checkForUpdates]);

  const commitLoadedPlaylist = useCallback(
    async (
      preview: PlaylistPreview,
      cachedPreview: PlaylistPreview,
      descriptor: CurrentSourceDescriptor,
      mode: SourceLoadMode,
      appliedSourceFilter: string,
    ) => {
      const state = getStore();
      state.setPlaylist(preview);
      state.setCachedSourcePreview(cachedPreview);
      state.setCurrentSourceDescriptor(descriptor);
      state.setLastAppliedSourceFilter(appliedSourceFilter);
      state.setPlaylistOpenError(null);

      if (mode === "freshOpen") {
        state.setSearch("");
        state.setGroupFilter("all");
        state.setStatusFilter("all");
        state.setShowHistory(false);
      } else {
        state.setGroupFilter(
          resolvePreservedGroupFilter(state.groupFilter, preview.groups),
        );
      }

      state.setSelectedChannel(null);
      state.setSelectedChannelIndices([]);
      state.setPendingPlaybackChannel(null);

      const initStartedAt = performance.now();
      logger.info(
        `[App] Preparing scan cache for ${preview.channels.length} visible channels`,
      );
      await initFromPlaylist(preview.channels);
      logger.info(
        `[App] Scan cache ready in ${(performance.now() - initStartedAt).toFixed(1)}ms`,
      );
    },
    [initFromPlaylist],
  );

  const loadFullSourcePreview = useCallback(
    async (descriptor: CurrentSourceDescriptor): Promise<PlaylistPreview> => {
      switch (descriptor.kind) {
        case "path":
          return openPlaylist(descriptor.path, undefined, undefined);
        case "url":
          return openPlaylistUrl(descriptor.url, undefined, undefined);
        case "saved":
          return openSavedPlaylist(descriptor.id, undefined, undefined);
        case "xtream":
          return openPlaylistXtream(
            {
              server: descriptor.server,
              username: descriptor.username,
              password: descriptor.password,
            },
            undefined,
            undefined,
          );
        case "stalker":
          return openPlaylistStalker(
            {
              portal: descriptor.portal,
              mac: descriptor.mac,
            },
            undefined,
            undefined,
          );
      }
    },
    [],
  );

  const buildVisiblePreview = useCallback(
    (preview: PlaylistPreview, sourceFilter: string) =>
      buildVisiblePlaylistPreview(preview, sourceFilter, hideVodContent),
    [hideVodContent],
  );

  const loadAndCommitSource = useCallback(
    async (
      descriptor: CurrentSourceDescriptor,
      mode: SourceLoadMode,
    ): Promise<LoadAndCommitSourceResult> => {
      const normalizedSourceFilter = normalizeSourceFilter(channelSearch);
      const currentSourceFilterError = validateSourceFilterPattern(
        normalizedSourceFilter,
      );
      if (currentSourceFilterError) {
        const error =
          mode === "reapplySourceFilter"
            ? formatSourceReloadError(currentSourceFilterError)
            : formatPlaylistOpenError(currentSourceFilterError);
        getStore().setPlaylistOpenError(error);
        return { ok: false, error };
      }

      const sourceLabel = (() => {
        switch (descriptor.kind) {
          case "path":
            return `path=${descriptor.path}`;
          case "url":
            return `url=${descriptor.url}`;
          case "saved":
            return `saved id=${descriptor.id}`;
          case "xtream":
            return `xtream server=${descriptor.server}, username=${descriptor.username}`;
          case "stalker":
            return `stalker portal=${descriptor.portal}, mac=${descriptor.mac}`;
        }
      })();
      const loadingAction =
        mode === "reapplySourceFilter"
          ? "Reloading source with source filter"
          : "Opening source";

      getStore().setPlaylistOpenError(null);
      getStore().setPlaylistLoadProgress(null);
      getStore().setPlaylistLoading(true);
      const safeLabel = sourceLabel.replace(/username=\S+/g, "username=***").replace(/password=\S+/g, "password=***");
      logger.info(`[App] ${loadingAction}: ${safeLabel}`);

      try {
        const state = getStore();
        const canReuseCachedPreview =
          mode === "reapplySourceFilter" && state.cachedSourcePreview != null;

        const cachedPreview = canReuseCachedPreview
          ? state.cachedSourcePreview!
          : await loadFullSourcePreview(descriptor);
        if (!canReuseCachedPreview) {
          logger.debug(
            `[App] ${loadingAction}: ${sourceLabel}, channelSearch="${normalizedSourceFilter}"`,
          );
          logger.debug(
            `[App] Source loaded: ${cachedPreview.file_name}, channels=${cachedPreview.total_channels}, groups=${cachedPreview.groups.length}`,
            cachedPreview.groups,
          );
        } else {
          logger.debug(
            `[App] ${loadingAction} from cached preview: ${sourceLabel}, channelSearch="${normalizedSourceFilter}", cachedChannels=${cachedPreview.total_channels}`,
          );
        }

        const preview = buildVisiblePreview(cachedPreview, normalizedSourceFilter);
        await commitLoadedPlaylist(
          preview,
          cachedPreview,
          descriptor,
          mode,
          normalizedSourceFilter,
        );
        return { ok: true, preview };
      } catch (err) {
        logger.error(
          mode === "reapplySourceFilter"
            ? "[App] Failed to reload source with source filter"
            : "[App] Failed to open source",
          err,
        );
        const message =
          mode === "reapplySourceFilter"
            ? formatSourceReloadError(err)
            : formatPlaylistOpenError(err);
        getStore().setPlaylistOpenError(message);

        if (mode === "freshOpen") {
          // Keep app interaction predictable after a failed fresh open attempt.
          getStore().setSelectedChannel(null);
          getStore().setSelectedChannelIndices([]);
          getStore().setPendingPlaybackChannel(null);
          getStore().setShowHistory(false);
          void refreshRecentPlaylists();
        }

        return { ok: false, error: message };
      } finally {
        getStore().setPlaylistLoading(false);
        getStore().setPlaylistLoadProgress(null);
      }
    },
    [
      buildVisiblePreview,
      channelSearch,
      commitLoadedPlaylist,
      loadFullSourcePreview,
      refreshRecentPlaylists,
    ],
  );

  const previousHideVodContentRef = useRef(hideVodContent);

  useEffect(() => {
    if (!settingsHydrated) {
      previousHideVodContentRef.current = hideVodContent;
      return;
    }

    if (previousHideVodContentRef.current === hideVodContent) {
      return;
    }
    previousHideVodContentRef.current = hideVodContent;

    const state = getStore();
    if (!state.cachedSourcePreview) {
      return;
    }

    const nextPreview = buildVisiblePreview(
      state.cachedSourcePreview,
      state.lastAppliedSourceFilter,
    );
    const visibleIndices = new Set(
      nextPreview.channels.map((channel) => channel.index),
    );
    const selectedIndex = state.selectedChannel?.index ?? null;
    const pendingPlaybackIndex = state.pendingPlaybackChannel?.index ?? null;
    const nextSelectedIndices = state.selectedChannelIndices.filter((index) =>
      visibleIndices.has(index),
    );

    state.setPlaylist(nextPreview);
    state.setGroupFilter(
      resolvePreservedGroupFilter(state.groupFilter, nextPreview.groups),
    );
    state.setSelectedChannelIndices(nextSelectedIndices);

    if (selectedIndex == null || !visibleIndices.has(selectedIndex)) {
      state.setSelectedChannel(null);
    }
    if (pendingPlaybackIndex == null || !visibleIndices.has(pendingPlaybackIndex)) {
      state.setPendingPlaybackChannel(null);
    }

    void syncFromPlaylist(nextPreview.channels, true).then(() => {
      if (selectedIndex == null || !visibleIndices.has(selectedIndex)) {
        return;
      }

      const refreshed = getStore().results[selectedIndex];
      if (refreshed) {
        getStore().setSelectedChannel(refreshed);
      }
    });
  }, [
    buildVisiblePreview,
    hideVodContent,
    settingsHydrated,
    syncFromPlaylist,
  ]);

  const patchCurrentPlaylistMetadata = useCallback(
    (displayName: string, savedPlaylistId?: string | null) => {
      const state = getStore();
      if (state.playlist) {
        state.setPlaylist(
          applyDisplayNameToPreview(state.playlist, displayName, savedPlaylistId),
        );
      }
      if (state.cachedSourcePreview) {
        state.setCachedSourcePreview(
          applyDisplayNameToPreview(
            state.cachedSourcePreview,
            displayName,
            savedPlaylistId,
          ),
        );
      }
    },
    [],
  );

  const openSavedPlaylistById = useCallback(
    async (id: string): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "saved",
          id,
        },
        "freshOpen",
      );
      if (!result.ok) {
        return result.error;
      }

      const nextSaved = await refreshSavedPlaylists();
      const savedEntry = nextSaved.find((entry) => entry.id === id);
      if (!savedEntry) {
        void refreshRecentPlaylists();
        return true;
      }

      try {
        const recentPayload =
          savedEntry.kind === "file"
            ? {
                kind: "file" as const,
                value: savedEntry.path,
              }
            : savedEntry.kind === "url"
              ? {
                  kind: "url" as const,
                  value: savedEntry.url,
                }
              : {
                  kind: "xtream" as const,
                  value: serializeXtreamRecent({
                    server:
                      savedEntry.preferred_server ?? savedEntry.servers[0] ?? "",
                    username: savedEntry.username,
                    password: savedEntry.password ?? undefined,
                  }),
                };

        const entries = await addRecentPlaylist(
          recentPayload.kind,
          recentPayload.value,
          savedEntry.display_name,
          savedEntry.id,
        );
        getStore().setRecentPlaylists(entries);
      } catch {
        // Ignore recent-list update failures.
      }

      return true;
    },
    [loadAndCommitSource, refreshRecentPlaylists, refreshSavedPlaylists],
  );

  const openPlaylistPath = useCallback(async (selectedPath: string) => {
    const result = await loadAndCommitSource(
      {
        kind: "path",
        path: selectedPath,
      },
      "freshOpen",
    );
    if (!result.ok) {
      return;
    }

    try {
      const entries = await addRecentPlaylist("file", selectedPath, null, null);
      getStore().setRecentPlaylists(entries);
    } catch {
      // Ignore recent-list update failures.
    }
  }, [loadAndCommitSource]);

  const handleOpen = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [
        { name: "M3U Playlists", extensions: ["m3u", "m3u8"] },
      ],
      directory: false,
    });
    if (!path) return;

    const selectedPath = Array.isArray(path) ? path[0] : path;
    if (!selectedPath) return;

    await openPlaylistPath(selectedPath);
  }, [openPlaylistPath]);

  const handleOpenFolder = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: true,
    });
    if (!path) return;

    const selectedPath = Array.isArray(path) ? path[0] : path;
    if (!selectedPath) return;

    await openPlaylistPath(selectedPath);
  }, [openPlaylistPath]);

  const openPlaylistUrlValue = useCallback(async (url: string): Promise<string | true> => {
    const result = await loadAndCommitSource(
      {
        kind: "url",
        url,
      },
      "freshOpen",
    );
    if (!result.ok) {
      return result.error;
    }

    try {
      const entries = await addRecentPlaylist("url", url, null, null);
      getStore().setRecentPlaylists(entries);
    } catch {
      // Ignore recent-list update failures.
    }

    return true;
  }, [loadAndCommitSource]);

  const openPlaylistXtreamValue = useCallback(
    async (source: XtreamOpenRequest, savePassword?: boolean): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "xtream",
          server: source.server,
          username: source.username,
          password: source.password,
        },
        "freshOpen",
      );
      if (!result.ok) {
        return result.error;
      }

      if (
        typeof result.preview.xtream_max_connections === "number" &&
        Number.isFinite(result.preview.xtream_max_connections) &&
        result.preview.xtream_max_connections > 0
      ) {
        const effectiveConcurrency = Math.max(
          1,
          Math.min(20, Math.round(result.preview.xtream_max_connections)),
        );
        getStore().setMenuInfo(
          `Xtream max connections detected: ${result.preview.xtream_max_connections}. Scan concurrency will use ${effectiveConcurrency}.`,
        );
      }

      try {
        const entries = await addRecentPlaylist(
          "xtream",
          serializeXtreamRecent({
            server: source.server,
            username: source.username,
            password: savePassword ? source.password : undefined,
          }),
          null,
          null,
        );
        getStore().setRecentPlaylists(entries);
      } catch {
        // Ignore recent-list update failures.
      }

      return true;
    },
    [loadAndCommitSource],
  );

  const openPlaylistStalkerValue = useCallback(
    async (source: StalkerOpenRequest): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "stalker",
          portal: source.portal,
          mac: source.mac,
        },
        "freshOpen",
      );
      return result.ok ? true : result.error;
    },
    [loadAndCommitSource],
  );

  const handleOpenSaved = useCallback((id: string) => {
    void openSavedPlaylistById(id);
  }, [openSavedPlaylistById]);

  const handleManageSavedPlaylists = useCallback(() => {
    setSavedPlaylistsDialogOpen(true);
  }, []);

  const handleSaveCurrentPlaylist = useCallback(() => {
    const state = getStore();
    const currentPlaylist = state.playlist;
    const descriptor = state.currentSourceDescriptor;
    const existing = findSavedPlaylistForCurrentSource(
      state.savedPlaylists,
      descriptor,
      currentPlaylist?.saved_playlist_id,
    );

    if (existing) {
      setSavedPlaylistEditorDraft(savedEntryToDraft(existing));
      return;
    }

    const draft = buildSavedPlaylistDraftFromSource(
      descriptor,
      currentPlaylist?.file_name ?? "",
      null,
    );
    if (!draft) {
      state.setMenuInfo("Open a file, URL, or Xtream source first.");
      return;
    }
    setSavedPlaylistEditorDraft(draft);
  }, []);

  const handleSavePlaylistDraft = useCallback(
    async (draft: SavedPlaylistDraft) => {
      const result = await upsertSavedPlaylist(draft);
      getStore().setSavedPlaylists(result.entries);
      setSavedPlaylistEditorDraft(null);
      void refreshRecentPlaylists();

      const state = getStore();
      const currentPlaylist = state.playlist;
      const currentSaved = currentPlaylist?.saved_playlist_id ?? null;
      const currentMatch = findSavedPlaylistForCurrentSource(
        result.entries,
        state.currentSourceDescriptor,
        currentSaved,
      );
      if (currentMatch && currentMatch.id === result.entry.id) {
        await openSavedPlaylistById(result.entry.id);
      }
    },
    [openSavedPlaylistById, refreshRecentPlaylists],
  );

  const handleDeleteSavedPlaylistById = useCallback(
    async (id: string) => {
      const confirmed = window.confirm("Delete this saved playlist?");
      if (!confirmed) {
        return;
      }

      try {
        const currentState = getStore();
        const deletedEntry =
          currentState.savedPlaylists.find((entry) => entry.id === id) ?? null;
        const fallbackDescriptor = deletedEntry
          ? savedEntryToSourceDescriptor(deletedEntry)
          : null;
        const entries = await deleteSavedPlaylist(id);
        getStore().setSavedPlaylists(entries);
        void refreshRecentPlaylists();

        const state = getStore();
        if (state.playlist?.saved_playlist_id === id) {
          state.setCurrentSourceDescriptor(fallbackDescriptor);
          patchCurrentPlaylistMetadata(state.playlist.file_name, null);
        }
      } catch (err) {
        getStore().setMenuInfo(errorToString(err));
      }
    },
    [patchCurrentPlaylistMetadata, refreshRecentPlaylists],
  );

  const handlePreferSavedXtreamServer = useCallback(
    async (entry: SavedPlaylistEntry, server: string) => {
      if (entry.kind !== "xtream") {
        return;
      }
      try {
        const result = await upsertSavedPlaylist({
          id: entry.id,
          kind: "xtream",
          display_name: entry.display_name,
          servers: [...entry.servers],
          preferred_server: server,
          username: entry.username,
          password: entry.password,
        });
        getStore().setSavedPlaylists(result.entries);
        setSavedXtreamTestEntry(null);

        const state = getStore();
        if (state.playlist?.saved_playlist_id === entry.id) {
          await openSavedPlaylistById(entry.id);
        }
      } catch (err) {
        getStore().setMenuInfo(errorToString(err));
      }
    },
    [openSavedPlaylistById],
  );

  const ensureSourceFilterApplied = useCallback(async () => {
    const state = getStore();
    if (
      !hasDirtySourceFilter(
        state.channelSearch,
        state.lastAppliedSourceFilter,
        state.currentSourceDescriptor,
      )
    ) {
      return { ok: true, reapplied: false };
    }

    if (!state.currentSourceDescriptor) {
      return { ok: true, reapplied: false };
    }

    const result = await loadAndCommitSource(
      state.currentSourceDescriptor,
      "reapplySourceFilter",
    );
    return { ok: result.ok, reapplied: result.ok };
  }, [loadAndCommitSource]);

  const handleApplySourceFilter = useCallback(() => {
    const state = getStore();
    if (!state.currentSourceDescriptor) {
      return;
    }
    if (
      !hasDirtySourceFilter(
        state.channelSearch,
        state.lastAppliedSourceFilter,
        state.currentSourceDescriptor,
      )
    ) {
      return;
    }
    void loadAndCommitSource(state.currentSourceDescriptor, "reapplySourceFilter");
  }, [loadAndCommitSource]);

  const openSourceDialog = useCallback((state: OpenSourceDialogState) => {
    getStore().setOpenSourceDialogState(state);
  }, []);

  const handleOpenUrl = useCallback(() => {
    openSourceDialog({
      mode: "url",
      initialUrl: "",
      initialXtream: null,
      initialStalker: null,
    });
  }, [openSourceDialog]);

  const handleOpenXtream = useCallback(() => {
    openSourceDialog({
      mode: "xtream",
      initialUrl: "",
      initialXtream: null,
      initialStalker: null,
    });
  }, [openSourceDialog]);

  const refreshHistory = useCallback(async () => {
    if (!playlist) {
      getStore().setHistoryEntries([]);
      getStore().setHistoryError(null);
      return;
    }

    getStore().setHistoryLoading(true);
    getStore().setHistoryError(null);
    try {
      const items = await getScanHistory(
        playlist.file_path,
        playlist.source_identity,
      );
      getStore().setHistoryEntries(items);
    } catch (err) {
      getStore().setHistoryError(errorToString(err));
    } finally {
      getStore().setHistoryLoading(false);
    }
  }, [playlist]);

  const handleClearHistory = useCallback(async () => {
    if (!playlist) return;

    getStore().setHistoryClearing(true);
    getStore().setHistoryError(null);
    try {
      await clearScanHistory(playlist.file_path, playlist.source_identity);
      await refreshHistory();
    } catch (err) {
      getStore().setHistoryError(errorToString(err));
    } finally {
      getStore().setHistoryClearing(false);
    }
  }, [playlist, refreshHistory]);

  const openHistoryPanel = useCallback(() => {
    if (!playlist) {
      getStore().setMenuInfo("Open a playlist first to view scan history.");
      return;
    }
    getStore().setShowHistory(true);
    void refreshHistory();
  }, [playlist, refreshHistory]);

  const handleOpenRecent = useCallback(
    (entry: RecentPlaylistEntry) => {
      if (entry.saved_playlist_id) {
        void openSavedPlaylistById(entry.saved_playlist_id);
        return;
      }
      if (entry.kind === "url") {
        void openPlaylistUrlValue(entry.value);
        return;
      }
      if (entry.kind === "xtream") {
        const source = parseXtreamRecent(entry.value);
        if (!source) {
          getStore().setMenuInfo("This Xtream recent entry is invalid.");
          void refreshRecentPlaylists();
          return;
        }
        if (source.password) {
          void openPlaylistXtreamValue(
            { server: source.server, username: source.username, password: source.password },
            true,
          );
          return;
        }
        openSourceDialog({
          mode: "xtream",
          initialUrl: "",
          initialXtream: source,
          initialStalker: null,
        });
        return;
      }
      void openPlaylistPath(entry.value);
    },
    [
      openPlaylistPath,
      openPlaylistUrlValue,
      openPlaylistXtreamValue,
      openSavedPlaylistById,
      openSourceDialog,
      refreshRecentPlaylists,
    ],
  );

  const recentPlaylistsRef = useRef<RecentPlaylistEntry[]>(recentPlaylists);
  useEffect(() => {
    recentPlaylistsRef.current = recentPlaylists;
  }, [recentPlaylists]);
  const savedPlaylistsRef = useRef<SavedPlaylistEntry[]>(savedPlaylists);
  useEffect(() => {
    savedPlaylistsRef.current = savedPlaylists;
  }, [savedPlaylists]);
  const startScreenRecentPlaylists = useMemo(
    () => recentPlaylists.slice(0, START_SCREEN_RECENT_LIMIT),
    [recentPlaylists],
  );
  const startScreenSavedPlaylists = useMemo(
    () => savedPlaylists.slice(0, 8),
    [savedPlaylists],
  );

  useEffect(() => {
    let active = true;
    let actionListener: { unregister: () => Promise<void> } | null = null;

    onAction(() => {
      if (!active) return;
      const mainWindow = getCurrentWindow();
      void mainWindow.unminimize().catch(() => {});
      void mainWindow.show().catch(() => {});
      void mainWindow.setFocus().catch(() => {});
    })
      .then((listener) => {
        if (!active) {
          void listener.unregister();
          return;
        }
        actionListener = listener;
      })
      .catch(() => {
        // Notification action listener unavailable on this platform/runtime.
      });

    return () => {
      active = false;
      if (actionListener) {
        void actionListener.unregister();
      }
    };
  }, []);

  useEffect(() => {
    if (!playlist) {
      getStore().setHistoryEntries([]);
      getStore().setHistoryError(null);
      getStore().setShowHistory(false);
      return;
    }

    void refreshHistory();
  }, [playlist, refreshHistory]);

  const handleExternalOpenPaths = useCallback((paths: string[]) => {
    const targetPath = paths.find((path) => path.trim().length > 0) ?? null;
    if (!targetPath) {
      return;
    }

    if (paths.length > 1) {
      getStore().setMenuInfo(`Opened ${paths.length} items. Loaded the first one.`);
    }

    void restoreAndFocusWindow(getCurrentWindow()).catch(() => {});
    void openPlaylistPath(targetPath);
  }, [openPlaylistPath]);

  const handleDroppedPaths = useCallback((paths: string[]) => {
    const playlistPath = paths.find((path) =>
      isPlaylistLikePath(path),
    );

    if (!playlistPath) {
      getStore().setMenuInfo("Dropped file is not an M3U/M3U8 playlist.");
      return;
    }

    void openPlaylistPath(playlistPath);
  }, [openPlaylistPath]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (!mounted) return;
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          getStore().setIsDragOver(true);
          return;
        }
        if (payload.type === "drop") {
          getStore().setIsDragOver(false);
          handleDroppedPaths(payload.paths);
          return;
        }
        getStore().setIsDragOver(false);
      })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => {
        // Ignore drag-drop hook errors; fallback is file picker.
      });

    return () => {
      mounted = false;
      getStore().setIsDragOver(false);
      unlisten?.();
    };
  }, [handleDroppedPaths]);

  // Keyboard shortcuts
  const showKeyboardShortcutsRef = useRef(showKeyboardShortcuts);
  useEffect(() => {
    showKeyboardShortcutsRef.current = showKeyboardShortcuts;
  }, [showKeyboardShortcuts]);

  const openSourceDialogRef = useRef(openSourceDialogState);
  useEffect(() => {
    openSourceDialogRef.current = openSourceDialogState;
  }, [openSourceDialogState]);

  const pendingPlaybackRef = useRef<ChannelResult | null>(pendingPlaybackChannel);
  useEffect(() => {
    pendingPlaybackRef.current = pendingPlaybackChannel;
  }, [pendingPlaybackChannel]);

  const showHistoryRef = useRef(showHistory);
  useEffect(() => {
    showHistoryRef.current = showHistory;
  }, [showHistory]);

  const lightboxOpenRef = useRef(lightboxOpen);
  useEffect(() => {
    lightboxOpenRef.current = lightboxOpen;
  }, [lightboxOpen]);

  const handleOpenShortcutRef = useRef(handleOpen);
  useEffect(() => {
    handleOpenShortcutRef.current = handleOpen;
  }, [handleOpen]);

  const handleOpenSettingsRef = useRef<() => void>(() => {});
  const handleOpenLogRef = useRef<() => void>(() => {});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inputLikeTarget = isInputLikeTarget(e.target);
      const hasPrimaryModifier = isPrimaryModifierPressed(e, isMac) && !e.altKey;
      const lowerKey = e.key.toLowerCase();

      if (hasPrimaryModifier && !e.shiftKey && lowerKey === "o") {
        e.preventDefault();
        handleOpenShortcutRef.current();
      }
      if (hasPrimaryModifier && !e.shiftKey && lowerKey === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (hasPrimaryModifier && !e.shiftKey && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        handleOpenSettingsRef.current();
      }
      if (hasPrimaryModifier && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        getStore().setShowKeyboardShortcuts(true);
      }
      if (e.altKey && isPrimaryModifierPressed(e, isMac) && lowerKey === "l") {
        e.preventDefault();
        handleOpenLogRef.current();
      }
      if (
        !e.repeat &&
        !inputLikeTarget &&
        !hasPrimaryModifier &&
        !e.shiftKey &&
        !e.altKey &&
        lowerKey === "s"
      ) {
        e.preventDefault();
        if (isScanActive(getStore().scanState)) {
          void cancelRef.current();
        } else {
          void handleStartScanRef.current();
        }
        return;
      }
      if (
        !e.repeat &&
        e.key === " " &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        if (inputLikeTarget) return;
        e.preventDefault();
        getStore().toggleLightboxOpen();
      }
      if (e.key === "Escape") {
        if (lightboxOpenRef.current) {
          getStore().setLightboxOpen(false);
          return;
        }
        if (pendingPlaybackRef.current) {
          getStore().setPendingPlaybackChannel(null);
          return;
        }
        if (openSourceDialogRef.current) {
          getStore().setOpenSourceDialogState(null);
          return;
        }
        if (showKeyboardShortcutsRef.current) {
          getStore().setShowKeyboardShortcuts(false);
          return;
        }
        if (showHistoryRef.current) {
          getStore().setShowHistory(false);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [data-allow-native-context]",
        )
      ) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  const startScanWithSelection = useCallback(async (selection: number[]) => {
    const state = getStore();
    const currentChannelSearchError = validateSourceFilterPattern(
      state.channelSearch,
    );

    if (currentChannelSearchError) {
      state.setScanInputError(
        `Invalid source filter regex: ${currentChannelSearchError}`,
      );
      return false;
    }

    const applyResult = await ensureSourceFilterApplied();
    if (!applyResult.ok) {
      return false;
    }

    const refreshedState = getStore();
    const currentPlaylist = refreshedState.playlist;
    const currentChannelSearch = normalizeSourceFilter(
      refreshedState.channelSearch,
    );
    const currentGroupFilter = refreshedState.groupFilter;
    const currentSettings = refreshedState.settings;
    const effectiveSelection = applyResult.reapplied ? [] : selection;

    if (!currentPlaylist) return false;

    const config: ScanConfig = {
      file_path: currentPlaylist.file_path,
      source_identity: currentPlaylist.source_identity ?? null,
      playlist_display_name: currentPlaylist.file_name,
      group_filter: currentGroupFilter !== "all" ? currentGroupFilter : null,
      channel_search: currentChannelSearch || null,
      selected_indices: effectiveSelection.length > 0 ? effectiveSelection : null,
      hide_vod_content: currentSettings.hide_vod_content,
      timeout: currentSettings.timeout,
      extended_timeout: currentSettings.extended_timeout,
      concurrency: resolveSmartConcurrency(
        currentSettings.concurrency,
        currentPlaylist.single_provider,
        currentPlaylist.xtream_max_connections ?? null,
      ),
      retries: currentSettings.retries,
      retry_backoff: currentSettings.retry_backoff,
      user_agent: currentSettings.user_agent,
      skip_screenshots: currentSettings.skip_screenshots,
      profile_bitrate: currentSettings.profile_bitrate,
      ffprobe_timeout_secs: currentSettings.ffprobe_timeout_secs,
      ffmpeg_bitrate_timeout_secs: currentSettings.ffmpeg_bitrate_timeout_secs,
      accept_invalid_certs: currentSettings.accept_invalid_certs,
      proxy_file: currentSettings.proxy_file,
      test_geoblock: currentSettings.test_geoblock,
      screenshots_dir: currentSettings.screenshots_dir,
      client_capabilities: {
        event_batch_v1: true,
      },
    };

    await start(config, currentPlaylist.total_channels, effectiveSelection);
    return true;
  }, [ensureSourceFilterApplied, start]);

  const handleStartScan = useCallback(async () => {
    const started = await startScanWithSelection(getStore().selectedChannelIndices);
    if (started) {
      void triggerHaptic(HapticFeedbackPattern.LevelChange, PerformanceTime.Now);
    }
  }, [startScanWithSelection]);

  const handleScanSelected = useCallback(
    (indices: number[]) => {
      void (async () => {
        const started = await startScanWithSelection(indices);
        if (started) {
          void triggerHaptic(HapticFeedbackPattern.LevelChange, PerformanceTime.Now);
        }
      })();
    },
    [startScanWithSelection],
  );

  handlePlaybackFailedRef.current = (result) => {
    // Set "checking" status immediately, then run a lightweight backend check
    const checking = { ...result, status: "checking" as const };
    updateResult(checking);
    quickCheckChannel(result).then(
      (checked) => updateResult(checked),
      () => updateResult({ ...result, status: "dead" as const }),
    );
  };

  // Refs for menu event handlers so listeners never need re-registration
  const handleOpenRef = useRef(handleOpen);
  handleOpenRef.current = handleOpen;
  const handleOpenFolderRef = useRef(handleOpenFolder);
  handleOpenFolderRef.current = handleOpenFolder;
  const handleOpenUrlRef = useRef(handleOpenUrl);
  handleOpenUrlRef.current = handleOpenUrl;
  const handleOpenExternalPathsRef = useRef(handleExternalOpenPaths);
  handleOpenExternalPathsRef.current = handleExternalOpenPaths;
  const handleOpenRecentRef = useRef(handleOpenRecent);
  handleOpenRecentRef.current = handleOpenRecent;
  const handleOpenSavedRef = useRef(handleOpenSaved);
  handleOpenSavedRef.current = handleOpenSaved;
  const handleClearRecentRef = useRef(handleClearRecentPlaylists);
  handleClearRecentRef.current = handleClearRecentPlaylists;
  const handleManageSavedRef = useRef<() => void>(() => {});
  const handleStartScanRef = useRef(handleStartScan);
  handleStartScanRef.current = handleStartScan;
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const openHistoryPanelRef = useRef(openHistoryPanel);
  openHistoryPanelRef.current = openHistoryPanel;
  const checkForUpdatesRef = useRef(checkForUpdates);
  checkForUpdatesRef.current = checkForUpdates;
  const handleToggleReportRef = useRef<() => void>(() => {});
  const handleToggleSidebarRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const queueExport = (action: "csv" | "split" | "renamed" | "m3u" | "scanlog") => {
      getStore().queueMenuExportRequest(action);
    };

    const setup = async () => {
      const listeners = await Promise.all([
        listen("menu://open-playlist", () => void handleOpenRef.current()),
        listen("menu://open-folder", () => void handleOpenFolderRef.current()),
        listen("menu://open-url", () => void handleOpenUrlRef.current()),
        listen<string[]>("app://open-paths", (event) => {
          handleOpenExternalPathsRef.current(event.payload);
        }),
        ...Array.from({ length: 10 }, (_, i) =>
          listen(`menu://open-recent-${i}`, () => {
            const entry = recentPlaylistsRef.current[i];
            if (entry) handleOpenRecentRef.current(entry);
          }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          listen(`menu://open-saved-${i}`, () => {
            const entry = savedPlaylistsRef.current[i];
            if (entry) handleOpenSavedRef.current(entry.id);
          }),
        ),
        listen("menu://clear-recent", () => void handleClearRecentRef.current()),
        listen("menu://manage-saved", () => handleManageSavedRef.current()),
        listen("menu://export-csv", () => queueExport("csv")),
        listen("menu://export-split", () => queueExport("split")),
        listen("menu://export-renamed", () => queueExport("renamed")),
        listen("menu://export-filtered-m3u", () => queueExport("m3u")),
        listen("menu://export-scan-log", () => queueExport("scanlog")),
        listen("menu://toggle-sidebar", () => handleToggleSidebarRef.current()),
        listen("menu://toggle-report", () => handleToggleReportRef.current()),
        listen("menu://toggle-prescan-filter", () => {
          const current = settingsRef.current;
          void saveSettingsRef.current({ ...current, show_prescan_filter: !current.show_prescan_filter });
        }),
        listen("menu://toggle-header-button-text", () => {
          const current = settingsRef.current;
          void saveSettingsRef.current({
            ...current,
            show_header_button_text: !current.show_header_button_text,
          });
        }),
        listen("menu://clear-filters", () => {
          getStore().setSearch("");
          getStore().setChannelSearch("");
          getStore().setGroupFilter("all");
          getStore().setStatusFilter("all");
        }),
        listen("menu://open-history", () => openHistoryPanelRef.current()),
        listen("menu://start-scan", () => void handleStartScanRef.current()),
        listen("menu://pause-scan", () => void pauseRef.current()),
        listen("menu://resume-scan", () => void resumeRef.current()),
        listen("menu://stop-scan", () => void cancelRef.current()),
        listen("menu://open-settings", () => handleOpenSettingsRef.current()),
        listen("menu://open-log", () => handleOpenLogRef.current()),
        listen("menu://check-updates", () => void checkForUpdatesRef.current(true)),
        listen("menu://keyboard-shortcuts", () => getStore().setShowKeyboardShortcuts(true)),
        listen<import("./lib/types").PlaylistLoadProgress>(
          "playlist://load-progress",
          (event) => {
            getStore().setPlaylistLoadProgress(event.payload);
          },
        ),
      ]);
      if (cancelled) {
        for (const off of listeners) off();
      } else {
        unlisten.push(...listeners);
        // Only declare this window ready after its menu listeners are mounted.
        void emit("menu-ready", getCurrentWindow().label).catch(() => {});
      }
    };

    void setup();
    return () => {
      cancelled = true;
      for (const off of unlisten) {
        off();
      }
    };
  }, []);

  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const delta = ev.clientX - sidebarDragRef.current.startX;
      const newWidth = Math.max(100, Math.min(600, sidebarDragRef.current.startWidth + delta));
      getStore().setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      sidebarDragRef.current = null;
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const handleReportSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    reportSidebarDragRef.current = {
      startX: e.clientX,
      startWidth: reportSidebarWidth,
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (!reportSidebarDragRef.current) return;
      const delta = reportSidebarDragRef.current.startX - ev.clientX;
      const newWidth = Math.max(
        260,
        Math.min(700, reportSidebarDragRef.current.startWidth + delta),
      );
      getStore().setReportSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      reportSidebarDragRef.current = null;
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [reportSidebarWidth]);

  useEffect(() => {
    localStorage.setItem("sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("report-sidebar-width", String(reportSidebarWidth));
  }, [reportSidebarWidth]);

  const handleSelectChannel = useCallback((result: ChannelResult) => {
    getStore().setSelectedChannel(result);
  }, []);

  const handleOpenSettings = useCallback(async () => {
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      await restoreAndFocusWindow(existing);
      return;
    }
    const devUrl = "http://localhost:1420";
    const baseUrl = import.meta.env.DEV ? devUrl : window.location.origin;
    new WebviewWindow("settings", {
      url: `${baseUrl}?window=settings`,
      ...(platform === "windows" ? { dataDirectory: "settings-webview" } : {}),
      title: "Settings",
      width: 620,
      height: 680,
      minWidth: 520,
      minHeight: 400,
      resizable: true,
      minimizable: false,
      maximizable: false,
      center: true,
      hiddenTitle: true,
      titleBarStyle: "overlay",
    });
  }, [platform]);
  useEffect(() => {
    handleOpenSettingsRef.current = handleOpenSettings;
  }, [handleOpenSettings]);
  useEffect(() => {
    handleManageSavedRef.current = handleManageSavedPlaylists;
  }, [handleManageSavedPlaylists]);

  const handleOpenLog = useCallback(async () => {
    const existing = await WebviewWindow.getByLabel("log");
    if (existing) {
      await restoreAndFocusWindow(existing);
      return;
    }
    const devUrl = "http://localhost:1420";
    const baseUrl = import.meta.env.DEV ? devUrl : window.location.origin;
    new WebviewWindow("log", {
      url: `${baseUrl}?window=log`,
      ...(platform === "windows" ? { dataDirectory: "log-webview" } : {}),
      title: "Log",
      width: 900,
      height: 600,
      minWidth: 500,
      minHeight: 300,
      resizable: true,
      minimizable: true,
      maximizable: true,
      center: true,
      hiddenTitle: true,
      titleBarStyle: "overlay",
    });
  }, [platform]);
  useEffect(() => {
    handleOpenLogRef.current = handleOpenLog;
  }, [handleOpenLog]);

  const markManualReportVisibility = useCallback((nextVisible: boolean) => {
    reportWasAutoShownRef.current = false;
    const isActiveScan = isScanActive(getStore().scanState);
    if (!isActiveScan) {
      return;
    }
    if (nextVisible) {
      reportAutoRevealBlockedRef.current = false;
      reportAutoRevealDoneRef.current = true;
      return;
    }
    reportAutoRevealBlockedRef.current = true;
  }, []);

  const handleToggleReport = useCallback(() => {
    const next = !showReportPanel;
    markManualReportVisibility(next);
    getStore().setShowReportPanel(next);
  }, [showReportPanel, markManualReportVisibility]);
  handleToggleReportRef.current = handleToggleReport;

  const handleCloseReport = useCallback(() => {
    markManualReportVisibility(false);
    getStore().setShowReportPanel(false);
  }, [markManualReportVisibility]);

  const handleOpenExternal = useCallback(async (result: ChannelResult) => {
    try {
      await openChannelInPlayer({
        extinf_line: result.extinf_line,
        metadata_lines: result.metadata_lines,
        url: result.url,
      });
    } catch (err) {
      logger.error("[Player] Failed to open channel in external player:", errorToString(err));
      getStore().setPlaybackError(errorToString(err));
    }
  }, []);

  const handlePlayInApp = useCallback(
    (result: ChannelResult) => {
      if (isScanActive(getStore().scanState) && getStore().playlist?.single_provider) {
        getStore().setPendingPlaybackChannel(result);
        return;
      }
      // While a cast session is active, redirect the cast to the new channel
      // instead of starting a competing local stream. Single-connection IPTV
      // upstreams can only feed one consumer; starting local play would kick
      // the cast pipeline's ffmpeg off the upstream.
      const currentChromecast = chromecastRef.current;
      if (isCastSessionActive(currentChromecast.session)) {
        const session = currentChromecast.session;
        const device =
          currentChromecast.devices.find((d) => d.id === session.deviceId) ??
          (lastCastDeviceRef.current?.id === session.deviceId
            ? lastCastDeviceRef.current
            : null);
        if (device) {
          void currentChromecast.cast(device, buildCastRequest(result));
          return;
        }
        // Fall through to local play if we can't resolve the device — better
        // than silently doing nothing.
      }
      getStore().setPlayIntentActive(true);
      playStream(result);
    },
    [playStream],
  );

  const handleStopPlayer = useCallback(() => {
    getStore().setPlayIntentActive(false);
    stopStream();
  }, [stopStream]);

  const handlePip = useCallback(() => {
    const video = playbackVideoElement;
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else if (document.pictureInPictureEnabled) {
      video.requestPictureInPicture().catch(() => {});
    }
  }, [playbackVideoElement]);

  const handleProceedPlayback = useCallback(() => {
    if (!pendingPlaybackChannel) return;
    const channel = pendingPlaybackChannel;
    getStore().setPendingPlaybackChannel(null);
    getStore().setPlayIntentActive(true);
    playStream(channel);
  }, [pendingPlaybackChannel, playStream]);

  // Merge player-derived metadata into ChannelResult for unscanned channels
  const lastMergedMetaRef = useRef<{ index: number; meta: typeof streamPlayer.streamMetadata } | null>(null);
  useEffect(() => {
    const meta = streamPlayer.streamMetadata;
    const idx = streamPlayer.activeChannelIndex;
    if (!meta || idx === null) return;

    // Prevent infinite re-trigger: skip if we already merged this exact data
    const last = lastMergedMetaRef.current;
    if (last && last.index === idx && last.meta === meta) return;
    lastMergedMetaRef.current = { index: idx, meta };

    const state = getStore();
    const existing = state.results[idx];
    if (!existing) return;

    let changed = false;
    const updated = { ...existing };

    if (meta.width != null && existing.width == null) { updated.width = meta.width; changed = true; }
    if (meta.height != null && existing.height == null) { updated.height = meta.height; changed = true; }
    if (meta.resolution && !existing.resolution) { updated.resolution = meta.resolution; changed = true; }
    if (meta.codec && !existing.codec) { updated.codec = meta.codec; changed = true; }
    if (meta.fps != null && existing.fps == null) { updated.fps = meta.fps; changed = true; }
    if (meta.videoBitrate && !existing.video_bitrate) { updated.video_bitrate = meta.videoBitrate; changed = true; }
    if (meta.audioCodec && !existing.audio_codec) { updated.audio_codec = meta.audioCodec; changed = true; }
    if (meta.audioBitrate && !existing.audio_bitrate) { updated.audio_bitrate = meta.audioBitrate; changed = true; }

    if (changed) {
      updateResult(updated);
      // Also update selectedChannel if it's the same index
      if (state.selectedChannel?.index === idx) {
        getStore().setSelectedChannel(updated);
      }
    }
  }, [streamPlayer.streamMetadata, streamPlayer.activeChannelIndex, updateResult]);

  handleToggleSidebarRef.current = () => {
    const state = getStore();
    const sidebarVisible = !state.sidebarHidden && !!state.selectedChannel;
    if (sidebarVisible) {
      getStore().setSidebarHidden(true);
    } else {
      if (!state.selectedChannel) {
        if (state.flatResults.length > 0) {
          getStore().setSelectedChannel(state.flatResults[0]);
        } else if (state.playlist && state.playlist.channels.length > 0) {
          getStore().setSelectedChannel(
            toPendingChannelResult(state.playlist.channels[0]),
          );
        }
      }
      getStore().setSidebarHidden(false);
    }
  };

  const handleTableProfilerRender = useCallback<ProfilerOnRenderCallback>(
    (id, phase, actualDuration, baseDuration) => {
      recordUiPerf({
        metric: "react.commit",
        valueMs: actualDuration,
        meta: {
          id,
          phase,
          baseDuration,
        },
      });
    },
    [],
  );
  // Auto-stop player when selected channel changes or is deselected
  useEffect(() => {
    if (playbackChannelIndex === null) return;
    if (!liveSelectedChannel) {
      getStore().setPlayIntentActive(false);
      stopStream();
    } else if (liveSelectedChannel.index !== playbackChannelIndex) {
      stopStream();
    }
  }, [liveSelectedChannel, playbackChannelIndex, stopStream]);

  const headerPortalRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const tableProfilerEnabled =
    uiPerfEnabled() &&
    (playlist?.channels.length ?? 0) <= TABLE_PROFILER_ROW_LIMIT;
  const channelTableElement = (
    <ChannelTable
      onSelectChannel={handleSelectChannel}
      onOpenChannel={handlePlayInApp}
      onOpenExternal={handleOpenExternal}
      onScanSelected={handleScanSelected}
      isCasting={isCasting}
      headerPortalRef={isMac ? headerPortalRef : undefined}
      toolbarHeight={toolbarHeight}
    />
  );
  const toolbarMeasureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = toolbarMeasureRef.current;
    if (!el) return;
    const update = () => {
      const nextToolbarHeight = el.offsetHeight;
      setToolbarHeight((prev) =>
        prev === nextToolbarHeight ? prev : nextToolbarHeight,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tableChromeStyle = isMac
    ? {
        marginLeft:
          liveSelectedChannel && !sidebarHidden
            ? `${sidebarWidth}px`
            : undefined,
        marginRight:
          playlist && showReportPanel
            ? `${reportSidebarWidth}px`
            : undefined,
      }
    : undefined;

  return (
    <div className="flex flex-col h-screen bg-surface">
      <ScanRuntimeEffects
        refreshHistory={refreshHistory}
        reportAutoRevealBlockedRef={reportAutoRevealBlockedRef}
        reportAutoRevealDoneRef={reportAutoRevealDoneRef}
        reportWasAutoShownRef={reportWasAutoShownRef}
      />
      <div
        ref={toolbarMeasureRef}
        className={`relative z-20 ${isMac && playlist ? "glass-material bg-panel" : ""} ${isMac && !playlist ? "pb-4" : ""}`}
      >
        {isMac && !playlist && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 glass-material bg-panel" />
          </div>
        )}
        <div className="relative z-10">
          <Toolbar
            onOpen={handleOpen}
            onOpenFolder={handleOpenFolder}
            onOpenUrl={handleOpenUrl}
            onOpenXtream={handleOpenXtream}
            onSavePlaylist={handleSaveCurrentPlaylist}
            onManageSavedPlaylists={handleManageSavedPlaylists}
            onStartScan={handleStartScan}
            onPauseScan={pause}
            onResumeScan={resume}
            onStopScan={cancel}
            onOpenSettings={handleOpenSettings}
            onToggleReport={handleToggleReport}
            searchInputRef={searchInputRef}
          />
          {isMac && playlist && (
            <div className="flex flex-col" style={tableChromeStyle}>
              <div ref={headerPortalRef} />
              <FilterBar onApply={handleApplySourceFilter} variant="chrome" />
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col flex-1 min-h-0">
      {ffmpegWarning && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-400 text-[13px]">
          <AlertTriangle className="w-4 h-4" />
          ffmpeg/ffprobe not found. Screenshots and media info will be disabled.
        </div>
      )}
      <ScanPauseBanners />

      {scanError && !errorDismissed && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{scanError}</span>
          <button
            onClick={() => getStore().setErrorDismissed(true)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {playbackError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{playbackError}</span>
          <button
            onClick={() => getStore().setPlaybackError(null)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {playlistOpenError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{playlistOpenError}</span>
          <button
            onClick={() => getStore().setPlaylistOpenError(null)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {scanInputError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{scanInputError}</span>
          <button
            onClick={() => getStore().setScanInputError(null)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {menuInfo && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-500/10 border-b border-blue-500/20 text-blue-400 text-[13px]">
          <Info className="w-4 h-4" />
          <span className="flex-1">{menuInfo}</span>
          <button
            onClick={() => getStore().setMenuInfo(null)}
            className="p-1 hover:bg-blue-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {updateNotice && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-[13px]">
          <span className="flex-1">
            Update available: <strong>v{updateNotice.latest_version}</strong>
            {appVersion ? ` (current v${appVersion})` : ""}.
          </span>
          <button
            type="button"
            onClick={() => {
              void openUrl(updateNotice.release_url).catch((err) => {
                logger.error("[Update] Failed to open release URL:", errorToString(err));
              });
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-400/30 hover:bg-emerald-500/15 transition-colors"
          >
            Download
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              getStore().setUpdateNotice(null);
              localStorage.removeItem(UPDATE_CACHE_KEY);
            }}
            className="p-1 hover:bg-emerald-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex flex-1 min-h-0 bg-content">
          {liveSelectedChannel && !sidebarHidden && (
            <SelectedChannelSidebar
              sidebarWidth={sidebarWidth}
              onResizeStart={handleSidebarDragStart}
              streamPlayer={streamPlayer}
              chromecast={chromecast}
              onPlayChannel={handlePlayInApp}
              onScanChannel={handleScanSelected}
              onStopPlayer={handleStopPlayer}
              onOpenExternal={handleOpenExternal}
              onPip={handlePip}
            />
          )}
          <div className="flex flex-col flex-1 min-w-0">
            {!isMac && <FilterBar onApply={handleApplySourceFilter} />}
            {playlist ? (
              tableProfilerEnabled ? (
                <Profiler id="ChannelTable" onRender={handleTableProfilerRender}>
                  {channelTableElement}
                </Profiler>
              ) : (
                channelTableElement
              )
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden native-scroll text-text-tertiary">
              <div className="min-h-full flex flex-col items-center justify-center text-center px-4 py-6">
                {playlistLoading ? (
                  <div className="select-none">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-blue-500" />
                    <p className="text-lg font-medium">
                      {playlistLoadProgress?.stage === "Connecting"
                        ? "Connecting…"
                        : playlistLoadProgress?.stage === "Downloading"
                          ? "Downloading playlist…"
                          : playlistLoadProgress?.stage === "Saving"
                            ? "Saving to cache…"
                            : playlistLoadProgress?.stage === "Parsing"
                              ? "Parsing playlist…"
                              : playlistLoadProgress?.stage === "Processing"
                                ? "Processing…"
                                : "Loading playlist…"}
                    </p>
                    {(playlistLoadProgress?.stage === "Connecting" ||
                      playlistLoadProgress?.stage === "Saving") && (
                      <p className="text-sm mt-1 text-text-quaternary">
                        {playlistLoadProgress.detail}
                      </p>
                    )}
                    {playlistLoadProgress?.stage === "Downloading" && (
                      <p className="text-sm mt-1 tabular-nums">
                        {(playlistLoadProgress.bytes_downloaded / (1024 * 1024)).toFixed(1)} MB
                        {playlistLoadProgress.elapsed_secs > 0 && (
                          <span className="ml-2 text-text-quaternary">
                            {(playlistLoadProgress.bytes_downloaded / playlistLoadProgress.elapsed_secs / (1024 * 1024)).toFixed(1)} MB/s
                          </span>
                        )}
                      </p>
                    )}
                    {playlistLoadProgress?.stage === "Parsing" && (
                      <div className="text-sm mt-1 tabular-nums">
                        <p>
                          {playlistLoadProgress.channels_found.toLocaleString()} entries found
                        </p>
                        <p className="text-text-quaternary">
                          {playlistLoadProgress.live_found.toLocaleString()} channels
                          <span className="mx-2">•</span>
                          {(
                            playlistLoadProgress.movie_found +
                            playlistLoadProgress.series_found
                          ).toLocaleString()}{" "}
                          VOD
                          {(playlistLoadProgress.movie_found > 0 ||
                            playlistLoadProgress.series_found > 0) && (
                            <span className="ml-2">
                              ({playlistLoadProgress.movie_found.toLocaleString()} movies,{" "}
                              {playlistLoadProgress.series_found.toLocaleString()} series)
                            </span>
                          )}
                        </p>
                      </div>
                    )}
                    {playlistLoadProgress?.stage === "Processing" && (
                      <p className="text-sm mt-1 text-text-quaternary">
                        {playlistLoadProgress.detail}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col items-center">
                      <div className="select-none pt-3">
                        <p className="text-lg font-medium mb-2">
                          No playlist loaded
                        </p>
                        <p className="text-[15px] mb-4">
                          Click Open or press{" "}
                          <kbd className="px-2 py-0.5 bg-input rounded text-[13px] border border-border-app">
                            {modKey}+O
                          </kbd>{" "}
                          to load an M3U playlist
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          onClick={handleOpen}
                          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/25 transition-colors"
                          type="button"
                        >
                          <FolderOpen className="w-4 h-4" />
                          Open File
                        </button>
                        <button
                          onClick={handleOpenFolder}
                          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                          type="button"
                        >
                          <FolderOpen className="w-4 h-4" />
                          Open Folder
                        </button>
                        <button
                          onClick={handleOpenUrl}
                          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                          type="button"
                        >
                          Add URL
                        </button>
                        <button
                          onClick={handleOpenXtream}
                          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors"
                          type="button"
                        >
                          Add Xtream
                        </button>
                      </div>
                    </div>

                    <div className="mt-6 w-full max-w-xl text-left">
                      {startScreenSavedPlaylists.length > 0 && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[12px] uppercase tracking-[0.08em] text-text-tertiary">
                              Saved Playlists
                            </p>
                            <button
                              onClick={handleManageSavedPlaylists}
                              className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
                              type="button"
                            >
                              Manage…
                            </button>
                          </div>
                          <div className="space-y-1">
                            {startScreenSavedPlaylists.map((entry) => (
                              <button
                                key={entry.id}
                                onClick={() => handleOpenSaved(entry.id)}
                                className="w-full text-left px-3 py-2 rounded-lg border border-border-subtle hover:border-border-app hover:bg-panel-subtle transition-colors"
                                type="button"
                                title={savedPlaylistSecondaryLabel(entry)}
                              >
                                <span className="text-[13px] text-text-primary block truncate">
                                  {entry.display_name}
                                </span>
                                <span className="text-[11px] text-text-tertiary block truncate mt-0.5">
                                  {savedPlaylistSecondaryLabel(entry)}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {startScreenRecentPlaylists.length > 0 && (
                        <div className={startScreenSavedPlaylists.length > 0 ? "mt-6" : ""}>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[12px] uppercase tracking-[0.08em] text-text-tertiary">
                              Open Recent
                            </p>
                            <button
                              onClick={() => {
                                void handleClearRecentPlaylists();
                              }}
                              className="text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
                              type="button"
                            >
                              Clear
                            </button>
                          </div>
                          <div className="space-y-1">
                            {startScreenRecentPlaylists.map((entry) => (
                              <button
                                key={`${entry.kind}:${entry.value}`}
                                onClick={() => handleOpenRecent(entry)}
                                className="w-full text-left px-3 py-2 rounded-lg border border-border-subtle hover:border-border-app hover:bg-panel-subtle transition-colors"
                                type="button"
                                title={recentTitle(entry)}
                              >
                                <span className="text-[13px] text-text-primary block truncate">
                                  {entry.label}
                                </span>
                                <span className="text-[11px] text-text-tertiary block truncate mt-0.5">
                                  {recentValueLabel(entry)}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {playlist && showReportPanel && (
          <PlaylistReportPanel
            placement="right"
            widthPx={reportSidebarWidth}
            onResizeStart={handleReportSidebarDragStart}
            onClose={handleCloseReport}
          />
        )}
      </div>

      <StatsPanel />
      <ProgressBar />
      </div>
      </div>

      {openSourceDialogState && (
        <Suspense fallback={null}>
          <OpenSourceDialog
            initialMode={openSourceDialogState.mode}
            initialUrl={openSourceDialogState.initialUrl}
            initialXtream={openSourceDialogState.initialXtream}
            initialStalker={openSourceDialogState.initialStalker}
            onOpenUrl={openPlaylistUrlValue}
            onOpenXtream={openPlaylistXtreamValue}
            onOpenStalker={openPlaylistStalkerValue}
            onClose={() => getStore().setOpenSourceDialogState(null)}
          />
        </Suspense>
      )}

      {savedPlaylistsDialogOpen && (
        <Suspense fallback={null}>
          <SavedPlaylistsDialog
            playlists={savedPlaylists}
            onOpen={(id) => handleOpenSaved(id)}
            onEdit={(entry) => setSavedPlaylistEditorDraft(savedEntryToDraft(entry))}
            onDelete={(id) => void handleDeleteSavedPlaylistById(id)}
            onTestServers={(entry) => setSavedXtreamTestEntry(entry)}
            onClose={() => setSavedPlaylistsDialogOpen(false)}
          />
        </Suspense>
      )}

      {savedPlaylistEditorDraft && (
        <Suspense fallback={null}>
          <SavedPlaylistEditorDialog
            draft={savedPlaylistEditorDraft}
            onClose={() => setSavedPlaylistEditorDraft(null)}
            onSave={(draft) => void handleSavePlaylistDraft(draft)}
          />
        </Suspense>
      )}

      {savedXtreamTestEntry?.kind === "xtream" && (
        <Suspense fallback={null}>
          <XtreamServerTestDialog
            initialServersText={savedXtreamTestEntry.servers.join("\n")}
            username={savedXtreamTestEntry.username}
            password={savedXtreamTestEntry.password ?? ""}
            onSelectServer={(server) =>
              void handlePreferSavedXtreamServer(savedXtreamTestEntry, server)
            }
            onClose={() => setSavedXtreamTestEntry(null)}
          />
        </Suspense>
      )}

      {showKeyboardShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcutsDialog
            modifierLabel={modKey}
            onClose={() => getStore().setShowKeyboardShortcuts(false)}
          />
        </Suspense>
      )}

      {showHistory && playlist && (
        <Suspense fallback={null}>
          <HistoryPanel
            playlistName={playlist.file_name}
            entries={historyEntries}
            loading={historyLoading}
            error={historyError}
            clearing={historyClearing}
            onRefresh={() => {
              void refreshHistory();
            }}
            onClear={() => {
              void handleClearHistory();
            }}
            onClose={() => getStore().setShowHistory(false)}
          />
        </Suspense>
      )}

      {isDragOver && (
        <div className="fixed inset-0 z-40 pointer-events-none">
          <div className="absolute inset-0 bg-blue-500/12 backdrop-blur-[1px]" />
          <div className="absolute inset-0 flex items-center justify-center px-4">
            <div className="rounded-2xl border-2 border-dashed border-blue-400/70 bg-overlay/90 px-8 py-6 text-center shadow-2xl">
              <p className="text-[11px] uppercase tracking-[0.08em] text-blue-300 mb-1">
                Drop Playlist
              </p>
              <p className="text-[16px] font-semibold text-text-primary">
                Release to open `.m3u` / `.m3u8`
              </p>
            </div>
          </div>
        </div>
      )}

      {pendingPlaybackChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-xl rounded-xl border border-border-app bg-overlay p-5 shadow-2xl">
            <h2 className="text-[16px] font-semibold mb-2">
              Scan currently running
            </h2>
            <p className="text-[14px] text-text-secondary leading-relaxed">
              A scan is currently running. Playing a channel while scanning may
              interfere with the scan or cause playback issues if the server&apos;s
              max connection limit is exceeded.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => getStore().setPendingPlaybackChannel(null)}
                className="macos-btn px-3 py-2 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={handleProceedPlayback}
                className="macos-btn macos-btn-primary px-3 py-2 min-h-9 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 rounded-md"
                type="button"
              >
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
