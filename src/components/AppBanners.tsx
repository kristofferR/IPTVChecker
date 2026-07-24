import { useEffect, useMemo } from "react";
import { Download, ExternalLink, Info, X } from "lucide-react";
import { useAppStore } from "../store";
import { dismissUpdateNotice } from "../hooks/useUpdateCheck";
import {
  isManualInstall,
  updateActionLabel,
  updateBannerMessage,
  updateConfirmMessage,
} from "../lib/updateState";
import { validateSourceFilterPattern } from "../lib/sourceFilter";

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

/** Shared banner auto-dismiss shape: whenever `value` becomes truthy, run
 *  `onShow` (optional) and schedule `dismiss` after `timeoutMs`. */
function useAutoDismiss(
  value: unknown,
  timeoutMs: number,
  dismiss: () => void,
  onShow?: () => void,
) {
  useEffect(() => {
    if (!value) return;
    onShow?.();
    const timer = setTimeout(dismiss, timeoutMs);
    return () => clearTimeout(timer);
    // Callbacks are stable store writes; only the banner value drives re-arming.
  }, [value]);
}

interface AppBannersProps {
  /** Installs the discovered update, or opens the distribution's update page
   *  for package-manager-owned installations. */
  onInstallUpdate: () => void | Promise<void>;
}

/** The transient error/info banners shown under the toolbar, with their
 *  auto-dismiss timers. The update banner is the one persistent entry. */
export function AppBanners({ onInstallUpdate }: AppBannersProps) {
  const scanError = useAppStore((s) => s.scanError);
  const errorDismissed = useAppStore((s) => s.errorDismissed);
  const playbackError = useAppStore((s) => s.playbackError);
  const playlistOpenError = useAppStore((s) => s.playlistOpenError);
  const scanInputError = useAppStore((s) => s.scanInputError);
  const menuInfo = useAppStore((s) => s.menuInfo);
  const updateNotice = useAppStore((s) => s.updateNotice);
  const updatePhase = useAppStore((s) => s.updatePhase);
  const appVersion = useAppStore((s) => s.appVersion);
  const channelSearch = useAppStore((s) => s.channelSearch);
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
  useAutoDismiss(playlistOpenError, 10000, () =>
    getStore().setPlaylistOpenError(null),
  );
  useAutoDismiss(scanInputError, 8000, () => getStore().setScanInputError(null));
  useAutoDismiss(menuInfo, 8000, () => getStore().setMenuInfo(null));

  // Clear any stale scan-input error once the source filter becomes valid.
  useEffect(() => {
    if (!channelSearchError) {
      getStore().setScanInputError(null);
    }
  }, [channelSearchError]);

  return (
    <>
      {scanError && !errorDismissed && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-400 text-[13px]">
          <span className="flex-1">{scanError}</span>
          <button
            onClick={() => getStore().setErrorDismissed(true)}
            className="p-1 hover:bg-red-500/20 rounded transition-colors"
            type="button"
            aria-label="Dismiss scan error"
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
            aria-label="Dismiss playback error"
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
            aria-label="Dismiss playlist error"
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
            aria-label="Dismiss input error"
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
            aria-label="Dismiss notification"
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
            aria-label="Dismiss update notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
}
