import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { ArchivePlayOptions } from "../hooks/useStreamPlayer";
import { useAppStore } from "../store";
import { resolveArchivePlayback } from "./archive";
import { logger } from "./logger";
import { cancelArchiveDownload as cancelArchiveDownloadCommand, downloadArchive } from "./tauri";
import type { ArchiveDownloadProgress, ChannelResult } from "./types";

export type ArchiveDownloadStatus = "running" | "done" | "failed" | "cancelled";

export interface ArchiveDownload {
  id: string;
  channelName: string;
  title: string;
  path: string;
  durationS: number;
  outTimeS: number;
  bytes: number;
  status: ArchiveDownloadStatus;
  error: string | null;
}

const PROGRESS_EVENT = "archive-download://progress";
let progressListener: Promise<() => void> | null = null;

function ensureProgressListener(): void {
  if (progressListener) return;
  progressListener = listen<ArchiveDownloadProgress>(PROGRESS_EVENT, (event) => {
    const { id, out_time_s, bytes } = event.payload;
    useAppStore.getState().patchArchiveDownload(id, { outTimeS: out_time_s, bytes });
  });
}

/** Filesystem-safe stem for the default recording name. */
export function recordingFileStem(
  channelName: string,
  title: string | undefined,
  startEpochS: number,
): string {
  const start = new Date(startEpochS * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(
    start.getHours(),
  )}${pad(start.getMinutes())}`;
  const clean = (part: string | undefined) =>
    (part ?? "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const parts = [clean(channelName), clean(title), stamp].filter((part) => part.length > 0);
  return parts.join(" - ").slice(0, 120) || "recording";
}

export function isArchiveDownloadRunning(
  downloads: Record<string, ArchiveDownload> = useAppStore.getState().archiveDownloads,
): boolean {
  return Object.values(downloads).some((download) => download.status === "running");
}

/**
 * Ask where to save, then record the programme's archive window to an MPEG-TS
 * file. Progress and completion land in the store for the banner to show.
 */
export async function startArchiveDownload(
  result: ChannelResult,
  options: ArchivePlayOptions,
): Promise<void> {
  const resolved = resolveArchivePlayback(result, {
    startEpochS: options.startEpochS,
    endEpochS: options.endEpochS,
  });
  if (!resolved) return;
  const durationS = Math.max(1, resolved.windowEndEpochS - resolved.startEpochS);
  const path = await save({
    defaultPath: `${recordingFileStem(result.name, options.title, resolved.startEpochS)}.ts`,
    filters: [{ name: "MPEG-TS", extensions: ["ts"] }],
  });
  if (!path) return;

  ensureProgressListener();
  const id = crypto.randomUUID();
  const store = useAppStore.getState();
  store.upsertArchiveDownload({
    id,
    channelName: result.name,
    title: options.title ?? "",
    path,
    durationS,
    outTimeS: 0,
    bytes: 0,
    status: "running",
    error: null,
  });
  logger.info(`[Download] Recording ${result.name} (${durationS}s) to ${path}`);
  try {
    await downloadArchive({ id, url: resolved.url, path, duration_s: durationS });
    useAppStore.getState().patchArchiveDownload(id, { status: "done", outTimeS: durationS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /cancelled/i.test(message);
    logger.warn(`[Download] ${cancelled ? "Cancelled" : "Failed"}: ${message}`);
    useAppStore.getState().patchArchiveDownload(id, {
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : message,
    });
  }
}

export async function cancelArchiveDownload(id: string): Promise<void> {
  await cancelArchiveDownloadCommand(id).catch(() => {});
}
