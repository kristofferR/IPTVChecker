import { type EnglishCatalog, formatCount, getFormatLocale, type MessageKey, t } from ".";
import type { MessageAt, ParamArgs } from "./types";

/** Keys of `reasons.*` messages that take no params. */
type PlainReasonKey = {
  [K in MessageKey]: K extends `reasons.${string}`
    ? ParamArgs<MessageAt<EnglishCatalog, K>, string> extends []
      ? K
      : never
    : never;
}[MessageKey];

/** Fixed reason strings from Rust (engine/checker.rs, engine/ffmpeg.rs, commands/scan.rs, error.rs). */
export const EXACT_REASONS = {
  Timeout: "reasons.timeout",
  "Connection refused": "reasons.connectionRefused",
  "DNS failure": "reasons.dnsFailure",
  "SSL/TLS error": "reasons.tlsError",
  "Invalid URL": "reasons.invalidUrl",
  "Redirect loop": "reasons.redirectLoop",
  "Playlist recursion limit exceeded": "reasons.playlistRecursionLimit",
  "Failed to read manifest body": "reasons.manifestReadFailed",
  "Empty manifest body": "reasons.emptyManifest",
  "No playable URI found in playlist": "reasons.noPlayableUri",
  Cancelled: "reasons.cancelled",
  "Scan cancelled": "reasons.scanCancelled",
  "Account busy": "reasons.accountBusy",
  "Invalid timeout: must be greater than 0 seconds": "reasons.invalidTimeout",
  "Invalid extended timeout: must be greater than 0 seconds": "reasons.invalidExtendedTimeout",
  "ffprobe check failed": "reasons.ffprobe.checkFailed",
  "ffprobe is required for RTSP/RTMP liveness checks, but it is not available":
    "reasons.ffprobe.required",
  "No decodable audio/video tracks reported by ffprobe": "reasons.ffprobe.noTracks",
  "ffmpeg/ffprobe not available": "reasons.ffmpeg.unavailable",
  "No decodable audio/video tracks reported by ffmpeg": "reasons.ffmpeg.noTracks",
  "server rejected ffmpeg connection (HTTP 5XX)": "reasons.ffmpeg.rejected5xx",
  "server rejected ffmpeg connection (HTTP 403 Forbidden)": "reasons.ffmpeg.rejected403",
  "server rejected ffmpeg connection (HTTP 401 Unauthorized)": "reasons.ffmpeg.rejected401",
  "server rejected ffmpeg connection (HTTP 4XX)": "reasons.ffmpeg.rejected4xx",
  "stream not found for ffmpeg (HTTP 404)": "reasons.ffmpeg.notFound",
  "connection refused while opening stream": "reasons.ffmpeg.connectionRefused",
  "connection reset while reading stream": "reasons.ffmpeg.connectionReset",
  "timed out while opening stream": "reasons.ffmpeg.openTimedOut",
  "invalid stream data for ffmpeg": "reasons.ffmpeg.invalidData",
  "ffmpeg could not open the stream": "reasons.ffmpeg.couldNotOpen",
  "no stderr output": "reasons.ffmpeg.noStderr",
  "terminated by signal": "reasons.ffmpeg.terminatedBySignal",
  "output file missing": "reasons.screenshot.outputMissing",
  "output image is empty": "reasons.screenshot.emptyImage",
  "output image header is incomplete": "reasons.screenshot.incompleteHeader",
  "output image header is invalid": "reasons.screenshot.invalidHeader",
  "HLS Encrypted": "reasons.drm.hlsEncrypted",
  "DASH Encrypted": "reasons.drm.dashEncrypted",
  "4K channel not labeled as such": "reasons.label.unlabeled4k",
  "Analyzing channel URLs": "reasons.progress.analyzingUrls",
  "Looking up server location": "reasons.progress.lookingUpServer",
  "Fetching Dispatcharr channels": "reasons.progress.fetchingDispatcharrChannels",
  "Fetching Dispatcharr streams": "reasons.progress.fetchingDispatcharrStreams",
  "Caching Dispatcharr playlist": "reasons.progress.cachingDispatcharr",
  "Initializing HTTP client": "reasons.progress.initializingClient",
  "Waiting for server": "reasons.progress.waitingForServer",
  "Writing to disk": "reasons.progress.writingToDisk",
} as const satisfies Record<string, PlainReasonKey>;

const exact: ReadonlyMap<string, PlainReasonKey> = new Map(Object.entries(EXACT_REASONS));

function formatSeconds(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const digits = raw.split(".")[1]?.length ?? 0;
  return value.toLocaleString(getFormatLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Parameterized reasons. Nested reasons (`details`, codes) are translated recursively. */
const PATTERNS: ReadonlyArray<readonly [RegExp, (match: string[]) => string]> = [
  [/^HTTP (\d{3})$/, ([, code]) => t("reasons.http.status", { code })],
  [/^Expected 720p or 1080p, got (.+)$/, ([, actual]) => t("reasons.label.expectedHd", { actual })],
  [
    /^Expected (.+), got (.+)$/,
    ([, expected, actual]) => t("reasons.label.expected", { expected, actual }),
  ],
  [
    /^HTTP (\d{3}) without Location header$/,
    ([, code]) => t("reasons.http.missingLocation", { code }),
  ],
  [
    /^HTTP (\d{3}) with invalid redirect location$/,
    ([, code]) => t("reasons.http.invalidLocation", { code }),
  ],
  [
    /^Stream read interrupted: (.+)$/s,
    ([, error]) => t("reasons.streamReadInterrupted", { error }),
  ],
  [
    /^No data \(insufficient stream data: (\d+) bytes\)$/,
    ([, bytes]) => t("reasons.insufficientData", { count: Number(bytes) }),
  ],
  [
    /^Manifest body exceeded (\d+) MiB cap$/,
    ([, size]) => t("reasons.manifestTooLarge", { size: formatCount(Number(size)) }),
  ],
  [
    /^Unexpected text content type: (.*)$/s,
    ([, type]) => t("reasons.unexpectedContentType", { type }),
  ],
  [
    /^Unsupported non-HTTP stream scheme for ffprobe liveness check: (.+)$/s,
    ([, scheme]) => t("reasons.ffprobe.unsupportedScheme", { scheme }),
  ],
  [
    /^ffmpeg timed out after ([\d.]+)s$/,
    ([, seconds]) => t("reasons.ffmpeg.timedOut", { seconds: formatSeconds(seconds) }),
  ],
  [
    /^ffmpeg exited with (.+?) - (.*)$/s,
    ([, code, details]) =>
      t("reasons.ffmpeg.exited", {
        code: translateReason(code),
        details: translateReason(details),
      }),
  ],
  [
    /^(ffmpeg|ffprobe) timed out after ([\d.]+)s \(binary: (.*?)\) - (.*)$/s,
    ([, tool, seconds, binary, details]) =>
      t("reasons.ffmpeg.toolTimedOut", {
        tool,
        seconds: formatSeconds(seconds),
        binary,
        details: translateReason(details),
      }),
  ],
  [
    /^(ffmpeg|ffprobe) failed \(binary: (.*?), exit: (.+?)\) - (.*)$/s,
    ([, tool, binary, code, details]) =>
      t("reasons.ffmpeg.toolFailed", {
        tool,
        binary,
        code: translateReason(code),
        details: translateReason(details),
      }),
  ],
  [
    /^output file missing - (.*)$/s,
    ([, details]) => t("reasons.screenshot.outputMissingDetails", { details }),
  ],
  [
    /^invalid screenshot output - (.*)$/s,
    ([, details]) => t("reasons.screenshot.invalidOutput", { details: translateReason(details) }),
  ],
  [
    /^failed to read output metadata: (.*)$/s,
    ([, error]) => t("reasons.screenshot.metadataReadFailed", { error }),
  ],
  [
    /^failed to open output image: (.*)$/s,
    ([, error]) => t("reasons.screenshot.openFailed", { error }),
  ],
  [
    /^failed to read output image: (.*)$/s,
    ([, error]) => t("reasons.screenshot.readFailed", { error }),
  ],
  [
    /^Detected DRM system: (.+)$/s,
    ([, system]) => t("reasons.drm.detected", { system: translateReason(system) }),
  ],
];

/**
 * Scan results store failure reasons as fixed English strings from Rust (they
 * are persisted, exported and compared). Translate them only for display.
 * Unknown text, such as raw tool output, passes through unchanged.
 */
export function translateReason(reason: string): string {
  const key = exact.get(reason);
  if (key) return t(key);
  for (const [pattern, translate] of PATTERNS) {
    const match = pattern.exec(reason);
    if (match) return translate(match);
  }
  return reason;
}
