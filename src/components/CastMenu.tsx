import { Cast, ChevronDown, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCastSessionActive } from "../lib/cast";
import type { CastMediaRequest, CastSession, ChromecastDevice } from "../lib/types";

interface UseChromecastShape {
  devices: ChromecastDevice[];
  discovering: boolean;
  session: CastSession | null;
  error: string | null;
  refreshDevices: () => Promise<void>;
  cast: (device: ChromecastDevice, request: CastMediaRequest) => Promise<void>;
  stop: () => Promise<void>;
}

export type CastStartHandler = () => (() => void) | undefined;

interface CastMenuProps {
  chromecast: UseChromecastShape;
  castRequest: CastMediaRequest;
  mode: "popover" | "inline";
  /**
   * Fired before cast startup so the local stream can release its upstream
   * connection. May return a rollback to run if startup fails.
   */
  onCastStart?: CastStartHandler;
  /**
   * Popover-mode only: fired when the menu opens or closes so the parent can
   * suppress auto-hide of surrounding chrome while the picker is visible.
   */
  onOpenChange?: (open: boolean) => void;
}

export function CastMenu({
  chromecast,
  castRequest,
  mode,
  onCastStart,
  onOpenChange,
}: CastMenuProps) {
  if (mode === "popover") {
    return (
      <CastMenuPopover
        chromecast={chromecast}
        castRequest={castRequest}
        onCastStart={onCastStart}
        onOpenChange={onOpenChange}
      />
    );
  }
  return (
    <CastMenuInline chromecast={chromecast} castRequest={castRequest} onCastStart={onCastStart} />
  );
}

// ---------- Popover (lightbox / full player) ----------

function CastMenuPopover({
  chromecast,
  castRequest,
  onCastStart,
  onOpenChange,
}: Omit<CastMenuProps, "mode">) {
  const [open, setOpenState] = useState(false);
  const [starting, setStarting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isCasting = isCastSessionActive(chromecast.session);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, setOpen]);

  const openMenu = useCallback(() => {
    setOpen(true);
    void chromecast.refreshDevices();
  }, [chromecast, setOpen]);

  const handleCast = useCallback(
    async (device: ChromecastDevice) => {
      setStarting(true);
      // Fire onCastStart BEFORE the network round-trip with the TV. The parent
      // uses it to stop local playback (releasing the IPTV upstream slot for
      // ffmpeg), and it also flips playIntentActive=false so arrow-key
      // navigation in the channel table won't auto-start a new local stream
      // mid-handshake.
      const rollBackCastStart = onCastStart?.();
      try {
        await chromecast.cast(device, castRequest);
        setOpen(false);
      } catch {
        rollBackCastStart?.();
        // error surfaces via chromecast.error; keep menu open so the user sees it
      } finally {
        setStarting(false);
      }
    },
    [castRequest, chromecast, onCastStart],
  );

  const handleStop = useCallback(async () => {
    try {
      await chromecast.stop();
    } finally {
      setOpen(false);
    }
  }, [chromecast]);

  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`p-1 transition-colors ${
          isCasting ? "text-blue-300 hover:text-blue-200" : "text-white hover:text-white/80"
        }`}
        title={isCasting ? `Casting to ${chromecast.session?.deviceName ?? "device"}` : "Cast"}
      >
        <Cast className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 rounded-md border border-white/10 bg-black/90 backdrop-blur-sm shadow-xl text-white text-[12px] z-10">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <span className="font-medium">{isCasting ? "Casting" : "Cast to device"}</span>
            <button
              type="button"
              onClick={() => void chromecast.refreshDevices()}
              disabled={chromecast.discovering}
              className="p-1 text-white/70 hover:text-white disabled:opacity-50"
              title="Refresh devices"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${chromecast.discovering ? "animate-spin" : ""}`}
              />
            </button>
          </div>
          {isCasting && chromecast.session && (
            <div className="px-3 py-2 border-b border-white/10">
              <div className="text-white/85">{chromecast.session.deviceName}</div>
              <div className="text-[11px] text-white/55 capitalize">{chromecast.session.state}</div>
              <button
                type="button"
                onClick={() => void handleStop()}
                className="mt-2 w-full px-2 py-1 text-[11px] font-medium rounded bg-red-600/80 hover:bg-red-600 transition-colors"
              >
                Stop casting
              </button>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {chromecast.devices.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-white/55 text-center">
                {chromecast.discovering ? "Searching for devices..." : "No devices found"}
              </div>
            ) : (
              chromecast.devices.map((device) => {
                const active = chromecast.session?.deviceId === device.id && isCasting;
                return (
                  <button
                    key={device.id}
                    type="button"
                    onClick={() => void handleCast(device)}
                    disabled={starting || active}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-left"
                  >
                    <Cast className="w-3.5 h-3.5 shrink-0 text-white/70" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{device.friendlyName}</div>
                      {device.model && (
                        <div className="text-[10px] text-white/45 truncate">{device.model}</div>
                      )}
                    </div>
                    {active && <span className="text-[10px] text-blue-300">Active</span>}
                  </button>
                );
              })
            )}
          </div>
          {chromecast.error && (
            <div className="px-3 py-2 border-t border-white/10 text-[11px] text-red-300">
              {chromecast.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Inline (sidebar) ----------

function CastMenuInline({ chromecast, castRequest, onCastStart }: Omit<CastMenuProps, "mode">) {
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const isCasting = isCastSessionActive(chromecast.session);

  // Auto-expand when casting so the active session is always visible without
  // an extra click; collapse back when it ends.
  useEffect(() => {
    if (isCasting) setExpanded(true);
  }, [isCasting]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !isCasting) void chromecast.refreshDevices();
      return next;
    });
  }, [chromecast, isCasting]);

  const handleCast = useCallback(
    async (device: ChromecastDevice) => {
      setStarting(true);
      // Fire onCastStart BEFORE the network round-trip — see CastMenuPopover
      // for the rationale (release upstream slot + suppress arrow-key
      // auto-play during the cast handshake).
      const rollBackCastStart = onCastStart?.();
      try {
        await chromecast.cast(device, castRequest);
      } catch {
        rollBackCastStart?.();
        // error surfaces via chromecast.error; row stays expanded
      } finally {
        setStarting(false);
      }
    },
    [castRequest, chromecast, onCastStart],
  );

  const handleStop = useCallback(() => {
    void chromecast.stop();
  }, [chromecast]);

  return (
    <div className="rounded-md border border-border-subtle bg-panel-subtle">
      {isCasting && chromecast.session ? (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <Cast className="h-3.5 w-3.5 shrink-0 text-blue-500" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-text-primary truncate">
                Casting to {chromecast.session.deviceName}
              </div>
              <div className="text-[11px] text-text-tertiary capitalize">
                {chromecast.session.state}
              </div>
            </div>
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-red-600 hover:bg-red-500 text-white transition-colors shrink-0"
              title="Stop casting"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
          </div>
          {chromecast.error && (
            <div className="text-[11px] text-red-500 break-words">{chromecast.error}</div>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={handleToggle}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-panel-muted"
          >
            <Cast className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
            <span className="flex-1 text-[12px] font-medium text-text-primary">
              Cast to a device
            </span>
            {chromecast.discovering && (
              <RefreshCw className="h-3 w-3 animate-spin text-text-tertiary" />
            )}
            <ChevronDown
              className={`h-3.5 w-3.5 text-text-tertiary transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            />
          </button>
          {expanded && (
            <div className="border-t border-border-subtle">
              <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-text-tertiary">
                <span>
                  {chromecast.devices.length} device{chromecast.devices.length === 1 ? "" : "s"}{" "}
                  found
                </span>
                <button
                  type="button"
                  onClick={() => void chromecast.refreshDevices()}
                  disabled={chromecast.discovering}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-panel-muted disabled:opacity-50"
                  title="Refresh devices"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${chromecast.discovering ? "animate-spin" : ""}`}
                  />
                  Refresh
                </button>
              </div>
              <div className="border-t border-border-subtle">
                {chromecast.devices.length === 0 ? (
                  <div className="px-3 py-3 text-center text-[11px] text-text-tertiary">
                    {chromecast.discovering
                      ? "Searching for devices..."
                      : "No Chromecast devices found on the network."}
                  </div>
                ) : (
                  chromecast.devices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => void handleCast(device)}
                      disabled={starting}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-panel-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Cast className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-text-primary truncate">
                          {device.friendlyName}
                        </div>
                        {device.model && (
                          <div className="text-[10px] text-text-tertiary truncate">
                            {device.model}
                          </div>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
              {chromecast.error && (
                <div className="px-3 py-2 border-t border-border-subtle text-[11px] text-red-500 break-words">
                  {chromecast.error}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
