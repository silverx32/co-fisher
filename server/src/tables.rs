//! Independent tables share one room wallet ledger, never a deck or turn.
use crate::{
    cards,
    games::{Receipt, SingleGame},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

/// Seated players offline at least this long get a stand-in so their table keeps going.
const AWAY: Duration = Duration::from_secs(60);
/// Spectator marks per second per person; faster clicks are dropped without an error.
const MARKS_PER_SECOND: usize = 6;
pub struct Games {
    pub epoch: String,
    pub revision: u64,
    tables: Vec<(String, SingleGame)>,
    views: HashMap<String, String>,
    offsets: HashMap<String, i64>,
    receipts: HashMap<String, Receipt>,
    seen: HashMap<(String, String), (i64, Receipt)>,
    used: VecDeque<String>,
    numbers: HashMap<String, u64>,
    next_number: u64,
    offline: HashMap<String, Instant>,
    marks: HashMap<String, VecDeque<Instant>>,
    next_mark: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op(g: &mut Games, id: &str, op: &str, extra: Value) -> Result<(), String> {
        let state = g.snapshot(id);
        let mut msg = json!({"epoch":g.epoch,"op":op,"revision":state["tableRevision"],"tableId":state["table"]["id"]});
        for (k, v) in extra.as_object().unwrap() {
            msg[k] = v.clone();
        }
        g.command(id, id, &msg, 2000)
    }
    fn join(g: &mut Games, id: &str, key: Option<String>, create: bool, n: u64) {
        op(
            g,
            id,
            "join",
            json!({"kind":"blackjack","tableId":key,"create":create,"ticket":format!("{n:032x}")}),
        )
        .unwrap();
    }
    #[test]
    fn tables_have_separate_turns_and_wallets() {
        let mut g = Games::default();
        join(&mut g, "a", None, true, 1);
        let one = g.snapshot("a")["table"]["id"].as_str().unwrap().to_owned();
        join(&mut g, "b", Some(one.clone()), false, 2);
        join(&mut g, "c", Some(one.clone()), false, 3);
        join(&mut g, "d", None, true, 4);
        let two = g.snapshot("d")["table"]["id"].as_str().unwrap().to_owned();
        join(&mut g, "e", Some(two.clone()), false, 5);
        join(&mut g, "f", Some(two.clone()), false, 6);
        op(&mut g, "a", "start", json!({})).unwrap();
        let first = g.snapshot("a")["tableRevision"].clone();
        op(&mut g, "d", "start", json!({})).unwrap();
        assert_eq!(g.snapshot("a")["tableRevision"], first);
        assert_eq!(g.snapshot("a")["tables"].as_array().unwrap().len(), 2);
        assert!(op(
            &mut g,
            "a",
            "join",
            json!({"kind":"blackjack","tableId":two,"ticket":format!("{:032x}",10)})
        )
        .is_err());
        assert_eq!(g.offset("a"), -500);
        op(&mut g, "b", "leave", json!({})).unwrap();
        join(&mut g, "b", None, true, 11);
        let new_ticket = g.receipts["b"].ticket.clone();
        op(&mut g, "c", "leave", json!({})).unwrap();
        assert_eq!(g.offset("a"), 700);
        assert_eq!(g.offset("d"), -500);
        assert_eq!(g.receipts["b"].ticket, new_ticket);
        assert!(!g.receipts["b"].final_);
    }
    #[test]
    fn turn_owner_is_reported_and_only_long_offline_players_are_played_for() {
        let mut g = Games::default();
        let ticket = |n: u64| format!("{n:032x}");
        op(&mut g, "a", "join", json!({"kind":"xiangqi","tableId":null,"create":true,"ticket":ticket(1)})).unwrap();
        let key = g.snapshot("a")["table"]["id"].clone();
        op(&mut g, "b", "join", json!({"kind":"xiangqi","tableId":key,"ticket":ticket(2)})).unwrap();
        op(&mut g, "a", "start", json!({})).unwrap();
        assert_eq!(g.snapshot("a")["act"]["kind"], "xiangqi");
        assert!(g.snapshot("b")["act"].is_null());
        assert!(g.snapshot("z")["kinds"].as_array().unwrap().contains(&json!("monopoly")));
        let revision = g.revision;
        g.tick(&|id| id != "a");
        assert_eq!(g.revision, revision, "a short disconnect must not move for them");
        g.offline.insert("a".into(), Instant::now() - AWAY);
        g.tick(&|id| id != "a");
        assert!(g.revision > revision);
        assert_eq!(g.snapshot("b")["act"]["kind"], "xiangqi");
        assert!(g.snapshot("a")["act"].is_null());
    }
    #[test]
    fn only_spectators_mark_running_boards_and_floods_are_dropped() {
        let mut g = Games::default();
        let ticket = |n: u64| format!("{n:032x}");
        op(&mut g, "a", "join", json!({"kind":"xiangqi","tableId":null,"create":true,"ticket":ticket(1)})).unwrap();
        let key = g.snapshot("a")["table"]["id"].clone();
        let mark = |g: &mut Games, id: &str, square: u64| {
            let msg = json!({"epoch":g.epoch,"op":"mark","tableId":key,"square":square});
            g.mark(id, id, &msg)
        };
        assert!(mark(&mut g, "z", 4).is_err(), "nothing to mark in the lobby");
        op(&mut g, "b", "join", json!({"kind":"xiangqi","tableId":key,"ticket":ticket(2)})).unwrap();
        op(&mut g, "a", "start", json!({})).unwrap();
        let revision = g.snapshot("a")["tableRevision"].clone();
        let m = mark(&mut g, "z", 4).unwrap().unwrap();
        assert_eq!((m["t"].as_str(), m["by"].as_str(), m["name"].as_str()), (Some("gameMark"), Some("z"), Some("z")));
        assert_eq!((m["square"].as_u64(), m["tableId"].clone()), (Some(4), key.clone()));
        assert_eq!(g.snapshot("a")["tableRevision"], revision, "marks never make a move stale");
        assert_eq!(g.snapshot("z")["marks"]["xiangqi"], "spectators");
        assert_eq!(g.snapshot("z")["marks"]["monopoly"], "everyone");
        assert!(mark(&mut g, "a", 4).is_err(), "players can't mark");
        assert!(mark(&mut g, "z", 90).is_err());
        for _ in 1..MARKS_PER_SECOND {
            assert!(mark(&mut g, "z", 5).unwrap().is_some());
        }
        assert!(mark(&mut g, "z", 5).unwrap().is_none(), "flood dropped quietly");
        assert!(mark(&mut g, "y", 5).unwrap().is_some(), "each spectator has their own allowance");
        // 飞行棋 / 大富翁: players mark their own board too; games without marks refuse.
        for (kind, points, n) in [("flight", 196, 10), ("monopoly", 32, 20), ("blackjack", 0, 30)] {
            let mut g = Games::default();
            for (i, id) in ["p", "q", "r"].iter().enumerate() {
                let key = if i == 0 { Value::Null } else { g.snapshot("p")["table"]["id"].clone() };
                op(&mut g, id, "join", json!({"kind":kind,"tableId":key,"create":i == 0,"ticket":ticket(n + i as u64)})).unwrap();
            }
            op(&mut g, "p", "start", json!({})).unwrap();
            let key = g.snapshot("p")["table"]["id"].clone();
            let msg = |square: u64| json!({"epoch":g.epoch,"op":"mark","tableId":key,"square":square});
            let (player, spectator, outside) = (msg(1), msg(points.max(1) - 1), msg(points));
            if points == 0 {
                assert!(g.mark("p", "p", &player).is_err() && g.mark("z", "z", &player).is_err(), "{kind}");
                continue;
            }
            assert!(g.mark("p", "p", &player).unwrap().is_some(), "{kind} player");
            assert!(g.mark("z", "z", &spectator).unwrap().is_some(), "{kind} spectator");
            assert!(g.mark("q", "q", &outside).is_err(), "{kind} point range");
        }
    }
    #[test]
    fn spectators_can_watch_but_cannot_act_or_see_cards() {
        let mut g = Games::default();
        join(&mut g, "a", None, true, 1);
        let key = g.snapshot("a")["table"]["id"].clone();
        for (id, n) in [("b", 2), ("c", 3)] {
            join(&mut g, id, key.as_str().map(String::from), false, n);
        }
        op(&mut g, "a", "start", json!({})).unwrap();
        op(&mut g, "z", "watch", json!({"tableId":key})).unwrap();
        assert!(g.snapshot("z")["table"]["seats"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["cards"].is_null()));
        assert!(op(&mut g, "z", "hit", json!({})).is_err());
        assert!(op(&mut g, "a", "leave", json!({"tableId":"missing"})).is_err());
    }
}
impl Default for Games {
    fn default() -> Self {
        Self {
            epoch: cards::token(),
            revision: 0,
            tables: vec![],
            views: HashMap::new(),
            offsets: HashMap::new(),
            receipts: HashMap::new(),
            seen: HashMap::new(),
            used: VecDeque::new(),
            numbers: HashMap::new(),
            next_number: 1,
            offline: HashMap::new(),
            marks: HashMap::new(),
            next_mark: 0,
        }
    }
}
impl Games {
    pub fn offset(&self, id: &str) -> i64 {
        self.offsets.get(id).copied().unwrap_or(0)
    }
    fn selected(&self, id: &str) -> Option<usize> {
        self.views
            .get(id)
            .and_then(|key| self.tables.iter().position(|(k, _)| k == key))
            .or_else(|| {
                self.tables
                    .iter()
                    .rposition(|(_, g)| g.receipts.get(id).is_some_and(|r| !r.final_))
            })
            .or_else(|| {
                self.tables
                    .iter()
                    .rposition(|(_, g)| g.snapshot(id)["table"]["phase"] != "finished")
            })
            .or_else(|| self.tables.len().checked_sub(1))
    }
    fn sync_ledger(&mut self, i: usize) {
        let (key, g) = &self.tables[i];
        for (id, r) in &g.receipts {
            let offset = g.offset(id);
            let cache = (key.clone(), id.clone());
            let old = self.seen.get(&cache);
            let prev = old.map_or(0, |s| s.0);
            *self.offsets.entry(id.clone()).or_default() += offset - prev;
            if old.is_none_or(|s| s.1 != *r) {
                self.receipts.insert(id.clone(), r.clone());
            }
            self.seen.insert(cache, (offset, r.clone()));
        }
    }
    pub fn snapshot(&self, id: &str) -> Value {
        let mut result = self.selected(id).map_or_else(
            || json!({"table":null}),
            |i| {
                let mut v = self.tables[i].1.snapshot(id);
                if v["table"].is_object() {
                    v["table"]["id"] = self.tables[i].0.clone().into();
                    v["table"]["number"] = self.numbers[&self.tables[i].0].into();
                }
                v["tableRevision"] = v["revision"].clone();
                v
            },
        );
        result["t"] = "gameState".into();
        result["epoch"] = self.epoch.clone().into();
        result["revision"] = self.revision.into();
        result["receipt"] = self.receipts.get(id).map_or(
            Value::Null,
            |r| json!({"ticket":r.ticket,"net":r.net,"final":r.final_}),
        );
        // The table waiting on this player, even while they are watching another one.
        result["act"] = self
            .tables
            .iter()
            .find(|(_, g)| g.can_act(id))
            .map_or(Value::Null, |(key, g)| json!({"id":key,"number":self.numbers[key],"kind":g.kind()}));
        result["kinds"] = json!(crate::games::KINDS);
        // Who may drop board marks, per game.
        result["marks"] = crate::games::MARK_KINDS
            .iter()
            .map(|(kind, _, everyone)| (kind.to_string(), json!(if *everyone { "everyone" } else { "spectators" })))
            .collect::<serde_json::Map<_, _>>()
            .into();
        result["tables"]=self.tables.iter().filter_map(|(key,g)|{
            let v=g.snapshot("");let t=&v["table"];if t.is_null()||t["phase"]=="finished"{return None;}
            Some(json!({"id":key,"number":self.numbers[key],"kind":t["kind"],"phase":t["phase"],"host":t["host"],"turn":t["turn"],"seats":t["seats"].as_array().unwrap().iter().map(|s|json!({"id":s["id"],"name":s["name"],"alive":s["alive"],"left":s["left"]})).collect::<Vec<_>>()}))
        }).collect::<Vec<_>>().into();
        result
    }
    pub fn command(
        &mut self,
        id: &str,
        name: &str,
        msg: &Value,
        balance: u64,
    ) -> Result<(), String> {
        if msg["epoch"].as_str() != Some(&self.epoch) {
            return Err("牌桌已更新，请重试".into());
        }
        let op = msg["op"].as_str().unwrap_or("");
        if op == "sync" {
            return Ok(());
        }
        let target = msg["tableId"].as_str().filter(|s| !s.is_empty());
        if op == "watch" {
            let key = target
                .filter(|key| self.tables.iter().any(|(k, _)| k == key))
                .ok_or("该牌桌已结束或不存在")?;
            self.views.insert(id.into(), key.into());
            self.revision += 1;
            return Ok(());
        }
        let mut created = false;
        let i = if op == "join" {
            let ticket = msg["ticket"].as_str().unwrap_or("");
            if self.receipts.get(id).is_some_and(|r| r.ticket == ticket) {
                return Ok(());
            }
            if self.receipts.get(id).is_some_and(|r| !r.final_) {
                return Err("每人同时参加一桌，请先完成或退出原牌局".into());
            }
            if self.used.iter().any(|k| k == ticket) {
                return Err("报名凭证已使用".into());
            }
            if balance < 500 {
                return Err("报名需要 500 点".into());
            }
            if let Some(key) = target {
                let i = self
                    .tables
                    .iter()
                    .position(|(k, _)| k == key)
                    .ok_or("该牌桌已结束")?;
                if self.tables[i].1.snapshot(id)["table"]["phase"] != "lobby" {
                    return Err("这桌已开局，请选择其他桌或新建".into());
                }
                i
            } else if msg["create"] != true
                && self.tables.iter().any(|(_, g)| {
                    let s = g.snapshot(id);
                    s["table"]["phase"] == "lobby" && s["table"]["kind"] == msg["kind"]
                })
            {
                self.tables
                    .iter()
                    .rposition(|(_, g)| {
                        let s = g.snapshot(id);
                        s["table"]["phase"] == "lobby" && s["table"]["kind"] == msg["kind"]
                    })
                    .unwrap()
            } else {
                if self
                    .tables
                    .iter()
                    .filter(|(_, g)| g.snapshot(id)["table"]["phase"] != "finished")
                    .count()
                    >= 16
                {
                    return Err("房间最多同时开 16 桌".into());
                }
                let key = cards::token();
                self.numbers.insert(key.clone(), self.next_number);
                self.next_number += 1;
                self.tables.push((key, SingleGame::default()));
                created = true;
                self.tables.len() - 1
            }
        } else {
            if let Some(key) = target {
                self.tables
                    .iter()
                    .position(|(k, _)| k == key)
                    .ok_or("该牌桌不存在")?
            } else {
                self.selected(id).ok_or("请先选择牌桌")?
            }
        };
        let mut inner = msg.clone();
        inner["epoch"] = self.tables[i].1.epoch.clone().into();
        let before = self.tables[i].1.revision;
        let result = self.tables[i].1.command(id, name, &inner, balance);
        if result.is_ok() {
            if op == "join" {
                self.used.push_back(msg["ticket"].as_str().unwrap().into());
                if self.used.len() > 512 {
                    self.used.pop_front();
                }
                self.views.insert(id.into(), self.tables[i].0.clone());
            }
            self.sync_ledger(i);
            if self.tables[i].1.revision != before {
                self.revision += 1;
            }
        } else if created {
            if let Some((key, _)) = self.tables.pop() {
                self.numbers.remove(&key);
            }
        }
        self.prune();
        result
    }
    /// A spectator's mark on a board, broadcast to the room as is: it never changes a
    /// table's revision, so it can't make a player's pending move stale. None when throttled.
    pub fn mark(&mut self, id: &str, name: &str, msg: &Value) -> Result<Option<Value>, String> {
        if msg["epoch"].as_str() != Some(&self.epoch) {
            return Err("牌桌已更新，请重试".into());
        }
        let key = msg["tableId"].as_str().unwrap_or("");
        let (key, g) = self
            .tables
            .iter()
            .find(|(k, _)| k == key)
            .ok_or("该牌桌已结束或不存在")?;
        let points = g.mark_points(id)?;
        let square = msg["square"].as_u64().filter(|s| *s < points).ok_or("无效位置")?;
        let now = Instant::now();
        let recent = self.marks.entry(id.into()).or_default();
        recent.retain(|t| now.duration_since(*t) < Duration::from_secs(1));
        if recent.len() >= MARKS_PER_SECOND {
            return Ok(None);
        }
        recent.push_back(now);
        self.next_mark += 1;
        Ok(Some(json!({"t":"gameMark","tableId":key,"by":id,"name":name,"square":square,"seq":self.next_mark})))
    }
    pub fn tick(&mut self, online: &dyn Fn(&str) -> bool) {
        let now = Instant::now();
        self.marks
            .retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < Duration::from_secs(1)));
        let seated: HashSet<String> = self.tables.iter().flat_map(|(_, g)| g.players()).collect();
        self.offline.retain(|id, _| seated.contains(id) && !online(id));
        for id in seated {
            if !online(&id) {
                self.offline.entry(id).or_insert(now);
            }
        }
        let away: HashSet<String> = self
            .offline
            .iter()
            .filter(|(_, since)| now.duration_since(**since) >= AWAY)
            .map(|(id, _)| id.clone())
            .collect();
        for i in 0..self.tables.len() {
            let before = self.tables[i].1.revision;
            self.tables[i].1.tick(&|id| away.contains(id));
            if before != self.tables[i].1.revision {
                self.sync_ledger(i);
                self.revision += 1;
            }
        }
        self.prune();
    }
    fn prune(&mut self) {
        while self.tables.len() > 32 {
            let Some(i) = self
                .tables
                .iter()
                .position(|(_, g)| g.snapshot("")["table"]["phase"] == "finished")
            else {
                break;
            };
            let (key, _) = self.tables.remove(i);
            self.numbers.remove(&key);
            self.views.retain(|_, v| v != &key);
            self.seen.retain(|(k, _), _| k != &key);
        }
    }
}
