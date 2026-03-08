import type { StateCreator } from "zustand";
import type { AppStore, FilterSlice } from "../types";

export const createFilterSlice: StateCreator<AppStore, [], [], FilterSlice> = (set) => ({
  search: "",
  channelSearch: "",
  groupFilter: "all",
  statusFilter: "all",

  setSearch: (search) => set({ search }),
  setChannelSearch: (channelSearch) => set({ channelSearch }),
  setGroupFilter: (groupFilter) => set({ groupFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  clearAllFilters: () =>
    set({ search: "", channelSearch: "", groupFilter: "all", statusFilter: "all" }),
});
