//! Global, listen-only keyboard monitor.
//!
//! Privacy: the OS hook sees every key, but only keys the user configured as
//! "tap keys" (the `WATCHED` set) are ever forwarded to the UI. Nothing is
//! stored or logged. The hook never blocks or alters keys, so other apps
//! keep receiving them normally.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static WATCHED: RwLock<Option<HashSet<String>>> = RwLock::new(None);
static STATUS: Mutex<&'static str> = Mutex::new("stopped");

/// Called from the platform hook thread for every non-repeat key-down.
/// `code` uses DOM `KeyboardEvent.code` names (e.g. "KeyF", "Space").
pub(crate) fn on_key_down(code: &'static str) {
    let watched = WATCHED.read().unwrap();
    let Some(set) = watched.as_ref() else { return };
    if !set.contains(code) {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit_to("widget", "global-key", code);
    }
}

pub fn set_watched(keys: Vec<String>) {
    *WATCHED.write().unwrap() = Some(keys.into_iter().collect());
}

pub fn status() -> &'static str {
    let s = *STATUS.lock().unwrap();
    if s == "stopped" && !has_permission() {
        return "no-permission";
    }
    s
}

pub fn has_permission() -> bool {
    #[cfg(target_os = "macos")]
    return macos::has_permission();
    #[cfg(not(target_os = "macos"))]
    return true;
}

pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    return macos::request_permission();
    #[cfg(not(target_os = "macos"))]
    return true;
}

/// Starts the hook thread once. Returns the resulting status string:
/// "running" | "no-permission" | "unsupported" | "error".
pub fn start(app: &AppHandle) -> &'static str {
    let _ = APP.set(app.clone());
    let mut st = STATUS.lock().unwrap();
    if *st == "running" {
        return "running";
    }
    if !has_permission() {
        return "no-permission";
    }
    #[cfg(target_os = "macos")]
    let result = macos::spawn();
    #[cfg(windows)]
    let result = windows::spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let result: Result<(), String> = Err("unsupported".into());

    *st = match result {
        Ok(()) => "running",
        Err(e) if e == "unsupported" => "unsupported",
        Err(e) => {
            eprintln!("[keys] failed to start global key listener: {e}");
            "error"
        }
    };
    *st
}
