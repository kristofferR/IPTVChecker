import { hasArchive } from "./archive";
import type { ChannelResult, EpgProgramme } from "./types";

export function programmePlaybackAvailability(
  channel: Pick<ChannelResult, "catchup" | "catchup_days" | "catchup_source">,
  programme: Pick<EpgProgramme, "start" | "stop">,
  nowEpochS: number,
) {
  const started = programme.start <= nowEpochS;
  const earliest = channel.catchup_days == null ? null : nowEpochS - channel.catchup_days * 86_400;
  return {
    live: started && programme.stop > nowEpochS,
    archive: hasArchive(channel) && started && (earliest == null || programme.start >= earliest),
  };
}

export interface GuideProgrammeIndex {
  programmes: readonly EpgProgramme[];
  latestStops: Float64Array;
}

/** Index an immutable, start-time-sorted programme list returned by the backend. */
export function indexGuideProgrammes(programmes: readonly EpgProgramme[]): GuideProgrammeIndex {
  const latestStops = new Float64Array(programmes.length);
  let latestStop = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < programmes.length; i++) {
    latestStop = Math.max(latestStop, programmes[i].stop);
    latestStops[i] = latestStop;
  }
  return { programmes, latestStops };
}

/** Preserve programmes touching either window edge, including overlapping listings. */
export function guideProgrammesInWindow(
  { programmes, latestStops }: GuideProgrammeIndex,
  from: number,
  to: number,
): EpgProgramme[] {
  if (from > to) return [];
  let low = 0;
  let high = programmes.length;
  // Stop times need not be sorted: a short listing may overlap a long one.
  // Prefix maxima let us skip history without losing either programme.
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (latestStops[mid] < from) low = mid + 1;
    else high = mid;
  }

  const visible: EpgProgramme[] = [];
  for (let i = low; i < programmes.length && programmes[i].start <= to; i++) {
    if (programmes[i].stop >= from) visible.push(programmes[i]);
  }
  return visible;
}
