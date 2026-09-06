import { describe, expect, it } from "bun:test";
import type { ArchiveProbeOutcome } from "../src/lib/archiveProbe";
import {
  archiveFailure,
  archiveFailureLabel,
  archiveVerdict,
  classifyArchiveFailure,
} from "../src/lib/archiveVerification";
import { toPendingChannelResult } from "../src/lib/channelResults";
import { CATCHUP_VERDICT_FILTERS, countStatusOptions, filterResults } from "../src/lib/filters";
import type { Channel } from "../src/lib/types";

function outcome(overrides: Partial<ArchiveProbeOutcome>): ArchiveProbeOutcome {
  return {
    label: "Archive −1 h",
    daysBack: 0,
    ok: false,
    depthVerified: false,
    depthUnknown: false,
    requestedStartEpochS: 1_700_000_000,
    requestUrl: "http://host/a.m3u8",
    responseUrl: null,
    latencyMs: null,
    error: null,
    ...overrides,
  };
}

function channel(
  index: number,
  days: number | null = 7,
): ReturnType<typeof toPendingChannelResult> {
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
    catchup: days == null ? null : "xc",
    catchup_days: days,
    catchup_source: null,
    url: `http://host/${index}.m3u8`,
    content_type: "live",
    extinf_line: "#EXTINF:-1,Ch",
    metadata_lines: [],
  };
  return toPendingChannelResult(base);
}

describe("classifyArchiveFailure", () => {
  it("maps checker errors to fake reasons", () => {
    expect(classifyArchiveFailure(outcome({ error: "Empty manifest body" }))).toEqual({
      kind: "empty",
    });
    expect(classifyArchiveFailure(outcome({ error: "No playable URI found in playlist" }))).toEqual(
      { kind: "empty" },
    );
    expect(classifyArchiveFailure(outcome({ error: "HTTP 404" }))).toEqual({
      kind: "http",
      status: 404,
    });
    expect(classifyArchiveFailure(outcome({ error: "request timed out" }))).toEqual({
      kind: "timeout",
    });
    expect(classifyArchiveFailure(outcome({ error: "dead" }))).toEqual({ kind: "unreachable" });
  });

  it("treats a reachable point that serves the wrong time as live, and unknown time as fine", () => {
    expect(classifyArchiveFailure(outcome({ ok: true, depthVerified: false }))).toEqual({
      kind: "live",
    });
    expect(classifyArchiveFailure(outcome({ ok: true, depthVerified: true }))).toBeNull();
    expect(
      classifyArchiveFailure(outcome({ ok: true, depthVerified: false, depthUnknown: true })),
    ).toBeNull();
  });

  it("labels reasons for the chip", () => {
    expect(archiveFailureLabel({ kind: "http", status: 403 })).toBe("403");
    expect(archiveFailureLabel({ kind: "empty" })).toBe("EMPTY");
    expect(archiveFailureLabel({ kind: "live" })).toBe("LIVE");
  });
});

describe("archiveVerdict with quick-mode entries", () => {
  it("calls a working near point real even when depth was not measured", () => {
    const entry = {
      running: false,
      checkedAt: 1,
      outcomes: [outcome({ ok: true, depthVerified: true, latencyMs: 300 })],
    };
    expect(archiveVerdict(channel(1, 7), entry)).toBe("verified");
    expect(archiveFailure(entry)).toBeNull();
  });

  it("exposes the failure behind a fake verdict", () => {
    const entry = {
      running: false,
      checkedAt: 1,
      outcomes: [outcome({ error: "HTTP 404" })],
    };
    expect(archiveVerdict(channel(1, 7), entry)).toBe("fake");
    expect(archiveFailure(entry)).toEqual({ kind: "http", status: 404 });
  });
});

describe("verdict status filters", () => {
  const real = channel(1);
  const fake = channel(2);
  const untested = channel(3);
  const plain = channel(4, null);
  const probes = {
    1: { running: false, checkedAt: 1, outcomes: [outcome({ ok: true, depthVerified: true })] },
    2: { running: false, checkedAt: 1, outcomes: [outcome({ error: "Empty manifest body" })] },
  };
  const results = [real, fake, untested, plain];

  it("selects channels by verdict and counts them", () => {
    expect(
      filterResults(
        results,
        "",
        "all",
        "catchup_fake",
        undefined,
        undefined,
        undefined,
        probes,
      ).map((r) => r.index),
    ).toEqual([2]);
    expect(
      filterResults(
        results,
        "",
        "all",
        "catchup_real",
        undefined,
        undefined,
        undefined,
        probes,
      ).map((r) => r.index),
    ).toEqual([1]);
    expect(
      filterResults(
        results,
        "",
        "all",
        "catchup_untested",
        undefined,
        undefined,
        undefined,
        probes,
      ).map((r) => r.index),
    ).toEqual([3]);
    const counts = countStatusOptions(results, "", "all", undefined, undefined, undefined, probes);
    expect(counts.catchup).toBe(3);
    expect(counts.catchup_real).toBe(1);
    expect(counts.catchup_fake).toBe(1);
    expect(counts.catchup_untested).toBe(1);
    expect(Object.keys(CATCHUP_VERDICT_FILTERS)).toContain("catchup_shallower");
  });
});
