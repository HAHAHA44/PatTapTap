use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::mpsc;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_EXTENDED,
    MSG, SetWindowsHookExW, TranslateMessage, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Keys currently held, used to drop OS auto-repeat key-downs.
static DOWN: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let kb = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let msg = wparam as u32;
        let mut down = DOWN.lock().unwrap();
        let set = down.get_or_insert_with(HashSet::new);
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            if set.insert(kb.vkCode) {
                drop(down);
                if let Some(c) = vk_to_code(kb.vkCode, kb.flags & LLKHF_EXTENDED != 0) {
                    super::on_key_down(c);
                }
            }
        } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
            set.remove(&kb.vkCode);
        }
    }
    // Always pass the key on: we only observe.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

pub fn spawn() -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("patpattap-keys".into())
        .spawn(move || unsafe {
            let hmod = GetModuleHandleW(std::ptr::null());
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod, 0);
            if hook.is_null() {
                let _ = tx.send(Err("SetWindowsHookExW failed".into()));
                return;
            }
            let _ = tx.send(Ok(()));
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Windows virtual-key codes -> DOM `KeyboardEvent.code`.
fn vk_to_code(vk: u32, extended: bool) -> Option<&'static str> {
    const LETTERS: [&str; 26] = [
        "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK",
        "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV",
        "KeyW", "KeyX", "KeyY", "KeyZ",
    ];
    const DIGITS: [&str; 10] = [
        "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
        "Digit9",
    ];
    const NUMPAD: [&str; 10] = [
        "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7",
        "Numpad8", "Numpad9",
    ];
    const FKEYS: [&str; 12] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ];
    Some(match vk {
        0x41..=0x5A => LETTERS[(vk - 0x41) as usize],
        0x30..=0x39 => DIGITS[(vk - 0x30) as usize],
        0x60..=0x69 => NUMPAD[(vk - 0x60) as usize],
        0x70..=0x7B => FKEYS[(vk - 0x70) as usize],
        0x20 => "Space",
        0x0D => if extended { "NumpadEnter" } else { "Enter" },
        0x09 => "Tab",
        0x08 => "Backspace",
        0x1B => "Escape",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x6A => "NumpadMultiply",
        0x6B => "NumpadAdd",
        0x6D => "NumpadSubtract",
        0x6E => "NumpadDecimal",
        0x6F => "NumpadDivide",
        0xBA => "Semicolon",
        0xBB => "Equal",
        0xBC => "Comma",
        0xBD => "Minus",
        0xBE => "Period",
        0xBF => "Slash",
        0xC0 => "Backquote",
        0xDB => "BracketLeft",
        0xDC => "Backslash",
        0xDD => "BracketRight",
        0xDE => "Quote",
        _ => return None,
    })
}
