import type { StateCreator } from "zustand";
import type { AppStore, ScanSlice, ScanTelemetry } from "../types";

export const EMPTY_TELEMETRY: ScanTelemetry = {
  throughputChannelsPerSecond: null,
  etaSeconds: null,
};

export const createScanSlice: StateCreator<AppStore, [], [], ScanSlice> = (set) => ({
  results: [],
  flatResults: [],
  uiMetrics: { presentCount: 0, lowFpsCount: 0, mislabeledCount: 0 },
  duplicateIndices: new Set(),
  progress: null,
  summary: null,
  scanState: "idle",
  scanError: null,
  telemetry: EMPTY_TELEMETRY,
  screenshotsPaused: false,
  networkPaused: false,

  setResults: (results) => set({ results }),
  setFlatResults: (flatResults) => set({ flatResults }),
  setUiMetrics: (uiMetrics) => set({ uiMetrics }),
  setDuplicateIndices: (duplicateIndices) => set({ duplicateIndices }),
  setProgress: (progress) => set({ progress }),
  setSummary: (summary) => set({ summary }),
  setScanState: (scanState) => set({ scanState }),
  setScanError: (scanError) => set({ scanError }),
  setTelemetry: (telemetry) => set({ telemetry }),
  setScreenshotsPaused: (screenshotsPaused) => set({ screenshotsPaused }),
  setNetworkPaused: (networkPaused) => set({ networkPaused }),
});
