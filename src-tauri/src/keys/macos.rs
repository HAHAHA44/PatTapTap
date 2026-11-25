use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    EventField,
};
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::mpsc;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
}

static TAP_PORT: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

pub fn has_permission() -> bool {
    unsafe { CGPreflightListenEventAccess() }
}

pub fn request_permission() -> bool {
    unsafe { CGRequestListenEventAccess() }
}

pub fn spawn() -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("patpattap-keys".into())
        .spawn(move || {
            let tap = CGEventTap::new(
                CGEventTapLocation::HID,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::KeyDown],
                |_proxy, ty, event| {
                    match ty {
                        CGEventType::KeyDown => {
                            let repeat = event
                                .get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT);
                            if repeat == 0 {
                                let kc = event
                                    .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                                if let Some(code) = keycode_to_code(kc) {
                                    super::on_key_down(code);
                                }
                            }
                        }
                        // The system disables taps that are too slow; turn it back on.
                        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                            let port = TAP_PORT.load(Ordering::SeqCst);
                            if !port.is_null() {
                                unsafe { CGEventTapEnable(port as CFMachPortRef, true) };
                            }
                        }
                        _ => {}
                    }
                    None
                },
            );
            let tap = match tap {
                Ok(t) => t,
                Err(()) => {
                    let _ = tx.send(Err("CGEventTapCreate failed".into()));
                    return;
                }
            };
            let source = match tap.mach_port.create_runloop_source(0) {
                Ok(s) => s,
                Err(()) => {
                    let _ = tx.send(Err("create_runloop_source failed".into()));
                    return;
                }
            };
            TAP_PORT.store(
                tap.mach_port.as_concrete_TypeRef() as *mut _,
                Ordering::SeqCst,
            );
            let run_loop = CFRunLoop::get_current();
            unsafe { run_loop.add_source(&source, kCFRunLoopCommonModes) };
            tap.enable();
            let _ = tx.send(Ok(()));
            CFRunLoop::run_current();
            drop(tap);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// macOS virtual keycodes (ANSI layout positions) -> DOM `KeyboardEvent.code`.
fn keycode_to_code(kc: i64) -> Option<&'static str> {
    Some(match kc {
        0 => "KeyA", 1 => "KeyS", 2 => "KeyD", 3 => "KeyF", 4 => "KeyH", 5 => "KeyG",
        6 => "KeyZ", 7 => "KeyX", 8 => "KeyC", 9 => "KeyV", 11 => "KeyB", 12 => "KeyQ",
        13 => "KeyW", 14 => "KeyE", 15 => "KeyR", 16 => "KeyY", 17 => "KeyT",
        18 => "Digit1", 19 => "Digit2", 20 => "Digit3", 21 => "Digit4", 22 => "Digit6",
        23 => "Digit5", 24 => "Equal", 25 => "Digit9", 26 => "Digit7", 27 => "Minus",
        28 => "Digit8", 29 => "Digit0", 30 => "BracketRight", 31 => "KeyO", 32 => "KeyU",
        33 => "BracketLeft", 34 => "KeyI", 35 => "KeyP", 36 => "Enter", 37 => "KeyL",
        38 => "KeyJ", 39 => "Quote", 40 => "KeyK", 41 => "Semicolon", 42 => "Backslash",
        43 => "Comma", 44 => "Slash", 45 => "KeyN", 46 => "KeyM", 47 => "Period",
        48 => "Tab", 49 => "Space", 50 => "Backquote", 51 => "Backspace", 53 => "Escape",
        65 => "NumpadDecimal", 67 => "NumpadMultiply", 69 => "NumpadAdd",
        75 => "NumpadDivide", 76 => "NumpadEnter", 78 => "NumpadSubtract",
        82 => "Numpad0", 83 => "Numpad1", 84 => "Numpad2", 85 => "Numpad3", 86 => "Numpad4",
        87 => "Numpad5", 88 => "Numpad6", 89 => "Numpad7", 91 => "Numpad8", 92 => "Numpad9",
        96 => "F5", 97 => "F6", 98 => "F7", 99 => "F3", 100 => "F8", 101 => "F9",
        103 => "F11", 109 => "F10", 111 => "F12", 118 => "F4", 120 => "F2", 122 => "F1",
        123 => "ArrowLeft", 124 => "ArrowRight", 125 => "ArrowDown", 126 => "ArrowUp",
        _ => return None,
    })
}
