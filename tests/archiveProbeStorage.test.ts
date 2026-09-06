import { describe, expect, it } from "bun:test";
import type { ArchiveProbeEntry } from "../src/lib/archiveProbe";
import {
  archiveProbeStorageKey,
  loadArchiveProbes,
  saveArchiveProbes,
} from "../src/lib/archiveProbeStorage";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

const done: ArchiveProbeEntry = {
  running: false,
  checkedAt: 1_700_000_000,
  outcomes: [
    {
      label: "Archive −1 h",
      daysBack: 0,
      ok: true,
      depthVerified: true,
      requestedStartEpochS: 1,
      requestUrl: "http://host/a",
      responseUrl: "http://host/a.ts",
      latencyMs: 200,
      error: null,
    },
  ],
};

describe("archive probe storage", () => {
  it("keys by source identity, falling back to the file path", () => {
    expect(archiveProbeStorageKey({ source_identity: "xtream:u@host", file_path: "/x" })).toBe(
      "catchup-verdicts:xtream:u@host",
    );
    expect(archiveProbeStorageKey({ source_identity: null, file_path: "/tmp/list.m3u" })).toBe(
      "catchup-verdicts:/tmp/list.m3u",
    );
  });

  it("persists only completed entries and restores only URL-matched channels", () => {
    const storage = memoryStorage();
    const results = [
      { index: 1, url: "http://host/1" },
      { index: 2, url: "http://host/2" },
    ];
    saveArchiveProbes(
      "k",
      { 1: done, 2: { ...done, running: true, checkedAt: null } },
      results,
      storage,
    );
    expect(loadArchiveProbes("k", results, storage)).toEqual({ 1: done });
    // The list was re-downloaded and channel 1 is now a different stream.
    expect(loadArchiveProbes("k", [{ index: 1, url: "http://host/other" }], storage)).toBeNull();
  });

  it("removes the key when nothing is left to keep", () => {
    const storage = memoryStorage();
    storage.setItem("k", "{}");
    saveArchiveProbes("k", {}, [], storage);
    expect(storage.map.has("k")).toBe(false);
  });
});
