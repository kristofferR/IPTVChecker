import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Initialize MCP plugin listeners for AI agent debugging (dev builds only)
if (import.meta.env.DEV) {
  import("tauri-plugin-mcp").then(({ setupPluginListeners }) =>
    setupPluginListeners(),
  );
}

const platformHint = navigator.platform.toUpperCase().includes("MAC")
  ? "macos"
  : navigator.platform.toUpperCase().includes("WIN")
    ? "windows"
    : "linux";
document.documentElement.dataset.platform = platformHint;
document.documentElement.dataset.theme = "system";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
