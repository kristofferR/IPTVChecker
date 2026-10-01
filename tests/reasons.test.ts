import { describe, expect, it } from "bun:test";
import { t } from "../src/i18n";
import { EXACT_REASONS, translateReason } from "../src/i18n/reasons";

describe("translateReason", () => {
  it("maps every fixed reason to a message with the same English text", () => {
    for (const [reason, key] of Object.entries(EXACT_REASONS)) {
      expect(t(key)).toBe(reason);
      expect(translateReason(reason)).toBe(reason);
    }
  });

  it("round-trips parameterized reasons in English", () => {
    for (const reason of [
      "HTTP 404",
      "HTTP 302 without Location header",
      "HTTP 301 with invalid redirect location",
      "Stream read interrupted: error decoding response body",
      "No data (insufficient stream data: 512 bytes)",
      "Manifest body exceeded 8 MiB cap",
      "Unexpected text content type: text/html",
      "Unsupported non-HTTP stream scheme for ffprobe liveness check: udp",
      "ffmpeg timed out after 12.5s",
      "ffmpeg exited with 1 - no stderr output",
      "ffmpeg exited with terminated by signal - output file missing",
      "ffprobe timed out after 10.0s (binary: ffprobe) - timed out while opening stream",
      "ffprobe failed (binary: /usr/bin/ffprobe, exit: 1) - invalid stream data for ffmpeg",
      "output file missing - Conversion failed!",
      "invalid screenshot output - output image header is invalid",
      "failed to open output image: permission denied",
      "Detected DRM system: HLS Encrypted",
    ]) {
      expect(translateReason(reason)).toBe(reason);
    }
  });

  it("renders pattern params through the message, not the raw text", () => {
    expect(translateReason("No data (insufficient stream data: 1 bytes)")).toBe(
      "No data (insufficient stream data: 1 byte)",
    );
    expect(translateReason("No data (insufficient stream data: 12000 bytes)")).toBe(
      "No data (insufficient stream data: 12,000 bytes)",
    );
  });

  it("passes unknown text through unchanged", () => {
    expect(translateReason("Connection reset by peer (os error 104)")).toBe(
      "Connection reset by peer (os error 104)",
    );
    expect(translateReason("HLS SAMPLE-AES")).toBe("HLS SAMPLE-AES");
    expect(translateReason("")).toBe("");
  });
});
