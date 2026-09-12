import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  archiveChannelKey,
  prefersArchiveRemux,
  rememberArchiveRemux,
} from "../src/lib/archivePlaybackPreference";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let stored = new Map<string, string>();
beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

it("persists the channel preference without credentials and can forget a failing route", async () => {
  const url = "https://provider.example/live/user/secret/123.ts";
  const key = await archiveChannelKey(url);
  expect(prefersArchiveRemux(key)).toBe(false);
  rememberArchiveRemux(key, true);
  expect(prefersArchiveRemux(await archiveChannelKey(url))).toBe(true);
  expect(prefersArchiveRemux(await archiveChannelKey(url.replace("123", "456")))).toBe(false);
  expect(prefersArchiveRemux(await archiveChannelKey(url.replace("provider", "other")))).toBe(
    false,
  );
  expect([...stored.values()].join()).not.toContain("secret");
  rememberArchiveRemux(key, false);
  expect(prefersArchiveRemux(key)).toBe(false);
});

it("bounds remembered channels and refreshes recently successful ones", () => {
  const key = (n: number) => n.toString(16).padStart(64, "0");
  for (let n = 0; n < 200; n++) rememberArchiveRemux(key(n), true);
  rememberArchiveRemux(key(0), true);
  rememberArchiveRemux(key(200), true);
  expect(prefersArchiveRemux(key(0))).toBe(true);
  expect(prefersArchiveRemux(key(1))).toBe(false);
  expect(prefersArchiveRemux(key(200))).toBe(true);
});

it("ignores malformed or unavailable storage", () => {
  const key = "a".repeat(64);
  rememberArchiveRemux(key, true);
  const storageKey = [...stored.keys()][0];
  if (!storageKey) throw new Error("Missing preference storage key");
  for (const value of ["{", "null", "{}", '[null,42,"invalid"]']) {
    stored.set(storageKey, value);
    expect(prefersArchiveRemux(key)).toBe(false);
  }
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("Storage unavailable");
    },
  });
  expect(prefersArchiveRemux(key)).toBe(false);
  expect(() => rememberArchiveRemux(key, true)).not.toThrow();
});
