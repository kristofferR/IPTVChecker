import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { setLiquidGlassEffect } from "tauri-plugin-liquid-glass-api";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type {
  ChannelResult,
  PlaylistPreview,
  RecentPlaylistEntry,
  ScanConfig,
  ScanHistoryItem,
  XtreamOpenRequest,
  XtreamRecentSource,
} from "./lib/types";
import {
  addRecentPlaylist,
  clearRecentPlaylists,
  clearScanHistory,
  getRecentPlaylists,
  getScanHistory,
  openPlaylist,
  openPlaylistXtream,
  openPlaylistUrl,
  checkFfmpegAvailable,
  readScreenshot,
  openChannelInPlayer,
} from "./lib/tauri";
import { useScan } from "./hooks/useScan";
import { useSettings } from "./hooks/useSettings";
import { Toolbar } from "./components/Toolbar";
import { FilterBar } from "./components/FilterBar";
import { ChannelTable } from "./components/ChannelTable";
import { ThumbnailPanel } from "./components/ThumbnailPanel";
import { StatsPanel } from "./components/StatsPanel";
import { WarningsPanel } from "./components/WarningsPanel";
import { ProgressBar } from "./components/ProgressBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { HistoryPanel } from "./components/HistoryPanel";
import { OpenSourceDialog } from "./components/OpenSourceDialog";
import { AlertTriangle, ExternalLink, FolderOpen, Info, X } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { detectPlatform, type Platform } from "./lib/platform";
import { findDuplicateChannelIndices } from "./lib/duplicates";
import { filterResults } from "./lib/filters";
import { logger } from "./lib/logger";
import { HapticFeedbackPattern, PerformanceTime, triggerHaptic } from "./lib/haptics";

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

function validateRegexPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  try {
    new RegExp(trimmed);
    return null;
  } catch (err) {
    return errorToString(err);
  }
}

const UPDATE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const OS_PROGRESS_UPDATE_INTERVAL_MS = 2000;
const UPDATE_LAST_CHECK_KEY = "updates:last-check-epoch-ms";
const UPDATE_CACHE_KEY = "updates:last-available-release";
const GITHUB_LATEST_RELEASE_API =
  "https://api.github.com/repos/kristofferR/IPTVChecker-GUI/releases/latest";
const GITHUB_RELEASES_PAGE =
  "https://github.com/kristofferR/IPTVChecker-GUI/releases";

interface UpdateNotice {
  latest_version: string;
  release_url: string;
  checked_at_epoch_ms: number;
}

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

function formatScanNotificationBody(stats: {
  alive: number;
  dead: number;
  geoblocked: number;
}): string {
  return `Alive ${stats.alive} | Dead ${stats.dead} | Geoblocked ${stats.geoblocked}`;
}

async function canSendNotifications(): Promise<boolean> {
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

function inferPlatformFromNavigator(): Platform {
  const platformName = navigator.platform.toLowerCase();
  if (platformName.includes("mac")) return "macos";
  if (platformName.includes("win")) return "windows";
  return "linux";
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

type OpenSourceMode = "url" | "xtream";

interface OpenSourceDialogState {
  mode: OpenSourceMode;
  initialUrl: string;
  initialXtream: XtreamRecentSource | null;
}

function serializeXtreamRecent(source: XtreamRecentSource): string {
  return JSON.stringify({
    server: source.server.trim(),
    username: source.username.trim(),
  });
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
    return { server, username };
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

export default function App() {
  const [platform, setPlatform] = useState<Platform>(inferPlatformFromNavigator);
  const isMac = platform === "macos";
  const modKey = isMac ? "Cmd" : "Ctrl";

  const [playlist, setPlaylist] = useState<PlaylistPreview | null>(null);
  const [search, setSearch] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedChannel, setSelectedChannel] = useState<ChannelResult | null>(
    null,
  );
  const [selectedChannelIndices, setSelectedChannelIndices] = useState<number[]>(
    [],
  );
  const [showSettings, setShowSettings] = useState(false);
  const [ffmpegWarning, setFfmpegWarning] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playlistOpenError, setPlaylistOpenError] = useState<string | null>(
    null,
  );
  const [scanInputError, setScanInputError] = useState<string | null>(null);
  const [pendingPlaybackChannel, setPendingPlaybackChannel] =
    useState<ChannelResult | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [menuInfo, setMenuInfo] = useState<string | null>(null);
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openSourceDialogState, setOpenSourceDialogState] =
    useState<OpenSourceDialogState | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<ScanHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyClearing, setHistoryClearing] = useState(false);
  const [recentPlaylists, setRecentPlaylists] = useState<RecentPlaylistEntry[]>([]);
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  const [menuExportRequest, setMenuExportRequest] = useState<{
    id: number;
    action: "csv" | "split" | "renamed" | "m3u" | "scanlog";
  } | null>(null);

  const { settings, save: saveSettings } = useSettings();
  const {
    results,
    progress,
    summary,
    scanState,
    error,
    telemetry,
    start,
    cancel,
    pause,
    resume,
    initFromPlaylist,
  } = useScan();
  const channelSearchError = useMemo(
    () => validateRegexPattern(channelSearch),
    [channelSearch],
  );

  useEffect(() => {
    document.documentElement.dataset.platform = platform;
  }, [platform]);

  // Detect platform via native plugin and refresh the initial fallback.
  useEffect(() => {
    detectPlatform()
      .then((p) => {
        setPlatform(p);
        if (p === "macos") {
          setLiquidGlassEffect({}).catch(() => {});
        }
      })
      .catch(() => {
        // Keep navigator-based fallback when plugin-os isn't available yet.
      });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // Check ffmpeg on mount
  useEffect(() => {
    checkFfmpegAvailable().then(([ffmpeg, ffprobe]) => {
      if (!ffmpeg || !ffprobe) {
        setFfmpegWarning(true);
      }
    });
  }, []);

  // Auto-dismiss error banner after 10 seconds
  useEffect(() => {
    if (error) {
      setErrorDismissed(false);
      const timer = setTimeout(() => setErrorDismissed(true), 10000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    if (!playbackError) return;
    const timer = setTimeout(() => setPlaybackError(null), 10000);
    return () => clearTimeout(timer);
  }, [playbackError]);

  useEffect(() => {
    if (!playlistOpenError) return;
    const timer = setTimeout(() => setPlaylistOpenError(null), 10000);
    return () => clearTimeout(timer);
  }, [playlistOpenError]);

  useEffect(() => {
    if (!scanInputError) return;
    const timer = setTimeout(() => setScanInputError(null), 8000);
    return () => clearTimeout(timer);
  }, [scanInputError]);

  useEffect(() => {
    if (!channelSearchError) {
      setScanInputError(null);
    }
  }, [channelSearchError]);

  useEffect(() => {
    if (!menuInfo) return;
    const timer = setTimeout(() => setMenuInfo(null), 8000);
    return () => clearTimeout(timer);
  }, [menuInfo]);

  const refreshRecentPlaylists = useCallback(async () => {
    try {
      const entries = await getRecentPlaylists();
      setRecentPlaylists(entries);
    } catch {
      // Ignore recent-list load failures.
    }
  }, []);

  const handleClearRecentPlaylists = useCallback(async () => {
    try {
      const entries = await clearRecentPlaylists();
      setRecentPlaylists(entries);
    } catch {
      // Ignore clear failures.
    }
  }, []);

  useEffect(() => {
    void refreshRecentPlaylists();
  }, [refreshRecentPlaylists]);

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
        setAppVersion(currentVersion);

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
          setUpdateNotice(notice);
          localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(notice));
          if (force) {
            setMenuInfo(`Update available: v${latestVersion}`);
          }
          return;
        }

        setUpdateNotice(null);
        localStorage.removeItem(UPDATE_CACHE_KEY);
        if (force) {
          setMenuInfo(`You're up to date (v${currentVersion}).`);
        }
      } catch (err) {
        if (force) {
          setMenuInfo(`Update check failed: ${errorToString(err)}`);
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
          setAppVersion(currentVersion);
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
        setUpdateNotice(cachedNotice);
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

  const openPlaylistPath = useCallback(async (selectedPath: string) => {
    setPlaylistOpenError(null);
    try {
      const searchTrimmed = channelSearch.trim() || undefined;
      logger.debug(
        `[App] Opening playlist: ${selectedPath}, channelSearch: "${searchTrimmed ?? ""}"`,
      );
      const preview = await openPlaylist(selectedPath, undefined, searchTrimmed);
      logger.debug(
        `[App] Playlist loaded: ${preview.file_name}, channels=${preview.total_channels}, groups=${preview.groups.length}`,
        preview.groups,
      );
      setPlaylist(preview);
      initFromPlaylist(preview.channels);
      setSearch("");
      setGroupFilter("all");
      setStatusFilter("all");
      setPlaylistOpenError(null);
      setSelectedChannel(null);
      setSelectedChannelIndices([]);
      setPendingPlaybackChannel(null);
      setShowHistory(false);
      try {
        const entries = await addRecentPlaylist("file", selectedPath);
        setRecentPlaylists(entries);
      } catch {
        // Ignore recent-list update failures.
      }
    } catch (err) {
      logger.error("[App] Failed to open playlist", err);
      setPlaylistOpenError(formatPlaylistOpenError(err));
      // Keep app interaction predictable after a failed open attempt.
      setSelectedChannel(null);
      setSelectedChannelIndices([]);
      setPendingPlaybackChannel(null);
      setShowHistory(false);
      void refreshRecentPlaylists();
    }
  }, [initFromPlaylist, channelSearch, refreshRecentPlaylists]);

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

  const openPlaylistUrlValue = useCallback(async (url: string): Promise<boolean> => {
    setPlaylistOpenError(null);
    try {
      const searchTrimmed = channelSearch.trim() || undefined;
      logger.debug(
        `[App] Opening playlist URL: ${url}, channelSearch: "${searchTrimmed ?? ""}"`,
      );
      const preview = await openPlaylistUrl(url, undefined, searchTrimmed);
      logger.debug(
        `[App] Playlist URL loaded: ${preview.file_name}, channels=${preview.total_channels}, groups=${preview.groups.length}`,
        preview.groups,
      );
      setPlaylist(preview);
      initFromPlaylist(preview.channels);
      setSearch("");
      setGroupFilter("all");
      setStatusFilter("all");
      setPlaylistOpenError(null);
      setSelectedChannel(null);
      setSelectedChannelIndices([]);
      setPendingPlaybackChannel(null);
      setShowHistory(false);
      try {
        const entries = await addRecentPlaylist("url", url);
        setRecentPlaylists(entries);
      } catch {
        // Ignore recent-list update failures.
      }
      return true;
    } catch (err) {
      logger.error("[App] Failed to open playlist URL", err);
      setPlaylistOpenError(formatPlaylistOpenError(err));
      setSelectedChannel(null);
      setSelectedChannelIndices([]);
      setPendingPlaybackChannel(null);
      setShowHistory(false);
      void refreshRecentPlaylists();
      return false;
    }
  }, [channelSearch, initFromPlaylist, refreshRecentPlaylists]);

  const openPlaylistXtreamValue = useCallback(
    async (source: XtreamOpenRequest): Promise<boolean> => {
      setPlaylistOpenError(null);
      try {
        const searchTrimmed = channelSearch.trim() || undefined;
        logger.debug(
          `[App] Opening Xtream playlist: server=${source.server}, username=${source.username}, channelSearch="${searchTrimmed ?? ""}"`,
        );
        const preview = await openPlaylistXtream(source, undefined, searchTrimmed);
        logger.debug(
          `[App] Xtream playlist loaded: ${preview.file_name}, channels=${preview.total_channels}, groups=${preview.groups.length}`,
          preview.groups,
        );
        setPlaylist(preview);
        initFromPlaylist(preview.channels);
        setSearch("");
        setGroupFilter("all");
        setStatusFilter("all");
        setPlaylistOpenError(null);
        setSelectedChannel(null);
        setSelectedChannelIndices([]);
        setPendingPlaybackChannel(null);
        setShowHistory(false);
        try {
          const entries = await addRecentPlaylist(
            "xtream",
            serializeXtreamRecent({
              server: source.server,
              username: source.username,
            }),
          );
          setRecentPlaylists(entries);
        } catch {
          // Ignore recent-list update failures.
        }
        return true;
      } catch (err) {
        logger.error("[App] Failed to open Xtream playlist", err);
        setPlaylistOpenError(formatPlaylistOpenError(err));
        setSelectedChannel(null);
        setSelectedChannelIndices([]);
        setPendingPlaybackChannel(null);
        setShowHistory(false);
        void refreshRecentPlaylists();
        return false;
      }
    },
    [channelSearch, initFromPlaylist, refreshRecentPlaylists],
  );

  const openSourceDialog = useCallback((state: OpenSourceDialogState) => {
    setOpenSourceDialogState(state);
  }, []);

  const handleOpenUrl = useCallback(() => {
    openSourceDialog({
      mode: "url",
      initialUrl: "",
      initialXtream: null,
    });
  }, [openSourceDialog]);

  const refreshHistory = useCallback(async () => {
    if (!playlist) {
      setHistoryEntries([]);
      setHistoryError(null);
      return;
    }

    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const items = await getScanHistory(
        playlist.file_path,
        playlist.source_identity,
      );
      setHistoryEntries(items);
    } catch (err) {
      setHistoryError(errorToString(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [playlist]);

  const handleClearHistory = useCallback(async () => {
    if (!playlist) return;

    setHistoryClearing(true);
    setHistoryError(null);
    try {
      await clearScanHistory(playlist.file_path, playlist.source_identity);
      await refreshHistory();
    } catch (err) {
      setHistoryError(errorToString(err));
    } finally {
      setHistoryClearing(false);
    }
  }, [playlist, refreshHistory]);

  const openHistoryPanel = useCallback(() => {
    if (!playlist) {
      setMenuInfo("Open a playlist first to view scan history.");
      return;
    }
    setShowHistory(true);
    void refreshHistory();
  }, [playlist, refreshHistory]);

  const handleOpenRecent = useCallback(
    (entry: RecentPlaylistEntry) => {
      if (entry.kind === "url") {
        void openPlaylistUrlValue(entry.value);
        return;
      }
      if (entry.kind === "xtream") {
        const source = parseXtreamRecent(entry.value);
        if (!source) {
          setMenuInfo("This Xtream recent entry is invalid.");
          void refreshRecentPlaylists();
          return;
        }
        openSourceDialog({
          mode: "xtream",
          initialUrl: "",
          initialXtream: source,
        });
        return;
      }
      void openPlaylistPath(entry.value);
    },
    [openPlaylistPath, openPlaylistUrlValue, openSourceDialog, refreshRecentPlaylists],
  );

  const recentPlaylistsRef = useRef<RecentPlaylistEntry[]>(recentPlaylists);
  useEffect(() => {
    recentPlaylistsRef.current = recentPlaylists;
  }, [recentPlaylists]);
  const previousScanStateRef = useRef(scanState);
  const osProgressTimerRef = useRef<number | null>(null);
  const lastOsProgressUpdateMsRef = useRef(0);

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
      setHistoryEntries([]);
      setHistoryError(null);
      setShowHistory(false);
      return;
    }

    void refreshHistory();
  }, [playlist, refreshHistory]);

  useEffect(() => {
    const previousScanState = previousScanStateRef.current;
    previousScanStateRef.current = scanState;
    const justFinished =
      previousScanState === "scanning" || previousScanState === "paused";

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

    if (!settings.scan_notifications || !summary) return;
    if (scanState !== "complete" && scanState !== "cancelled") return;

    const title = scanState === "complete" ? "Scan complete" : "Scan cancelled";
    const playlistPrefix = playlist ? `${playlist.file_name} | ` : "";
    const body = `${playlistPrefix}${formatScanNotificationBody(summary)}`;

    void (async () => {
      if (!(await canSendNotifications())) return;
      sendNotification({
        title,
        body,
        autoCancel: true,
      });
    })();
  }, [scanState, settings.scan_notifications, summary, playlist, refreshHistory]);

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
        scanState === "paused"
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
          ? `${progress.alive}/${progress.dead}`
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

    if (scanState === "scanning" || scanState === "paused") {
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
  }, [scanState, progress, isMac]);

  const handleDroppedPaths = useCallback((paths: string[]) => {
    const playlistPath = paths.find((path) =>
      path.toLowerCase().endsWith(".m3u") || path.toLowerCase().endsWith(".m3u8"),
    );

    if (!playlistPath) {
      setMenuInfo("Dropped file is not an M3U/M3U8 playlist.");
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
          setIsDragOver(true);
          return;
        }
        if (payload.type === "drop") {
          setIsDragOver(false);
          handleDroppedPaths(payload.paths);
          return;
        }
        setIsDragOver(false);
      })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => {
        // Ignore drag-drop hook errors; fallback is file picker.
      });

    return () => {
      mounted = false;
      setIsDragOver(false);
      unlisten?.();
    };
  }, [handleDroppedPaths]);

  // Keyboard shortcuts
  const showSettingsRef = useRef(showSettings);
  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        handleOpen();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings((s) => !s);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShowKeyboardShortcuts(true);
      }
      if (e.key === "Escape") {
        if (pendingPlaybackRef.current) {
          setPendingPlaybackChannel(null);
          return;
        }
        if (openSourceDialogRef.current) {
          setOpenSourceDialogState(null);
          return;
        }
        if (showKeyboardShortcutsRef.current) {
          setShowKeyboardShortcuts(false);
          return;
        }
        if (showHistory) {
          setShowHistory(false);
          return;
        }
        if (showSettingsRef.current) setShowSettings(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleOpen, showHistory]);

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
    if (channelSearchError) {
      setScanInputError(`Invalid pre-scan regex: ${channelSearchError}`);
      return false;
    }

    if (!playlist) return false;

    const config: ScanConfig = {
      file_path: playlist.file_path,
      source_identity: playlist.source_identity ?? null,
      group_filter: groupFilter !== "all" ? groupFilter : null,
      channel_search: channelSearch.trim() || null,
      selected_indices: selection.length > 0 ? selection : null,
      timeout: settings.timeout,
      extended_timeout: settings.extended_timeout,
      concurrency: settings.concurrency,
      retries: settings.retries,
      retry_backoff: settings.retry_backoff,
      user_agent: settings.user_agent,
      skip_screenshots: settings.skip_screenshots,
      profile_bitrate: settings.profile_bitrate,
      proxy_file: settings.proxy_file,
      test_geoblock: settings.test_geoblock,
      screenshots_dir: settings.screenshots_dir,
    };

    await start(config, playlist.total_channels, selection);
    return true;
  }, [playlist, settings, groupFilter, channelSearch, start, channelSearchError]);

  const handleStartScan = useCallback(async () => {
    const started = await startScanWithSelection(selectedChannelIndices);
    if (started) {
      void triggerHaptic(HapticFeedbackPattern.LevelChange, PerformanceTime.Now);
    }
  }, [selectedChannelIndices, startScanWithSelection]);

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

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    const queueExport = (action: "csv" | "split" | "renamed" | "m3u" | "scanlog") => {
      setMenuExportRequest((prev) => ({
        id: (prev?.id ?? 0) + 1,
        action,
      }));
    };

    const setup = async () => {
      unlisten.push(
        await listen("menu://open-playlist", () => {
          void handleOpen();
        }),
      );
      unlisten.push(
        await listen("menu://open-folder", () => {
          void handleOpenFolder();
        }),
      );
      unlisten.push(
        await listen("menu://open-url", () => {
          void handleOpenUrl();
        }),
      );
      for (let i = 0; i < 10; i += 1) {
        const eventName = `menu://open-recent-${i}`;
        unlisten.push(
          await listen(eventName, () => {
            const entry = recentPlaylistsRef.current[i];
            if (!entry) return;
            handleOpenRecent(entry);
          }),
        );
      }
      unlisten.push(
        await listen("menu://clear-recent", () => {
          void handleClearRecentPlaylists();
        }),
      );
      unlisten.push(
        await listen("menu://export-csv", () => queueExport("csv")),
      );
      unlisten.push(
        await listen("menu://export-split", () => queueExport("split")),
      );
      unlisten.push(
        await listen("menu://export-renamed", () => queueExport("renamed")),
      );
      unlisten.push(
        await listen("menu://export-filtered-m3u", () => queueExport("m3u")),
      );
      unlisten.push(
        await listen("menu://export-scan-log", () => queueExport("scanlog")),
      );
      unlisten.push(
        await listen("menu://toggle-sidebar", () =>
          setSidebarHidden((hidden) => !hidden),
        ),
      );
      unlisten.push(
        await listen("menu://clear-filters", () => {
          setSearch("");
          setChannelSearch("");
          setGroupFilter("all");
          setStatusFilter("all");
        }),
      );
      unlisten.push(
        await listen("menu://open-history", () => openHistoryPanel()),
      );
      unlisten.push(
        await listen("menu://start-scan", () => {
          void handleStartScan();
        }),
      );
      unlisten.push(
        await listen("menu://pause-scan", () => {
          void pause();
        }),
      );
      unlisten.push(
        await listen("menu://resume-scan", () => {
          void resume();
        }),
      );
      unlisten.push(
        await listen("menu://stop-scan", () => {
          void cancel();
        }),
      );
      unlisten.push(
        await listen("menu://open-settings", () => setShowSettings(true)),
      );
      unlisten.push(
        await listen("menu://check-updates", () => {
          void checkForUpdates(true);
        }),
      );
      unlisten.push(
        await listen("menu://keyboard-shortcuts", () =>
          setShowKeyboardShortcuts(true),
        ),
      );
    };

    void setup();
    return () => {
      for (const off of unlisten) {
        off();
      }
    };
  }, [cancel, checkForUpdates, handleClearRecentPlaylists, handleOpen, handleOpenFolder, handleOpenRecent, handleOpenUrl, handleStartScan, openHistoryPanel, pause, resume]);

  const handleSelectChannel = useCallback((result: ChannelResult) => {
    setSelectedChannel(result);
  }, []);

  const launchChannelInPlayer = useCallback(async (result: ChannelResult) => {
    try {
      await openChannelInPlayer({
        extinf_line: result.extinf_line,
        metadata_lines: result.metadata_lines,
        url: result.url,
      });
    } catch (err) {
      setPlaybackError(String(err));
    }
  }, []);

  const handleOpenChannel = useCallback(
    (result: ChannelResult) => {
      if (scanState === "scanning" || scanState === "paused") {
        setPendingPlaybackChannel(result);
        return;
      }
      void launchChannelInPlayer(result);
    },
    [scanState, launchChannelInPlayer],
  );

  const handleProceedPlayback = useCallback(() => {
    if (!pendingPlaybackChannel) return;
    const channel = pendingPlaybackChannel;
    setPendingPlaybackChannel(null);
    void launchChannelInPlayer(channel);
  }, [pendingPlaybackChannel, launchChannelInPlayer]);

  const completedResults = useMemo(
    () => results.filter((r): r is ChannelResult => r != null),
    [results],
  );
  const duplicateIndices = useMemo(
    () => findDuplicateChannelIndices(results),
    [results],
  );
  const filteredExportResults = useMemo(
    () =>
      filterResults(
        completedResults,
        search,
        groupFilter,
        statusFilter,
        duplicateIndices,
      ),
    [completedResults, search, groupFilter, statusFilter, duplicateIndices],
  );
  const selectedExportResults = useMemo(() => {
    if (selectedChannelIndices.length === 0) {
      return [];
    }
    const selected = new Set(selectedChannelIndices);
    return completedResults.filter((result) => selected.has(result.index));
  }, [completedResults, selectedChannelIndices]);

  // Keep sidebar in sync with live scan results
  const liveSelectedChannel =
    selectedChannel != null
      ? (results[selectedChannel.index] ?? selectedChannel)
      : null;

  // Load screenshot via custom Tauri command (bypasses fs/asset scope issues)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const screenshotPathRef = useRef<string | null>(null);
  useEffect(() => {
    const path = liveSelectedChannel?.screenshot_path?.trim() || null;
    if (path === screenshotPathRef.current) return;
    screenshotPathRef.current = path;

    if (!path) {
      setScreenshotUrl(null);
      return;
    }

    let stale = false;
    readScreenshot(path)
      .then((dataUrl) => {
        if (!stale) setScreenshotUrl(dataUrl);
      })
      .catch(() => {
        if (!stale) setScreenshotUrl(null);
      });
    return () => {
      stale = true;
    };
  }, [liveSelectedChannel?.screenshot_path]);

  return (
    <div className="flex flex-col h-screen bg-surface">
      <Toolbar
        useWindowDragRegion={isMac}
        onOpen={handleOpen}
        onOpenFolder={handleOpenFolder}
        onOpenUrl={handleOpenUrl}
        onStartScan={handleStartScan}
        onPauseScan={pause}
        onResumeScan={resume}
        onStopScan={cancel}
        onOpenHistory={openHistoryPanel}
        onOpenSettings={() => setShowSettings(true)}
        scanState={scanState}
        hasPlaylist={playlist !== null}
        results={completedResults}
        filteredResults={filteredExportResults}
        selectedResults={selectedExportResults}
        playlistName={playlist?.file_name ?? ""}
        playlistPath={playlist?.file_path ?? ""}
        selectedCount={selectedChannelIndices.length}
        menuExportRequest={menuExportRequest}
        scanBlockedReason={
          channelSearchError ? `Invalid pre-scan regex: ${channelSearchError}` : null
        }
      />

      <div className="flex flex-col flex-1 min-h-0 bg-content">
      {ffmpegWarning && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-400 text-[13px]">
          <AlertTriangle className="w-4 h-4" />
          ffmpeg/ffprobe not found. Screenshots and media info will be disabled.
        </div>
      )}

      {error && !errorDismissed && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setErrorDismissed(true)}
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
            onClick={() => setPlaybackError(null)}
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
            onClick={() => setPlaylistOpenError(null)}
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
            onClick={() => setScanInputError(null)}
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
            onClick={() => setMenuInfo(null)}
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
          <a
            href={updateNotice.release_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-400/30 hover:bg-emerald-500/15 transition-colors"
          >
            Download
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => {
              setUpdateNotice(null);
              localStorage.removeItem(UPDATE_CACHE_KEY);
            }}
            className="p-1 hover:bg-emerald-500/20 rounded transition-colors"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <FilterBar
        search={search}
        onSearchChange={setSearch}
        groups={playlist?.groups ?? []}
        groupFilter={groupFilter}
        onGroupChange={setGroupFilter}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        channelSearch={channelSearch}
        onChannelSearchChange={setChannelSearch}
        channelSearchError={channelSearchError}
        scanState={scanState}
      />

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          {playlist ? (
            <ChannelTable
              results={results}
              duplicateIndices={duplicateIndices}
              search={search}
              groupFilter={groupFilter}
              statusFilter={statusFilter}
              onSelectChannel={handleSelectChannel}
              onOpenChannel={handleOpenChannel}
              onSelectionChange={setSelectedChannelIndices}
              onScanSelected={handleScanSelected}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-tertiary">
              <div className="text-center px-4">
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
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[15px] font-medium bg-btn text-text-primary hover:bg-btn-hover border border-border-app transition-colors ml-2"
                  type="button"
                >
                  <FolderOpen className="w-4 h-4" />
                  Open Folder
                </button>

                {recentPlaylists.length > 0 && (
                  <div className="mt-6 text-left mx-auto max-w-xl">
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
                      {recentPlaylists.map((entry) => (
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
            </div>
          )}
        </div>

        {liveSelectedChannel && !sidebarHidden && (
          <div className="w-72 border-l border-border-app bg-panel-muted">
            <ThumbnailPanel
              result={liveSelectedChannel}
              screenshotUrl={screenshotUrl}
            />
          </div>
        )}
      </div>

      <WarningsPanel
        results={results}
        duplicateCount={duplicateIndices.size}
      />
      <StatsPanel
        progress={progress}
        summary={summary}
        scanState={scanState}
        totalChannels={playlist?.total_channels ?? 0}
      />
      <ProgressBar
        progress={progress}
        scanState={scanState}
        throughputChannelsPerSecond={telemetry.throughputChannelsPerSecond}
        etaSeconds={telemetry.etaSeconds}
      />
      </div>

      {openSourceDialogState && (
        <OpenSourceDialog
          initialMode={openSourceDialogState.mode}
          initialUrl={openSourceDialogState.initialUrl}
          initialXtream={openSourceDialogState.initialXtream}
          onOpenUrl={openPlaylistUrlValue}
          onOpenXtream={openPlaylistXtreamValue}
          onClose={() => setOpenSourceDialogState(null)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showKeyboardShortcuts && (
        <KeyboardShortcutsDialog
          modifierLabel={modKey}
          onClose={() => setShowKeyboardShortcuts(false)}
        />
      )}

      {showHistory && playlist && (
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
          onClose={() => setShowHistory(false)}
        />
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
                onClick={() => setPendingPlaybackChannel(null)}
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
