//! One authoritative table per social room. Snapshots are personalized: private
//! hands never enter the ordinary room broadcast, including for spectators.
//! Turns have no time limit; only players offline for a while are played for.
use crate::cards::{self, Pattern};
pub use crate::tables::Games;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

pub const ENTRY: u64 = 500;
pub const KINDS: [&str; 7] = ["blackjack", "holdem", "ddz", "mahjong", "flight", "xiangqi", "monopoly"];
/// Stand-in moves for offline players are spaced out so the others can follow them.
const PACE: Duration = Duration::from_millis(800);
/// Allowed entrants per game.
fn seats(kind: &str) -> (usize, usize) {
    match kind {
        "ddz" => (3, 3),
        "mahjong" => (4, 4),
        "holdem" => (3, 9),
        "xiangqi" => (2, 2),
        "flight" => (2, 4),
        "monopoly" => (2, 6),
        _ => (3, 16),
    }
}
/// A game that runs its own turns (飞行棋 / 象棋 / 大富翁). The table keeps the
/// seats, tickets and prize; the board decides who may act and who won.
pub(crate) trait Board: Send {
    fn can_act(&self, seat: usize) -> bool;
    fn command(&mut self, seat: usize, msg: &Value) -> Result<(), String>;
    fn forfeit(&mut self, seat: usize);
    /// One step on behalf of seats whose players are `away`; false when none was due.
    fn auto(&mut self, away: &dyn Fn(usize) -> bool) -> bool;
    fn snapshot(&self, viewer: Option<usize>) -> Value;
    fn turn(&self) -> usize;
    fn note(&self) -> String;
    /// Not knocked out (bankrupt) and not forfeited.
    fn alive(&self, seat: usize) -> bool;
    /// Seats sharing the prize, once the game is over.
    fn winners(&self) -> Option<Vec<usize>>;
}
#[derive(Clone, PartialEq)]
pub(crate) struct Receipt {
    pub ticket: String,
    pub net: i64,
    pub final_: bool,
}
#[derive(Clone)]
struct Seat {
    id: String,
    name: String,
    ticket: String,
    hand: Vec<u8>,
    alive: bool,
    left: bool,
    chips: u64,
    bet: u64,
    committed: u64,
    folded: bool,
    stood: bool,
}
struct Table {
    kind: String,
    seats: Vec<Seat>,
    phase: String,
    turn: usize,
    round: u64,
    deck: Vec<u8>,
    board: Vec<u8>,
    button: usize,
    current: u64,
    min_raise: u64,
    pending: Vec<bool>,
    can_raise: Vec<bool>,
    /// End of the pause between blackjack / Hold'em hands.
    deadline: Instant,
    /// Earliest next stand-in move for an offline player.
    paced: Instant,
    landlord: Option<usize>,
    bid: u64,
    bidder: Option<usize>,
    bid_count: usize,
    last: Vec<u8>,
    last_pattern: Option<Pattern>,
    last_owner: usize,
    passes: usize,
    bottom: Vec<u8>,
    note: String,
    winners: Vec<String>,
    reveal: bool,
    entrants: usize,
    mahjong: Option<crate::mahjong::Mahjong>,
    game: Option<Box<dyn Board>>,
}
pub(crate) struct SingleGame {
    pub epoch: String,
    pub revision: u64,
    table: Option<Table>,
    pub receipts: HashMap<String, Receipt>,
    pub offsets: HashMap<String, i64>,
    used: VecDeque<String>,
}
impl Default for SingleGame {
    fn default() -> Self {
        Self {
            epoch: cards::token(),
            revision: 0,
            table: None,
            receipts: HashMap::new(),
            offsets: HashMap::new(),
            used: VecDeque::new(),
        }
    }
}
impl SingleGame {
    pub fn offset(&self, id: &str) -> i64 {
        self.offsets.get(id).copied().unwrap_or(0)
    }
    fn receipt(&mut self, seat: &Seat, returned: u64, final_: bool) {
        let net = returned as i64 - ENTRY as i64;
        let previous = self
            .receipts
            .get(&seat.id)
            .filter(|r| r.ticket == seat.ticket)
            .map_or(0, |r| r.net);
        *self.offsets.entry(seat.id.clone()).or_default() += net - previous;
        self.receipts.insert(
            seat.id.clone(),
            Receipt {
                ticket: seat.ticket.clone(),
                net,
                final_,
            },
        );
    }
    pub fn kind(&self) -> Option<&str> {
        self.table.as_ref().map(|t| t.kind.as_str())
    }
    /// Seated, still in an unfinished game; offline time is only tracked for them.
    pub fn players(&self) -> Vec<String> {
        self.table
            .as_ref()
            .filter(|t| t.phase != "lobby" && t.phase != "finished")
            .map_or(vec![], |t| t.seats.iter().filter(|s| !s.left).map(|s| s.id.clone()).collect())
    }
    pub fn can_act(&self, id: &str) -> bool {
        let Some(t) = &self.table else { return false };
        let Some(i) = t.seats.iter().position(|s| s.id == id) else { return false };
        if let Some(m) = &t.mahjong {
            return m.can_act(i);
        }
        if let Some(b) = &t.game {
            return t.phase != "finished" && b.can_act(i);
        }
        !["lobby", "intermission", "finished"].contains(&t.phase.as_str()) && t.turn == i
    }
    pub fn snapshot(&self, id: &str) -> Value {
        let receipt = self
            .receipts
            .get(id)
            .map(|r| json!({"ticket":r.ticket,"net":r.net,"final":r.final_}));
        let table = self.table.as_ref().map(|t| {
            let mine = t.seats.iter().position(|s| s.id == id);
            let can_act = self.can_act(id);
            let mut v = json!({
                "kind":t.kind,"phase":t.phase,"round":t.round,"turn":t.seats.get(t.turn).map(|s| &s.id),
                "host":t.seats.first().map(|s| &s.id),"entry":ENTRY,"pot":t.entrants as u64*ENTRY,
                "prize":t.entrants as u64*ENTRY*80/100,"board":t.board,"note":t.note,"winners":t.winners,
                "landlord":t.landlord.map(|i| &t.seats[i].id),"bid":t.bid,
                "bottom":if t.landlord.is_some() { t.bottom.clone() } else { vec![] },
                "last":t.last,"lastOwner":t.seats.get(t.last_owner).map(|s| &s.name),
                "currentBet":t.current,"minRaise":t.min_raise,
                "call":mine.map_or(0,|i| t.current.saturating_sub(t.seats[i].bet).min(t.seats[i].chips)),
                "canRaise":mine.is_some_and(|i| t.can_raise.get(i).copied().unwrap_or(false)),
                "canAct":can_act,"seats":t.seats.iter().enumerate().map(|(i,s)| json!({
                    "id":s.id,"name":s.name,"alive":s.alive,"left":s.left,"chips":s.chips,
                    "bet":s.bet,"committed":s.committed,"folded":s.folded,"stood":s.stood,
                    "count":s.hand.len(),"cards":if mine==Some(i) || (t.reveal && !s.folded && t.kind=="holdem") || (t.reveal && t.kind=="blackjack") { Some(&s.hand) } else { None },
                    "score":if t.kind=="blackjack" && (mine==Some(i)||t.reveal) { Some(cards::blackjack(&s.hand)) } else { None },
                })).collect::<Vec<_>>(),"mahjong":t.mahjong.as_ref().map(|m|m.snapshot(mine)),
            });
            if let Some(b) = &t.game {
                v[t.kind.as_str()] = b.snapshot(mine);
            }
            v
        });
        json!({"t":"gameState","epoch":self.epoch,"revision":self.revision,"table":table,"receipt":receipt})
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
        if op == "join" {
            let ticket = msg["ticket"]
                .as_str()
                .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or("报名凭证无效")?;
            if self.receipts.get(id).is_some_and(|r| r.ticket == ticket) {
                return Ok(());
            }
            if self.used.iter().any(|t| t == ticket) {
                return Err("报名凭证已使用".into());
            }
            if balance < ENTRY {
                return Err("报名需要 500 点".into());
            }
            let kind = msg["kind"]
                .as_str()
                .filter(|k| KINDS.contains(k))
                .ok_or("未知游戏")?;
            if self.table.as_ref().is_none_or(|t| t.phase == "finished") {
                self.table = Some(Table::new(kind));
            }
            let t = self.table.as_mut().unwrap();
            if t.phase != "lobby" || t.kind != kind {
                return Err("当前牌桌尚未结束，请先观战".into());
            }
            if t.seats.iter().any(|s| s.id == id) {
                return Err("已经报名了".into());
            }
            if t.seats.len() >= seats(kind).1 {
                return Err("牌桌已满".into());
            }
            let seat = Seat {
                id: id.into(),
                name: name.into(),
                ticket: ticket.into(),
                hand: vec![],
                alive: true,
                left: false,
                chips: 1000,
                bet: 0,
                committed: 0,
                folded: false,
                stood: false,
            };
            t.seats.push(seat.clone());
            t.entrants = t.seats.len();
            self.receipt(&seat, 0, false);
            self.used.push_back(ticket.into());
            if self.used.len() > 256 {
                self.used.pop_front();
            }
            self.revision += 1;
            return Ok(());
        }
        let mut t = self.table.take().ok_or("还没有牌桌")?;
        let result = self.table_command(&mut t, id, msg);
        self.table = Some(t);
        if result.is_ok() {
            self.revision += 1;
        }
        result
    }
    fn table_command(&mut self, t: &mut Table, id: &str, msg: &Value) -> Result<(), String> {
        let i = t
            .seats
            .iter()
            .position(|s| s.id == id)
            .ok_or("观战玩家不能操作")?;
        let op = msg["op"].as_str().unwrap_or("");
        if op == "start" {
            if t.phase != "lobby" || i != 0 {
                return Err("只有第一位报名者可以开局".into());
            }
            let (min, max) = seats(&t.kind);
            if !(min..=max).contains(&t.seats.len()) {
                return Err(match t.kind.as_str() {
                    "ddz" => "斗地主需要三人".into(),
                    "mahjong" => "四川麻将需要四人".into(),
                    "xiangqi" => "象棋需要两人".into(),
                    _ => format!("至少 {min} 人报名才能开局"),
                });
            }
            t.begin();
            self.after_begin(t);
            return Ok(());
        }
        if op == "leave" {
            if t.phase == "finished" || t.seats[i].left {
                return Err("已经离开牌局".into());
            }
            if t.phase == "lobby" {
                let seat = t.seats.remove(i);
                self.receipt(&seat, ENTRY, true);
                t.entrants = t.seats.len();
                if t.seats.is_empty() {
                    t.phase = "finished".into();
                    t.note = "牌桌已取消，门票已退还".into();
                }
                return Ok(());
            }
            if t.kind == "mahjong" && t.mahjong.as_ref().is_some_and(|m| m.won[i]) {
                return Err("已经胡牌，请等待本局结算".into());
            }
            t.seats[i].left = true;
            t.seats[i].alive = false;
            t.seats[i].folded = true;
            t.seats[i].stood = true;
            self.receipt(&t.seats[i], 0, true);
            if t.kind == "mahjong" {
                t.mahjong.as_mut().unwrap().forfeit(i);
                self.sync_mahjong(t);
                return Ok(());
            }
            if let Some(b) = t.game.as_mut() {
                b.forfeit(i);
                self.sync_board(t);
                return Ok(());
            }
            if t.kind == "ddz" {
                let winners: Vec<usize> = if let Some(l) = t.landlord {
                    (0..t.seats.len())
                        .filter(|j| if i == l { *j != l } else { *j == l })
                        .collect()
                } else {
                    (0..t.seats.len()).filter(|j| *j != i).collect()
                };
                self.finish(t, &winners, "有人弃权，另一方获胜");
            } else if t.kind == "holdem" {
                if t.phase != "intermission" {
                    t.pending[i] = false;
                    let after = if t.turn == i {
                        i
                    } else {
                        (t.turn + t.seats.len() - 1) % t.seats.len()
                    };
                    self.advance_poker(t, after);
                } else {
                    self.champion(t);
                }
            } else {
                self.advance_blackjack(t);
            }
            return Ok(());
        }
        if t.kind == "mahjong" && t.phase != "lobby" && t.phase != "finished" {
            if msg["revision"].as_u64() != Some(self.revision)
                && !t.mahjong.as_ref().unwrap().accepts_stale(msg)
            {
                return Err("局面已变化，请重新操作".into());
            }
            t.mahjong.as_mut().unwrap().command(i, msg)?;
            self.sync_mahjong(t);
            return Ok(());
        }
        if t.game.is_some() && t.phase != "finished" {
            // Character picks and draw offers don't depend on whose turn it is.
            if msg["revision"].as_u64() != Some(self.revision) && !["pick", "draw"].contains(&op) {
                return Err("局面已变化，请重新操作".into());
            }
            t.game.as_mut().unwrap().command(i, msg)?;
            self.sync_board(t);
            return Ok(());
        }
        if !t.seats[i].alive
            || t.phase == "lobby"
            || t.phase == "finished"
            || t.phase == "intermission"
            || t.turn != i
        {
            return Err("还没轮到你".into());
        }
        if msg["revision"].as_u64() != Some(self.revision) {
            return Err("局面已变化，请重新操作".into());
        }
        match t.kind.as_str() {
            "blackjack" => {
                match op {
                    "hit" => {
                        let c = t.deck.pop().ok_or("牌堆已空")?;
                        t.seats[i].hand.push(c);
                        if cards::blackjack(&t.seats[i].hand) >= 21 {
                            t.seats[i].stood = true;
                        }
                    }
                    "stand" => t.seats[i].stood = true,
                    _ => return Err("请选择要牌或停牌".into()),
                }
                self.advance_blackjack(t);
            }
            "holdem" => {
                self.poker_action(t, i, op, msg["amount"].as_u64().unwrap_or(0))?;
                self.advance_poker(t, i);
            }
            _ => self.ddz_action(t, i, op, msg)?,
        }
        Ok(())
    }
    /// Ends pauses between hands and plays for seats whose players are `away`
    /// (offline too long). Nobody who is present is ever hurried.
    pub fn tick(&mut self, away: &dyn Fn(&str) -> bool) {
        let Some(mut t) = self.table.take() else {
            return;
        };
        let now = Instant::now();
        let ids: Vec<String> = t.seats.iter().map(|s| s.id.clone()).collect();
        let seat_away = |i: usize| away(&ids[i]);
        if t.phase == "mahjong" {
            if now >= t.paced && t.mahjong.as_mut().unwrap().auto(&seat_away) {
                t.paced = now + PACE;
                self.sync_mahjong(&mut t);
                self.revision += 1;
            }
        } else if t.game.is_some() {
            if t.phase != "finished" && now >= t.paced && t.game.as_mut().unwrap().auto(&seat_away) {
                t.paced = now + PACE;
                self.sync_board(&mut t);
                self.revision += 1;
            }
        } else if t.phase == "intermission" {
            if now >= t.deadline {
                t.begin();
                self.after_begin(&mut t);
                self.revision += 1;
            }
        } else if !["lobby", "finished"].contains(&t.phase.as_str()) && now >= t.paced && seat_away(t.turn) {
            t.paced = now + PACE;
            let i = t.turn;
            match t.kind.as_str() {
                "blackjack" => {
                    t.seats[i].stood = true;
                    self.advance_blackjack(&mut t);
                }
                "holdem" => {
                    let op = if t.seats[i].bet >= t.current {
                        "check"
                    } else {
                        "fold"
                    };
                    let _ = self.poker_action(&mut t, i, op, 0);
                    self.advance_poker(&mut t, i);
                }
                _ => {
                    let msg = if t.phase == "bid" {
                        json!({"bid":0})
                    } else if t.last_pattern.is_some() {
                        json!({})
                    } else {
                        json!({"cards":[t.seats[i].hand[0]]})
                    };
                    let op = if t.phase == "bid" {
                        "bid"
                    } else if t.last_pattern.is_some() {
                        "pass"
                    } else {
                        "play"
                    };
                    let _ = self.ddz_action(&mut t, i, op, &msg);
                }
            }
            self.revision += 1;
        }
        self.table = Some(t);
    }
    fn finish(&mut self, t: &mut Table, winners: &[usize], note: &str) {
        if t.phase == "finished" {
            return;
        }
        t.phase = "finished".into();
        t.note = note.into();
        t.winners = winners.iter().map(|i| t.seats[*i].id.clone()).collect();
        let prize = t.entrants as u64 * ENTRY * 80 / 100;
        for (i, s) in t.seats.iter().enumerate() {
            let reward = if winners.contains(&i) {
                prize / winners.len() as u64
            } else {
                0
            };
            self.receipt(s, reward, true);
        }
    }
    fn after_begin(&mut self, t: &mut Table) {
        if t.kind == "mahjong" {
            self.sync_mahjong(t);
            return;
        }
        if t.game.is_some() {
            self.sync_board(t);
            return;
        }
        if t.kind == "blackjack" {
            self.advance_blackjack(t);
        } else if t.kind == "holdem" {
            let after = (t.turn + t.seats.len() - 1) % t.seats.len();
            self.advance_poker(t, after);
        }
    }
    fn sync_board(&mut self, t: &mut Table) {
        let b = t.game.as_ref().unwrap();
        t.turn = b.turn();
        t.note = b.note();
        let winners = b.winners();
        let out: Vec<usize> = (0..t.seats.len())
            .filter(|i| t.seats[*i].alive && !b.alive(*i))
            .collect();
        for i in out {
            // Knocked out (bankrupt): settled at zero now, free to join another table.
            t.seats[i].alive = false;
            self.receipt(&t.seats[i], 0, true);
        }
        if let Some(winners) = winners {
            let note = t.note.clone();
            self.finish(t, &winners, &note);
        }
    }
    fn sync_mahjong(&mut self, t: &mut Table) {
        let m = t.mahjong.as_ref().unwrap();
        t.turn = m.turn;
        t.note = m.note.clone();
        for (i, s) in t.seats.iter_mut().enumerate() {
            s.alive = !m.won[i] && !m.left[i];
        }
        if m.finished {
            t.phase = "finished".into();
            t.winners = m
                .first_winners()
                .iter()
                .map(|i| t.seats[*i].id.clone())
                .collect();
            for (i, s) in t.seats.iter().enumerate() {
                self.receipt(s, m.payouts[i], true);
            }
        }
    }
    fn champion(&mut self, t: &mut Table) -> bool {
        let live: Vec<usize> = t
            .seats
            .iter()
            .enumerate()
            .filter(|(_, s)| s.alive && !s.left)
            .map(|(i, _)| i)
            .collect();
        if live.len() <= 1 {
            self.finish(
                t,
                &live,
                if live.is_empty() {
                    "所有玩家已弃权"
                } else {
                    "比赛结束，奖金已结算"
                },
            );
            true
        } else {
            false
        }
    }
    fn advance_blackjack(&mut self, t: &mut Table) {
        if self.champion(t) {
            return;
        }
        if let Some(i) = t.seats.iter().position(|s| s.alive && !s.left && !s.stood) {
            t.turn = i;
            return;
        }
        t.reveal = true;
        let best = t
            .seats
            .iter()
            .filter(|s| s.alive && !s.left)
            .map(|s| cards::blackjack(&s.hand))
            .filter(|v| *v <= 21)
            .max();
        if let Some(best) = best {
            for s in &mut t.seats {
                if s.alive && cards::blackjack(&s.hand) != best {
                    s.alive = false;
                    self.receipt(s, 0, true);
                }
            }
        }
        if self.champion(t) {
            return;
        }
        t.phase = "intermission".into();
        t.deadline = Instant::now() + Duration::from_secs(6);
        t.note = if best.is_none() {
            "全部爆牌，存活玩家重新发牌".into()
        } else {
            "最高点数平局，淘汰其余玩家后继续加赛".into()
        };
    }
    fn poker_action(
        &mut self,
        t: &mut Table,
        i: usize,
        op: &str,
        amount: u64,
    ) -> Result<(), String> {
        let s = &t.seats[i];
        let call = t.current.saturating_sub(s.bet);
        let max = s.bet + s.chips;
        let target = if op == "allin" { max } else { amount };
        match op {
            "fold" => t.seats[i].folded = true,
            "check" if call == 0 => {}
            "call" => {
                let n = call.min(t.seats[i].chips);
                t.pay(i, n);
            }
            "raise" | "allin" if target > t.current => {
                if !t.can_raise[i] {
                    return Err("不足额加注未重开加注权，只能跟注或弃牌".into());
                }
                if target > max || (target < t.current + t.min_raise && target != max) {
                    return Err("加注不足最小额度，或筹码不够".into());
                }
                let full = target >= t.current + t.min_raise;
                if full {
                    t.min_raise = target - t.current;
                }
                let n = target - t.seats[i].bet;
                t.pay(i, n);
                t.current = target;
                for j in 0..t.seats.len() {
                    if j != i && t.eligible(j) {
                        t.pending[j] = t.seats[j].bet < t.current;
                        if full {
                            t.can_raise[j] = true;
                        }
                    }
                }
            }
            "allin" => {
                let n = t.seats[i].chips;
                t.pay(i, n);
            }
            _ => return Err("当前不能这样下注".into()),
        }
        t.pending[i] = false;
        t.can_raise[i] = false;
        t.note = format!(
            "{}：{}",
            t.seats[i].name,
            match op {
                "fold" => "弃牌",
                "check" => "过牌",
                "call" => "跟注",
                "raise" => "加注",
                _ => "全下",
            }
        );
        Ok(())
    }
    fn advance_poker(&mut self, t: &mut Table, after: usize) {
        loop {
            let live: Vec<usize> = t
                .seats
                .iter()
                .enumerate()
                .filter(|(_, s)| s.alive && !s.folded && !s.left)
                .map(|(i, _)| i)
                .collect();
            if live.len() <= 1 {
                self.poker_award(t, &live);
                return;
            }
            let betting: Vec<usize> = (0..t.seats.len()).filter(|i| t.eligible(*i)).collect();
            if betting.len() == 1 && t.seats[betting[0]].bet >= t.current {
                t.pending[betting[0]] = false;
            }
            if let Some(j) = (1..=t.seats.len())
                .map(|d| (after + d) % t.seats.len())
                .find(|j| t.pending[*j] && t.eligible(*j))
            {
                t.turn = j;
                return;
            }
            if t.phase == "river" {
                self.poker_award(t, &live);
                return;
            }
            let deal = if t.phase == "preflop" { 3 } else { 1 };
            t.deck.pop(); // burn
            for _ in 0..deal {
                t.board.push(t.deck.pop().unwrap());
            }
            t.phase = match t.phase.as_str() {
                "preflop" => "flop",
                "flop" => "turn",
                _ => "river",
            }
            .into();
            t.current = 0;
            t.min_raise = t.blind();
            for j in 0..t.seats.len() {
                t.seats[j].bet = 0;
                t.pending[j] = t.eligible(j);
                t.can_raise[j] = t.eligible(j);
            }
            if betting.len() >= 2 {
                t.turn = t.next(t.button, |s| s.alive && !s.folded && !s.left && s.chips > 0);
                return;
            }
        }
    }
    fn poker_award(&mut self, t: &mut Table, live: &[usize]) {
        let mut levels: Vec<u64> = t
            .seats
            .iter()
            .map(|s| s.committed)
            .filter(|n| *n > 0)
            .collect();
        levels.sort();
        levels.dedup();
        let mut prev = 0;
        for level in levels {
            let contributors: Vec<usize> = (0..t.seats.len())
                .filter(|i| t.seats[*i].committed >= level)
                .collect();
            let amount = (level - prev) * contributors.len() as u64;
            prev = level;
            let contenders: Vec<usize> = live
                .iter()
                .copied()
                .filter(|i| t.seats[*i].committed >= level)
                .collect();
            let winners = if contributors.len() == 1 {
                contributors
            } else if contenders.len() <= 1 {
                contenders
            } else {
                let scores: Vec<(usize, u64)> = contenders
                    .iter()
                    .map(|i| {
                        let mut hand = t.board.clone();
                        hand.extend(&t.seats[*i].hand);
                        (*i, cards::poker(&hand))
                    })
                    .collect();
                let best = scores.iter().map(|(_, s)| *s).max().unwrap();
                scores
                    .iter()
                    .filter(|(_, s)| *s == best)
                    .map(|(i, _)| *i)
                    .collect()
            };
            if !winners.is_empty() {
                let mut winners = winners;
                winners.sort_by_key(|i| (i + t.seats.len() - t.button - 1) % t.seats.len());
                for (k, i) in winners.iter().enumerate() {
                    t.seats[*i].chips += amount / winners.len() as u64
                        + u64::from((k as u64) < amount % winners.len() as u64);
                }
            }
        }
        t.reveal = live.len() > 1;
        for s in &mut t.seats {
            if s.alive && s.chips == 0 {
                s.alive = false;
                self.receipt(s, 0, true);
            }
        }
        if self.champion(t) {
            return;
        }
        t.phase = "intermission".into();
        t.deadline = Instant::now() + Duration::from_secs(6);
        t.note = "本手结束，筹码已分配；淘汰者继续观战".into();
    }
    fn ddz_action(&mut self, t: &mut Table, i: usize, op: &str, msg: &Value) -> Result<(), String> {
        if t.phase == "bid" {
            if op != "bid" {
                return Err("请先叫地主".into());
            }
            let bid = msg["bid"]
                .as_u64()
                .filter(|n| *n <= 3 && (*n == 0 || *n > t.bid))
                .ok_or("叫分必须高于前一位，或选择不叫")?;
            if bid > 0 {
                t.bid = bid;
                t.bidder = Some(i);
            }
            t.bid_count += 1;
            if bid == 3 || t.bid_count == 3 {
                if let Some(l) = t.bidder {
                    t.landlord = Some(l);
                    t.seats[l].hand.extend(&t.bottom);
                    t.sort_hands();
                    t.turn = l;
                    t.phase = "play".into();
                    t.note = format!("{} 是地主，先出牌", t.seats[l].name);
                } else {
                    t.begin();
                    t.note = "都不叫，重新发牌".into();
                }
            } else {
                t.turn = (i + 1) % 3;
            }
            return Ok(());
        }
        if op == "pass" {
            if t.last_pattern.is_none() {
                return Err("新一轮必须出牌".into());
            }
            t.passes += 1;
            if t.passes == 2 {
                t.last_pattern = None;
                t.last.clear();
                t.passes = 0;
                t.turn = t.last_owner;
            } else {
                t.turn = (i + 1) % 3;
            }
        } else if op == "play" {
            let selected = msg["cards"]
                .as_array()
                .filter(|c| !c.is_empty() && c.len() <= 20)
                .ok_or("请选择 1–20 张手牌")?;
            let cards: Vec<u8> = selected
                .iter()
                .map(|c| {
                    c.as_u64()
                        .filter(|n| *n <= 53)
                        .map(|n| n as u8)
                        .ok_or("无效手牌")
                })
                .collect::<Result<_, _>>()?;
            if cards.iter().any(|c| !t.seats[i].hand.contains(c)) {
                return Err("只能出自己的牌".into());
            }
            let p = cards::pattern(&cards).ok_or("不支持的牌型，请重新选牌")?;
            if t.last_pattern
                .as_ref()
                .is_some_and(|last| !cards::beats(&p, last))
            {
                return Err("出牌必须大于上一手，或选择不出".into());
            }
            t.seats[i].hand.retain(|c| !cards.contains(c));
            t.last = cards;
            t.last_pattern = Some(p);
            t.last_owner = i;
            t.passes = 0;
            t.turn = (i + 1) % 3;
            if t.seats[i].hand.is_empty() {
                let l = t.landlord.unwrap();
                let winners: Vec<usize> = (0..3)
                    .filter(|j| if i == l { *j == l } else { *j != l })
                    .collect();
                self.finish(
                    t,
                    &winners,
                    if i == l {
                        "地主获胜"
                    } else {
                        "农民获胜，奖金平分"
                    },
                );
            }
        } else {
            return Err("请选择出牌或不出".into());
        }
        Ok(())
    }
}
impl Table {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            seats: vec![],
            phase: "lobby".into(),
            turn: 0,
            round: 0,
            deck: vec![],
            board: vec![],
            button: 0,
            current: 0,
            min_raise: 20,
            pending: vec![],
            can_raise: vec![],
            deadline: Instant::now(),
            paced: Instant::now(),
            landlord: None,
            bid: 0,
            bidder: None,
            bid_count: 0,
            last: vec![],
            last_pattern: None,
            last_owner: 0,
            passes: 0,
            bottom: vec![],
            note: "等待报名，第一位报名者可开始游戏".into(),
            winners: vec![],
            reveal: false,
            entrants: 0,
            mahjong: None,
            game: None,
        }
    }
    fn next(&self, after: usize, predicate: impl Fn(&Seat) -> bool) -> usize {
        (1..=self.seats.len())
            .map(|d| (after + d) % self.seats.len())
            .find(|i| predicate(&self.seats[*i]))
            .unwrap_or(after)
    }
    fn blind(&self) -> u64 {
        20u64 << ((self.round.saturating_sub(1) / 8).min(10))
    }
    fn eligible(&self, i: usize) -> bool {
        let s = &self.seats[i];
        s.alive && !s.left && !s.folded && s.chips > 0
    }
    fn pay(&mut self, i: usize, n: u64) {
        let s = &mut self.seats[i];
        s.chips -= n;
        s.bet += n;
        s.committed += n;
    }
    fn sort_hands(&mut self) {
        for s in &mut self.seats {
            s.hand.sort_by_key(|c| (cards::ddz_rank(*c), *c));
        }
    }
    fn begin(&mut self) {
        self.round += 1;
        self.reveal = false;
        self.board.clear();
        self.last.clear();
        self.last_pattern = None;
        self.passes = 0;
        self.deck = cards::deck(self.kind == "ddz");
        if self.kind == "blackjack" {
            for _ in 0..5 {
                self.deck.extend(cards::deck(false));
            }
        }
        for s in &mut self.seats {
            s.hand.clear();
            s.folded = !s.alive || s.left;
            s.stood = !s.alive || s.left;
            s.bet = 0;
            s.committed = 0;
        }
        self.pending = vec![false; self.seats.len()];
        self.can_raise = vec![true; self.seats.len()];
        let names: Vec<String> = self.seats.iter().map(|s| s.name.clone()).collect();
        match self.kind.as_str() {
            "mahjong" => {
                self.phase = "mahjong".into();
                self.mahjong = Some(crate::mahjong::Mahjong::new());
            }
            "flight" => {
                self.phase = "flight".into();
                self.game = Some(Box::new(crate::flight::Flight::new(names)));
            }
            "xiangqi" => {
                self.phase = "xiangqi".into();
                self.game = Some(Box::new(crate::xiangqi::Xiangqi::new()));
            }
            "monopoly" => {
                self.phase = "monopoly".into();
                self.game = Some(Box::new(crate::monopoly::Monopoly::new(names)));
            }
            "blackjack" => {
                self.phase = "blackjack".into();
                for s in &mut self.seats {
                    if s.alive && !s.left {
                        for _ in 0..2 {
                            s.hand.push(self.deck.pop().unwrap());
                        }
                        s.stood = cards::blackjack(&s.hand) == 21;
                    }
                }
                self.turn = self
                    .seats
                    .iter()
                    .position(|s| s.alive && !s.stood)
                    .unwrap_or(0);
                self.note = "轮流要牌或停牌，最高的不爆牌点数晋级".into();
            }
            "holdem" => {
                self.phase = "preflop".into();
                if self.round > 1 {
                    self.button = self.next(self.button, |s| s.alive && !s.left);
                }
                let live = self.seats.iter().filter(|s| s.alive && !s.left).count();
                for _ in 0..2 {
                    for s in &mut self.seats {
                        if s.alive && !s.left {
                            s.hand.push(self.deck.pop().unwrap());
                        }
                    }
                }
                let sb = if live == 2 {
                    self.button
                } else {
                    self.next(self.button, |s| s.alive && !s.left)
                };
                let bb = self.next(sb, |s| s.alive && !s.left);
                let blind = self.blind();
                self.pay(sb, (blind / 2).min(self.seats[sb].chips));
                self.pay(bb, blind.min(self.seats[bb].chips));
                self.current = blind;
                self.min_raise = blind;
                for i in 0..self.seats.len() {
                    self.pending[i] = self.eligible(i);
                }
                self.turn = self.next(bb, |s| s.alive && !s.left && s.chips > 0);
                self.note = format!("盲注 {}/{} · 每 8 手提升", blind / 2, blind);
            }
            _ => {
                self.phase = "bid".into();
                self.landlord = None;
                self.bid = 0;
                self.bidder = None;
                self.bid_count = 0;
                for _ in 0..17 {
                    for s in &mut self.seats {
                        s.hand.push(self.deck.pop().unwrap());
                    }
                }
                self.bottom = self.deck.drain(..).collect();
                self.sort_hands();
                self.turn = (self.round as usize - 1) % 3;
                self.note = "轮流叫地主：不叫、1 分、2 分或 3 分".into();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    type Games = SingleGame;
    #[test]
    fn mahjong_settlement_is_final_once_and_consumes_exactly_twenty_percent() {
        let mut g = Games::default();
        for id in ["a", "b", "c", "d"] {
            join(&mut g, id, "mahjong");
        }
        g.command("a", "a", &json!({"epoch":g.epoch,"op":"start"}), 0)
            .unwrap();
        for id in ["b", "c", "d"] {
            g.command(id, id, &json!({"epoch":g.epoch,"op":"leave"}), 0)
                .unwrap();
        }
        assert_eq!(g.snapshot("a")["table"]["phase"], "finished");
        assert_eq!(g.offset("a"), 1100);
        assert_eq!(
            ["a", "b", "c", "d"]
                .iter()
                .map(|id| g.offset(id))
                .sum::<i64>(),
            -400
        );
        let revision = g.revision;
        g.tick(&|_| true);
        assert_eq!(g.revision, revision);
        assert_eq!(g.offset("a"), 1100);
    }
    fn start(g: &mut Games, ids: &[&str], kind: &str) {
        for id in ids {
            join(g, id, kind);
        }
        g.command(ids[0], ids[0], &json!({"epoch":g.epoch,"op":"start"}), 0)
            .unwrap();
    }
    fn act(g: &mut Games, id: &str, extra: Value) -> Result<(), String> {
        let mut msg = json!({"epoch":g.epoch,"revision":g.revision});
        for (k, v) in extra.as_object().unwrap() {
            msg[k] = v.clone();
        }
        g.command(id, id, &msg, 0)
    }
    #[test]
    fn board_games_check_seat_counts_and_share_the_prize() {
        let mut g = Games::default();
        join(&mut g, "a", "xiangqi");
        assert!(g
            .command("a", "a", &json!({"epoch":g.epoch,"op":"start"}), 0)
            .is_err());
        join(&mut g, "b", "xiangqi");
        assert!(g
            .command(
                "c",
                "c",
                &json!({"epoch":g.epoch,"op":"join","kind":"xiangqi","ticket":format!("{:0>32}", "c")}),
                500
            )
            .is_err());
        g.command("a", "a", &json!({"epoch":g.epoch,"op":"start"}), 0)
            .unwrap();
        let view = g.snapshot("a");
        assert_eq!(view["table"]["xiangqi"]["moves"].as_array().unwrap().len(), 44);
        assert!(view["table"]["canAct"].as_bool().unwrap());
        assert!(g.snapshot("b")["table"]["xiangqi"]["moves"]
            .as_array()
            .unwrap()
            .is_empty());
        // Stale clicks must not move a piece; the current revision does.
        let mv = json!({"op":"move","from":64,"to":67});
        assert!(g
            .command("a", "a", &json!({"epoch":g.epoch,"op":"move","from":64,"to":67,"revision":0}), 0)
            .is_err());
        act(&mut g, "a", mv).unwrap();
        act(&mut g, "a", json!({"op":"draw"})).unwrap();
        act(&mut g, "b", json!({"op":"draw"})).unwrap();
        assert_eq!(g.snapshot("a")["table"]["phase"], "finished");
        assert_eq!((g.offset("a"), g.offset("b")), (-100, -100));
    }
    #[test]
    fn quitting_a_board_game_forfeits_the_ticket() {
        let mut g = Games::default();
        start(&mut g, &["a", "b", "c"], "flight");
        assert!(g.snapshot("z")["table"]["flight"]["players"].is_array());
        act(&mut g, "b", json!({"op":"leave"})).unwrap();
        assert_eq!(g.offset("b"), -500);
        assert!(g.receipts["b"].final_);
        act(&mut g, "a", json!({"op":"leave"})).unwrap();
        assert_eq!(g.snapshot("c")["table"]["winners"], json!(["c"]));
        assert_eq!(g.offset("c"), 700);
    }
    #[test]
    fn monopoly_plays_to_the_end_with_stand_ins_and_settles_once() {
        let mut g = Games::default();
        start(&mut g, &["a", "b", "c"], "monopoly");
        assert_eq!(g.snapshot("a")["table"]["monopoly"]["phase"], "pick");
        // Picks happen together, so an older revision is accepted for them.
        g.command("a", "a", &json!({"epoch":g.epoch,"op":"pick","character":0,"revision":0}), 0)
            .unwrap();
        assert!(act(&mut g, "b", json!({"op":"pick","character":0})).is_err());
        act(&mut g, "c", json!({"op":"leave"})).unwrap();
        for _ in 0..5000 {
            if g.table.as_ref().unwrap().phase == "finished" {
                break;
            }
            g.table.as_mut().unwrap().paced = Instant::now();
            g.tick(&|_| true);
        }
        let v = g.snapshot("a");
        assert_eq!(v["table"]["phase"], "finished");
        assert_eq!(v["table"]["monopoly"]["finished"], true);
        assert_eq!(g.offset("c"), -500);
        assert_eq!(
            ["a", "b", "c"].iter().map(|id| g.offset(id)).sum::<i64>(),
            -300
        );
    }
    fn join(g: &mut Games, id: &str, kind: &str) {
        g.command(
            id,
            id,
            &json!({"epoch":g.epoch,"op":"join","kind":kind,"ticket":format!("{id:0>32}")}),
            500,
        )
        .unwrap();
    }
    fn setup(kind: &str) -> Games {
        let mut g = Games::default();
        for id in ["a", "b", "c"] {
            join(&mut g, id, kind);
        }
        g
    }
    #[test]
    fn tickets_authority_and_private_hands() {
        let mut g = setup("holdem");
        assert_eq!(g.offset("a"), -500);
        join(&mut g, "a", "holdem");
        assert_eq!(g.offset("a"), -500);
        let start = json!({"epoch":g.epoch,"op":"start"});
        assert!(g.command("b", "b", &start, 500).is_err());
        g.command("a", "a", &start, 500).unwrap();
        let a = g.snapshot("a");
        assert_eq!(a["table"]["seats"][0]["cards"].as_array().unwrap().len(), 2);
        assert!(a["table"]["seats"][1]["cards"].is_null());
        let spectator = g.snapshot("z");
        assert!(spectator["table"]["seats"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["cards"].is_null()));
    }
    #[test]
    fn withdraw_and_first_seat_transfer() {
        let mut g = setup("ddz");
        g.command("a", "a", &json!({"epoch":g.epoch,"op":"leave"}), 0)
            .unwrap();
        assert_eq!(g.offset("a"), 0);
        assert_eq!(g.snapshot("b")["table"]["host"], "b");
    }
    #[test]
    fn landlord_team_prizes() {
        let mut g = setup("ddz");
        let mut t = g.table.take().unwrap();
        t.landlord = Some(0);
        g.finish(&mut t, &[1, 2], "农民获胜");
        assert_eq!(g.offset("a"), -500);
        assert_eq!(g.offset("b"), 100);
        assert_eq!(g.offset("c"), 100);
        g.finish(&mut t, &[1, 2], "duplicate");
        assert_eq!(g.offset("b"), 100);
    }
    #[test]
    fn poker_sidepots_conserve_chips() {
        let mut g = setup("holdem");
        let mut t = g.table.take().unwrap();
        t.begin();
        t.board = vec![0, 2, 4, 6, 8];
        for (i, s) in t.seats.iter_mut().enumerate() {
            s.committed = [100, 200, 300][i];
            s.chips = 1000 - s.committed;
            s.hand = vec![12 + i as u8, 25 + i as u8];
        }
        g.poker_award(&mut t, &[0, 1, 2]);
        assert_eq!(t.seats.iter().map(|s| s.chips).sum::<u64>(), 3000);
    }
    #[test]
    fn blackjack_eliminates_lower_scores_and_replays_ties() {
        let mut g = setup("blackjack");
        let mut t = g.table.take().unwrap();
        t.begin();
        for (i, s) in t.seats.iter_mut().enumerate() {
            s.hand = if i == 2 { vec![7, 8] } else { vec![12, 8] };
            s.stood = true;
        }
        g.advance_blackjack(&mut t);
        assert!(!t.seats[2].alive);
        assert_eq!(t.phase, "intermission");
        t.seats[0].hand = vec![12, 8];
        t.seats[1].hand = vec![7, 8];
        g.advance_blackjack(&mut t);
        assert_eq!(t.phase, "finished");
        assert_eq!(t.winners, vec!["a"]);
        assert_eq!(g.offset("a"), 700);
        assert_eq!(g.offset("b"), -500);
    }
    #[test]
    fn blackjack_all_bust_replays_without_charging_again() {
        let mut g = setup("blackjack");
        let mut t = g.table.take().unwrap();
        t.begin();
        for s in &mut t.seats {
            s.hand = vec![8, 9, 10];
            s.stood = true;
        }
        g.advance_blackjack(&mut t);
        assert_eq!(t.phase, "intermission");
        assert!(t.seats.iter().all(|s| s.alive));
        assert_eq!(g.offset("a"), -500);
    }
    #[test]
    fn poker_minimum_raise_and_short_allin_dont_reopen_action() {
        let mut g = setup("holdem");
        let mut t = g.table.take().unwrap();
        t.begin();
        assert!(g.poker_action(&mut t, 0, "raise", 30).is_err());
        g.poker_action(&mut t, 0, "raise", 60).unwrap();
        assert_eq!(t.min_raise, 40);
        t.seats[1].chips = 60 - t.seats[1].bet + 10;
        g.poker_action(&mut t, 1, "allin", 0).unwrap();
        assert_eq!(t.current, 70);
        assert!(!t.can_raise[0]);
        assert!(t.pending[0]);
        assert!(t.can_raise[2]);
        assert!(g.poker_action(&mut t, 0, "raise", 110).is_err());
    }
    #[test]
    fn poker_tied_sidepot_splits_and_returns_uncalled_chips() {
        let mut g = setup("holdem");
        let mut t = g.table.take().unwrap();
        t.begin();
        t.phase = "river".into();
        t.board = vec![8, 9, 10, 11, 12];
        for (i, s) in t.seats.iter_mut().enumerate() {
            s.hand = vec![13 + i as u8, 26 + i as u8];
            s.committed = [100, 200, 300][i];
            s.chips = 1000 - s.committed;
        }
        g.poker_award(&mut t, &[0, 1, 2]);
        assert_eq!(
            t.seats.iter().map(|s| s.chips).collect::<Vec<_>>(),
            vec![1000, 1000, 1000]
        );
    }
    #[test]
    fn ddz_turns_passes_and_team_win() {
        let mut g = setup("ddz");
        let mut t = g.table.take().unwrap();
        t.begin();
        g.ddz_action(&mut t, 0, "bid", &json!({"bid":3})).unwrap();
        assert_eq!(t.landlord, Some(0));
        assert_eq!(t.seats[0].hand.len(), 20);
        assert_eq!(t.bottom.len(), 3);
        t.seats[0].hand = vec![1, 3];
        t.seats[1].hand = vec![2, 4];
        t.seats[2].hand = vec![5, 6];
        g.ddz_action(&mut t, 0, "play", &json!({"cards":[1]}))
            .unwrap();
        g.ddz_action(&mut t, 1, "pass", &json!({})).unwrap();
        g.ddz_action(&mut t, 2, "pass", &json!({})).unwrap();
        assert_eq!(t.turn, 0);
        assert!(t.last_pattern.is_none());
        assert!(g.ddz_action(&mut t, 0, "pass", &json!({})).is_err());
        g.ddz_action(&mut t, 0, "play", &json!({"cards":[3]}))
            .unwrap();
        assert_eq!(t.phase, "finished");
        assert_eq!(g.offset("a"), 700);
    }
    #[test]
    fn present_players_are_never_hurried_and_stale_actions_are_rejected() {
        let mut g = setup("blackjack");
        g.command("a", "a", &json!({"epoch":g.epoch,"op":"start"}), 0)
            .unwrap();
        // Make deterministic hands that are not natural 21s.
        let t = g.table.as_mut().unwrap();
        for s in &mut t.seats {
            s.hand = vec![1, 2];
            s.stood = false;
        }
        t.turn = 0;
        let revision = g.revision;
        g.tick(&|_| false);
        assert!(!g.table.as_ref().unwrap().seats[0].stood);
        assert_eq!(g.revision, revision);
        g.tick(&|id| id == "a");
        assert!(g.table.as_ref().unwrap().seats[0].stood);
        assert!(g.revision > revision);
        assert!(g
            .command(
                "b",
                "b",
                &json!({"epoch":g.epoch,"op":"hit","revision":revision}),
                0
            )
            .is_err());
    }
    #[test]
    fn holdem_automatic_tournament_eventually_finishes_and_conserves_chips() {
        let mut g = setup("holdem");
        g.command("a", "a", &json!({"epoch":g.epoch,"op":"start"}), 0)
            .unwrap();
        for _ in 0..5000 {
            if g.table.as_ref().unwrap().phase == "finished" {
                break;
            }
            let t = g.table.as_mut().unwrap();
            t.deadline = Instant::now();
            t.paced = Instant::now();
            g.tick(&|_| true);
            assert_eq!(
                g.table
                    .as_ref()
                    .unwrap()
                    .seats
                    .iter()
                    .map(|s| s.chips + s.committed)
                    .sum::<u64>(),
                if g.table.as_ref().unwrap().phase == "intermission"
                    || g.table.as_ref().unwrap().phase == "finished"
                {
                    3000 + g
                        .table
                        .as_ref()
                        .unwrap()
                        .seats
                        .iter()
                        .map(|s| s.committed)
                        .sum::<u64>()
                } else {
                    3000
                }
            );
        }
        assert_eq!(g.table.as_ref().unwrap().phase, "finished");
        assert_eq!(g.table.as_ref().unwrap().winners.len(), 1);
    }
}
