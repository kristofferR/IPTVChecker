import { LogLevel } from "@tauri-apps/plugin-log";

export interface AppLogEntry {
  id: number;
  timestampMs: number;
  level: LogLevel;
  message: string;
}

export const MAX_LOG_ENTRIES = 10_000;

export function formatLogTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function formatLogEntries(entries: readonly AppLogEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${formatLogTimestamp(entry.timestampMs)} ${LogLevel[entry.level].toUpperCase()} ${entry.message}`,
    )
    .join("\n");
}

export function mergeLogEntries(
  current: AppLogEntry[],
  incoming: AppLogEntry[],
  limit = MAX_LOG_ENTRIES,
): AppLogEntry[] {
  if (incoming.length === 0) return current;

  const incomingById = new Map(incoming.map((entry) => [entry.id, entry]));
  const sortedIncoming = [...incomingById.values()].sort((left, right) => left.id - right.id);
  const lastCurrentId = current[current.length - 1]?.id ?? -1;
  if ((sortedIncoming[0]?.id ?? -1) > lastCurrentId) {
    const combined = [...current, ...sortedIncoming];
    return combined.length > limit ? combined.slice(-limit) : combined;
  }

  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of sortedIncoming) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-limit);
}
