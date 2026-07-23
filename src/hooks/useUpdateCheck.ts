import { useCallback, useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../store";
import type { UpdateNotice } from "../store/types";
import { errorToString } from "../lib/errors";

const UPDATE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;
const UPDATE_LAST_CHECK_KEY = "updates:last-check-epoch-ms";
const UPDATE_CACHE_KEY = "updates:last-available-release";
const GITHUB_LATEST_RELEASE_API =
  "https://api.github.com/repos/kristofferR/IPTVChecker/releases/latest";
const GITHUB_RELEASES_PAGE =
  "https://github.com/kristofferR/IPTVChecker/releases";

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function parseVersionParts(version: string): number[] {
  const numeric = normalizeVersion(version)
    .split(".")
    .map((part) => {
      const matched = part.match(/^\d+/);
      return matched ? Number.parseInt(matched[0], 10) : 0;
    });
  return numeric.length > 0 ? numeric : [0];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }

  return 0;
}

function readCachedUpdateNotice(): UpdateNotice | null {
  const raw = localStorage.getItem(UPDATE_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UpdateNotice;
    if (!parsed.latest_version || !parsed.release_url) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function shouldSkipUpdateCheck(
  force: boolean,
  now: number,
  lastCheckedRaw: string | null,
): boolean {
  const lastChecked = lastCheckedRaw
    ? Number.parseInt(lastCheckedRaw, 10)
    : Number.NaN;
  return (
    !force &&
    Number.isFinite(lastChecked) &&
    now - lastChecked < UPDATE_CHECK_COOLDOWN_MS
  );
}

/** Clears the update banner and its cached release info (used by the banner's
 *  dismiss button). */
export function dismissUpdateNotice(): void {
  getStore().setUpdateNotice(null);
  localStorage.removeItem(UPDATE_CACHE_KEY);
}

/** Checks GitHub releases for a newer version. Runs an initial (cooldown-gated)
 *  check on mount and returns `checkForUpdates` for the menu's manual check. */
export function useUpdateCheck(): {
  checkForUpdates: (force: boolean, knownCurrentVersion?: string) => Promise<void>;
} {
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const checkForUpdates = useCallback(
    async (force: boolean, knownCurrentVersion?: string) => {
      const now = Date.now();
      const lastCheckedRaw = localStorage.getItem(UPDATE_LAST_CHECK_KEY);
      if (shouldSkipUpdateCheck(force, now, lastCheckedRaw)) {
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      activeControllerRef.current?.abort();
      const controller = new AbortController();
      activeControllerRef.current = controller;
      const timeout = setTimeout(
        () => controller.abort(),
        UPDATE_CHECK_TIMEOUT_MS,
      );
      const isCurrentRequest = () => requestIdRef.current === requestId;

      try {
        const currentVersion = normalizeVersion(
          knownCurrentVersion ?? (await getVersion()),
        );
        if (!isCurrentRequest() || controller.signal.aborted) return;
        getStore().setAppVersion(currentVersion);

        const response = await fetch(GITHUB_LATEST_RELEASE_API, {
          headers: {
            Accept: "application/vnd.github+json",
          },
          signal: controller.signal,
        });

        if (!isCurrentRequest() || controller.signal.aborted) return;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const release = (await response.json()) as {
          tag_name?: string;
          html_url?: string;
        };

        if (!isCurrentRequest() || controller.signal.aborted) return;
        const latestVersion = normalizeVersion(release.tag_name ?? "");
        if (!latestVersion) {
          throw new Error("Latest release version is missing");
        }

        localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(now));

        if (compareVersions(latestVersion, currentVersion) > 0) {
          const notice: UpdateNotice = {
            latest_version: latestVersion,
            release_url: release.html_url || GITHUB_RELEASES_PAGE,
            checked_at_epoch_ms: now,
          };
          getStore().setUpdateNotice(notice);
          localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(notice));
          return;
        }

        getStore().setUpdateNotice(null);
        localStorage.removeItem(UPDATE_CACHE_KEY);
        if (force) {
          getStore().setMenuInfo(`You're up to date (v${currentVersion}).`);
        }
      } catch (err) {
        if (!isCurrentRequest()) return;
        if (force) {
          const detail = controller.signal.aborted
            ? "Request timed out."
            : errorToString(err);
          getStore().setMenuInfo(`Update check failed: ${detail}`);
        }
      } finally {
        clearTimeout(timeout);
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const runInitialUpdateCheck = async () => {
      let currentVersion = "";
      try {
        currentVersion = normalizeVersion(await getVersion());
        if (!cancelled) {
          getStore().setAppVersion(currentVersion);
        }
      } catch {
        currentVersion = "";
      }

      if (cancelled) return;

      const cachedNotice = readCachedUpdateNotice();
      if (
        cachedNotice &&
        currentVersion &&
        compareVersions(cachedNotice.latest_version, currentVersion) > 0
      ) {
        getStore().setUpdateNotice(cachedNotice);
      } else if (cachedNotice) {
        localStorage.removeItem(UPDATE_CACHE_KEY);
      }

      await checkForUpdates(false, currentVersion || undefined);
    };

    void runInitialUpdateCheck();
    return () => {
      cancelled = true;
      requestIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [checkForUpdates]);

  return { checkForUpdates };
}
