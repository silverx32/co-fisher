//! Aeroplane chess for 2–4 players, four planes each. Progress is per player:
//! 0 hangar, 1..=50 the shared outer ring, 51..=55 the home column, 56 home.
use crate::games::Board;
use serde_json::{json, Value};

pub const HOME: u8 = 56;
const RING: u8 = 50;
/// Landing on this own-colour square flies straight to `FLY_TO`.
const FLY_FROM: u8 = 18;
const FLY_TO: u8 = 30;
pub struct Flight {
    names: Vec<String>,
    /// Colour slot per seat (0..4); also fixes where that seat enters the ring.
    colors: Vec<usize>,
    planes: Vec<[u8; 4]>,
    left: Vec<bool>,
    turn: usize,
    dice: Option<u8>,
    sixes: u8,
    finished: bool,
    winner: Option<usize>,
    note: String,
}
/// Absolute ring square (0..52) for a colour's progress on the outer ring.
fn square(color: usize, step: u8) -> usize {
    (13 * color + 8 + step as usize) % 52
}
fn own_color(step: u8) -> bool {
    (1..=RING).contains(&step) && step % 4 == 2
}
impl Flight {
    pub fn new(names: Vec<String>) -> Self {
        let players = names.len();
        Self {
            names,
            colors: if players == 2 { vec![0, 2] } else { (0..players).collect() },
            planes: vec![[0; 4]; players],
            left: vec![false; players],
            turn: 0,
            dice: None,
            sixes: 0,
            finished: false,
            winner: None,
            note: "掷到 6 才能起飞；6 点可以再掷一次".into(),
        }
    }
    fn movable(&self, i: usize, dice: u8) -> Vec<usize> {
        (0..4)
            .filter(|k| match self.planes[i][*k] {
                HOME => false,
                0 => dice == 6,
                _ => true,
            })
            .collect()
    }
    /// Where plane `k` ends up and which (seat, plane) pairs it knocks back to the hangar.
    fn land(&self, i: usize, k: usize, dice: u8) -> (u8, Vec<(usize, usize)>, &'static str) {
        let mut pos = match self.planes[i][k] {
            0 => 1,
            p if p + dice > HOME => 2 * HOME - p - dice,
            p => p + dice,
        };
        let mut hits = vec![];
        let hit = |pos: u8, hits: &mut Vec<(usize, usize)>| {
            if !(1..=RING).contains(&pos) {
                return;
            }
            let at = square(self.colors[i], pos);
            for (j, planes) in self.planes.iter().enumerate() {
                if j == i || self.left[j] {
                    continue;
                }
                for (q, p) in planes.iter().enumerate() {
                    if (1..=RING).contains(p) && square(self.colors[j], *p) == at && !hits.contains(&(j, q)) {
                        hits.push((j, q));
                    }
                }
            }
        };
        hit(pos, &mut hits);
        let mut how = "";
        if self.planes[i][k] != 0 && own_color(pos) {
            if pos != FLY_FROM && pos + 4 <= RING {
                pos += 4;
                how = "，同色跳 4 格";
                hit(pos, &mut hits);
            }
            if pos == FLY_FROM {
                pos = FLY_TO;
                how = if how.is_empty() { "，飞越捷径" } else { "，同色跳后飞越捷径" };
                hit(pos, &mut hits);
            }
        }
        (pos, hits, how)
    }
    fn roll(&mut self, i: usize, d: u8) {
        self.sixes = if d == 6 { self.sixes + 1 } else { 0 };
        if self.sixes == 3 {
            self.note = format!("{} 连续三次掷出 6，本回合作废", self.names[i]);
            self.pass();
            return;
        }
        let movable = self.movable(i, d);
        let mut spots: Vec<u8> = movable.iter().map(|k| self.planes[i][*k]).collect();
        spots.dedup();
        if movable.is_empty() {
            self.note = format!("{} 掷出 {d}，没有可以走的飞机", self.names[i]);
            self.pass();
        } else if spots.len() == 1 {
            // Identical choices (e.g. every plane still in the hangar) need no click.
            self.fly(i, movable[0], d);
        } else {
            self.dice = Some(d);
            self.note = format!("{} 掷出 {d}，请选择要走的飞机", self.names[i]);
        }
    }
    fn fly(&mut self, i: usize, k: usize, d: u8) {
        let from = self.planes[i][k];
        let (to, hits, how) = self.land(i, k, d);
        self.planes[i][k] = to;
        for (j, q) in &hits {
            self.planes[*j][*q] = 0;
        }
        self.dice = None;
        let what = if from == 0 {
            "起飞".to_string()
        } else if to == HOME {
            "到达终点".into()
        } else {
            format!("前进到第 {to} 格")
        };
        let hit = if hits.is_empty() { String::new() } else { format!("，撞回 {} 架飞机", hits.len()) };
        self.note = format!("{} 掷出 {d}：{} 号飞机{what}{how}{hit}", self.names[i], k + 1);
        if self.planes[i].iter().all(|p| *p == HOME) {
            self.finished = true;
            self.winner = Some(i);
            self.note = format!("{} 的四架飞机全部到达终点", self.names[i]);
        } else if d == 6 {
            self.note += "，6 点再掷一次";
        } else {
            self.pass();
        }
    }
    fn pass(&mut self) {
        self.dice = None;
        self.sixes = 0;
        let n = self.planes.len();
        if let Some(j) = (1..=n).map(|d| (self.turn + d) % n).find(|j| !self.left[*j]) {
            self.turn = j;
        }
    }
    /// Stand-in for a disconnected player: roll, then prefer knocking planes back,
    /// reaching home, taking off, and otherwise the most advanced landing.
    fn stand_in(&mut self) {
        let i = self.turn;
        let Some(d) = self.dice else {
            self.roll(i, crate::cards::below(6) as u8 + 1);
            return;
        };
        let k = self
            .movable(i, d)
            .into_iter()
            .max_by_key(|k| {
                let (to, hits, _) = self.land(i, *k, d);
                (hits.len(), to == HOME, self.planes[i][*k] == 0, to)
            })
            .unwrap();
        self.fly(i, k, d);
    }
}

impl Board for Flight {
    fn can_act(&self, i: usize) -> bool {
        !self.finished && !self.left[i] && self.turn == i
    }
    fn snapshot(&self, viewer: Option<usize>) -> Value {
        let movable = match (viewer, self.dice) {
            (Some(i), Some(d)) if self.can_act(i) => self.movable(i, d),
            _ => vec![],
        };
        json!({
            "turn":self.turn,"dice":self.dice,"finished":self.finished,"winner":self.winner,"note":self.note,
            "movable":movable,
            "players":(0..self.planes.len()).map(|i|json!({"color":self.colors[i],"planes":self.planes[i],"left":self.left[i],
                "home":self.planes[i].iter().filter(|p|**p==HOME).count()})).collect::<Vec<_>>(),
        })
    }
    fn command(&mut self, i: usize, msg: &Value) -> Result<(), String> {
        if !self.can_act(i) {
            return Err("还没轮到你".into());
        }
        match msg["op"].as_str().unwrap_or("") {
            "roll" => {
                if self.dice.is_some() {
                    return Err("已经掷过了，请选择要走的飞机".into());
                }
                let d = crate::cards::below(6) as u8 + 1;
                self.roll(i, d);
                Ok(())
            }
            "move" => {
                let d = self.dice.ok_or("请先掷骰子")?;
                let k = msg["plane"]
                    .as_u64()
                    .filter(|k| *k < 4)
                    .ok_or("请选择飞机")? as usize;
                if !self.movable(i, d).contains(&k) {
                    return Err("这架飞机现在不能走".into());
                }
                self.fly(i, k, d);
                Ok(())
            }
            _ => Err("请掷骰子或选择飞机".into()),
        }
    }
    fn forfeit(&mut self, i: usize) {
        self.left[i] = true;
        let live: Vec<usize> = (0..self.left.len()).filter(|j| !self.left[*j]).collect();
        if live.len() <= 1 {
            self.finished = true;
            self.winner = live.first().copied();
            self.note = "其他玩家都已退出".into();
        } else if self.turn == i {
            self.pass();
        }
    }
    fn auto(&mut self, away: &dyn Fn(usize) -> bool) -> bool {
        let go = self.can_act(self.turn) && away(self.turn);
        if go {
            self.stand_in();
        }
        go
    }
    fn turn(&self) -> usize {
        self.turn
    }
    fn note(&self) -> String {
        self.note.clone()
    }
    fn alive(&self, i: usize) -> bool {
        !self.left[i]
    }
    fn winners(&self) -> Option<Vec<usize>> {
        self.finished.then(|| self.winner.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("p{i}")).collect()
    }
    #[test]
    fn needs_six_to_take_off_and_six_rolls_again() {
        let mut f = Flight::new(names(3));
        f.roll(0, 3);
        assert_eq!(f.turn, 1);
        f.roll(1, 6);
        assert_eq!(f.planes[1], [1, 0, 0, 0]);
        assert_eq!(f.turn, 1);
        f.roll(1, 2);
        assert_eq!(f.planes[1][0], 3);
        assert_eq!(f.turn, 2);
    }
    #[test]
    fn three_sixes_forfeit_the_turn() {
        let mut f = Flight::new(names(2));
        f.planes[0] = [5, 9, 0, 0];
        for _ in 0..2 {
            f.roll(0, 6);
            f.command(0, &json!({"op":"move","plane":0})).unwrap();
        }
        let before = f.planes[0];
        f.roll(0, 6);
        assert_eq!(f.planes[0], before);
        assert_eq!(f.turn, 1);
    }
    #[test]
    fn colour_jump_shortcut_and_capture() {
        let mut f = Flight::new(names(2));
        f.planes[0] = [12, 40, 0, 0];
        // 12 + 2 = 14 is own colour: jump to 18, then fly to 30.
        assert_eq!(f.land(0, 0, 2).0, FLY_TO);
        // Seat 1 (colour 2) sits on the same ring square as seat 0's step 30.
        let step = (1..=RING).find(|s| square(2, *s) == square(0, 30)).unwrap();
        f.planes[1] = [step, 0, 0, 0];
        f.dice = Some(2);
        f.command(0, &json!({"op":"move","plane":0})).unwrap();
        assert_eq!(f.planes[0][0], 30);
        assert_eq!(f.planes[1][0], 0);
    }
    #[test]
    fn exact_roll_home_bounces_back() {
        let mut f = Flight::new(names(2));
        f.planes[0] = [54, 0, 0, 0];
        assert_eq!(f.land(0, 0, 2).0, HOME);
        assert_eq!(f.land(0, 0, 5).0, 53);
    }
    #[test]
    fn last_plane_home_wins_and_forfeits_end_the_game() {
        let mut f = Flight::new(names(3));
        f.planes[0] = [HOME, HOME, HOME, 53];
        f.roll(0, 3);
        assert!(f.finished);
        assert_eq!(f.winner, Some(0));
        let mut f = Flight::new(names(3));
        f.forfeit(0);
        assert_eq!(f.turn, 1);
        f.forfeit(2);
        assert_eq!(f.winner, Some(1));
    }
    #[test]
    fn automatic_play_terminates() {
        for players in 2..=4 {
            let mut f = Flight::new(names(players));
            for _ in 0..20000 {
                if f.finished {
                    break;
                }
                assert!(f.auto(&|_| true));
            }
            assert!(f.finished);
        }
    }
}
