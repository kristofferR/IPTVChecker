import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Cpu, KeyRound, Link2, X } from "lucide-react";
import type {
  StalkerOpenRequest,
  XtreamOpenRequest,
  XtreamRecentSource,
} from "../lib/types";

type OpenSourceMode = "url" | "xtream" | "stalker";

interface OpenSourceDialogProps {
  initialMode: OpenSourceMode;
  initialUrl?: string;
  initialXtream?: XtreamRecentSource | null;
  initialStalker?: StalkerOpenRequest | null;
  onOpenUrl: (url: string) => Promise<string | true>;
  onOpenXtream: (source: XtreamOpenRequest) => Promise<string | true>;
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
  const [xtreamPassword, setXtreamPassword] = useState("");
  const [stalkerPortal, setStalkerPortal] = useState(initialStalker?.portal ?? "");
  const [stalkerMac, setStalkerMac] = useState(initialStalker?.mac ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const initialXtreamServer = initialXtream?.server ?? "";
  const initialXtreamUsername = initialXtream?.username ?? "";
  const initialStalkerPortal = initialStalker?.portal ?? "";
  const initialStalkerMac = initialStalker?.mac ?? "";

  useEffect(() => {
    setMode(initialMode);
    setUrl(initialUrl ?? "");
    setXtreamServer(initialXtreamServer);
    setXtreamUsername(initialXtreamUsername);
    setXtreamPassword("");
    setStalkerPortal(initialStalkerPortal);
    setStalkerMac(initialStalkerMac);
    setLocalError(null);
    setSubmitting(false);
  }, [
    initialMode,
    initialUrl,
    initialXtreamServer,
    initialXtreamUsername,
    initialStalkerPortal,
    initialStalkerMac,
  ]);

  const handleClose = useCallback(() => {
    setXtreamPassword("");
    setLocalError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

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

      const xtreamResult = await onOpenXtream({
        server: xtreamServer.trim(),
        username,
        password,
      });
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
    }
  };

  const tabClass = (tab: OpenSourceMode) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
      mode === tab
        ? "bg-blue-600 text-white"
        : "bg-btn text-text-secondary hover:bg-btn-hover"
    }`;

  return (
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
  );
}
