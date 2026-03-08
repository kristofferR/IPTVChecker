import type { StateCreator } from "zustand";
import type { AppStore, UiSlice } from "../types";
import { inferPlatformFromNavigator } from "../../lib/platform";

const initialPlatform = inferPlatformFromNavigator();

export const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set) => ({
  platform: initialPlatform,
  isMac: initialPlatform === "macos",
  sidebarHidden: false,
  sidebarWidth: (() => {
    const saved = localStorage.getItem("sidebar-width");
    return saved ? Math.max(100, Math.min(600, Number(saved))) : 288;
  })(),
  showReportPanel: false,
  reportSidebarWidth: (() => {
    const saved = localStorage.getItem("report-sidebar-width");
    return saved ? Math.max(260, Math.min(700, Number(saved))) : 330;
  })(),
  lightboxOpen: false,
  showKeyboardShortcuts: false,
  isDragOver: false,
  ffmpegWarning: false,
  errorDismissed: false,
  playbackError: null,
  playlistOpenError: null,
  scanInputError: null,
  menuInfo: null,
  menuExportRequest: null,
  updateNotice: null,
  appVersion: "",
  openSourceDialogState: null,

  setPlatform: (platform) => set({ platform, isMac: platform === "macos" }),
  toggleSidebar: () => set((state) => ({ sidebarHidden: !state.sidebarHidden })),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  toggleReportPanel: () => set((state) => ({ showReportPanel: !state.showReportPanel })),
  setShowReportPanel: (showReportPanel) => set({ showReportPanel }),
  setReportSidebarWidth: (reportSidebarWidth) => set({ reportSidebarWidth }),
  setLightboxOpen: (lightboxOpen) => set({ lightboxOpen }),
  setShowKeyboardShortcuts: (showKeyboardShortcuts) => set({ showKeyboardShortcuts }),
  setIsDragOver: (isDragOver) => set({ isDragOver }),
  setFfmpegWarning: (ffmpegWarning) => set({ ffmpegWarning }),
  setErrorDismissed: (errorDismissed) => set({ errorDismissed }),
  setPlaybackError: (playbackError) => set({ playbackError }),
  setScanInputError: (scanInputError) => set({ scanInputError }),
  setMenuInfo: (menuInfo) => set({ menuInfo }),
  setMenuExportRequest: (menuExportRequest) => set({ menuExportRequest }),
  setUpdateNotice: (updateNotice) => set({ updateNotice }),
  setAppVersion: (appVersion) => set({ appVersion }),
  setOpenSourceDialogState: (openSourceDialogState) => set({ openSourceDialogState }),
});
