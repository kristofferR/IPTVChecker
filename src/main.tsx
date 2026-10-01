import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "./i18n";
import { startMainLogBridge } from "./lib/logBridge";
import { getUiLocale } from "./lib/tauri";
import "./index.css";

// Initialize MCP plugin listeners for AI agent debugging (dev builds only)
if (import.meta.env.DEV) {
  import("tauri-plugin-mcp").then(({ setupPluginListeners }) => setupPluginListeners());
}

const platformHint = navigator.platform.toUpperCase().includes("MAC")
  ? "macos"
  : navigator.platform.toUpperCase().includes("WIN")
    ? "windows"
    : "linux";
document.documentElement.dataset.platform = platformHint;
document.documentElement.dataset.theme = "system";

const windowParam = new URLSearchParams(window.location.search).get("window");
const isSettingsWindow = windowParam === "settings";
const isLogWindow = windowParam === "log";
if (!isSettingsWindow && !isLogWindow) {
  void startMainLogBridge().catch(() => {});
}
document.documentElement.dataset.window = isLogWindow
  ? "log"
  : isSettingsWindow
    ? "settings"
    : "main";

// The locale loads before the UI modules are evaluated, so strings built at
// module scope are already translated.
async function render() {
  await initI18n(
    await getUiLocale().catch(() => ({ locale: "en", preference: null, system: null })),
  );
  const { ErrorBoundary } = await import("./components/ErrorBoundary");
  const View = isLogWindow
    ? (await import("./LogWindow")).LogWindow
    : isSettingsWindow
      ? (await import("./SettingsWindow")).SettingsWindow
      : (await import("./App")).default;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <View />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void render();
