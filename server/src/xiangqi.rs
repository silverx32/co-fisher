//! Two-player Chinese chess. The first entrant plays red and moves first. The
//! board is public; only the side to move receives its legal move list.
use crate::games::Board;
use serde_json::{json, Value};

const START: &[u8; 90] = b"rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P.C.....C..........RNBAKABNR";
/// 60 full moves (120 plies) without a capture is a draw.
const QUIET_LIMIT: u32 = 120;
pub struct Xiangqi {
    /// Index row * 9 + col; row 0 is black's back rank. Uppercase red, lowercase black, b'.' empty.
    board: [u8; 90],
    turn: usize,
    finished: bool,
    winner: Option<usize>,
    left: [bool; 2],
    note: String,
    last: Option<(usize, usize)>,
    quiet: u32,
    plies: u32,
    draw_offer: Option<usize>,
    captured: [Vec<u8>; 2],
}
fn side(p: u8) -> Option<usize> {
    match p {
        b'.' => None,
        p if p.is_ascii_uppercase() => Some(0),
        _ => Some(1),
    }
}
fn at(r: i32, c: i32) -> Option<usize> {
    ((0..10).contains(&r) && (0..9).contains(&c)).then(|| (r * 9 + c) as usize)
}
fn in_palace(s: usize, who: usize) -> bool {
    let (r, c) = (s / 9, s % 9);
    (3..=5).contains(&c) && if who == 0 { r >= 7 } else { r <= 2 }
}
fn own_half(s: usize, who: usize) -> bool {
    if who == 0 {
        s / 9 >= 5
    } else {
        s / 9 <= 4
    }
}
fn value(p: u8) -> u32 {
    match p.to_ascii_uppercase() {
        b'K' => 1000,
        b'R' => 9,
        b'C' | b'N' => 4,
        b'A' | b'B' => 2,
        _ => 1,
    }
}
pub fn name(p: u8) -> &'static str {
    match p {
        b'K' => "帅",
        b'A' => "仕",
        b'B' => "相",
        b'N' => "马",
        b'R' => "车",
        b'C' => "炮",
        b'P' => "兵",
        b'k' => "将",
        b'a' => "士",
        b'b' => "象",
        b'n' => "马",
        b'r' => "车",
        b'c' => "炮",
        _ => "卒",
    }
}
impl Xiangqi {
    pub fn new() -> Self {
        Self {
            board: *START,
            turn: 0,
            finished: false,
            winner: None,
            left: [false; 2],
            note: "红方先走；点自己的棋子，再点要去的位置".into(),
            last: None,
            quiet: 0,
            plies: 0,
            draw_offer: None,
            captured: [vec![], vec![]],
        }
    }
    /// Moves obeying piece geometry only; may still leave the mover's general exposed.
    fn pseudo(&self, s: usize) -> Vec<usize> {
        let p = self.board[s];
        let Some(who) = side(p) else { return vec![] };
        let (r, c) = ((s / 9) as i32, (s % 9) as i32);
        let free = |t: usize| side(self.board[t]) != Some(who);
        let empty = |t: usize| self.board[t] == b'.';
        let orth = [(1, 0), (-1, 0), (0, 1), (0, -1)];
        let diag = [(1, 1), (1, -1), (-1, 1), (-1, -1)];
        let mut out = vec![];
        match p.to_ascii_uppercase() {
            b'K' => out.extend(
                orth.iter()
                    .filter_map(|(dr, dc)| at(r + dr, c + dc))
                    .filter(|t| in_palace(*t, who) && free(*t)),
            ),
            b'A' => out.extend(
                diag.iter()
                    .filter_map(|(dr, dc)| at(r + dr, c + dc))
                    .filter(|t| in_palace(*t, who) && free(*t)),
            ),
            b'B' => {
                for (dr, dc) in diag {
                    if let (Some(eye), Some(t)) = (at(r + dr, c + dc), at(r + 2 * dr, c + 2 * dc)) {
                        if empty(eye) && own_half(t, who) && free(t) {
                            out.push(t);
                        }
                    }
                }
            }
            b'N' => {
                for (dr, dc) in orth {
                    let Some(leg) = at(r + dr, c + dc) else { continue };
                    if !empty(leg) {
                        continue;
                    }
                    let side_steps = if dr == 0 { [(1, 0), (-1, 0)] } else { [(0, 1), (0, -1)] };
                    for (sr, sc) in side_steps {
                        if let Some(t) = at(r + 2 * dr + sr, c + 2 * dc + sc) {
                            if free(t) {
                                out.push(t);
                            }
                        }
                    }
                }
            }
            b'R' | b'C' => {
                let cannon = p.eq_ignore_ascii_case(&b'C');
                for (dr, dc) in orth {
                    let (mut rr, mut cc) = (r + dr, c + dc);
                    let mut screen = false;
                    while let Some(t) = at(rr, cc) {
                        if empty(t) {
                            if !screen {
                                out.push(t);
                            }
                        } else if !cannon {
                            if free(t) {
                                out.push(t);
                            }
                            break;
                        } else if !screen {
                            screen = true;
                        } else {
                            if free(t) {
                                out.push(t);
                            }
                            break;
                        }
                        rr += dr;
                        cc += dc;
                    }
                }
            }
            _ => {
                let forward = if who == 0 { -1 } else { 1 };
                let mut steps = vec![(forward, 0)];
                if !own_half(s, who) {
                    steps.extend([(0, 1), (0, -1)]);
                }
                out.extend(
                    steps
                        .iter()
                        .filter_map(|(dr, dc)| at(r + dr, c + dc))
                        .filter(|t| free(*t)),
                );
            }
        }
        out
    }
    fn general(&self, who: usize) -> Option<usize> {
        let k = if who == 0 { b'K' } else { b'k' };
        self.board.iter().position(|p| *p == k)
    }
    fn exposed(&self, who: usize) -> bool {
        let Some(k) = self.general(who) else { return true };
        if let Some(other) = self.general(1 - who) {
            if k % 9 == other % 9 {
                let (a, b) = (k.min(other), k.max(other));
                if (a + 9..b).step_by(9).all(|s| self.board[s] == b'.') {
                    return true;
                }
            }
        }
        (0..90)
            .filter(|s| side(self.board[*s]) == Some(1 - who))
            .any(|s| self.pseudo(s).contains(&k))
    }
    fn legal(&self, who: usize) -> Vec<(usize, usize)> {
        let mut out = vec![];
        for s in (0..90).filter(|s| side(self.board[*s]) == Some(who)) {
            for t in self.pseudo(s) {
                let mut next = Xiangqi { board: self.board, ..Xiangqi::new() };
                next.board[t] = next.board[s];
                next.board[s] = b'.';
                if !next.exposed(who) {
                    out.push((s, t));
                }
            }
        }
        out
    }
    fn play(&mut self, from: usize, to: usize) {
        let who = self.turn;
        let piece = self.board[from];
        let taken = self.board[to];
        if taken != b'.' {
            self.captured[who].push(taken);
            self.quiet = 0;
        } else {
            self.quiet += 1;
        }
        self.board[to] = piece;
        self.board[from] = b'.';
        self.last = Some((from, to));
        self.plies += 1;
        if self.draw_offer == Some(1 - who) {
            self.draw_offer = None;
        }
        self.turn = 1 - who;
        let mover = ["红", "黑"][who];
        if self.legal(self.turn).is_empty() {
            let how = if self.exposed(self.turn) { "绝杀" } else { "困毙" };
            self.end(Some(who), &format!("{mover}方{how}获胜"));
        } else if self.quiet >= QUIET_LIMIT {
            self.end(None, "六十回合未吃子，判和，奖金平分");
        } else if !self.board.iter().any(|p| b"RNCPrncp".contains(p)) {
            self.end(None, "双方都没有过河子力，判和，奖金平分");
        } else {
            let what = if taken == b'.' {
                format!("{mover}方走{}", name(piece))
            } else {
                format!("{mover}方{}吃{}", name(piece), name(taken))
            };
            let check = if self.exposed(self.turn) { "，将军！" } else { "" };
            self.note = format!("{what}{check}");
        }
    }
    fn end(&mut self, winner: Option<usize>, note: &str) {
        self.finished = true;
        self.winner = winner;
        self.draw_offer = None;
        self.note = note.into();
    }
    /// Stand-in for a disconnected player: take the most valuable piece, else any legal move.
    fn stand_in(&mut self) {
        let moves = self.legal(self.turn);
        let best = moves
            .iter()
            .map(|(_, t)| if self.board[*t] == b'.' { 0 } else { value(self.board[*t]) })
            .max()
            .unwrap_or(0);
        let pool: Vec<_> = moves
            .into_iter()
            .filter(|(_, t)| (if self.board[*t] == b'.' { 0 } else { value(self.board[*t]) }) == best)
            .collect();
        if !pool.is_empty() {
            let (from, to) = pool[crate::cards::below(pool.len() as u32) as usize];
            self.play(from, to);
        }
    }
}

impl Board for Xiangqi {
    fn can_act(&self, i: usize) -> bool {
        !self.finished && !self.left[i] && self.turn == i
    }
    fn snapshot(&self, viewer: Option<usize>) -> Value {
        let moves = viewer
            .filter(|i| self.can_act(*i))
            .map_or(vec![], |i| self.legal(i));
        json!({
            "board":String::from_utf8_lossy(&self.board),"turn":self.turn,"finished":self.finished,
            "winner":self.winner,"note":self.note,"last":self.last.map(|(a,b)|[a,b]),
            "check":!self.finished && self.exposed(self.turn),"drawOffer":self.draw_offer,
            "moves":moves.iter().map(|(a,b)|[a,b]).collect::<Vec<_>>(),
            "captured":self.captured.iter().map(|c|String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>(),
            "plies":self.plies,"quiet":self.quiet,
        })
    }
    fn command(&mut self, i: usize, msg: &Value) -> Result<(), String> {
        if self.finished || self.left[i] {
            return Err("本局已结束".into());
        }
        match msg["op"].as_str().unwrap_or("") {
            "draw" => {
                if self.draw_offer == Some(1 - i) {
                    self.end(None, "双方同意和棋，奖金平分");
                } else {
                    self.draw_offer = Some(i);
                    self.note = format!("{}方提议和棋，对方可以同意或继续走棋", ["红", "黑"][i]);
                }
                Ok(())
            }
            "move" => {
                if self.turn != i {
                    return Err("还没轮到你".into());
                }
                let square = |k: &str| {
                    msg[k]
                        .as_u64()
                        .filter(|n| *n < 90)
                        .map(|n| n as usize)
                        .ok_or("无效位置")
                };
                let (from, to) = (square("from")?, square("to")?);
                if !self.legal(i).contains(&(from, to)) {
                    return Err("这步棋不合规则，或会让自己的将帅被将".into());
                }
                self.play(from, to);
                Ok(())
            }
            _ => Err("请走棋、提议和棋或退出".into()),
        }
    }
    fn forfeit(&mut self, i: usize) {
        self.left[i] = true;
        if !self.finished {
            self.end(Some(1 - i), &format!("{}方认输", ["红", "黑"][i]));
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
        // A draw shares the prize between both players.
        self.finished
            .then(|| self.winner.map_or(vec![0, 1], |w| vec![w]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sq(r: usize, c: usize) -> usize {
        r * 9 + c
    }
    fn empty_with(pieces: &[(usize, u8)]) -> Xiangqi {
        let mut x = Xiangqi::new();
        x.board = [b'.'; 90];
        for (s, p) in pieces {
            x.board[*s] = *p;
        }
        x
    }
    #[test]
    fn opening_has_44_moves_and_horse_leg_blocks() {
        let x = Xiangqi::new();
        assert_eq!(x.legal(0).len(), 44);
        assert_eq!(x.legal(1).len(), 44);
        let mut x = Xiangqi::new();
        x.board[sq(8, 1)] = b'P';
        assert!(!x.pseudo(sq(9, 1)).contains(&sq(7, 2)));
        assert!(!x.pseudo(sq(9, 1)).contains(&sq(7, 0)));
    }
    #[test]
    fn cannon_needs_exactly_one_screen_to_capture() {
        let x = Xiangqi::new();
        let moves = x.pseudo(sq(7, 1));
        assert!(moves.contains(&sq(0, 1)));
        assert!(moves.contains(&sq(3, 1)));
        assert!(!moves.contains(&sq(2, 1)));
        assert!(!moves.contains(&sq(1, 1)));
    }
    #[test]
    fn generals_may_not_face_and_illegal_moves_are_rejected() {
        let mut x = empty_with(&[(sq(9, 4), b'K'), (sq(0, 3), b'k'), (sq(5, 5), b'R')]);
        assert!(!x.legal(0).iter().any(|(_, t)| *t == sq(9, 3)));
        assert!(x
            .command(0, &json!({"op":"move","from":sq(9, 4),"to":sq(9, 3)}))
            .is_err());
        x.command(0, &json!({"op":"move","from":sq(5, 5),"to":sq(0, 5)}))
            .unwrap();
        assert!(x.note.contains("将军"));
        assert!(!x.finished);
        assert_eq!(x.legal(1), vec![(sq(0, 3), sq(1, 3))]);
    }
    #[test]
    fn checkmate_ends_the_game_for_the_mover() {
        // Two chariots on adjacent files mate the black general on its back rank.
        let mut x = empty_with(&[(sq(9, 3), b'K'), (sq(0, 4), b'k'), (sq(1, 0), b'R'), (sq(5, 8), b'R')]);
        x.command(0, &json!({"op":"move","from":sq(5, 8),"to":sq(0, 8)}))
            .unwrap();
        assert!(x.finished);
        assert_eq!(x.winner, Some(0));
    }
    #[test]
    fn draw_needs_both_sides_and_moving_declines() {
        let mut x = Xiangqi::new();
        x.command(0, &json!({"op":"draw"})).unwrap();
        x.command(0, &json!({"op":"move","from":sq(7, 1),"to":sq(7, 4)}))
            .unwrap();
        x.command(1, &json!({"op":"move","from":sq(2, 1),"to":sq(2, 4)}))
            .unwrap();
        assert!(x.draw_offer.is_none());
        x.command(0, &json!({"op":"draw"})).unwrap();
        x.command(1, &json!({"op":"draw"})).unwrap();
        assert!(x.finished);
        assert_eq!(x.winner, None);
    }
    #[test]
    fn automatic_play_always_terminates() {
        for _ in 0..3 {
            let mut x = Xiangqi::new();
            for _ in 0..5000 {
                if x.finished {
                    break;
                }
                assert!(x.auto(&|_| true));
            }
            assert!(x.finished);
        }
    }
}
