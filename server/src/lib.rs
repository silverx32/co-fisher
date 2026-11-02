//! Co-Fisher room server. Used both inside the app (a player hosts, single room) and as the
//! standalone relay (`cofisher-relay`, many rooms keyed by room code). Each player's wallet
//! (count / inventory) is owned by their own client; the server keeps the roster, relays
//! throws and applies basic sanity checks and rate limits.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

pub const PROTOCOL_VERSION: u64 = 2;
pub const DEFAULT_PORT: u16 = 23333;
pub const MAX_PLAYERS: usize = 16;
pub const ITEM_IDS: [&str; 3] = ["tomato", "ink", "poop"];
pub const ITEM_NAMES: [&str; 3] = ["番茄", "墨鱼汁", "屎"];
// Built-in characters; art in ui/assets/characters/<id>/ (sliced by tools/slice-atlas.js).
pub const CHARACTERS: [&str; 6] = ["claude", "codex", "doubao", "gemini", "deepseek", "kimi"];
pub const NAME_MAX: usize = 12;
/// Equipped cosmetic id (art ships with the app; the server only checks the format).
pub const DECO_ID_MAX: usize = 32;
pub const MAX_PAYLOAD: usize = 1024 * 1024; // custom skins travel as data URLs
pub const SKIN_IMAGE_MAX: usize = 400 * 1024; // per image data URL length

const ROOM_CODE_MAX: usize = 32;
const MAX_KEYS_PER_SECOND: f64 = 40.0;
const KEY_BURST: f64 = 200.0; // count growth budget: refills at MAX_KEYS_PER_SECOND, capped here
const SKIN_CHANGE_EVERY: Duration = Duration::from_secs(10);
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30 * 60);
const THROWS_PER_WINDOW: usize = 3;
const THROW_WINDOW: Duration = Duration::from_secs(1);
const BROADCAST_INTERVAL: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(10);
const DEAD_AFTER: Duration = Duration::from_secs(25);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const HELLOS_PER_IP_PER_MIN: usize = 20;
const OUTBOX: usize = 64; // queued messages per client before it's considered stuck
const CLOSE_GRACE: Duration = Duration::from_secs(1);
/// Error replies the client should retry later instead of giving up.
const RETRYABLE: &str = "retry";

#[derive(Clone, Debug)]
pub struct ServerOptions {
    /// "::" listens on IPv6 and IPv4 (dual stack); falls back to 0.0.0.0 if IPv6 is unavailable.
    pub host: String,
    pub port: u16,
    pub password: String,
    /// In-app hosting: everybody lands in one room regardless of the room code they typed.
    pub single_room: bool,
    pub max_rooms: usize,
    pub max_sockets: usize,
    pub max_sockets_per_ip: usize,
}

impl ServerOptions {
    pub fn host_mode(port: u16, password: String) -> Self {
        Self { host: "::".into(), port, password, single_room: true, max_rooms: 1, max_sockets: MAX_PLAYERS * 4, max_sockets_per_ip: MAX_PLAYERS * 4 }
    }
    pub fn relay(port: u16, password: String) -> Self {
        Self { host: "::".into(), port, password, single_room: false, max_rooms: 500, max_sockets: 4000, max_sockets_per_ip: MAX_PLAYERS * 2 }
    }
}

pub struct ServerHandle {
    pub port: u16,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    /// Closes every connection (peers that don't answer are dropped after a short grace period).
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_millis(1500), self.task).await;
    }
}

// ---------------------------------------------------------------- state

struct Known {
    secret_hash: [u8; 32],
    count: u64,
    at: Instant,
}

struct Player {
    conn: u64,
    seq: u64,
    tx: mpsc::Sender<Message>,
    kill: Arc<Notify>,
    name: String,
    character: String,
    skin: Option<Value>,
    skin_rev: u64,
    deco: String,
    count: u64,
    typing: bool,
    inv: [u64; 3],
    throws: VecDeque<Instant>,
    budget: f64,
    budget_at: Instant,
    skin_changed_at: Option<Instant>,
}

#[derive(Default)]
struct Room {
    players: HashMap<String, Player>,
    // Survives disconnects (for the room's lifetime) so an id can't be taken over by someone
    // else and a reconnect can't reset the count-growth check.
    known: HashMap<String, Known>,
    dirty: bool,
    /// Empty rooms are kept for a while (with their `known` ids) so a former roommate can't
    /// recreate the room and claim someone else's id.
    emptied_at: Option<Instant>,
}

#[derive(Default)]
struct State {
    rooms: HashMap<String, Room>,
    hellos: HashMap<IpAddr, VecDeque<Instant>>,
    sockets: usize,
    sockets_by_ip: HashMap<IpAddr, usize>,
    next_conn: u64,
    next_seq: u64,
}

struct Shared {
    opts: ServerOptions,
    state: Mutex<State>,
}

fn push(p_tx: &mpsc::Sender<Message>, kill: &Notify, msg: &Value) {
    push_raw(p_tx, kill, Message::text(msg.to_string()));
}

fn push_raw(p_tx: &mpsc::Sender<Message>, kill: &Notify, msg: Message) {
    // A client that can't keep up is disconnected rather than buffered without bound.
    if p_tx.try_send(msg).is_err() {
        kill.notify_one();
    }
}

/// IPv6 clients usually own a whole /64, so per-IP limits apply to the prefix.
fn ip_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

fn close_msg(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() }))
}

impl Room {
    fn broadcast(&self, msg: &Value) {
        // Serialized once; cloning the message only bumps a reference count.
        let m = Message::text(msg.to_string());
        for p in self.players.values() {
            push_raw(&p.tx, &p.kill, m.clone());
        }
    }

    fn snapshot(&self) -> Value {
        let mut by_seq: Vec<(&String, &Player)> = self.players.iter().collect();
        by_seq.sort_by_key(|(_, p)| p.seq);
        Value::Array(
            by_seq
                .into_iter()
                .map(|(id, p)| {
                    json!({
                        "id": id, "name": p.name, "char": p.character,
                        "skinRev": if p.skin.is_some() { p.skin_rev } else { 0 }, "deco": p.deco,
                        "count": p.count, "typing": p.typing, "inv": inv_json(&p.inv),
                    })
                })
                .collect(),
        )
    }
}

fn inv_json(inv: &[u64; 3]) -> Value {
    let mut m = Map::new();
    for (i, id) in ITEM_IDS.iter().enumerate() {
        m.insert((*id).into(), inv[i].into());
    }
    Value::Object(m)
}

// ---------------------------------------------------------------- input cleaning

pub fn clean_name(v: &Value) -> String {
    let s: String = v.as_str().unwrap_or("").chars().filter(|c| !c.is_control()).collect();
    let s: String = s.trim().chars().take(NAME_MAX).collect();
    if s.is_empty() { "无名氏".into() } else { s }
}

/// A cosmetic id like "party-red", or "" for none.
pub fn clean_deco(v: &Value) -> String {
    match v.as_str() {
        Some(s) if s.len() <= DECO_ID_MAX && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') => s.to_string(),
        _ => String::new(),
    }
}

fn valid_image_data_url(s: &str) -> bool {
    if s.len() > SKIN_IMAGE_MAX {
        return false;
    }
    let body = ["png", "gif", "jpeg", "webp"]
        .iter()
        .find_map(|t| s.strip_prefix(&format!("data:image/{t};base64,")));
    matches!(body, Some(b) if !b.is_empty() && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'='))
}

/// Accepts only `{ idle, typing }` base64 image data URLs.
pub fn clean_skin(v: &Value) -> Option<Value> {
    let idle = v.get("idle")?.as_str()?;
    let typing = v.get("typing")?.as_str()?;
    (valid_image_data_url(idle) && valid_image_data_url(typing)).then(|| json!({ "idle": idle, "typing": typing }))
}

fn clamp_num(v: &Value, max: f64) -> u64 {
    match v.as_f64() {
        Some(n) if n.is_finite() => n.floor().clamp(0.0, max) as u64,
        _ => 0,
    }
}

pub fn clean_inv(v: &Value) -> [u64; 3] {
    let mut out = [0; 3];
    for (i, id) in ITEM_IDS.iter().enumerate() {
        out[i] = clamp_num(v.get(*id).unwrap_or(&Value::Null), 99_999.0);
    }
    out
}

fn clamp_count(v: &Value) -> u64 {
    clamp_num(v, 1e9)
}

fn clean_room(v: &Value) -> String {
    let s: String = v.as_str().unwrap_or("").chars().filter(|c| !c.is_control()).collect();
    s.trim().chars().take(ROOM_CODE_MAX).collect()
}

fn valid_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

/// How much a returning player's count may have grown while they were away.
fn growth_allowance(since: Instant) -> u64 {
    (since.elapsed().as_secs_f64() * MAX_KEYS_PER_SECOND).min(1e9) as u64 + 5
}

// ---------------------------------------------------------------- server

fn bind(host: &str, port: u16) -> io::Result<std::net::TcpListener> {
    let ip: IpAddr = host.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad host"))?;
    let addr = SocketAddr::new(ip, port);
    let sock = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    if ip.is_ipv6() {
        sock.set_only_v6(false)?; // dual stack: IPv4 clients arrive as ::ffff:a.b.c.d
    }
    sock.bind(&addr.into())?;
    sock.listen(128)?;
    sock.set_nonblocking(true)?;
    Ok(sock.into())
}

pub async fn start(opts: ServerOptions) -> io::Result<ServerHandle> {
    let std_listener = match bind(&opts.host, opts.port) {
        Ok(l) => l,
        Err(e) if opts.host == "::" && e.kind() != io::ErrorKind::AddrInUse => bind("0.0.0.0", opts.port).map_err(|_| e)?,
        Err(e) => return Err(e),
    };
    let listener = TcpListener::from_std(std_listener)?;
    let port = listener.local_addr()?.port();
    let (shutdown, shutdown_rx) = watch::channel(false);
    let shared = Arc::new(Shared { opts, state: Mutex::new(State::default()) });
    let task = tokio::spawn(accept_loop(shared, listener, shutdown_rx));
    Ok(ServerHandle { port, shutdown, task })
}

async fn accept_loop(shared: Arc<Shared>, listener: TcpListener, mut shutdown: watch::Receiver<bool>) {
    let mut conns = JoinSet::new();
    let mut tick = tokio::time::interval(BROADCAST_INTERVAL);
    let mut ticks: u64 = 0;
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tick.tick() => {
                ticks += 1;
                flush(&shared, ticks % 100 == 0);
            }
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let ip = peer.ip().to_canonical();
                {
                    let mut st = shared.state.lock().unwrap();
                    let per_ip = st.sockets_by_ip.get(&ip_key(ip)).copied().unwrap_or(0);
                    if st.sockets >= shared.opts.max_sockets || per_ip >= shared.opts.max_sockets_per_ip {
                        continue; // dropping the stream closes it
                    }
                    st.sockets += 1;
                    *st.sockets_by_ip.entry(ip_key(ip)).or_default() += 1;
                }
                let _ = stream.set_nodelay(true);
                conns.spawn(connection(shared.clone(), stream, ip, shutdown.clone()));
            }
        }
    }
    drop(listener); // free the port right away
    let drain = async { while conns.join_next().await.is_some() {} };
    if tokio::time::timeout(Duration::from_millis(700), drain).await.is_err() {
        conns.abort_all();
    }
}

fn flush(shared: &Shared, prune: bool) {
    let mut st = shared.state.lock().unwrap();
    for room in st.rooms.values_mut() {
        if room.dirty {
            room.dirty = false;
            let msg = json!({ "t": "state", "players": room.snapshot() });
            room.broadcast(&msg);
        }
    }
    if prune {
        st.rooms.retain(|_, r| r.emptied_at.is_none_or(|t| t.elapsed() < EMPTY_ROOM_TTL));
        st.hellos.retain(|_, q| {
            q.retain(|t| t.elapsed() < Duration::from_secs(60));
            !q.is_empty()
        });
    }
}

struct SocketGuard(Arc<Shared>, IpAddr);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(mut st) = self.0.state.lock() {
            st.sockets = st.sockets.saturating_sub(1);
            let key = ip_key(self.1);
            if let Some(n) = st.sockets_by_ip.get_mut(&key) {
                *n -= 1;
                if *n == 0 {
                    st.sockets_by_ip.remove(&key);
                }
            }
        }
    }
}

/// Aborts the writer task if the connection task itself is aborted (server shutdown).
struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

enum Flow {
    Continue,
    Close(u16, String),
}

async fn connection(shared: Arc<Shared>, stream: TcpStream, peer: IpAddr, mut shutdown: watch::Receiver<bool>) {
    let _guard = SocketGuard(shared.clone(), peer);
    let cfg = WebSocketConfig::default().max_message_size(Some(MAX_PAYLOAD)).max_frame_size(Some(MAX_PAYLOAD));
    let ws = match tokio::time::timeout(HELLO_TIMEOUT, tokio_tungstenite::accept_async_with_config(stream, Some(cfg))).await {
        Ok(Ok(ws)) => ws,
        _ => return,
    };
    let (mut sink, mut incoming) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(OUTBOX);
    let kill = Arc::new(Notify::new());
    let conn = {
        let mut st = shared.state.lock().unwrap();
        st.next_conn += 1;
        st.next_conn
    };
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let is_close = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || is_close {
                break;
            }
        }
    });
    let _writer_guard = AbortOnDrop(writer.abort_handle());

    let mut joined: Option<(String, String)> = None; // (room, player id)
    let hello_deadline = tokio::time::sleep(HELLO_TIMEOUT);
    tokio::pin!(hello_deadline);
    let mut ping = tokio::time::interval(HEARTBEAT);
    let mut last_seen = Instant::now();

    loop {
        tokio::select! {
            _ = &mut hello_deadline, if joined.is_none() => {
                let _ = tx.try_send(close_msg(4000, "握手超时"));
                break;
            }
            _ = shutdown.changed() => {
                let _ = tx.try_send(close_msg(1001, "房主关闭了房间"));
                break;
            }
            _ = kill.notified() => break,
            _ = ping.tick() => {
                if last_seen.elapsed() > DEAD_AFTER {
                    break;
                }
                let _ = tx.try_send(Message::Ping(Default::default()));
            }
            msg = incoming.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    last_seen = Instant::now();
                    let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    if !v.is_object() {
                        continue;
                    }
                    let flow = match &joined {
                        None if v["t"] == "hello" => match on_hello(&shared, conn, &tx, &kill, peer, &v) {
                            Ok(key) => { joined = Some(key); Flow::Continue }
                            Err(text) => {
                                let retry = text.starts_with(RETRYABLE);
                                let text = text.trim_start_matches(RETRYABLE);
                                let _ = tx.try_send(Message::text(json!({ "t": "error", "text": text, "retry": retry }).to_string()));
                                Flow::Close(4001, "rejected".into())
                            }
                        },
                        None => Flow::Continue,
                        Some((room, id)) => { on_message(&shared, conn, room, id, &v); Flow::Continue }
                    };
                    if let Flow::Close(code, reason) = flow {
                        let _ = tx.try_send(close_msg(code, &reason));
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => last_seen = Instant::now(),
            }
        }
    }

    if let Some((room, id)) = &joined {
        on_close(&shared, conn, room, id);
    }
    drop(tx);
    // Flush a pending close frame, then wait (briefly) for the peer's close reply before dropping
    // the socket. Dropping it earlier makes Windows reset the connection, and the peer may lose
    // the error message / close code we just sent.
    let _ = tokio::time::timeout(CLOSE_GRACE, async {
        let _ = writer.await;
        while let Some(Ok(m)) = incoming.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
}

fn on_hello(
    shared: &Shared,
    conn: u64,
    tx: &mpsc::Sender<Message>,
    kill: &Arc<Notify>,
    peer: IpAddr,
    msg: &Value,
) -> Result<(String, String), String> {
    let opts = &shared.opts;
    let mut st = shared.state.lock().unwrap();
    let now = Instant::now();

    if !peer.is_loopback() {
        let recent = st.hellos.entry(peer).or_default();
        recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        recent.push_back(now);
        if recent.len() > HELLOS_PER_IP_PER_MIN {
            return Err(format!("{RETRYABLE}连接太频繁，请稍后再试"));
        }
    }
    if msg["v"].as_u64() != Some(PROTOCOL_VERSION) {
        return Err("版本不一致，请和房主使用同一版本".into());
    }
    if !opts.password.is_empty() && msg["password"].as_str() != Some(opts.password.as_str()) {
        return Err("房间密码错误".into());
    }
    let id = msg["id"].as_str().filter(|s| valid_id(s)).ok_or("无效的玩家 ID")?.to_string();
    let secret = msg["secret"].as_str().filter(|s| (16..=128).contains(&s.len())).ok_or("缺少玩家密钥")?;
    let secret_hash: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
    let code = if opts.single_room { String::new() } else { clean_room(&msg["room"]) };

    match st.rooms.get(&code) {
        None if st.rooms.len() >= opts.max_rooms => return Err(format!("{RETRYABLE}服务器房间数已满，稍后再试")),
        Some(room) => {
            if let Some(k) = room.known.get(&id) {
                if k.secret_hash != secret_hash {
                    return Err("这个玩家 ID 已被别人使用".into());
                }
            }
            if !room.players.contains_key(&id) && room.players.len() >= MAX_PLAYERS {
                return Err(format!("房间已满（最多 {MAX_PLAYERS} 人）"));
            }
        }
        None => {}
    }

    st.next_seq += 1;
    let seq = st.next_seq;
    let room = st.rooms.entry(code.clone()).or_default();
    room.emptied_at = None;
    let replaced = room.players.remove(&id);
    if let Some(old) = &replaced {
        // Same player reconnecting (network blip / second copy) replaces the stale socket.
        let _ = old.tx.try_send(close_msg(4002, "在别处重新连接"));
        old.kill.notify_one();
    }

    let mut count = clamp_count(&msg["count"]);
    match room.known.get_mut(&id) {
        Some(k) => count = count.min(k.count + growth_allowance(k.at)),
        None => {
            room.known.insert(id.clone(), Known { secret_hash, count, at: now });
        }
    }
    let skin = clean_skin(&msg["skin"]);
    let p = Player {
        conn,
        seq: replaced.as_ref().map_or(seq, |o| o.seq),
        tx: tx.clone(),
        kill: kill.clone(),
        name: clean_name(&msg["name"]),
        character: msg["char"].as_str().filter(|c| CHARACTERS.contains(c)).unwrap_or(CHARACTERS[0]).to_string(),
        skin_rev: if skin.is_some() { 1 } else { 0 },
        skin,
        deco: clean_deco(&msg["deco"]),
        count,
        typing: false,
        inv: clean_inv(&msg["inv"]),
        throws: VecDeque::new(),
        budget: MAX_KEYS_PER_SECOND, // one second's worth to start with
        budget_at: now,
        skin_changed_at: None,
    };

    push(tx, kill, &json!({ "t": "welcome", "you": id, "max": MAX_PLAYERS }));
    // Everyone's custom skins to the newcomer, and the newcomer's to everyone.
    for (oid, other) in &room.players {
        if let Some(s) = &other.skin {
            push(tx, kill, &json!({ "t": "skin", "id": oid, "rev": other.skin_rev, "skin": s }));
        }
    }
    let name = p.name.clone();
    let skin_msg = p.skin.as_ref().map(|s| json!({ "t": "skin", "id": id, "rev": p.skin_rev, "skin": s }));
    room.players.insert(id.clone(), p);
    if let Some(m) = skin_msg {
        room.broadcast(&m);
    }
    if replaced.is_none() {
        room.broadcast(&json!({ "t": "log", "text": format!("{name} 加入了房间") }));
    }
    room.dirty = true;
    Ok((code, id))
}

fn on_message(shared: &Shared, conn: u64, code: &str, id: &str, msg: &Value) {
    let mut st = shared.state.lock().unwrap();
    let Some(room) = st.rooms.get_mut(code) else { return };
    if room.players.get(id).map(|p| p.conn) != Some(conn) {
        return; // replaced by a newer connection
    }
    match msg["t"].as_str() {
        Some("status") => {
            let p = room.players.get_mut(id).unwrap();
            let next = clamp_count(&msg["count"]);
            // The count may only grow as fast as a human types (spending lowers it freely):
            // a budget refills at typing speed and each increase spends from it.
            let now = Instant::now();
            p.budget = (p.budget + now.duration_since(p.budget_at).as_secs_f64() * MAX_KEYS_PER_SECOND).min(KEY_BURST);
            p.budget_at = now;
            let granted = next.saturating_sub(p.count).min(p.budget as u64);
            p.budget -= granted as f64;
            p.count = if next < p.count { next } else { p.count + granted };
            p.typing = msg["typing"].as_bool().unwrap_or(false);
            p.inv = clean_inv(&msg["inv"]);
            room.dirty = true;
        }
        Some("profile") => {
            let p = room.players.get_mut(id).unwrap();
            p.name = clean_name(&msg["name"]);
            if let Some(c) = msg["char"].as_str().filter(|c| CHARACTERS.contains(c)) {
                p.character = c.to_string();
            }
            if let Some(d) = msg.get("deco") {
                p.deco = clean_deco(d);
            }
            if let Some(s) = msg.get("skin") {
                let skin = clean_skin(s);
                let too_soon = p.skin_changed_at.is_some_and(|t| t.elapsed() < SKIN_CHANGE_EVERY);
                // Skins are up to ~800 KB and go to everyone: ignore repeats and rapid changes.
                if skin != p.skin && !too_soon {
                    p.skin = skin;
                    p.skin_rev += 1;
                    p.skin_changed_at = Some(Instant::now());
                    let m = json!({ "t": "skin", "id": id, "rev": p.skin_rev, "skin": p.skin });
                    room.broadcast(&m);
                }
            }
            room.dirty = true;
        }
        Some("throw") => {
            let item = msg["item"].as_str().and_then(|s| ITEM_IDS.iter().position(|i| *i == s));
            let target = msg["target"].as_str().unwrap_or("");
            let reply = |p: &Player, ok: bool, text: &str| {
                push(&p.tx, &p.kill, &json!({ "t": "throwResult", "seq": msg["seq"], "ok": ok, "item": msg["item"], "target": msg["target"], "text": text }));
            };
            let target_name = room.players.get(target).map(|t| t.name.clone());
            let p = room.players.get_mut(id).unwrap();
            // The wallet is client-owned; the throw carries the inventory it was made with, so a
            // status update still in flight (e.g. right after buying) can't cause a false "没有了".
            if msg.get("inv").is_some_and(Value::is_object) {
                p.inv = clean_inv(&msg["inv"]);
            }
            let Some(item) = item else { return reply(p, false, "未知道具") };
            let Some(target_name) = target_name else { return reply(p, false, "对方已离线") };
            if target == id {
                return reply(p, false, "不能扔自己");
            }
            if p.inv[item] < 1 {
                return reply(p, false, &format!("没有{}了", ITEM_NAMES[item]));
            }
            let now = Instant::now();
            while p.throws.front().is_some_and(|t| now.duration_since(*t) >= THROW_WINDOW) {
                p.throws.pop_front();
            }
            if p.throws.len() >= THROWS_PER_WINDOW {
                return reply(p, false, "扔太快啦，歇一下");
            }
            p.throws.push_back(now);
            p.inv[item] -= 1;
            reply(p, true, "");
            let hit = json!({ "t": "hit", "item": ITEM_IDS[item], "from": id, "fromName": p.name, "to": target, "toName": target_name });
            room.dirty = true;
            room.broadcast(&hit);
        }
        _ => {}
    }
}

fn on_close(shared: &Shared, conn: u64, code: &str, id: &str) {
    let mut st = shared.state.lock().unwrap();
    let Some(room) = st.rooms.get_mut(code) else { return };
    if room.players.get(id).map(|p| p.conn) != Some(conn) {
        return;
    }
    let p = room.players.remove(id).unwrap();
    if let Some(k) = room.known.get_mut(id) {
        k.count = p.count;
        k.at = Instant::now();
    }
    if room.players.is_empty() {
        room.emptied_at = Some(Instant::now());
        return;
    }
    room.dirty = true;
    room.broadcast(&json!({ "t": "log", "text": format!("{} 离开了房间", p.name) }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_input() {
        assert_eq!(clean_name(&json!("  a\u{0007}b  ")), "ab");
        assert_eq!(clean_name(&json!(null)), "无名氏");
        assert_eq!(clean_name(&json!("一二三四五六七八九十一二三四")).chars().count(), NAME_MAX);
        assert!(clean_skin(&json!({ "idle": "data:image/png;base64,AAAA", "typing": "data:image/gif;base64,AA==" })).is_some());
        assert!(clean_skin(&json!({ "idle": "file://x/y.png", "typing": "data:image/png;base64,AAAA" })).is_none());
        assert!(clean_skin(&json!({ "idle": "data:image/png;base64,<script>", "typing": "data:image/png;base64,AAAA" })).is_none());
        assert_eq!(clean_inv(&json!({ "tomato": 2.7, "ink": -3, "poop": "x" })), [2, 0, 0]);
        assert_eq!(clean_deco(&json!("party-red")), "party-red");
        assert_eq!(clean_deco(&json!("Bad Id")), "");
        assert_eq!(clean_deco(&json!(3)), "");
        assert!(valid_id("player-0001") && !valid_id("short") && !valid_id("bad id with spaces"));
    }
}
