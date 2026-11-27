//! Small secrets (the login refresh token) in the OS credential store:
//! macOS Keychain / Windows Credential Manager. Never written to plain files.

#[allow(dead_code)] // unused where there is no credential store
const SERVICE: &str = "com.patpattap.app";

/// Only these names may be stored, so the webview can't use this as a general keychain API.
fn check_name(name: &str) -> Result<(), String> {
    match name {
        "refresh_token" => Ok(()),
        _ => Err("unknown secret".into()),
    }
}

#[cfg(any(target_os = "macos", windows))]
fn entry(name: &str) -> Result<keyring::Entry, String> {
    check_name(name)?;
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Other platforms (not shipped yet): no credential store, so no saved login.
#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    check_name(&name).map(|_| None)
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub fn secret_set(name: String, _value: String) -> Result<(), String> {
    check_name(&name)
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    check_name(&name)
}

