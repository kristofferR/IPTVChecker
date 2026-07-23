import type { StateCreator } from "zustand";
import type {
  AppStore,
  ScanCollectionsUpdate,
  ScanRuntimeUpdate,
  ScanSlice,
  ScanTelemetry,
} from "../types";

export const EMPTY_TELEMETRY: ScanTelemetry = {
  throughputChannelsPerSecond: null,
  etaSeconds: null,
};

export const createScanSlice: StateCreator<AppStore, [], [], ScanSlice> = (set) => ({
  results: {},
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

  applyScanCollections: (update: ScanCollectionsUpdate) =>
    set({
      results: update.results,
      flatResults: update.flatResults,
      uiMetrics: update.uiMetrics,
    }),
  applyScanRuntime: (update: ScanRuntimeUpdate) => set(update),
});
