//! Self-update from GitHub Releases: the latest release's `CoFisher.exe` asset replaces the
//! running exe (Windows lets a running exe be renamed, not overwritten), then the app restarts.
//! HTTP goes through WinHTTP, which ships with Windows and honours the system proxy.

use std::ffi::c_void;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpReadData,
    WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetTimeouts, INTERNET_DEFAULT_HTTPS_PORT,
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
    WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};

pub const REPO: &str = "silverx32/co-fisher";
const ASSET: &str = "CoFisher.exe";
pub const CURRENT: &str = env!("CARGO_PKG_VERSION");
const API_MAX: usize = 1024 * 1024;
const EXE_MAX: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct Release {
    pub version: String,
    pub notes: String,
    pub page: String,
    url: String,
    size: u64,
    sha256: Option<String>,
}

struct Handle(*mut c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

fn check_handle(h: *mut c_void) -> Result<Handle, String> {
    if h.is_null() {
        Err(format!("网络错误：{}", windows::core::Error::from_thread()))
    } else {
        Ok(Handle(h))
    }
}

/// Blocking HTTPS GET (follows redirects). `progress(done, total)` is called as data arrives.
fn get(url: &str, accept: &str, max: usize, mut progress: impl FnMut(u64, Option<u64>)) -> Result<Vec<u8>, String> {
    let rest = url.strip_prefix("https://").ok_or("只支持 https 地址")?;
    let (host, path) = match rest.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (rest, "/".to_string()),
    };
    let net_err = |e: windows::core::Error| format!("网络错误：{}", e.message());
    unsafe {
        let agent = HSTRING::from(format!("CoFisher/{CURRENT}"));
        // AUTOMATIC_PROXY (system / PAC proxy) needs Windows 8.1+.
        let mut session = WinHttpOpen(&agent, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0);
        if session.is_null() {
            session = WinHttpOpen(&agent, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, PCWSTR::null(), PCWSTR::null(), 0);
        }
        let session = check_handle(session)?;
        WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, 30_000).map_err(net_err)?;
        let conn = check_handle(WinHttpConnect(session.0, &HSTRING::from(host), INTERNET_DEFAULT_HTTPS_PORT, 0))?;
        let req = check_handle(WinHttpOpenRequest(
            conn.0,
            w!("GET"),
            &HSTRING::from(path),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ))?;
        let headers: Vec<u16> = format!("Accept: {accept}\r\n").encode_utf16().collect();
        WinHttpSendRequest(req.0, Some(&headers), None, 0, 0, 0).map_err(net_err)?;
        WinHttpReceiveResponse(req.0, std::ptr::null_mut()).map_err(net_err)?;

        let query_num = |what: u32| -> Option<u64> {
            let mut n: u32 = 0;
            let mut len = size_of::<u32>() as u32;
            let buf = Some(&mut n as *mut u32 as *mut c_void);
            WinHttpQueryHeaders(req.0, what | WINHTTP_QUERY_FLAG_NUMBER, PCWSTR::null(), buf, &mut len, std::ptr::null_mut()).ok().map(|_| n as u64)
        };
        let status = query_num(WINHTTP_QUERY_STATUS_CODE).unwrap_or(0);
        if status != 200 {
            return Err(match status {
                404 => "还没有发布任何版本".into(),
                403 | 429 => "GitHub 访问太频繁，过一会儿再试".into(),
                _ => format!("服务器返回 {status}"),
            });
        }
        let total = query_num(WINHTTP_QUERY_CONTENT_LENGTH);
        if total.is_some_and(|t| t > max as u64) {
            return Err("文件太大".into());
        }
        let mut out = Vec::with_capacity(total.unwrap_or(0) as usize);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            WinHttpReadData(req.0, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut read).map_err(net_err)?;
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
            if out.len() > max {
                return Err("文件太大".into());
            }
            progress(out.len() as u64, total);
        }
        Ok(out)
    }
}

fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next().unwrap_or(Some(0))?, it.next().unwrap_or(Some(0))?))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// The latest release if it's newer than this build and has an exe attached.
pub fn check() -> Result<Option<Release>, String> {
    let body = get(&format!("https://api.github.com/repos/{REPO}/releases/latest"), "application/vnd.github+json", API_MAX, |_, _| {})?;
    let v: Value = serde_json::from_slice(&body).map_err(|_| "版本信息格式不对".to_string())?;
    let tag = v["tag_name"].as_str().unwrap_or("");
    if !is_newer(tag, CURRENT) {
        return Ok(None);
    }
    let asset = v["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str() == Some(ASSET)));
    let Some(asset) = asset else { return Ok(None) }; // release without an exe (e.g. still uploading)
    let url = asset["browser_download_url"].as_str().filter(|u| u.starts_with("https://")).ok_or("下载地址不对")?;
    Ok(Some(Release {
        version: tag.trim_start_matches(['v', 'V']).chars().take(32).collect(),
        notes: v["body"].as_str().unwrap_or("").chars().take(2000).collect(),
        page: v["html_url"].as_str().unwrap_or("").chars().take(300).collect(),
        url: url.to_string(),
        size: asset["size"].as_u64().unwrap_or(0),
        // GitHub reports "sha256:<hex>" for assets uploaded since mid-2025.
        sha256: asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_ascii_lowercase),
    }))
}

fn exe_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok((exe.with_extension("exe.new"), exe.with_extension("exe.old"), exe))
}

/// Downloads, verifies and swaps in the new exe; returns the path to start.
pub fn install(rel: &Release, progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Err("开发版不支持自动更新".into());
    }
    let data = get(&rel.url, "application/octet-stream", EXE_MAX, progress)?;
    if (rel.size > 0 && data.len() as u64 != rel.size) || !data.starts_with(b"MZ") {
        return Err("下载的文件不完整，请重试".into());
    }
    if let Some(want) = &rel.sha256 {
        let got: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        if &got != want {
            return Err("文件校验失败，请重试".into());
        }
    }
    let (new, old, exe) = exe_paths()?;
    let denied = |e: std::io::Error| format!("无法替换程序文件（{e}），请手动下载新版");
    fs::write(&new, &data).map_err(denied)?;
    let _ = fs::remove_file(&old);
    if let Err(e) = fs::rename(&exe, &old) {
        let _ = fs::remove_file(&new);
        return Err(denied(e));
    }
    if let Err(e) = fs::rename(&new, &exe) {
        let _ = fs::rename(&old, &exe);
        return Err(denied(e));
    }
    Ok(exe)
}

/// Removes what the last update left behind (the old exe is still running for a moment after
/// the restart, so keep trying for a while).
pub fn cleanup() {
    std::thread::spawn(|| {
        let Ok((new, old, _)) = exe_paths() else { return };
        let _ = fs::remove_file(new);
        for _ in 0..20 {
            match fs::remove_file(&old) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => std::thread::sleep(Duration::from_secs(1)),
                _ => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v2.1.0", "2.0.0"));
        assert!(is_newer("2.0.10", "2.0.9"));
        assert!(is_newer("v3", "2.9.9"));
        assert!(!is_newer("v2.0.0", "2.0.0"));
        assert!(!is_newer("v1.9.9", "2.0.0"));
        assert!(!is_newer("nightly", "2.0.0"));
        assert!(is_newer("v2.1.0-beta", "2.0.0"));
    }
}

#[cfg(test)]
mod live {
    /// Talks to GitHub: `cargo test -p co-fisher live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn checks_github() {
        let r = super::check();
        println!("check: {:?}", r.as_ref().map(|o| o.as_ref().map(|r| (&r.version, &r.url, r.size, &r.sha256))));
        let robots = super::get("https://github.com/robots.txt", "*/*", 1 << 20, |_, _| {}).unwrap();
        assert!(!robots.is_empty());
    }
}
