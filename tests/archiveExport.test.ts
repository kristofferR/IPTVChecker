import { describe, expect, it } from "bun:test";
import {
  realCatchupResults,
  setCatchupDays,
  stripCatchupAttributes,
  stripFakeCatchupResults,
} from "../src/lib/archiveExport";
import type { ArchiveProbeEntry, ArchiveProbeOutcome } from "../src/lib/archiveProbe";
import { toPendingChannelResult } from "../src/lib/channelResults";
import type { Channel, ChannelResult } from "../src/lib/types";

function channel(index: number, extinf: string, days: number | null = 7): ChannelResult {
  const base: Channel = {
    index,
    playlist: "p.m3u",
    name: `Ch ${index}`,
    group: "G",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    catchup: "default",
    catchup_days: days,
    catchup_source: null,
    url: `http://host/${index}.m3u8`,
    content_type: "live",
    extinf_line: extinf,
    metadata_lines: [],
  };
  return toPendingChannelResult(base);
}

function outcome(daysBack: number, ok: boolean, depthVerified = ok): ArchiveProbeOutcome {
  return {
    label: `−${daysBack}`,
    daysBack,
    ok,
    depthVerified,
    requestedStartEpochS: 0,
    requestUrl: "http://host/a",
    responseUrl: ok ? "http://host/seg.ts" : null,
    latencyMs: ok ? 100 : null,
    error: ok ? null : "Empty manifest body",
  };
}

function entry(outcomes: ArchiveProbeOutcome[]): ArchiveProbeEntry {
  return { running: false, outcomes, checkedAt: 1 };
}

describe("EXTINF catch-up attribute rewriting", () => {
  it("strips every catch-up attribute and keeps the rest", () => {
    expect(
      stripCatchupAttributes(
        '#EXTINF:-1 tvg-id="a" catchup="xc" catchup-days="7" tvg-rec=3 timeshift=\'2\' catchup-source="http://x/${start}" group-title="G",Name',
      ),
    ).toBe('#EXTINF:-1 tvg-id="a" group-title="G",Name');
  });

  it("rewrites existing depth attributes or inserts one before the title", () => {
    expect(setCatchupDays('#EXTINF:-1 catchup="xc" catchup-days="7" tvg-rec="7",Name', 3)).toBe(
      '#EXTINF:-1 catchup="xc" catchup-days="3" tvg-rec="3",Name',
    );
    expect(setCatchupDays('#EXTINF:-1 catchup="default",Name', 2)).toBe(
      '#EXTINF:-1 catchup="default" catchup-days="2",Name',
    );
  });
});

describe("verdict-based exports", () => {
  const verified = channel(1, '#EXTINF:-1 catchup="xc" catchup-days="7",Ch 1');
  const shallower = channel(2, '#EXTINF:-1 catchup="xc" catchup-days="7",Ch 2');
  const fake = channel(3, '#EXTINF:-1 catchup="xc" catchup-days="7",Ch 3');
  const untested = channel(4, '#EXTINF:-1 catchup="xc" catchup-days="7",Ch 4');
  const plain = channel(5, "#EXTINF:-1,Ch 5", null);
  plain.catchup = null;
  const probes = {
    1: entry([outcome(0, true), outcome(7, true)]),
    2: entry([outcome(0, true), outcome(7, false), outcome(3.5, true), outcome(5.25, false)]),
    3: entry([outcome(0, false)]),
  };
  const results = [verified, shallower, fake, untested, plain];

  it("keeps real archives and writes the measured depth for shallower ones", () => {
    const exported = realCatchupResults(results, probes);
    expect(exported.map((r) => r.index)).toEqual([1, 2]);
    expect(exported[1].catchup_days).toBe(3);
    expect(exported[1].extinf_line).toBe('#EXTINF:-1 catchup="xc" catchup-days="3",Ch 2');
    expect(exported[0]).toBe(verified);
  });

  it("removes catch-up flags only from fake channels", () => {
    const exported = stripFakeCatchupResults(results, probes);
    expect(exported[2].catchup).toBeNull();
    expect(exported[2].catchup_days).toBeNull();
    expect(exported[2].extinf_line).toBe("#EXTINF:-1,Ch 3");
    expect(exported[0]).toBe(verified);
    expect(exported[3]).toBe(untested);
    expect(exported[4]).toBe(plain);
  });
});
