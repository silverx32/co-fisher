#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod decos;
mod input;
mod net;
mod steam;
mod update;
mod win;

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cofisher_server::{
    clean_skin, ItemKind, ServerHandle, ServerOptions, BOSSES, CHARACTERS, ITEM_COUNT, ITEM_IDS, ITEM_KINDS, MAX_PLAYERS,
    NAME_MAX, UMBRELLA,
};
use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc;

use config::Config;
use net::{Net, NetEvent};
use steam::Steam;

// Wide enough for 8 friends per row (two rows for a full room of 16) to the left of me;
// the empty part is click-through.
const PET_W: f64 = 910.0;
const PET_ME_X: f64 = PET_W - 95.0; // where my character stands, from the window's left edge
const PET_H: f64 = 720.0;
const TYPING_HOLD_MS: u64 = 700;
const TICK: Duration = Duration::from_millis(25); // short so each key press / click shows up right away
const STATUS_EVERY: Duration = Duration::from_millis(150);
const SAVE_EVERY: Duration = Duration::from_secs(2);
const CURSOR_POLL: Duration = Duration::from_millis(40);
const SPLAT_LIFETIME: Duration = Duration::from_millis(7600); // longest effect in overlay.js
const MAX_ACTIVE_SPLATS: usize = 5;
const UPDATE_FIRST_CHECK: Duration = Duration::from_secs(8);
const UPDATE_EVERY: Duration = Duration::from_secs(3600);
const UPDATE_PROGRESS_EVERY: Duration = Duration::from_millis(150);

struct Item {
    id: &'static str,
    name: &'static str,
    emoji: &'static str,
    cost: u64,
    desc: &'static str,
}

// Same order as ITEM_IDS.
const ITEMS: [Item; ITEM_COUNT] = [
    Item { id: "tomato", name: "番茄", emoji: "🍅", cost: 50, desc: "" },
    Item { id: "ink", name: "墨鱼汁", emoji: "🦑", cost: 100, desc: "" },
    Item { id: "poop", name: "屎", emoji: "💩", cost: 200, desc: "" },
    Item { id: "rain", name: "番茄雨", emoji: "🌧️", cost: 1000, desc: "糊房间里所有人" },
    Item { id: "firework", name: "烟花", emoji: "🎆", cost: 300, desc: "全房间一起看" },
    Item { id: "umbrella", name: "雨伞", emoji: "☂️", cost: 500, desc: "自动挡下一次攻击" },
];
/// A server whose welcome doesn't list its items (v2.2) knows the first three.
const OLD_SERVER_ITEMS: usize = 3;

// Display name + description, in the same order as CHARACTERS.
const CHARACTER_INFO: [(&str, &str); 6] = [
    ("Claude", "橘色长卷发，戴向日葵发饰"),
    ("Codex", "白发龙角，拖着软软的龙尾巴"),
    ("豆包", "黑色短发，红围巾"),
    ("Gemini", "紫色渐变长发，戴小礼帽"),
    ("DeepSeek", "蓝发鲸鱼女仆，有鲸鱼尾巴"),
    ("Kimi", "银发猫耳女仆"),
];

fn item_index(id: &str) -> Option<usize> {
    ITEM_IDS.iter().position(|i| *i == id)
}

struct Inner {
    config: Config,
    skin: Option<Value>,
    dirty: bool,
    last_save: Instant,
    players: Vec<Value>,
    skins: HashMap<String, Value>, // player id -> { rev, skin }
    pending_throws: HashMap<u64, usize>,
    throw_seq: u64,
    /// Items the room's server supports.
    server_items: Vec<&'static str>,
    /// The room's boss as the page shows it (null when there's none).
    boss: Value,
    game: Value,
    games_supported: bool,
    /// Umbrella blocks heard about on this connection (see `blocked` in the server).
    blocks_seen: u64,
    splat_times: VecDeque<Instant>,
    splats_sent: u64,
    overlay_shown: bool,
    hit_rects: Vec<[f64; 4]>, // interactive areas of the pet window, CSS px
    typing: bool,
    last_pushed_count: Option<u64>,
    last_status: String,
    last_status_at: Instant,
    update: Option<update::Release>,
    update_state: Value, // last "update" event, for pages that load later
    update_busy: bool,
}

struct AppState {
    inner: Mutex<Inner>,
    net: Net,
    steam: Steam,
    server: tokio::sync::Mutex<Option<ServerHandle>>,
}

type St<'a> = State<'a, Arc<AppState>>;

impl Inner {
    fn wallet(&self) -> Value {
        json!({ "count": self.config.count, "total": self.config.total, "inv": self.config.inv.to_json() })
    }
    fn touch(&mut self) {
        self.dirty = true;
    }
    /// Worn cosmetic ids, head first.
    fn worn(&self) -> Vec<String> {
        decos::SLOTS.iter().filter_map(|(slot, _)| self.config.worn.get(*slot).cloned()).collect()
    }
    fn deco_state(&self) -> Value {
        let c = &self.config;
        json!({
            "owned": c.decos,
            "worn": c.worn,
            "nextChestAt": c.last_chest_ms + decos::CHEST_COOLDOWN_MS,
            "bossChests": c.boss_chests,
            "luckyChests": c.lucky_chests,
            "stats": decos::stats(&c.decos, &self.worn()),
        })
    }
    /// Sends our status to the room on the next tick instead of waiting for the throttle.
    fn status_soon(&mut self) {
        self.last_status.clear();
        self.last_status_at = Instant::now() - STATUS_EVERY;
    }
}

fn hello_for(app: &AppHandle) -> Value {
    let st = app.state::<Arc<AppState>>();
    let i = st.inner.lock().unwrap();
    let c = &i.config;
    let mut msg=net::hello_payload(&c.id, &c.secret, &c.name, &c.character, &i.worn(), i.skin.as_ref(), c.count, c.inv.to_json());
    msg["gameEpoch"]=c.game_epoch.clone().into();msg["gameOffset"]=c.game_offset.into();
    msg["gameReserve"]=c.game_ticket.as_ref().map_or(0,|t|(-t.applied).max(0) as u64).into();
    msg
}

fn profile_msg(i: &Inner, with_skin: bool) -> Value {
    let worn = i.worn();
    let mut m = json!({ "t": "profile", "name": i.config.name, "char": i.config.character, "deco": worn.first(), "decos": worn });
    if with_skin {
        m["skin"] = i.skin.clone().unwrap_or(Value::Null);
    }
    m
}

// ---------------------------------------------------------------- addresses

fn local_addresses() -> (Vec<String>, Vec<String>) {
    let mut v4 = Vec::new();
    let mut v6 = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if iface.is_loopback() {
            continue;
        }
        match iface.ip() {
            IpAddr::V4(a) if !a.is_link_local() => v4.push(a.to_string()),
            // Global unicast (2000::/3) only: link-local / unique-local can't be reached from outside.
            IpAddr::V6(a) if a.segments()[0] & 0xe000 == 0x2000 => v6.push(a.to_string()),
            _ => {}
        }
    }
    v4.dedup();
    v6.dedup();
    (v4, v6)
}

async fn server_status(state: &AppState) -> Value {
    let (ips, ipv6) = local_addresses();
    let steam = state.steam.status(false);
    match &*state.server.lock().await {
        Some(s) => json!({ "running": true, "port": s.port, "ips": ips, "ipv6": ipv6, "steam": steam }),
        None => json!({ "running": false, "ips": ips, "ipv6": ipv6, "steam": steam }),
    }
}

async fn stop_server(state: &AppState) {
    state.steam.stop().await;
    if let Some(s) = state.server.lock().await.take() {
        s.stop().await;
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
async fn init(state: St<'_>) -> Result<Value, ()> {
    let server = server_status(&state).await;
    let i = state.inner.lock().unwrap();
    let items: serde_json::Map<String, Value> = ITEMS
        .iter()
        .zip(ITEM_KINDS)
        .map(|(it, kind)| {
            let v = json!({ "id": it.id, "name": it.name, "emoji": it.emoji, "cost": it.cost, "kind": kind.as_str(), "desc": it.desc });
            (it.id.to_string(), v)
        })
        .collect();
    let characters: Vec<Value> = CHARACTERS
        .iter()
        .zip(CHARACTER_INFO)
        .map(|(id, (name, desc))| json!({ "id": id, "name": name, "desc": desc }))
        .collect();
    Ok(json!({
        "me": { "id": i.config.id, "name": i.config.name, "char": i.config.character, "skin": i.skin },
        "wallet": i.wallet(),
        "daily": i.config.daily,
        "dailyLastHits": i.config.daily_last_hits,
        "items": items,
        "serverItems": i.server_items,
        "dnd": i.config.dnd,
        "characters": characters,
        "maxPlayers": MAX_PLAYERS,
        "joinAddress": i.config.join_address,
        "joinRoom": i.config.join_room,
        "joinPassword": i.config.join_password,
        "hostPort": i.config.host_port,
        "hostPassword": i.config.host_password,
        "net": { "state": state.net.state() },
        "server": server,
        "steam": state.steam.status(false),
        "players": i.players,
        "boss": i.boss,
        "game": i.game,
        "gamesSupported": i.games_supported,
        "skins": i.skins,
        "decos": decos::catalogue(),
        "decoState": i.deco_state(),
        "version": update::CURRENT,
        "update": i.update_state,
        "justUpdated": std::env::args().any(|a| a == UPDATED_ARG),
    }))
}

#[tauri::command]
fn set_profile(state: St<'_>, name: Option<String>, character: Option<String>) -> Value {
    let mut i = state.inner.lock().unwrap();
    if let Some(n) = name {
        let n: String = n.trim().chars().filter(|c| !c.is_control()).take(NAME_MAX).collect();
        if !n.is_empty() {
            i.config.name = n;
        }
    }
    if let Some(c) = character.filter(|c| CHARACTERS.contains(&c.as_str())) {
        i.config.character = c;
    }
    i.touch();
    state.steam.update_lobby_meta(Some(&i.config.name), None);
    state.net.send(&profile_msg(&i, false));
    json!({ "name": i.config.name, "char": i.config.character })
}

#[tauri::command]
fn set_skin(state: St<'_>, idle: String, typing: String) -> Value {
    let Some(skin) = clean_skin(&json!({ "idle": idle, "typing": typing })) else {
        return json!({ "ok": false, "error": "图片格式不支持或太大（单张 < 300KB，png/gif/jpg/webp）" });
    };
    let mut i = state.inner.lock().unwrap();
    config::save_skin(Some(&skin));
    i.skin = Some(skin.clone());
    state.net.send(&profile_msg(&i, true));
    json!({ "ok": true, "skin": skin })
}

#[tauri::command]
fn clear_skin(state: St<'_>) -> Value {
    let mut i = state.inner.lock().unwrap();
    config::save_skin(None);
    i.skin = None;
    state.net.send(&profile_msg(&i, true));
    json!({ "ok": true })
}

async fn do_host(app: &AppHandle, state: &AppState, port: u16, password: String) -> Result<(), String> {
    stop_server(state).await;
    let handle = match cofisher_server::start(ServerOptions::host_mode(port, password.clone())).await {
        Ok(h) => h,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return Err(format!("端口 {port} 被占用，换一个试试")),
        Err(e) => return Err(e.to_string()),
    };
    *state.server.lock().await = Some(handle);
    let host_name = {
        let mut i = state.inner.lock().unwrap();
        i.config.host_port = port;
        i.config.host_password = password.clone();
        i.config.resume = "host".into();
        i.touch();
        i.config.name.clone()
    };
    state.steam.start_host(port, &host_name, !password.is_empty()).await;
    let a = app.clone();
    let url = format!("ws://127.0.0.1:{port}/");
    state.net.connect(url.clone(), url, password, String::new(), Arc::new(move || hello_for(&a)));
    Ok(())
}

async fn do_join(app: &AppHandle, state: &AppState, address: String, password: String, room: String) -> Result<(), String> {
    {
        let i=state.inner.lock().unwrap();
        if i.config.game_ticket.is_some() && (i.config.resume!="join" || i.config.join_address!=address.trim() || i.config.join_room!=room.trim()) {
            return Err("请先退出牌局并完成结算，再切换房间".into());
        }
    }
    if let Some(target) = steam::parse_target(&address) {
        stop_server(state).await;
        let (local_port, steam_addr) = state.steam.start_join(target).await?;
        {
            let mut i = state.inner.lock().unwrap();
            i.config.join_address = steam_addr.clone();
            i.config.join_room.clear();
            i.config.join_password = password.clone();
            i.config.resume = "join".into();
            i.touch();
        }
        let a = app.clone();
        state.net.connect(format!("ws://127.0.0.1:{local_port}/"), steam_addr, password, String::new(), Arc::new(move || hello_for(&a)));
        return Ok(());
    }
    let url = net::to_url(&address).map_err(|_| "地址格式不对，例如 steam:ID、192.168.1.10:23333 或 [2408::1]:23333".to_string())?;
    stop_server(state).await;
    let room: String = room.trim().chars().take(32).collect();
    {
        let mut i = state.inner.lock().unwrap();
        i.config.join_address = address.trim().to_string();
        i.config.join_room = room.clone();
        i.config.join_password = password.clone();
        i.config.resume = "join".into();
        i.touch();
    }
    let a = app.clone();
    state.net.connect(url.clone(), url, password, room, Arc::new(move || hello_for(&a)));
    Ok(())
}

/// Reconnects to whatever we were in last time (after a reboot, the app starting with Windows, …).
async fn resume_last_session(app: AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    if steam::connect_arg(&args).is_some() {
        return; // launched from a Steam invite; invite_rx handles it
    }
    let state = app.state::<Arc<AppState>>();
    let c = state.inner.lock().unwrap().config.clone();
    let result = match c.resume.as_str() {
        "host" => do_host(&app, &state, c.host_port, c.host_password).await,
        "join" => do_join(&app, &state, c.join_address, c.join_password, c.join_room).await,
        _ => Ok(()),
    };
    if let Err(e) = result {
        let _ = app.emit("toast", format!("自动重连失败：{e}"));
    }
}

#[tauri::command]
async fn host(app: AppHandle, state: St<'_>, port: f64, password: String) -> Result<Value, ()> {
    if state.inner.lock().unwrap().config.game_ticket.is_some(){return Ok(json!({"ok":false,"error":"请先退出牌局并完成结算，再切换房间"}));}
    if !(port.is_finite() && (1024.0..=65535.0).contains(&port)) {
        return Ok(json!({ "ok": false, "error": "端口范围 1024-65535" }));
    }
    Ok(match do_host(&app, &state, port as u16, password).await {
        Ok(()) => json!({ "ok": true, "server": server_status(&state).await }),
        Err(e) => json!({ "ok": false, "error": e }),
    })
}

#[tauri::command]
async fn join(app: AppHandle, state: St<'_>, address: String, password: String, room: String) -> Result<Value, ()> {
    if state.inner.lock().unwrap().config.game_ticket.is_some(){return Ok(json!({"ok":false,"error":"请先退出牌局并完成结算，再切换房间"}));}
    Ok(match do_join(&app, &state, address, password, room).await {
        Ok(()) => {
            let join_addr = state.inner.lock().unwrap().config.join_address.clone();
            json!({ "ok": true, "joinAddress": join_addr, "server": server_status(&state).await })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    })
}

#[tauri::command]
fn steam_status(state: St<'_>, retry: Option<bool>) -> Value {
    state.steam.status(retry.unwrap_or(false))
}

#[tauri::command]
async fn steam_rooms(state: St<'_>) -> Result<Value, ()> {
    let steam = state.steam.status(true);
    let rooms = state.steam.list_rooms().await;
    Ok(json!({ "steam": steam, "rooms": rooms }))
}

#[tauri::command]
fn steam_invite(state: St<'_>) -> Value {
    json!({ "ok": state.steam.invite_overlay() })
}

#[tauri::command]
async fn leave(app: AppHandle, state: St<'_>) -> Result<Value, ()> {
    if state.inner.lock().unwrap().config.game_ticket.is_some(){return Ok(json!({"ok":false,"error":"请先在小游戏中退出牌局，等待门票或奖金结算"}));}
    state.net.disconnect();
    stop_server(&state).await;
    {
        let mut i = state.inner.lock().unwrap();
        i.players.clear();
        i.skins.clear();
        i.boss = Value::Null;
        i.config.resume.clear();
        i.touch();
    }
    let _ = app.emit("players", Vec::<Value>::new());
    let _ = app.emit("boss", Value::Null);
    Ok(json!({ "ok": true, "server": server_status(&state).await }))
}

#[tauri::command]
fn game_command(app:AppHandle,state:St<'_>,mut action:Value)->Value {
    if !action.is_object(){return json!({"ok":false,"error":"无效操作"});}
    let op=action["op"].as_str().unwrap_or("").to_string();
    if !["join","start","leave","hit","stand","fold","check","call","raise","allin","bid","pass","play","sync"].contains(&op.as_str()) {
        return json!({"ok":false,"error":"未知操作"});
    }
    let mut i=state.inner.lock().unwrap();
    if state.net.state()!="online" || !i.games_supported{return json!({"ok":false,"error":"需要连接支持小游戏的新版房间"});}
    action["t"]="game".into();action["epoch"]=i.config.game_epoch.clone().into();
    if op=="join" {
        if config::save_disabled(){return json!({"ok":false,"error":"存档不可写，暂时不能报名"});}
        let kind=action["kind"].as_str().unwrap_or("").to_string();
        if !["blackjack","holdem","ddz"].contains(&kind.as_str()){return json!({"ok":false,"error":"未知游戏"});}
        let ticket=match i.config.reserve_game(&kind){Ok(t)=>t,Err(e)=>return json!({"ok":false,"error":e})};
        action["ticket"]=ticket.into();action["count"]=i.config.count.saturating_add(500).into();
        action["gameEpoch"]=i.config.game_epoch.clone().into();action["gameOffset"]=(i.config.game_offset+500).into();
        config::save(&i.config);i.status_soon();
    }
    if !state.net.send(&action) {
        if op=="join" {i.config.game_receipt(&json!({"ticket":action["ticket"],"net":0,"final":true}));config::save(&i.config);}
        return json!({"ok":false,"error":"连接已断开，请重试","wallet":i.wallet()});
    }
    let wallet=i.wallet();drop(i);let _=app.emit("wallet",&wallet);
    json!({"ok":true,"wallet":wallet})
}

#[tauri::command]
fn buy(app: AppHandle, state: St<'_>, item: String, qty: f64) -> Value {
    let Some(idx) = item_index(&item) else { return json!({ "ok": false, "error": "未知道具" }) };
    if !(qty.is_finite() && (1.0..=99.0).contains(&qty)) {
        return json!({ "ok": false, "error": "数量不对" });
    }
    let qty = qty as u64;
    let mut i = state.inner.lock().unwrap();
    let cost = ITEMS[idx].cost * qty;
    if i.config.count < cost {
        return json!({ "ok": false, "error": format!("点数不够，还差 {}", cost - i.config.count) });
    }
    i.config.count -= cost;
    *i.config.inv.get_mut(idx) += qty;
    i.touch();
    // Tell friends right away (next tick) so the new stock shows up without waiting.
    i.status_soon();
    let w = i.wallet();
    drop(i);
    let _ = app.emit("wallet", &w);
    json!({ "ok": true, "wallet": w })
}

#[tauri::command]
fn open_chest(app: AppHandle, state: St<'_>) -> Value {
    let mut i = state.inner.lock().unwrap();
    let now = input::now_ms();
    if decos::chest_cooling(i.config.last_chest_ms, now) {
        return json!({ "ok": false, "error": "宝箱还在冷却中" });
    }
    if i.config.count < decos::CHEST_COST {
        return json!({ "ok": false, "error": format!("点数不够，还差 {}", decos::CHEST_COST - i.config.count) });
    }
    i.config.count -= decos::CHEST_COST;
    i.config.last_chest_ms = now;
    let (prize, w, d) = award(&mut i, decos::roll_chest(false));
    drop(i);
    let _ = app.emit("wallet", &w);
    json!({ "ok": true, "prize": prize, "wallet": w, "decoState": d })
}

/// Opens a chest won from a boss: free, no cooldown; lucky ones (last hit) first.
#[tauri::command]
fn open_boss_chest(app: AppHandle, state: St<'_>) -> Value {
    let mut i = state.inner.lock().unwrap();
    let lucky = i.config.lucky_chests > 0;
    if lucky {
        i.config.lucky_chests -= 1;
    } else if i.config.boss_chests > 0 {
        i.config.boss_chests -= 1;
    } else {
        return json!({ "ok": false, "error": "没有 Boss 宝箱了" });
    }
    let (prize, w, d) = award(&mut i, decos::roll_chest(lucky));
    drop(i);
    let _ = app.emit("wallet", &w);
    json!({ "ok": true, "prize": prize, "lucky": lucky, "wallet": w, "decoState": d })
}

/// Puts what a chest gave into the collection or the item stock. Returns the prize, wallet and
/// collection for the page.
fn award(i: &mut Inner, prize: decos::Prize) -> (Value, Value, Value) {
    let prize = match prize {
        decos::Prize::Deco(d) => {
            let n = i.config.decos.entry(d.id.clone()).or_default();
            *n += 1;
            json!({ "kind": "deco", "id": d.id, "rarity": d.rarity, "isNew": *n == 1 })
        }
        decos::Prize::Items(rarity, items) => {
            for (id, qty) in items {
                if let Some(k) = item_index(id) {
                    *i.config.inv.get_mut(k) += qty;
                }
            }
            let items: serde_json::Map<String, Value> = items.iter().map(|(id, qty)| (id.to_string(), (*qty).into())).collect();
            json!({ "kind": "items", "rarity": rarity, "items": items })
        }
    };
    i.touch();
    i.status_soon(); // new items show up in the room
    (prize, i.wallet(), i.deco_state())
}

/// Copies picked on the page (id -> how many); `None` if a count isn't a whole number from 1 to
/// MERGE_COUNT.
fn clean_picks(picks: HashMap<String, f64>) -> Option<decos::Picks> {
    let ok = |n: f64| n.fract() == 0.0 && (1.0..=decos::MERGE_COUNT as f64).contains(&n);
    picks.into_iter().map(|(id, n)| ok(n).then_some((id, n as u64))).collect()
}

/// Merges the copies the player picked. Using up the last copy of something needs `confirm`.
#[tauri::command]
fn merge_decos(state: St<'_>, picks: HashMap<String, f64>, confirm: bool) -> Value {
    let Some(picks) = clean_picks(picks) else { return json!({ "ok": false, "error": "数量不对" }) };
    let mut i = state.inner.lock().unwrap();
    let worn = i.worn();
    let lose = match decos::check_picks(&i.config.decos, &picks, &worn) {
        Ok((_, lose)) => lose,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    if lose > 0 && !confirm {
        return json!({ "ok": false, "confirm": true, "lose": lose });
    }
    let got = decos::merge(&mut i.config.decos, &picks, &worn).expect("checked above");
    let is_new = i.config.decos.get(&got.id) == Some(&1);
    i.touch();
    json!({ "ok": true, "item": got.id, "isNew": is_new, "decoState": i.deco_state() })
}

/// 补满: tops the copies picked so far up with the ones a merge of `rarity` would use first.
#[tauri::command]
fn fill_merge(state: St<'_>, rarity: usize, picks: HashMap<String, f64>) -> Value {
    let mut picks = clean_picks(picks).unwrap_or_default();
    let i = state.inner.lock().unwrap();
    decos::fill_picks(&i.config.decos, rarity, &i.worn(), &mut picks);
    json!({ "picks": picks })
}

#[tauri::command]
/// Wears `id` in its slot, or takes off whatever is in `slot` when `id` is empty.
fn equip_deco(state: St<'_>, slot: String, id: String) -> Value {
    let mut i = state.inner.lock().unwrap();
    if id.is_empty() {
        i.config.worn.remove(&slot);
    } else {
        let Some(d) = decos::get(&id).filter(|_| i.config.decos.contains_key(&id)) else {
            return json!({ "ok": false, "error": "还没有这个装扮" });
        };
        i.config.worn.insert(d.slot.clone(), id);
    }
    i.touch();
    state.net.send(&profile_msg(&i, false));
    json!({ "ok": true, "decoState": i.deco_state() })
}

/// `target` is ignored for room-wide items (番茄雨, 烟花).
#[tauri::command]
fn throw_item(app: AppHandle, state: St<'_>, item: String, target: String) -> Value {
    let Some(idx) = item_index(&item) else { return json!({ "ok": false, "error": "未知道具" }) };
    if ITEM_KINDS[idx] == ItemKind::Shield {
        return json!({ "ok": false, "error": "雨伞不用扔，有存货就会自动挡" });
    }
    if state.net.state() != "online" {
        return json!({ "ok": false, "error": "还没联机哦" });
    }
    let mut i = state.inner.lock().unwrap();
    if !i.server_items.contains(&ITEMS[idx].id) {
        return json!({ "ok": false, "error": format!("房主或中转服务器版本较旧，用不了{}", ITEMS[idx].name) });
    }
    if i.config.inv.get(idx) < 1 {
        return json!({ "ok": false, "error": format!("没有{}了，先去兑换", ITEMS[idx].name) });
    }
    i.throw_seq += 1;
    let seq = i.throw_seq;
    // The inventory *before* this throw travels with it; the server checks and deducts from it.
    let msg = json!({ "t": "throw", "seq": seq, "item": item, "target": target, "inv": i.config.inv.to_json(), "blocks": i.blocks_seen });
    // Optimistic: deducted now, refunded if the server rejects or the connection drops.
    *i.config.inv.get_mut(idx) -= 1;
    if !state.net.send(&msg) {
        *i.config.inv.get_mut(idx) += 1;
        return json!({ "ok": false, "error": "发送失败" });
    }
    i.pending_throws.insert(seq, idx);
    i.touch();
    let w = i.wallet();
    drop(i);
    let _ = app.emit("wallet", &w);
    json!({ "ok": true, "wallet": w })
}

// ---------------------------------------------------------------- updates

const UPDATED_ARG: &str = "--updated";

fn set_update_state(app: &AppHandle, mut v: Value) {
    v["current"] = update::CURRENT.into();
    app.state::<Arc<AppState>>().inner.lock().unwrap().update_state = v.clone();
    let _ = app.emit("update", v);
}

/// `manual`: the user pressed the button, so report "up to date" and errors too.
async fn check_update(app: AppHandle, manual: bool) {
    {
        let st = app.state::<Arc<AppState>>();
        let mut i = st.inner.lock().unwrap();
        if i.update_busy {
            return;
        }
        i.update_busy = true;
    }
    if manual {
        set_update_state(&app, json!({ "state": "checking" }));
    }
    let result = tauri::async_runtime::spawn_blocking(update::check).await.unwrap_or_else(|e| Err(e.to_string()));
    let found = result.as_ref().ok().cloned().flatten();
    let known = {
        let st = app.state::<Arc<AppState>>();
        let mut i = st.inner.lock().unwrap();
        i.update_busy = false;
        let known = i.update.as_ref().map(|r| r.version.clone());
        if result.is_ok() {
            i.update = found.clone();
        }
        known
    };
    match (result, found) {
        (_, Some(rel)) => {
            set_update_state(&app, json!({ "state": "available", "version": rel.version, "notes": rel.notes, "page": rel.page }));
            // Hourly checks only announce a version once; it stays visible next to the name.
            if !manual && known.as_deref() != Some(rel.version.as_str()) {
                let _ = app.emit("toast", format!("发现新版本 v{}，点名字旁的「新版本」查看", rel.version));
            }
        }
        (Ok(_), None) if manual => set_update_state(&app, json!({ "state": "latest" })),
        (Err(e), _) if manual => set_update_state(&app, json!({ "state": "error", "text": e })),
        _ => {}
    }
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<(), ()> {
    check_update(app, true).await;
    Ok(())
}

#[tauri::command]
fn apply_update(app: AppHandle, state: St<'_>) -> Value {
    let rel = {
        let mut i = state.inner.lock().unwrap();
        if i.update_busy {
            return json!({ "ok": false, "error": "正在处理，请稍等" });
        }
        let Some(rel) = i.update.clone() else { return json!({ "ok": false, "error": "没有可用的新版本" }) };
        i.update_busy = true;
        rel
    };
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        set_update_state(&a, json!({ "state": "downloading", "version": rel.version, "done": 0, "total": null }));
        let (a2, rel2) = (a.clone(), rel.clone());
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut last = Instant::now() - UPDATE_PROGRESS_EVERY;
            update::install(&rel2, |done, total| {
                if last.elapsed() >= UPDATE_PROGRESS_EVERY {
                    last = Instant::now();
                    set_update_state(&a2, json!({ "state": "downloading", "version": rel2.version, "done": done, "total": total }));
                }
            })
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
        match result {
            Ok(exe) => {
                set_update_state(&a, json!({ "state": "restarting", "version": rel.version }));
                restart_into(&a, exe);
            }
            Err(e) => {
                a.state::<Arc<AppState>>().inner.lock().unwrap().update_busy = false;
                set_update_state(&a, json!({ "state": "error", "text": e, "version": rel.version, "page": rel.page }));
            }
        }
    });
    json!({ "ok": true })
}

/// Starts the freshly installed exe and quits. The single-instance lock is released first,
/// otherwise the new process would just hand its arguments to us and exit.
fn restart_into(app: &AppHandle, exe: std::path::PathBuf) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        config::save(&a.state::<Arc<AppState>>().inner.lock().unwrap().config);
        tauri_plugin_single_instance::destroy(&a);
        match std::process::Command::new(&exe).arg(UPDATED_ARG).spawn() {
            Ok(_) => {
                a.cleanup_before_exit();
                std::process::exit(0);
            }
            Err(e) => {
                a.state::<Arc<AppState>>().inner.lock().unwrap().update_busy = false;
                set_update_state(&a, json!({ "state": "error", "text": format!("已更新，但重启失败（{e}），请手动重新打开") }));
            }
        }
    });
}

async fn update_loop(app: AppHandle) {
    tokio::time::sleep(UPDATE_FIRST_CHECK).await;
    loop {
        check_update(app.clone(), false).await;
        tokio::time::sleep(UPDATE_EVERY).await;
    }
}

#[tauri::command]
fn hit_rects(state: St<'_>, rects: Vec<[f64; 4]>) {
    state.inner.lock().unwrap().hit_rects = rects.into_iter().take(64).collect();
}

#[tauri::command]
fn overlay_idle(app: AppHandle, state: St<'_>, seen: u64) {
    // Only hide if the overlay has received every splat we sent (one may be in flight).
    if seen >= state.inner.lock().unwrap().splats_sent {
        hide_overlay(&app, &state);
    }
}

fn hide_overlay(app: &AppHandle, state: &AppState) {
    state.inner.lock().unwrap().overlay_shown = false;
    if let Some(Ok(h)) = app.get_webview_window("overlay").map(|ov| ov.hwnd()) {
        win::hide(h);
    }
}

#[tauri::command]
fn set_dnd(app: AppHandle, on: bool) {
    apply_dnd(&app, on);
}

#[tauri::command]
fn quit(app: AppHandle, state: St<'_>) {
    config::save(&state.inner.lock().unwrap().config);
    app.exit(0);
}

// ---------------------------------------------------------------- network events

fn non_neg(v: &Value) -> u64 {
    v.as_f64().filter(|n| n.is_finite() && *n > 0.0).map_or(0, |n| n.floor().min(1e12) as u64)
}

/// A string from the network, at most `max` characters.
fn clip(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").chars().take(max).collect()
}

/// A list of player ids from the network.
fn id_list(v: &Value) -> Vec<String> {
    let list = v.as_array().into_iter().flatten().filter_map(Value::as_str);
    list.take(MAX_PLAYERS).map(|s| s.chars().take(64).collect()).collect()
}

/// Which of our bosses a "boss" / "bossDown" message is about: by id, or by name from v2.4
/// servers, which send none. `None` for one we don't know (only a newer server has it).
fn boss_id(b: &Value) -> Option<&'static str> {
    match b.get("id") {
        Some(id) => BOSSES.iter().find(|k| id.as_str() == Some(k.id)),
        None => BOSSES.iter().find(|k| b["name"].as_str() == Some(k.name)),
    }
    .map(|k| k.id)
}

/// The room's boss as the page shows it; null from servers without one.
fn clean_boss(b: &Value) -> Value {
    if !b.is_object() {
        return Value::Null;
    }
    json!({
        "id": boss_id(b), "emoji": clip(&b["emoji"], 8), "name": clip(&b["name"], 16), "level": non_neg(&b["level"]),
        "hp": non_neg(&b["hp"]), "max": non_neg(&b["max"]), "in": non_neg(&b["in"]), "minPct": non_neg(&b["minPct"]),
    })
}

/// Everything from the network is untrusted (the host could be anyone): normalise before the UI sees it.
fn clean_player(p: &Value) -> Option<Value> {
    let id: String = p["id"].as_str()?.chars().take(64).collect();
    let character = p["char"].as_str().filter(|c| CHARACTERS.contains(c)).unwrap_or(CHARACTERS[0]);
    let inv: serde_json::Map<String, Value> = ITEM_IDS.iter().map(|k| (k.to_string(), non_neg(&p["inv"][k]).into())).collect();
    Some(json!({
        "id": id,
        "name": p["name"].as_str().unwrap_or("").chars().take(NAME_MAX).collect::<String>(),
        "char": character,
        "decos": worn_by(p),
        "skinRev": non_neg(&p["skinRev"]),
        "count": non_neg(&p["count"]),
        "typing": p["typing"].as_bool().unwrap_or(false),
        "chest": p["chest"].as_bool().unwrap_or(false),
        "dnd": p["dnd"].as_bool().unwrap_or(false),
        "dmg": non_neg(&p["dmg"]),
        "inv": inv,
    }))
}

/// A player's worn cosmetics: known ids only, at most one per slot. v2.1 clients / relays only
/// send a single "deco".
fn worn_by(p: &Value) -> Vec<String> {
    let listed: Vec<&Value> = match p["decos"].as_array() {
        Some(list) => list.iter().collect(),
        None => vec![&p["deco"]],
    };
    let mut worn: Vec<&decos::Deco> = Vec::new();
    for d in listed.into_iter().filter_map(|v| v.as_str()).filter_map(decos::get) {
        if !worn.iter().any(|w| w.slot == d.slot) {
            worn.push(d);
        }
    }
    worn.into_iter().map(|d| d.id.clone()).collect()
}

fn refund_pending(app: &AppHandle, state: &AppState) {
    let mut i = state.inner.lock().unwrap();
    if i.pending_throws.is_empty() {
        return;
    }
    let pending: Vec<usize> = i.pending_throws.drain().map(|(_, idx)| idx).collect();
    for idx in pending {
        *i.config.inv.get_mut(idx) += 1;
    }
    i.touch();
    let w = i.wallet();
    drop(i);
    let _ = app.emit("wallet", w);
}

fn on_net_event(app: &AppHandle, ev: NetEvent) {
    let state = app.state::<Arc<AppState>>();
    match ev {
        NetEvent::Status { state: s, text } => {
            // A throw whose result never arrived (connection dropped) gives the item back.
            if s != "online" {
                refund_pending(app, &state);
                state.inner.lock().unwrap().games_supported=false;
                let _=app.emit("games-online",false);
            }
            let _ = app.emit("net-status", json!({ "state": s, "text": text }));
        }
        NetEvent::Welcome(msg) => {
            let items: Vec<&'static str> = match msg["items"].as_array() {
                Some(list) => ITEM_IDS.iter().copied().filter(|id| list.iter().any(|v| v.as_str() == Some(id))).collect(),
                None => ITEM_IDS[..OLD_SERVER_ITEMS].to_vec(),
            };
            {
                let mut i = state.inner.lock().unwrap();
                i.last_status.clear(); // resend our status
                i.blocks_seen = 0; // counted per connection
                i.server_items = items.clone();
                i.games_supported=msg["games"].as_bool()==Some(true);
                if !i.games_supported {i.config.game_new_epoch("");i.game=Value::Null;config::save(&i.config);}
                if let Some(epoch)=msg["gameEpoch"].as_str().filter(|s|s.len()==32) {
                    i.config.game_new_epoch(epoch);
                    config::save(&i.config);
                    if let Some(ticket)=&i.config.game_ticket {
                        state.net.send(&json!({"t":"game","op":"join","epoch":epoch,"ticket":ticket.ticket,"kind":ticket.kind,
                            "count":i.config.count.saturating_add(500),"gameEpoch":epoch,"gameOffset":i.config.game_offset+500}));
                    }
                }
                let _=app.emit("wallet",i.wallet());
                let _=app.emit("games-online",i.games_supported);
            }
            let _ = app.emit("server-items", items);
        }
        NetEvent::State(list, boss) => {
            let players: Vec<Value> = list.iter().take(MAX_PLAYERS).filter_map(clean_player).collect();
            let boss = clean_boss(&boss);
            let gone: Vec<String> = {
                let mut i = state.inner.lock().unwrap();
                let ids: Vec<&str> = players.iter().filter_map(|p| p["id"].as_str()).collect();
                let gone: Vec<String> = i.skins.keys().filter(|k| !ids.contains(&k.as_str())).cloned().collect();
                for g in &gone {
                    i.skins.remove(g);
                }
                i.players = players.clone();
                i.boss = boss.clone();
                gone
            };
            for id in gone {
                let _ = app.emit("skin", json!({ "id": id, "rev": 0, "skin": null }));
            }
            state.steam.update_lobby_meta(None, Some(players.len()));
            let _ = app.emit("players", players);
            let _ = app.emit("boss", boss);
        }
        NetEvent::BossDown(msg) => on_boss_down(app, &state, &msg),
        NetEvent::Game(msg) => {
            let mut i=state.inner.lock().unwrap();
            if msg["t"]=="gameError" {
                if let Some(ticket)=msg["ticket"].as_str() {
                    i.config.game_receipt(&json!({"ticket":ticket,"net":0,"final":true}));
                    config::save(&i.config);i.status_soon();
                    let _=app.emit("wallet",i.wallet());
                }
                let text:String=msg["text"].as_str().unwrap_or("牌桌操作失败").chars().take(80).collect();
                let _=app.emit("toast",&text);let _=app.emit("game-error",text);
                return;
            }
            if msg["epoch"].as_str()!=Some(&i.config.game_epoch){return;}
            if i.config.game_receipt(&msg["receipt"]) {
                config::save(&i.config);i.status_soon();let _=app.emit("wallet",i.wallet());
            }
            i.game=msg.clone();let _=app.emit("games",msg);
        }
        NetEvent::Skin(msg) => {
            let Some(id) = msg["id"].as_str().map(|s| s.chars().take(64).collect::<String>()) else { return };
            let skin = clean_skin(&msg["skin"]);
            let rev = non_neg(&msg["rev"]);
            {
                let mut i = state.inner.lock().unwrap();
                match &skin {
                    Some(s) => i.skins.insert(id.clone(), json!({ "rev": rev, "skin": s })),
                    None => i.skins.remove(&id),
                };
            }
            let _ = app.emit("skin", json!({ "id": id, "rev": rev, "skin": skin }));
        }
        NetEvent::Log(text) => {
            let _ = app.emit("log", text);
        }
        NetEvent::Hit(raw) => on_hit(app, &state, &raw),
        NetEvent::ThrowResult(r) => {
            let Some(seq) = r["seq"].as_u64() else { return };
            let mut i = state.inner.lock().unwrap();
            let Some(idx) = i.pending_throws.remove(&seq) else { return };
            if r["ok"].as_bool() != Some(true) {
                *i.config.inv.get_mut(idx) += 1; // refund the optimistic deduction
                i.touch();
                let w = i.wallet();
                drop(i);
                let _ = app.emit("wallet", w);
                let text: String = r["text"].as_str().filter(|t| !t.is_empty()).unwrap_or("扔失败了").chars().take(60).collect();
                let _ = app.emit("toast", text);
            }
        }
    }
}

/// Something was thrown in the room: a single throw, a room-wide item, or one blocked by umbrellas.
fn on_hit(app: &AppHandle, state: &AppState, raw: &Value) {
    let Some(idx) = raw["item"].as_str().and_then(item_index) else { return };
    let (item, kind) = (&ITEMS[idx], ITEM_KINDS[idx]);
    let (from, from_name) = (clip(&raw["from"], 64), clip(&raw["fromName"], NAME_MAX));
    let (to, to_name) = (clip(&raw["to"], 64), clip(&raw["toName"], NAME_MAX));
    // v2.2 servers only relay single throws, without these lists.
    let (targets, blocked) = match raw.get("targets") {
        Some(t) => (id_list(t), id_list(&raw["blocked"])),
        None => (vec![to.clone()], Vec::new()),
    };
    let me = state.inner.lock().unwrap().config.id.clone();
    let mine = from == me;
    let hit_me = kind == ItemKind::Party || targets.contains(&me);
    let umbrellas_left = blocked.contains(&me).then(|| use_umbrella(app, state));
    let hit = json!({
        "item": item.id, "kind": kind.as_str(), "from": from, "fromName": from_name, "to": to, "toName": to_name,
        "targets": targets, "blocked": blocked, "mine": mine,
    });
    let quiet = hit_me && !show_effect(app, state, &hit);

    let (name, emoji) = (item.name, item.emoji);
    let thrower = if mine { "你".to_string() } else { format!(" {from_name} ") };
    let dodged = if blocked.is_empty() { String::new() } else { format!("，{} 人撑伞躲过", blocked.len()) };
    let mut line = match (kind, umbrellas_left) {
        (ItemKind::Group, Some(left)) => format!("☂️ {from_name} 下了一场{name}，被你的雨伞挡住了（还剩 {left} 把）"),
        (_, Some(left)) => format!("☂️ 你的雨伞挡住了 {from_name} 的{name}（还剩 {left} 把）"),
        (ItemKind::Party, _) => format!("{emoji} {} 放了一场{name}！", thrower.trim()),
        (ItemKind::Group, _) if mine => format!("{emoji} 你下了一场{name}，糊中 {} 人{dodged}", targets.len()),
        (ItemKind::Group, _) if hit_me => format!("{emoji} {from_name} 下了一场{name}，你被淋了一脸！"),
        (ItemKind::Group, _) => format!("{emoji} {from_name} 下了一场{name}{dodged}"),
        _ if hit_me => format!("💥 {from_name} 用{name}糊了你一脸！"),
        _ if !blocked.is_empty() => format!("☂️ {to_name} 用雨伞挡住了{thrower}的{name}"),
        _ => format!("{from_name} 用{name}糊了 {to_name} 一脸"),
    };
    if quiet {
        line.push_str("（免打扰）");
    }
    let _ = app.emit("log", line);
    let _ = app.emit("hit", hit);
}

/// `part` of `total` as "2.5%" / "34%".
fn percent(part: u64, total: u64) -> String {
    let p = part as f64 * 100.0 / total.max(1) as f64;
    if p < 10.0 { format!("{p:.1}%") } else { format!("{p:.0}%") }
}

/// The room beat its boss: everyone there who did enough of the damage gets a boss chest, a
/// lucky one for the last hit, which also drops one of the boss's own cosmetics. Every last hit
/// counts towards the calendar's 最后一击.
fn on_boss_down(app: &AppHandle, state: &AppState, msg: &Value) {
    let (emoji, name) = (clip(&msg["emoji"], 8), clip(&msg["name"], 16));
    let (killer, killer_name) = (clip(&msg["killer"], 64), clip(&msg["killerName"], NAME_MAX));
    let me = state.inner.lock().unwrap().config.id.clone();
    let lucky = killer == me;
    let won = id_list(&msg["rewarded"]).contains(&me);
    let share = percent(non_neg(&msg["damage"][me.as_str()]), non_neg(&msg["total"]));
    let need = non_neg(&msg["minPct"]);
    let mut loot = None; // (cosmetic, first copy)
    let mut last_hits = Value::Null; // today's new count
    if lucky || won {
        let mut i = state.inner.lock().unwrap();
        if lucky {
            let today = win::today();
            let n = i.config.daily_last_hits.entry(today.clone()).or_default();
            *n += 1;
            last_hits = json!({ today: *n });
        }
        if won && lucky {
            i.config.lucky_chests += 1;
            loot = boss_id(msg).and_then(decos::roll_boss_drop).map(|d| {
                let n = i.config.decos.entry(d.id.clone()).or_default();
                *n += 1;
                (d, *n == 1)
            });
        } else if won {
            i.config.boss_chests += 1;
        }
        i.touch();
        let d = i.deco_state();
        drop(i);
        let _ = app.emit("deco-state", d);
    }
    let quiet = !show_effect(app, state, &json!({ "item": "firework", "title": format!("⚔️ 打败了 {emoji} {name}！") }));
    let prize = match loot {
        Some((d, _)) => format!("幸运 Boss 宝箱和专属装扮「{}」（{}）", d.name, decos::RARITIES[d.rarity].name),
        None => "幸运 Boss 宝箱（稀有度更高）".to_string(),
    };
    let mut line = match (won, lucky) {
        (true, true) => format!("⚔️ 你补了最后一刀，打败了 {emoji} {name}！伤害 {share}，得到一个{prize}"),
        (true, false) => format!("⚔️ {killer_name} 补了最后一刀，打败了 {emoji} {name}！你的伤害 {share}，得到一个 Boss 宝箱"),
        (false, true) => format!("⚔️ 你补了最后一刀，打败了 {emoji} {name}！可惜伤害只有 {share}，要 {need}% 以上才有宝箱和专属装扮"),
        (false, false) => format!("⚔️ {killer_name} 打败了 {emoji} {name}！你的伤害只有 {share}，要 {need}% 以上才有宝箱"),
    };
    if quiet {
        line.push_str("（免打扰）");
    }
    let _ = app.emit("log", line);
    let loot = loot.map(|(d, new)| json!({ "id": d.id, "isNew": new }));
    let _ = app.emit("boss-down", json!({ "killerName": killer_name, "loot": loot, "dailyLastHits": last_hits }));
}

/// The server used up one of our umbrellas blocking an attack; returns how many are left.
fn use_umbrella(app: &AppHandle, state: &AppState) -> u64 {
    let mut i = state.inner.lock().unwrap();
    let left = i.config.inv.get(UMBRELLA).saturating_sub(1);
    *i.config.inv.get_mut(UMBRELLA) = left;
    i.blocks_seen += 1;
    i.touch();
    i.status_soon();
    let w = i.wallet();
    drop(i);
    let _ = app.emit("wallet", w);
    left
}

/// Plays an item's effect on the full-screen overlay. Returns false when it was kept off the
/// screen for 免打扰 (switched on, or a full-screen app / presentation in front).
fn show_effect(app: &AppHandle, state: &AppState, hit: &Value) -> bool {
    let (dnd, overlay_up) = {
        let i = state.inner.lock().unwrap();
        (i.config.dnd, i.overlay_shown)
    };
    // Only asked while the overlay is hidden: covering the screen, it might count as full-screen.
    if dnd || (!overlay_up && win::user_busy()) {
        return false;
    }
    {
        let mut i = state.inner.lock().unwrap();
        while i.splat_times.front().is_some_and(|t| t.elapsed() > SPLAT_LIFETIME) {
            i.splat_times.pop_front();
        }
        if i.splat_times.len() >= MAX_ACTIVE_SPLATS {
            return true; // the screen is covered enough already
        }
        i.splat_times.push_back(Instant::now());
        i.splats_sent += 1;
        i.overlay_shown = true;
    }
    let Some(ov) = app.get_webview_window("overlay") else { return true };
    // Cover the monitor the pet is on.
    let monitor = app
        .get_webview_window("pet")
        .and_then(|p| p.current_monitor().ok().flatten())
        .or_else(|| ov.primary_monitor().ok().flatten());
    if let (Some(m), Ok(hwnd)) = (monitor, ov.hwnd()) {
        let (p, s) = (m.position(), m.size());
        let rect = Some((p.x, p.y, s.width as i32, s.height as i32));
        win::show_no_activate(hwnd, rect);
        // Moving onto a monitor with another DPI makes Windows rescale the window; set it again.
        win::show_no_activate(hwnd, rect);
    }
    let _ = app.emit_to("overlay", "effect", hit);
    true
}

// ---------------------------------------------------------------- windows / tray

fn corner_position(m: &tauri::Monitor) -> PhysicalPosition<i32> {
    let (wa, sf) = (m.work_area(), m.scale_factor());
    PhysicalPosition::new(
        wa.position.x + wa.size.width as i32 - ((PET_W + 8.0) * sf) as i32,
        wa.position.y + wa.size.height as i32 - (PET_H * sf) as i32,
    )
}

fn on_screen(win: &WebviewWindow, x: i32, y: i32) -> bool {
    let sf = win.scale_factor().unwrap_or(1.0);
    let cx = x + (PET_ME_X * sf) as i32;
    let cy = y + ((PET_H - 100.0) * sf) as i32; // where the character stands
    win.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        cx >= p.x && cx <= p.x + s.width as i32 && cy >= p.y && cy <= p.y + s.height as i32
    })
}

fn reset_pet_position(app: &AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        if let Some(m) = pet.primary_monitor().ok().flatten() {
            let _ = pet.set_position(corner_position(&m));
        }
    }
}

// The pet window is always shown/hidden through Tauri so its visibility state stays in sync.
fn toggle_pet(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    if pet.is_visible().unwrap_or(false) {
        let _ = pet.hide();
    } else {
        let _ = pet.show();
    }
}

fn create_windows(app: &AppHandle) -> tauri::Result<()> {
    // A hidden owner keeps both windows off the taskbar and out of Alt+Tab (tray icon only).
    let owner = win::hidden_owner().map_err(std::io::Error::from)?;
    // Created visible + unfocused so Tauri shows it without stealing focus *and* records it as
    // visible. (Showing it via raw Win32 instead makes Tauri hide it again on the next style
    // change, e.g. toggling click-through.) The builder takes logical coordinates.
    let mut builder = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("摸鱼搭子")
        .inner_size(PET_W, PET_H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .owner_raw(owner)
        .visible(true)
        .focused(false);
    if let Some(m) = app.primary_monitor().ok().flatten() {
        let p = corner_position(&m);
        builder = builder.position(p.x as f64 / m.scale_factor(), p.y as f64 / m.scale_factor());
    }
    let pet = builder.build()?;
    pet.set_ignore_cursor_events(true)?;
    let saved = app.state::<Arc<AppState>>().inner.lock().unwrap().config.pet_pos_phys;
    if let Some((x, y)) = saved.filter(|&(x, y)| on_screen(&pet, x, y)) {
        pet.set_position(PhysicalPosition::new(x, y))?;
    }
    let a = app.clone();
    let pet_for_close = pet.clone();
    pet.on_window_event(move |e| match e {
        WindowEvent::Moved(p) => {
            let st = a.state::<Arc<AppState>>();
            let mut i = st.inner.lock().unwrap();
            i.config.pet_pos_phys = Some((p.x, p.y));
            i.touch();
        }
        // Alt+F4 would destroy the window for good; hide it instead (the tray brings it back).
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = pet_for_close.hide();
        }
        _ => {}
    });

    // Created up front (hidden) so it's loaded and ready the moment a splat arrives.
    let overlay = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("摸鱼搭子 overlay")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .owner_raw(owner)
        .resizable(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .build()?;
    overlay.set_ignore_cursor_events(true)?;
    Ok(())
}

/// The tray's 免打扰 item, kept so that switching it off from the pet unticks it too.
struct DndItem(CheckMenuItem<tauri::Wry>);

fn apply_dnd(app: &AppHandle, on: bool) {
    {
        let st = app.state::<Arc<AppState>>();
        let mut i = st.inner.lock().unwrap();
        i.config.dnd = on;
        i.touch();
        i.status_soon(); // friends see the 🔕
    }
    if let Some(item) = app.try_state::<DndItem>() {
        let _ = item.0.set_checked(on);
    }
    let _ = app.emit("dnd", on);
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏小人", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "回到右下角", true, None::<&str>)?;
    let dnd_on = app.state::<Arc<AppState>>().inner.lock().unwrap().config.dnd;
    let dnd = CheckMenuItem::with_id(app, "dnd", "免打扰（被糊不弹全屏）", true, dnd_on, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机自启", true, win::autostart_enabled(), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &reset, &dnd, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(DndItem(dnd.clone()));
    let auto = autostart.clone();
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("摸鱼搭子 Co-Fisher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "toggle" => toggle_pet(app),
            "reset" => reset_pet_position(app),
            "dnd" => apply_dnd(app, dnd.is_checked().unwrap_or(false)),
            "autostart" => {
                let want = auto.is_checked().unwrap_or(false);
                if win::set_autostart(want).is_err() {
                    let _ = auto.set_checked(!want);
                }
            }
            "quit" => {
                config::save(&app.state::<Arc<AppState>>().inner.lock().unwrap().config);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                toggle_pet(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- background loops

async fn tick_loop(app: AppHandle) {
    let mut tick = tokio::time::interval(TICK);
    let mut n: u64 = 0;
    loop {
        tick.tick().await;
        n += 1;
        let state = app.state::<Arc<AppState>>();
        state.steam.tick();
        let now = input::now_ms();
        let last = input::last_input_ms();
        let typing = last > 0 && now.saturating_sub(last) < TYPING_HOLD_MS;
        if now.saturating_sub(last) > 3000 {
            input::clear_held();
        }
        let presses = input::take_presses();
        let (local, status) = {
            let mut i = state.inner.lock().unwrap();
            let mut daily = Value::Null; // today's new total, for the calendar
            if presses > 0 {
                i.config.count += presses;
                i.config.total += presses;
                let today = win::today();
                let n = i.config.daily.entry(today.clone()).or_default();
                *n += presses;
                daily = json!({ today: *n });
                i.touch();
            }
            let changed = presses > 0 || typing != i.typing || i.last_pushed_count != Some(i.config.count);
            let local = changed.then(|| {
                i.typing = typing;
                i.last_pushed_count = Some(i.config.count);
                json!({ "typing": typing, "count": i.config.count, "total": i.config.total, "inv": i.config.inv.to_json(), "daily": daily })
            });
            let status = (i.last_status_at.elapsed() >= STATUS_EVERY).then(|| {
                let chest = decos::chest_ready(i.config.last_chest_ms, now, i.config.count);
                let (inv, blocks) = (i.config.inv.to_json(), i.blocks_seen);
                json!({ "t": "status", "count": i.config.count, "typing": typing, "inv": inv, "blocks": blocks, "chest": chest, "dnd": i.config.dnd,"gameEpoch":i.config.game_epoch,"gameOffset":i.config.game_offset })
            });
            if i.dirty && i.last_save.elapsed() >= SAVE_EVERY {
                // Throttled rather than debounced, so continuous typing still saves.
                config::save(&i.config);
                i.dirty = false;
                i.last_save = Instant::now();
            }
            (local, status)
        };
        if let Some(l) = local {
            let _ = app.emit("local", l);
        }
        if let Some(s) = status {
            let key = s.to_string();
            let changed = state.inner.lock().unwrap().last_status != key;
            if changed && state.net.send(&s) {
                let mut i = state.inner.lock().unwrap();
                i.last_status = key;
                i.last_status_at = Instant::now();
            }
        }
        // Monitors get unplugged / rearranged: bring the pet back if it ended up off-screen.
        // If a splat never reached the overlay page it never reports idle; don't leave a
        // full-screen window up.
        let overlay_stale = {
            let i = state.inner.lock().unwrap();
            i.overlay_shown && i.splat_times.back().is_none_or(|t| t.elapsed() > SPLAT_LIFETIME + Duration::from_secs(2))
        };
        if overlay_stale {
            hide_overlay(&app, &state);
        }
        if n % 200 == 0 {
            if let Some(pet) = app.get_webview_window("pet") {
                if let Ok(p) = pet.outer_position() {
                    if !on_screen(&pet, p.x, p.y) {
                        reset_pet_position(&app);
                    }
                }
            }
        }
    }
}

/// The pet window is mostly transparent: it lets clicks through except over the character,
/// friend cards and panel, whose rectangles the page reports via `hit_rects`.
async fn cursor_loop(app: AppHandle) {
    let mut tick = tokio::time::interval(CURSOR_POLL);
    let mut ignoring = true;
    loop {
        tick.tick().await;
        let Some(pet) = app.get_webview_window("pet") else { continue };
        let (Some((cx, cy)), Ok(pos), Ok(sf)) = (win::cursor_pos(), pet.inner_position(), pet.scale_factor()) else { continue };
        let (lx, ly) = ((cx - pos.x) as f64 / sf, (cy - pos.y) as f64 / sf);
        let over = {
            let st = app.state::<Arc<AppState>>();
            let i = st.inner.lock().unwrap();
            i.hit_rects.iter().any(|r| lx >= r[0] && ly >= r[1] && lx <= r[0] + r[2] && ly <= r[1] + r[3])
        };
        if over == ignoring {
            ignoring = !over;
            let _ = pet.set_ignore_cursor_events(ignoring);
        }
    }
}

// ---------------------------------------------------------------- main

fn main() {
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let (invite_tx, mut invite_rx) = mpsc::unbounded_channel();
    let state = Arc::new(AppState {
        inner: Mutex::new(Inner {
            config: config::load(),
            skin: config::load_skin(),
            dirty: true,
            last_save: Instant::now() - SAVE_EVERY,
            players: Vec::new(),
            skins: HashMap::new(),
            pending_throws: HashMap::new(),
            throw_seq: 0,
            server_items: ITEM_IDS.to_vec(),
            boss: Value::Null,
            game: Value::Null,
            games_supported: false,
            blocks_seen: 0,
            splat_times: VecDeque::new(),
            splats_sent: 0,
            overlay_shown: false,
            hit_rects: Vec::new(),
            typing: false,
            last_pushed_count: None,
            last_status: String::new(),
            last_status_at: Instant::now(),
            update: None,
            update_state: json!({ "state": "idle", "current": update::CURRENT }),
            update_busy: false,
        }),
        net: Net::new(ev_tx),
        steam: Steam::new(invite_tx.clone()),
        server: tokio::sync::Mutex::new(None),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, args, _cwd| {
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.show();
            }
            if let Some(target) = steam::connect_arg(&args) {
                let _ = invite_tx.send(target);
            }
        }))
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            init, set_profile, set_skin, clear_skin, host, join, leave,
            steam_status, steam_rooms, steam_invite,
            buy, throw_item, open_chest, open_boss_chest, merge_decos, fill_merge, equip_deco,
            game_command,
            check_for_update, apply_update, hit_rects, overlay_idle, set_dnd, quit
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            update::cleanup();
            create_windows(&handle)?;
            create_tray(&handle)?;
            if let Err(e) = input::start() {
                let _ = handle.emit("toast", format!("键盘 / 鼠标监听启动失败（{e}）"));
            }
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = ev_rx.recv().await {
                    on_net_event(&h, ev);
                }
            });
            let h_inv = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(target) = invite_rx.recv().await {
                    let st = h_inv.state::<Arc<AppState>>();
                    let pwd = st.inner.lock().unwrap().config.join_password.clone();
                    match do_join(&h_inv, &st, target, pwd, String::new()).await {
                        Ok(()) => {
                            let join_addr = st.inner.lock().unwrap().config.join_address.clone();
                            let srv = server_status(&st).await;
                            let _ = h_inv.emit("steam-joined", json!({ "joinAddress": join_addr, "server": srv }));
                        }
                        Err(e) => {
                            let _ = h_inv.emit("toast", format!("Steam 加入失败：{e}"));
                        }
                    }
                }
            });
            tauri::async_runtime::spawn(resume_last_session(handle.clone()));
            tauri::async_runtime::spawn(tick_loop(handle.clone()));
            tauri::async_runtime::spawn(update_loop(handle.clone()));
            tauri::async_runtime::spawn(cursor_loop(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit(); // closing windows keeps us in the tray
                } else {
                    config::save(&app.state::<Arc<AppState>>().inner.lock().unwrap().config);
                }
            }
        });
}
