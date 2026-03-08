import { create } from "zustand";
import type { AppStore } from "./types";
import { createPlaylistSlice } from "./slices/playlistSlice";
import { createScanSlice } from "./slices/scanSlice";
import { createFilterSlice } from "./slices/filterSlice";
import { createSelectionSlice } from "./slices/selectionSlice";
import { createUiSlice } from "./slices/uiSlice";
import { createPlayerSlice } from "./slices/playerSlice";
import { createHistorySlice } from "./slices/historySlice";
import { createSettingsSlice } from "./slices/settingsSlice";

export const useAppStore = create<AppStore>()((...a) => ({
  ...createPlaylistSlice(...a),
  ...createScanSlice(...a),
  ...createFilterSlice(...a),
  ...createSelectionSlice(...a),
  ...createUiSlice(...a),
  ...createPlayerSlice(...a),
  ...createHistorySlice(...a),
  ...createSettingsSlice(...a),
}));
