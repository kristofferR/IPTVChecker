import type { StateCreator } from "zustand";
import type { AppStore, DispatcharrSlice } from "../types";

export const createDispatcharrSlice: StateCreator<AppStore, [], [], DispatcharrSlice> = (set) => ({
  dispatcharrOrders: {},
  dispatcharrUndo: {},
  dispatcharrRowStates: {},
  dispatcharrToast: null,
  dispatcharrFind: null,

  setDispatcharrRowState: (channelId, rowState) =>
    set((state) => {
      const { [channelId]: _previous, ...rest } = state.dispatcharrRowStates;
      return { dispatcharrRowStates: rowState ? { ...rest, [channelId]: rowState } : rest };
    }),
  commitDispatcharrOrder: (channelId, order, undoOrder) =>
    set((state) => {
      const { [channelId]: _previous, ...undo } = state.dispatcharrUndo;
      return {
        dispatcharrOrders: { ...state.dispatcharrOrders, [channelId]: order },
        dispatcharrUndo: undoOrder ? { ...undo, [channelId]: undoOrder } : undo,
      };
    }),
  setDispatcharrToast: (dispatcharrToast) => set({ dispatcharrToast }),
  setDispatcharrFind: (dispatcharrFind) => set({ dispatcharrFind }),
  resetDispatcharrEdits: () =>
    set({
      dispatcharrOrders: {},
      dispatcharrUndo: {},
      dispatcharrRowStates: {},
      dispatcharrToast: null,
      dispatcharrFind: null,
    }),
});
