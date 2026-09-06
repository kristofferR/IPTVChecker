import { describe, expect, it } from "bun:test";
import { dayLabel, timeLabel } from "../src/lib/timeFormat";

describe("guide time labels", () => {
  it("preserves locale formatting across midnight and winter/summer dates", () => {
    for (const date of [
      new Date(2026, 0, 15, 0, 0),
      new Date(2026, 0, 15, 23, 59),
      new Date(2026, 6, 15, 12, 30),
    ]) {
      expect(timeLabel(date.getTime() / 1000)).toBe(
        date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }),
      );
    }
  });

  it("keeps relative day names and locale dates across a year boundary", () => {
    const now = new Date(2026, 0, 1, 12);
    expect(dayLabel(new Date(2026, 0, 1, 1).getTime() / 1000, now)).toBe("Today");
    expect(dayLabel(new Date(2025, 11, 31, 23).getTime() / 1000, now)).toBe("Yesterday");
    for (const date of [new Date(2025, 11, 30, 12), new Date(2026, 0, 2, 12)]) {
      expect(dayLabel(date.getTime() / 1000, now)).toBe(
        date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
      );
    }
  });

  it("follows system time-zone changes after the formatters have been cached", () => {
    const previousTimeZone = process.env.TZ;
    try {
      for (const timeZone of ["Europe/Oslo", "America/New_York", "Asia/Kolkata"]) {
        process.env.TZ = timeZone;
        for (const date of [new Date("2026-01-15T23:30:00Z"), new Date("2026-07-15T23:30:00Z")]) {
          expect(timeLabel(date.getTime() / 1000)).toBe(
            date.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            }),
          );
          expect(dayLabel(date.getTime() / 1000, new Date("2026-08-01T12:00:00Z"))).toBe(
            date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
          );
        }
      }
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });
});
