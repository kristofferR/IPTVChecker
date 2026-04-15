import { describe, expect, test } from "bun:test";
import { isScanActive } from "../src/lib/scanState";

describe("scanState helpers", () => {
  test("treats cancelling as an active scan state", () => {
    expect(isScanActive("scanning")).toBe(true);
    expect(isScanActive("paused")).toBe(true);
    expect(isScanActive("cancelling")).toBe(true);
    expect(isScanActive("complete")).toBe(false);
    expect(isScanActive("cancelled")).toBe(false);
    expect(isScanActive("idle")).toBe(false);
  });
});
