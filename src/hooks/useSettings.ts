import { useEffect } from "react";
import { useAppStore } from "../store";

export function useSettings() {
  const settings = useAppStore((s) => s.settings);
  const loading = useAppStore((s) => s.settingsLoading);
  const hydrated = useAppStore((s) => s.settingsHydrated);
  const load = useAppStore((s) => s.loadSettings);
  const save = useAppStore((s) => s.saveSettings);
  const applyExternal = useAppStore((s) => s.setSettings);

  useEffect(() => {
    if (!hydrated) {
      void load();
    }
  }, [hydrated, load]);

  return { settings, save, applyExternal, loading: loading || !hydrated };
}
