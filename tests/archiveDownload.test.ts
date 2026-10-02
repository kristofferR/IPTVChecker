import { describe, expect, test } from "bun:test";
import { recordingFileStem } from "../src/lib/archiveDownload";

describe("recordingFileStem", () => {
  test("joins channel, title and local start time without filesystem-hostile characters", () => {
    const start = new Date(2026, 8, 3, 21, 0).getTime() / 1000;
    expect(recordingFileStem("SE: SVT 1 HD", "Rapport: kväll / natt", start)).toBe(
      "SE SVT 1 HD - Rapport kväll natt - 2026-09-03 2100",
    );
  });

  test("omits an empty title and never returns an empty stem", () => {
    const start = new Date(2026, 0, 1, 0, 5).getTime() / 1000;
    expect(recordingFileStem("NRK1", "  ", start)).toBe("NRK1 - 2026-01-01 0005");
    expect(recordingFileStem("///", undefined, start)).toBe("2026-01-01 0005");
  });
});
