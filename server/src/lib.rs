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

mod cards;
mod flight;
mod games;
mod mahjong;
mod monopoly;
mod tables;
mod xiangqi;

pub const PROTOCOL_VERSION: u64 = 2;
pub const DEFAULT_PORT: u16 = 23333;
pub const MAX_PLAYERS: usize = 16;
pub const ITEM_COUNT: usize = 6;
// v2.2 clients and relays only know the first three; they ignore the others.
pub const ITEM_IDS: [&str; ITEM_COUNT] = ["tomato", "ink", "poop", "rain", "firework", "umbrella"];
pub const ITEM_NAMES: [&str; ITEM_COUNT] = ["番茄", "墨鱼汁", "屎", "番茄雨", "烟花", "雨伞"];
pub const ITEM_KINDS: [ItemKind; ITEM_COUNT] =
    [ItemKind::Throw, ItemKind::Throw, ItemKind::Throw, ItemKind::Group, ItemKind::Party, ItemKind::Shield];
/// Index of the umbrella, the one `ItemKind::Shield` item.
pub const UMBRELLA: usize = 5;
// Built-in characters; art in ui/assets/characters/<id>/ (sliced by tools/slice-atlas.js).
pub const CHARACTERS: [&str; 6] = ["claude", "codex", "doubao", "gemini", "deepseek", "kimi"];
pub const NAME_MAX: usize = 12;
/// Worn cosmetic ids (art ships with the app; the server only checks the format).
pub const DECO_ID_MAX: usize = 32;
const WORN_MAX: usize = 4; // one per slot, with room for a future slot
pub const MAX_PAYLOAD: usize = 1024 * 1024; // custom skins travel as data URLs
pub const SKIN_IMAGE_MAX: usize = 400 * 1024; // per image data URL length

const ROOM_CODE_MAX: usize = 32;
const MAX_KEYS_PER_SECOND: f64 = 40.0;
const KEY_BURST: f64 = 200.0; // count growth budget: refills at MAX_KEYS_PER_SECOND, capped here
const SKIN_CHANGE_EVERY: Duration = Duration::from_secs(10);
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30 * 60);
const THROWS_PER_WINDOW: usize = 3;
const THROW_WINDOW: Duration = Duration::from_secs(1);
// Per player, so one person can't keep the whole room covered.
const GROUP_COOLDOWN: Duration = Duration::from_secs(60);
const PARTY_COOLDOWN: Duration = Duration::from_secs(10);
/// Boss HP per player in the fight (key presses), before the boss's own toughness.
pub const BOSS_HP_PER_PLAYER: u64 = 1500;
/// After a boss is beaten, the next one appears this much later.
pub const BOSS_COOLDOWN: Duration = Duration::from_secs(20 * 60);
/// Share of the boss's HP (%) a player must have dealt to get a chest when it's beaten.
pub const BOSS_MIN_SHARE: u64 = 3;
/// A kind of room boss. Clients know it by `id` (its exclusive cosmetics carry it); `toughness`
/// scales its HP, in %.
pub struct BossKind {
    pub id: &'static str,
    pub emoji: &'static str,
    pub name: &'static str,
    pub toughness: u64,
}

/// Fought in turn, getting tougher. v2.4 servers had only eight of these and sent no ids.
pub const BOSSES: [BossKind; 16] = [
    BossKind { id: "bug", emoji: "🐛", name: "Bug 虫", toughness: 80 },
    BossKind { id: "deadline", emoji: "⏰", name: "Deadline 怪", toughness: 100 },
    BossKind { id: "printer", emoji: "🖨️", name: "卡纸打印机", toughness: 90 },
    BossKind { id: "email", emoji: "📧", name: "邮件海怪", toughness: 100 },
    BossKind { id: "call", emoji: "📞", name: "夺命连环 Call", toughness: 100 },
    BossKind { id: "report", emoji: "📊", name: "周报巨魔", toughness: 110 },
    BossKind { id: "expense", emoji: "🧾", name: "报销单妖", toughness: 100 },
    BossKind { id: "meeting", emoji: "🤖", name: "会议机器人", toughness: 100 },
    BossKind { id: "ghost", emoji: "👻", name: "已读不回幽灵", toughness: 110 },
    BossKind { id: "pie", emoji: "🥧", name: "画饼大师", toughness: 110 },
    BossKind { id: "overtime", emoji: "🧟", name: "加班僵尸", toughness: 120 },
    BossKind { id: "legacy", emoji: "🦖", name: "祖传代码恐龙", toughness: 120 },
    BossKind { id: "change", emoji: "🐲", name: "需求变更龙", toughness: 130 },
    BossKind { id: "incident", emoji: "🔥", name: "线上事故", toughness: 140 },
    BossKind { id: "glare", emoji: "👔", name: "老板的凝视", toughness: 150 },
    BossKind { id: "demon", emoji: "👹", name: "996 魔王", toughness: 160 },
];
const BROADCAST_INTERVAL: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(10);
const DEAD_AFTER: Duration = Duration::from_secs(25);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const HELLOS_PER_IP_PER_MIN: usize = 20;
const OUTBOX: usize = 64; // queued messages per client before it's considered stuck
const CLOSE_GRACE: Duration = Duration::from_secs(1);
/// Error replies the client should retry later instead of giving up.
const RETRYABLE: &str = "retry";

/// How an item is used.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    /// Thrown at one player.
    Throw,
    /// Hits everyone else in the room.
    Group,
    /// A show for the whole room, the sender included; not an attack.
    Party,
    /// Never thrown: blocks the next attack on whoever holds one, and is used up doing so.
    Shield,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Throw => "throw",
            ItemKind::Group => "group",
            ItemKind::Party => "party",
            ItemKind::Shield => "shield",
        }
    }

    fn cooldown(self) -> Duration {
        match self {
            ItemKind::Group => GROUP_COOLDOWN,
            ItemKind::Party => PARTY_COOLDOWN,
            ItemKind::Throw | ItemKind::Shield => Duration::ZERO,
        }
    }
}

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
    pub boss_hp: u64,
    pub boss_cooldown: Duration,
}

impl ServerOptions {
    pub fn host_mode(port: u16, password: String) -> Self {
        Self {
            host: "::".into(), port, password, single_room: true, max_rooms: 1, max_sockets: MAX_PLAYERS * 4, max_sockets_per_ip: MAX_PLAYERS * 4,
            boss_hp: BOSS_HP_PER_PLAYER, boss_cooldown: BOSS_COOLDOWN,
        }
    }
    pub fn relay(port: u16, password: String) -> Self {
        Self {
            host: "::".into(), port, password, single_room: false, max_rooms: 500, max_sockets: 4000, max_sockets_per_ip: MAX_PLAYERS * 2,
            boss_hp: BOSS_HP_PER_PLAYER, boss_cooldown: BOSS_COOLDOWN,
        }
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
    game_offset: i64,
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
    decos: Vec<String>,
    /// Whether their cosmetics chest can be opened right now (shown to the room; the timer stays private).
    chest: bool,
    /// 免打扰: hits don't cover their screen (shown to the room).
    dnd: bool,
    count: u64,
    typing: bool,
    inv: [u64; ITEM_COUNT],
    /// Umbrellas used up blocking attacks on this connection. Clients report how many blocks
    /// they've heard about, so an inventory sent before hearing of one doesn't bring it back.
    blocked: u64,
    throws: VecDeque<Instant>,
    used_at: [Option<Instant>; ITEM_COUNT],
    budget: f64,
    budget_at: Instant,
    skin_changed_at: Option<Instant>,
}

impl Player {
    /// Takes the inventory a client sent (`inv` + `blocks`) with a status or a throw.
    fn set_inv(&mut self, msg: &Value) {
        self.inv = clean_inv(&msg["inv"]);
        let unheard = self.blocked.saturating_sub(clamp_num(&msg["blocks"], 1e9));
        self.inv[UMBRELLA] = self.inv[UMBRELLA].saturating_sub(unheard);
    }
}

/// The room's shared boss: everyone's typing hurts it. Beaten, the next one appears after a
/// cooldown (once someone's in the room).
#[derive(Default)]
struct Boss {
    /// Bosses this room has beaten; picks the current / next one from BOSSES.
    beaten: u64,
    hp: u64,
    max_hp: u64,
    /// Players its HP is made for: the most that have been in the room at once during this
    /// fight. Coming and going (under any id) never raises it; MAX_PLAYERS caps it.
    shares: u64,
    /// While none is up: when the next one may appear (`None`: right away).
    next_at: Option<Instant>,
    /// Damage dealt to the current one, per player id. Kept after a win for the last fight's ranking.
    damage: HashMap<String, u64>,
}

impl Boss {
    fn kind(&self) -> &'static BossKind {
        &BOSSES[(self.beaten % BOSSES.len() as u64) as usize]
    }

    /// HP for each player in the fight.
    fn share(&self, hp_per_player: u64) -> u64 {
        (hp_per_player.saturating_mul(self.kind().toughness) / 100).max(1)
    }

    fn spawn(&mut self, players: usize, hp_per_player: u64) {
        self.shares = players as u64;
        self.max_hp = self.share(hp_per_player).saturating_mul(self.shares);
        self.hp = self.max_hp;
        self.next_at = None;
        self.damage.clear();
    }

    /// Someone joined and the room now has `players`: a new high adds a share for each extra
    /// head, so the fight takes about the same typing per person.
    fn crowd(&mut self, players: usize, hp_per_player: u64) {
        let players = players as u64;
        if self.hp > 0 && players > self.shares {
            let more = self.share(hp_per_player).saturating_mul(players - self.shares);
            self.shares = players;
            self.max_hp = self.max_hp.saturating_add(more);
            self.hp = self.hp.saturating_add(more);
        }
    }

    fn json(&self, now: Instant) -> Value {
        let k = self.kind();
        // "in": ms until the next one appears; while none is up, id / emoji / name / level are the next one's.
        let wait = if self.hp > 0 { 0 } else { self.next_at.map_or(0, |t| t.saturating_duration_since(now).as_millis() as u64) };
        json!({
            "id": k.id, "emoji": k.emoji, "name": k.name, "level": self.beaten + 1,
            "hp": self.hp, "max": self.max_hp, "in": wait, "minPct": BOSS_MIN_SHARE,
        })
    }
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
    boss: Boss,
    games: games::Games,
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
    fn game_snapshots(&self) {
        for (id,p) in &self.players { push(&p.tx,&p.kill,&self.games.snapshot(id)); }
    }

    fn game_tick(&mut self) {
        let before: Vec<(String,i64)> = self.players.keys().map(|id|(id.clone(),self.games.offset(id))).collect();
        let revision=self.games.revision;
        let players=&self.players;
        self.games.tick(&|id| players.contains_key(id));
        if self.games.revision!=revision {
            for (id,offset) in before { if let Some(p)=self.players.get_mut(&id) {p.count=adjust_game_count(p.count,self.games.offset(&id)-offset);} }
            self.game_snapshots();self.dirty=true;
        }
    }
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
                        "skinRev": if p.skin.is_some() { p.skin_rev } else { 0 }, "deco": p.decos.first().map_or("", |d| d.as_str()), "decos": p.decos, "chest": p.chest,
                        "dnd": p.dnd, "count": p.count, "typing": p.typing, "inv": inv_json(&p.inv),
                        "dmg": self.boss.damage.get(id.as_str()).copied().unwrap_or(0),
                    })
                })
                .collect(),
        )
    }

    fn spawn_boss_if_due(&mut self, hp_per_player: u64, now: Instant) {
        if self.boss.hp > 0 || self.players.is_empty() || self.boss.next_at.is_some_and(|t| now < t) {
            return;
        }
        self.boss.spawn(self.players.len(), hp_per_player);
        self.dirty = true;
    }

    /// Typing hurts the boss. Returns the "bossDown" message when this finishes it off.
    fn hit_boss(&mut self, id: &str, keys: u64, cooldown: Duration, now: Instant) -> Option<Value> {
        let b = &mut self.boss;
        if keys == 0 || b.hp == 0 {
            return None;
        }
        let dealt = keys.min(b.hp);
        b.hp -= dealt;
        *b.damage.entry(id.to_string()).or_default() += dealt;
        if b.hp > 0 {
            return None;
        }
        let k = b.kind();
        b.beaten += 1;
        b.next_at = Some(now + cooldown);
        let killer_name = self.players.get(id).map_or("", |p| p.name.as_str());
        // A chest for everyone here who dealt at least BOSS_MIN_SHARE % of its HP. Clients roll
        // it themselves (the last hit's is luckier, and drops one of the boss's own cosmetics).
        let damage: Map<String, Value> = self.players.keys().map(|p| (p.clone(), b.damage.get(p).copied().unwrap_or(0).into())).collect();
        let earned = |d: u64| d.saturating_mul(100) >= b.max_hp.saturating_mul(BOSS_MIN_SHARE);
        let rewarded: Vec<&String> = damage.iter().filter(|(_, d)| earned(d.as_u64().unwrap_or(0))).map(|(p, _)| p).collect();
        Some(json!({
            "t": "bossDown", "id": k.id, "emoji": k.emoji, "name": k.name, "killer": id, "killerName": killer_name,
            "rewarded": rewarded, "damage": damage, "total": b.max_hp, "minPct": BOSS_MIN_SHARE,
        }))
    }
}

fn inv_json(inv: &[u64; ITEM_COUNT]) -> Value {
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

/// Worn cosmetics from `decos` (a list), or v2.1's single `deco`.
fn clean_worn(msg: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let listed: Vec<&Value> = match msg["decos"].as_array() {
        Some(list) => list.iter().collect(),
        None => vec![&msg["deco"]],
    };
    for d in listed.into_iter().map(clean_deco).filter(|d| !d.is_empty()) {
        if out.len() < WORN_MAX && !out.contains(&d) {
            out.push(d);
        }
    }
    out
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

pub fn clean_inv(v: &Value) -> [u64; ITEM_COUNT] {
    let mut out = [0; ITEM_COUNT];
    for (i, id) in ITEM_IDS.iter().enumerate() {
        out[i] = clamp_num(v.get(*id).unwrap_or(&Value::Null), 99_999.0);
    }
    out
}

fn clamp_count(v: &Value) -> u64 {
    clamp_num(v, 1e9)
}

fn adjust_game_count(count:u64,delta:i64)->u64 { (count as i128+delta as i128).clamp(0,1_000_000_000) as u64 }

fn reported_game_count(games:&games::Games,id:&str,msg:&Value)->u64 {
    let count=clamp_count(&msg["count"]);
    if msg["gameEpoch"].as_str()==Some(&games.epoch) {
        adjust_game_count(count,games.offset(id).saturating_sub(msg["gameOffset"].as_i64().unwrap_or(0)))
    } else {count}
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
    let now = Instant::now();
    let mut st = shared.state.lock().unwrap();
    for room in st.rooms.values_mut() {
        room.game_tick();
        room.spawn_boss_if_due(shared.opts.boss_hp, now);
        if room.dirty {
            room.dirty = false;
            let msg = json!({ "t": "state", "players": room.snapshot(), "boss": room.boss.json(now) });
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

    let mut count = reported_game_count(&room.games,&id,msg);
    if msg["gameEpoch"].as_str()!=Some(&room.games.epoch) {
        count=count.saturating_add(msg["gameReserve"].as_u64().unwrap_or(0).min(games::ENTRY));
    }
    match room.known.get_mut(&id) {
        Some(k) => count = count.min(adjust_game_count(k.count,room.games.offset(&id).saturating_sub(k.game_offset)).saturating_add(growth_allowance(k.at))),
        None => {
            room.known.insert(id.clone(), Known { secret_hash, count, at: now, game_offset:room.games.offset(&id) });
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
        decos: clean_worn(msg),
        chest: false,
        dnd: false,
        count,
        typing: false,
        inv: clean_inv(&msg["inv"]),
        blocked: 0,
        throws: VecDeque::new(),
        used_at: [None; ITEM_COUNT],
        budget: MAX_KEYS_PER_SECOND, // one second's worth to start with
        budget_at: now,
        skin_changed_at: None,
    };

    // "items": what this server supports (v2.2 servers don't send it).
    push(tx, kill, &json!({ "t": "welcome", "you": id, "max": MAX_PLAYERS, "items": ITEM_IDS, "games":true,"gameEpoch":room.games.epoch }));
    // Everyone's custom skins to the newcomer, and the newcomer's to everyone.
    for (oid, other) in &room.players {
        if let Some(s) = &other.skin {
            push(tx, kill, &json!({ "t": "skin", "id": oid, "rev": other.skin_rev, "skin": s }));
        }
    }
    let name = p.name.clone();
    let skin_msg = p.skin.as_ref().map(|s| json!({ "t": "skin", "id": id, "rev": p.skin_rev, "skin": s }));
    room.players.insert(id.clone(), p);
    push(tx,kill,&room.games.snapshot(&id));
    room.boss.crowd(room.players.len(), opts.boss_hp);
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
        Some("game") if msg["op"] == "mark" => {
            let p = &room.players[id];
            match room.games.mark(id, &p.name.clone(), msg) {
                Ok(Some(mark)) => room.broadcast(&mark),
                Ok(None) => {}
                Err(text) => push(&p.tx, &p.kill, &json!({"t":"gameError","text":text})),
            }
        }
        Some("game") => {
            let before:Vec<(String,i64)>=room.players.keys().map(|id|(id.clone(),room.games.offset(id))).collect();
            let p=&room.players[id];
            let balance=if msg["op"]=="join" { p.count.min(reported_game_count(&room.games,id,msg)) } else {p.count};
            let result=room.games.command(id,&p.name,msg,balance);
            for (pid,offset) in before {if let Some(p)=room.players.get_mut(&pid){p.count=adjust_game_count(p.count,room.games.offset(&pid)-offset);}}
            if let Err(text)=result {let p=&room.players[id];push(&p.tx,&p.kill,&json!({"t":"gameError","text":text,"ticket":msg["ticket"]}));}
            room.game_snapshots();room.dirty=true;
        }
        Some("status") => {
            let next = reported_game_count(&room.games,id,msg);
            let p = room.players.get_mut(id).unwrap();
            // The count may only grow as fast as a human types (spending lowers it freely):
            // a budget refills at typing speed and each increase spends from it.
            let now = Instant::now();
            p.budget = (p.budget + now.duration_since(p.budget_at).as_secs_f64() * MAX_KEYS_PER_SECOND).min(KEY_BURST);
            p.budget_at = now;
            let granted = next.saturating_sub(p.count).min(p.budget as u64);
            p.budget -= granted as f64;
            p.count = if next < p.count { next } else { p.count + granted };
            p.typing = msg["typing"].as_bool().unwrap_or(false);
            p.chest = msg["chest"].as_bool().unwrap_or(false);
            p.dnd = msg["dnd"].as_bool().unwrap_or(false);
            p.set_inv(msg);
            room.dirty = true;
            // The key presses just counted hit the room's boss.
            if let Some(down) = room.hit_boss(id, granted, shared.opts.boss_cooldown, now) {
                room.broadcast(&down);
            }
        }
        Some("profile") => {
            let p = room.players.get_mut(id).unwrap();
            p.name = clean_name(&msg["name"]);
            if let Some(c) = msg["char"].as_str().filter(|c| CHARACTERS.contains(c)) {
                p.character = c.to_string();
            }
            if msg.get("decos").is_some() || msg.get("deco").is_some() {
                p.decos = clean_worn(msg);
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
            let alone = room.players.len() < 2;
            let p = room.players.get_mut(id).unwrap();
            // The wallet is client-owned; the throw carries the inventory it was made with, so a
            // status update still in flight (e.g. right after buying) can't cause a false "没有了".
            if msg.get("inv").is_some_and(Value::is_object) {
                p.set_inv(msg);
            }
            let Some(item) = item else { return reply(p, false, "未知道具") };
            let kind = ITEM_KINDS[item];
            match kind {
                ItemKind::Shield => return reply(p, false, "雨伞不用扔，有存货就会自动挡"),
                ItemKind::Throw if target_name.is_none() => return reply(p, false, "对方已离线"),
                ItemKind::Throw if target == id => return reply(p, false, "不能扔自己"),
                ItemKind::Group if alone => return reply(p, false, "房间里没有别人"),
                _ => {}
            }
            if p.inv[item] < 1 {
                return reply(p, false, &format!("没有{}了", ITEM_NAMES[item]));
            }
            let now = Instant::now();
            let wait = p.used_at[item].map_or(Duration::ZERO, |t| kind.cooldown().saturating_sub(now.duration_since(t)));
            if !wait.is_zero() {
                return reply(p, false, &format!("{}还要等 {} 秒", ITEM_NAMES[item], wait.as_secs_f64().ceil()));
            }
            while p.throws.front().is_some_and(|t| now.duration_since(*t) >= THROW_WINDOW) {
                p.throws.pop_front();
            }
            if p.throws.len() >= THROWS_PER_WINDOW {
                return reply(p, false, "扔太快啦，歇一下");
            }
            p.throws.push_back(now);
            p.used_at[item] = Some(now);
            p.inv[item] -= 1;
            reply(p, true, "");
            let from_name = p.name.clone();
            let attacked: Vec<String> = match kind {
                ItemKind::Throw => vec![target.to_string()],
                ItemKind::Group => room.players.keys().filter(|k| k.as_str() != id).cloned().collect(),
                ItemKind::Party | ItemKind::Shield => Vec::new(),
            };
            // Whoever holds an umbrella blocks the attack and uses one up.
            let (mut targets, mut blocked) = (Vec::new(), Vec::new());
            for t in attacked {
                let Some(tp) = room.players.get_mut(&t) else { continue };
                if tp.inv[UMBRELLA] > 0 {
                    tp.inv[UMBRELLA] -= 1;
                    tp.blocked += 1;
                    blocked.push(t);
                } else {
                    targets.push(t);
                }
            }
            let single = kind == ItemKind::Throw;
            let hit = json!({
                "t": "hit", "item": ITEM_IDS[item], "from": id, "fromName": from_name,
                // A single throw's target, which is all v2.2 clients read.
                "to": if single { target } else { "" }, "toName": target_name.filter(|_| single).unwrap_or_default(),
                "targets": targets, "blocked": blocked,
            });
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
        k.game_offset = room.games.offset(id);
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
        assert_eq!(clean_inv(&json!({ "tomato": 2.7, "ink": -3, "poop": "x", "umbrella": 1 })), [2, 0, 0, 0, 0, 1]);
        assert_eq!((ITEM_IDS[UMBRELLA], ITEM_KINDS[UMBRELLA]), ("umbrella", ItemKind::Shield));
        assert_eq!(clean_deco(&json!("party-red")), "party-red");
        assert_eq!(clean_deco(&json!("Bad Id")), "");
        assert_eq!(clean_deco(&json!(3)), "");
        assert_eq!(clean_worn(&json!({ "decos": ["a", "b", "a", "Bad", "c", "d", "e"] })), ["a", "b", "c", "d"]);
        assert_eq!(clean_worn(&json!({ "deco": "party-red" })), ["party-red"]);
        assert!(clean_worn(&json!({ "deco": "" })).is_empty());
        assert!(valid_id("player-0001") && !valid_id("short") && !valid_id("bad id with spaces"));
    }

    #[test]
    fn boss_hp_follows_the_most_players_at_once() {
        let mut b = Boss::default();
        b.spawn(2, 100); // Bug 虫 is 80% tough
        assert_eq!((b.hp, b.max_hp), (160, 160));
        // Someone leaves and comes back (or someone new takes their place): no more HP.
        for players in [1, 2, 1, 2, 2] {
            b.crowd(players, 100);
        }
        assert_eq!((b.hp, b.max_hp), (160, 160));
        b.hp = 100;
        b.crowd(4, 100); // a new high: two more shares
        assert_eq!((b.hp, b.max_hp, b.shares), (260, 320, 4));
        b.hp = 0; // beaten: joining doesn't revive it
        b.crowd(5, 100);
        assert_eq!((b.hp, b.max_hp), (0, 320));
    }

    #[test]
    fn bosses_have_unique_ids_and_the_v2_4_ones_keep_their_names() {
        let ids: std::collections::HashSet<&str> = BOSSES.iter().map(|k| k.id).collect();
        assert_eq!(ids.len(), BOSSES.len());
        assert!(BOSSES.iter().all(|k| !k.id.is_empty() && k.id.bytes().all(|c| c.is_ascii_lowercase()) && k.toughness > 0));
        // Clients map v2.4 servers' boss names (sent without ids) to these.
        for name in ["Bug 虫", "Deadline 怪", "邮件海怪", "周报巨魔", "会议机器人", "加班僵尸", "需求变更龙", "老板的凝视"] {
            assert!(BOSSES.iter().any(|k| k.name == name), "{name}");
        }
    }
}
