//! 大富翁 for 2–6 players. Every table generates its own 32-square ring: the
//! corners are fixed, while lots, prices, districts and event squares are
//! shuffled. Cash here is in-game money; the wallet only sees ticket and prize.
use crate::{cards::below, games::Board};
use serde_json::{json, Value};

pub const ROUNDS: u32 = 20;
const SIZE: usize = 32;
const START_CASH: i64 = 1500;
const SALARY: i64 = 200;
const MAX_LEVEL: u8 = 3;
/// Rent multiplier per building level, applied to an eighth of the lot price.
const RENT: [i64; 4] = [1, 3, 7, 12];
const REMOTE_COOLDOWN: u8 = 3;
/// Emoji, name and skill; the index is the character id sent by clients.
pub const CHARACTERS: [(&str, &str, &str); 8] = [
    ("🐟", "摸鱼达人", "经过或停在起点，工资多领 100"),
    ("🏠", "收租大户", "收到的过路费 +30%"),
    ("🏷️", "砍价王", "买地打 8 折"),
    ("🔨", "装修队长", "升级房子半价"),
    ("🍀", "锦鲤", "机会卡只会抽到好事"),
    ("⚖️", "法务", "过路费打 6 折，免交税"),
    ("🛵", "外卖骑手", "掷三颗骰子，取较大的两颗"),
    ("🎮", "遥控大师", "可指定一次点数（2–12），之后冷却 3 回合"),
];
const SLACKER: usize = 0;
const RENTIER: usize = 1;
const BARGAIN: usize = 2;
const BUILDER: usize = 3;
const KOI: usize = 4;
const LAWYER: usize = 5;
const COURIER: usize = 6;
const REMOTE: usize = 7;
const NAMES: [&str; 36] = [
    "奶茶店", "便利店", "网吧", "火锅店", "电影院", "健身房", "书店", "咖啡馆", "游戏厅",
    "烧烤摊", "花店", "宠物店", "面包房", "KTV", "动漫店", "菜市场", "小龙虾馆", "甜品站",
    "猫咖", "桌游吧", "滑板场", "露营地", "游乐场", "水族馆", "天文台", "温泉", "剧本杀",
    "密室逃脱", "电竞馆", "夜市", "螺蛳粉店", "洗车行", "理发店", "照相馆", "自习室", "文具店",
];
#[derive(Clone, Copy, PartialEq)]
enum Square {
    Start,
    Lot,
    Chance,
    Tax,
    Bonus,
    Overtime,
    Park,
    Lottery,
}
#[derive(Clone, Copy)]
enum Card {
    Cash(i64),
    /// Positive: every other player pays you; negative: you pay each of them.
    Each(i64),
    Steps(i32),
    Start,
    Overtime,
    Repairs(i64),
}
const GOOD: [(&str, Card); 7] = [
    ("年终奖提前发了，+200", Card::Cash(200)),
    ("项目上线，团队奖金 +150", Card::Cash(150)),
    ("工位抽屉里翻出红包，+100", Card::Cash(100)),
    ("外卖免单，+50", Card::Cash(50)),
    ("过生日，每位玩家给你 30", Card::Each(30)),
    ("搭上顺风车，前进 3 格", Card::Steps(3)),
    ("直通起点，领工资", Card::Start),
];
const BAD: [(&str, Card); 6] = [
    ("电脑蓝屏，维修费 100", Card::Cash(-100)),
    ("摸鱼被抓，罚款 150", Card::Cash(-150)),
    ("请全组喝奶茶，每位玩家 30", Card::Each(-30)),
    ("走错路，后退 3 格", Card::Steps(-3)),
    ("临时加班，下回合停一次", Card::Overtime),
    ("房屋检修，每级房子付 25", Card::Repairs(25)),
];
struct Tile {
    square: Square,
    name: String,
    price: i64,
    district: usize,
    owner: Option<usize>,
    level: u8,
}
struct Player {
    character: Option<usize>,
    cash: i64,
    pos: usize,
    broke: bool,
    left: bool,
    skip: bool,
    cooldown: u8,
}
pub struct Monopoly {
    names: Vec<String>,
    tiles: Vec<Tile>,
    players: Vec<Player>,
    turn: usize,
    round: u32,
    /// pick → roll ⇄ decide → finished
    phase: &'static str,
    pending: Option<(usize, &'static str, i64)>,
    dice: Vec<u8>,
    note: String,
    log: Vec<String>,
    winners: Option<Vec<usize>>,
}
fn shuffle<T>(v: &mut [T]) {
    for i in (1..v.len()).rev() {
        v.swap(i, below(i as u32 + 1) as usize);
    }
}
fn label(s: Square) -> &'static str {
    match s {
        Square::Start => "起点",
        Square::Lot => "空地",
        Square::Chance => "机会",
        Square::Tax => "税务局",
        Square::Bonus => "红包",
        Square::Overtime => "加班",
        Square::Park => "公园",
        Square::Lottery => "彩票站",
    }
}
fn code(s: Square) -> &'static str {
    match s {
        Square::Start => "start",
        Square::Lot => "lot",
        Square::Chance => "chance",
        Square::Tax => "tax",
        Square::Bonus => "bonus",
        Square::Overtime => "overtime",
        Square::Park => "park",
        Square::Lottery => "lottery",
    }
}
fn generate() -> Vec<Tile> {
    let mut edge = vec![Square::Lot; 20];
    edge.extend([Square::Chance; 4]);
    edge.extend([Square::Tax, Square::Tax, Square::Bonus, Square::Bonus]);
    shuffle(&mut edge);
    let mut names = NAMES.to_vec();
    shuffle(&mut names);
    let mut edge = edge.into_iter();
    let mut tiles: Vec<Tile> = (0..SIZE)
        .map(|pos| {
            let square = match pos {
                0 => Square::Start,
                8 => Square::Overtime,
                16 => Square::Park,
                24 => Square::Lottery,
                _ => edge.next().unwrap(),
            };
            let (name, price) = if square == Square::Lot {
                // Prices climb around the ring, ±10%, in tens.
                let price = (60 + 8 * pos as i64) * (90 + below(21) as i64) / 1000 * 10;
                (names.pop().unwrap().to_string(), price)
            } else {
                (label(square).to_string(), 0)
            };
            Tile {
                square,
                name,
                price,
                district: 0,
                owner: None,
                level: 0,
            }
        })
        .collect();
    // Consecutive lots form districts of two or three; never leave a single lot over.
    let lots: Vec<usize> = (0..SIZE).filter(|p| tiles[*p].square == Square::Lot).collect();
    let (mut start, mut district) = (0, 0);
    while start < lots.len() {
        let size = match lots.len() - start {
            2 | 4 => 2,
            3 => 3,
            _ => 2 + below(2) as usize,
        };
        for p in &lots[start..start + size] {
            tiles[*p].district = district;
        }
        start += size;
        district += 1;
    }
    tiles
}
impl Monopoly {
    pub fn new(names: Vec<String>) -> Self {
        let players = names
            .iter()
            .map(|_| Player {
                character: None,
                cash: START_CASH,
                pos: 0,
                broke: false,
                left: false,
                skip: false,
                cooldown: 0,
            })
            .collect();
        Self {
            names,
            tiles: generate(),
            players,
            turn: 0,
            round: 1,
            phase: "pick",
            pending: None,
            dice: vec![],
            note: "本局地图已随机生成；先各自挑选角色，技能各不相同".into(),
            log: vec![],
            winners: None,
        }
    }
    fn say(&mut self, text: String) {
        self.log.push(text.clone());
        if self.log.len() > 8 {
            self.log.remove(0);
        }
        self.note = text;
    }
    fn active(&self, i: usize) -> bool {
        !self.players[i].broke && !self.players[i].left
    }
    fn is(&self, i: usize, character: usize) -> bool {
        self.players[i].character == Some(character)
    }
    fn value(&self, p: usize) -> i64 {
        let t = &self.tiles[p];
        t.price + t.level as i64 * t.price / 2
    }
    fn assets(&self, i: usize) -> i64 {
        self.players[i].cash
            + (0..SIZE)
                .filter(|p| self.tiles[*p].owner == Some(i))
                .map(|p| self.value(p))
                .sum::<i64>()
    }
    fn rent(&self, p: usize) -> i64 {
        let t = &self.tiles[p];
        let Some(owner) = t.owner else { return 0 };
        let mut rent = t.price / 8 * RENT[t.level as usize];
        if self
            .tiles
            .iter()
            .all(|x| x.square != Square::Lot || x.district != t.district || x.owner == Some(owner))
        {
            rent *= 2;
        }
        if self.is(owner, RENTIER) {
            rent = rent * 13 / 10;
        }
        rent
    }
    fn buy_cost(&self, i: usize, p: usize) -> i64 {
        let price = self.tiles[p].price;
        if self.is(i, BARGAIN) {
            price * 8 / 10
        } else {
            price
        }
    }
    fn upgrade_cost(&self, i: usize, p: usize) -> i64 {
        let half = self.tiles[p].price / 2;
        if self.is(i, BUILDER) {
            half / 2
        } else {
            half
        }
    }
    fn begin_if_ready(&mut self) {
        if self.phase == "pick" && self.players.iter().all(|p| p.left || p.character.is_some()) {
            self.phase = "roll";
            self.turn = (0..self.players.len()).find(|i| self.active(*i)).unwrap_or(0);
            self.say(format!("角色选好了，{} 先掷骰子", self.names[self.turn]));
        }
    }
    fn roll(&mut self, i: usize, chosen: Option<u64>) -> Result<(), String> {
        let dice = if let Some(n) = chosen {
            if !self.is(i, REMOTE) || self.players[i].cooldown > 0 {
                return Err("遥控骰子还在冷却".into());
            }
            if !(2..=12).contains(&n) {
                return Err("点数须在 2–12 之间".into());
            }
            self.players[i].cooldown = REMOTE_COOLDOWN;
            vec![n as u8]
        } else {
            self.players[i].cooldown = self.players[i].cooldown.saturating_sub(1);
            let count = if self.is(i, COURIER) { 3 } else { 2 };
            let mut d: Vec<u8> = (0..count).map(|_| below(6) as u8 + 1).collect();
            d.sort_unstable_by(|a, b| b.cmp(a));
            d.truncate(2);
            d
        };
        let steps: u8 = dice.iter().sum();
        self.dice = dice;
        let how = if chosen.is_some() { "遥控出" } else { "掷出" };
        self.say(format!("{} {how} {steps} 点", self.names[i]));
        self.walk(i, steps as i32);
        if !self.land(i, false) {
            self.next_turn();
        }
        Ok(())
    }
    fn walk(&mut self, i: usize, steps: i32) {
        let from = self.players[i].pos;
        let to = (from as i32 + steps).rem_euclid(SIZE as i32) as usize;
        self.players[i].pos = to;
        if steps > 0 && to < from {
            let pay = SALARY + if self.is(i, SLACKER) { 100 } else { 0 };
            self.players[i].cash += pay;
            self.say(format!("{} 经过起点，领工资 {pay}", self.names[i]));
        }
    }
    /// Resolves the square `i` stands on; true when a buy/upgrade decision is pending.
    fn land(&mut self, i: usize, chained: bool) -> bool {
        let p = self.players[i].pos;
        let (name, tile) = (self.names[i].clone(), self.tiles[p].name.clone());
        match self.tiles[p].square {
            Square::Lot => match self.tiles[p].owner {
                None => {
                    let cost = self.buy_cost(i, p);
                    if self.players[i].cash >= cost {
                        self.pending = Some((p, "buy", cost));
                        self.phase = "decide";
                        self.say(format!("{name} 来到空地「{tile}」，可以花 {cost} 买下"));
                        return true;
                    }
                    self.say(format!("{name} 来到「{tile}」，现金不够买下"));
                }
                Some(o) if o == i => {
                    let cost = self.upgrade_cost(i, p);
                    if self.tiles[p].level < MAX_LEVEL && self.players[i].cash >= cost {
                        self.pending = Some((p, "upgrade", cost));
                        self.phase = "decide";
                        self.say(format!(
                            "{name} 回到自家「{tile}」，可以花 {cost} 升到 {} 级",
                            self.tiles[p].level + 1
                        ));
                        return true;
                    }
                    self.say(format!("{name} 回到自家「{tile}」"));
                }
                Some(o) => {
                    let mut rent = self.rent(p);
                    if self.is(i, LAWYER) {
                        rent = rent * 6 / 10;
                    }
                    self.say(format!("{name} 踩到 {} 的「{tile}」，付过路费 {rent}", self.names[o]));
                    self.pay(i, Some(o), rent);
                }
            },
            Square::Chance if chained => self.say(format!("{name} 又到机会格，这次什么也没发生")),
            Square::Chance => return self.chance(i),
            Square::Tax if self.is(i, LAWYER) => self.say(format!("{name} 是法务，免交税")),
            Square::Tax => {
                let tax = (self.players[i].cash / 10).max(50);
                self.say(format!("{name} 到税务局缴税 {tax}"));
                self.pay(i, None, tax);
            }
            Square::Bonus => {
                let n = 100 + 50 * below(3) as i64;
                self.players[i].cash += n;
                self.say(format!("{name} 领到红包 {n}"));
            }
            Square::Overtime => {
                self.players[i].skip = true;
                self.say(format!("{name} 被拉去加班，下回合停一次"));
            }
            Square::Lottery if below(4) == 0 => {
                self.players[i].cash += 400;
                self.say(format!("{name} 彩票中了 400！"));
            }
            Square::Lottery => self.say(format!("{name} 买彩票没中")),
            Square::Park => self.say(format!("{name} 在公园歇脚")),
            Square::Start => self.say(format!("{name} 停在起点")),
        }
        false
    }
    fn chance(&mut self, i: usize) -> bool {
        let n = GOOD.len() + if self.is(i, KOI) { 0 } else { BAD.len() };
        let k = below(n as u32) as usize;
        let (text, card) = if k < GOOD.len() { GOOD[k] } else { BAD[k - GOOD.len()] };
        self.say(format!("{} 抽到机会卡：{text}", self.names[i]));
        match card {
            Card::Cash(n) if n >= 0 => self.players[i].cash += n,
            Card::Cash(n) => self.pay(i, None, -n),
            Card::Each(n) => {
                for j in 0..self.players.len() {
                    if j != i && self.active(j) && self.active(i) {
                        if n > 0 {
                            self.pay(j, Some(i), n);
                        } else {
                            self.pay(i, Some(j), -n);
                        }
                    }
                }
            }
            Card::Steps(n) => {
                self.walk(i, n);
                return self.land(i, true);
            }
            Card::Start => self.walk(i, (SIZE - self.players[i].pos) as i32),
            Card::Overtime => self.players[i].skip = true,
            Card::Repairs(n) => {
                let levels: i64 = self
                    .tiles
                    .iter()
                    .filter(|t| t.owner == Some(i))
                    .map(|t| t.level as i64)
                    .sum();
                self.pay(i, None, levels * n);
            }
        }
        false
    }
    /// Pays from cash, selling the cheapest lots back to the bank at half value
    /// when short. Whoever still cannot pay hands over what is left and goes broke.
    fn pay(&mut self, i: usize, to: Option<usize>, amount: i64) {
        if amount <= 0 || !self.active(i) {
            return;
        }
        while self.players[i].cash < amount {
            let Some(p) = (0..SIZE)
                .filter(|p| self.tiles[*p].owner == Some(i))
                .min_by_key(|p| self.value(*p))
            else {
                break;
            };
            let gain = self.value(p) / 2;
            self.players[i].cash += gain;
            self.tiles[p].owner = None;
            self.tiles[p].level = 0;
            let text = format!("{} 变卖「{}」，回收 {gain}", self.names[i], self.tiles[p].name);
            self.say(text);
        }
        let paid = amount.min(self.players[i].cash);
        self.players[i].cash -= paid;
        if let Some(j) = to {
            self.players[j].cash += paid;
        }
        if paid < amount {
            self.players[i].broke = true;
            self.say(format!("{} 破产出局", self.names[i]));
        }
    }
    fn next_turn(&mut self) {
        self.pending = None;
        if self.check_end() {
            return;
        }
        let n = self.players.len();
        let mut j = self.turn;
        for _ in 0..2 * n {
            j = (j + 1) % n;
            if j == 0 {
                self.round += 1;
                if self.round > ROUNDS {
                    self.round = ROUNDS;
                    self.by_assets();
                    return;
                }
            }
            if !self.active(j) {
                continue;
            }
            if self.players[j].skip {
                self.players[j].skip = false;
                self.say(format!("{} 还在加班，跳过这一回合", self.names[j]));
                continue;
            }
            self.turn = j;
            self.phase = "roll";
            return;
        }
    }
    fn check_end(&mut self) -> bool {
        if self.winners.is_some() {
            return true;
        }
        let live: Vec<usize> = (0..self.players.len()).filter(|i| self.active(*i)).collect();
        if live.len() > 1 {
            return false;
        }
        self.finish(live, "其他玩家都已破产或退出");
        true
    }
    fn by_assets(&mut self) {
        let live: Vec<usize> = (0..self.players.len()).filter(|i| self.active(*i)).collect();
        let best = live.iter().map(|i| self.assets(*i)).max().unwrap_or(0);
        let winners = live.into_iter().filter(|i| self.assets(*i) == best).collect();
        self.finish(winners, &format!("{ROUNDS} 轮结束，按现金加地产的总资产排名"));
    }
    fn finish(&mut self, winners: Vec<usize>, why: &str) {
        self.phase = "finished";
        self.pending = None;
        let names: Vec<&str> = winners.iter().map(|w| self.names[*w].as_str()).collect();
        let text = if names.is_empty() {
            why.to_string()
        } else {
            format!("{why}，{} 获胜", names.join("、"))
        };
        self.winners = Some(winners);
        self.say(text);
    }
}

impl Board for Monopoly {
    fn can_act(&self, i: usize) -> bool {
        match self.phase {
            "pick" => !self.players[i].left && self.players[i].character.is_none(),
            "roll" | "decide" => self.turn == i && self.active(i),
            _ => false,
        }
    }
    fn winners(&self) -> Option<Vec<usize>> {
        self.winners.clone()
    }
    fn alive(&self, i: usize) -> bool {
        self.active(i)
    }
    fn snapshot(&self, _viewer: Option<usize>) -> Value {
        json!({
            "phase":self.phase,"turn":self.turn,"round":self.round,"rounds":ROUNDS,"dice":self.dice,
            "note":self.note,"log":self.log,"finished":self.winners.is_some(),"winners":self.winners,
            "pending":self.pending.map(|(p,kind,cost)|json!({"tile":p,"kind":kind,"cost":cost})),
            "characters":CHARACTERS.iter().map(|(emoji,name,skill)|json!({"emoji":emoji,"name":name,"skill":skill})).collect::<Vec<_>>(),
            "tiles":self.tiles.iter().enumerate().map(|(p,t)|json!({"kind":code(t.square),"name":t.name,"price":t.price,
                "district":t.district,"owner":t.owner,"level":t.level,"rent":self.rent(p)})).collect::<Vec<_>>(),
            "players":self.players.iter().enumerate().map(|(i,p)|json!({"character":p.character,"cash":p.cash,"pos":p.pos,
                "broke":p.broke,"left":p.left,"skip":p.skip,"cooldown":p.cooldown,"assets":self.assets(i)})).collect::<Vec<_>>(),
        })
    }
    fn command(&mut self, i: usize, msg: &Value) -> Result<(), String> {
        if !self.can_act(i) {
            return Err("还没轮到你".into());
        }
        let op = msg["op"].as_str().unwrap_or("");
        match (self.phase, op) {
            ("pick", "pick") => {
                let c = msg["character"]
                    .as_u64()
                    .filter(|c| *c < CHARACTERS.len() as u64)
                    .ok_or("请选择角色")? as usize;
                if self.players.iter().any(|p| p.character == Some(c) && !p.left) {
                    return Err("这个角色已经被别人选了".into());
                }
                self.players[i].character = Some(c);
                self.say(format!("{} 选了{}{}", self.names[i], CHARACTERS[c].0, CHARACTERS[c].1));
                self.begin_if_ready();
            }
            ("roll", "roll") => self.roll(i, msg["steps"].as_u64())?,
            ("decide", "buy" | "upgrade" | "skip") => {
                let (p, kind, cost) = self.pending.unwrap();
                let (name, tile) = (self.names[i].clone(), self.tiles[p].name.clone());
                if op == "skip" {
                    self.say(format!("{name} 放弃了「{tile}」"));
                } else if op != kind {
                    return Err("请选择购买、升级或放弃".into());
                } else {
                    self.players[i].cash -= cost;
                    if kind == "buy" {
                        self.tiles[p].owner = Some(i);
                        self.say(format!("{name} 花 {cost} 买下「{tile}」"));
                    } else {
                        self.tiles[p].level += 1;
                        self.say(format!("{name} 花 {cost} 把「{tile}」升到 {} 级", self.tiles[p].level));
                    }
                }
                self.next_turn();
            }
            _ => {
                return Err(match self.phase {
                    "pick" => "请先选角色",
                    "decide" => "请先决定买不买、升不升级",
                    _ => "请掷骰子",
                }
                .into())
            }
        }
        Ok(())
    }
    fn forfeit(&mut self, i: usize) {
        self.players[i].left = true;
        for t in &mut self.tiles {
            if t.owner == Some(i) {
                t.owner = None;
                t.level = 0;
            }
        }
        self.say(format!("{} 退出了，名下地产收归银行", self.names[i]));
        if self.check_end() {
            return;
        }
        if self.phase == "pick" {
            self.begin_if_ready();
        } else if self.turn == i {
            self.next_turn();
        }
    }
    /// Stand-in for players offline too long: random free character, then roll,
    /// buying or upgrading only while keeping 300 cash in reserve.
    fn auto(&mut self, away: &dyn Fn(usize) -> bool) -> bool {
        if self.phase == "pick" {
            let mut acted = false;
            for i in 0..self.players.len() {
                if self.can_act(i) && away(i) {
                    let free: Vec<usize> = (0..CHARACTERS.len())
                        .filter(|c| !self.players.iter().any(|p| p.character == Some(*c) && !p.left))
                        .collect();
                    let c = free[below(free.len() as u32) as usize];
                    acted |= self.command(i, &json!({"op":"pick","character":c})).is_ok();
                }
            }
            return acted;
        }
        let i = self.turn;
        if !self.can_act(i) || !away(i) {
            return false;
        }
        let op = match self.pending {
            Some((_, kind, cost)) if self.players[i].cash - cost >= 300 => kind,
            Some(_) => "skip",
            None => "roll",
        };
        self.command(i, &json!({ "op": op })).is_ok()
    }
    fn turn(&self) -> usize {
        self.turn
    }
    fn note(&self) -> String {
        self.note.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn game(n: usize) -> Monopoly {
        let mut m = Monopoly::new((0..n).map(|i| format!("p{i}")).collect());
        for i in 0..n {
            m.command(i, &json!({"op":"pick","character":i})).unwrap();
        }
        m
    }
    fn lot(m: &Monopoly) -> usize {
        (0..SIZE).find(|p| m.tiles[*p].square == Square::Lot).unwrap()
    }
    #[test]
    fn every_map_keeps_corners_and_groups_lots_in_twos_and_threes() {
        for _ in 0..50 {
            let tiles = generate();
            assert_eq!(tiles.len(), SIZE);
            assert!(tiles[0].square == Square::Start && tiles[8].square == Square::Overtime);
            assert!(tiles[16].square == Square::Park && tiles[24].square == Square::Lottery);
            let lots: Vec<&Tile> = tiles.iter().filter(|t| t.square == Square::Lot).collect();
            assert_eq!(lots.len(), 20);
            assert!(lots.iter().all(|t| (60..=340).contains(&t.price)));
            let mut names: Vec<&str> = lots.iter().map(|t| t.name.as_str()).collect();
            names.sort();
            names.dedup();
            assert_eq!(names.len(), 20);
            let districts = lots.iter().map(|t| t.district).max().unwrap() + 1;
            for d in 0..districts {
                let size = lots.iter().filter(|t| t.district == d).count();
                assert!((2..=3).contains(&size));
            }
        }
    }
    #[test]
    fn characters_are_unique_and_play_starts_once_all_picked() {
        let mut m = Monopoly::new(vec!["a".into(), "b".into()]);
        m.command(0, &json!({"op":"pick","character":3})).unwrap();
        assert!(m.command(1, &json!({"op":"pick","character":3})).is_err());
        assert!(m.command(0, &json!({"op":"roll"})).is_err());
        m.command(1, &json!({"op":"pick","character":5})).unwrap();
        assert_eq!(m.phase, "roll");
        assert!(m.can_act(0) && !m.can_act(1));
    }
    #[test]
    fn skills_change_prices_rent_and_salary() {
        let mut m = game(6);
        let p = lot(&m);
        let price = m.tiles[p].price;
        assert_eq!(m.buy_cost(BARGAIN, p), price * 8 / 10);
        assert_eq!(m.upgrade_cost(BUILDER, p), price / 4);
        m.tiles[p].owner = Some(RENTIER);
        m.tiles[p].level = 2;
        let rent = m.rent(p);
        m.players[LAWYER].pos = p;
        let (before, owner) = (m.players[LAWYER].cash, m.players[RENTIER].cash);
        m.land(LAWYER, false);
        assert_eq!(before - m.players[LAWYER].cash, rent * 6 / 10);
        assert_eq!(m.players[RENTIER].cash - owner, rent * 6 / 10);
        m.players[SLACKER].pos = 30;
        m.walk(SLACKER, 4);
        assert_eq!(m.players[SLACKER].cash, START_CASH + SALARY + 100);
    }
    #[test]
    fn remote_dice_then_cooldown() {
        let mut m = game(8);
        m.turn = REMOTE;
        m.tiles[5].square = Square::Park;
        m.command(REMOTE, &json!({"op":"roll","steps":5})).unwrap();
        assert_eq!(m.players[REMOTE].pos, 5);
        assert_eq!(m.players[REMOTE].cooldown, REMOTE_COOLDOWN);
        m.phase = "roll";
        m.pending = None;
        m.turn = REMOTE;
        assert!(m.command(REMOTE, &json!({"op":"roll","steps":5})).is_err());
    }
    #[test]
    fn buying_upgrading_and_bankruptcy_liquidates_then_ends() {
        let mut m = game(2);
        let p = lot(&m);
        m.players[0].pos = p;
        assert!(m.land(0, false));
        m.command(0, &json!({"op":"buy"})).unwrap();
        assert_eq!(m.tiles[p].owner, Some(0));
        m.tiles[p].level = MAX_LEVEL;
        let other = (0..SIZE).rev().find(|q| m.tiles[*q].square == Square::Lot).unwrap();
        m.tiles[other].owner = Some(1);
        m.tiles[other].price = 40;
        m.players[1].cash = 10;
        m.players[1].pos = p;
        m.turn = 1;
        m.land(1, false);
        assert!(m.players[1].broke);
        assert_eq!(m.tiles[other].owner, None);
        m.next_turn();
        assert_eq!(m.winners(), Some(vec![0]));
    }
    #[test]
    fn overtime_skips_one_turn() {
        let mut m = game(3);
        m.players[1].skip = true;
        m.next_turn();
        assert_eq!(m.turn, 2);
        assert!(!m.players[1].skip);
    }
    #[test]
    fn forfeits_release_lots_and_hand_over_the_turn() {
        let mut m = game(3);
        let p = lot(&m);
        m.tiles[p].owner = Some(0);
        m.forfeit(0);
        assert_eq!(m.tiles[p].owner, None);
        assert_eq!(m.turn, 1);
        m.forfeit(2);
        assert_eq!(m.winners(), Some(vec![1]));
    }
    #[test]
    fn automatic_games_end_within_the_round_limit() {
        for n in 2..=6 {
            let mut m = Monopoly::new((0..n).map(|i| format!("p{i}")).collect());
            for _ in 0..10_000 {
                if m.winners.is_some() {
                    break;
                }
                assert!(m.auto(&|_| true));
            }
            let winners = m.winners().unwrap();
            assert!(!winners.is_empty());
            assert!(m.round <= ROUNDS);
        }
    }
}
