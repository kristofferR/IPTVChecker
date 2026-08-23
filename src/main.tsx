import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LogWindow } from "./LogWindow";
import { startMainLogBridge } from "./lib/logBridge";
import { SettingsWindow } from "./SettingsWindow";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isLogWindow ? <LogWindow /> : isSettingsWindow ? <SettingsWindow /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
