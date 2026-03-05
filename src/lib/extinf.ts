function findUnquotedComma(text: string): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ",") {
      return index;
    }
  }

  return -1;
}

export function getExtinfAttribute(
  extinfLine: string,
  attribute: string,
): string | null {
  if (!extinfLine.startsWith("#EXTINF")) return null;

  const headerEnd = findUnquotedComma(extinfLine);
  const header = headerEnd >= 0 ? extinfLine.slice(0, headerEnd) : extinfLine;
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b${escapedAttribute}=(?:\"([^\"\\\\]*(?:\\\\.[^\"\\\\]*)*)\"|'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|([^\\s]+))`,
    "i",
  );

  const match = pattern.exec(header);
  if (!match) return null;

  const value = (match[1] ?? match[2] ?? match[3] ?? "")
    .replace(/\\(["'])/g, "$1")
    .trim();
  return value.length > 0 ? value : null;
}

export function extractTvgLogoUrl(extinfLine: string): string | null {
  const raw = getExtinfAttribute(extinfLine, "tvg-logo");
  if (!raw) return null;

  const candidate = raw.trim();
  if (candidate.startsWith("//")) {
    return `https:${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}
