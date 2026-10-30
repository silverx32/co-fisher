//! Steamworks integration (AppID 480 Spacewar by default, or `steam_appid.txt` / `STEAM_APP_ID`).
//!
//! Bridges Steam Networking Sockets P2P (`ISteamNetworkingSockets` over Valve's SDR relay network)
//! and Steam Matchmaking Lobbies (`ISteamMatchmaking`) to the local WebSocket room server / client,
//! so Steam friends and LAN/IPv6 friends share the exact same room and protocol.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cofisher_server::{MAX_PLAYERS, NAME_MAX};
use serde_json::{json, Value};
use steamworks::networking_sockets::{InvalidHandle, ListenSocket, NetConnection};
use steamworks::networking_types::{
    ListenSocketEvent, NetworkingConfigEntry, NetworkingConfigValue, NetworkingConnectionState,
    NetworkingIdentity, SendFlags,
};
use steamworks::{
    AccountType, AppId, CallbackHandle, Client, DistanceFilter, FriendFlags,
    GameLobbyJoinRequested, GameRichPresenceJoinRequested, LobbyId, LobbyKey, LobbyListFilter,
    LobbyType, SteamError, SteamId, StringFilter, StringFilterKind,
};
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;

pub const DEFAULT_APP_ID: u32 = 480; // Spacewar (Valve's official Steamworks SDK test AppID)
const LOBBY_TAG_KEY: &str = "cofisher";
const LOBBY_TAG_VAL: &str = "1";
const P2P_VIRTUAL_PORT: i32 = 0;
const P2P_CHUNK: usize = 32 * 1024;
const SEND_BUF_SIZE: i32 = 2 * 1024 * 1024; // 2 MB so 800 KB custom skins never stall

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SteamTarget {
    Host(SteamId),
    Lobby(LobbyId),
}

/// Parses a Steam room address typed/pasted by a user or received from a Steam invite:
/// - `steam:76561198xxxxxxxxx` or `steam://76561198xxxxxxxxx`
/// - `lobby:10977524xxxxxxxxx` or `steam://joinlobby/480/10977524xxxxxxxxx/...`
/// - Bare 17-digit 64-bit SteamID / LobbyID
pub fn parse_target(input: &str) -> Option<SteamTarget> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("steam://joinlobby/") {
        let mut parts = rest.split('/').filter(|p| !p.is_empty());
        let _app = parts.next()?;
        let lobby_raw: u64 = parts.next()?.parse().ok()?;
        return (lobby_raw > 0).then(|| SteamTarget::Lobby(LobbyId::from_raw(lobby_raw)));
    }
    if let Some(rest) = lower.strip_prefix("lobby://").or_else(|| lower.strip_prefix("lobby:")) {
        let id: u64 = rest.trim().parse().ok()?;
        return (id > 0).then(|| SteamTarget::Lobby(LobbyId::from_raw(id)));
    }
    if let Some(rest) = lower.strip_prefix("steam://").or_else(|| lower.strip_prefix("steam:")) {
        let id: u64 = rest.trim().trim_end_matches('/').parse().ok()?;
        return classify_raw_id(id);
    }
    // Bare 17-digit SteamID64 / LobbyID64 (IPv4 has dots, IPv6 has colons).
    if (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) {
        let id: u64 = s.parse().ok()?;
        return classify_raw_id(id);
    }
    None
}

fn classify_raw_id(id: u64) -> Option<SteamTarget> {
    if id == 0 {
        return None;
    }
    let sid = SteamId::from_raw(id);
    match sid.account_type() {
        AccountType::Chat => Some(SteamTarget::Lobby(LobbyId::from_raw(id))),
        AccountType::Individual => Some(SteamTarget::Host(sid)),
        _ => None,
    }
}

/// Extracts `+connect_lobby <id>` or `+connect <str>` from command-line arguments.
pub fn connect_arg(args: &[String]) -> Option<String> {
    let mut it = args.iter().map(|s| s.trim());
    while let Some(a) = it.next() {
        if a.eq_ignore_ascii_case("+connect_lobby") {
            if let Some(id) = it.next().filter(|s| !s.is_empty()) {
                return Some(format!("lobby:{id}"));
            }
        } else if a.eq_ignore_ascii_case("+connect") {
            if let Some(target) = it.next().filter(|s| !s.is_empty()) {
                return Some(target.to_string());
            }
        } else if parse_target(a).is_some() && a.to_ascii_lowercase().starts_with("steam://") {
            return Some(a.to_string());
        }
    }
    None
}

fn configured_app_id() -> u32 {
    if let Ok(s) = std::env::var("STEAM_APP_ID") {
        if let Ok(id) = s.trim().parse::<u32>() {
            if id > 0 {
                return id;
            }
        }
    }
    if let Some(path) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("steam_appid.txt"))) {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(id) = s.trim().parse::<u32>() {
                if id > 0 {
                    return id;
                }
            }
        }
    }
    DEFAULT_APP_ID
}

fn p2p_opts() -> [NetworkingConfigEntry; 1] {
    [NetworkingConfigEntry::new_int32(NetworkingConfigValue::SendBufferSize, SEND_BUF_SIZE)]
}

struct Inner {
    app_id: u32,
    client: Option<Client>,
    init_error: String,
    _callbacks: Vec<CallbackHandle>,
    generation: u64,
    active_lobby: Option<LobbyId>,
    host_name: String,
    has_pwd: bool,
    player_count: usize,
    cancel: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct Steam {
    inner: Arc<Mutex<Inner>>,
    invite_tx: mpsc::UnboundedSender<String>,
}

impl Steam {
    pub fn new(invite_tx: mpsc::UnboundedSender<String>) -> Self {
        let s = Self {
            inner: Arc::new(Mutex::new(Inner {
                app_id: configured_app_id(),
                client: None,
                init_error: String::new(),
                _callbacks: Vec::new(),
                generation: 0,
                active_lobby: None,
                host_name: String::new(),
                has_pwd: false,
                player_count: 1,
                cancel: None,
                task: None,
            })),
            invite_tx,
        };
        let _ = s.try_init();
        let args: Vec<String> = std::env::args().collect();
        if let Some(target) = connect_arg(&args) {
            let _ = s.invite_tx.send(target);
        }
        s
    }

    /// Initializes the Steamworks client if not already initialized. Can be called again if the
    /// user started Steam after launching Co-Fisher.
    pub fn try_init(&self) -> Option<Client> {
        let mut i = self.inner.lock().unwrap();
        if let Some(c) = &i.client {
            return Some(c.clone());
        }
        let app_id = i.app_id;
        match Client::init_app(app_id) {
            Ok(client) => {
                client.networking_utils().init_relay_network_access();
                let _ = client.networking_sockets().init_authentication();

                let tx1 = self.invite_tx.clone();
                let cb1 = client.register_callback(move |ev: GameLobbyJoinRequested| {
                    if !ev.friend_steam_id.is_invalid() && ev.friend_steam_id.raw() != 0 {
                        let _ = tx1.send(format!("steam:{}", ev.friend_steam_id.raw()));
                    } else if ev.lobby_steam_id.raw() != 0 {
                        let _ = tx1.send(format!("lobby:{}", ev.lobby_steam_id.raw()));
                    }
                });

                let tx2 = self.invite_tx.clone();
                let cb2 = client.register_callback(move |ev: GameRichPresenceJoinRequested| {
                    if parse_target(&ev.connect).is_some() {
                        let _ = tx2.send(ev.connect);
                    } else if !ev.friend_steam_id.is_invalid() && ev.friend_steam_id.raw() != 0 {
                        let _ = tx2.send(format!("steam:{}", ev.friend_steam_id.raw()));
                    }
                });

                let launch_cmd = client.apps().launch_command_line();
                if !launch_cmd.is_empty() {
                    let parts: Vec<String> = launch_cmd.split_whitespace().map(str::to_string).collect();
                    if let Some(target) = connect_arg(&parts) {
                        let _ = self.invite_tx.send(target);
                    }
                }

                i._callbacks = vec![cb1, cb2];
                i.init_error.clear();
                i.client = Some(client.clone());
                Some(client)
            }
            Err(_) => {
                i.init_error = "未检测到 Steam（请先打开并登录 Steam 客户端）".into();
                None
            }
        }
    }

    pub fn tick(&self) {
        let client = self.inner.lock().unwrap().client.clone();
        if let Some(c) = client {
            c.run_callbacks();
        }
    }

    pub fn status(&self, retry: bool) -> Value {
        if retry {
            let _ = self.try_init();
        }
        let i = self.inner.lock().unwrap();
        match &i.client {
            Some(c) => {
                let id = c.user().steam_id().raw().to_string();
                let name = c.friends().name();
                let lobby = i.active_lobby.map(|l| l.raw().to_string());
                json!({
                    "available": true,
                    "appId": i.app_id,
                    "steamId": id,
                    "name": name,
                    "address": format!("steam:{id}"),
                    "lobbyId": lobby,
                })
            }
            None => json!({
                "available": false,
                "appId": i.app_id,
                "error": if i.init_error.is_empty() { "未检测到 Steam" } else { &i.init_error },
            }),
        }
    }

    pub fn update_lobby_meta(&self, host_name: Option<&str>, player_count: Option<usize>) {
        let mut i = self.inner.lock().unwrap();
        if let Some(n) = host_name {
            i.host_name = n.chars().take(NAME_MAX).collect();
        }
        if let Some(c) = player_count {
            i.player_count = c.max(1);
        }
        if let (Some(client), Some(lobby)) = (&i.client, i.active_lobby) {
            let mm = client.matchmaking();
            if !i.host_name.is_empty() {
                mm.set_lobby_data(lobby, "host_name", &i.host_name);
            }
            mm.set_lobby_data(lobby, "players", &i.player_count.to_string());
        }
    }

    pub async fn stop(&self) {
        let (cancel, task) = {
            let mut i = self.inner.lock().unwrap();
            i.generation += 1;
            let lobby = i.active_lobby.take();
            if let Some(client) = &i.client {
                if let Some(l) = lobby {
                    client.matchmaking().leave_lobby(l);
                }
                client.friends().clear_rich_presence();
            }
            (i.cancel.take(), i.task.take())
        };
        if let Some(c) = cancel {
            let _ = c.send(true);
        }
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_millis(800), t).await;
        }
    }

    /// Starts accepting Steam P2P connections and creates a Steam Lobby for the local host room.
    pub async fn start_host(&self, local_port: u16, host_name: &str, has_pwd: bool) {
        self.stop().await;
        let Some(client) = self.try_init() else { return };
        let Ok(listen_socket) = client.networking_sockets().create_listen_socket_p2p(P2P_VIRTUAL_PORT, p2p_opts()) else {
            return;
        };

        let my_id = client.user().steam_id().raw().to_string();
        let connect_str = format!("steam:{my_id}");
        client.friends().set_rich_presence("connect", Some(&connect_str));
        client.friends().set_rich_presence("status", Some("在摸鱼搭子房间里"));

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let generation = {
            let mut i = self.inner.lock().unwrap();
            i.generation += 1;
            i.host_name = host_name.chars().take(NAME_MAX).collect();
            i.has_pwd = has_pwd;
            i.player_count = 1;
            i.cancel = Some(cancel_tx);
            i.generation
        };

        // Create a public lobby tagged with `cofisher = "1"` so friends and room search find us.
        let inner_for_lobby = self.inner.clone();
        let client_for_lobby = client.clone();
        client.matchmaking().create_lobby(LobbyType::Public, MAX_PLAYERS as u32, move |res| {
            let Ok(lobby) = res else { return };
            let mut i = inner_for_lobby.lock().unwrap();
            if i.generation != generation {
                client_for_lobby.matchmaking().leave_lobby(lobby);
                return;
            }
            i.active_lobby = Some(lobby);
            let mm = client_for_lobby.matchmaking();
            let my_id = client_for_lobby.user().steam_id().raw().to_string();
            mm.set_lobby_data(lobby, LOBBY_TAG_KEY, LOBBY_TAG_VAL);
            mm.set_lobby_data(lobby, "host_id", &my_id);
            mm.set_lobby_data(lobby, "host_name", &i.host_name);
            mm.set_lobby_data(lobby, "has_pwd", if i.has_pwd { "1" } else { "0" });
            mm.set_lobby_data(lobby, "players", &i.player_count.to_string());
        });

        let task = tauri::async_runtime::spawn(host_loop(listen_socket, local_port, cancel_rx));
        let mut i = self.inner.lock().unwrap();
        if i.generation == generation {
            i.task = Some(task);
        }
    }

    /// Starts a local loopback TCP listener that tunnels each connection over Steam P2P to the target host.
    /// Returns `(local_port, canonical_steam_address)`.
    pub async fn start_join(&self, target: SteamTarget) -> Result<(u16, String), String> {
        self.stop().await;
        let client = self.try_init().ok_or_else(|| "未检测到 Steam，请先打开并登录 Steam 客户端".to_string())?;
        let host_id = match target {
            SteamTarget::Host(id) => id,
            SteamTarget::Lobby(lobby) => resolve_lobby_host(&client, lobby).await?,
        };
        if host_id.is_invalid() || host_id.raw() == 0 {
            return Err("无效的 Steam 房间地址".into());
        }
        if host_id == client.user().steam_id() {
            return Err("这是你自己的 Steam 地址，想当房主请点上面「创建房间」".into());
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let addr_label = format!("steam:{}", host_id.raw());

        client.friends().set_rich_presence("connect", Some(&addr_label));
        client.friends().set_rich_presence("status", Some("在摸鱼搭子房间里"));

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task = tauri::async_runtime::spawn(join_loop(client, host_id, listener, cancel_rx));
        {
            let mut i = self.inner.lock().unwrap();
            i.generation += 1;
            if let SteamTarget::Lobby(l) = target {
                i.active_lobby = Some(l);
            }
            i.cancel = Some(cancel_tx);
            i.task = Some(task);
        }
        Ok((local_port, addr_label))
    }

    /// Queries joinable Co-Fisher rooms from both Steam Friends and Steam Matchmaking Lobbies.
    pub async fn list_rooms(&self) -> Vec<Value> {
        let Some(client) = self.try_init() else { return Vec::new() };
        let app_id = self.inner.lock().unwrap().app_id;
        let my_id = client.user().steam_id();

        let mut friend_ids = HashSet::new();
        let mut friend_rooms: Vec<(SteamId, String, Option<LobbyId>)> = Vec::new();
        for f in client.friends().get_friends(FriendFlags::IMMEDIATE) {
            let fid = f.id();
            if fid == my_id || fid.is_invalid() {
                continue;
            }
            friend_ids.insert(fid);
            if let Some(fg) = f.game_played() {
                if fg.game.app_id() == AppId(app_id) {
                    let lobby = (fg.lobby.raw() != 0).then_some(fg.lobby);
                    let rp = f.rich_presence("connect");
                    if lobby.is_some() || rp.as_deref().and_then(parse_target).is_some() {
                        let host = match rp.as_deref().and_then(parse_target) {
                            Some(SteamTarget::Host(h)) => h,
                            _ => fid,
                        };
                        if host != my_id {
                            friend_rooms.push((host, f.name(), lobby));
                        }
                    }
                }
            }
        }

        let (tx, rx) = oneshot::channel();
        {
            let mm = client.matchmaking();
            let filters = vec![StringFilter(LobbyKey::new(LOBBY_TAG_KEY), LOBBY_TAG_VAL, StringFilterKind::Equal)];
            mm.set_lobby_list_filter(
                LobbyListFilter::default()
                    .set_string(Some(filters))
                    .set_distance(Some(DistanceFilter::Worldwide))
                    .set_count(Some(50)),
            )
            .request_lobby_list(move |res| {
                let _ = tx.send(res.unwrap_or_default());
            });
        }
        let lobbies = tokio::time::timeout(Duration::from_millis(3500), rx).await.ok().and_then(Result::ok).unwrap_or_default();

        let mut out = Vec::new();
        let mut seen_hosts = HashSet::new();
        let mm = client.matchmaking();

        for lobby in lobbies {
            if mm.lobby_data(lobby, LOBBY_TAG_KEY).as_deref() != Some(LOBBY_TAG_VAL) {
                continue;
            }
            let host_id = mm
                .lobby_data(lobby, "host_id")
                .and_then(|s| s.parse::<u64>().ok())
                .map(SteamId::from_raw)
                .unwrap_or_else(|| mm.lobby_owner(lobby));
            if host_id.is_invalid() || host_id.raw() == 0 || host_id == my_id || !seen_hosts.insert(host_id) {
                continue;
            }
            let is_friend = friend_ids.contains(&host_id);
            let name = mm
                .lobby_data(lobby, "host_name")
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| client.friends().get_friend(host_id).name());
            let has_pwd = mm.lobby_data(lobby, "has_pwd").as_deref() == Some("1");
            let players = mm
                .lobby_data(lobby, "players")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or_else(|| mm.lobby_member_count(lobby).max(1));
            out.push(json!({
                "hostId": host_id.raw().to_string(),
                "address": format!("steam:{}", host_id.raw()),
                "lobbyId": lobby.raw().to_string(),
                "name": name.chars().take(NAME_MAX).collect::<String>(),
                "players": players.min(MAX_PLAYERS),
                "hasPwd": has_pwd,
                "isFriend": is_friend,
            }));
        }

        for (host_id, fname, lobby) in friend_rooms {
            if !seen_hosts.insert(host_id) {
                continue;
            }
            out.push(json!({
                "hostId": host_id.raw().to_string(),
                "address": format!("steam:{}", host_id.raw()),
                "lobbyId": lobby.map(|l| l.raw().to_string()),
                "name": fname.chars().take(NAME_MAX).collect::<String>(),
                "players": 1,
                "hasPwd": false,
                "isFriend": true,
            }));
        }

        out.sort_by_key(|r| !r["isFriend"].as_bool().unwrap_or(false));
        out
    }

    pub fn invite_overlay(&self) -> bool {
        let i = self.inner.lock().unwrap();
        let Some(client) = &i.client else { return false };
        let my_id = client.user().steam_id().raw();
        if let Some(lobby) = i.active_lobby {
            client.friends().activate_invite_dialog(lobby);
        } else {
            client.friends().activate_invite_dialog_connect_string(&format!("steam:{my_id}"));
        }
        true
    }
}

async fn resolve_lobby_host(client: &Client, lobby: LobbyId) -> Result<SteamId, String> {
    let host_from_meta = |c: &Client| -> Option<SteamId> {
        let mm = c.matchmaking();
        if let Some(id) = mm.lobby_data(lobby, "host_id").and_then(|s| s.parse::<u64>().ok()) {
            if id > 0 {
                return Some(SteamId::from_raw(id));
            }
        }
        let owner = mm.lobby_owner(lobby);
        (!owner.is_invalid() && owner.raw() != 0).then_some(owner)
    };
    if let Some(h) = host_from_meta(client) {
        return Ok(h);
    }
    let (tx, rx) = oneshot::channel();
    client.matchmaking().join_lobby(lobby, move |res| {
        let _ = tx.send(res);
    });
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(Ok(_))) => host_from_meta(client).ok_or_else(|| "无法获取 Steam 房间房主信息".into()),
        _ => Err("加入 Steam 大厅失败或房间已关闭".into()),
    }
}

async fn host_loop(listen_socket: ListenSocket, local_port: u16, mut cancel: watch::Receiver<bool>) {
    let mut conns = JoinSet::new();
    let mut poll = tokio::time::interval(Duration::from_millis(12));
    loop {
        tokio::select! {
            _ = cancel.changed() => break,
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            _ = poll.tick() => {
                while let Some(ev) = listen_socket.try_receive_event() {
                    match ev {
                        ListenSocketEvent::Connecting(req) => {
                            let _ = req.accept();
                        }
                        ListenSocketEvent::Connected(connected) => {
                            let conn = connected.take_connection();
                            let c_rx = cancel.clone();
                            conns.spawn(async move {
                                if let Ok(tcp) = TcpStream::connect(("127.0.0.1", local_port)).await {
                                    bridge_conn(conn, tcp, false, c_rx).await;
                                }
                            });
                        }
                        ListenSocketEvent::Disconnected(_) => {}
                    }
                }
            }
        }
    }
    // Always drop child NetConnections before dropping ListenSocket so InnerSocket is never
    // dropped while the callback lock is held.
    conns.abort_all();
    while conns.join_next().await.is_some() {}
    drop(listen_socket);
}

async fn join_loop(client: Client, host_id: SteamId, listener: TcpListener, mut cancel: watch::Receiver<bool>) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.changed() => break,
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            accepted = listener.accept() => {
                let Ok((tcp, _)) = accepted else { break };
                let ident = NetworkingIdentity::new_steam_id(host_id);
                let Ok(conn) = client.networking_sockets().connect_p2p(ident, P2P_VIRTUAL_PORT, p2p_opts()) else {
                    continue;
                };
                let c_rx = cancel.clone();
                conns.spawn(bridge_conn(conn, tcp, true, c_rx));
            }
        }
    }
    conns.abort_all();
    while conns.join_next().await.is_some() {}
}

fn drain_p2p_bytes(conn: &mut NetConnection) -> Result<Vec<u8>, InvalidHandle> {
    let msgs = conn.receive_messages(64)?;
    let mut out = Vec::new();
    for m in msgs {
        out.extend_from_slice(m.data());
    }
    Ok(out)
}

async fn bridge_conn(mut conn: NetConnection, tcp: TcpStream, is_client: bool, mut cancel: watch::Receiver<bool>) {
    let _ = tcp.set_nodelay(true);
    if is_client {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            while let Some(ev) = conn.try_receive_event() {
                match ev.new_state {
                    NetworkingConnectionState::Connected => break,
                    NetworkingConnectionState::ClosedByPeer | NetworkingConnectionState::ProblemDetectedLocally => return,
                    _ => {}
                }
            }
            if matches!(conn.info().and_then(|i| i.state().map_err(|_| InvalidHandle)), Ok(NetworkingConnectionState::Connected)) {
                break;
            }
            if Instant::now() >= deadline || *cancel.borrow() {
                return;
            }
            tokio::select! {
                _ = cancel.changed() => return,
                _ = tokio::time::sleep(Duration::from_millis(12)) => {}
            }
        }
    }

    let (mut rd, mut wr) = tcp.into_split();
    let mut buf = vec![0u8; P2P_CHUNK];
    let mut pending_p2p: Option<Vec<u8>> = None;
    let mut poll = tokio::time::interval(Duration::from_millis(8));

    loop {
        tokio::select! {
            _ = cancel.changed() => break,
            res = rd.read(&mut buf), if pending_p2p.is_none() => match res {
                Ok(0) | Err(_) => {
                    // Drain any remaining inbound messages and let outbound reliable packets flush
                    // (e.g. a server rejection error + close frame) before closing the P2P handle.
                    let _ = conn.flush_messages();
                    if let Ok(bytes) = drain_p2p_bytes(&mut conn) {
                        if !bytes.is_empty() {
                            let _ = wr.write_all(&bytes).await;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    break;
                }
                Ok(n) => {
                    match conn.send_message(&buf[..n], SendFlags::RELIABLE_NO_NAGLE) {
                        Ok(_) => {}
                        Err(SteamError::LimitExceeded) => pending_p2p = Some(buf[..n].to_vec()),
                        Err(_) => break,
                    }
                }
            },
            _ = poll.tick() => {
                if let Some(data) = &pending_p2p {
                    match conn.send_message(data, SendFlags::RELIABLE_NO_NAGLE) {
                        Ok(_) => pending_p2p = None,
                        Err(SteamError::LimitExceeded) => {}
                        Err(_) => break,
                    }
                }
                let Ok(bytes) = drain_p2p_bytes(&mut conn) else { break };
                if !bytes.is_empty() && wr.write_all(&bytes).await.is_err() {
                    return;
                }
                while let Some(ev) = conn.try_receive_event() {
                    if matches!(ev.new_state, NetworkingConnectionState::ClosedByPeer | NetworkingConnectionState::ProblemDetectedLocally) {
                        let _ = wr.shutdown().await;
                        return;
                    }
                }
                match conn.info().and_then(|i| i.state().map_err(|_| InvalidHandle)) {
                    Ok(NetworkingConnectionState::Connected | NetworkingConnectionState::FindingRoute | NetworkingConnectionState::Connecting) => {}
                    _ => {
                        let _ = wr.shutdown().await;
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_steam_targets() {
        assert_eq!(
            parse_target("steam:76561198040894045"),
            Some(SteamTarget::Host(SteamId::from_raw(76561198040894045)))
        );
        assert_eq!(
            parse_target("  steam://76561198040894045/ "),
            Some(SteamTarget::Host(SteamId::from_raw(76561198040894045)))
        );
        assert_eq!(
            parse_target("76561198040894045"),
            Some(SteamTarget::Host(SteamId::from_raw(76561198040894045)))
        );
        assert_eq!(
            parse_target("lobby:109775241000000000"),
            Some(SteamTarget::Lobby(LobbyId::from_raw(109775241000000000)))
        );
        assert_eq!(
            parse_target("steam://joinlobby/480/109775241000000000/76561198040894045"),
            Some(SteamTarget::Lobby(LobbyId::from_raw(109775241000000000)))
        );
        assert!(parse_target("192.168.1.10:23333").is_none());
        assert!(parse_target("[2408::1]:23333").is_none());
    }

    #[test]
    fn parses_connect_args() {
        let args = vec!["CoFisher.exe".into(), "+connect_lobby".into(), "10977524123".into()];
        assert_eq!(connect_arg(&args).as_deref(), Some("lobby:10977524123"));
        let args2 = vec!["CoFisher.exe".into(), "+connect".into(), "steam:76561198040894045".into()];
        assert_eq!(connect_arg(&args2).as_deref(), Some("steam:76561198040894045"));
    }
}
