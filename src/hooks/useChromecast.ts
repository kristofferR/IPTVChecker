import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { castToDevice, discoverChromecasts, getCastStatus, stopCast } from "../lib/tauri";
import type { CastMediaRequest, CastSession, ChromecastDevice } from "../lib/types";

export interface UseChromecastResult {
  devices: ChromecastDevice[];
  discovering: boolean;
  session: CastSession | null;
  error: string | null;
  refreshDevices: () => Promise<void>;
  cast: (device: ChromecastDevice, request: CastMediaRequest) => Promise<void>;
  stop: () => Promise<void>;
}

export function useChromecast(): UseChromecastResult {
  const [devices, setDevices] = useState<ChromecastDevice[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [session, setSession] = useState<CastSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refreshDevices = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const found = await discoverChromecasts();
      if (!cancelledRef.current) setDevices(found);
    } catch (err) {
      if (!cancelledRef.current) setError(String(err));
    } finally {
      if (!cancelledRef.current) setDiscovering(false);
    }
  }, []);

  const cast = useCallback(async (device: ChromecastDevice, request: CastMediaRequest) => {
    setError(null);
    try {
      const next = await castToDevice(device, request);
      if (!cancelledRef.current) setSession(next);
    } catch (err) {
      if (!cancelledRef.current) {
        setError(String(err));
        // A same-device redirect may fail after the backend has restored the
        // previous cast. Reconcile instead of assuming the receiver stopped.
        try {
          const current = await getCastStatus();
          if (!cancelledRef.current) setSession(current);
        } catch {
          // Keep the last known session when status cannot be refreshed.
        }
      }
      throw err;
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await stopCast();
      // Only clear locally on a successful backend stop. If the call rejects
      // (transport down, command error, …) the receiver may still be
      // playing — clearing here would lie to the rest of the UI and break
      // follow-up flows like cast-redirect that gate on isCastSessionActive.
      if (!cancelledRef.current) {
        setError(null);
        setSession(null);
      }
    } catch (err) {
      if (!cancelledRef.current) setError(String(err));
      throw err;
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    (async () => {
      try {
        const initial = await getCastStatus();
        if (mounted && !cancelledRef.current) setSession(initial);
      } catch {
        // ignore — no active session is the norm
      }
      try {
        const off = await listen<CastSession>("cast://status", (event) => {
          if (!mounted || cancelledRef.current) return;
          const next = event.payload;
          if (next.state === "stopped") {
            setSession(null);
            setError(null);
            return;
          }
          setSession(next);
          if (next.state === "error") {
            setError(next.errorMessage ?? "Cast session error");
          } else {
            // A healthy update means whatever caused a previous error has
            // recovered — drop the stale message so the menu doesn't keep
            // showing it.
            setError(null);
          }
        });
        // If cleanup ran while listen() was in flight, release the listener
        // immediately instead of leaving it orphaned on the Tauri side.
        if (!mounted) {
          off();
          return;
        }
        unlisten = off;
      } catch (err) {
        if (mounted && !cancelledRef.current) setError(String(err));
      }
    })();

    return () => {
      mounted = false;
      cancelledRef.current = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Memoize so consumers keyed on this object (ThumbnailPanel, CastMenu)
  // don't see a new identity on every render of the owning component.
  return useMemo(
    () => ({ devices, discovering, session, error, refreshDevices, cast, stop }),
    [devices, discovering, session, error, refreshDevices, cast, stop],
  );
}
