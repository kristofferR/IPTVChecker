import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  lazy,
  Profiler,
  type ProfilerOnRenderCallback,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { setLiquidGlassEffect } from "tauri-plugin-liquid-glass-api";
import { AppBanners } from "./components/AppBanners";
import { ChannelTable } from "./components/ChannelTable";
import { FilterBar } from "./components/FilterBar";
import { PlaylistReportPanel } from "./components/PlaylistReportPanel";
import { ProgressBar } from "./components/ProgressBar";
import { StartScreen } from "./components/StartScreen";
import { StatsPanel } from "./components/StatsPanel";
import { ThumbnailPanel } from "./components/ThumbnailPanel";
import { Toolbar } from "./components/Toolbar";
import { type UseChromecastResult, useChromecast } from "./hooks/useChromecast";
import { useMenuEventBridge } from "./hooks/useMenuEventBridge";
import { usePlaylistSources } from "./hooks/usePlaylistSources";
import { useScan } from "./hooks/useScan";
import { useSettings } from "./hooks/useSettings";
import { type ArchivePlayOptions, useStreamPlayer } from "./hooks/useStreamPlayer";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { buildArchiveUrl } from "./lib/archive";
import { buildCastRequest, isCastSessionActive } from "./lib/cast";
import {
  checkFfmpegAvailable,
  clearScanHistory,
  getScanHistory,
  getTitleBarVisibility,
  openChannelInPlayer,
  quickCheckChannel,
  readScreenshot,
} from "./lib/tauri";
import type { AppSettings, ChannelResult, ChromecastDevice, ScanConfig } from "./lib/types";
import { selectResultByIndex, useAppStore } from "./store";
import type { AppStore, OpenSourceDialogState } from "./store/types";

const KeyboardShortcutsDialog = lazy(() => import("./components/KeyboardShortcutsDialog"));
const HistoryPanel = lazy(() => import("./components/HistoryPanel"));
const OpenSourceDialog = lazy(() => import("./components/OpenSourceDialog"));
const XtreamServerTestDialog = lazy(() =>
  import("./components/OpenSourceDialog").then((module) => ({
    default: module.ServerTestModal,
  })),
);
const SavedPlaylistsDialog = lazy(() => import("./components/SavedPlaylistsDialog"));
const SavedPlaylistEditorDialog = lazy(() => import("./components/SavedPlaylistEditorDialog"));

import { AlertTriangle } from "lucide-react";
import { mergeSuccessfulPlaybackResult, toPendingChannelResult } from "./lib/channelResults";
import { errorToString } from "./lib/errors";
import { HapticFeedbackPattern, PerformanceTime, triggerHaptic } from "./lib/haptics";
import { logger } from "./lib/logger";
import { recordUiPerf, startLongTaskObserver, uiPerfEnabled } from "./lib/perf";
import { detectPlatform } from "./lib/platform";
import { isSingleConnectionPlaylist } from "./lib/playback";
import { shouldAutoRevealReportPanel } from "./lib/playlistReportVisibility";
import { isScanActive } from "./lib/scanState";
import { isInputLikeTarget, isPrimaryModifierPressed } from "./lib/shortcuts";
import { normalizeSourceFilter, validateSourceFilterPattern } from "./lib/sourceFilter";

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

const OS_PROGRESS_UPDATE_INTERVAL_MS = 2000;
const TABLE_PROFILER_ROW_LIMIT = 50_000;

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

const selectLiveSelectedChannel = (state: AppStore): ChannelResult | null => {
  const selected = state.selectedChannel;
  return selected ? (selectResultByIndex(state, selected.index) ?? selected) : null;
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
          <span className="flex-1">
            Scan paused — network connectivity lost. Waiting for recovery...
          </span>
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
  onPlayArchive,
  onScanChannel,
  onStopPlayer,
  onCastStart,
  onOpenExternal,
  onPip,
}: {
  sidebarWidth: number;
  onResizeStart: (event: React.MouseEvent) => void;
  streamPlayer: StreamPlayerController;
  chromecast: UseChromecastResult;
  onPlayChannel: (result: ChannelResult) => void;
  onPlayArchive: (result: ChannelResult, options: ArchivePlayOptions) => void;
  onScanChannel: (indices: number[]) => void;
  onStopPlayer: () => void;
  onCastStart: () => void;
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
  // LRU-capped: entries are 50-200 KB base64 data URLs, and a long browsing
  // session would otherwise retain every screenshot ever viewed.
  const SCREENSHOT_CACHE_LIMIT = 50;
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
      // Re-insert to refresh recency (Map preserves insertion order).
      screenshotCacheRef.current.delete(path);
      screenshotCacheRef.current.set(path, cached);
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
          const cache = screenshotCacheRef.current;
          while (cache.size >= SCREENSHOT_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          cache.set(path, dataUrl);
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
        archiveSession={streamPlayer.archiveSession}
        onPlayArchive={onPlayArchive}
        onSeekArchive={streamPlayer.seekArchive}
        onGoLive={streamPlayer.goLive}
        onTogglePause={streamPlayer.togglePause}
        onStopPlayer={onStopPlayer}
        onCastStart={onCastStart}
        onSetVolume={streamPlayer.setVolume}
        onToggleMute={streamPlayer.toggleMute}
        onOpenExternal={onOpenExternal}
        onRetryPlay={streamPlayer.retry}
        onPip={document.pictureInPictureEnabled ? onPip : undefined}
      />
    </div>
  );
}

function ScanRuntimeEffects({ refreshHistory }: { refreshHistory: () => Promise<void> }) {
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
    getStore().resetReportAutoReveal();
  }, [playlist]);

  useEffect(() => {
    const previous = reportAutoRevealPreviousScanStateRef.current;
    const scanJustStarted = scanState === "scanning" && !isScanActive(previous);

    if (scanJustStarted) {
      getStore().prepareReportAutoRevealForScanStart();
    }

    reportAutoRevealPreviousScanStateRef.current = scanState;
  }, [scanState, showReportPanel]);

  useEffect(() => {
    if (!playlist || showReportPanel) {
      return;
    }
    if (!reportAutoReveal) {
      return;
    }
    const { reportAutoRevealBlocked, reportAutoRevealDone } = getStore();
    if (reportAutoRevealBlocked || reportAutoRevealDone) {
      return;
    }

    const active = scanState === "scanning" || scanState === "paused" || scanState === "complete";
    if (!active) {
      return;
    }
    if (!shouldAutoRevealReportPanel(progress, playlist.total_channels)) {
      return;
    }

    getStore().autoRevealReportPanel();
  }, [playlist, progress, reportAutoReveal, scanState, showReportPanel]);

  useEffect(() => {
    const previousScanState = previousScanStateRef.current;
    previousScanStateRef.current = scanState;
    const justFinished = isScanActive(previousScanState);

    if (scanState === "complete" && playlist) {
      void refreshHistory();
    }

    if (!justFinished) return;

    if (scanState === "complete") {
      void triggerHaptic(HapticFeedbackPattern.Generic, PerformanceTime.DrawCompleted);
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
      const status = networkPaused
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
        const badgeLabel = progress ? `${progress.alive + progress.drm}/${progress.dead}` : "...";
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
        lastOsProgressUpdateMsRef.current === 0 || elapsed >= OS_PROGRESS_UPDATE_INTERVAL_MS;

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
  const recentPlaylists = useAppStore((s) => s.recentPlaylists);
  const savedPlaylists = useAppStore((s) => s.savedPlaylists);
  const platform = useAppStore((s) => s.platform);
  const isMac = useAppStore((s) => s.isMac);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const showReportPanel = useAppStore((s) => s.showReportPanel);
  const reportSidebarWidth = useAppStore((s) => s.reportSidebarWidth);
  const showKeyboardShortcuts = useAppStore((s) => s.showKeyboardShortcuts);
  const isDragOver = useAppStore((s) => s.isDragOver);
  const ffmpegWarning = useAppStore((s) => s.ffmpegWarning);
  const openSourceDialogState = useAppStore((s) => s.openSourceDialogState);
  const pendingPlaybackChannel = useAppStore((s) => s.pendingPlaybackChannel);
  const [pendingArchivePlayback, setPendingArchivePlayback] = useState<{
    result: ChannelResult;
    options: ArchivePlayOptions;
  } | null>(null);
  const [pendingPlaybackReason, setPendingPlaybackReason] = useState<
    "scan" | "archive_probe" | null
  >(null);
  const archiveProbeActive = useAppStore((state) =>
    Object.values(state.archiveProbes).some((probe) => probe.running),
  );
  const liveSelectedChannel = useAppStore(selectLiveSelectedChannel);
  const showHistory = useAppStore((s) => s.showHistory);
  const historyEntries = useAppStore((s) => s.historyEntries);
  const historyLoading = useAppStore((s) => s.historyLoading);
  const historyError = useAppStore((s) => s.historyError);
  const historyClearing = useAppStore((s) => s.historyClearing);
  const modKey = isMac ? "Cmd" : "Ctrl";

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
    setArchiveSession,
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
  const { start, cancel, pause, resume, initFromPlaylist, syncFromPlaylist, updateResult } =
    useScan();
  const { checkForUpdates, installUpdate } = useUpdateCheck();
  const {
    handleClearRecentPlaylists,
    handleOpen,
    handleOpenFolder,
    openPlaylistPath,
    openPlaylistUrlValue,
    openPlaylistXtreamValue,
    openPlaylistStalkerValue,
    handleOpenSaved,
    handleOpenRecent,
    handleManageSavedPlaylists,
    editSavedPlaylist,
    handleSaveCurrentPlaylist,
    handleSavePlaylistDraft,
    handleDeleteSavedPlaylistById,
    handlePreferSavedXtreamServer,
    ensureSourceFilterApplied,
    handleApplySourceFilter,
    savedPlaylistsDialogOpen,
    setSavedPlaylistsDialogOpen,
    savedPlaylistEditorDraft,
    setSavedPlaylistEditorDraft,
    savedXtreamTestEntry,
    setSavedXtreamTestEntry,
  } = usePlaylistSources({ initFromPlaylist, syncFromPlaylist });

  useEffect(() => {
    setPendingArchivePlayback(null);
  }, [playlist?.file_path, playlist?.source_identity]);

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
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
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
    let cancelled = false;
    let off: (() => void) | undefined;
    listen<AppSettings>("settings-changed", (event) => {
      applyExternalSettings(event.payload);
    }).then((unlisten) => {
      // Release immediately if cleanup ran while listen() was in flight.
      if (cancelled) {
        unlisten();
        return;
      }
      off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [applyExternalSettings]);

  useEffect(() => {
    startLongTaskObserver();
  }, []);

  // Check ffmpeg on mount. A failed IPC check counts as unavailable.
  useEffect(() => {
    checkFfmpegAvailable()
      .then(([ffmpeg, ffprobe]) => {
        if (!ffmpeg || !ffprobe) {
          getStore().setFfmpegWarning(true);
        }
      })
      .catch(() => {
        getStore().setFfmpegWarning(true);
      });
  }, []);

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
      const items = await getScanHistory(playlist.file_path, playlist.source_identity);
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

  const handleExternalOpenPaths = useCallback(
    (paths: string[]) => {
      const targetPath = paths.find((path) => path.trim().length > 0) ?? null;
      if (!targetPath) {
        return;
      }

      if (paths.length > 1) {
        getStore().setMenuInfo(`Opened ${paths.length} items. Loaded the first one.`);
      }

      void restoreAndFocusWindow(getCurrentWindow()).catch(() => {});
      void openPlaylistPath(targetPath);
    },
    [openPlaylistPath],
  );

  const handleDroppedPaths = useCallback(
    (paths: string[]) => {
      const playlistPath = paths.find((path) => isPlaylistLikePath(path));

      if (!playlistPath) {
        getStore().setMenuInfo("Dropped file is not an M3U/M3U8 playlist.", "warn");
        return;
      }

      void openPlaylistPath(playlistPath);
    },
    [openPlaylistPath],
  );

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

  const startScanWithSelection = useCallback(
    async (selection: number[]) => {
      const state = getStore();
      const currentChannelSearchError = validateSourceFilterPattern(state.channelSearch);

      if (currentChannelSearchError) {
        state.setScanInputError(`Invalid source filter regex: ${currentChannelSearchError}`);
        return false;
      }

      const applyResult = await ensureSourceFilterApplied();
      if (!applyResult.ok) {
        return false;
      }

      const refreshedState = getStore();
      const currentPlaylist = refreshedState.playlist;
      const currentChannelSearch = normalizeSourceFilter(refreshedState.channelSearch);
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
    },
    [ensureSourceFilterApplied, start],
  );

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
    const latestResult = selectResultByIndex(getStore(), result.index) ?? result;
    const checking = { ...latestResult, status: "checking" as const };
    updateResult(checking);
    quickCheckChannel(latestResult).then(
      (checked) => updateResult(checked),
      () => updateResult({ ...latestResult, status: "dead" as const }),
    );
  };

  const handleSidebarDragStart = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [sidebarWidth],
  );

  const handleReportSidebarDragStart = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [reportSidebarWidth],
  );

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
      ...(platform === "linux" ? { decorations: await getTitleBarVisibility() } : {}),
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
      ...(platform === "linux" ? { decorations: await getTitleBarVisibility() } : {}),
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

  const handleToggleReport = useCallback(() => {
    getStore().toggleReportPanel();
  }, []);

  const handleCloseReport = useCallback(() => {
    getStore().setReportPanelManually(false);
  }, []);

  const handleStopPlayer = useCallback(() => {
    getStore().setPlayIntentActive(false);
    stopStream();
  }, [stopStream]);

  const handleCastStart = useCallback(() => {
    getStore().setPlayIntentActive(false);
    stopStream({ preserveArchiveSession: true });
  }, [stopStream]);

  const handleOpenExternal = useCallback(
    async (result: ChannelResult) => {
      if (isSingleConnectionPlaylist(getStore().playlist)) {
        handleStopPlayer();
      }

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
    },
    [handleStopPlayer],
  );

  const handlePlayInApp = useCallback(
    (result: ChannelResult) => {
      if (isScanActive(getStore().scanState) && getStore().playlist?.single_provider) {
        getStore().setPendingPlaybackChannel(result);
        setPendingPlaybackReason("scan");
        return;
      }
      if (
        getStore().playlist?.single_provider &&
        Object.values(getStore().archiveProbes).some((probe) => probe.running)
      ) {
        getStore().setPendingPlaybackChannel(result);
        setPendingPlaybackReason("archive_probe");
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
          (lastCastDeviceRef.current?.id === session.deviceId ? lastCastDeviceRef.current : null);
        if (device) {
          void currentChromecast
            .cast(device, buildCastRequest(result))
            .then(() => setArchiveSession(null))
            .catch(() => {});
          return;
        }
        // Fall through to local play if we can't resolve the device — better
        // than silently doing nothing.
      }
      getStore().setPlayIntentActive(true);
      playStream(result);
    },
    [playStream, setArchiveSession],
  );

  const handlePlayArchive = useCallback(
    (result: ChannelResult, options: ArchivePlayOptions) => {
      if (isScanActive(getStore().scanState) && getStore().playlist?.single_provider) {
        setPendingArchivePlayback({ result, options });
        setPendingPlaybackReason("scan");
        return;
      }
      if (
        getStore().playlist?.single_provider &&
        Object.values(getStore().archiveProbes).some((probe) => probe.running)
      ) {
        setPendingArchivePlayback({ result, options });
        setPendingPlaybackReason("archive_probe");
        return;
      }

      const nowEpochS = Math.floor(Date.now() / 1000);
      const windowEndEpochS = Math.min(options.endEpochS ?? nowEpochS, nowEpochS);
      const startEpochS = Math.min(Math.floor(options.startEpochS), windowEndEpochS - 1);
      const url = buildArchiveUrl(result, {
        startEpochS,
        durationS: Math.max(60, windowEndEpochS - startEpochS),
        nowEpochS,
      });
      if (!url) return;

      const currentChromecast = chromecastRef.current;
      if (isCastSessionActive(currentChromecast.session)) {
        const session = currentChromecast.session;
        const device =
          currentChromecast.devices.find((d) => d.id === session.deviceId) ??
          (lastCastDeviceRef.current?.id === session.deviceId ? lastCastDeviceRef.current : null);
        if (device) {
          void currentChromecast
            .cast(
              device,
              buildCastRequest({ ...result, url, content_type: "movie", stream_url: null }),
            )
            .then(() => {
              setArchiveSession({
                baseResult: result,
                url,
                startEpochS,
                windowStartEpochS: startEpochS,
                windowEndEpochS,
                title: options.title ?? null,
              });
            })
            .catch(() => {});
          return;
        }
      }

      getStore().setPlayIntentActive(true);
      streamPlayer.playArchive(result, options);
    },
    [setArchiveSession, streamPlayer.playArchive],
  );

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
    setPendingPlaybackReason(null);
    if (pendingArchivePlayback) {
      setPendingArchivePlayback(null);
      getStore().setPlayIntentActive(true);
      streamPlayer.playArchive(pendingArchivePlayback.result, pendingArchivePlayback.options);
      return;
    }
    if (!pendingPlaybackChannel) return;
    const channel = pendingPlaybackChannel;
    getStore().setPendingPlaybackChannel(null);
    getStore().setPlayIntentActive(true);
    playStream(channel);
  }, [pendingArchivePlayback, pendingPlaybackChannel, playStream, streamPlayer.playArchive]);

  useEffect(() => {
    if (pendingPlaybackReason === "archive_probe" && !archiveProbeActive) {
      handleProceedPlayback();
    }
  }, [archiveProbeActive, handleProceedPlayback, pendingPlaybackReason]);

  // Successful playback is itself a channel check. Keep the result row and
  // detail panel in sync with everything the active player can establish.
  useEffect(() => {
    const idx = streamPlayer.activeChannelIndex;
    if (idx === null || streamPlayer.playerState !== "playing" || streamPlayer.archiveSession)
      return;

    const state = getStore();
    const existing = selectResultByIndex(state, idx);
    if (!existing) return;

    const updated = mergeSuccessfulPlaybackResult(
      existing,
      streamPlayer.streamMetadata,
      settings.low_fps_threshold,
    );
    if (updated !== existing) {
      updateResult(updated);
      if (state.selectedChannel?.index === idx) {
        getStore().setSelectedChannel(updated);
      }
    }
  }, [
    settings.low_fps_threshold,
    streamPlayer.activeChannelIndex,
    streamPlayer.archiveSession,
    streamPlayer.playerState,
    streamPlayer.streamMetadata,
    updateResult,
  ]);

  const handleToggleSidebar = useCallback(() => {
    const state = getStore();
    const sidebarVisible = !state.sidebarHidden && !!state.selectedChannel;
    if (sidebarVisible) {
      getStore().setSidebarHidden(true);
    } else {
      if (!state.selectedChannel) {
        if (state.flatResults.length > 0) {
          getStore().setSelectedChannel(state.flatResults[0]);
        } else if (state.playlist && state.playlist.channels.length > 0) {
          getStore().setSelectedChannel(toPendingChannelResult(state.playlist.channels[0]));
        }
      }
      getStore().setSidebarHidden(false);
    }
  }, []);

  // Native menu events dispatch through a single ref-mirrored handler object,
  // so listeners register once and never miss a handler update.
  useMenuEventBridge({
    handleOpen,
    handleOpenFolder,
    handleOpenUrl,
    handleExternalOpenPaths,
    handleOpenRecent,
    handleOpenSaved,
    handleClearRecentPlaylists,
    handleManageSavedPlaylists,
    handleToggleSidebar,
    handleToggleReport,
    handleStartScan,
    pause,
    resume,
    cancel,
    openHistoryPanel,
    handleOpenSettings,
    handleOpenLog,
    checkForUpdates,
    settings,
    saveSettings,
  });

  // Keyboard shortcuts. Handlers are mirrored into a layout-synchronized ref
  // so the window listener registers once per platform change.
  const shortcutHandlersRef = useRef({
    handleOpen,
    handleOpenSettings,
    handleOpenLog,
    handleStartScan,
    cancel,
  });
  useLayoutEffect(() => {
    shortcutHandlersRef.current = {
      handleOpen,
      handleOpenSettings,
      handleOpenLog,
      handleStartScan,
      cancel,
    };
  }, [handleOpen, handleOpenSettings, handleOpenLog, handleStartScan, cancel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inputLikeTarget = isInputLikeTarget(e.target);
      const hasPrimaryModifier = isPrimaryModifierPressed(e, isMac) && !e.altKey;
      const lowerKey = e.key.toLowerCase();

      if (hasPrimaryModifier && !e.shiftKey && lowerKey === "o") {
        e.preventDefault();
        void shortcutHandlersRef.current.handleOpen();
      }
      if (hasPrimaryModifier && !e.shiftKey && lowerKey === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (hasPrimaryModifier && !e.shiftKey && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        void shortcutHandlersRef.current.handleOpenSettings();
      }
      if (hasPrimaryModifier && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        getStore().setShowKeyboardShortcuts(true);
      }
      if (e.altKey && isPrimaryModifierPressed(e, isMac) && lowerKey === "l") {
        e.preventDefault();
        void shortcutHandlersRef.current.handleOpenLog();
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
          void shortcutHandlersRef.current.cancel();
        } else {
          void shortcutHandlersRef.current.handleStartScan();
        }
        return;
      }
      if (!e.repeat && e.key === " " && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (inputLikeTarget) return;
        e.preventDefault();
        getStore().toggleLightboxOpen();
      }
      if (e.key === "Escape") {
        const state = getStore();
        if (state.lightboxOpen) {
          state.setLightboxOpen(false);
          return;
        }
        if (state.pendingPlaybackChannel || pendingArchivePlayback) {
          state.setPendingPlaybackChannel(null);
          setPendingArchivePlayback(null);
          setPendingPlaybackReason(null);
          return;
        }
        if (state.openSourceDialogState) {
          state.setOpenSourceDialogState(null);
          return;
        }
        if (state.showKeyboardShortcuts) {
          state.setShowKeyboardShortcuts(false);
          return;
        }
        if (state.showHistory) {
          state.setShowHistory(false);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMac, pendingArchivePlayback]);

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
    uiPerfEnabled() && (playlist?.channels.length ?? 0) <= TABLE_PROFILER_ROW_LIMIT;
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
      setToolbarHeight((prev) => (prev === nextToolbarHeight ? prev : nextToolbarHeight));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tableChromeStyle = isMac
    ? {
        marginLeft: liveSelectedChannel && !sidebarHidden ? `${sidebarWidth}px` : undefined,
        marginRight: playlist && showReportPanel ? `${reportSidebarWidth}px` : undefined,
      }
    : undefined;

  return (
    <div className="flex flex-col h-screen bg-surface">
      <ScanRuntimeEffects refreshHistory={refreshHistory} />
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

        <AppBanners onInstallUpdate={installUpdate} />

        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex flex-1 min-h-0 bg-content">
            {liveSelectedChannel && !sidebarHidden && (
              <SelectedChannelSidebar
                sidebarWidth={sidebarWidth}
                onResizeStart={handleSidebarDragStart}
                streamPlayer={streamPlayer}
                chromecast={chromecast}
                onPlayChannel={handlePlayInApp}
                onPlayArchive={handlePlayArchive}
                onScanChannel={handleScanSelected}
                onStopPlayer={handleStopPlayer}
                onCastStart={handleCastStart}
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
                <StartScreen
                  playlistLoading={playlistLoading}
                  playlistLoadProgress={playlistLoadProgress}
                  modKey={modKey}
                  recentPlaylists={recentPlaylists}
                  savedPlaylists={savedPlaylists}
                  onOpen={handleOpen}
                  onOpenFolder={handleOpenFolder}
                  onOpenUrl={handleOpenUrl}
                  onOpenXtream={handleOpenXtream}
                  onManageSavedPlaylists={handleManageSavedPlaylists}
                  onOpenSaved={handleOpenSaved}
                  onOpenRecent={handleOpenRecent}
                  onClearRecent={handleClearRecentPlaylists}
                />
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
            onEdit={(entry) => editSavedPlaylist(entry)}
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

      {(pendingPlaybackChannel || pendingArchivePlayback) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-xl rounded-xl border border-border-app bg-overlay p-5 shadow-2xl">
            <h2 className="text-[16px] font-semibold mb-2">
              {pendingPlaybackReason === "archive_probe"
                ? "Catch-up test currently running"
                : "Scan currently running"}
            </h2>
            <p className="text-[14px] text-text-secondary leading-relaxed">
              {pendingPlaybackReason === "archive_probe"
                ? "Playback will start when the catch-up test finishes, so a single-connection server is not interrupted."
                : "A scan is currently running. Playing a channel while scanning may interfere with the scan or cause playback issues if the server&apos;s max connection limit is exceeded."}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  getStore().setPendingPlaybackChannel(null);
                  setPendingArchivePlayback(null);
                  setPendingPlaybackReason(null);
                }}
                className="macos-btn px-3 py-2 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                type="button"
              >
                Cancel
              </button>
              {pendingPlaybackReason !== "archive_probe" && (
                <button
                  onClick={handleProceedPlayback}
                  className="macos-btn macos-btn-primary px-3 py-2 min-h-9 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 rounded-md"
                  type="button"
                >
                  Proceed
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
