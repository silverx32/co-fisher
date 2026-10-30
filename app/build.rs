use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    copy_steam_dll();
}

/// Copies `steam_api64.dll` (and a default `steam_appid.txt` = 480) next to `CoFisher.exe`
/// so the binary can be launched directly from `target/{debug,release}` as well as `cargo run`.
fn copy_steam_dll() {
    let Ok(out) = env::var("OUT_DIR").map(PathBuf::from) else { return };
    let Some(build_dir) = out.parent().and_then(|p| p.parent()) else { return };
    let Some(profile_dir) = build_dir.parent() else { return };
    let Ok(entries) = fs::read_dir(build_dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with("steamworks-sys-") {
            let dll = entry.path().join("out").join("steam_api64.dll");
            if dll.is_file() {
                let _ = fs::copy(&dll, profile_dir.join("steam_api64.dll"));
                let appid = profile_dir.join("steam_appid.txt");
                if !appid.exists() {
                    let _ = fs::write(appid, "480\n");
                }
                break;
            }
        }
    }
}
