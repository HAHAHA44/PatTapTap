mod keys;

use std::collections::HashMap;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn start_key_listener(app: AppHandle) -> &'static str {
    keys::start(&app)
}

#[tauri::command]
fn key_listener_status() -> &'static str {
    keys::status()
}

#[tauri::command]
fn request_key_permission() -> bool {
    keys::request_permission()
}

#[tauri::command]
fn set_watched_keys(keys: Vec<String>) {
    keys::set_watched(keys);
}

#[tauri::command]
fn open_permission_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .spawn();
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

/// Dev aid: frontend errors/logs show up in the terminal running `tauri dev`.
#[tauri::command]
fn log_js(window: tauri::WebviewWindow, level: String, msg: String) {
    eprintln!("[js:{}:{}] {}", window.label(), level, msg);
}

/// Tray menu items, kept so the frontend can relabel them when the language changes.
struct TrayItems(HashMap<&'static str, MenuItem<tauri::Wry>>);

#[tauri::command]
fn set_tray_labels(app: AppHandle, labels: HashMap<String, String>) {
    if let Some(items) = app.try_state::<TrayItems>() {
        for (id, item) in items.0.iter() {
            if let Some(text) = labels.get(*id) {
                let _ = item.set_text(text);
            }
        }
    }
    if let (Some(tray), Some(tip)) = (app.tray_by_id("main"), labels.get("tooltip")) {
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Settings")
        .inner_size(640.0, 700.0)
        .min_inner_size(540.0, 520.0)
        .center()
        .build();
    if let Ok(w) = built {
        let _ = w.set_focus();
    }
}

fn toggle_widget_visible(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("widget") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.emit("cmd", "stop");
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // Placeholder labels; the widget sends translated ones right after startup.
    let toggle = MenuItem::with_id(app, "toggle", "Start / Stop", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let through = MenuItem::with_id(app, "clickthrough", "Click-through", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &sep, &show, &through, &settings, &sep2, &quit])?;
    app.manage(TrayItems(HashMap::from([
        ("toggle", toggle.clone()),
        ("show", show.clone()),
        ("clickthrough", through.clone()),
        ("settings", settings.clone()),
        ("quit", quit.clone()),
    ])));

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = app.emit_to("widget", "cmd", "toggle");
            }
            "clickthrough" => {
                let _ = app.emit_to("widget", "cmd", "clickthrough");
            }
            "show" => toggle_widget_visible(app),
            "settings" => show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_store::Builder::new().build());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    builder
        .setup(|app| {
            // Widget-style app: no Dock icon on macOS, lives in the menu bar tray.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_key_listener,
            key_listener_status,
            request_key_permission,
            set_watched_keys,
            open_permission_settings,
            open_settings,
            restart_app,
            quit_app,
            set_tray_labels,
            log_js
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
