//! Small Win32 helpers Tauri doesn't expose.

use windows::core::w;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, GetCursorPos, SetWindowPos, ShowWindow, HWND_TOPMOST, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, WS_EX_TOOLWINDOW, WS_POPUP,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "CoFisher";

/// Cursor position in physical screen pixels.
pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}

/// A window that is never shown, to own the pet and overlay windows: Windows gives owned windows
/// no taskbar button and no Alt+Tab entry. Tauri's `skip_taskbar` isn't enough on its own: windows
/// without an owner get `WS_EX_APPWINDOW`, so the button comes back after a hide/show or a click.
/// Call on the main thread, whose message loop keeps the window alive.
pub fn hidden_owner() -> windows::core::Result<HWND> {
    unsafe { CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("CoFisher"), WS_POPUP, 0, 0, 0, 0, None, None, None, None) }
}

/// A full-screen app (game, video, slideshow) or presentation mode is on, or the screen is
/// locked: not the moment to cover the screen.
pub fn user_busy() -> bool {
    let state = unsafe { SHQueryUserNotificationState() };
    matches!(state, Ok(QUNS_NOT_PRESENT | QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE))
}

/// Shows a window topmost without taking focus away from what the user is typing in.
/// `rect` is (x, y, width, height) in physical pixels; `None` keeps the current bounds.
pub fn show_no_activate(hwnd: HWND, rect: Option<(i32, i32, i32, i32)>) {
    let mut flags: SET_WINDOW_POS_FLAGS = SWP_NOACTIVATE | SWP_SHOWWINDOW;
    if rect.is_none() {
        flags |= SWP_NOMOVE | SWP_NOSIZE;
    }
    let (x, y, w, h) = rect.unwrap_or_default();
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, flags);
    }
}

/// Counterpart of `show_no_activate` for the overlay, which is only ever shown/hidden via Win32:
/// mixing in Tauri's show/hide desyncs Tauri's own visibility flag.
pub fn hide(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

pub fn autostart_enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .is_ok()
}

pub fn set_autostart(on: bool) -> std::io::Result<()> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE)?;
    if on {
        let exe = std::env::current_exe()?;
        key.set_value(RUN_VALUE, &format!("\"{}\"", exe.display()))
    } else {
        match key.delete_value(RUN_VALUE) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            r => r,
        }
    }
}
