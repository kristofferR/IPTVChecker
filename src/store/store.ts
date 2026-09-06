import { create } from "zustand";
import { createArchiveSlice } from "./slices/archiveSlice";
import { createFilterSlice } from "./slices/filterSlice";
import { createHistorySlice } from "./slices/historySlice";
import { createPlayerSlice } from "./slices/playerSlice";
import { createPlaylistSlice } from "./slices/playlistSlice";
import { createScanSlice } from "./slices/scanSlice";
import { createSelectionSlice } from "./slices/selectionSlice";
import { createSettingsSlice } from "./slices/settingsSlice";
import { createUiSlice } from "./slices/uiSlice";
import type { AppStore } from "./types";

export const useAppStore = create<AppStore>()((...a) => ({
  ...createPlaylistSlice(...a),
  ...createScanSlice(...a),
  ...createFilterSlice(...a),
  ...createSelectionSlice(...a),
  ...createUiSlice(...a),
  ...createPlayerSlice(...a),
  ...createHistorySlice(...a),
  ...createSettingsSlice(...a),
  ...createArchiveSlice(...a),
}));
