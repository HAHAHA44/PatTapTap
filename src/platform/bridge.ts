// Tauri-specific glue. Everything platform-dependent lives here so src/core stays portable.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { normalizeSettings, Settings } from "../core/settings";
import { SessionSummary } from "../core/types";

// Separate files so each has a single writer:
// settings.json + state.json are written by the widget window, history.json too;
// the settings window only requests changes via events.
const settingsStore = new LazyStore("settings.json", { defaults: {}, autoSave: false });
const historyStore = new LazyStore("history.json", { defaults: {}, autoSave: false });
const stateStore = new LazyStore("state.json", { defaults: {}, autoSave: false });

export const EV = {
  /** settings window -> widget: please apply & persist these settings */
  settingsUpdate: "settings-update",
  /** widget -> all: settings were applied */
  settingsChanged: "settings-changed",
  /** widget -> all: a practice session ended */
  sessionEnded: "session-ended",
  /** any -> widget: "toggle" | "stop" | "clickthrough" */
  cmd: "cmd",
  /** rust -> widget: a watched key was pressed (payload: KeyboardEvent.code) */
  globalKey: "global-key",
  /** widget -> all: running state changed */
  runState: "run-state",
} as const;

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings(await settingsStore.get("settings"));
}

export async function persistSettings(s: Settings) {
  await settingsStore.set("settings", s);
  await settingsStore.save();
}

/** Used by the settings window: ask the widget to apply + persist. */
export function requestSettings(s: Settings) {
  return emit(EV.settingsUpdate, s);
}

export function onSettingsChanged(fn: (s: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(EV.settingsChanged, (e) => fn(normalizeSettings(e.payload)));
}

const HISTORY_MAX = 200;
/** Keep the per-note trace only for the most recent sessions to bound file size. */
const DETAIL_MAX = 50;

export async function loadHistory(): Promise<SessionSummary[]> {
  const h = await historyStore.get<SessionSummary[]>("sessions");
  return Array.isArray(h) ? h : [];
}

export async function appendHistory(s: SessionSummary) {
  const h = await loadHistory();
  h.unshift(s);
  const kept = h.slice(0, HISTORY_MAX).map((x, i) => {
    if (i < DETAIL_MAX || !x.detail) return x;
    const { detail: _drop, ...rest } = x;
    return rest;
  });
  await historyStore.set("sessions", kept);
  await historyStore.save();
}

/** Overwrite the history (used when merging in sessions synced from other devices). */
export async function replaceHistory(list: SessionSummary[]) {
  await historyStore.set("sessions", list.slice(0, HISTORY_MAX));
  await historyStore.save();
}

export async function clearHistory() {
  await historyStore.set("sessions", []);
  await historyStore.save();
}

export async function getState<T>(key: string): Promise<T | undefined> {
  return stateStore.get<T>(key);
}

export async function setState(key: string, value: unknown) {
  await stateStore.set(key, value);
  await stateStore.save();
}

export type KeyStatus = "running" | "no-permission" | "unsupported" | "error" | "stopped";

export const native = {
  startKeyListener: () => invoke<KeyStatus>("start_key_listener"),
  keyStatus: () => invoke<KeyStatus>("key_listener_status"),
  requestKeyPermission: () => invoke<boolean>("request_key_permission"),
  setWatchedKeys: (keys: string[]) => invoke("set_watched_keys", { keys }),
  openPermissionSettings: () => invoke("open_permission_settings"),
  openSettings: () => invoke("open_settings"),
  restart: () => invoke("restart_app"),
  quit: () => invoke("quit_app"),
  setTrayLabels: (labels: Record<string, string>) => invoke("set_tray_labels", { labels }),
};

export const isMac = navigator.userAgent.includes("Mac");
