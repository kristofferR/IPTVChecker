import { useEffect } from "react";
import { LogWindowContent } from "./components/LogWindowContent";
import { useSettings } from "./hooks/useSettings";

export function LogWindow() {
  const { settings } = useSettings();

  useEffect(() => {
    document.documentElement.classList.add("no-transitions");
    document.documentElement.dataset.theme = settings.theme;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.window = "log";
  }, []);

  return <LogWindowContent />;
}
