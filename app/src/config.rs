//! Persistent settings + wallet in %APPDATA%\co-fisher (same folder and field names as the
//! earlier Electron version, so existing counts carry over).

use std::collections::BTreeMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::{Path, PathBuf};

use cofisher_server::{clean_skin, CHARACTERS, DEFAULT_PORT, NAME_MAX};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Items owned, in `ITEM_IDS` order.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Inv {
    pub tomato: u64,
    pub ink: u64,
    pub poop: u64,
    pub rain: u64,
    pub firework: u64,
    pub umbrella: u64,
}

impl Inv {
    pub fn get(&self, i: usize) -> u64 {
        [self.tomato, self.ink, self.poop, self.rain, self.firework, self.umbrella][i]
    }
    pub fn get_mut(&mut self, i: usize) -> &mut u64 {
        match i {
            0 => &mut self.tomato,
            1 => &mut self.ink,
            2 => &mut self.poop,
            3 => &mut self.rain,
            4 => &mut self.firework,
            _ => &mut self.umbrella,
        }
    }
    pub fn to_json(&self) -> Value {
        json!({
            "tomato": self.tomato, "ink": self.ink, "poop": self.poop,
            "rain": self.rain, "firework": self.firework, "umbrella": self.umbrella,
        })
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
    /// Unopened chests from beaten bosses; the lucky ones (last hit) have better odds.
    pub boss_chests: u64,
    pub lucky_chests: u64,
    /// 免打扰: hits show on the pet only, never full screen.
    pub dnd: bool,
    /// Key presses + mouse clicks per local day ("2026-11-04" -> count), for the calendar.
    pub daily: BTreeMap<String, u64>,
    /// Bosses I landed the last hit on, per local day (days without any are left out).
    pub daily_last_hits: BTreeMap<String, u64>,
    pub game_epoch: String,
    pub game_offset: i64,
    pub game_offsets: BTreeMap<String,i64>,
    pub game_ticket: Option<GameTicket>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all="camelCase")]
pub struct GameTicket {
    pub ticket: String,
    pub kind: String,
    pub epoch: String,
    pub applied: i64,
    #[serde(default)]
    pub table_id: Option<String>,
    #[serde(default)]
    pub create: bool,
}

impl Config {
    pub fn reserve_game(&mut self,kind:&str)->Result<String,&'static str> {
        if self.game_ticket.is_some() {return Err("已有报名或牌局尚未结算，请先恢复连接");}
        if self.count<500 {return Err("报名需要 500 点");}
        let ticket=random_hex(16);
        self.count-=500;self.game_offset-=500;
        self.game_ticket=Some(GameTicket{ticket:ticket.clone(),kind:kind.into(),epoch:self.game_epoch.clone(),applied:-500,table_id:None,create:false});
        Ok(ticket)
    }
    pub fn game_receipt(&mut self,receipt:&Value)->bool {
        let Some(ticket)=self.game_ticket.as_mut() else{return false};
        if receipt["ticket"].as_str()!=Some(&ticket.ticket) {return false;}
        let Some(net)=receipt["net"].as_i64().filter(|n|(-500..=5900).contains(n)) else{return false};
        let final_=receipt["final"].as_bool()==Some(true);
        if !final_ && net != -500 {return false;}
        if !final_ && net==ticket.applied {return false;}
        let delta=net-ticket.applied;
        self.count=(self.count as i128+delta as i128).clamp(0,u64::MAX as i128) as u64;
        self.game_offset+=delta;ticket.applied=net;
        if final_ {self.game_ticket=None;}
        true
    }
    /// A fresh server/room cancels its previous unfinished table. The local
    /// escrow is returned once; already-final settlements are never rolled back.
    pub fn game_new_epoch(&mut self,epoch:&str)->bool {
        if self.game_epoch==epoch{return false;}
        if let Some(t)=self.game_ticket.take() {
            self.count=(self.count as i128-t.applied as i128).clamp(0,u64::MAX as i128) as u64;
            self.game_offset-=t.applied;
        }
        if !self.game_epoch.is_empty(){self.game_offsets.insert(self.game_epoch.clone(),self.game_offset);}
        self.game_epoch=epoch.into();self.game_offset=self.game_offsets.get(epoch).copied().unwrap_or(0);true
    }
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
                        let backup = path.with_file_name(format!("config.bad-{}.json", crate::input::now_ms()));
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
    use super::*;
    #[test]
    fn game_ticket_settlement_is_exactly_once_and_survives_reload() {
        let mut c=Config {count:2000,game_epoch:"room-a".into(),..Config::default()};
        let ticket=c.reserve_game("ddz").unwrap();assert_eq!(c.count,1500);
        assert!(c.reserve_game("ddz").is_err());
        let serialized=serde_json::to_string(&c).unwrap();let mut c:Config=serde_json::from_str(&serialized).unwrap();
        let paid=json!({"ticket":ticket,"net":-500,"final":false});c.game_receipt(&paid);c.game_receipt(&paid);assert_eq!(c.count,1500);
        let won=json!({"ticket":ticket,"net":100,"final":true});c.game_receipt(&won);c.game_receipt(&won);assert_eq!(c.count,2100);assert_eq!(c.game_offset,100);
        c.game_new_epoch("room-b");assert_eq!(c.count,2100);
    }
    #[test]
    fn fresh_room_refunds_unfinished_entry_once() {
        let mut c=Config{count:1000,game_epoch:"old".into(),..Config::default()};c.reserve_game("blackjack").unwrap();
        c.game_new_epoch("new");c.game_new_epoch("new");assert_eq!(c.count,1000);assert_eq!(c.game_offset,0);assert!(c.game_ticket.is_none());
    }
    #[test]
    fn returning_to_another_room_keeps_its_wallet_offset() {
        let mut c=Config{count:2000,game_epoch:"a".into(),..Config::default()};let ticket=c.reserve_game("ddz").unwrap();
        c.game_receipt(&json!({"ticket":ticket,"net":100,"final":true}));c.game_new_epoch("b");
        assert_eq!(c.game_offset,0);c.game_new_epoch("a");assert_eq!(c.game_offset,100);assert_eq!(c.count,2100);
    }
    #[test]
    fn inventory_follows_item_ids() {
        let ids: Vec<String> = super::Inv::default().to_json().as_object().unwrap().keys().cloned().collect();
        assert_eq!(ids, cofisher_server::ITEM_IDS);
        for (i, id) in cofisher_server::ITEM_IDS.iter().enumerate() {
            let mut inv = super::Inv::default();
            *inv.get_mut(i) = 7;
            assert_eq!((inv.get(i), &inv.to_json()[id]), (7, &serde_json::json!(7)), "{id}");
        }
    }

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
