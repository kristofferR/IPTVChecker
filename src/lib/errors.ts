/** Shared error-formatting helpers for user-facing messages. */

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

export function formatPlaylistOpenError(err: unknown): string {
  const raw = errorToString(err).replace(/^error:\s*/i, "").trim();
  if (!raw || raw === "[object Object]") {
    return "Failed to open playlist. Please verify the file path and playlist format.";
  }
  return raw.toLowerCase().startsWith("failed to open playlist")
    ? raw
    : `Failed to open playlist: ${raw}`;
}

export function formatSourceReloadError(err: unknown): string {
  const raw = errorToString(err).replace(/^error:\s*/i, "").trim();
  const normalized = raw.replace(/^failed to open playlist:\s*/i, "").trim();

  if (!normalized || normalized === "[object Object]") {
    return "Failed to reload source. Please verify the source settings and filter.";
  }

  return raw.toLowerCase().startsWith("failed to reload source")
    ? raw
    : `Failed to reload source: ${normalized}`;
}
