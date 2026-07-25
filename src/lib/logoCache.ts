import { useCallback, useEffect, useSyncExternalStore } from "react";

export type LogoCacheStatus = "idle" | "loading" | "ready" | "error";

interface LogoCacheEntry {
  status: LogoCacheStatus;
  listeners: Set<() => void>;
  promise: Promise<void> | null;
}

const LOGO_CACHE_LIMIT = 4096;
const logoCache = new Map<string, LogoCacheEntry>();

function notify(entry: LogoCacheEntry): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

function evictLogoCacheEntries(): void {
  if (logoCache.size <= LOGO_CACHE_LIMIT) {
    return;
  }

  for (const [url, entry] of logoCache) {
    if (logoCache.size <= LOGO_CACHE_LIMIT) {
      return;
    }
    if (entry.listeners.size > 0 || entry.promise !== null) {
      continue;
    }
    logoCache.delete(url);
  }
}

function getOrCreateLogoEntry(url: string): LogoCacheEntry {
  const existing = logoCache.get(url);
  if (existing) {
    logoCache.delete(url);
    logoCache.set(url, existing);
    return existing;
  }

  const next: LogoCacheEntry = {
    status: "idle",
    listeners: new Set(),
    promise: null,
  };
  logoCache.set(url, next);
  evictLogoCacheEntries();
  return next;
}

function loadLogo(url: string, entry: LogoCacheEntry): void {
  if (entry.status === "ready" || entry.status === "error" || entry.promise) {
    return;
  }

  entry.status = "loading";
  notify(entry);

  const image = new Image();
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";

  entry.promise = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`failed to load logo: ${url}`));
    image.src = url;
    if (image.complete && image.naturalWidth > 0) {
      resolve();
    }
  })
    .then(async () => {
      try {
        if (typeof image.decode === "function") {
          await image.decode();
        }
      } catch {
        // Browsers can reject decode() for already-decoded or SVG images.
      }
      entry.status = "ready";
      notify(entry);
    })
    .catch(() => {
      entry.status = "error";
      notify(entry);
    })
    .finally(() => {
      image.onload = null;
      image.onerror = null;
      entry.promise = null;
    });
}

function subscribeToLogo(url: string, onStoreChange: () => void): () => void {
  const entry = getOrCreateLogoEntry(url);
  entry.listeners.add(onStoreChange);
  return () => {
    entry.listeners.delete(onStoreChange);
  };
}

function getLogoStatus(url: string | null): LogoCacheStatus {
  if (!url) {
    return "idle";
  }
  return getOrCreateLogoEntry(url).status;
}

export function useLogoCacheStatus(url: string | null): LogoCacheStatus {
  const subscribe = useCallback(
    (onStoreChange: () => void) => (url ? subscribeToLogo(url, onStoreChange) : () => {}),
    [url],
  );
  const getSnapshot = useCallback(() => getLogoStatus(url), [url]);

  useEffect(() => {
    if (!url) {
      return;
    }
    loadLogo(url, getOrCreateLogoEntry(url));
  }, [url]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
