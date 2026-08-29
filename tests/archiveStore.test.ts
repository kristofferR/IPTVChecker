import { afterEach, describe, expect, it } from "bun:test";
import type { ArchiveProbeEntry } from "../src/lib/archiveProbe";
import { toPendingChannelResult } from "../src/lib/channelResults";
import type { Channel } from "../src/lib/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear() {},
    getItem() {
      return null;
    },
    key() {
      return null;
    },
    length: 0,
    removeItem() {},
    setItem() {},
  } satisfies Storage,
});

const { useAppStore } = await import("../src/store");

function result(url: string) {
  const channel: Channel = {
    index: 7,
    playlist: "fixture.m3u8",
    name: "Channel",
    group: "Group",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url,
    content_type: "live",
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
  };
  return toPendingChannelResult(channel);
}

const entry: ArchiveProbeEntry = {
  running: false,
  outcomes: [],
  checkedAt: 1,
};

describe("archive probe store", () => {
  afterEach(() => {
    useAppStore.setState({
      flatResults: [],
      resultPositions: new Map(),
      archiveProbes: {},
      archiveProbeGeneration: 0,
    });
  });

  it("discards updates from a superseded playlist generation", () => {
    const currentResult = result("https://new.example/channel.ts");
    useAppStore.setState({
      flatResults: [currentResult],
      resultPositions: new Map([[currentResult.index, 0]]),
      archiveProbes: {},
      archiveProbeGeneration: 2,
    });

    useAppStore.getState().setArchiveProbe(2, currentResult.index, entry);
    expect(useAppStore.getState().archiveProbes).toEqual({ [currentResult.index]: entry });

    useAppStore.getState().clearArchiveProbes();
    expect(useAppStore.getState().archiveProbeGeneration).toBe(3);
    expect(useAppStore.getState().archiveProbes).toEqual({});

    useAppStore.getState().setArchiveProbe(2, currentResult.index, entry);
    expect(useAppStore.getState().archiveProbes).toEqual({});
  });
});
