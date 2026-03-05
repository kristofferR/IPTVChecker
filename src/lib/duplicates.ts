import type { ChannelResult } from "./types";

const UNRESERVED_CHAR = /^[A-Za-z0-9\-._~]$/u;

function decodeUnreservedPercentEncoding(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    const decoded = String.fromCharCode(codePoint);
    if (UNRESERVED_CHAR.test(decoded)) {
      return decoded;
    }
    return `%${hex.toUpperCase()}`;
  });
}

function normalizePathname(pathname: string): string {
  const withoutTrailingSlash =
    pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return decodeUnreservedPercentEncoding(withoutTrailingSlash);
}

function normalizeQuery(searchParams: URLSearchParams): string {
  const sorted = Array.from(searchParams.entries()).map(([key, value]) => ({
    key: decodeUnreservedPercentEncoding(key),
    value: decodeUnreservedPercentEncoding(value),
  }));

  sorted.sort((a, b) => {
    if (a.key !== b.key) {
      return a.key < b.key ? -1 : 1;
    }
    if (a.value === b.value) {
      return 0;
    }
    return a.value < b.value ? -1 : 1;
  });

  const normalized = new URLSearchParams();
  for (const entry of sorted) {
    normalized.append(entry.key, entry.value);
  }
  return normalized.toString();
}

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
    parsed.pathname = normalizePathname(parsed.pathname);
    const normalizedQuery = normalizeQuery(parsed.searchParams);
    parsed.search = normalizedQuery.length > 0 ? `?${normalizedQuery}` : "";
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
