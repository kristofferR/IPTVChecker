import { logger } from "./logger";

export interface UiPerfSample {
  metric: string;
  valueMs: number;
  atEpochMs: number;
  meta?: Record<string, string | number | boolean | null>;
}

const PERF_BUFFER_LIMIT = 400;
const PERF_DISABLE_KEY = "iptv-checker.ui-perf.disabled";

declare global {
  interface Window {
    __iptvUiPerfSamples?: UiPerfSample[];
    __iptvUiLongTaskObserverStarted?: boolean;
  }
}

function perfEnabled(): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }
  return localStorage.getItem(PERF_DISABLE_KEY) !== "1";
}

export function recordUiPerf(sample: Omit<UiPerfSample, "atEpochMs">): void {
  if (!perfEnabled()) {
    return;
  }

  const nextSample: UiPerfSample = {
    ...sample,
    atEpochMs: Date.now(),
  };

  const buffer = (window.__iptvUiPerfSamples ??= []);
  buffer.push(nextSample);
  if (buffer.length > PERF_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - PERF_BUFFER_LIMIT);
  }

  if (nextSample.valueMs >= 8) {
    logger.debug("[ui-perf]", nextSample.metric, `${nextSample.valueMs.toFixed(2)}ms`);
  }
}

export function measureUiPerf<T>(
  metric: string,
  run: () => T,
  meta?: Record<string, string | number | boolean | null>,
): T {
  if (!perfEnabled()) {
    return run();
  }

  const startedAt = performance.now();
  const value = run();
  recordUiPerf({
    metric,
    valueMs: performance.now() - startedAt,
    meta,
  });
  return value;
}

export function readUiPerfSamples(metric?: string): UiPerfSample[] {
  const samples = window.__iptvUiPerfSamples ?? [];
  if (!metric) {
    return [...samples];
  }
  return samples.filter((sample) => sample.metric === metric);
}

export function summarizeUiPerf(metric: string): {
  count: number;
  avgMs: number;
  p95Ms: number;
} | null {
  const samples = readUiPerfSamples(metric);
  if (samples.length === 0) {
    return null;
  }

  const values = samples.map((sample) => sample.valueMs).sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(
    values.length - 1,
    Math.max(0, Math.floor(values.length * 0.95) - 1),
  );

  return {
    count: values.length,
    avgMs: total / values.length,
    p95Ms: values[p95Index],
  };
}

export function startLongTaskObserver(): void {
  if (!perfEnabled()) {
    return;
  }
  if (window.__iptvUiLongTaskObserverStarted) {
    return;
  }
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supported.includes("longtask")) {
    return;
  }

  window.__iptvUiLongTaskObserverStarted = true;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      recordUiPerf({
        metric: "longtask",
        valueMs: entry.duration,
        meta: {
          name: entry.name,
        },
      });
    }
  });

  observer.observe({ entryTypes: ["longtask"] });
}
