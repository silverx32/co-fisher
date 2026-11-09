//! WebSocket client to a room (a friend hosting in-app, or the relay). Reconnects with backoff
//! and notices hosts that vanish silently. Everything received is untrusted; callers sanitise.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cofisher_server::{DEFAULT_PORT, MAX_PAYLOAD, PROTOCOL_VERSION};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const PING_EVERY: Duration = Duration::from_secs(5);
const DEAD_AFTER: Duration = Duration::from_secs(20);

pub enum NetEvent {
    Status { state: &'static str, text: String },
    Welcome(Value),
    /// Players and the room's boss (null from servers without one).
    State(Vec<Value>, Value),
    Skin(Value),
    Hit(Value),
    BossDown(Value),
    Log(String),
    ThrowResult(Value),
    Game(Value),
}

pub type HelloFn = Arc<dyn Fn() -> Value + Send + Sync>;

#[derive(Default)]
struct Inner {
    generation: u64,
    task: Option<JoinHandle<()>>,
    out: Option<mpsc::UnboundedSender<String>>,
    state: &'static str,
}

#[derive(Clone)]
pub struct Net {
    inner: Arc<Mutex<Inner>>,
    events: mpsc::UnboundedSender<NetEvent>,
}

/// Turns what a user types into a ws:// URL: adds the scheme, brackets bare IPv6 addresses
/// and fills in the default port.
pub fn to_url(address: &str) -> Result<String, ()> {
    let a = address.trim();
    if a.is_empty() || a.contains(char::is_whitespace) {
        return Err(());
    }
    let with_scheme = if a.starts_with("ws://") || a.starts_with("wss://") {
        a.to_string()
    } else if a.matches(':').count() >= 2 && !a.contains('[') {
        format!("ws://[{a}]") // bare IPv6 address without port
    } else {
        format!("ws://{a}")
    };
    let uri: Uri = with_scheme.parse().map_err(|_| ())?;
    let scheme = uri.scheme_str().ok_or(())?;
    let host = uri.host().filter(|h| !h.is_empty()).ok_or(())?;
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    let port = uri.port_u16().unwrap_or(DEFAULT_PORT);
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    Ok(format!("{scheme}://{host}:{port}{path}"))
}

impl Net {
    pub fn new(events: mpsc::UnboundedSender<NetEvent>) -> Self {
        let inner = Inner { state: "offline", ..Default::default() };
        Self { inner: Arc::new(Mutex::new(inner)), events }
    }

    pub fn state(&self) -> &'static str {
        self.inner.lock().unwrap().state
    }

    pub fn connect(&self, url: String, label: String, password: String, room: String, hello: HelloFn) {
        self.disconnect();
        // Generation bump, spawn and storing the handle happen under one lock so two quick
        // connects can't leave an orphaned task that disconnect() can no longer abort.
        let mut i = self.inner.lock().unwrap();
        i.generation += 1;
        let generation = i.generation;
        if let Some(old) = i.task.take() {
            old.abort();
        }
        let me = self.clone();
        i.task = Some(tauri::async_runtime::spawn(async move { me.run(generation, url, label, password, room, hello).await }));
    }

    pub fn disconnect(&self) {
        let task = {
            let mut i = self.inner.lock().unwrap();
            i.generation += 1; // anything the old task still does is ignored from now on
            i.out = None;
            i.task.take()
        };
        if let Some(t) = task {
            t.abort();
        }
        self.set_state_now("offline", "未连接");
    }

    /// Sends only while joined; returns whether the message was queued.
    pub fn send(&self, msg: &Value) -> bool {
        let i = self.inner.lock().unwrap();
        match (&i.out, i.state) {
            (Some(out), "online") => out.send(msg.to_string()).is_ok(),
            _ => false,
        }
    }

    fn set_state_now(&self, state: &'static str, text: &str) {
        self.inner.lock().unwrap().state = state;
        let _ = self.events.send(NetEvent::Status { state, text: text.to_string() });
    }

    /// Like `set_state_now`, but a no-op for a superseded connection task.
    fn set_state(&self, generation: u64, state: &'static str, text: &str) -> bool {
        {
            let mut i = self.inner.lock().unwrap();
            if i.generation != generation {
                return false;
            }
            i.state = state;
            if state != "online" {
                i.out = None;
            }
        }
        let _ = self.events.send(NetEvent::Status { state, text: text.to_string() });
        true
    }

    fn emit(&self, generation: u64, ev: NetEvent) {
        if self.inner.lock().unwrap().generation == generation {
            let _ = self.events.send(ev);
        }
    }

    async fn run(self, generation: u64, url: String, label: String, password: String, room: String, hello: HelloFn) {
        let mut delay = Duration::from_secs(1);
        loop {
            if !self.set_state(generation, "connecting", &format!("正在连接 {label} …")) {
                return;
            }
            let (outcome, was_online) = self.session(generation, &url, &password, &room, &hello).await;
            self.emit(generation, NetEvent::State(Vec::new(), Value::Null));
            match outcome {
                Err(fatal) => {
                    self.set_state(generation, "offline", &fatal);
                    return;
                }
                Ok(reason) => {
                    if was_online {
                        delay = Duration::from_secs(1);
                    }
                    let text = format!("{reason}，{} 秒后重连…", delay.as_secs());
                    if !self.set_state(generation, "connecting", &text) {
                        return;
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(15));
                }
            }
        }
    }

    /// One connection attempt. `Ok(reason)` = retry later, `Err(text)` = give up (rejected).
    async fn session(&self, generation: u64, url: &str, password: &str, room: &str, hello: &HelloFn) -> (Result<String, String>, bool) {
        let cfg = WebSocketConfig::default().max_message_size(Some(MAX_PAYLOAD)).max_frame_size(Some(MAX_PAYLOAD));
        let ws = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async_with_config(url, Some(cfg), true)).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => return (Ok(friendly_error(&e.to_string())), false),
            Err(_) => return (Ok("连接超时".into()), false),
        };
        let (mut sink, mut stream) = ws.split();
        let mut hello_msg = hello();
        if let Some(obj) = hello_msg.as_object_mut() {
            obj.insert("t".into(), "hello".into());
            obj.insert("v".into(), PROTOCOL_VERSION.into());
            obj.insert("password".into(), password.into());
            obj.insert("room".into(), room.into());
        }
        if sink.send(Message::text(hello_msg.to_string())).await.is_err() {
            return (Ok("连接断开".into()), false);
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let mut online = false;
        let mut fatal: Option<String> = None;
        let mut retry_text: Option<String> = None;
        let mut last_seen = Instant::now();
        let mut ping = tokio::time::interval(PING_EVERY);
        let mut close: Option<(u16, String)> = None;

        loop {
            tokio::select! {
                Some(text) = out_rx.recv() => {
                    if sink.send(Message::text(text)).await.is_err() { break; }
                }
                _ = ping.tick() => {
                    if self.inner.lock().unwrap().generation != generation {
                        break;
                    }
                    if last_seen.elapsed() > DEAD_AFTER {
                        close = Some((0, "连接超时".into()));
                        break;
                    }
                    if sink.send(Message::Ping(Default::default())).await.is_err() { break; }
                }
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = Instant::now();
                        let Ok(mut v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        match v["t"].as_str() {
                            Some("welcome") => {
                                {
                                    let mut i = self.inner.lock().unwrap();
                                    if i.generation != generation { return (Ok(String::new()), false); }
                                    i.out = Some(out_tx.clone());
                                }
                                online = true;
                                self.set_state(generation, "online", "已连接");
                                self.emit(generation, NetEvent::Welcome(v));
                            }
                            Some("error") => {
                                let text: String = v["text"].as_str().unwrap_or("被房主拒绝").chars().take(60).collect();
                                // e.g. "连接太频繁" (several friends behind one router): try again later.
                                if v["retry"].as_bool() == Some(true) { retry_text = Some(text) } else { fatal = Some(text) }
                            }
                            Some("state") => {
                                if let Value::Array(list) = v["players"].take() {
                                    self.emit(generation, NetEvent::State(list, v["boss"].take()));
                                }
                            }
                            Some("skin") => self.emit(generation, NetEvent::Skin(v)),
                            Some("hit") => self.emit(generation, NetEvent::Hit(v)),
                            Some("bossDown") => self.emit(generation, NetEvent::BossDown(v)),
                            Some("throwResult") => self.emit(generation, NetEvent::ThrowResult(v)),
                            Some("gameState") | Some("gameError") | Some("gameMark") => self.emit(generation, NetEvent::Game(v)),
                            Some("log") => {
                                if let Some(t) = v["text"].as_str() {
                                    self.emit(generation, NetEvent::Log(t.chars().take(80).collect()));
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        close = frame.map(|f| (u16::from(f.code), f.reason.as_str().chars().take(60).collect()));
                        break;
                    }
                    Some(Ok(_)) => last_seen = Instant::now(),
                    Some(Err(_)) | None => break,
                }
            }
        }
        {
            let mut i = self.inner.lock().unwrap();
            if i.generation == generation {
                i.out = None;
            }
        }
        if let Some(f) = fatal {
            return (Err(f), online);
        }
        if let Some(t) = retry_text {
            return (Ok(t), online);
        }
        match close {
            Some((4002, reason)) => (Err(if reason.is_empty() { "在别处重新连接".into() } else { reason }), online),
            Some((_, reason)) if !reason.is_empty() => (Ok(reason), online),
            _ => (Ok("连接断开".into()), online),
        }
    }
}

fn friendly_error(e: &str) -> String {
    let lower = e.to_lowercase();
    if lower.contains("refused") || e.contains("10061") || e.contains("积极拒绝") {
        "连不上（对方没开房间，或被防火墙挡住）".into()
    } else if lower.contains("unreachable") || e.contains("10051") || e.contains("10065") {
        "网络不可达（如果是 IPv6 地址，可能你这边没有 IPv6）".into()
    } else if lower.contains("timed out") || e.contains("10060") {
        "连接超时".into()
    } else {
        format!("连接失败：{}", e.chars().take(60).collect::<String>())
    }
}

/// `json!` helper for callers building hello payloads.
#[allow(clippy::too_many_arguments)]
pub fn hello_payload(id: &str, secret: &str, name: &str, character: &str, worn: &[String], skin: Option<&Value>, count: u64, inv: Value) -> Value {
    // "deco" (one item) is what v2.1 relays understand.
    json!({ "id": id, "secret": secret, "name": name, "char": character, "deco": worn.first(), "decos": worn, "skin": skin, "count": count, "inv": inv })
}

#[cfg(test)]
mod tests {
    use super::to_url;

    #[test]
    fn parses_addresses() {
        assert_eq!(to_url("192.168.1.5").unwrap(), "ws://192.168.1.5:23333/");
        assert_eq!(to_url(" 10.0.0.2:4000 ").unwrap(), "ws://10.0.0.2:4000/");
        assert_eq!(to_url("2408:8207::1").unwrap(), "ws://[2408:8207::1]:23333/");
        assert_eq!(to_url("[2408:8207::1]:4000").unwrap(), "ws://[2408:8207::1]:4000/");
        assert_eq!(to_url("my.relay.cn:9000").unwrap(), "ws://my.relay.cn:9000/");
        assert_eq!(to_url("ws://example.com").unwrap(), "ws://example.com:23333/");
        assert!(to_url("").is_err());
        assert!(to_url("a b").is_err());
    }
}
