import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import Widget from "./widget/Widget";
import SettingsApp from "./settings/SettingsApp";

// One bundle, two windows: pick the view by window label.
const label = getCurrentWindow().label;
const logToTerminal = (level: string, msg: string) => invoke("log_js", { level, msg }).catch(() => {});
window.addEventListener("error", (e) => logToTerminal("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logToTerminal("reject", String(e.reason?.stack ?? e.reason)));
if (import.meta.env.DEV) (window as unknown as { bcLog: typeof logToTerminal }).bcLog = logToTerminal;
document.documentElement.classList.add(label === "widget" ? "w-widget" : "w-settings");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // No StrictMode: its double-mounted effects would register native listeners twice.
  label === "widget" ? <Widget /> : <SettingsApp />,
);
