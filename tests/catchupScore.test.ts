import { describe, expect, it } from "bun:test";
import {
  type ArchiveProbeEntry,
  type ArchiveProbeOutcome,
  verifyArchiveDepthResponse,
} from "../src/lib/archiveProbe";
import { archiveVerdict, measuredDepthDays } from "../src/lib/archiveVerification";
import { blendOverallScore, computeCatchupScore } from "../src/lib/catchupScore";
import type { ChannelResult } from "../src/lib/types";

function channel(index: number, catchupDays: number | null, catchup = "xc"): ChannelResult {
  return {
    index,
    catchup: catchupDays != null || catchup ? catchup : null,
    catchup_days: catchupDays,
    catchup_source: null,
    content_type: "live",
  } as ChannelResult;
}

function plain(index: number): ChannelResult {
  return {
    index,
    catchup: null,
    catchup_days: null,
    catchup_source: null,
    content_type: "live",
  } as ChannelResult;
}

function entry(
  outcomes: Array<[number, boolean, number | null, depthVerified?: boolean]>,
): ArchiveProbeEntry {
  return {
    running: false,
    checkedAt: 1,
    outcomes: outcomes.map(([daysBack, ok, latencyMs, depthVerified = ok]) => ({
      label: `−${daysBack}d`,
      daysBack,
      ok,
      depthVerified,
      responseUrl: null,
      latencyMs,
      error: ok ? null : "dead",
    })),
  };
}

function responseOutcome(daysBack: number, responseUrl: string): ArchiveProbeOutcome {
  return {
    label: `−${daysBack}d`,
    daysBack,
    ok: true,
    depthVerified: daysBack === 0,
    responseUrl,
    latencyMs: 100,
    error: null,
  };
}

describe("verifyArchiveDepthResponse", () => {
  const near = responseOutcome(0, "https://host/live/segment-100.ts");

  it("accepts a deep probe that resolves to different media", () => {
    const deep = responseOutcome(7, "https://host/archive/segment-20.ts");
    expect(verifyArchiveDepthResponse(deep, near).depthVerified).toBe(true);
  });

  it("accepts successful direct streams for distinct archive windows", () => {
    const queryNear = responseOutcome(0, "https://host/live.ts?utc=100&lutc=200&token=x");
    const deep = responseOutcome(7, "https://host/live.ts?utc=10&lutc=200&token=x");
    expect(verifyArchiveDepthResponse(deep, queryNear).depthVerified).toBe(true);
  });

  it("ignores URL fragments when comparing responses", () => {
    const fragmentNear = responseOutcome(0, "https://host/live.ts?utc=100#near");
    const deep = responseOutcome(7, "https://host/live.ts?utc=100#deep");
    expect(verifyArchiveDepthResponse(deep, fragmentNear).depthVerified).toBe(false);
  });
});

describe("archiveVerdict", () => {
  const ch = channel(1, 7);

  it("stays advertised without completed probes", () => {
    expect(archiveVerdict(ch, undefined)).toBe("advertised");
    expect(archiveVerdict(ch, { running: true, outcomes: [], checkedAt: null })).toBe("advertised");
    expect(
      archiveVerdict(ch, {
        running: false,
        outcomes: entry([[0, true, 400]]).outcomes,
        checkedAt: null,
      }),
    ).toBe("advertised");
  });

  it("classifies broken, verified, and shallower archives", () => {
    expect(archiveVerdict(ch, entry([[0, false, null]]))).toBe("broken");
    expect(
      archiveVerdict(
        ch,
        entry([
          [0, true, 400],
          [7, true, 700],
        ]),
      ),
    ).toBe("verified");
    expect(
      archiveVerdict(
        ch,
        entry([
          [0, true, 400],
          [7, false, null],
          [3, true, 500],
        ]),
      ),
    ).toBe("shallower");
    expect(
      archiveVerdict(
        ch,
        entry([
          [0, true, 400],
          [7, true, 700, false],
        ]),
      ),
    ).toBe("shallower");
    expect(
      archiveVerdict(ch, {
        ...entry([
          [0, true, 400],
          [7, true, 700, false],
        ]),
        outcomes: [
          responseOutcome(0, "https://host/live/segment-100.ts"),
          {
            ...responseOutcome(7, "https://host/archive/segment-20.ts"),
            depthVerified: false,
            depthUnknown: true,
          },
        ],
      }),
    ).toBe("advertised");
  });

  it("measures depth as the deepest answering point", () => {
    expect(measuredDepthDays(entry([[0, true, 400]]))).toBe(1 / 24);
    expect(
      measuredDepthDays(
        entry([
          [0, true, 400],
          [7, false, null],
          [3, true, 500],
        ]),
      ),
    ).toBe(3);
    expect(measuredDepthDays(entry([[0, false, null]]))).toBeNull();
  });
});

describe("computeCatchupScore", () => {
  it("is null without catch-up channels", () => {
    expect(computeCatchupScore([], {})).toBeNull();
    expect(computeCatchupScore([plain(0), plain(1)], {})).toBeNull();
  });

  it("scores advertised coverage before verification", () => {
    const results = [channel(0, 7), channel(1, 7), plain(2), plain(3)];
    expect(computeCatchupScore(results, {})).toBe(5);
  });

  it("calculates coverage from live channels only", () => {
    const movie = { ...plain(2), content_type: "movie" as const };
    const series = { ...plain(3), content_type: "series" as const };
    expect(computeCatchupScore([channel(0, 7), plain(1), movie, series], {})).toBe(5);
  });

  it("blends reliability and depth after verification", () => {
    const results = [channel(0, 7), channel(1, 7)];
    const probes = {
      0: entry([
        [0, true, 400],
        [7, true, 700],
      ]),
      1: entry([
        [0, true, 400],
        [7, true, 800],
      ]),
    };
    // Full coverage, full reliability, full depth.
    expect(computeCatchupScore(results, probes)).toBe(10);

    const broken = { 0: entry([[0, false, null]]), 1: entry([[0, false, null]]) };
    // Full coverage but nothing works: only the coverage half survives.
    expect(computeCatchupScore(results, broken as Record<number, ArchiveProbeEntry>)).toBe(5);
  });

  it("retains the advertised baseline for untested catch-up channels", () => {
    const results = Array.from({ length: 100 }, (_, index) => channel(index, 7));
    const probes = { 0: entry([[0, false, null]]) };
    expect(computeCatchupScore(results, probes)).toBeCloseTo(9.95, 5);
  });
});

describe("blendOverallScore", () => {
  const base = { overall: 7.0, ping: 6, content: 8, quality: 7 };

  it("keeps the original overall without a catch-up component", () => {
    expect(blendOverallScore(base, null)).toBe(7.0);
  });

  it("folds the catch-up component in at 15% weight", () => {
    // 6*0.2 + 8*0.35 + 7*0.3 + 10*0.15 = 7.6
    expect(blendOverallScore(base, 10)).toBeCloseTo(7.6, 5);
  });
});
