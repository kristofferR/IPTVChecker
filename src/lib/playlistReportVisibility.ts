export type ReportScanState =
  | "idle"
  | "scanning"
  | "paused"
  | "complete"
  | "cancelled";

export interface ReportScanProgressSnapshot {
  completed: number;
  total: number;
}

export const REPORT_AUTO_REVEAL_COMPLETION_THRESHOLD = 0.9;
export const REPORT_AUTO_REVEAL_COVERAGE_THRESHOLD = 0.85;

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

export function shouldAutoRevealReportPanel(
  progress: ReportScanProgressSnapshot | null,
  playlistTotalChannels: number,
  completionThreshold = REPORT_AUTO_REVEAL_COMPLETION_THRESHOLD,
  coverageThreshold = REPORT_AUTO_REVEAL_COVERAGE_THRESHOLD,
): boolean {
  if (!progress) {
    return false;
  }

  const scanTotal = Math.max(0, progress.total);
  const fullPlaylistTotal = Math.max(0, playlistTotalChannels);
  if (scanTotal === 0 || fullPlaylistTotal === 0) {
    return false;
  }

  const scanCoverage = scanTotal / fullPlaylistTotal;
  if (scanCoverage < coverageThreshold) {
    return false;
  }

  const completionRatio = progress.completed / scanTotal;
  return completionRatio >= completionThreshold;
}
