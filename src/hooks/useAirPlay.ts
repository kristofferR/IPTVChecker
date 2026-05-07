import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getAirplayStatus,
  startAirplay,
  stopAirplay,
} from "../lib/tauri";
import { detectPlatform } from "../lib/platform";
import type { AirPlayMediaRequest, AirPlaySession } from "../lib/types";

export interface UseAirPlayResult {
  available: boolean;
  session: AirPlaySession | null;
  error: string | null;
  start: (request: AirPlayMediaRequest) => Promise<void>;
  stop: () => Promise<void>;
}

export function useAirPlay(): UseAirPlayResult {
  const [available, setAvailable] = useState(false);
  const [session, setSession] = useState<AirPlaySession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const start = useCallback(
    async (request: AirPlayMediaRequest) => {
      setError(null);
      try {
        const next = await startAirplay(request);
        if (!cancelledRef.current) setSession(next);
      } catch (err) {
        if (!cancelledRef.current) {
          setError(String(err));
          setSession(null);
        }
        throw err;
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    try {
      await stopAirplay();
      // Symmetric to useChromecast.stop: only clear locally on a successful
      // backend stop. If the call rejects (window already torn down, etc.)
      // the receiver may still be playing — clearing here would lie to the
      // rest of the UI and break cast-redirect gates.
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
      // Gate everything on macOS — start_airplay isn't even registered as a
      // command on Windows/Linux, so calling it would reject anyway.
      const platform = await detectPlatform();
      if (!mounted || cancelledRef.current) return;
      if (platform !== "macos") return;
      setAvailable(true);

      try {
        const initial = await getAirplayStatus();
        if (mounted && !cancelledRef.current) setSession(initial);
      } catch {
        // ignore — no active session is the norm
      }

      try {
        unlisten = await listen<AirPlaySession>("airplay://status", (event) => {
          if (!mounted || cancelledRef.current) return;
          const next = event.payload;
          if (next.state === "stopped") {
            setSession(null);
            setError(null);
            return;
          }
          setSession(next);
          if (next.state === "error") {
            setError(next.errorMessage ?? "AirPlay session error");
          } else {
            setError(null);
          }
        });
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

  return { available, session, error, start, stop };
}
