import type { LogLevel } from "@tauri-apps/plugin-log";

export interface AppLogEntry {
  id: number;
  timestampMs: number;
  level: LogLevel;
  message: string;
}

export const MAX_LOG_ENTRIES = 10_000;

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
