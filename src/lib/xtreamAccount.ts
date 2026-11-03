import { getFormatLocale } from "../i18n";
import { getChannelErrorReason } from "./channelResults";
import type { ChannelResult, ChannelStatus, XtreamAccountState } from "./types";

/** States in which the provider won't serve the account's channels. */
export function isUnusableAccount(state: XtreamAccountState): boolean {
  return state === "expired" || state === "disabled" || state === "rejected";
}

/** Locale date for an Xtream epoch in seconds. */
export function formatAccountDate(epochS: number): string {
  return new Date(epochS * 1000).toLocaleDateString(getFormatLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const FAILED_STATUSES: ReadonlySet<ChannelStatus> = new Set([
  "dead",
  "geoblocked",
  "geoblocked_confirmed",
  "geoblocked_unconfirmed",
]);
/** HTTP checker reasons (engine/checker.rs) for a server refusing the request. */
const REFUSED_REASONS: ReadonlySet<string> = new Set(["HTTP 401", "HTTP 403"]);

/** How many checked channels the server refused, to tell whether an unusable
 *  account explains a scan's failures. */
export function countRefusedChannels(
  results: readonly Pick<ChannelResult, "status" | "error_reason">[],
): {
  checked: number;
  refused: number;
} {
  let checked = 0;
  let refused = 0;
  for (const result of results) {
    if (result.status === "pending" || result.status === "checking") continue;
    checked += 1;
    const reason = getChannelErrorReason(result);
    if (FAILED_STATUSES.has(result.status) && reason && REFUSED_REASONS.has(reason)) refused += 1;
  }
  return { checked, refused };
}
