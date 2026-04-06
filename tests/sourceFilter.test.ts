import { describe, expect, it } from "bun:test";
import {
  hasDirtySourceFilter,
  normalizeSourceFilter,
  resolvePreservedGroupFilter,
} from "../src/lib/sourceFilter";
import type { CurrentSourceDescriptor } from "../src/lib/types";

const fileSource: CurrentSourceDescriptor = {
  kind: "path",
  path: "/tmp/sample.m3u8",
};

describe("sourceFilter helpers", () => {
  it("normalizes missing and padded values", () => {
    expect(normalizeSourceFilter(undefined)).toBe("");
    expect(normalizeSourceFilter(null)).toBe("");
    expect(normalizeSourceFilter("  test  ")).toBe("test");
  });

  it("only marks the filter dirty when a source is loaded", () => {
    expect(hasDirtySourceFilter("sports", "", null)).toBe(false);
    expect(hasDirtySourceFilter("sports", "", fileSource)).toBe(true);
    expect(hasDirtySourceFilter(" sports ", "sports", fileSource)).toBe(false);
  });

  it("preserves the group filter only when it still exists", () => {
    expect(resolvePreservedGroupFilter("all", ["Sports", "News"])).toBe("all");
    expect(resolvePreservedGroupFilter("sports", ["Sports", "News"])).toBe(
      "sports",
    );
    expect(resolvePreservedGroupFilter("Movies", ["Sports", "News"])).toBe(
      "all",
    );
  });
});
