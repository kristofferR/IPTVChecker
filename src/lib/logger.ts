import {
  attachConsole,
  debug as tauriDebug,
  info as tauriInfo,
  warn as tauriWarn,
  error as tauriError,
} from "@tauri-apps/plugin-log";

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

// Bridge frontend console.* calls to the Rust log plugin → terminal output
attachConsole();

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

export const logger = {
  level: ACTIVE_LOG_LEVEL,
  debug(...args: unknown[]) {
    if (shouldLog("debug")) {
      const msg = formatArgs(args);
      console.debug(msg);
      void tauriDebug(msg);
    }
  },
  info(...args: unknown[]) {
    if (shouldLog("info")) {
      const msg = formatArgs(args);
      console.info(msg);
      void tauriInfo(msg);
    }
  },
  warn(...args: unknown[]) {
    if (shouldLog("warn")) {
      const msg = formatArgs(args);
      console.warn(msg);
      void tauriWarn(msg);
    }
  },
  error(...args: unknown[]) {
    if (shouldLog("error")) {
      const msg = formatArgs(args);
      console.error(msg);
      void tauriError(msg);
    }
  },
};
