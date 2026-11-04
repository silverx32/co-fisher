//! Cosmetics ("装扮"): a PNG worn on top of (or behind) any character, one per slot (头饰 /
//! 宠物 / 特效). Obtained from a chest
//! (costs points, once per cooldown) and by merging 10 of one rarity, picked by hand, into one
//! of the next. Each room boss also has cosmetics of its own, dropped only by its last hit
//! (they can go into a merge, but never come out of one).
//! The catalogue is generated together with the art by tools/gen-decos.js.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use cofisher_server::BOSSES;
use serde::Deserialize;
use serde_json::{json, Value};

pub const CHEST_COST: u64 = 3000;
pub const CHEST_COOLDOWN_MS: u64 = 30 * 60 * 1000;
pub const MERGE_COUNT: u64 = 10;

/// Still waiting since the chest was last opened at `last` (Unix ms)? A clock turned back
/// doesn't lock the chest.
pub fn chest_cooling(last: u64, now: u64) -> bool {
    last <= now && now < last + CHEST_COOLDOWN_MS
}

/// Can be opened right now: cooled down and enough points.
pub fn chest_ready(last: u64, now: u64, count: u64) -> bool {
    !chest_cooling(last, now) && count >= CHEST_COST
}

pub struct Rarity {
    pub name: &'static str,
    pub color: &'static str,
    /// Chest odds, in 1/1000.
    pub weight: u32,
}

pub const RARITIES: [Rarity; 5] = [
    Rarity { name: "普通", color: "#8c939d", weight: 620 },
    Rarity { name: "稀有", color: "#3b8beb", weight: 260 },
    Rarity { name: "史诗", color: "#a855f7", weight: 90 },
    Rarity { name: "传说", color: "#f59e0b", weight: 25 },
    Rarity { name: "神话", color: "#ef4444", weight: 5 },
];
/// Odds for the chest of whoever lands a boss's last hit: a bit better than RARITIES' (in 1/1000).
pub const LUCKY_WEIGHTS: [u32; 5] = [540, 290, 120, 40, 10];
/// Odds by rarity of the boss's own cosmetic that its last hit also drops (in 1/1000; rarities
/// a boss has none of are left out).
pub const BOSS_DROP_WEIGHTS: [u32; 5] = [450, 300, 160, 70, 20];

/// Share of chests (in %) that hold an item bundle instead of a cosmetic.
pub const ITEM_CHANCE: u32 = 25;
/// Item bundles by rarity, one picked at random: (item id, how many).
const BUNDLES: [&[&[(&str, u64)]]; 5] = [
    &[&[("tomato", 10)], &[("ink", 5)], &[("umbrella", 1)]],
    &[&[("poop", 5)], &[("firework", 3)], &[("umbrella", 2)]],
    &[&[("rain", 2)], &[("firework", 6)]],
    &[&[("rain", 3), ("umbrella", 2)]],
    &[&[("rain", 6), ("firework", 6), ("umbrella", 2)]],
];

/// What a chest gives.
pub enum Prize {
    Deco(&'static Deco),
    /// Rarity and the items.
    Items(usize, &'static [(&'static str, u64)]),
}

/// (id, name) of each slot; one item per slot can be worn at a time.
pub const SLOTS: [(&str, &str); 3] = [("head", "头饰"), ("pet", "宠物"), ("fx", "特效")];

#[derive(Deserialize, Clone)]
pub struct Deco {
    pub id: String,
    pub name: String,
    pub rarity: usize,
    pub slot: String,
    pub layer: String,
    /// Square crop around the art in image pixels [x0, y0, x1, y1], for icons.
    #[serde(rename = "box", default)]
    pub icon_box: Vec<u32>,
    /// The boss whose last hit drops it; never from chests or merges. Empty for the others.
    #[serde(default)]
    pub boss: String,
}

pub fn all() -> &'static [Deco] {
    static ALL: OnceLock<Vec<Deco>> = OnceLock::new();
    ALL.get_or_init(|| {
        let list: Vec<Deco> = serde_json::from_str(include_str!("../../ui/assets/decos/decos.json")).expect("decos.json");
        list.into_iter().filter(|d| d.rarity < RARITIES.len() && SLOTS.iter().any(|s| s.0 == d.slot)).collect()
    })
}

pub fn get(id: &str) -> Option<&'static Deco> {
    all().iter().find(|d| d.id == id)
}

pub fn catalogue() -> Value {
    let items = all().iter().map(|d| {
        let mut v = json!({ "id": d.id, "name": d.name, "rarity": d.rarity, "slot": d.slot, "layer": d.layer, "box": d.icon_box });
        if !d.boss.is_empty() {
            v["boss"] = d.boss.clone().into();
            v["drop"] = drop_pct(d).into();
        }
        v
    });
    json!({
        "items": items.collect::<Vec<_>>(),
        "slots": SLOTS.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "bosses": BOSSES.iter().map(|b| json!({ "id": b.id, "emoji": b.emoji, "name": b.name })).collect::<Vec<_>>(),
        "rarities": RARITIES
            .iter()
            .zip(LUCKY_WEIGHTS)
            .map(|(r, lucky)| json!({ "name": r.name, "color": r.color, "odds": r.weight as f64 / 10.0, "luckyOdds": lucky as f64 / 10.0 }))
            .collect::<Vec<_>>(),
        "itemChance": ITEM_CHANCE,
        "chestCost": CHEST_COST,
        "chestCooldownMs": CHEST_COOLDOWN_MS,
        "mergeCount": MERGE_COUNT,
    })
}

/// Uniform in 0..n.
fn rand_below(n: u32) -> u32 {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    // n is tiny, so the modulo bias is negligible.
    u32::from_le_bytes(b) % n
}

/// A chest's or merge's cosmetic of `rarity` (bosses' own aren't among them).
fn pick_in(rarity: usize) -> &'static Deco {
    let pool: Vec<&Deco> = all().iter().filter(|d| d.rarity == rarity && d.boss.is_empty()).collect();
    pool[rand_below(pool.len() as u32) as usize]
}

fn roll_rarity(weights: &[u32]) -> usize {
    let mut x = rand_below(weights.iter().sum());
    for (i, w) in weights.iter().enumerate() {
        if x < *w {
            return i;
        }
        x -= w;
    }
    0
}

/// Opens a chest: a rarity first (`lucky`: the boss's last hit), then a cosmetic or an item bundle of it.
pub fn roll_chest(lucky: bool) -> Prize {
    let rarity = if lucky { roll_rarity(&LUCKY_WEIGHTS) } else { roll_rarity(&RARITIES.map(|r| r.weight)) };
    if rand_below(100) < ITEM_CHANCE {
        let bundles = BUNDLES[rarity];
        return Prize::Items(rarity, bundles[rand_below(bundles.len() as u32) as usize]);
    }
    Prize::Deco(pick_in(rarity))
}

/// A boss's own cosmetics, and the odds of each rarity among them (0 where it has none).
fn boss_pool(boss: &str) -> (Vec<&'static Deco>, [u32; 5]) {
    let pool: Vec<&Deco> = all().iter().filter(|d| !d.boss.is_empty() && d.boss == boss).collect();
    let weights = std::array::from_fn(|r| if pool.iter().any(|d| d.rarity == r) { BOSS_DROP_WEIGHTS[r] } else { 0 });
    (pool, weights)
}

/// What the last hit on `boss` drops: a rarity first, then one of its cosmetics of that rarity.
/// `None` for a boss without any (e.g. one only a newer server has).
pub fn roll_boss_drop(boss: &str) -> Option<&'static Deco> {
    let (pool, weights) = boss_pool(boss);
    if pool.is_empty() {
        return None;
    }
    let rarity = roll_rarity(&weights);
    let of: Vec<&Deco> = pool.into_iter().filter(|d| d.rarity == rarity).collect();
    Some(of[rand_below(of.len() as u32) as usize])
}

/// Chance (in %) that its boss's last hit drops `d`.
fn drop_pct(d: &Deco) -> f64 {
    let (pool, weights) = boss_pool(&d.boss);
    let same = pool.iter().filter(|x| x.rarity == d.rarity).count().max(1);
    weights[d.rarity] as f64 * 100.0 / weights.iter().sum::<u32>().max(1) as f64 / same as f64
}

pub type Owned = BTreeMap<String, u64>;
/// Copies picked for a merge: id -> how many.
pub type Picks = BTreeMap<String, u64>;

/// Copies of `id` a merge may use: all of them, except the last one of something worn.
fn usable(owned: &Owned, id: &str, worn: &[String]) -> u64 {
    let n = owned.get(id).copied().unwrap_or(0);
    if worn.iter().any(|w| w == id) { n.saturating_sub(1) } else { n }
}

/// Checks a merge the player picked: MERGE_COUNT usable copies, all of one rarity below the top
/// (bosses' own count like any other). Returns that rarity and how many cosmetics would be gone
/// from the collection afterwards.
pub fn check_picks(owned: &Owned, picks: &Picks, worn: &[String]) -> Result<(usize, u64), String> {
    let mut rarity = None;
    let mut lost = 0;
    for (id, n) in picks {
        let d = get(id).ok_or("没有这个装扮")?;
        if *rarity.get_or_insert(d.rarity) != d.rarity {
            return Err("只能用同一种稀有度的装扮合成".into());
        }
        if *n == 0 || *n > usable(owned, id, worn) {
            return Err(format!("{}不够了（正在穿的要留一件）", d.name));
        }
        if owned.get(id) == Some(n) {
            lost += 1;
        }
    }
    if picks.values().sum::<u64>() != MERGE_COUNT {
        return Err(format!("要选 {MERGE_COUNT} 件"));
    }
    match rarity {
        Some(r) if r + 1 < RARITIES.len() => Ok((r, lost)),
        _ => Err("最高稀有度不能再合成了".into()),
    }
}

/// Uses up the picked copies (see `check_picks`) and returns the new cosmetic: a random one of
/// the next rarity from the chests' pool (a boss's own only ever drop from its last hit).
pub fn merge(owned: &mut Owned, picks: &Picks, worn: &[String]) -> Result<&'static Deco, String> {
    let (rarity, _) = check_picks(owned, picks, worn)?;
    for (id, n) in picks {
        if let Some(c) = owned.get_mut(id) {
            *c -= n;
            if *c == 0 {
                owned.remove(id);
            }
        }
    }
    let got = pick_in(rarity + 1);
    *owned.entry(got.id.clone()).or_default() += 1;
    Ok(got)
}

/// Tops a merge of `rarity` up to MERGE_COUNT copies (the 补满 button): spare duplicates first
/// (chest cosmetics before bosses' own, most copies first), then the last copies of chest
/// cosmetics, least-owned first. A boss's own last copy only goes in when picked by hand. Stops
/// short when there aren't enough.
pub fn fill_picks(owned: &Owned, rarity: usize, worn: &[String], picks: &mut Picks) {
    let mut items: Vec<(&String, &Deco, u64)> =
        owned.iter().filter_map(|(id, n)| get(id).filter(|d| d.rarity == rarity).map(|d| (id, d, *n))).collect();
    items.sort_by_key(|(id, d, n)| (!d.boss.is_empty(), std::cmp::Reverse(*n), *id));
    let spares = items.iter().map(|(id, _, n)| (*id, n.saturating_sub(1)));
    let last_copies = items.iter().rev().filter(|(_, d, _)| d.boss.is_empty()).map(|(id, _, _)| (*id, usable(owned, id, worn)));
    let mut need = MERGE_COUNT.saturating_sub(picks.values().sum());
    for (id, limit) in spares.chain(last_copies) {
        let add = limit.saturating_sub(picks.get(id).copied().unwrap_or(0)).min(need);
        if add > 0 {
            *picks.entry(id.clone()).or_default() += add;
            need -= add;
        }
    }
}

/// Per rarity: { owned (copies), usable (copies a merge may use) }.
pub fn stats(owned: &Owned, worn: &[String]) -> Value {
    (0..RARITIES.len())
        .map(|r| {
            let mine: Vec<&String> = owned.keys().filter(|id| get(id).is_some_and(|d| d.rarity == r)).collect();
            json!({
                "owned": mine.iter().map(|id| owned[*id]).sum::<u64>(),
                "usable": mine.iter().map(|id| usable(owned, id, worn)).sum::<u64>(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Chest / merge cosmetics of rarity `r`.
    fn ids(r: usize) -> Vec<String> {
        all().iter().filter(|d| d.rarity == r && d.boss.is_empty()).map(|d| d.id.clone()).collect()
    }

    #[test]
    fn catalogue_is_complete() {
        assert_eq!(all().iter().filter(|d| d.boss.is_empty()).count(), 140);
        for (slot, _) in SLOTS {
            assert!(all().iter().any(|d| d.slot == slot), "slot {slot} has items");
        }
        for r in 0..RARITIES.len() {
            assert!(!ids(r).is_empty(), "rarity {r} has items");
        }
        assert!(all().iter().all(|d| cofisher_server::clean_deco(&json!(d.id)) == d.id && (d.layer == "front" || d.layer == "back")));
        assert_eq!(RARITIES.iter().map(|r| r.weight).sum::<u32>(), 1000);
    }

    fn picks(list: &[(&String, u64)]) -> Picks {
        list.iter().map(|(id, n)| ((*id).clone(), *n)).collect()
    }

    #[test]
    fn picked_merges_are_checked_and_keep_the_worn_copy() {
        let c = ids(0);
        let mut owned = Owned::from([(c[0].clone(), 6), (c[1].clone(), 3), (c[2].clone(), 1)]);
        let worn = vec![c[1].clone(), "some-pet".to_string()];
        // Ten copies, but the worn c[1] keeps its last one.
        assert!(check_picks(&owned, &picks(&[(&c[0], 6), (&c[1], 3), (&c[2], 1)]), &worn).is_err());
        assert!(check_picks(&owned, &picks(&[(&c[0], 6), (&c[1], 2), (&c[2], 1)]), &worn).is_err(), "only 9");
        owned.insert(c[3].clone(), 1);
        let ok = picks(&[(&c[0], 6), (&c[1], 2), (&c[2], 1), (&c[3], 1)]);
        assert_eq!(check_picks(&owned, &ok, &worn), Ok((0, 3)), "c[0], c[2] and c[3] would be gone");
        // Mixed rarities, unknown ids, the top rarity.
        let r1 = ids(1);
        owned.insert(r1[0].clone(), 1);
        assert!(check_picks(&owned, &picks(&[(&c[0], 6), (&c[1], 2), (&c[2], 1), (&r1[0], 1)]), &worn).is_err());
        assert!(check_picks(&owned, &picks(&[(&"no-such".to_string(), 10)]), &[]).is_err());
        let top = ids(RARITIES.len() - 1);
        owned.insert(top[0].clone(), 10);
        assert!(check_picks(&owned, &picks(&[(&top[0], 10)]), &[]).is_err());

        let got = merge(&mut owned, &ok, &worn).unwrap();
        assert!(got.rarity == 1 && got.boss.is_empty());
        assert_eq!(owned.get(&c[1]), Some(&1));
        assert!(!owned.contains_key(&c[0]) && !owned.contains_key(&c[2]) && !owned.contains_key(&c[3]));
        assert!(merge(&mut owned, &ok, &worn).is_err(), "used up");
    }

    #[test]
    fn fill_uses_spares_first_and_never_a_bosss_last_copy() {
        let c = ids(0);
        let boss: Vec<&Deco> = all().iter().filter(|d| !d.boss.is_empty() && d.rarity == 0).take(2).collect();
        let worn = vec![c[2].clone()];
        let mut owned = Owned::from([(c[0].clone(), 4), (c[1].clone(), 1), (c[2].clone(), 1), (boss[0].id.clone(), 3), (boss[1].id.clone(), 1)]);
        // One c[0] picked by hand; then c[0]'s other spares, the boss's spares, and the last copies
        // of chest ones (not the worn c[2], never a boss's last copy). Seven is all there is.
        let mut p = picks(&[(&c[0], 1)]);
        fill_picks(&owned, 0, &worn, &mut p);
        assert_eq!(p, picks(&[(&c[0], 4), (&c[1], 1), (&boss[0].id, 2)]));
        owned.insert(c[3].clone(), 5);
        let mut p = Picks::new();
        fill_picks(&owned, 0, &worn, &mut p);
        assert_eq!(p, picks(&[(&c[3], 4), (&c[0], 3), (&boss[0].id, 2), (&c[1], 1)]));
        assert_eq!(check_picks(&owned, &p, &worn), Ok((0, 1)));
        assert_eq!(stats(&owned, &worn)[0], json!({ "owned": 15, "usable": 14 }));
    }

    #[test]
    fn chest_rolls_valid_prizes() {
        let (mut decos, mut bundles) = (0, 0);
        for i in 0..2000 {
            match roll_chest(i % 2 == 0) {
                Prize::Deco(d) => {
                    assert!(get(&d.id).is_some());
                    decos += 1;
                }
                Prize::Items(rarity, items) => {
                    assert!(BUNDLES[rarity].contains(&items));
                    bundles += 1;
                }
            }
        }
        // About a quarter are items (expected 500 of 2000).
        assert!((300..700).contains(&bundles), "{bundles} bundles, {decos} cosmetics");
    }

    #[test]
    fn every_boss_drops_its_own_cosmetics() {
        assert_eq!(BOSS_DROP_WEIGHTS.iter().sum::<u32>(), 1000);
        assert!(all().iter().all(|d| d.boss.is_empty() || BOSSES.iter().any(|b| b.id == d.boss)), "unknown boss");
        for b in &BOSSES {
            let own: Vec<&Deco> = all().iter().filter(|d| d.boss == b.id).collect();
            let rarities: std::collections::BTreeSet<usize> = own.iter().map(|d| d.rarity).collect();
            assert!(rarities.len() >= 3, "{} has cosmetics of several rarities", b.id);
            let total: f64 = own.iter().map(|d| drop_pct(d)).sum();
            assert!((total - 100.0).abs() < 1e-9, "{}: {total}%", b.id);
            for _ in 0..50 {
                assert_eq!(roll_boss_drop(b.id).unwrap().boss, b.id);
            }
        }
        assert!(roll_boss_drop("nobody").is_none() && roll_boss_drop("").is_none());
    }

    #[test]
    fn bosses_own_can_go_into_a_merge_but_never_come_out() {
        for i in 0..2000 {
            if let Prize::Deco(d) = roll_chest(i % 2 == 0) {
                assert!(d.boss.is_empty(), "{}", d.id);
            }
        }
        let own = all().iter().find(|d| d.boss == BOSSES[0].id && d.rarity == 0).expect("a 普通 boss cosmetic");
        let owned = Owned::from([(own.id.clone(), 10)]);
        let p = picks(&[(&own.id, 10)]);
        assert_eq!(check_picks(&owned, &p, &[]), Ok((0, 1)));
        for _ in 0..200 {
            let got = merge(&mut owned.clone(), &p, &[]).unwrap();
            assert!(got.rarity == 1 && got.boss.is_empty(), "{}", got.id);
        }
    }

    #[test]
    fn bundles_and_lucky_odds_make_sense() {
        for bundle in BUNDLES.iter().flat_map(|b| b.iter()) {
            assert!(bundle.iter().all(|(id, n)| cofisher_server::ITEM_IDS.contains(id) && *n > 0), "{bundle:?}");
        }
        assert_eq!(LUCKY_WEIGHTS.iter().sum::<u32>(), 1000);
        // Lucky: less 普通, more of everything rarer.
        assert!(LUCKY_WEIGHTS[0] < RARITIES[0].weight);
        assert!(LUCKY_WEIGHTS.iter().zip(&RARITIES).skip(1).all(|(l, r)| *l > r.weight));
    }
}
