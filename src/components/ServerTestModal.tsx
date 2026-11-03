import { listen } from "@tauri-apps/api/event";
import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { errorToString } from "../lib/errors";
import { normalizeXtreamServer } from "../lib/savedPlaylists";
import type { XtreamServerTestReport } from "../lib/types";

interface ServerTestModalProps {
  /** Shown above the title: the source kind, or the account under test. */
  eyebrow: string;
  initialServersText: string;
  /** The server in use, badged in the results. */
  currentServer?: string | null;
  runTest: (servers: string[]) => Promise<XtreamServerTestReport>;
  /** Replaces the default hint under the results. */
  selectHint?: string;
  /** A working server was clicked; the caller closes the dialog. */
  onSelectServer: (server: string) => void;
  onClose: () => void;
}

/** Ranks candidate Xtream servers of one account by quality and latency. */
export default function ServerTestModal({
  eyebrow,
  initialServersText,
  currentServer,
  runTest,
  selectHint,
  onSelectServer,
  onClose,
}: ServerTestModalProps) {
  const [testServers, setTestServers] = useState(initialServersText);
  const [testReport, setTestReport] = useState<XtreamServerTestReport | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testProgress, setTestProgress] = useState<string | null>(null);
  const testRunningRef = useRef(false);
  const current = currentServer ? normalizeXtreamServer(currentServer) : null;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<string>("scan://server-test-progress", (event) => {
      if (testRunningRef.current) {
        setTestProgress(event.payload);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleRunTest = async () => {
    const lines = testServers
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      setTestError(t("sources.serverTest.noServers"));
      return;
    }
    setTestError(null);
    setTestReport(null);
    setTestProgress(null);
    setTestRunning(true);
    testRunningRef.current = true;
    try {
      setTestReport(await runTest(lines));
    } catch (error: unknown) {
      setTestError(errorToString(error));
    } finally {
      setTestRunning(false);
      testRunningRef.current = false;
      setTestProgress(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-5xl rounded-xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
          <div>
            <p
              dir="auto"
              className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1"
            >
              {eyebrow}
            </p>
            <h2 className="text-[18px] font-semibold text-text-primary">
              {t("sources.serverTest.title")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
            aria-label={t("sources.serverTest.closeLabel")}
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="server-test-urls"
              className="text-[12px] font-medium text-text-secondary"
            >
              {t("sources.serverTest.serverUrls")}
            </label>
            <textarea
              id="server-test-urls"
              rows={6}
              dir="ltr"
              autoFocus
              value={testServers}
              onChange={(e) => setTestServers(e.target.value)}
              placeholder={"https://server1.example.com:8080\nhttps://server2.example.com:8080"}
              className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none font-mono resize-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRunTest}
              disabled={testRunning}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {testRunning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {testRunning ? t("sources.serverTest.testing") : t("sources.serverTest.runTest")}
            </button>

            {testRunning && (
              <span dir="auto" className="text-[12px] text-text-tertiary">
                {testProgress || t("sources.serverTest.starting")}
              </span>
            )}
          </div>

          {testError && <p className="text-[12px] text-red-400">{testError}</p>}

          {testReport && (
            <div className="space-y-4 max-h-[65vh] overflow-y-auto pe-1">
              <div className="flex items-center gap-4 text-[12px] text-text-tertiary">
                <span className={testReport.same_cdn ? "text-yellow-400" : "text-green-400"}>
                  {testReport.same_cdn
                    ? t("sources.serverTest.sameCdn")
                    : t("sources.serverTest.differentCdns")}
                </span>
                <span>
                  {t("sources.serverTest.channelsProbed", {
                    count: testReport.channels_probed,
                  })}
                </span>
              </div>

              <div className="space-y-3">
                {testReport.results.map((result, i) => {
                  let hostLabel: string;
                  try {
                    const u = new URL(result.server);
                    hostLabel = u.host;
                  } catch {
                    hostLabel = result.server;
                  }

                  const streamLatencyColor =
                    result.avg_stream_latency_ms == null
                      ? "text-text-muted"
                      : result.avg_stream_latency_ms < 200
                        ? "text-green-400"
                        : result.avg_stream_latency_ms < 500
                          ? "text-yellow-400"
                          : "text-orange-400";

                  const qualitySummary = result.channel_probes
                    .filter((p) => p.resolution)
                    .map((p) => {
                      const parts: string[] = [];
                      if (p.resolution) parts.push(p.resolution);
                      if (p.codec) parts.push(p.codec);
                      if (p.fps) parts.push(`${p.fps}fps`);
                      return parts.join(" ");
                    })
                    .filter((v, idx, arr) => arr.indexOf(v) === idx)
                    .join(", ");

                  const screenshots = result.channel_probes.filter((p) => p.screenshot);

                  return (
                    <div
                      key={result.server}
                      className={`rounded-lg border overflow-hidden transition-colors ${
                        result.success
                          ? "cursor-pointer border-border-app hover:border-blue-500/50"
                          : "opacity-50 border-border-app"
                      } ${i === 0 && result.success ? "ring-1 ring-green-500/30" : ""}`}
                      onClick={() => {
                        if (result.success) onSelectServer(result.server);
                      }}
                      title={
                        result.success
                          ? t("sources.serverTest.clickToUse", { server: result.server })
                          : (result.error ?? undefined)
                      }
                    >
                      {/* Header */}
                      <div className="px-4 py-3 bg-surface">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {i === 0 && result.success && (
                              <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-400 uppercase tracking-wide">
                                {t("sources.serverTest.best")}
                              </span>
                            )}
                            <span
                              dir="ltr"
                              className="text-[14px] font-semibold text-text-primary truncate"
                            >
                              {hostLabel}
                            </span>
                            {current !== null &&
                              normalizeXtreamServer(result.server) === current && (
                                <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-blue-400 uppercase tracking-wide">
                                  {t("sources.serverTest.current")}
                                </span>
                              )}
                            {result.resolved_host && result.resolved_host !== hostLabel && (
                              <span
                                dir="ltr"
                                className="text-[11px] text-text-muted font-mono truncate"
                              >
                                {result.resolved_host}
                              </span>
                            )}
                          </div>
                        </div>

                        {result.error ? (
                          <span
                            dir="auto"
                            className="text-[12px] text-red-400"
                            title={result.error}
                          >
                            {result.error}
                          </span>
                        ) : (
                          <div className="flex items-center gap-5 text-[12px]">
                            <span className="text-text-secondary tabular-nums">
                              <span className="text-text-muted">API</span>{" "}
                              {result.api_latency_ms != null ? `${result.api_latency_ms}ms` : "—"}
                            </span>
                            <span className={`tabular-nums ${streamLatencyColor}`}>
                              <span className="text-text-muted">
                                {t("sources.serverTest.stream")}
                              </span>{" "}
                              {result.avg_stream_latency_ms != null
                                ? `${result.avg_stream_latency_ms}ms`
                                : "—"}
                            </span>
                            {qualitySummary && (
                              <span className="text-text-secondary truncate">{qualitySummary}</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Screenshots */}
                      {screenshots.length > 0 && (
                        <div className="flex gap-1 p-1.5 bg-black/20">
                          {result.channel_probes.map((probe) => (
                            <div key={probe.stream_id} className="flex-1 min-w-0">
                              {probe.screenshot ? (
                                <img
                                  src={probe.screenshot}
                                  alt={t("sources.serverTest.channelScreenshotAlt", {
                                    id: probe.stream_id,
                                  })}
                                  className="w-full h-auto rounded"
                                />
                              ) : (
                                <div className="aspect-video bg-black/30 rounded flex items-center justify-center text-[10px] text-text-muted">
                                  {t("sources.serverTest.noImage")}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="text-[11px] text-text-muted">
                {selectHint ?? t("sources.serverTest.selectHint")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
