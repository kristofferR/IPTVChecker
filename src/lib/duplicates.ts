import type { ChannelResult } from "./types";

function canonicalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function findDuplicateChannelIndices(
  results: (ChannelResult | null)[],
): Set<number> {
  const firstByUrl = new Map<string, number>();
  const duplicates = new Set<number>();

  for (const result of results) {
    if (!result) continue;

    const key = canonicalizeUrl(result.url);
    if (!key) continue;

    const first = firstByUrl.get(key);
    if (first == null) {
      firstByUrl.set(key, result.index);
      continue;
    }

    duplicates.add(first);
    duplicates.add(result.index);
  }

  return duplicates;
}
