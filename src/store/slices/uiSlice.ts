import type { StateCreator } from "zustand";
import type { AppStore, UiSlice } from "../types";
import { inferPlatformFromNavigator } from "../../lib/platform";
import { isScanActive } from "../../lib/scanState";

const initialPlatform = inferPlatformFromNavigator();

export const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set, get) => ({
  platform: initialPlatform,
  isMac: initialPlatform === "macos",
  sidebarHidden: false,
  sidebarWidth: (() => {
    const saved = localStorage.getItem("sidebar-width");
    return saved ? Math.max(100, Math.min(600, Number(saved))) : 288;
  })(),
  showReportPanel: false,
  reportAutoRevealBlocked: false,
  reportAutoRevealDone: false,
  reportWasAutoShown: false,
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
  scanInputError: null,
  menuInfo: null,
  menuExportRequest: null,
  updateNotice: null,
  appVersion: "",
  openSourceDialogState: null,

  setPlatform: (platform) => set({ platform, isMac: platform === "macos" }),
  setSidebarHidden: (sidebarHidden) => set({ sidebarHidden }),
  toggleSidebar: () => set((state) => ({ sidebarHidden: !state.sidebarHidden })),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  // Manual visibility changes own the auto-reveal bookkeeping so every
  // entry point (toolbar, menu, stats bar) behaves identically: during an
  // active scan, manually opening marks auto-reveal done and manually
  // closing blocks it from popping the panel back open.
  setReportPanelManually: (visible) =>
    set((state) => {
      const active = isScanActive(state.scanState);
      return {
        showReportPanel: visible,
        reportWasAutoShown: false,
        ...(active
          ? visible
            ? { reportAutoRevealBlocked: false, reportAutoRevealDone: true }
            : { reportAutoRevealBlocked: true }
          : {}),
      };
    }),
  toggleReportPanel: () => {
    const state = get();
    state.setReportPanelManually(!state.showReportPanel);
  },
  resetReportAutoReveal: () =>
    set({
      showReportPanel: false,
      reportAutoRevealBlocked: false,
      reportAutoRevealDone: false,
      reportWasAutoShown: false,
    }),
  prepareReportAutoRevealForScanStart: () =>
    set((state) => ({
      reportAutoRevealBlocked: false,
      reportAutoRevealDone: false,
      reportWasAutoShown: false,
      showReportPanel:
        state.reportWasAutoShown && state.showReportPanel
          ? false
          : state.showReportPanel,
    })),
  autoRevealReportPanel: () =>
    set({
      reportAutoRevealDone: true,
      reportWasAutoShown: true,
      showReportPanel: true,
    }),
  setShowReportPanel: (showReportPanel) => set({ showReportPanel }),
  setReportSidebarWidth: (reportSidebarWidth) => set({ reportSidebarWidth }),
  setLightboxOpen: (lightboxOpen) => set({ lightboxOpen }),
  toggleLightboxOpen: () => set((state) => ({ lightboxOpen: !state.lightboxOpen })),
  setShowKeyboardShortcuts: (showKeyboardShortcuts) => set({ showKeyboardShortcuts }),
  setIsDragOver: (isDragOver) => set({ isDragOver }),
  setFfmpegWarning: (ffmpegWarning) => set({ ffmpegWarning }),
  setErrorDismissed: (errorDismissed) => set({ errorDismissed }),
  setPlaybackError: (playbackError) => set({ playbackError }),
  setScanInputError: (scanInputError) => set({ scanInputError }),
  setMenuInfo: (menuInfo) => set({ menuInfo }),
  setMenuExportRequest: (menuExportRequest) => set({ menuExportRequest }),
  queueMenuExportRequest: (action) =>
    set((state) => ({
      menuExportRequest: { id: (state.menuExportRequest?.id ?? 0) + 1, action },
    })),
  setUpdateNotice: (updateNotice) => set({ updateNotice }),
  setAppVersion: (appVersion) => set({ appVersion }),
  setOpenSourceDialogState: (openSourceDialogState) => set({ openSourceDialogState }),
});
