//! Four-player Sichuan blood battle. Entry/prizes are fixed; tile actions never
//! spend wallet points. Physical tile IDs keep concealed information private.
use serde_json::{json, Value};

const PRIZES: [u64; 4] = [700, 550, 350, 0];
#[derive(Clone)]
struct Meld {
    tiles: Vec<u8>,
    concealed: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum Claim {
    Pass,
    Peng,
    Gang,
    Hu,
}
struct Response {
    source: usize,
    tile: u8,
    rob: Option<usize>,
    choices: [Option<Claim>; 4],
}
pub struct Mahjong {
    hands: [Vec<u8>; 4],
    wall: Vec<u8>,
    melds: [Vec<Meld>; 4],
    rivers: [Vec<u8>; 4],
    exchanged: [bool; 4],
    exchange: [Vec<u8>; 4],
    missing: [Option<u8>; 4],
    pub won: [bool; 4],
    pub left: [bool; 4],
    ranks: Vec<Vec<usize>>,
    win_tiles: [Option<u8>; 4],
    pub turn: usize,
    pub note: String,
    pub finished: bool,
    phase: &'static str,
    response: Option<Response>,
    pub payouts: [u64; 4],
}
fn kind(tile: u8) -> usize {
    tile as usize / 4
}
fn suit(tile: u8) -> u8 {
    (kind(tile) / 9) as u8
}
fn remove(hand: &mut Vec<u8>, tile: u8) {
    let i = hand.iter().position(|t| *t == tile).unwrap();
    hand.remove(i);
}
fn groups(n: &mut [u8; 27]) -> bool {
    let Some(i) = n.iter().position(|x| *x > 0) else {
        return true;
    };
    if n[i] >= 3 {
        n[i] -= 3;
        if groups(n) {
            n[i] += 3;
            return true;
        }
        n[i] += 3;
    }
    if i % 9 <= 6 && n[i + 1] > 0 && n[i + 2] > 0 {
        n[i] -= 1;
        n[i + 1] -= 1;
        n[i + 2] -= 1;
        let ok = groups(n);
        n[i] += 1;
        n[i + 1] += 1;
        n[i + 2] += 1;
        if ok {
            return true;
        }
    }
    false
}
pub fn winning(hand: &[u8], melds: usize, missing: u8) -> bool {
    if hand.len() != 14 - 3 * melds || hand.iter().any(|t| suit(*t) == missing) {
        return false;
    }
    let mut n = [0u8; 27];
    for t in hand {
        n[kind(*t)] += 1;
        if n[kind(*t)] > 4 {
            return false;
        }
    }
    if melds == 0 && n.iter().all(|x| x % 2 == 0) {
        return true;
    }
    for i in 0..27 {
        if n[i] >= 2 {
            n[i] -= 2;
            let ok = groups(&mut n);
            n[i] += 2;
            if ok {
                return true;
            }
        }
    }
    false
}
impl Mahjong {
    pub fn new() -> Self {
        let mut wall: Vec<u8> = (0..108).collect();
        for i in (1..wall.len()).rev() {
            let bound = (i + 1) as u32;
            let limit = u32::MAX - u32::MAX % bound;
            let j = loop {
                let mut b = [0; 4];
                getrandom::fill(&mut b).expect("OS random");
                let n = u32::from_le_bytes(b);
                if n < limit {
                    break (n % bound) as usize;
                }
            };
            wall.swap(i, j);
        }
        let mut hands: [Vec<u8>; 4] = std::array::from_fn(|_| vec![]);
        for _ in 0..13 {
            for hand in &mut hands {
                hand.push(wall.pop().unwrap());
            }
        }
        hands[0].push(wall.pop().unwrap());
        for h in &mut hands {
            h.sort();
        }
        Self {
            hands,
            wall,
            melds: std::array::from_fn(|_| vec![]),
            rivers: std::array::from_fn(|_| vec![]),
            exchanged: [false; 4],
            exchange: std::array::from_fn(|_| vec![]),
            missing: [None; 4],
            won: [false; 4],
            left: [false; 4],
            ranks: vec![],
            win_tiles: [None; 4],
            turn: 0,
            note: "先选三张同花色的牌，交换给下家，然后定缺".into(),
            finished: false,
            phase: "exchange",
            response: None,
            payouts: [0; 4],
        }
    }
    pub fn first_winners(&self) -> Vec<usize> {
        self.ranks.first().cloned().unwrap_or_default()
    }
    fn active(&self, i: usize) -> bool {
        !self.won[i] && !self.left[i]
    }
    fn next(&self, i: usize) -> usize {
        (1..=4)
            .map(|d| (i + d) % 4)
            .find(|j| self.active(*j))
            .unwrap_or(i)
    }
    fn can_hu(&self, i: usize, tile: Option<u8>) -> bool {
        if !self.active(i) {
            return false;
        }
        let Some(missing) = self.missing[i] else {
            return false;
        };
        let mut h = self.hands[i].clone();
        if let Some(t) = tile {
            if self.hands[i]
                .iter()
                .filter(|x| kind(**x) == kind(t))
                .count()
                + self.melds[i]
                    .iter()
                    .flat_map(|m| m.tiles.iter())
                    .filter(|x| kind(**x) == kind(t))
                    .count()
                >= 4
            {
                return false;
            }
            h.push(t);
        }
        winning(&h, self.melds[i].len(), missing)
    }
    fn count(&self, i: usize, tile: u8) -> usize {
        self.hands[i]
            .iter()
            .filter(|t| kind(**t) == kind(tile))
            .count()
    }
    fn options(&self, i: usize, r: &Response) -> Vec<&'static str> {
        if i == r.source || !self.active(i) {
            return vec![];
        }
        let mut opts = vec![];
        if self.can_hu(i, Some(r.tile)) {
            opts.push("hu");
        }
        if r.rob.is_none() && self.missing[i] != Some(suit(r.tile)) {
            if self.count(i, r.tile) >= 2 {
                opts.push("peng");
            }
            if self.count(i, r.tile) >= 3 && !self.wall.is_empty() {
                opts.push("gang");
            }
        }
        opts
    }
    pub fn can_act(&self, i: usize) -> bool {
        if !self.active(i) || self.finished {
            return false;
        }
        match self.phase {
            "exchange" => !self.exchanged[i],
            "que" => self.missing[i].is_none(),
            "discard" => i == self.turn,
            "response" => self
                .response
                .as_ref()
                .is_some_and(|r| r.choices[i].is_none()),
            _ => false,
        }
    }
    pub fn accepts_stale(&self, msg: &Value) -> bool {
        msg["mjPhase"].as_str() == Some(self.phase)
            && match self.phase {
                "exchange" | "que" => true,
                "response" => self.response.as_ref().is_some_and(|r| {
                    msg["claimTile"].as_u64() == Some(r.tile as u64)
                        && msg["claimSource"].as_u64() == Some(r.source as u64)
                }),
                _ => false,
            }
    }
    pub fn snapshot(&self, viewer: Option<usize>) -> Value {
        let opts = viewer.map_or(vec![], |i| {
            if !self.can_act(i) {
                return vec![];
            }
            match self.phase {
                "exchange" => vec!["exchange"],
                "que" => vec!["que"],
                "response" => {
                    let mut v = self.options(i, self.response.as_ref().unwrap());
                    v.push("pass");
                    v
                }
                _ => {
                    let mut v = vec!["discard"];
                    if self.can_hu(i, None) {
                        v.push("hu");
                    }
                    v
                }
            }
        });
        let gangs = viewer
            .filter(|i| self.can_act(*i) && self.phase == "discard" && !self.wall.is_empty())
            .map_or(vec![], |i| {
                (0..27)
                    .filter(|k| {
                        self.missing[i] != Some((k / 9) as u8)
                            && (self.hands[i].iter().filter(|t| kind(**t) == *k).count() == 4
                                || (self.hands[i].iter().any(|t| kind(*t) == *k)
                                    && self.melds[i]
                                        .iter()
                                        .any(|m| m.tiles.len() == 3 && kind(m.tiles[0]) == *k)))
                    })
                    .collect::<Vec<_>>()
            });
        json!({"phase":self.phase,"wall":self.wall.len(),"turn":self.turn,"actions":opts,"gangs":gangs,"note":self.note,"finished":self.finished,
            "claim":self.response.as_ref().map(|r|json!({"source":r.source,"tile":r.tile,"rob":r.rob.is_some()})),
            "players":(0..4).map(|i|json!({"hand":if viewer==Some(i)||self.won[i]||self.finished{Some(&self.hands[i])}else{None},"count":self.hands[i].len(),"missing":self.missing[i],"won":self.won[i],"left":self.left[i],"exchanged":self.exchanged[i],"river":self.rivers[i],"winTile":self.win_tiles[i],"payout":self.payouts[i],"rank":self.ranks.iter().position(|g|g.contains(&i)).map(|g|1+self.ranks[..g].iter().map(|g|g.len()).sum::<usize>()),"melds":self.melds[i].iter().map(|m|json!({"count":m.tiles.len(),"concealed":m.concealed,"tiles":if m.concealed&&viewer!=Some(i)&&!self.finished{None}else{Some(&m.tiles)}})).collect::<Vec<_>>()})).collect::<Vec<_>>()})
    }
    pub fn command(&mut self, i: usize, msg: &Value) -> Result<(), String> {
        if !self.can_act(i) {
            return Err("请等待其他玩家操作".into());
        }
        let op = msg["op"].as_str().unwrap_or("");
        match self.phase {
            "exchange" => {
                if op != "exchange" {
                    return Err("先选择三张同花色的手牌".into());
                }
                let a = msg["tiles"]
                    .as_array()
                    .filter(|a| a.len() == 3)
                    .ok_or("须选择三张同花色的牌")?;
                let a: Vec<u8> = a
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .filter(|v| *v < 108)
                            .map(|v| v as u8)
                            .ok_or("无效手牌")
                    })
                    .collect::<Result<_, _>>()?;
                if a.iter()
                    .any(|t| !self.hands[i].contains(t) || suit(*t) != suit(a[0]))
                    || a[0] == a[1]
                    || a[0] == a[2]
                    || a[1] == a[2]
                {
                    return Err("须选择自己三张不同的同花色手牌".into());
                }
                self.exchange[i] = a;
                self.exchanged[i] = true;
                if self.exchanged.iter().all(|x| *x) {
                    for j in 0..4 {
                        for t in self.exchange[j].clone() {
                            remove(&mut self.hands[j], t);
                        }
                    }
                    for j in 0..4 {
                        self.hands[(j + 1) % 4].extend(&self.exchange[j]);
                    }
                    for h in &mut self.hands {
                        h.sort();
                    }
                    self.phase = "que";
                    self.note = "请选择本局要打缺的花色：万、筒或条".into();
                }
            }
            "que" => {
                if op != "que" {
                    return Err("请先定缺".into());
                }
                let s = msg["suit"]
                    .as_u64()
                    .filter(|s| *s < 3)
                    .ok_or("请选择万、筒或条")?;
                self.missing[i] = Some(s as u8);
                if self.missing.iter().all(Option::is_some) {
                    self.phase = "discard";
                    self.turn = if self.active(0) { 0 } else { self.next(0) };
                    self.note = "定缺完成，庄家先出牌；缺门的牌必须先打".into();
                    if self.turn != 0 {
                        self.draw(self.turn, false);
                    }
                }
            }
            "response" => {
                let r = self.response.as_ref().unwrap();
                let opts = self.options(i, r);
                let c = match op {
                    "pass" => Claim::Pass,
                    "hu" if opts.contains(&"hu") => Claim::Hu,
                    "peng" if opts.contains(&"peng") => Claim::Peng,
                    "gang" if opts.contains(&"gang") => Claim::Gang,
                    _ => return Err("这张牌不能这样操作".into()),
                };
                self.response.as_mut().unwrap().choices[i] = Some(c);
                if self
                    .response
                    .as_ref()
                    .unwrap()
                    .choices
                    .iter()
                    .all(Option::is_some)
                {
                    self.resolve();
                }
            }
            "discard" => match op {
                "hu" => {
                    if !self.can_hu(i, None) {
                        return Err("当前还不能胡牌，请先打完缺门".into());
                    }
                    self.record_wins(vec![i]);
                    if !self.finished {
                        self.draw(self.next(i), false);
                    }
                }
                "discard" => {
                    let t = msg["tile"]
                        .as_u64()
                        .filter(|t| *t < 108)
                        .map(|t| t as u8)
                        .ok_or("请选择要打出的牌")?;
                    if !self.hands[i].contains(&t) {
                        return Err("只能打自己的手牌".into());
                    }
                    if self.hands[i]
                        .iter()
                        .any(|x| Some(suit(*x)) == self.missing[i])
                        && Some(suit(t)) != self.missing[i]
                    {
                        return Err("须先打缺门的牌".into());
                    }
                    remove(&mut self.hands[i], t);
                    self.rivers[i].push(t);
                    self.offer(i, t, None);
                }
                "gang" => {
                    let k = msg["tileKind"]
                        .as_u64()
                        .filter(|n| *n < 27)
                        .ok_or("请选择杠牌")? as usize;
                    if self.wall.is_empty() || self.missing[i] == Some((k / 9) as u8) {
                        return Err("当前不能杠这门牌".into());
                    }
                    let tiles: Vec<u8> = self.hands[i]
                        .iter()
                        .copied()
                        .filter(|t| kind(*t) == k)
                        .collect();
                    if tiles.len() == 4 {
                        for t in &tiles {
                            remove(&mut self.hands[i], *t);
                        }
                        self.melds[i].push(Meld {
                            tiles,
                            concealed: true,
                        });
                        self.draw(i, true);
                    } else if let Some(m) = self.melds[i]
                        .iter()
                        .position(|m| m.tiles.len() == 3 && kind(m.tiles[0]) == k)
                    {
                        let t = *tiles.first().ok_or("没有补杠的手牌")?;
                        self.offer(i, t, Some(m));
                    } else {
                        return Err("没有可杠的四张牌或可补杠的碰牌".into());
                    }
                }
                _ => return Err("请选择出牌、杠或胡牌".into()),
            },
            _ => return Err("本局已结束".into()),
        }
        Ok(())
    }
    fn offer(&mut self, source: usize, tile: u8, rob: Option<usize>) {
        let mut r = Response {
            source,
            tile,
            rob,
            choices: [Some(Claim::Pass); 4],
        };
        for i in 0..4 {
            if !self.options(i, &r).is_empty() {
                r.choices[i] = None;
            }
        }
        let complete = r.choices.iter().all(Option::is_some);
        self.response = Some(r);
        self.phase = "response";
        self.note = if rob.is_some() {
            "等待抢杠胡回应"
        } else {
            "等待碰、杠、胡回应；胡牌优先，支持一炮多响"
        }
        .into();
        if complete {
            self.resolve();
        }
    }
    fn resolve(&mut self) {
        let r = self.response.take().unwrap();
        let winners: Vec<usize> = (1..=3)
            .map(|d| (r.source + d) % 4)
            .filter(|i| r.choices[*i] == Some(Claim::Hu))
            .collect();
        if !winners.is_empty() {
            if r.rob.is_some() {
                remove(&mut self.hands[r.source], r.tile);
                self.rivers[r.source].push(r.tile);
            }
            for i in &winners {
                self.win_tiles[*i] = Some(r.tile);
            }
            self.record_wins(winners.clone());
            if !self.finished {
                self.draw(self.next(*winners.last().unwrap()), false);
            }
            return;
        }
        if let Some(m) = r.rob {
            remove(&mut self.hands[r.source], r.tile);
            self.melds[r.source][m].tiles.push(r.tile);
            if self.active(r.source) {
                self.draw(r.source, true);
            } else {
                self.draw(self.next(r.source), false);
            }
            return;
        }
        if let Some(i) = (1..=3)
            .map(|d| (r.source + d) % 4)
            .find(|i| matches!(r.choices[*i], Some(Claim::Peng | Claim::Gang)))
        {
            let count = if r.choices[i] == Some(Claim::Gang) {
                3
            } else {
                2
            };
            let mut tiles: Vec<u8> = self.hands[i]
                .iter()
                .copied()
                .filter(|t| kind(*t) == kind(r.tile))
                .take(count)
                .collect();
            for t in &tiles {
                remove(&mut self.hands[i], *t);
            }
            self.rivers[r.source].pop();
            tiles.push(r.tile);
            self.melds[i].push(Meld {
                tiles,
                concealed: false,
            });
            self.turn = i;
            if count == 3 {
                self.draw(i, true);
            } else {
                self.phase = "discard";
                self.note = "碰牌后请出一张手牌".into();
            }
            return;
        }
        self.draw(self.next(r.source), false);
    }
    fn draw(&mut self, i: usize, kong: bool) {
        if self.wall.is_empty() {
            self.finish();
            return;
        }
        let tile = if kong {
            self.wall.remove(0)
        } else {
            self.wall.pop().unwrap()
        };
        self.hands[i].push(tile);
        self.hands[i].sort();
        self.turn = i;
        self.phase = "discard";
        self.note = if kong {
            "杠后补牌，请出牌或自摸"
        } else {
            "轮到当前玩家出牌；可胡牌时点胡"
        }
        .into();
    }
    fn record_wins(&mut self, winners: Vec<usize>) {
        for i in &winners {
            self.won[*i] = true;
        }
        self.ranks.push(winners);
        self.note = "有人胡牌，已胡玩家观战，其余人继续血战".into();
        self.calculate();
        if (0..4).filter(|i| self.active(*i)).count() <= 1 {
            self.finish();
        }
    }
    fn readiness(&self, i: usize) -> u8 {
        if self.hands[i]
            .iter()
            .any(|t| Some(suit(*t)) == self.missing[i])
        {
            return 0;
        }
        if (0..27).any(|k| self.can_hu(i, Some(k * 4))) {
            2
        } else {
            1
        }
    }
    fn finish(&mut self) {
        if self.finished {
            return;
        }
        for ready in (0..=2).rev() {
            let group: Vec<usize> = (0..4)
                .filter(|i| self.active(*i) && self.readiness(*i) == ready)
                .collect();
            if !group.is_empty() {
                self.ranks.push(group);
            }
        }
        self.finished = true;
        self.phase = "finished";
        self.response = None;
        self.calculate();
        self.note = "血战结束，按胡牌顺序结算；流局按听牌、未听、花猪排序，同名次平分".into();
    }
    fn calculate(&mut self) {
        self.payouts = [0; 4];
        let mut pos = 0;
        for group in &self.ranks {
            let amount: u64 = PRIZES[pos..(pos + group.len()).min(4)].iter().sum();
            for (k, i) in group.iter().enumerate() {
                self.payouts[*i] = amount / group.len() as u64
                    + u64::from((k as u64) < amount % group.len() as u64);
            }
            pos += group.len();
        }
        if self.finished {
            let remaining = 1600 - self.payouts.iter().sum::<u64>();
            if let Some(group) = self.ranks.first() {
                for (k, i) in group.iter().enumerate() {
                    self.payouts[*i] += remaining / group.len() as u64
                        + u64::from((k as u64) < remaining % group.len() as u64);
                }
            }
        }
    }
    pub fn forfeit(&mut self, i: usize) {
        self.left[i] = true;
        self.exchanged[i] = true;
        if self.missing[i].is_none() {
            self.missing[i] = Some(0);
        }
        if (0..4).filter(|j| self.active(*j)).count() <= 1 {
            self.finish();
            return;
        }
        if self.phase == "exchange" || self.phase == "que" {
            // Preserve a complete four-seat deal during setup; forfeited seats are auto-submitted.
            self.exchange[i] = self.hands[i]
                .iter()
                .copied()
                .filter(|t| {
                    suit(*t)
                        == self.hands[i]
                            .iter()
                            .map(|t| suit(*t))
                            .max_by_key(|s| {
                                self.hands[i].iter().filter(|t| suit(**t) == *s).count()
                            })
                            .unwrap()
                })
                .take(3)
                .collect();
            if self.phase == "exchange" && self.exchanged.iter().all(|x| *x) {
                for j in 0..4 {
                    for t in self.exchange[j].clone() {
                        remove(&mut self.hands[j], t);
                    }
                }
                for j in 0..4 {
                    self.hands[(j + 1) % 4].extend(&self.exchange[j]);
                    self.hands[(j + 1) % 4].sort();
                }
                self.phase = "que";
            }
            if self.phase == "que" && self.missing.iter().all(Option::is_some) {
                self.phase = "discard";
                self.turn = if self.active(0) { 0 } else { self.next(0) };
                if self.turn != 0 {
                    self.draw(self.turn, false);
                }
            }
        } else if self.phase == "response" {
            if let Some(r) = self.response.as_mut() {
                r.choices[i] = Some(Claim::Pass);
            }
            if self
                .response
                .as_ref()
                .is_some_and(|r| r.choices.iter().all(Option::is_some))
            {
                self.resolve();
            }
        } else if self.turn == i {
            self.draw(self.next(i), false);
        }
    }
    /// Plays for seats whose players are `away` (offline too long): every pending
    /// exchange / missing-suit choice, claim response or discard. False if none was due.
    pub fn auto(&mut self, away: &dyn Fn(usize) -> bool) -> bool {
        let mut acted = false;
        for i in 0..4 {
            if self.finished || !self.can_act(i) || !away(i) {
                continue;
            }
            let msg = match self.phase {
                "exchange" => {
                    let s = (0..3)
                        .max_by_key(|s| self.hands[i].iter().filter(|t| suit(**t) == *s).count())
                        .unwrap();
                    let tiles: Vec<u8> = self.hands[i]
                        .iter()
                        .copied()
                        .filter(|t| suit(*t) == s)
                        .take(3)
                        .collect();
                    json!({"op":"exchange","tiles":tiles})
                }
                "que" => {
                    let s = (0..3)
                        .min_by_key(|s| self.hands[i].iter().filter(|t| suit(**t) == *s).count())
                        .unwrap();
                    json!({"op":"que","suit":s})
                }
                "response" => {
                    let hu = self.options(i, self.response.as_ref().unwrap()).contains(&"hu");
                    json!({"op":if hu { "hu" } else { "pass" }})
                }
                _ if self.can_hu(i, None) => json!({"op":"hu"}),
                _ => {
                    let t = self.hands[i]
                        .iter()
                        .copied()
                        .find(|t| Some(suit(*t)) == self.missing[i])
                        .unwrap_or(*self.hands[i].last().unwrap());
                    json!({"op":"discard","tile":t})
                }
            };
            acted |= self.command(i, &msg).is_ok();
        }
        acted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn waiting_one() -> Vec<u8> {
        vec![4, 8, 12, 13, 14, 16, 17, 18, 20, 21, 22, 24, 25]
    }
    fn action_fixture() -> Mahjong {
        let mut m = Mahjong::new();
        m.phase = "discard";
        m.missing = [Some(2); 4];
        m.hands[1] = waiting_one();
        m.hands[2] = vec![0, 1];
        m.hands[3] = vec![40, 41];
        m.wall = vec![80, 81, 82, 83];
        m
    }
    #[test]
    fn must_discard_missing_suit_first() {
        let mut m = action_fixture();
        m.hands[0] = vec![0, 72];
        assert!(m.command(0, &json!({"op":"discard","tile":0})).is_err());
        assert_eq!(m.hands[0], vec![0, 72]);
        m.command(0, &json!({"op":"discard","tile":72})).unwrap();
        assert!(!m.hands[0].contains(&72));
    }
    #[test]
    fn hu_beats_peng_and_claim_context_is_checked() {
        let mut m = action_fixture();
        m.hands[0] = vec![3, 28];
        m.command(0, &json!({"op":"discard","tile":3})).unwrap();
        assert_eq!(m.phase, "response");
        assert!(m.accepts_stale(&json!({"mjPhase":"response","claimTile":3,"claimSource":0})));
        assert!(!m.accepts_stale(&json!({"mjPhase":"response","claimTile":7,"claimSource":0})));
        m.command(2, &json!({"op":"peng"})).unwrap();
        m.command(1, &json!({"op":"hu"})).unwrap();
        assert!(m.won[1]);
        assert!(m.melds[2].is_empty());
        assert_eq!(m.payouts[1], 700);
    }
    #[test]
    fn added_kong_can_be_robbed_without_changing_the_peng() {
        let mut m = action_fixture();
        m.hands[0] = vec![3, 28];
        m.melds[0] = vec![Meld {
            tiles: vec![0, 1, 2],
            concealed: false,
        }];
        m.command(0, &json!({"op":"gang","tileKind":0})).unwrap();
        assert_eq!(m.phase, "response");
        m.command(1, &json!({"op":"hu"})).unwrap();
        assert!(m.won[1]);
        assert_eq!(m.melds[0][0].tiles.len(), 3);
        assert!(!m.hands[0].contains(&3));
        assert_eq!(m.win_tiles[1], Some(3));
    }
    #[test]
    fn concealed_kong_hides_faces_and_draws_a_replacement() {
        let mut m = action_fixture();
        m.hands[0] = vec![0, 1, 2, 3, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21];
        m.command(0, &json!({"op":"gang","tileKind":0})).unwrap();
        assert_eq!(m.hands[0].len(), 11);
        assert_eq!(m.melds[0][0].tiles.len(), 4);
        assert!(m.snapshot(Some(1))["players"][0]["melds"][0]["tiles"].is_null());
        assert_eq!(
            m.snapshot(Some(0))["players"][0]["melds"][0]["tiles"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }
    #[test]
    fn dealer_forfeiting_during_setup_does_not_stall() {
        let mut m = Mahjong::new();
        m.forfeit(0);
        for _ in 0..600 {
            if m.finished {
                break;
            }
            m.auto(&|_| true);
        }
        assert!(m.finished);
        assert_eq!(m.payouts[0], 0);
        assert_eq!(m.payouts.iter().sum::<u64>(), 1600);
    }
    #[test]
    fn stand_in_only_plays_for_away_seats() {
        let mut m = Mahjong::new();
        assert!(!m.auto(&|_| false));
        assert!(m.auto(&|i| i == 2));
        assert!(m.exchanged[2] && !m.exchanged[0]);
        assert_eq!(m.phase, "exchange");
    }
    #[test]
    fn winning_shapes_require_missing_suit() {
        let h = vec![0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17];
        assert!(winning(&h, 0, 2));
        assert!(!winning(&h, 0, 0));
        let p = vec![0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21, 24, 25];
        assert!(winning(&p, 0, 2));
    }
    #[test]
    fn wall_and_hands_are_unique_and_private() {
        let m = Mahjong::new();
        let mut all = m.wall.clone();
        for h in &m.hands {
            all.extend(h);
        }
        all.sort();
        assert_eq!(all, (0..108).collect::<Vec<_>>());
        let v = m.snapshot(Some(0));
        assert_eq!(v["players"][0]["hand"].as_array().unwrap().len(), 14);
        assert!(v["players"][1]["hand"].is_null());
    }
    #[test]
    fn payouts_follow_order_and_ties_share_slots() {
        let mut m = Mahjong::new();
        m.record_wins(vec![2]);
        m.record_wins(vec![0, 1]);
        assert!(m.finished);
        assert_eq!(m.payouts, [450, 450, 700, 0]);
        assert_eq!(m.payouts.iter().sum::<u64>(), 1600);
    }
    #[test]
    fn automated_game_terminates_and_keeps_all_tiles() {
        for _ in 0..5 {
            let mut m = Mahjong::new();
            for _ in 0..500 {
                if m.finished {
                    break;
                }
                assert!(m.auto(&|_| true));
                let mut all = m.wall.clone();
                for h in &m.hands {
                    all.extend(h);
                }
                for r in &m.rivers {
                    all.extend(r);
                }
                for melds in &m.melds {
                    for meld in melds {
                        all.extend(&meld.tiles);
                    }
                }
                all.sort();
                assert_eq!(all, (0..108).collect::<Vec<_>>());
            }
            assert!(m.finished);
            assert_eq!(m.payouts.iter().sum::<u64>(), 1600);
        }
    }
}
