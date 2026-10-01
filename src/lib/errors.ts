/** Shared error-formatting helpers for user-facing messages. */

import { t } from "../i18n";

export function errorToString(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function redactSensitiveQueryParameters(message: string): string {
  return message.replace(/([?&](?:username|password)=)[^&#)\]]*/gi, "$1***");
}

/** Redact URL userinfo and Xtream-style credential query parameters in either
 *  a standalone URL or a larger error/log message. */
export function redactUrlCredentials(value: string): string {
  const redactedUserInfo = value.replace(/\b(https?:\/\/)[^/\s?#()[\]]+@/gi, "$1***@");
  return redactSensitiveQueryParameters(redactedUserInfo);
}

function formatUserFacingError(
  err: unknown,
  fallback: string,
  frame: (error: string) => string,
  existingPrefix: RegExp,
  normalizedPrefix?: RegExp,
): string {
  if (err === null || err === undefined) {
    return fallback;
  }
  const raw = redactUrlCredentials(errorToString(err))
    .replace(/^error:\s*/i, "")
    .trim();
  const normalized = normalizedPrefix ? raw.replace(normalizedPrefix, "").trim() : raw;

  if (!normalized || normalized === "[object Object]") {
    return fallback;
  }
  return existingPrefix.test(normalized) ? normalized : frame(normalized);
}

export function formatPlaylistOpenError(err: unknown): string {
  return formatUserFacingError(
    err,
    t("app.errors.openPlaylistFallback"),
    (error) => t("app.errors.openPlaylist", { error }),
    /^failed to open playlist(?:\s*:|$)/i,
  );
}

export function formatSourceReloadError(err: unknown): string {
  return formatUserFacingError(
    err,
    t("app.errors.reloadSourceFallback"),
    (error) => t("app.errors.reloadSource", { error }),
    /^failed to reload source(?:\s*:|$)/i,
    /^failed to open playlist:\s*/i,
  );
}
