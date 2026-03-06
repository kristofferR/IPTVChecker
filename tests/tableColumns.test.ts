import { describe, expect, it } from "bun:test";
import {
  DEFAULT_VISIBLE_COLUMN_ORDER,
  parseStoredColumnOrder,
  parseStoredColumnWidths,
} from "../src/lib/tableColumns";

describe("tableColumns helpers", () => {
  it("keeps only known columns, dedupes them, and appends fallback columns", () => {
    const parsed = parseStoredColumnOrder(
      JSON.stringify(["name", "status", "name", "bad-key"]),
      ["status", "name", "group"],
    );

    expect(parsed).toEqual(["name", "status", "group"]);
  });

  it("falls back to the provided order for malformed input", () => {
    expect(parseStoredColumnOrder("not-json", DEFAULT_VISIBLE_COLUMN_ORDER)).toEqual(
      DEFAULT_VISIBLE_COLUMN_ORDER,
    );
  });

  it("clamps stored widths to per-column minimums and ignores invalid values", () => {
    const widths = parseStoredColumnWidths(
      JSON.stringify({
        status: 12,
        name: 420,
        codec: "wide",
      }),
    );

    expect(widths.status).toBe(48);
    expect(widths.name).toBe(420);
    expect(widths.codec).toBe(96);
  });
});
