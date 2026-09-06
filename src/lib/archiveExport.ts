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

/**
 * Index of the comma that separates EXTINF attributes from the title, ignoring
 * commas inside quoted attribute values (`group-title="Sports, US"`).
 */
export function findUnquotedComma(line: string): number {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ",") {
      return index;
    }
  }
  return -1;
}

function splitExtinf(extinf: string): { attrs: string; title: string } {
  const comma = findUnquotedComma(extinf);
  return comma === -1
    ? { attrs: extinf, title: "" }
    : { attrs: extinf.slice(0, comma), title: extinf.slice(comma) };
}

/** Remove every catch-up attribute from an EXTINF line, leaving the title alone. */
export function stripCatchupAttributes(extinf: string): string {
  const { attrs, title } = splitExtinf(extinf);
  return attrs.replace(CATCHUP_ATTR_PATTERN, "") + title;
}

/** Rewrite the advertised depth attributes to `days`, adding one when absent. */
export function setCatchupDays(extinf: string, days: number): string {
  const value = String(Math.max(1, Math.round(days)));
  const { attrs, title } = splitExtinf(extinf);
  let touched = false;
  const rewritten = attrs.replace(
    /(\s(?:catchup-days|tvg-rec|timeshift)=)(?:"[^"]*"|'[^']*'|[^\s,]*)/gi,
    (_match, prefix: string) => {
      touched = true;
      return `${prefix}"${value}"`;
    },
  );
  return touched ? rewritten + title : `${rewritten} catchup-days="${value}"${title}`;
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
