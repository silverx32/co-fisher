//! Global key-press counter using a low-level keyboard hook.
//! Only the number of presses is kept — never which key was pressed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, HC_ACTION, KBDLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

static PRESSES: AtomicU64 = AtomicU64::new(0);
static LAST_KEY_MS: AtomicU64 = AtomicU64::new(0);
// Keys currently held, so auto-repeat while holding a key isn't counted.
static DOWN: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: for WH_KEYBOARD_LL with HC_ACTION, lparam points to a KBDLLHOOKSTRUCT.
        let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let vk = (kb.vkCode & 0xff) as usize;
        match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                LAST_KEY_MS.store(now_ms(), Relaxed);
                if !DOWN[vk].swap(true, Relaxed) {
                    PRESSES.fetch_add(1, Relaxed);
                }
            }
            WM_KEYUP | WM_SYSKEYUP => DOWN[vk].store(false, Relaxed),
            _ => {}
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Installs the hook on a dedicated thread with its own message loop.
pub fn start() -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("keyboard-hook".into())
        .spawn(move || unsafe {
            let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0) {
                Ok(_) => {
                    let _ = tx.send(Ok(()));
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv().unwrap_or_else(|_| Err("keyboard hook thread exited".into()))
}

/// New presses since the last call.
pub fn take_presses() -> u64 {
    PRESSES.swap(0, Relaxed)
}

pub fn last_key_ms() -> u64 {
    LAST_KEY_MS.load(Relaxed)
}

/// Recover from missed key-ups (e.g. a key held while the screen locked).
pub fn clear_held() {
    for d in &DOWN {
        d.store(false, Relaxed);
    }
}
