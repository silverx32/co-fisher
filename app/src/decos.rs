//! Cosmetics ("装扮"): a PNG worn on top of (or behind) any character, one per slot (头饰 /
//! 宠物 / 特效). Obtained from a chest
//! (costs points, once per cooldown) and by merging 10 of one rarity into one of the next.
//! The catalogue is generated together with the art by tools/gen-decos.js.

use std::collections::BTreeMap;
use std::sync::OnceLock;

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
    json!({
        "items": all().iter().map(|d| json!({ "id": d.id, "name": d.name, "rarity": d.rarity, "slot": d.slot, "layer": d.layer, "box": d.icon_box })).collect::<Vec<_>>(),
        "slots": SLOTS.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "rarities": RARITIES.iter().map(|r| json!({ "name": r.name, "color": r.color, "odds": r.weight as f64 / 10.0 })).collect::<Vec<_>>(),
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

fn pick_in(rarity: usize) -> &'static Deco {
    let pool: Vec<&Deco> = all().iter().filter(|d| d.rarity == rarity).collect();
    pool[rand_below(pool.len() as u32) as usize]
}

pub fn roll_chest() -> &'static Deco {
    let total: u32 = RARITIES.iter().map(|r| r.weight).sum();
    let mut x = rand_below(total);
    for (i, r) in RARITIES.iter().enumerate() {
        if x < r.weight {
            return pick_in(i);
        }
        x -= r.weight;
    }
    pick_in(0)
}

pub type Owned = BTreeMap<String, u64>;

/// Which copies a merge of `rarity` would use: spare duplicates first (most-owned first), then
/// single copies; the last copy of anything being worn is never used. `None` if there aren't
/// enough. The second value is how many distinct items would disappear from the collection.
pub fn merge_plan(owned: &Owned, rarity: usize, worn: &[String]) -> Option<(Vec<(String, u64)>, u64)> {
    let mut items: Vec<(&String, u64)> = owned
        .iter()
        .filter(|(id, n)| **n > 0 && get(id).is_some_and(|d| d.rarity == rarity))
        .map(|(id, n)| (id, *n))
        .collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let mut take: BTreeMap<String, u64> = BTreeMap::new();
    let mut need = MERGE_COUNT;
    for (id, n) in &items {
        let spare = (n - 1).min(need);
        if spare > 0 {
            take.insert((*id).clone(), spare);
            need -= spare;
        }
    }
    let mut lost = 0;
    for (id, _) in items.iter().rev() {
        if need == 0 {
            break;
        }
        if worn.contains(id) {
            continue;
        }
        *take.entry((*id).clone()).or_default() += 1;
        need -= 1;
        lost += 1;
    }
    (need == 0).then(|| (take.into_iter().collect(), lost))
}

/// Per rarity: { owned (copies), kinds (distinct), total (in catalogue), canMerge, lose }.
pub fn stats(owned: &Owned, worn: &[String]) -> Value {
    (0..RARITIES.len())
        .map(|r| {
            let mine = owned.iter().filter(|(id, n)| **n > 0 && get(id).is_some_and(|d| d.rarity == r));
            let (copies, kinds) = mine.fold((0, 0), |(c, k), (_, n)| (c + n, k + 1));
            let plan = (r + 1 < RARITIES.len()).then(|| merge_plan(owned, r, worn)).flatten();
            json!({
                "owned": copies,
                "kinds": kinds,
                "total": all().iter().filter(|d| d.rarity == r).count(),
                "canMerge": plan.is_some(),
                "lose": plan.map_or(0, |p| p.1),
            })
        })
        .collect()
}

/// Uses up the copies from `merge_plan` and returns the new item.
pub fn merge(owned: &mut Owned, rarity: usize, worn: &[String]) -> Option<&'static Deco> {
    let (take, _) = merge_plan(owned, rarity, worn)?;
    for (id, n) in take {
        if let Some(c) = owned.get_mut(&id) {
            *c -= n;
            if *c == 0 {
                owned.remove(&id);
            }
        }
    }
    let got = pick_in(rarity + 1);
    *owned.entry(got.id.clone()).or_default() += 1;
    Some(got)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(r: usize) -> Vec<String> {
        all().iter().filter(|d| d.rarity == r).map(|d| d.id.clone()).collect()
    }

    #[test]
    fn catalogue_is_complete() {
        assert_eq!(all().len(), 140);
        for (slot, _) in SLOTS {
            assert!(all().iter().any(|d| d.slot == slot), "slot {slot} has items");
        }
        for r in 0..RARITIES.len() {
            assert!(!ids(r).is_empty(), "rarity {r} has items");
        }
        assert!(all().iter().all(|d| cofisher_server::clean_deco(&json!(d.id)) == d.id && (d.layer == "front" || d.layer == "back")));
        assert_eq!(RARITIES.iter().map(|r| r.weight).sum::<u32>(), 1000);
    }

    #[test]
    fn merge_uses_duplicates_first_and_keeps_equipped() {
        let c = ids(0);
        let mut owned = Owned::new();
        owned.insert(c[0].clone(), 6);
        owned.insert(c[1].clone(), 3);
        owned.insert(c[2].clone(), 1);
        let worn = vec![c[2].clone(), "some-pet".to_string()];
        // 10 copies, but the worn c[2] is off limits.
        assert!(merge_plan(&owned, 0, &worn).is_none());
        owned.insert(c[4].clone(), 2);
        // 8 spare duplicates, then the last copies of the least-owned items (c[4], c[1]).
        let (plan, lost) = merge_plan(&owned, 0, &worn).unwrap();
        assert_eq!(plan.iter().map(|p| p.1).sum::<u64>(), MERGE_COUNT);
        assert_eq!(lost, 2);
        assert!(!plan.iter().any(|p| p.0 == c[2]));

        let got = merge(&mut owned, 0, &worn).unwrap();
        assert_eq!(got.rarity, 1);
        assert_eq!(owned.get(&c[0]), Some(&1));
        assert_eq!(owned.get(&c[2]), Some(&1));
        assert_eq!(owned.values().sum::<u64>(), 3);
    }

    #[test]
    fn duplicates_only_merge_loses_nothing() {
        let c = ids(1);
        let mut owned = Owned::new();
        owned.insert(c[0].clone(), 11);
        assert_eq!(merge_plan(&owned, 1, &[]).unwrap().1, 0);
        let top = ids(RARITIES.len() - 1);
        owned.insert(top[0].clone(), 20);
        assert_eq!(stats(&owned, &[])[RARITIES.len() - 1]["canMerge"], false);
    }

    #[test]
    fn chest_rolls_valid_items() {
        for _ in 0..200 {
            assert!(get(&roll_chest().id).is_some());
        }
    }
}
