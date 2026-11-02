//! Persistent settings + wallet in %APPDATA%\co-fisher (same folder and field names as the
//! earlier Electron version, so existing counts carry over).

use std::collections::BTreeMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::{Path, PathBuf};

use cofisher_server::{clean_skin, CHARACTERS, DEFAULT_PORT, NAME_MAX};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Inv {
    pub tomato: u64,
    pub ink: u64,
    pub poop: u64,
}

impl Inv {
    pub fn get(&self, i: usize) -> u64 {
        [self.tomato, self.ink, self.poop][i]
    }
    pub fn get_mut(&mut self, i: usize) -> &mut u64 {
        match i {
            0 => &mut self.tomato,
            1 => &mut self.ink,
            _ => &mut self.poop,
        }
    }
    pub fn to_json(&self) -> Value {
        json!({ "tomato": self.tomato, "ink": self.ink, "poop": self.poop })
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    // String fields accept null (older versions wrote some as null).
    #[serde(deserialize_with = "null_as_default")]
    pub id: String,
    #[serde(deserialize_with = "null_as_default")]
    pub secret: String,
    #[serde(deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(rename = "char", deserialize_with = "null_as_default")]
    pub character: String,
    pub count: u64,
    pub total: u64,
    pub inv: Inv,
    #[serde(deserialize_with = "null_as_default")]
    pub join_address: String,
    #[serde(deserialize_with = "null_as_default")]
    pub join_room: String,
    #[serde(deserialize_with = "null_as_default")]
    pub join_password: String,
    pub host_port: u16,
    #[serde(deserialize_with = "null_as_default")]
    pub host_password: String,
    /// What to reconnect to on startup: "host", "join" or "" (stay offline).
    #[serde(deserialize_with = "null_as_default")]
    pub resume: String,
    /// Physical pixels (the Electron version stored DIPs under `petPos`, which we ignore).
    pub pet_pos_phys: Option<(i32, i32)>,
    /// Cosmetics owned: id -> copies.
    pub decos: BTreeMap<String, u64>,
    /// Worn cosmetics: slot ("head" / "pet" / "fx") -> id.
    pub worn: BTreeMap<String, String>,
    /// v2.1 wore a single cosmetic; read once and moved into `worn`.
    #[serde(deserialize_with = "null_as_default", skip_serializing)]
    pub deco: String,
    /// When the last chest was opened (Unix ms).
    pub last_chest_ms: u64,
}

fn null_as_default<'de, D: serde::Deserializer<'de>, T: Default + Deserialize<'de>>(d: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("COFISHER_DATA_DIR") {
        return PathBuf::from(dir); // for running a second copy / tests without touching real data
    }
    std::env::var_os("APPDATA").map_or_else(|| PathBuf::from("."), PathBuf::from).join("co-fisher")
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random source unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn new_id() -> String {
    let h = random_hex(16);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Set when the existing config couldn't be read: we then never overwrite it.
static SAVE_DISABLED: AtomicBool = AtomicBool::new(false);

pub fn save_disabled() -> bool {
    SAVE_DISABLED.load(Ordering::Relaxed)
}

fn read_config(path: &Path) -> Config {
    // The file may be briefly locked (antivirus, cloud sync); retry before giving up.
    let mut last_err = None;
    for _ in 0..10 {
        match fs::read_to_string(path) {
            Ok(text) => {
                return match serde_json::from_str::<Config>(&text) {
                    Ok(c) => c,
                    Err(e) => {
                        // Keep the unreadable file for recovery instead of overwriting it.
                        let backup = path.with_file_name(format!("config.bad-{}.json", crate::keyboard::now_ms()));
                        eprintln!("config unreadable ({e}); backed up to {}", backup.display());
                        let _ = fs::copy(path, backup);
                        Config::default()
                    }
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Config::default(),
            Err(e) => last_err = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("config not readable ({last_err:?}); running without saving");
    SAVE_DISABLED.store(true, Ordering::Relaxed);
    Config::default()
}

pub fn load() -> Config {
    let path = data_dir().join("config.json");
    let mut c = read_config(&path);
    if !((8..=64).contains(&c.id.len()) && c.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
        c.id = new_id();
    }
    if c.secret.len() < 16 || c.secret.len() > 128 {
        c.secret = random_hex(24);
    }
    c.name = c.name.trim().chars().filter(|ch| !ch.is_control()).take(NAME_MAX).collect();
    if c.name.is_empty() {
        let user: String = std::env::var("USERNAME").unwrap_or_default().chars().take(NAME_MAX).collect();
        c.name = if user.is_empty() { "摸鱼人".into() } else { user };
    }
    if !CHARACTERS.contains(&c.character.as_str()) {
        c.character = CHARACTERS[0].into();
    }
    // Unknown ids (e.g. from a newer version) are kept in the collection but can't be worn.
    c.decos.retain(|_, n| *n > 0);
    if let Some(d) = crate::decos::get(&std::mem::take(&mut c.deco)) {
        c.worn.entry(d.slot.clone()).or_insert_with(|| d.id.clone());
    }
    let owned = c.decos.clone();
    c.worn.retain(|slot, id| owned.contains_key(id) && crate::decos::get(id).is_some_and(|d| &d.slot == slot));
    if c.host_port < 1024 {
        c.host_port = DEFAULT_PORT;
    }
    c
}

fn write_atomic(path: &Path, data: &str) {
    let tmp = path.with_extension("json.tmp");
    let result = fs::create_dir_all(data_dir()).and_then(|_| fs::write(&tmp, data)).and_then(|_| fs::rename(&tmp, path));
    if let Err(e) = result {
        eprintln!("save {} failed: {e}", path.display());
    }
}

pub fn save(c: &Config) {
    if save_disabled() {
        return;
    }
    if let Ok(s) = serde_json::to_string_pretty(c) {
        write_atomic(&data_dir().join("config.json"), &s);
    }
}

/// Custom skins are large, so they live in their own file and are written only when changed.
pub fn load_skin() -> Option<Value> {
    let s = fs::read_to_string(data_dir().join("skin.json")).ok()?;
    clean_skin(&serde_json::from_str(&s).ok()?)
}

pub fn save_skin(skin: Option<&Value>) {
    let path = data_dir().join("skin.json");
    match skin {
        Some(s) => write_atomic(&path, &s.to_string()),
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn moves_the_single_v2_1_cosmetic_into_its_slot() {
        let dir = std::env::temp_dir().join(format!("cofisher-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = r#"{ "decos": { "witch-green": 1, "pet-fox": 2 }, "deco": "witch-green", "worn": { "pet": "pet-fox", "fx": "not-owned" } }"#;
        std::fs::write(dir.join("config.json"), cfg).unwrap();
        // The only test that touches the data dir.
        unsafe { std::env::set_var("COFISHER_DATA_DIR", &dir) };
        let c = super::load();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(c.worn.get("head").map(String::as_str), Some("witch-green"));
        assert_eq!(c.worn.get("pet").map(String::as_str), Some("pet-fox"));
        assert!(!c.worn.contains_key("fx"));
        assert!(!serde_json::to_string(&c).unwrap().contains("\"deco\""));
    }
}
