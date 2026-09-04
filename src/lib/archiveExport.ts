import { hasArchive } from "./archive";
import type { ArchiveProbeEntry } from "./archiveProbe";
import { archiveVerdict, measuredDepthDays } from "./archiveVerification";
import type { ChannelResult } from "./types";

// Exports derived from verification verdicts: a playlist of only the channels
// whose archive works, and the original playlist with the lie removed.

const CATCHUP_ATTRS = [
  "catchup",
  "catchup-days",
  "catchup-source",
  "catchup-type",
  "tvg-rec",
  "timeshift",
];
const CATCHUP_ATTR_PATTERN = new RegExp(
  `\\s+(?:${CATCHUP_ATTRS.map((name) => name.replace(/-/g, "\\-")).join("|")})=(?:"[^"]*"|'[^']*'|[^\\s,]*)`,
  "gi",
);

/** Remove every catch-up attribute from an EXTINF line. */
export function stripCatchupAttributes(extinf: string): string {
  return extinf.replace(CATCHUP_ATTR_PATTERN, "");
}

/** Rewrite the advertised depth attributes to `days`, adding one when absent. */
export function setCatchupDays(extinf: string, days: number): string {
  const value = String(Math.max(1, Math.round(days)));
  let touched = false;
  const rewritten = extinf.replace(
    /(\s(?:catchup-days|tvg-rec|timeshift)=)(?:"[^"]*"|'[^']*'|[^\s,]*)/gi,
    (_match, prefix: string) => {
      touched = true;
      return `${prefix}"${value}"`;
    },
  );
  if (touched) return rewritten;
  const comma = rewritten.indexOf(",");
  const insertAt = comma === -1 ? rewritten.length : comma;
  return `${rewritten.slice(0, insertAt)} catchup-days="${value}"${rewritten.slice(insertAt)}`;
}

/**
 * Channels whose archive answered (verified or shallower), with the advertised
 * depth replaced by the measured one so players stop offering days that are
 * not there.
 */
export function realCatchupResults(
  results: ChannelResult[],
  probes: Record<number, ArchiveProbeEntry>,
): ChannelResult[] {
  const exported: ChannelResult[] = [];
  for (const result of results) {
    if (!hasArchive(result)) continue;
    const entry = probes[result.index];
    const verdict = archiveVerdict(result, entry);
    if (verdict === "verified") {
      exported.push(result);
    } else if (verdict === "shallower") {
      const measured = measuredDepthDays(entry);
      const days = measured == null ? null : Math.max(1, Math.floor(measured));
      exported.push(
        days == null
          ? result
          : {
              ...result,
              catchup_days: days,
              extinf_line: setCatchupDays(result.extinf_line, days),
            },
      );
    }
  }
  return exported;
}

/** The full list, with catch-up attributes removed from channels judged fake. */
export function stripFakeCatchupResults(
  results: ChannelResult[],
  probes: Record<number, ArchiveProbeEntry>,
): ChannelResult[] {
  return results.map((result) => {
    if (!hasArchive(result) || archiveVerdict(result, probes[result.index]) !== "fake") {
      return result;
    }
    return {
      ...result,
      catchup: null,
      catchup_days: null,
      catchup_source: null,
      extinf_line: stripCatchupAttributes(result.extinf_line),
    };
  });
}
