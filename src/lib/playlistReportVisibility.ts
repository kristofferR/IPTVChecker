export type ReportScanState =
  | "idle"
  | "scanning"
  | "paused"
  | "complete"
  | "cancelled";

export function hasScanStarted(scanState: ReportScanState): boolean {
  return scanState !== "idle";
}

export function shouldShowContentCounts(
  movieCount: number,
  seriesCount: number,
): boolean {
  return movieCount > 0 || seriesCount > 0;
}

export function languageCoverage(
  channels: Array<{ language: string | null }>,
): number {
  if (channels.length === 0) {
    return 0;
  }

  const withLanguage = channels.filter((channel) => {
    const language = channel.language?.trim();
    return typeof language === "string" && language.length > 0;
  }).length;

  return withLanguage / channels.length;
}

export function shouldShowLanguageDistribution(
  channels: Array<{ language: string | null }>,
  minimumCoverage = 0.5,
): boolean {
  return languageCoverage(channels) > minimumCoverage;
}
