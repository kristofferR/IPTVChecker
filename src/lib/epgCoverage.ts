export interface EpgCoverageInput {
  tvg_id: string | null;
}

export interface EpgCoverageSummary {
  totalChannels: number;
  channelsWithEpg: number;
  coveragePercent: number;
  uniqueEpgSources: number;
}

function normalizeTvgId(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function summarizeEpgCoverage(items: EpgCoverageInput[]): EpgCoverageSummary {
  const totalChannels = items.length;
  const unique = new Set<string>();
  let channelsWithEpg = 0;

  for (const item of items) {
    const tvgId = normalizeTvgId(item.tvg_id);
    if (!tvgId) continue;
    channelsWithEpg += 1;
    unique.add(tvgId);
  }

  return {
    totalChannels,
    channelsWithEpg,
    coveragePercent: totalChannels > 0 ? (channelsWithEpg / totalChannels) * 100 : 0,
    uniqueEpgSources: unique.size,
  };
}
