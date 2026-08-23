import { emitTo, listen } from "@tauri-apps/api/event";
import { attachLogger } from "@tauri-apps/plugin-log";
import { type AppLogEntry, MAX_LOG_ENTRIES } from "./logEntries";

export const APP_LOG_ENTRY_EVENT = "app://log-entry";
export const APP_LOG_HISTORY_EVENT = "app://log-history";
export const APP_LOG_HISTORY_REQUEST_EVENT = "app://log-history-request";
export const APP_LOG_CLEAR_EVENT = "app://log-clear";

export interface AppLogHistoryRequest {
  requestId: string;
}

export interface AppLogHistoryResponse extends AppLogHistoryRequest {
  entries: AppLogEntry[];
}

let started = false;
let startPromise: Promise<void> | null = null;
let nextEntryId = 0;
let history: AppLogEntry[] = [];

async function setupMainLogBridge(): Promise<void> {
  const cleanup: Array<() => void> = [];

  try {
    cleanup.push(
      await attachLogger(({ level, message }) => {
        const entry: AppLogEntry = {
          id: nextEntryId++,
          timestampMs: Date.now(),
          level,
          message,
        };
        history.push(entry);
        if (history.length > MAX_LOG_ENTRIES) {
          history = history.slice(-MAX_LOG_ENTRIES);
        }
        void emitTo("log", APP_LOG_ENTRY_EVENT, entry).catch(() => {});
      }),
    );

    cleanup.push(
      await listen<AppLogHistoryRequest>(APP_LOG_HISTORY_REQUEST_EVENT, (event) => {
        const response: AppLogHistoryResponse = {
          requestId: event.payload.requestId,
          entries: [...history],
        };
        void emitTo("log", APP_LOG_HISTORY_EVENT, response).catch(() => {});
      }),
    );

    cleanup.push(
      await listen(APP_LOG_CLEAR_EVENT, () => {
        history = [];
      }),
    );
  } catch (error) {
    for (const off of cleanup.reverse()) off();
    throw error;
  }
}

export function startMainLogBridge(): Promise<void> {
  if (started) return Promise.resolve();
  if (startPromise) return startPromise;

  const startup = setupMainLogBridge()
    .then(() => {
      started = true;
    })
    .catch((error) => {
      console.error("[LogBridge] Failed to start", error);
      throw error;
    })
    .finally(() => {
      if (startPromise === startup) startPromise = null;
    });
  startPromise = startup;
  return startup;
}
