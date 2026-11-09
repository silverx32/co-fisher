//! Card rules shared by the three server-authoritative games. Cards are 0..51;
//! rank 0 is 2, rank 12 is ace; 52/53 are the two jokers.
pub fn deck(jokers: bool) -> Vec<u8> {
    let mut cards: Vec<u8> = (0..if jokers { 54 } else { 52 }).collect();
    for i in (1..cards.len()).rev() {
        cards.swap(i, below(i as u32 + 1) as usize);
    }
    cards
}

/// Uniform 0..bound from the OS; rejection sampling avoids modulo bias.
pub fn below(bound: u32) -> u32 {
    let limit = u32::MAX - u32::MAX % bound;
    loop {
        let mut b = [0; 4];
        getrandom::fill(&mut b).expect("OS random source");
        let n = u32::from_le_bytes(b);
        if n < limit {
            return n % bound;
        }
    }
}

pub fn token() -> String {
    let mut b = [0; 16];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|n| format!("{n:02x}")).collect()
}

pub fn blackjack(cards: &[u8]) -> u16 {
    let mut aces = 0;
    let mut score = 0;
    for c in cards {
        let r = c % 13;
        score += if r == 12 {
            aces += 1;
            11
        } else {
            (r as u16 + 2).min(10)
        };
    }
    while score > 21 && aces > 0 {
        score -= 10;
        aces -= 1;
    }
    score
}

/// Lexicographically ordered category and kickers, encoded base 15.
fn five(cards: &[u8]) -> u64 {
    let mut counts = [0u8; 15];
    for c in cards {
        counts[(c % 13 + 2) as usize] += 1;
    }
    let flush = cards.iter().all(|c| c / 13 == cards[0] / 13);
    let mut straight = 0;
    for high in (5..=14).rev() {
        if (0..5).all(|d| counts[if high - d == 1 { 14 } else { high - d }] > 0) {
            straight = high as u8;
            break;
        }
    }
    let mut groups: Vec<(u8, u8)> = (2..=14)
        .filter(|r| counts[*r] > 0)
        .map(|r| (counts[r], r as u8))
        .collect();
    groups.sort_unstable_by(|a, b| b.cmp(a));
    let mut ranks: Vec<u8> = groups.iter().map(|g| g.1).collect();
    let category = if flush && straight > 0 {
        ranks = vec![straight];
        8
    } else if groups[0].0 == 4 {
        7
    } else if groups[0].0 == 3 && groups[1].0 == 2 {
        6
    } else if flush {
        5
    } else if straight > 0 {
        ranks = vec![straight];
        4
    } else if groups[0].0 == 3 {
        3
    } else if groups[0].0 == 2 && groups[1].0 == 2 {
        2
    } else if groups[0].0 == 2 {
        1
    } else {
        0
    };
    let mut score = category as u64;
    for i in 0..5 {
        score = score * 15 + ranks.get(i).copied().unwrap_or(0) as u64;
    }
    score
}

pub fn poker(cards: &[u8]) -> u64 {
    let mut best = 0;
    for a in 0..cards.len() {
        for b in a + 1..cards.len() {
            for c in b + 1..cards.len() {
                for d in c + 1..cards.len() {
                    for e in d + 1..cards.len() {
                        best = best.max(five(&[cards[a], cards[b], cards[c], cards[d], cards[e]]));
                    }
                }
            }
        }
    }
    best
}

/// Dou Dizhu ranks: 3..A, 2, small joker, big joker.
pub fn ddz_rank(card: u8) -> u8 {
    if card >= 52 {
        return card - 52 + 13;
    }
    (card % 13 + 12) % 13
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    pub kind: u8,
    pub high: u8,
    pub span: usize,
    pub len: usize,
}

pub fn pattern(cards: &[u8]) -> Option<Pattern> {
    if cards.is_empty() || cards.len() > 20 || cards.iter().any(|c| *c > 53) {
        return None;
    }
    let mut seen = [false; 54];
    let mut n = [0usize; 15];
    for &c in cards {
        if seen[c as usize] {
            return None;
        }
        seen[c as usize] = true;
        n[ddz_rank(c) as usize] += 1;
    }
    let len = cards.len();
    let make = |kind, high, span| {
        Some(Pattern {
            kind,
            high: high as u8,
            span,
            len,
        })
    };
    if len == 2 && n[13] == 1 && n[14] == 1 {
        return make(10, 14, 1);
    }
    let groups: Vec<usize> = (0..15).filter(|r| n[*r] > 0).collect();
    if groups.len() == 1 {
        return match len {
            1 => make(0, groups[0], 1),
            2 => make(1, groups[0], 1),
            3 => make(2, groups[0], 1),
            4 => make(9, groups[0], 1),
            _ => None,
        };
    }
    if let Some(t) = (0..13).find(|r| n[*r] == 3) {
        if len == 4 {
            return make(3, t, 1);
        }
        if len == 5 && n.iter().any(|v| *v == 2) {
            return make(4, t, 1);
        }
    }
    for (copies, min, kind) in [(1, 5, 5), (2, 3, 6), (3, 2, 7)] {
        if groups.len() >= min
            && groups.last().copied().unwrap() < 12
            && groups.windows(2).all(|g| g[1] == g[0] + 1)
            && groups.iter().all(|r| n[*r] == copies)
        {
            return make(kind, *groups.last().unwrap(), groups.len());
        }
    }
    // Airplanes with single or paired wings; the body cannot include 2 or jokers.
    for (unit, kind) in [(4, 11), (5, 12)] {
        if len % unit != 0 || len / unit < 2 {
            continue;
        }
        let span = len / unit;
        for start in 0..=12usize.saturating_sub(span) {
            if !(start..start + span).all(|r| n[r] == 3) {
                continue;
            }
            let wings: Vec<usize> = (0..15)
                .filter(|r| *r < start || *r >= start + span)
                .map(|r| n[r])
                .filter(|v| *v > 0)
                .collect();
            if (unit == 4 && wings.iter().sum::<usize>() == span && !(n[13] > 0 && n[14] > 0))
                || (unit == 5 && wings.len() == span && wings.iter().all(|v| *v == 2))
            {
                return make(kind, start + span - 1, span);
            }
        }
    }
    if let Some(q) = (0..13).find(|r| n[*r] == 4) {
        if len == 6 && !(n[13] > 0 && n[14] > 0) {
            return make(13, q, 1);
        }
        if len == 8 && (0..15).filter(|r| *r != q && n[*r] == 2).count() == 2 {
            return make(14, q, 1);
        }
    }
    None
}

pub fn beats(a: &Pattern, b: &Pattern) -> bool {
    if a.kind == 10 {
        return b.kind != 10;
    }
    if b.kind == 10 {
        return false;
    }
    if a.kind == 9 && b.kind != 9 {
        return true;
    }
    a.kind == b.kind && a.span == b.span && a.len == b.len && a.high > b.high
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rank(r: u8, n: u8) -> Vec<u8> {
        (0..n).map(|s| s * 13 + (r + 1) % 13).collect()
    }
    #[test]
    fn scores_aces_and_busts() {
        assert_eq!(blackjack(&[12, 25, 9]), 12);
        assert_eq!(blackjack(&[12, 8]), 21);
        assert_eq!(blackjack(&[12, 25, 7]), 21);
    }
    #[test]
    fn poker_wheel_flush_and_kickers() {
        assert!(poker(&[12, 0, 1, 2, 3]) > poker(&[0, 13, 26, 39, 12]));
        assert!(poker(&[4, 5, 6, 7, 8]) > poker(&[12, 0, 1, 2, 3]));
        assert!(poker(&[12, 25, 11, 24, 10, 23, 9]) > poker(&[12, 25, 11, 24, 8, 21, 7]));
        assert_eq!(
            poker(&[12, 11, 10, 9, 8, 13, 27]),
            poker(&[12, 11, 10, 9, 8, 15, 29])
        );
    }
    #[test]
    fn ddz_combinations_and_comparison() {
        let straight: Vec<u8> = (0..5).map(|r| rank(r, 1)[0]).collect();
        assert_eq!(pattern(&straight).unwrap().kind, 5);
        assert!(pattern(&[0, 1, 2, 3, 4]).is_none()); // 2 cannot be in a straight
        let mut plane = rank(0, 3);
        plane.extend(rank(1, 3));
        plane.extend(rank(5, 2));
        assert_eq!(pattern(&plane).unwrap().kind, 11);
        assert!(beats(
            &pattern(&[52, 53]).unwrap(),
            &pattern(&rank(12, 4)).unwrap()
        ));
        assert!(pattern(&[1, 1]).is_none());
        let mut full = rank(3, 3);
        full.extend(rank(1, 2));
        assert_eq!(pattern(&full).unwrap().kind, 4);
    }
    #[test]
    fn shuffled_decks_have_unique_cards() {
        for jokers in [false, true] {
            let mut d = deck(jokers);
            d.sort();
            assert_eq!(d, (0..if jokers { 54 } else { 52 }).collect::<Vec<u8>>());
        }
    }
}
