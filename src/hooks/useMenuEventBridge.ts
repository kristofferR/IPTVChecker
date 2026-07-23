import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppSettings,
  PlaylistLoadProgress,
  RecentPlaylistEntry,
} from "../lib/types";
import { useAppStore } from "../store";

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

export interface MenuEventHandlers {
  handleOpen: () => void | Promise<void>;
  handleOpenFolder: () => void | Promise<void>;
  handleOpenUrl: () => void;
  handleExternalOpenPaths: (paths: string[]) => void;
  handleOpenRecent: (entry: RecentPlaylistEntry) => void;
  handleOpenSaved: (id: string) => void;
  handleClearRecentPlaylists: () => void | Promise<void>;
  handleManageSavedPlaylists: () => void;
  handleToggleSidebar: () => void;
  handleToggleReport: () => void;
  handleStartScan: () => void | Promise<void>;
  pause: () => void | Promise<void>;
  resume: () => void | Promise<void>;
  cancel: () => void | Promise<void>;
  openHistoryPanel: () => void;
  handleOpenSettings: () => void | Promise<void>;
  handleOpenLog: () => void | Promise<void>;
  checkForUpdates: (force: boolean) => void | Promise<void>;
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

/** Bridges native menu events (and external open requests) to app handlers.
 *
 *  All handlers are mirrored into a single ref updated every render, so the
 *  Tauri listeners are registered exactly once and never need re-registration.
 *  Listener registration runs in parallel via Promise.all with a cancelled
 *  flag so cleanup never leaves orphaned listeners behind. */
export function useMenuEventBridge(handlers: MenuEventHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const queueExport = (action: "csv" | "split" | "renamed" | "m3u" | "scanlog") => {
      getStore().queueMenuExportRequest(action);
    };

    const setup = async () => {
      const listeners = await Promise.all([
        listen("menu://open-playlist", () => void handlersRef.current.handleOpen()),
        listen("menu://open-folder", () => void handlersRef.current.handleOpenFolder()),
        listen("menu://open-url", () => void handlersRef.current.handleOpenUrl()),
        listen<string[]>("app://open-paths", (event) => {
          handlersRef.current.handleExternalOpenPaths(event.payload);
        }),
        ...Array.from({ length: 10 }, (_, i) =>
          listen(`menu://open-recent-${i}`, () => {
            const entry = getStore().recentPlaylists[i];
            if (entry) handlersRef.current.handleOpenRecent(entry);
          }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          listen(`menu://open-saved-${i}`, () => {
            const entry = getStore().savedPlaylists[i];
            if (entry) handlersRef.current.handleOpenSaved(entry.id);
          }),
        ),
        listen("menu://clear-recent", () => void handlersRef.current.handleClearRecentPlaylists()),
        listen("menu://manage-saved", () => handlersRef.current.handleManageSavedPlaylists()),
        listen("menu://export-csv", () => queueExport("csv")),
        listen("menu://export-split", () => queueExport("split")),
        listen("menu://export-renamed", () => queueExport("renamed")),
        listen("menu://export-filtered-m3u", () => queueExport("m3u")),
        listen("menu://export-scan-log", () => queueExport("scanlog")),
        listen("menu://toggle-sidebar", () => handlersRef.current.handleToggleSidebar()),
        listen("menu://toggle-report", () => handlersRef.current.handleToggleReport()),
        listen("menu://toggle-prescan-filter", () => {
          const current = handlersRef.current.settings;
          void handlersRef.current.saveSettings({
            ...current,
            show_prescan_filter: !current.show_prescan_filter,
          });
        }),
        listen("menu://toggle-header-button-text", () => {
          const current = handlersRef.current.settings;
          void handlersRef.current.saveSettings({
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
        listen("menu://open-history", () => handlersRef.current.openHistoryPanel()),
        listen("menu://start-scan", () => void handlersRef.current.handleStartScan()),
        listen("menu://pause-scan", () => void handlersRef.current.pause()),
        listen("menu://resume-scan", () => void handlersRef.current.resume()),
        listen("menu://stop-scan", () => void handlersRef.current.cancel()),
        listen("menu://open-settings", () => void handlersRef.current.handleOpenSettings()),
        listen("menu://open-log", () => void handlersRef.current.handleOpenLog()),
        listen("menu://check-updates", () => void handlersRef.current.checkForUpdates(true)),
        listen("menu://keyboard-shortcuts", () => getStore().setShowKeyboardShortcuts(true)),
        listen<PlaylistLoadProgress>(
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
}
