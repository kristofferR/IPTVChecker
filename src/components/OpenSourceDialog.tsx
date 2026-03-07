import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Cpu, KeyRound, Link2, Server, X, Loader2 } from "lucide-react";
import type {
  StalkerOpenRequest,
  XtreamOpenRequest,
  XtreamRecentSource,
  XtreamServerTestReport,
} from "../lib/types";
import { testXtreamServers } from "../lib/tauri";

type OpenSourceMode = "url" | "xtream" | "stalker";

interface OpenSourceDialogProps {
  initialMode: OpenSourceMode;
  initialUrl?: string;
  initialXtream?: XtreamRecentSource | null;
  initialStalker?: StalkerOpenRequest | null;
  onOpenUrl: (url: string) => Promise<string | true>;
  onOpenXtream: (source: XtreamOpenRequest, savePassword?: boolean) => Promise<string | true>;
  onOpenStalker: (source: StalkerOpenRequest) => Promise<string | true>;
  onClose: () => void;
}

function validateHttpUrl(url: string, label: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return `${label} cannot be empty.`;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `${label} must start with http:// or https://`;
  }
  return null;
}

interface ServerTestModalProps {
  initialServer: string;
  username: string;
  password: string;
  onSelectServer: (server: string) => void;
  onClose: () => void;
}

function ServerTestModal({
  initialServer,
  username,
  password,
  onSelectServer,
  onClose,
}: ServerTestModalProps) {
  const [testServers, setTestServers] = useState(initialServer);
  const [testReport, setTestReport] = useState<XtreamServerTestReport | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

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
      setTestError("Enter at least one server URL.");
      return;
    }
    setTestError(null);
    setTestReport(null);
    setTestRunning(true);
    try {
      const report = await testXtreamServers(lines, username, password);
      setTestReport(report);
    } catch (error: unknown) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTestRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-5xl rounded-xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              Xtream
            </p>
            <h2 className="text-[18px] font-semibold text-text-primary">
              Test Servers
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
            aria-label="Close server test"
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
              Server URLs (one per line)
            </label>
            <textarea
              id="server-test-urls"
              rows={6}
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
              {testRunning ? "Testing..." : "Run Test"}
            </button>

            {testRunning && (
              <span className="text-[12px] text-text-tertiary">
                Discovering channels and probing servers...
              </span>
            )}
          </div>

          {testError && (
            <p className="text-[12px] text-red-400">{testError}</p>
          )}

          {testReport && (
            <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
              <div className="flex items-center gap-4 text-[12px] text-text-tertiary">
                <span className={testReport.same_cdn ? "text-yellow-400" : "text-green-400"}>
                  {testReport.same_cdn ? "Same CDN" : "Different CDNs"}
                </span>
                <span>
                  Tested {testReport.channels_probed} channel{testReport.channels_probed !== 1 ? "s" : ""} per server
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

                  const streamLatencyColor = result.avg_stream_latency_ms == null
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
                        if (result.success) {
                          onSelectServer(result.server);
                          onClose();
                        }
                      }}
                      title={result.success ? `Click to use ${result.server}` : result.error ?? undefined}
                    >
                      {/* Header */}
                      <div className="px-4 py-3 bg-surface">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {i === 0 && result.success && (
                              <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-400 uppercase tracking-wide">
                                Best
                              </span>
                            )}
                            <span className="text-[14px] font-semibold text-text-primary truncate">
                              {hostLabel}
                            </span>
                            {result.resolved_host && result.resolved_host !== hostLabel && (
                              <span className="text-[11px] text-text-muted font-mono truncate">
                                {result.resolved_host}
                              </span>
                            )}
                          </div>
                        </div>

                        {result.error ? (
                          <span className="text-[12px] text-red-400" title={result.error}>
                            {result.error}
                          </span>
                        ) : (
                          <div className="flex items-center gap-5 text-[12px]">
                            <span className="text-text-secondary tabular-nums">
                              <span className="text-text-muted">API</span> {result.api_latency_ms != null ? `${result.api_latency_ms}ms` : "—"}
                            </span>
                            <span className={`tabular-nums ${streamLatencyColor}`}>
                              <span className="text-text-muted">Stream</span> {result.avg_stream_latency_ms != null ? `${result.avg_stream_latency_ms}ms` : "—"}
                            </span>
                            {qualitySummary && (
                              <span className="text-text-secondary truncate">
                                {qualitySummary}
                              </span>
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
                                  alt={`Channel ${probe.stream_id}`}
                                  className="w-full h-auto rounded"
                                />
                              ) : (
                                <div className="aspect-video bg-black/30 rounded flex items-center justify-center text-[10px] text-text-muted">
                                  No image
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
                Click a server to select it and return to the login form.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OpenSourceDialog({
  initialMode,
  initialUrl,
  initialXtream,
  initialStalker,
  onOpenUrl,
  onOpenXtream,
  onOpenStalker,
  onClose,
}: OpenSourceDialogProps) {
  const [mode, setMode] = useState<OpenSourceMode>(initialMode);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [xtreamServer, setXtreamServer] = useState(initialXtream?.server ?? "");
  const [xtreamUsername, setXtreamUsername] = useState(initialXtream?.username ?? "");
  const [xtreamPassword, setXtreamPassword] = useState(
    initialXtream?.password ?? "",
  );
  const [xtreamSavePassword, setXtreamSavePassword] = useState(
    !!initialXtream?.password,
  );
  const [stalkerPortal, setStalkerPortal] = useState(initialStalker?.portal ?? "");
  const [stalkerMac, setStalkerMac] = useState(initialStalker?.mac ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showServerTest, setShowServerTest] = useState(false);

  const initialXtreamServer = initialXtream?.server ?? "";
  const initialXtreamUsername = initialXtream?.username ?? "";
  const initialXtreamPassword = initialXtream?.password ?? "";
  const initialStalkerPortal = initialStalker?.portal ?? "";
  const initialStalkerMac = initialStalker?.mac ?? "";

  useEffect(() => {
    setMode(initialMode);
    setUrl(initialUrl ?? "");
    setXtreamServer(initialXtreamServer);
    setXtreamUsername(initialXtreamUsername);
    setXtreamPassword(initialXtreamPassword);
    setXtreamSavePassword(!!initialXtreamPassword);
    setStalkerPortal(initialStalkerPortal);
    setStalkerMac(initialStalkerMac);
    setLocalError(null);
    setSubmitting(false);
  }, [
    initialMode,
    initialUrl,
    initialXtreamServer,
    initialXtreamUsername,
    initialXtreamPassword,
    initialStalkerPortal,
    initialStalkerMac,
  ]);

  const handleClose = useCallback(() => {
    setXtreamPassword("");
    setLocalError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (showServerTest) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, showServerTest]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setLocalError(null);
    setSubmitting(true);

    try {
      if (mode === "url") {
        const validationError = validateHttpUrl(url, "Playlist URL");
        if (validationError) {
          setLocalError(validationError);
          return;
        }

        const urlResult = await onOpenUrl(url.trim());
        if (urlResult === true) {
          handleClose();
        } else {
          setLocalError(urlResult);
        }
        return;
      }

      if (mode === "stalker") {
        const portalError = validateHttpUrl(stalkerPortal, "Stalker portal");
        if (portalError) {
          setLocalError(portalError);
          return;
        }

        const mac = stalkerMac.trim();
        if (!mac) {
          setLocalError("Stalker MAC address cannot be empty.");
          return;
        }

        const stalkerResult = await onOpenStalker({
          portal: stalkerPortal.trim(),
          mac,
        });
        if (stalkerResult === true) {
          handleClose();
        } else {
          setLocalError(stalkerResult);
        }
        return;
      }

      const serverError = validateHttpUrl(xtreamServer, "Xtream server");
      if (serverError) {
        setLocalError(serverError);
        return;
      }

      const username = xtreamUsername.trim();
      if (!username) {
        setLocalError("Xtream username cannot be empty.");
        return;
      }

      const password = xtreamPassword.trim();
      if (!password) {
        setLocalError("Xtream password cannot be empty.");
        return;
      }

      const xtreamResult = await onOpenXtream(
        {
          server: xtreamServer.trim(),
          username,
          password,
        },
        xtreamSavePassword,
      );
      setXtreamPassword("");
      if (xtreamResult === true) {
        handleClose();
      } else {
        setLocalError(xtreamResult);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (nextMode: OpenSourceMode) => {
    setMode(nextMode);
    setLocalError(null);
    if (nextMode !== "xtream") {
      setXtreamPassword("");
      setXtreamSavePassword(false);
    }
  };

  const handleOpenServerTest = () => {
    const u = xtreamUsername.trim();
    const p = xtreamPassword.trim();
    if (!u || !p) {
      setLocalError("Enter username and password before testing servers.");
      return;
    }
    setLocalError(null);
    setShowServerTest(true);
  };

  const tabClass = (tab: OpenSourceMode) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
      mode === tab
        ? "bg-blue-600 text-white"
        : "bg-btn text-text-secondary hover:bg-btn-hover"
    }`;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/45" onClick={handleClose} />
        <div className="relative w-full max-w-xl rounded-xl border border-border-app bg-overlay shadow-2xl">
          <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
                Source
              </p>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Open Playlist Source
              </h2>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
              aria-label="Close source dialog"
            >
              <X className="w-[18px] h-[18px]" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => switchMode("url")}
                className={tabClass("url")}
              >
                <Link2 className="w-4 h-4" />
                URL
              </button>
              <button
                type="button"
                onClick={() => switchMode("xtream")}
                className={tabClass("xtream")}
              >
                <KeyRound className="w-4 h-4" />
                Xtream
              </button>
              <button
                type="button"
                onClick={() => switchMode("stalker")}
                className={tabClass("stalker")}
              >
                <Cpu className="w-4 h-4" />
                Stalker
              </button>
            </div>

            {mode === "url" ? (
              <div className="space-y-2">
                <label
                  htmlFor="open-source-url"
                  className="text-[12px] font-medium text-text-secondary"
                >
                  Playlist URL
                </label>
                <input
                  id="open-source-url"
                  type="text"
                  autoFocus
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/playlist.m3u8"
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                />
              </div>
            ) : mode === "xtream" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-xtream-server"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    Xtream Server
                  </label>
                  <input
                    id="open-source-xtream-server"
                    type="text"
                    autoFocus
                    value={xtreamServer}
                    onChange={(event) => setXtreamServer(event.target.value)}
                    placeholder="https://example.com:8080"
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-xtream-username"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    Username
                  </label>
                  <input
                    id="open-source-xtream-username"
                    type="text"
                    value={xtreamUsername}
                    onChange={(event) => setXtreamUsername(event.target.value)}
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-xtream-password"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    Password
                  </label>
                  <input
                    id="open-source-xtream-password"
                    type="password"
                    value={xtreamPassword}
                    onChange={(event) => setXtreamPassword(event.target.value)}
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={xtreamSavePassword}
                      onChange={(event) =>
                        setXtreamSavePassword(event.target.checked)
                      }
                      className="rounded border-border-app accent-blue-600"
                    />
                    <span className="text-[12px] text-text-secondary">
                      Save password in recents
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={handleOpenServerTest}
                    className="inline-flex items-center gap-1.5 rounded-md bg-btn px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-btn-hover hover:text-text-primary transition-colors"
                  >
                    <Server className="w-3.5 h-3.5" />
                    Test Servers
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-stalker-portal"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    Stalker Portal URL
                  </label>
                  <input
                    id="open-source-stalker-portal"
                    type="text"
                    autoFocus
                    value={stalkerPortal}
                    onChange={(event) => setStalkerPortal(event.target.value)}
                    placeholder="https://example.com:8080"
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-stalker-mac"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    MAC Address
                  </label>
                  <input
                    id="open-source-stalker-mac"
                    type="text"
                    value={stalkerMac}
                    onChange={(event) => setStalkerMac(event.target.value)}
                    placeholder="00:1A:79:12:34:56"
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {localError && (
              <p className="mt-3 text-[12px] text-red-400">{localError}</p>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-md bg-btn px-3 py-2 text-[13px] text-text-primary hover:bg-btn-hover transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-blue-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none transition-colors"
              >
                {submitting ? "Opening..." : "Open"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {showServerTest && (
        <ServerTestModal
          initialServer={xtreamServer.trim()}
          username={xtreamUsername.trim()}
          password={xtreamPassword.trim()}
          onSelectServer={(server) => setXtreamServer(server)}
          onClose={() => setShowServerTest(false)}
        />
      )}
    </>
  );
}
