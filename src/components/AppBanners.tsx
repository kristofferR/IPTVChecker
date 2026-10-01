import { Download, ExternalLink, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { dismissUpdateNotice } from "../hooks/useUpdateCheck";
import { formatCount, getFormatLocale, t } from "../i18n";
import { type ArchiveDownload, cancelArchiveDownload } from "../lib/archiveDownload";
import {
  type DownAccount,
  dispatcharrServerOfProxyPlaylist,
  dispatcharrTarget,
  getDispatcharrView,
} from "../lib/dispatcharr";
import { errorToString } from "../lib/errors";
import { formatBytes } from "../lib/format";
import { isScanActive } from "../lib/scanState";
import { validateSourceFilterPattern } from "../lib/sourceFilter";
import { dispatcharrRefreshAccount } from "../lib/tauri";
import type { ChannelResult } from "../lib/types";
import {
  isManualInstall,
  updateActionLabel,
  updateBannerMessage,
  updateConfirmMessage,
} from "../lib/updateState";
import { useAppStore } from "../store";

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

const CONVERT_DISMISSED_KEY = "dispatcharr-convert-dismissed";

function readConvertDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CONVERT_DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/** Offers to turn a Dispatcharr M3U export into a native Dispatcharr source,
 *  replacing the saved playlist when it came from one. Dismissal sticks per
 *  source. */
function DispatcharrConvertBanner() {
  const playlist = useAppStore((s) => s.playlist);
  // Converting replaces the whole source, so judge the unfiltered one: a
  // source filter or Hide VOD can hide the channels that make it mixed.
  const fullSource = useAppStore((s) => s.cachedSourcePreview ?? s.playlist);
  const savedPlaylists = useAppStore((s) => s.savedPlaylists);
  const server = useMemo(() => dispatcharrServerOfProxyPlaylist(fullSource), [fullSource]);
  const [dismissed, setDismissed] = useState(readConvertDismissed);
  const sourceKey = playlist?.source_identity ?? playlist?.file_path ?? "";
  if (!server || dismissed.includes(sourceKey)) return null;

  const saved = savedPlaylists.find((entry) => entry.id === playlist?.saved_playlist_id);
  const convert = () =>
    getStore().setOpenSourceDialogState({
      mode: "dispatcharr",
      initialUrl: "",
      initialXtream: null,
      initialStalker: null,
      initialDispatcharr: { server },
      convertSaved: saved ? { id: saved.id, name: saved.display_name } : null,
    });
  const dismiss = () => {
    const next = [...dismissed, sourceKey];
    localStorage.setItem(CONVERT_DISMISSED_KEY, JSON.stringify(next));
    setDismissed(next);
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-500/10 border-b border-blue-500/20 text-blue-400 text-[13px]">
      <Info className="w-4 h-4" />
      <span className="flex-1">{t("banners.dispatcharrConvert.message")}</span>
      <button
        type="button"
        onClick={convert}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-blue-400/30 hover:bg-blue-500/15 transition-colors"
      >
        {t("banners.dispatcharrConvert.convert")}
      </button>
      <button
        onClick={dismiss}
        className="p-1 hover:bg-blue-500/20 rounded transition-colors"
        type="button"
        aria-label={t("banners.dispatcharrConvert.dismiss")}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Names a provider account whose scanned streams nearly all failed the same
 *  way, and offers to refresh it in Dispatcharr and scan it again. */
type RefreshState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; error: string };

function DispatcharrProviderDownBanner({
  account,
  onRescan,
  onReload,
  onDismiss,
}: {
  account: DownAccount;
  onRescan: (indices: number[]) => void;
  onReload: () => void;
  onDismiss: () => void;
}) {
  const [refresh, setRefresh] = useState<RefreshState>({ kind: "idle" });
  const cause =
    account.error === "timeouts"
      ? t("banners.providerDown.causes.timeouts")
      : account.error === "connection errors"
        ? t("banners.providerDown.causes.connectionErrors")
        : account.error;
  const message =
    account.failed === account.scanned
      ? t("banners.providerDown.allFailed", {
          count: account.scanned,
          account: account.account,
          cause,
        })
      : t("banners.providerDown.someFailed", {
          failed: formatCount(account.failed),
          count: account.scanned,
          account: account.account,
          cause,
        });
  const handleRefresh = async () => {
    const target = dispatcharrTarget(getStore().playlist);
    if (!target) return;
    setRefresh({ kind: "sending" });
    try {
      await dispatcharrRefreshAccount(target, account.accountId);
      setRefresh({ kind: "sent" });
    } catch (error) {
      setRefresh({ kind: "failed", error: errorToString(error) });
    }
  };
  const handleRescan = () => {
    const { flatResults, dispatcharrOrders } = getStore();
    const view = getDispatcharrView(flatResults, dispatcharrOrders);
    const indices =
      view?.channels.flatMap((channel) =>
        channel.streams
          .filter((entry) => entry.ref.accountId === account.accountId)
          .map((entry) => entry.result.index),
      ) ?? [];
    if (indices.length > 0) onRescan(indices);
  };
  const buttonClass =
    "inline-flex shrink-0 items-center px-2.5 py-1 rounded-md border border-amber-400/30 hover:bg-amber-500/15 transition-colors disabled:opacity-50";
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-[13px]">
      <span className="flex-1 min-w-0">
        {message}
        {refresh.kind === "sent" && ` ${t("banners.providerDown.refreshing")}`}
        {refresh.kind === "failed" &&
          ` ${t("banners.providerDown.refreshFailed", { error: refresh.error })}`}
      </span>
      <button
        type="button"
        disabled={refresh.kind === "sending" || refresh.kind === "sent"}
        onClick={() => void handleRefresh()}
        className={buttonClass}
      >
        {t("banners.providerDown.refresh")}
      </button>
      {refresh.kind === "sent" ? (
        <button type="button" onClick={onReload} className={buttonClass}>
          {t("banners.providerDown.reload")}
        </button>
      ) : (
        <button type="button" onClick={handleRescan} className={buttonClass}>
          {t("banners.providerDown.rescan")}
        </button>
      )}
      <button
        onClick={onDismiss}
        className="p-1 hover:bg-amber-500/20 rounded transition-colors"
        type="button"
        aria-label={t("banners.providerDown.dismiss", { account: account.account })}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function DispatcharrProviderDownBanners({
  onRescan,
  onReload,
}: {
  onRescan: (indices: number[]) => void;
  onReload: () => void;
}) {
  const flatResults = useAppStore((s) => s.flatResults);
  const orders = useAppStore((s) => s.dispatcharrOrders);
  const scanning = useAppStore((s) => isScanActive(s.scanState));
  const view = useMemo(() => getDispatcharrView(flatResults, orders), [flatResults, orders]);
  // Dismissed for this set of results; a new scan brings a notice back.
  const [dismissed, setDismissed] = useState<{ results: ChannelResult[] | null; ids: number[] }>({
    results: null,
    ids: [],
  });
  if (scanning || !view) return null;
  const hidden = dismissed.results === flatResults ? dismissed.ids : [];
  return view.downAccounts
    .filter((account) => !hidden.includes(account.accountId))
    .map((account) => (
      <DispatcharrProviderDownBanner
        key={account.accountId}
        account={account}
        onRescan={onRescan}
        onReload={onReload}
        onDismiss={() =>
          setDismissed({ results: flatResults, ids: [...hidden, account.accountId] })
        }
      />
    ));
}

/** Shared banner auto-dismiss shape: whenever `value` becomes truthy, run
 *  `onShow` (optional) and schedule `dismiss` after `timeoutMs`. */
function useAutoDismiss(
  value: unknown,
  timeoutMs: number,
  dismiss: () => void,
  onShow?: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!value || !enabled) return;
    onShow?.();
    const timer = setTimeout(dismiss, timeoutMs);
    return () => clearTimeout(timer);
    // Callbacks are stable store writes; only the banner value and dismissal policy re-arm it.
  }, [value, enabled]);
}

function downloadLabel(download: ArchiveDownload): string {
  return download.title ? `${download.title} (${download.channelName})` : download.channelName;
}

/** One banner per recording: progress while running, then the outcome until dismissed. */
function ArchiveDownloadBanner({ download }: { download: ArchiveDownload }) {
  const dismiss = () => getStore().removeArchiveDownload(download.id);
  useAutoDismiss(download.status === "done", 12_000, dismiss);
  if (download.status === "running") {
    const percent = Math.min(
      100,
      Math.round((download.outTimeS / Math.max(1, download.durationS)) * 100),
    );
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-violet-500/10 border-b border-violet-500/20 text-violet-300 text-[13px]">
        <Download className="w-4 h-4 shrink-0" />
        <span className="min-w-0 truncate">
          {t("banners.recording.progress", { title: downloadLabel(download) })}
        </span>
        <div className="flex-1 h-1.5 min-w-16 rounded-full bg-violet-500/20 overflow-hidden">
          <div className="h-full bg-violet-400 rounded-full" style={{ width: `${percent}%` }} />
        </div>
        <span className="tabular-nums shrink-0 text-violet-200">
          {new Intl.NumberFormat(getFormatLocale(), { style: "percent" }).format(percent / 100)} ·{" "}
          {formatBytes(download.bytes)}
        </span>
        <button
          onClick={() => void cancelArchiveDownload(download.id)}
          className="shrink-0 rounded border border-violet-400/40 px-2 py-0.5 text-[12px] hover:bg-violet-500/20 transition-colors"
          type="button"
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }
  const tone =
    download.status === "done"
      ? "bg-green-500/10 border-green-500/20 text-green-400"
      : download.status === "failed"
        ? "bg-red-500/10 border-red-500/20 text-red-400"
        : "bg-panel-muted border-border-subtle text-text-secondary";
  const message =
    download.status === "done"
      ? t("banners.recording.saved", { title: downloadLabel(download), path: download.path })
      : download.status === "failed"
        ? t("banners.recording.failed", {
            title: downloadLabel(download),
            error: download.error ?? t("banners.recording.unknownError"),
          })
        : t("banners.recording.cancelled", { title: downloadLabel(download) });
  return (
    <div className={`flex items-center gap-2 px-4 py-2 border-b text-[13px] ${tone}`}>
      <span className="flex-1 min-w-0 truncate" title={message}>
        {message}
      </span>
      <button
        onClick={dismiss}
        className="p-1 rounded hover:bg-white/10 transition-colors"
        type="button"
        aria-label={t("banners.recording.dismiss")}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

interface AppBannersProps {
  /** Installs the discovered update, or opens the distribution's update page
   *  for package-manager-owned installations. */
  onInstallUpdate: () => void | Promise<void>;
  /** Scans the given rows (a provider account's streams). */
  onScanRows: (indices: number[]) => void;
  /** Loads the current source again, for stream URLs a refresh changed. */
  onReloadSource: () => void;
}

/** Error/info banners shown under the toolbar, with optional auto-dismiss
 *  timers. The update banner is always persistent. */
export function AppBanners({ onInstallUpdate, onScanRows, onReloadSource }: AppBannersProps) {
  const scanError = useAppStore((s) => s.scanError);
  const errorDismissed = useAppStore((s) => s.errorDismissed);
  const playbackError = useAppStore((s) => s.playbackError);
  const playlistOpenError = useAppStore((s) => s.playlistOpenError);
  const scanInputError = useAppStore((s) => s.scanInputError);
  const menuInfo = useAppStore((s) => s.menuInfo);
  const menuInfoPersistent = useAppStore((s) => s.menuInfoPersistent);
  const updateNotice = useAppStore((s) => s.updateNotice);
  const updatePhase = useAppStore((s) => s.updatePhase);
  const appVersion = useAppStore((s) => s.appVersion);
  const channelSearch = useAppStore((s) => s.channelSearch);
  const archiveDownloads = useAppStore((s) => s.archiveDownloads);
  const channelSearchError = useMemo(
    () => validateSourceFilterPattern(channelSearch),
    [channelSearch],
  );

  // Auto-dismiss error banner after 10 seconds
  useAutoDismiss(
    scanError,
    10000,
    () => getStore().setErrorDismissed(true),
    () => getStore().setErrorDismissed(false),
  );
  useAutoDismiss(playbackError, 10000, () => getStore().setPlaybackError(null));
  useAutoDismiss(playlistOpenError, 10000, () => getStore().setPlaylistOpenError(null));
  useAutoDismiss(scanInputError, 8000, () => getStore().setScanInputError(null));
  useAutoDismiss(
    menuInfo,
    8000,
    () => getStore().setMenuInfo(null),
    undefined,
    !menuInfoPersistent,
  );

  // Clear any stale scan-input error once the source filter becomes valid.
  useEffect(() => {
    if (!channelSearchError) {
      getStore().setScanInputError(null);
    }
  }, [channelSearchError]);

  return (
    <>
      {Object.values(archiveDownloads).map((download) => (
        <ArchiveDownloadBanner key={download.id} download={download} />
      ))}
      {scanError && !errorDismissed && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{scanError}</span>
          <button
            onClick={() => getStore().setErrorDismissed(true)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
            aria-label={t("banners.dismissScanError")}
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
            aria-label={t("banners.dismissPlaybackError")}
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
            aria-label={t("banners.dismissPlaylistError")}
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
            aria-label={t("banners.dismissInputError")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <DispatcharrConvertBanner />
      <DispatcharrProviderDownBanners onRescan={onScanRows} onReload={onReloadSource} />

      {menuInfo && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-500/10 border-b border-blue-500/20 text-blue-400 text-[13px]">
          <Info className="w-4 h-4" />
          <span className="flex-1">{menuInfo}</span>
          <button
            onClick={() => getStore().setMenuInfo(null)}
            className="p-1 hover:bg-blue-500/20 rounded transition-colors"
            type="button"
            aria-label={t("banners.dismissNotification")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {updateNotice && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-[13px]">
          <span className="flex-1">{updateBannerMessage(updateNotice, appVersion)}</span>
          <button
            type="button"
            disabled={updatePhase === "installing"}
            onClick={() => {
              if (!window.confirm(updateConfirmMessage(updateNotice))) return;
              void onInstallUpdate();
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-400/30 hover:bg-emerald-500/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {updateActionLabel(updateNotice, updatePhase)}
            {isManualInstall(updateNotice.installMode) ? (
              <ExternalLink className="w-3.5 h-3.5" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={dismissUpdateNotice}
            className="p-1 hover:bg-emerald-500/20 rounded transition-colors"
            type="button"
            aria-label={t("banners.update.dismiss")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
}
