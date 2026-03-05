export interface LanguageDistributionInput {
  language: string | null;
}

export interface LanguageDistributionEntry {
  language: string;
  count: number;
  percentage: number;
}

export interface LanguageDistributionSummary {
  entries: LanguageDistributionEntry[];
  otherCount: number;
  otherPercentage: number;
  totalDetected: number;
  unknownCount: number;
}

function normalizeLanguage(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

export function summarizeLanguageDistribution(
  items: LanguageDistributionInput[],
  topN = 5,
): LanguageDistributionSummary {
  const normalizedTopN = Number.isFinite(topN)
    ? Math.max(1, Math.floor(topN))
    : 5;
  const counts = new Map<string, number>();
  let unknownCount = 0;

  for (const item of items) {
    const language = normalizeLanguage(item.language);
    if (!language) {
      unknownCount += 1;
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const totalDetected = sorted.reduce((sum, [, count]) => sum + count, 0);
  const top = sorted.slice(0, normalizedTopN);
  const remainder = sorted.slice(normalizedTopN);
  const otherCount = remainder.reduce((sum, [, count]) => sum + count, 0);

  const entries: LanguageDistributionEntry[] = top.map(([language, count]) => ({
    language,
    count,
    percentage: totalDetected > 0 ? (count / totalDetected) * 100 : 0,
  }));

  return {
    entries,
    otherCount,
    otherPercentage: totalDetected > 0 ? (otherCount / totalDetected) * 100 : 0,
    totalDetected,
    unknownCount,
  };
}
