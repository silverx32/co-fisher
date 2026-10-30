#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod keyboard;
mod net;
mod steam;
mod win;

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cofisher_server::{clean_skin, ServerHandle, ServerOptions, CHARACTERS, ITEM_IDS, MAX_PLAYERS, NAME_MAX};
use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc;

use config::Config;
use net::{Net, NetEvent};
use steam::Steam;

// Wide enough for 7 friends standing to the left of me; the empty part is click-through.
const PET_W: f64 = 840.0;
const PET_ME_X: f64 = PET_W - 95.0; // where my character stands, from the window's left edge
const PET_H: f64 = 620.0;
const TYPING_HOLD_MS: u64 = 700;
const TICK: Duration = Duration::from_millis(25); // short so each key press shows up right away
const STATUS_EVERY: Duration = Duration::from_millis(150);
const SAVE_EVERY: Duration = Duration::from_secs(2);
const CURSOR_POLL: Duration = Duration::from_millis(40);
const SPLAT_LIFETIME: Duration = Duration::from_millis(7600); // flight + stay + fade in overlay.js
const MAX_ACTIVE_SPLATS: usize = 5;

struct Item {
    id: &'static str,
    name: &'static str,
    emoji: &'static str,
    cost: u64,
}

const ITEMS: [Item; 3] = [
    Item { id: "tomato", name: "番茄", emoji: "🍅", cost: 50 },
    Item { id: "ink", name: "墨鱼汁", emoji: "🦑", cost: 100 },
    Item { id: "poop", name: "屎", emoji: "💩", cost: 200 },
];

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
    splat_times: VecDeque<Instant>,
    splats_sent: u64,
    overlay_shown: bool,
    hit_rects: Vec<[f64; 4]>, // interactive areas of the pet window, CSS px
    typing: bool,
    last_pushed_count: Option<u64>,
    last_status: String,
    last_status_at: Instant,
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
}

fn hello_for(app: &AppHandle) -> Value {
    let st = app.state::<Arc<AppState>>();
    let i = st.inner.lock().unwrap();
    let c = &i.config;
    net::hello_payload(&c.id, &c.secret, &c.name, &c.character, i.skin.as_ref(), c.count, c.inv.to_json())
}

fn profile_msg(i: &Inner, with_skin: bool) -> Value {
    let mut m = json!({ "t": "profile", "name": i.config.name, "char": i.config.character });
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
        .map(|it| (it.id.to_string(), json!({ "id": it.id, "name": it.name, "emoji": it.emoji, "cost": it.cost })))
        .collect();
    let characters: Vec<Value> = CHARACTERS
        .iter()
        .zip(CHARACTER_INFO)
        .map(|(id, (name, desc))| json!({ "id": id, "name": name, "desc": desc }))
        .collect();
    Ok(json!({
        "me": { "id": i.config.id, "name": i.config.name, "char": i.config.character, "skin": i.skin },
        "wallet": i.wallet(),
        "items": items,
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
        "skins": i.skins,
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
    state.net.disconnect();
    stop_server(&state).await;
    {
        let mut i = state.inner.lock().unwrap();
        i.players.clear();
        i.skins.clear();
        i.config.resume.clear();
        i.touch();
    }
    let _ = app.emit("players", Vec::<Value>::new());
    Ok(json!({ "ok": true, "server": server_status(&state).await }))
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
    i.last_status.clear();
    i.last_status_at = Instant::now() - STATUS_EVERY;
    let w = i.wallet();
    drop(i);
    let _ = app.emit("wallet", &w);
    json!({ "ok": true, "wallet": w })
}

#[tauri::command]
fn throw_item(app: AppHandle, state: St<'_>, item: String, target: String) -> Value {
    let Some(idx) = item_index(&item) else { return json!({ "ok": false, "error": "未知道具" }) };
    if state.net.state() != "online" {
        return json!({ "ok": false, "error": "还没联机哦" });
    }
    let mut i = state.inner.lock().unwrap();
    if i.config.inv.get(idx) < 1 {
        return json!({ "ok": false, "error": format!("没有{}了，先去兑换", ITEMS[idx].name) });
    }
    i.throw_seq += 1;
    let seq = i.throw_seq;
    // The inventory *before* this throw travels with it; the server checks and deducts from it.
    let msg = json!({ "t": "throw", "seq": seq, "item": item, "target": target, "inv": i.config.inv.to_json() });
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
fn quit(app: AppHandle, state: St<'_>) {
    config::save(&state.inner.lock().unwrap().config);
    app.exit(0);
}

// ---------------------------------------------------------------- network events

fn non_neg(v: &Value) -> u64 {
    v.as_f64().filter(|n| n.is_finite() && *n > 0.0).map_or(0, |n| n.floor().min(1e12) as u64)
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
        "skinRev": non_neg(&p["skinRev"]),
        "count": non_neg(&p["count"]),
        "typing": p["typing"].as_bool().unwrap_or(false),
        "inv": inv,
    }))
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
            }
            let _ = app.emit("net-status", json!({ "state": s, "text": text }));
        }
        NetEvent::Welcome => state.inner.lock().unwrap().last_status.clear(), // resend our status
        NetEvent::State(list) => {
            let players: Vec<Value> = list.iter().take(MAX_PLAYERS).filter_map(clean_player).collect();
            let gone: Vec<String> = {
                let mut i = state.inner.lock().unwrap();
                let ids: Vec<&str> = players.iter().filter_map(|p| p["id"].as_str()).collect();
                let gone: Vec<String> = i.skins.keys().filter(|k| !ids.contains(&k.as_str())).cloned().collect();
                for g in &gone {
                    i.skins.remove(g);
                }
                i.players = players.clone();
                gone
            };
            for id in gone {
                let _ = app.emit("skin", json!({ "id": id, "rev": 0, "skin": null }));
            }
            state.steam.update_lobby_meta(None, Some(players.len()));
            let _ = app.emit("players", players);
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
        NetEvent::Hit(raw) => {
            let Some(idx) = raw["item"].as_str().and_then(item_index) else { return };
            let name = |v: &Value| v.as_str().unwrap_or("").chars().take(NAME_MAX).collect::<String>();
            let hit = json!({
                "item": ITEM_IDS[idx],
                "from": raw["from"].as_str().unwrap_or(""),
                "to": raw["to"].as_str().unwrap_or(""),
                "fromName": name(&raw["fromName"]),
                "toName": name(&raw["toName"]),
            });
            let me = state.inner.lock().unwrap().config.id.clone();
            let item = &ITEMS[idx];
            if hit["to"] == me.as_str() {
                show_splat(app, &state, &hit);
                let _ = app.emit("log", format!("💥 {} 用{}糊了你一脸！", hit["fromName"].as_str().unwrap_or(""), item.name));
            } else {
                let _ = app.emit("log", format!("{} 用{}糊了 {} 一脸", hit["fromName"].as_str().unwrap_or(""), item.name, hit["toName"].as_str().unwrap_or("")));
            }
            let _ = app.emit("hit", hit);
        }
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

fn show_splat(app: &AppHandle, state: &AppState, hit: &Value) {
    {
        let mut i = state.inner.lock().unwrap();
        while i.splat_times.front().is_some_and(|t| t.elapsed() > SPLAT_LIFETIME) {
            i.splat_times.pop_front();
        }
        if i.splat_times.len() >= MAX_ACTIVE_SPLATS {
            return; // the screen is covered enough already
        }
        i.splat_times.push_back(Instant::now());
        i.splats_sent += 1;
        i.overlay_shown = true;
    }
    let Some(ov) = app.get_webview_window("overlay") else { return };
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
    let _ = app.emit_to("overlay", "splat", hit);
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
        .skip_taskbar(true)
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
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .build()?;
    overlay.set_ignore_cursor_events(true)?;
    Ok(())
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏小人", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "回到右下角", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机自启", true, win::autostart_enabled(), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &reset, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;
    let auto = autostart.clone();
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("摸鱼搭子 Co-Fisher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "toggle" => toggle_pet(app),
            "reset" => reset_pet_position(app),
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
        let now = keyboard::now_ms();
        let last = keyboard::last_key_ms();
        let typing = last > 0 && now.saturating_sub(last) < TYPING_HOLD_MS;
        if now.saturating_sub(last) > 3000 {
            keyboard::clear_held();
        }
        let presses = keyboard::take_presses();
        let (local, status) = {
            let mut i = state.inner.lock().unwrap();
            if presses > 0 {
                i.config.count += presses;
                i.config.total += presses;
                i.touch();
            }
            let local = (typing != i.typing || i.last_pushed_count != Some(i.config.count)).then(|| {
                i.typing = typing;
                i.last_pushed_count = Some(i.config.count);
                json!({ "typing": typing, "count": i.config.count, "total": i.config.total, "inv": i.config.inv.to_json() })
            });
            let status = (i.last_status_at.elapsed() >= STATUS_EVERY).then(|| {
                json!({ "t": "status", "count": i.config.count, "typing": typing, "inv": i.config.inv.to_json() })
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
            splat_times: VecDeque::new(),
            splats_sent: 0,
            overlay_shown: false,
            hit_rects: Vec::new(),
            typing: false,
            last_pushed_count: None,
            last_status: String::new(),
            last_status_at: Instant::now(),
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
            buy, throw_item, hit_rects, overlay_idle, quit
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            create_windows(&handle)?;
            create_tray(&handle)?;
            if let Err(e) = keyboard::start() {
                let _ = handle.emit("toast", format!("键盘监听启动失败：{e}"));
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
