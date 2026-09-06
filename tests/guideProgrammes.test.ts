import { describe, expect, it } from "bun:test";
import { guideProgrammesInWindow, indexGuideProgrammes } from "../src/lib/guideProgrammes";
import type { EpgProgramme } from "../src/lib/types";

const programme = (start: number, stop: number): EpgProgramme => ({
  start,
  stop,
  title: `${start}-${stop}`,
});

describe("guide programme windows", () => {
  it("includes both boundary touches and excludes programmes in gaps", () => {
    const programmes = [programme(0, 10), programme(20, 30), programme(40, 50)];
    const index = indexGuideProgrammes(programmes);
    expect(guideProgrammesInWindow(index, 10, 20)).toEqual(programmes.slice(0, 2));
    expect(guideProgrammesInWindow(index, 11, 19)).toEqual([]);
    expect(guideProgrammesInWindow(index, -20, -1)).toEqual([]);
    expect(guideProgrammesInWindow(index, 51, 60)).toEqual([]);
    expect(guideProgrammesInWindow(index, 30, 20)).toEqual([]);
    expect(guideProgrammesInWindow(indexGuideProgrammes([]), 0, 100)).toEqual([]);
  });

  it("keeps long overlapping listings even when intervening programmes have ended", () => {
    const programmes = [programme(0, 100), programme(10, 20), programme(30, 40)];
    const visible = guideProgrammesInWindow(indexGuideProgrammes(programmes), 35, 50);
    expect(visible).toEqual([programmes[0], programmes[2]]);
    expect(visible[0]).toBe(programmes[0]);
  });

  it("matches the original visibility rule throughout a 14-day guide", () => {
    const programmes = Array.from({ length: 14 * 96 }, (_, i) =>
      programme(i * 900, i * 900 + (i % 23 === 0 ? 7200 : 600 + ((i * 97) % 900))),
    );
    const index = indexGuideProgrammes(programmes);
    for (let from = -3600; from < 15 * 86400; from += 13717) {
      const to = from + 6 * 3600;
      expect(guideProgrammesInWindow(index, from, to)).toEqual(
        programmes.filter((item) => !(item.stop < from || item.start > to)),
      );
    }
  });
});
