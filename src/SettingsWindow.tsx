import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { SettingsPanel } from "./components/SettingsPanel";
import { useSettings } from "./hooks/useSettings";

export function SettingsWindow() {
  const { settings, save, loading } = useSettings();

  useEffect(() => {
    document.documentElement.classList.add("no-transitions");
    document.documentElement.dataset.theme = settings.theme;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }, [settings.theme]);

  // Mark this as a settings window so CSS can apply opaque backgrounds
  useEffect(() => {
    document.documentElement.dataset.window = "settings";
  }, []);

  const handleSave = async (next: typeof settings) => {
    await save(next);
    await emit("settings-changed", next);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-overlay">
        <p className="text-text-tertiary text-[13px]">Loading settings...</p>
      </div>
    );
  }

  return <SettingsPanel settings={settings} onSave={handleSave} />;
}
