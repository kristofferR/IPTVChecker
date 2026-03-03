export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function parseLogLevel(raw: unknown): LogLevel | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "silent"
  ) {
    return normalized;
  }
  return null;
}

const DEFAULT_LOG_LEVEL: LogLevel = import.meta.env.DEV ? "debug" : "error";
const CONFIGURED_LEVEL = parseLogLevel(import.meta.env.VITE_LOG_LEVEL);
const ACTIVE_LOG_LEVEL = CONFIGURED_LEVEL ?? DEFAULT_LOG_LEVEL;

function shouldLog(level: Exclude<LogLevel, "silent">): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[ACTIVE_LOG_LEVEL];
}

export const logger = {
  level: ACTIVE_LOG_LEVEL,
  debug(...args: unknown[]) {
    if (shouldLog("debug")) {
      console.debug(...args);
    }
  },
  info(...args: unknown[]) {
    if (shouldLog("info")) {
      console.info(...args);
    }
  },
  warn(...args: unknown[]) {
    if (shouldLog("warn")) {
      console.warn(...args);
    }
  },
  error(...args: unknown[]) {
    if (shouldLog("error")) {
      console.error(...args);
    }
  },
};

