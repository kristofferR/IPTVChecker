import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { errorToString } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  discoveredUpdate,
  checkForUpdates as invokeCheckForUpdates,
  installUpdate as invokeInstallUpdate,
  openManualUpdate,
  updateInstallMode,
} from "../lib/tauri";
import type { UpdateInstallMode } from "../lib/updateState";
import { isManualInstall, updateFailureDetail } from "../lib/updateState";
import { useAppStore } from "../store";

/** Emitted by the backend's periodic check when it finds a new version. */
const UPDATE_AVAILABLE_EVENT = "updater://update-available";

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

/** Clears the update banner. The backend keeps its own discovery, so a later
 *  manual check can surface the same version again. */
export function dismissUpdateNotice(): void {
  getStore().setUpdateNotice(null);
}

/**
 * Drives the signed in-app updater.
 *
 * Discovery and installation are deliberately separate: nothing is downloaded
 * until `installUpdate` is called, and installs on package-manager-owned
 * copies (AUR, .deb/.rpm) are redirected to the distribution's page instead of
 * replacing files the package manager owns.
 */
export function useUpdateCheck(): {
  checkForUpdates: (force: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
} {
  const requestIdRef = useRef(0);
  const installModeRef = useRef<UpdateInstallMode | null>(null);
  const installModeRequestRef = useRef<Promise<UpdateInstallMode> | null>(null);

  // The install mode cannot change while the app runs, and detecting it shells
  // out to pacman on Linux, so resolve it once. The in-flight promise is shared
  // too: the mount effect and a manual check can ask concurrently, and that
  // should not run detection twice.
  const resolveInstallMode = useCallback(async (): Promise<UpdateInstallMode> => {
    if (installModeRef.current) return installModeRef.current;
    if (!installModeRequestRef.current) {
      installModeRequestRef.current = updateInstallMode()
        .then((mode) => {
          installModeRef.current = mode;
          return mode;
        })
        .finally(() => {
          // Clear on failure too, so a later attempt can retry.
          installModeRequestRef.current = null;
        });
    }
    return installModeRequestRef.current;
  }, []);

  const checkForUpdates = useCallback(
    async (force: boolean) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const isCurrentRequest = () => requestIdRef.current === requestId;

      getStore().setUpdatePhase("checking");
      try {
        const [result, installMode] = await Promise.all([
          invokeCheckForUpdates(),
          resolveInstallMode(),
        ]);
        if (!isCurrentRequest()) return;

        if (result.version) {
          getStore().setUpdateNotice({
            version: result.version,
            notes: result.notes,
            installMode,
          });
          return;
        }

        getStore().setUpdateNotice(null);
        if (force) {
          const current = getStore().appVersion;
          getStore().setMenuInfo(`You're up to date${current ? ` (v${current})` : ""}.`);
        }
      } catch (err) {
        if (!isCurrentRequest()) return;
        logger.error("[Update] Check failed:", errorToString(err));
        if (force) {
          getStore().setMenuInfo(`Update check failed: ${updateFailureDetail(errorToString(err))}`);
        }
      } finally {
        if (isCurrentRequest()) getStore().setUpdatePhase("idle");
      }
    },
    [resolveInstallMode],
  );

  /** Installs the discovered update, or opens the distribution's update page
   *  when this copy is owned by a package manager. */
  const installUpdate = useCallback(async () => {
    const notice = getStore().updateNotice;
    if (!notice) return;

    if (isManualInstall(notice.installMode)) {
      try {
        await openManualUpdate();
      } catch (err) {
        logger.error("[Update] Failed to open the update page:", errorToString(err));
        getStore().setMenuInfo(
          `Could not open the update page: ${updateFailureDetail(errorToString(err))}`,
        );
      }
      return;
    }

    getStore().setUpdatePhase("installing");
    try {
      // On success the app restarts, so nothing after this runs.
      const installed = await invokeInstallUpdate();
      if (!installed) {
        getStore().setUpdateNotice(null);
        getStore().setMenuInfo("IPTV Checker is already up to date.");
      }
    } catch (err) {
      logger.error("[Update] Install failed:", errorToString(err));
      getStore().setMenuInfo(`Update install failed: ${updateFailureDetail(errorToString(err))}`);
    } finally {
      getStore().setUpdatePhase("idle");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Adopt whatever the backend's startup check already found instead of
    // issuing a second network request from the frontend.
    const adoptExistingDiscovery = async () => {
      try {
        const [version, currentVersion, installMode] = await Promise.all([
          discoveredUpdate(),
          getVersion(),
          resolveInstallMode(),
        ]);
        if (cancelled) return;
        getStore().setAppVersion(currentVersion.replace(/^v/i, ""));
        if (version) {
          getStore().setUpdateNotice({ version, notes: null, installMode });
        }
      } catch (err) {
        logger.error("[Update] Initial update state failed:", errorToString(err));
      }
    };

    void adoptExistingDiscovery();

    const unlisten = listen<string>(UPDATE_AVAILABLE_EVENT, (event) => {
      void (async () => {
        try {
          const installMode = await resolveInstallMode();
          if (cancelled) return;
          getStore().setUpdateNotice({ version: event.payload, notes: null, installMode });
        } catch (err) {
          logger.error("[Update] Failed to surface a discovered update:", errorToString(err));
        }
      })();
    });

    return () => {
      cancelled = true;
      requestIdRef.current += 1;
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, [resolveInstallMode]);

  return { checkForUpdates, installUpdate };
}
