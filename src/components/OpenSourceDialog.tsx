import { listen } from "@tauri-apps/api/event";
import { Cpu, KeyRound, Link2, Loader2, Network, Server, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { t, tRich } from "../i18n";
import { normalizeDispatcharrServer } from "../lib/dispatcharr";
import { testXtreamServers } from "../lib/tauri";
import type {
  DispatcharrOpenRequest,
  StalkerOpenRequest,
  XtreamOpenRequest,
  XtreamRecentSource,
  XtreamServerTestReport,
} from "../lib/types";
import PasswordField from "./PasswordField";

type OpenSourceMode = "url" | "xtream" | "stalker" | "dispatcharr";
type DispatcharrAuthMode = "apiKey" | "login";

interface OpenSourceDialogProps {
  initialMode: OpenSourceMode;
  initialUrl?: string;
  initialXtream?: XtreamRecentSource | null;
  initialStalker?: StalkerOpenRequest | null;
  initialDispatcharr?: DispatcharrOpenRequest | null;
  /** Saved playlist this Dispatcharr source will replace, when converting. */
  convertSaved?: { id: string; name: string } | null;
  onOpenUrl: (url: string) => Promise<string | true>;
  onOpenXtream: (source: XtreamOpenRequest, savePassword?: boolean) => Promise<string | true>;
  onOpenStalker: (source: StalkerOpenRequest) => Promise<string | true>;
  onOpenDispatcharr: (
    source: DispatcharrOpenRequest,
    rememberSecrets?: boolean,
  ) => Promise<string | true>;
  onClose: () => void;
}

type UrlField = "playlistUrl" | "stalkerPortal" | "dispatcharrServer" | "xtreamServer";

function validateHttpUrl(url: string, field: UrlField): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return t(`sources.validation.${field}Empty`);
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return t(`sources.validation.${field}Scheme`);
  }
  return null;
}

interface ServerTestModalProps {
  initialServersText: string;
  username: string;
  password: string;
  onSelectServer: (server: string) => void;
  onClose: () => void;
}

export function ServerTestModal({
  initialServersText,
  username,
  password,
  onSelectServer,
  onClose,
}: ServerTestModalProps) {
  const [testServers, setTestServers] = useState(initialServersText);
  const [testReport, setTestReport] = useState<XtreamServerTestReport | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testProgress, setTestProgress] = useState<string | null>(null);
  const testRunningRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<string>("scan://server-test-progress", (event) => {
      if (testRunningRef.current) {
        setTestProgress(event.payload);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
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
      const report = await testXtreamServers(lines, username, password);
      setTestReport(report);
    } catch (error: unknown) {
      setTestError(error instanceof Error ? error.message : String(error));
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
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              Xtream
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
                        if (result.success) {
                          onSelectServer(result.server);
                          onClose();
                        }
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

              <p className="text-[11px] text-text-muted">{t("sources.serverTest.selectHint")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OpenSourceDialog({
  initialMode,
  initialUrl,
  initialXtream,
  initialStalker,
  initialDispatcharr,
  convertSaved,
  onOpenUrl,
  onOpenXtream,
  onOpenStalker,
  onOpenDispatcharr,
  onClose,
}: OpenSourceDialogProps) {
  const [mode, setMode] = useState<OpenSourceMode>(initialMode);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [xtreamServer, setXtreamServer] = useState(initialXtream?.server ?? "");
  const [xtreamUsername, setXtreamUsername] = useState(initialXtream?.username ?? "");
  const [xtreamPassword, setXtreamPassword] = useState(initialXtream?.password ?? "");
  const [xtreamSavePassword, setXtreamSavePassword] = useState(!!initialXtream?.password);
  const [stalkerPortal, setStalkerPortal] = useState(initialStalker?.portal ?? "");
  const [stalkerMac, setStalkerMac] = useState(initialStalker?.mac ?? "");
  const [dispatcharrServer, setDispatcharrServer] = useState(initialDispatcharr?.server ?? "");
  const [dispatcharrServerAutofilled, setDispatcharrServerAutofilled] = useState(false);
  const [dispatcharrAuthMode, setDispatcharrAuthMode] = useState<DispatcharrAuthMode>(
    initialDispatcharr?.username && !initialDispatcharr.api_key ? "login" : "apiKey",
  );
  const [dispatcharrApiKey, setDispatcharrApiKey] = useState(initialDispatcharr?.api_key ?? "");
  const [dispatcharrUsername, setDispatcharrUsername] = useState(
    initialDispatcharr?.username ?? "",
  );
  const [dispatcharrPassword, setDispatcharrPassword] = useState(
    initialDispatcharr?.password ?? "",
  );
  const [dispatcharrRemember, setDispatcharrRemember] = useState(
    Boolean(initialDispatcharr?.api_key || initialDispatcharr?.password),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showServerTest, setShowServerTest] = useState(false);

  const initialXtreamServer = initialXtream?.server ?? "";
  const initialXtreamUsername = initialXtream?.username ?? "";
  const initialXtreamPassword = initialXtream?.password ?? "";
  const initialStalkerPortal = initialStalker?.portal ?? "";
  const initialStalkerMac = initialStalker?.mac ?? "";
  const initialDispatcharrServer = initialDispatcharr?.server ?? "";
  const initialDispatcharrUsername = initialDispatcharr?.username ?? "";
  const initialDispatcharrPassword = initialDispatcharr?.password ?? "";
  const initialDispatcharrApiKey = initialDispatcharr?.api_key ?? "";

  useEffect(() => {
    setMode(initialMode);
    setUrl(initialUrl ?? "");
    setXtreamServer(initialXtreamServer);
    setXtreamUsername(initialXtreamUsername);
    setXtreamPassword(initialXtreamPassword);
    setXtreamSavePassword(!!initialXtreamPassword);
    setStalkerPortal(initialStalkerPortal);
    setStalkerMac(initialStalkerMac);
    setDispatcharrServer(initialDispatcharrServer);
    setDispatcharrServerAutofilled(false);
    setDispatcharrAuthMode(
      initialDispatcharrUsername && !initialDispatcharrApiKey ? "login" : "apiKey",
    );
    setDispatcharrApiKey(initialDispatcharrApiKey);
    setDispatcharrUsername(initialDispatcharrUsername);
    setDispatcharrPassword(initialDispatcharrPassword);
    setDispatcharrRemember(Boolean(initialDispatcharrApiKey || initialDispatcharrPassword));
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
    initialDispatcharrServer,
    initialDispatcharrUsername,
    initialDispatcharrPassword,
    initialDispatcharrApiKey,
  ]);

  const handleClose = useCallback(() => {
    setXtreamPassword("");
    setDispatcharrPassword("");
    setDispatcharrApiKey("");
    setLocalError(null);
    onClose();
  }, [onClose]);

  // A conversion in progress replaces a saved playlist once it verifies, so
  // the dialog cannot be dismissed until it finishes or fails.
  const conversionPending = submitting && Boolean(convertSaved);
  const requestClose = useCallback(() => {
    if (!conversionPending) handleClose();
  }, [conversionPending, handleClose]);

  useEffect(() => {
    if (showServerTest) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [requestClose, showServerTest]);

  const parseXtreamM3ULink = (link: string) => {
    try {
      const url = new URL(link);
      const u = url.searchParams.get("username");
      const p = url.searchParams.get("password");

      if (u && p) {
        setXtreamServer(`${url.protocol}//${url.host}`);
        setXtreamUsername(u);
        setXtreamPassword(p);

        // exit if we already set credentials
        return;
      }
    } catch (_) {}

    // fallback to setting the link as is
    setXtreamServer(link);
  };

  // A pasted Dispatcharr stream or M3U link reduces to the server it came from.
  const handleDispatcharrServerChange = (value: string) => {
    const pastedLink = /\/(proxy|output)\//i.test(value);
    const normalized = pastedLink ? normalizeDispatcharrServer(value) : null;
    setDispatcharrServer(normalized ?? value);
    setDispatcharrServerAutofilled(normalized !== null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setLocalError(null);
    setSubmitting(true);

    try {
      if (mode === "url") {
        const validationError = validateHttpUrl(url, "playlistUrl");
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
        const portalError = validateHttpUrl(stalkerPortal, "stalkerPortal");
        if (portalError) {
          setLocalError(portalError);
          return;
        }

        const mac = stalkerMac.trim();
        if (!mac) {
          setLocalError(t("sources.validation.stalkerMacEmpty"));
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

      if (mode === "dispatcharr") {
        const serverError = validateHttpUrl(dispatcharrServer, "dispatcharrServer");
        if (serverError) {
          setLocalError(serverError);
          return;
        }
        const apiKey = dispatcharrApiKey.trim();
        const username = dispatcharrUsername.trim();
        const password = dispatcharrPassword.trim();
        if (dispatcharrAuthMode === "apiKey" && !apiKey) {
          setLocalError(t("sources.validation.dispatcharrApiKeyEmpty"));
          return;
        }
        if (dispatcharrAuthMode === "login" && (!username || !password)) {
          setLocalError(t("sources.validation.dispatcharrLoginMissing"));
          return;
        }
        const dispatcharrResult = await onOpenDispatcharr(
          dispatcharrAuthMode === "apiKey"
            ? { server: dispatcharrServer.trim(), api_key: apiKey }
            : { server: dispatcharrServer.trim(), username, password },
          dispatcharrRemember,
        );
        if (dispatcharrResult === true) {
          handleClose();
        } else {
          setLocalError(dispatcharrResult);
        }
        return;
      }

      const serverError = validateHttpUrl(xtreamServer, "xtreamServer");
      if (serverError) {
        setLocalError(serverError);
        return;
      }

      const username = xtreamUsername.trim();
      if (!username) {
        setLocalError(t("sources.validation.xtreamUsernameEmpty"));
        return;
      }

      const password = xtreamPassword.trim();
      if (!password) {
        setLocalError(t("sources.validation.xtreamPasswordEmpty"));
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
    if (nextMode !== "dispatcharr") {
      setDispatcharrPassword("");
      setDispatcharrApiKey("");
    }
  };

  const handleOpenServerTest = () => {
    const u = xtreamUsername.trim();
    const p = xtreamPassword.trim();
    if (!u || !p) {
      setLocalError(t("sources.validation.credentialsBeforeTest"));
      return;
    }
    setLocalError(null);
    setShowServerTest(true);
  };

  const tabClass = (tab: OpenSourceMode) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
      mode === tab ? "bg-blue-600 text-white" : "bg-btn text-text-secondary hover:bg-btn-hover"
    }`;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/45" onClick={requestClose} />
        <div className="relative w-full max-w-xl rounded-xl border border-border-app bg-overlay shadow-2xl">
          <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
                {t("sources.eyebrow")}
              </p>
              <h2 className="text-[18px] font-semibold text-text-primary">{t("sources.title")}</h2>
            </div>
            <button
              type="button"
              onClick={requestClose}
              disabled={conversionPending}
              className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
              aria-label={t("sources.closeLabel")}
            >
              <X className="w-[18px] h-[18px]" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <button type="button" onClick={() => switchMode("url")} className={tabClass("url")}>
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
              <button
                type="button"
                onClick={() => switchMode("dispatcharr")}
                className={tabClass("dispatcharr")}
              >
                <Network className="w-4 h-4" />
                Dispatcharr
              </button>
            </div>

            {mode === "url" ? (
              <div className="space-y-2">
                <label
                  htmlFor="open-source-url"
                  className="text-[12px] font-medium text-text-secondary"
                >
                  {t("sources.playlistUrl")}
                </label>
                <input
                  id="open-source-url"
                  dir="ltr"
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
                    {t("sources.xtreamServer")}
                  </label>
                  <input
                    id="open-source-xtream-server"
                    dir="ltr"
                    type="text"
                    autoFocus
                    value={xtreamServer}
                    onChange={(event) => parseXtreamM3ULink(event.target.value)}
                    placeholder="https://example.com:8080"
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-xtream-username"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    {t("sources.username")}
                  </label>
                  <input
                    id="open-source-xtream-username"
                    dir="ltr"
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
                    {t("sources.password")}
                  </label>
                  <PasswordField
                    id="open-source-xtream-password"
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
                      onChange={(event) => setXtreamSavePassword(event.target.checked)}
                      className="rounded border-border-app accent-blue-600"
                    />
                    <span className="text-[12px] text-text-secondary">
                      {t("sources.savePasswordInRecents")}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={handleOpenServerTest}
                    className="inline-flex items-center gap-1.5 rounded-md bg-btn px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-btn-hover hover:text-text-primary transition-colors"
                  >
                    <Server className="w-3.5 h-3.5" />
                    {t("sources.testServers")}
                  </button>
                </div>
              </div>
            ) : mode === "dispatcharr" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-dispatcharr-server"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    {t("sources.dispatcharrServer")}
                  </label>
                  <input
                    id="open-source-dispatcharr-server"
                    dir="ltr"
                    type="text"
                    autoFocus
                    value={dispatcharrServer}
                    onChange={(event) => handleDispatcharrServerChange(event.target.value)}
                    placeholder="http://dispatcharr.local:9191"
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                  {dispatcharrServerAutofilled && (
                    <p className="text-[11px] text-text-tertiary">
                      {t("sources.fromPastedStreamUrl")}
                    </p>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-text-secondary">
                    {t("sources.signInWith")}
                  </span>
                  <div className="inline-flex rounded-md bg-btn p-0.5" role="radiogroup">
                    {(
                      [
                        ["apiKey", "sources.apiKey"],
                        ["login", "sources.username"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={dispatcharrAuthMode === value}
                        onClick={() => {
                          setDispatcharrAuthMode(value);
                          setLocalError(null);
                        }}
                        className={`rounded px-2.5 py-1 text-[12px] transition-colors ${
                          dispatcharrAuthMode === value
                            ? "bg-blue-600 text-white"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>
                </div>
                {dispatcharrAuthMode === "apiKey" ? (
                  <PasswordField
                    id="open-source-dispatcharr-api-key"
                    aria-label={t("sources.apiKey")}
                    value={dispatcharrApiKey}
                    onChange={(event) => setDispatcharrApiKey(event.target.value)}
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                ) : (
                  <>
                    <div className="space-y-2">
                      <label
                        htmlFor="open-source-dispatcharr-username"
                        className="text-[12px] font-medium text-text-secondary"
                      >
                        {t("sources.username")}
                      </label>
                      <input
                        id="open-source-dispatcharr-username"
                        dir="ltr"
                        type="text"
                        value={dispatcharrUsername}
                        onChange={(event) => setDispatcharrUsername(event.target.value)}
                        className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label
                        htmlFor="open-source-dispatcharr-password"
                        className="text-[12px] font-medium text-text-secondary"
                      >
                        {t("sources.password")}
                      </label>
                      <PasswordField
                        id="open-source-dispatcharr-password"
                        value={dispatcharrPassword}
                        onChange={(event) => setDispatcharrPassword(event.target.value)}
                        className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  </>
                )}
                {convertSaved ? (
                  <p className="text-[12px] text-text-secondary">
                    {tRich("sources.replacesSavedPlaylist", {
                      name: <bdi>{convertSaved.name}</bdi>,
                    })}
                  </p>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={dispatcharrRemember}
                      onChange={(event) => setDispatcharrRemember(event.target.checked)}
                      className="rounded border-border-app accent-blue-600"
                    />
                    <span className="text-[12px] text-text-secondary">
                      {t("sources.saveCredentialsInRecents")}
                    </span>
                  </label>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label
                    htmlFor="open-source-stalker-portal"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    {t("sources.stalkerPortalUrl")}
                  </label>
                  <input
                    id="open-source-stalker-portal"
                    dir="ltr"
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
                    {t("sources.macAddress")}
                  </label>
                  <input
                    id="open-source-stalker-mac"
                    dir="ltr"
                    type="text"
                    value={stalkerMac}
                    onChange={(event) => setStalkerMac(event.target.value)}
                    placeholder="00:1A:79:12:34:56"
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {localError && <p className="mt-3 text-[12px] text-red-400">{localError}</p>}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={conversionPending}
                className="rounded-md bg-btn px-3 py-2 text-[13px] text-text-primary hover:bg-btn-hover transition-colors disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-blue-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none transition-colors"
              >
                {submitting ? t("sources.opening") : t("common.open")}
              </button>
            </div>
          </form>
        </div>
      </div>

      {showServerTest && (
        <ServerTestModal
          initialServersText={xtreamServer.trim()}
          username={xtreamUsername.trim()}
          password={xtreamPassword.trim()}
          onSelectServer={(server) => setXtreamServer(server)}
          onClose={() => setShowServerTest(false)}
        />
      )}
    </>
  );
}
