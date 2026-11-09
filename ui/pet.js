'use strict';
/* global api */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const S = {
  me: null,
  wallet: { count: 0, total: 0, inv: {} },
  typing: false,
  items: {},
  serverItems: [], // items the room's server supports (older ones know fewer)
  dnd: false,
  boss: null, // the room's boss: { emoji, name, level, hp, max, in }; hp 0 = waiting for the next
  bossAt: 0, // local time the next boss appears
  characters: [],
  players: [],
  skins: {}, // playerId -> { rev, skin }
  net: 'offline',
  server: { running: false, ips: [] },
  steam: { available: false, appId: 480 },
  steamRooms: [],
  steamLoading: false,
  decos: { items: [], rarities: [] }, // catalogue
  decoState: { owned: {}, worn: {}, nextChestAt: 0, stats: [] },
  daily: {}, // key presses + clicks per day: "2026-11-04" -> count
  dailyLastHits: {}, // bosses I landed the last hit on, per day
  version: '',
  update: { state: 'idle' },
};

// Each built-in character has one idle frame and three typing frames. Every key press or click
// flashes one random typing frame (never the same one twice in a row), then it's straight back to idle.
const TYPING_FRAMES = 3;
const TAP_MS = 110;
const frameSrc = (char, frame) => `assets/characters/${char}/${frame ? `typing${frame}` : 'idle'}.png`;
const nextTypingFrame = (cur) => {
  const f = 1 + Math.floor(Math.random() * (TYPING_FRAMES - 1));
  return f >= cur ? f + 1 : f; // 1..3, never the same frame twice in a row
};

// frame: 0 = idle, 1..3 = typing. Custom skins only have one typing image.
function srcFor(char, skin, frame) {
  if (skin) return frame ? skin.typing : skin.idle;
  return frameSrc(char, frame);
}

function skinOf(player) {
  const s = S.skins[player.id];
  return player.skinRev && s?.skin ? s.skin : null;
}

function setSrc(img, src) {
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.src = src;
  }
}

// Decoded once up front so switching frames never flickers.
const preloaded = [];
function preloadFrames() {
  for (const c of S.characters) {
    for (let f = 0; f <= TYPING_FRAMES; f++) {
      const img = new Image();
      img.src = frameSrc(c.id, f);
      preloaded.push(img);
    }
  }
}

// A "tapper" shows a typing frame on tap() and returns to idle TAP_MS after the last tap.
function makeTapper(render) {
  const t = { frame: 0, timer: null };
  t.tap = () => {
    t.frame = nextTypingFrame(t.frame);
    render();
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { t.frame = 0; render(); }, TAP_MS);
  };
  return t;
}

const myTap = makeTapper(() => renderMe());
const friendTaps = new Map(); // player id -> { tapper, lastCount }

// Cosmetics: one picture on top of (layer "front") or behind ("back") the character.
const decoById = new Map();
const DECO_W = 336; const DECO_H = 330; // size of every cosmetic picture (tools/gen-decos.js)
// An <img> showing just the item (cropped to its box), for the collection and reveal.
function decoIcon(d) {
  const img = el('img');
  img.src = `assets/decos/${d.id}.png`;
  img.draggable = false;
  const [x0, y0, x1, y1] = d.box?.length === 4 ? d.box : [0, 0, DECO_W, DECO_H];
  img.style.objectViewBox = `inset(${y0}px ${DECO_W - x1}px ${DECO_H - y1}px ${x0}px)`;
  return img;
}
function setDeco(img, id) {
  const d = decoById.get(id);
  img.classList.toggle('hidden', !d);
  if (!d) return;
  setSrc(img, `assets/decos/${d.id}.png`);
  img.className = `deco ${d.layer} r${d.rarity}`;
}

// An avatar has one <img class="deco"> per slot; effects go first, headwear last (on top).
const SLOT_ORDER = ['fx', 'body', 'pet', 'head'];
function setWorn(avatar, ids) {
  while (avatar.querySelectorAll('img.deco').length < SLOT_ORDER.length) avatar.prepend(el('img', 'deco hidden'));
  const bySlot = SLOT_ORDER.map((s) => ids.find((id) => decoById.get(id)?.slot === s));
  avatar.querySelectorAll('img.deco').forEach((img, k) => setDeco(img, bySlot[k]));
}

// ---------------------------------------------------------------- me
function renderMe() {
  setSrc($('#myImg'), srcFor(S.me.char, S.me.skin, myTap.frame));
  setWorn($('#myAvatar'), Object.values(S.decoState.worn || {}));
  $('#myName').textContent = S.me.name;
}

let lastCount = null;
function renderWallet() {
  const c = S.wallet.count;
  $('#myCount').textContent = c;
  if (lastCount !== null && c > lastCount) {
    const b = $('#bubble');
    b.classList.remove('bump');
    void b.offsetWidth;
    b.classList.add('bump');
  }
  lastCount = c;
  $('#shopCount').textContent = c;
  $('#shopTotal').textContent = `累计敲击 ${S.wallet.total}`;
  renderShop();
  renderChest();
  renderFriendButtons();
  renderMyItems();
}

// ---------------------------------------------------------------- friends
const friendEls = new Map(); // id -> element

function renderFriends() {
  const box = $('#friends');
  const others = S.players.filter((p) => p.id !== S.me.id);
  const alive = new Set(others.map((p) => p.id));
  for (const [id, node] of friendEls) {
    if (!alive.has(id)) { node.remove(); friendEls.delete(id); friendTaps.delete(id); }
  }
  for (const p of others) {
    let node = friendEls.get(p.id);
    if (!node) {
      node = el('div', 'friend hit');
      node.dataset.playerId = p.id;
      const actions = el('div', 'factions');
      for (const item of Object.values(S.items).filter((x) => x.kind === 'throw')) {
        const b = el('button', 'fbtn');
        b.dataset.item = item.id;
        b.title = `扔${item.name}`;
        b.append(el('span', null, item.emoji), el('small'));
        b.addEventListener('click', () => throwAt(p.id, item, node));
        actions.append(b);
      }
      const avatar = el('div', 'avatar');
      const img = el('img', 'fimg');
      img.draggable = false;
      avatar.append(el('img', 'deco hidden'), el('img', 'deco hidden'), el('img', 'deco hidden'), img);
      const chest = el('span', 'fchest hidden', '🎁');
      chest.title = 'TA 的宝箱可以开了';
      node.append(el('span', 'ftyping', '⌨'), el('span', 'fbadges'), chest, avatar, el('div', 'fcount'), el('div', 'fname'), el('button', 'player-game-status fgame hidden'), actions);
      box.append(node);
      friendEls.set(p.id, node);
    }
    node.classList.toggle('typing', !!p.typing);
    node.querySelector('.fcount').textContent = `⌨ ${p.count}`;
    node.querySelector('.fchest').classList.toggle('hidden', !p.chest);
    node.querySelector('.fname').textContent = p.name;
    // An umbrella blocks the next throw at them; 免打扰 means it won't cover their screen.
    node.querySelector('.fbadges').textContent = `${p.inv?.umbrella ? '☂️' : ''}${p.dnd ? '🔕' : ''}`;
    const worn = (p.decos || []).map((id) => decoById.get(id)?.name).filter(Boolean).join('、');
    const inv = Object.values(S.items).map((it) => `${it.emoji}${p.inv?.[it.id] ?? 0}`).join(' ');
    node.title = `${p.name}\n点数 ${p.count}\n${inv}${p.dnd ? '\n🔕 免打扰中：被糊只显示在小人身上' : ''}${worn ? `\n装扮：${worn}` : ''}`;
    setWorn(node.querySelector('.avatar'), p.decos || []);
    let ft = friendTaps.get(p.id);
    if (!ft) {
      const img = node.querySelector('.fimg');
      const id = p.id;
      const tapper = makeTapper(() => {
        const cur = S.players.find((x) => x.id === id);
        if (cur) setSrc(img, srcFor(cur.char, skinOf(cur), tapper.frame));
      });
      ft = { tapper, lastCount: p.count };
      friendTaps.set(p.id, ft);
    }
    // Friends report their count in batches (~every 150ms); each increase shows as one tap.
    if (p.count > ft.lastCount) ft.tapper.tap();
    ft.lastCount = p.count;
    setSrc(node.querySelector('.fimg'), srcFor(p.char, skinOf(p), ft.tapper.frame));
  }
  renderFriendButtons();
  renderFriendsToggle();
  window.dispatchEvent(new Event('friend-cards-rendered'));
}

// Collapsing the friends bar leaves only me (Boss and the table entry stay); remembered across restarts.
let friendsCollapsed = localStorage.getItem('friendsCollapsed') === '1';
function renderFriendsToggle() {
  const n = friendEls.size;
  const b = $('#friendsToggle');
  b.classList.toggle('hidden', n === 0);
  b.textContent = friendsCollapsed ? `👥 ${n}` : '收起好友';
  b.title = friendsCollapsed ? `展开 ${n} 位好友` : '收起好友，只显示自己';
  $('#friends').classList.toggle('hidden', friendsCollapsed);
}
$('#friendsToggle').addEventListener('click', () => {
  friendsCollapsed = !friendsCollapsed;
  localStorage.setItem('friendsCollapsed', friendsCollapsed ? '1' : '0');
  renderFriendsToggle();
  window.dispatchEvent(new Event('friend-cards-rendered'));
});

// Each friend card has one button per item, showing how many we own; 0 = disabled.
function renderFriendButtons() {
  const online = S.net === 'online';
  for (const node of friendEls.values()) {
    for (const b of node.querySelectorAll('.fbtn')) {
      const n = S.wallet.inv[b.dataset.item] || 0;
      b.querySelector('small').textContent = n;
      b.disabled = n < 1 || !online || !S.serverItems.includes(b.dataset.item);
    }
  }
}

// ---------------------------------------------------------------- throwing
async function throwAt(targetId, item, node) {
  const r = await api.throwItem(item.id, targetId);
  if (!r.ok) return toast(r.error);
  S.wallet = r.wallet;
  renderWallet();
  flyItem(item.emoji, node);
}

function flyItem(emoji, toNode) {
  if (!toNode) return;
  const from = $('#myImg').getBoundingClientRect();
  const to = toNode.getBoundingClientRect();
  const f = el('div', 'flying', emoji);
  document.body.append(f);
  const x0 = from.left + from.width / 2 - 15;
  const y0 = from.top + 40;
  const x1 = to.left + to.width / 2 - 15;
  const y1 = to.top + 20;
  f.animate([
    { transform: `translate(${x0}px, ${y0}px) rotate(0)` },
    { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - 60}px) rotate(360deg)`, offset: 0.5 },
    { transform: `translate(${x1}px, ${y1}px) rotate(720deg)` },
  ], { duration: 550, easing: 'ease-in' }).onfinish = () => f.remove();
}

// What a room-wide item throws at each card, when that's not its own emoji.
const MISSILE = { rain: '🍅' };

// Pops the item over everyone it reached (friends' cards and my own character).
function showHit(hit) {
  const item = S.items[hit.item];
  if (!item) return;
  const nodeOf = (id) => (id === S.me.id ? $('#me') : friendEls.get(id));
  if (hit.kind === 'party') {
    for (const node of [$('#me'), ...friendEls.values()]) pop(node, item.emoji, false);
    return;
  }
  for (const id of hit.targets) pop(nodeOf(id), MISSILE[item.id] || item.emoji, true);
  for (const id of hit.blocked) pop(nodeOf(id), '☂️', false);
}

function pop(node, emoji, shake) {
  if (!node) return;
  if (shake) {
    node.classList.remove('shake');
    void node.offsetWidth;
    node.classList.add('shake');
  }
  const sp = el('div', 'fsplat', emoji);
  node.append(sp);
  setTimeout(() => sp.remove(), 2000);
}

// ---------------------------------------------------------------- my items
// Room-wide items are used from under my character, with a second click to confirm.
// Umbrellas only show how many I have; the 🔕 button switches 免打扰 off.
const myItemEls = new Map(); // item id -> { b, small, item }
let armed = null; // { id, timer }: the room-wide item waiting for its confirming click

function buildMyItems() {
  const box = $('#myItems');
  for (const item of Object.values(S.items)) {
    if (item.kind === 'throw') continue;
    const shield = item.kind === 'shield';
    const b = el(shield ? 'span' : 'button', `mitem hit${shield ? ' shield' : ''}`);
    const small = el('small');
    b.append(el('span', null, item.emoji), small);
    if (!shield) b.addEventListener('click', () => useRoomItem(item));
    box.append(b);
    myItemEls.set(item.id, { b, small, item });
  }
  const dnd = el('button', 'mitem hit', '🔕');
  dnd.id = 'myDnd';
  dnd.title = '免打扰中：被糊只显示在小人身上，不弹全屏\n点一下关闭（托盘菜单里也能开关）';
  dnd.addEventListener('click', () => api.setDnd(false));
  box.append(dnd);
}

function renderMyItems() {
  const online = S.net === 'online';
  let any = S.dnd;
  for (const { b, small, item } of myItemEls.values()) {
    const n = S.wallet.inv[item.id] || 0;
    const old = online && !S.serverItems.includes(item.id);
    any ||= n > 0;
    b.classList.toggle('hidden', n < 1);
    b.classList.toggle('off', old);
    b.classList.toggle('armed', armed?.id === item.id);
    small.textContent = n;
    if (item.kind === 'shield') {
      b.title = old ? '房主或中转服务器版本较旧，雨伞暂时不生效' : `雨伞 ×${n}：自动挡下下一次攻击，每挡一次用掉一把`;
    } else {
      b.disabled = !online || old;
      b.title = !online ? `${item.name}：联机后才能用` : old ? `房主或中转服务器版本较旧，用不了${item.name}` : `${item.name}：${item.desc}（点两下）`;
    }
  }
  $('#myDnd').classList.toggle('hidden', !S.dnd);
  $('#myItems').classList.toggle('hidden', !any);
}

async function useRoomItem(item) {
  clearTimeout(armed?.timer);
  if (armed?.id !== item.id) {
    armed = { id: item.id, timer: setTimeout(() => { armed = null; renderMyItems(); }, 3000) };
    renderMyItems();
    return toast(`再点一下：${item.name}（${item.desc}）`);
  }
  armed = null;
  renderMyItems();
  const r = await api.throwItem(item.id, '');
  if (!r.ok) return toast(r.error);
  S.wallet = r.wallet;
  renderWallet();
  if (item.kind === 'group') for (const node of friendEls.values()) flyItem(MISSILE[item.id] || item.emoji, node);
}

// ---------------------------------------------------------------- boss
// The room's boss over the friends: everyone's typing takes its HP down. Beaten, it shows a
// countdown to the next one.
let bossHp = null; // HP last shown, to pop damage numbers when it drops
let bossDown = null; // { until, killerName }: show the win for a moment

function renderBoss() {
  const b = S.boss;
  const box = $('#boss');
  box.classList.toggle('hidden', !b || S.net !== 'online');
  if (!b) {
    bossHp = null;
    return;
  }
  const up = b.hp > 0;
  const won = bossDown && Date.now() < bossDown.until;
  box.classList.toggle('waiting', !up && !won);
  box.classList.toggle('down', !!won);
  $('#bossEmoji').textContent = won ? '💥' : b.emoji;
  $('#bossName').textContent = won ? '打败了！' : up ? b.name : `下一只：${b.name}`;
  $('#bossLevel').textContent = won ? '' : `Lv.${b.level}`;
  $('#bossFill').style.width = up ? `${(100 * b.hp) / Math.max(1, b.max)}%` : '0%';
  $('#bossHp').textContent = won ? `最后一击：${bossDown.killerName}`
    : up ? `${b.hp.toLocaleString()} / ${b.max.toLocaleString()}` : `${mmss(Math.max(0, S.bossAt - Date.now()))} 后出现`;
  if (up && bossHp !== null && b.hp < bossHp) hurtBoss(bossHp - b.hp);
  bossHp = up ? b.hp : null;
  // Damage as a share of its HP: a chest needs at least minPct.
  const pct = (d) => {
    const p = (100 * d) / Math.max(1, b.max);
    return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
  };
  const mine = S.players.find((p) => p.id === S.me.id)?.dmg || 0;
  const tag = $('#bossMine');
  tag.classList.toggle('hidden', !up || !!won);
  tag.classList.toggle('low', mine * 100 < b.max * b.minPct);
  tag.textContent = `我 ${pct(mine)}`;
  const drops = S.decos.items.filter((x) => x.boss && x.boss === b.id).map((x) => `${x.name} ${pctText(x.drop)}`).join(' · ');
  const ranking = S.players.filter((p) => p.dmg > 0).sort((x, y) => y.dmg - x.dmg).slice(0, 5)
    .map((p, k) => `${k + 1}. ${p.name}  ${p.dmg}（${pct(p.dmg)}）`).join('\n');
  box.title = `${up ? `${b.emoji} ${b.name} Lv.${b.level}\n血量 ${b.hp} / ${b.max}\n我的伤害 ${mine}（${pct(mine)}）` : `下一只：${b.emoji} ${b.name} Lv.${b.level}`}` +
    `${ranking ? `\n${up ? '伤害' : '上一只的伤害'}：\n${ranking}` : ''}` +
    `\n大家敲键盘、点鼠标就是在打它。打败时伤害占 ${b.minPct}% 以上的人每人得一个 Boss 宝箱，补最后一刀的人宝箱稀有度更高` +
    `${drops ? `，还会掉一件它的专属装扮：\n${drops}` : ''}`;
}

function hurtBoss(damage) {
  const e = $('#bossEmoji');
  e.classList.remove('hurt');
  void e.offsetWidth;
  e.classList.add('hurt');
  const n = el('span', 'boss-dmg', `-${damage}`);
  $('#boss').append(n);
  setTimeout(() => n.remove(), 900);
}

// ---------------------------------------------------------------- panel
function openPanel(tab) {
  $('#panel').classList.remove('hidden');
  if (tab) switchTab(tab);
  if (S.net === 'offline' && S.steam?.available) refreshSteamRooms();
}

function switchTab(tab) {
  $('#panel').classList.toggle('games-panel', tab === 'games');
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('section[data-pane]').forEach((s) => s.classList.toggle('hidden', s.dataset.pane !== tab));
  if (tab === 'room' && S.net === 'offline' && S.steam?.available) refreshSteamRooms();
  if (tab === 'cal') showMonth(null);
}

document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#closePanel').addEventListener('click', () => $('#panel').classList.add('hidden'));

function renderSteam() {
  const st = S.server?.steam || S.steam || {};
  S.steam = st;
  const bar = $('#steamBar');
  const text = $('#steamText');
  const retry = $('#steamRetryBtn');
  if (st.available) {
    bar.classList.add('ok');
    text.textContent = `🎮 Steam 已就绪：${st.name} (AppID ${st.appId})`;
    retry.classList.add('hidden');
  } else {
    bar.classList.remove('ok');
    text.textContent = `🎮 ${st.error || '未检测到 Steam'}`;
    retry.classList.remove('hidden');
  }
}

function renderSteamRooms() {
  const online = S.net !== 'offline';
  const avail = !!S.steam?.available;
  const btn = $('#steamRefreshBtn');
  const list = $('#steamRoomList');
  btn.classList.toggle('hidden', online || !avail);
  btn.disabled = S.steamLoading;
  btn.textContent = S.steamLoading ? '搜索中…' : '刷新 Steam 房间';
  list.classList.toggle('hidden', online || !avail);
  if (online || !avail) return;
  list.replaceChildren();
  if (!S.steamRooms.length) {
    list.append(el('p', 'tip', S.steamLoading ? '正在搜索 Steam 房间…' : '暂无可见的 Steam 房间（也可让房主复制 steam:ID 发你）'));
    return;
  }
  for (const r of S.steamRooms) {
    const row = el('div', 'addr');
    const tag = el('small', 'steam-tag', r.isFriend ? '好友' : 'Steam');
    const desc = `${r.name} (${r.players}/${S.maxPlayers})${r.hasPwd ? ' 🔒' : ''}`;
    const join = el('button', 'primary', '加入');
    join.addEventListener('click', async () => {
      $('#joinAddr').value = r.address;
      join.disabled = true;
      const res = await api.join({ address: r.address, room: '', password: $('#joinPwd').value });
      join.disabled = false;
      if (!res.ok) return toast(res.error);
      if (res.joinAddress) $('#joinAddr').value = res.joinAddress;
      S.server = res.server;
      renderRoom();
    });
    row.append(tag, el('span', null, desc), join);
    list.append(row);
  }
}

async function refreshSteamRooms() {
  if (S.steamLoading) return;
  S.steamLoading = true;
  renderSteamRooms();
  try {
    const d = await api.steamRooms();
    S.steam = d.steam;
    S.steamRooms = d.rooms || [];
  } finally {
    S.steamLoading = false;
    renderSteam();
    renderSteamRooms();
    renderRoom();
  }
}

function renderRoom() {
  renderSteam();
  const online = S.net !== 'offline';
  $('#netDot').className = `dot ${S.net}`;
  const n = S.players.length;
  if (S.net === 'online') $('#netText').textContent = `${S.server.running ? '房主 · ' : ''}已连接，房间 ${n}/${S.maxPlayers} 人`;
  $('#hostBox').classList.toggle('hidden', online && !S.server.running);
  $('#joinBox').classList.toggle('hidden', online);
  $('#hostBtn').classList.toggle('hidden', S.server.running);
  $('#hostPort').disabled = S.server.running;
  $('#hostPwd').disabled = S.server.running;
  $('#leaveBtn').classList.toggle('hidden', !online && !S.server.running);
  renderSteamRooms();
  const info = $('#hostInfo');
  info.classList.toggle('hidden', !S.server.running);
  if (S.server.running) {
    const box = $('#hostAddrs');
    box.replaceChildren();
    const addRow = (label, addr, extraBtn) => {
      const row = el('div', 'addr');
      const tag = el('small', label === 'Steam' ? 'steam-tag' : null, label);
      const copy = el('button', null, '复制');
      copy.addEventListener('click', () => copyText(addr));
      row.append(tag, el('span', null, addr));
      if (extraBtn) row.append(extraBtn);
      row.append(copy);
      box.append(row);
    };
    const st = S.server.steam || S.steam;
    if (st?.available && st.address) {
      const invite = el('button', null, '邀请');
      invite.title = '打开 Steam 好友邀请窗口';
      invite.addEventListener('click', async () => {
        await api.steamInvite();
        copyText(st.address);
      });
      addRow('Steam', st.address, invite);
    }
    for (const ip of S.server.ips) addRow('局域网', `${ip}:${S.server.port}`);
    for (const ip of S.server.ipv6 || []) addRow('IPv6', `[${ip}]:${S.server.port}`);
    if (!st?.available && !S.server.ips.length && !(S.server.ipv6 || []).length) box.append(el('p', 'tip', '没检测到可用的网络地址'));
    if (!st?.available && !(S.server.ipv6 || []).length) box.append(el('p', 'tip', '未开 Steam 且无公网 IPv6，跨网请打开 Steam 或改用中转服务器'));
  }
}

function copyText(text) {
  const fallback = () => {
    const t = el('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  };
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).catch(fallback).finally(() => toast('已复制'));
}

$('#nameInput').addEventListener('change', async (e) => {
  const r = await api.setProfile({ name: e.target.value });
  S.me.name = r.name;
  e.target.value = r.name;
  renderMe();
});

$('#hostBtn').addEventListener('click', async () => {
  $('#hostBtn').disabled = true;
  const r = await api.host({ port: $('#hostPort').value, password: $('#hostPwd').value });
  $('#hostBtn').disabled = false;
  if (!r.ok) return toast(r.error);
  S.server = r.server;
  renderRoom();
});

$('#joinBtn').addEventListener('click', async () => {
  if ($('#joinBtn').disabled) return;
  $('#joinBtn').disabled = true;
  const r = await api.join({ address: $('#joinAddr').value, room: $('#joinRoom').value, password: $('#joinPwd').value });
  $('#joinBtn').disabled = false;
  if (!r.ok) return toast(r.error);
  if (r.joinAddress) $('#joinAddr').value = r.joinAddress;
  S.server = r.server;
  renderRoom();
});

$('#steamRetryBtn').addEventListener('click', () => refreshSteamRooms());
$('#steamRefreshBtn').addEventListener('click', () => refreshSteamRooms());

$('#leaveBtn').addEventListener('click', async () => {
  const r = await api.leave();
  if (!r.ok) { toast(r.error); return; }
  S.server = r.server;
  S.players = [];
  renderFriends();
  renderRoom();
});

$('#quitBtn').addEventListener('click', () => api.quit());

function renderChars() {
  const grid = $('#charGrid');
  grid.replaceChildren();
  for (const c of S.characters) {
    const card = el('div', `char${!S.me.skin && S.me.char === c.id ? ' selected' : ''}`);
    const img = el('img');
    img.src = frameSrc(c.id, 0);
    img.draggable = false;
    card.title = c.desc;
    card.append(img, el('span', null, c.name));
    card.addEventListener('mouseenter', () => { img.src = frameSrc(c.id, 1); });
    card.addEventListener('mouseleave', () => { img.src = frameSrc(c.id, 0); });
    card.addEventListener('click', async () => {
      if (S.me.skin) {
        await api.clearSkin();
        S.me.skin = null;
      }
      const r = await api.setProfile({ char: c.id });
      S.me.char = r.char;
      renderMe();
      renderChars();
    });
    grid.append(card);
  }
}

const SKIN_IMAGE_MAX = 400 * 1024; // data URL length, matches the server limit
const skinPick = { idle: null, typing: null };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

for (const kind of ['idle', 'typing']) {
  const input = $(kind === 'idle' ? '#skinIdle' : '#skinTyping');
  const btn = $(kind === 'idle' ? '#skinIdleBtn' : '#skinTypingBtn');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const url = await readAsDataUrl(file);
    if (url.length > SKIN_IMAGE_MAX) return toast('图片太大了，单张请小于 300KB');
    skinPick[kind] = url;
    btn.textContent = kind === 'idle' ? '待机图 ✓' : '敲键盘图 ✓';
    if (!skinPick.idle || !skinPick.typing) return toast(kind === 'idle' ? '再选一张敲键盘图' : '再选一张待机图');
    const r = await api.setSkin(skinPick.idle, skinPick.typing);
    skinPick.idle = skinPick.typing = null;
    $('#skinIdleBtn').textContent = '待机图…';
    $('#skinTypingBtn').textContent = '敲键盘图…';
    if (!r.ok) return toast(r.error);
    S.me.skin = r.skin;
    renderMe();
    renderChars();
    toast('皮肤已更换');
  });
}

$('#skinClear').addEventListener('click', async () => {
  await api.clearSkin();
  S.me.skin = null;
  renderMe();
  renderChars();
});

const shopRows = []; // built once; only text/disabled state is updated per keypress

function buildShop() {
  const list = $('#shopList');
  for (const item of Object.values(S.items)) {
    const row = el('div', 'shop-item');
    const info = el('div', 'info');
    const owned = el('small');
    const name = el('b', null, item.name);
    if (item.desc) name.append(el('span', 'desc', item.desc));
    info.append(name, owned);
    row.append(el('div', 'emoji', item.emoji), info);
    const buttons = [1, 5].map((qty) => {
      const b = el('button', null, `换${qty}`);
      b.addEventListener('click', async () => {
        const r = await api.buy(item.id, qty);
        if (!r.ok) return toast(r.error);
        S.wallet = r.wallet;
        renderWallet();
        toast(`获得 ${item.emoji}×${qty}`);
      });
      row.append(b);
      return { b, qty };
    });
    list.append(row);
    shopRows.push({ item, owned, buttons });
  }
}

function renderShop() {
  for (const { item, owned, buttons } of shopRows) {
    const old = S.net === 'online' && !S.serverItems.includes(item.id);
    owned.textContent = `${item.cost} 点 · 已有 ${S.wallet.inv[item.id] || 0} 个${old ? ' · 这个房间的服务器版本旧，暂时用不了' : ''}`;
    for (const { b, qty } of buttons) b.disabled = S.wallet.count < item.cost * qty;
  }
}

// ---------------------------------------------------------------- cosmetics
const decoTiles = new Map(); // id -> { tile, count, tag, d }
const mergeRows = []; // per rarity that can be merged: its "共 N 件" label
const mergeUi = {}; // the merge box's controls (buildMerge)
// Merging by hand: while picking, clicking an owned tile adds one copy of it instead of wearing
// it. The first copy picked sets the rarity, the rest must match.
let picking = null; // { rarity, picks: { id: copies }, confirm, lose, timer }
const wornRows = new Map(); // slot -> { name, off }
const slotViews = new Map(); // slot -> { tab, pane, groups: [{ items, info }] }
let decoSlot = 'head'; // which slot's collection is shown

// A titled grid of tiles (one rarity of a slot, or one boss's own) in `pane`.
function decoGroup(pane, title, color, items) {
  const head = el('div', 'deco-head');
  const name = el('b', null, title);
  if (color) name.style.color = color;
  const info = el('small');
  head.append(name, info);
  const grid = el('div', 'deco-grid');
  for (const d of items) {
    const tile = el('div', 'tile');
    const img = decoIcon(d);
    img.loading = 'lazy';
    const count = el('small');
    const tag = el('b', 'pick'); // copies picked for a merge
    tile.append(img, count, tag);
    // A boss's own come in every rarity: a strip in the rarity's colour tells them apart.
    if (d.boss) tile.style.boxShadow = `inset 0 -3px 0 ${S.decos.rarities[d.rarity].color}`;
    tile.addEventListener('click', () => (picking ? pickDeco(d) : toggleWear(d.id)));
    grid.append(tile);
    decoTiles.set(d.id, { tile, count, tag, d });
  }
  pane.append(head, grid);
  return { items, info };
}

const bossOf = (id) => (S.decos.bosses || []).find((b) => b.id === id);
const pctText = (p) => `${+p.toFixed(1)}%`;

function buildDecos() {
  for (const s of S.decos.slots) {
    const row = el('div', 'worn-row');
    const name = el('b');
    const off = el('button', 'mini', '卸下');
    off.addEventListener('click', () => wear(s.id, ''));
    row.append(el('span', 'worn-label', s.name), name, off);
    $('#decoWorn').append(row);
    wornRows.set(s.id, { name, off });
  }
  buildMerge();
  // One tab + pane per slot, then one for the bosses' own.
  const addView = (id, label) => {
    const tab = el('button', null, label);
    tab.addEventListener('click', () => { decoSlot = id; renderDecos(); });
    $('#decoSlotTabs').append(tab);
    const view = { tab, pane: el('div'), groups: [] };
    $('#decoList').append(view.pane);
    slotViews.set(id, view);
    return view;
  };
  for (const s of S.decos.slots) {
    const { pane, groups } = addView(s.id, s.name);
    S.decos.rarities.forEach((r, ri) => {
      const items = S.decos.items.filter((x) => x.slot === s.id && x.rarity === ri && !x.boss);
      if (items.length) groups.push(decoGroup(pane, r.name, r.color, items));
    });
  }
  if (!S.decos.items.some((x) => x.boss)) return;
  const { pane, groups } = addView('boss', '⚔️ Boss');
  for (const b of S.decos.bosses || []) {
    const items = S.decos.items.filter((x) => x.boss === b.id);
    if (items.length) groups.push(decoGroup(pane, `${b.emoji} ${b.name}`, null, items));
  }
}

function renderDecos() {
  const ds = S.decoState;
  const worn = ds.worn || {};
  for (const [id, { tile, count, tag, d }] of decoTiles) {
    const n = ds.owned[id] || 0;
    const on = worn[d.slot] === id;
    const picked = picking?.picks[id] || 0;
    tile.classList.toggle('owned', n > 0);
    tile.classList.toggle('equipped', on);
    tile.classList.toggle('picked', picked > 0);
    // While picking, owned ones that can't go into this merge are greyed out.
    const unfit = picking?.rarity == null ? !S.decos.rarities[d.rarity + 1] : d.rarity !== picking.rarity;
    tile.classList.toggle('dim', !!picking && n > 0 && unfit);
    const rarity = S.decos.rarities[d.rarity].name;
    const boss = bossOf(d.boss);
    const drop = boss ? `\n${boss.emoji} ${boss.name} 补最后一刀掉落，概率 ${pctText(d.drop)}` : '';
    const action = picking ? '\n点击挑作合成材料' : on ? '\n点击卸下' : '\n点击穿上';
    tile.title = n > 0 ? `${d.name}（${rarity}）× ${n}${drop}${action}` : boss ? `？？？（${rarity}）${drop}` : '？？？';
    count.textContent = n > 1 ? `×${n}` : '';
    tag.textContent = picked ? `✓${picked}` : '';
  }
  renderMerge();
  for (const [slot, { name, off }] of wornRows) {
    const d = decoById.get(worn[slot]);
    name.textContent = d ? d.name : '无';
    name.style.color = d ? S.decos.rarities[d.rarity].color : '#bbb';
    off.classList.toggle('hidden', !d);
  }
  for (const [slot, { tab, pane, groups }] of slotViews) {
    tab.classList.toggle('active', slot === decoSlot);
    pane.classList.toggle('hidden', slot !== decoSlot);
    for (const g of groups) g.info.textContent = `${g.items.filter((x) => ds.owned[x.id] > 0).length}/${g.items.length} 种`;
  }
}

let chestOpening = false;

// Same rule as decos::chest_cooling on the Rust side (a clock turned back doesn't lock it).
function chestWait() {
  const wait = S.decoState.nextChestAt - Date.now();
  return wait > 0 && wait <= S.decos.chestCooldownMs ? wait : 0;
}

const mmss = (ms) => {
  const sec = Math.ceil(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

const bossChests = () => (S.decoState.bossChests || 0) + (S.decoState.luckyChests || 0);

// The panel's 开箱 buttons and the bubble next to my character (boss chests come first).
function renderChest() {
  if (!S.decos.chestCost) return;
  const wait = chestWait();
  const cost = S.decos.chestCost;
  const short = Math.max(0, cost - S.wallet.count);
  const odds = `${S.decos.rarities.map((r) => `${r.name} ${r.odds}%`).join('  ')}\n约 ${S.decos.itemChance}% 开出道具`;
  const btn = $('#chestBtn');
  btn.disabled = chestOpening || wait > 0 || short > 0;
  btn.title = `概率：${odds}`;
  btn.textContent = wait ? mmss(wait) : '开箱';
  $('#chestInfo').textContent = `${cost} 点开一次，每 ${S.decos.chestCooldownMs / 60000} 分钟一次`;

  const won = bossChests();
  const lucky = S.decoState.luckyChests || 0;
  const luckyOdds = S.decos.rarities.map((r) => `${r.name} ${r.luckyOdds}%`).join('  ');
  $('#bossChestRow').classList.toggle('hidden', !won);
  $('#bossChestBtn').disabled = chestOpening;
  $('#bossChestBtn').textContent = `打开（${won}）`;
  $('#bossChestBtn').title = lucky ? `幸运宝箱概率：${luckyOdds}` : `概率：${odds}`;
  $('#bossChestInfo').textContent = `打败 Boss 得到，不花点数${lucky ? `；${lucky} 个是补刀的幸运宝箱` : ''}`;

  const b = $('#myChest');
  b.classList.remove('hidden', 'ready', 'poor', 'cd', 'boss');
  if (won) {
    b.classList.add('boss');
    b.textContent = `🎁 Boss ×${won}`;
    b.title = `打败 Boss 得到的宝箱，点一下打开（不花点数、没有冷却）${lucky ? `\n其中 ${lucky} 个是补刀的幸运宝箱，概率：${luckyOdds}` : ''}`;
  } else if (wait) {
    b.classList.add('cd');
    b.textContent = `⏳ ${mmss(wait)}`;
    b.title = '宝箱冷却中';
  } else {
    b.classList.add(short ? 'poor' : 'ready');
    b.textContent = `🎁 -${cost}`;
    b.title = short ? `还差 ${short} 点才能开宝箱` : `点一下花 ${cost} 点开宝箱\n概率：${odds}`;
  }
}

async function openChest() {
  if (chestOpening || chestWait() || S.wallet.count < S.decos.chestCost) return;
  chestOpening = true;
  renderChest();
  try {
    const r = await api.openChest();
    if (!r.ok) return toast(r.error);
    S.wallet = r.wallet;
    S.decoState = r.decoState;
    renderWallet();
    renderDecos();
    revealPrize(r.prize, '宝箱开出了');
  } finally {
    chestOpening = false;
    renderChest();
  }
}

async function openBossChest() {
  if (chestOpening || !bossChests()) return;
  chestOpening = true;
  renderChest();
  try {
    const r = await api.openBossChest();
    if (!r.ok) return toast(r.error);
    S.wallet = r.wallet;
    S.decoState = r.decoState;
    renderWallet();
    renderDecos();
    revealPrize(r.prize, r.lucky ? '幸运 Boss 宝箱开出了' : 'Boss 宝箱开出了');
  } finally {
    chestOpening = false;
    renderChest();
  }
}

// Shows `box` and restarts its pop-in animation.
function replay(box) {
  box.classList.remove('hidden');
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
}

// What a chest gave, popping up above my character for a few seconds.
let myRevealTimer;
function showMyReveal(icon, title, color, sub) {
  const box = $('#myReveal');
  const name = el('b', null, title);
  name.style.color = color;
  const text = el('div', null);
  text.append(name, el('div', 'tip', sub));
  box.replaceChildren(icon, text);
  replay(box);
  // Centred over me, near the window's right edge: move a wide one (item bundles) left to fit.
  box.style.marginLeft = '0px';
  const right = $('#me').getBoundingClientRect().left + box.offsetLeft + box.offsetWidth / 2;
  box.style.marginLeft = `${Math.min(0, window.innerWidth - 8 - right)}px`;
  clearTimeout(myRevealTimer);
  myRevealTimer = setTimeout(() => box.classList.add('hidden'), 4000);
}

// A chest's prize: { kind: 'deco', id, isNew } or { kind: 'items', rarity, items: { id: count } }.
function revealPrize(p, how) {
  if (p.kind === 'deco') return revealDeco(p.id, p.isNew, how);
  const r = S.decos.rarities[p.rarity];
  const got = Object.entries(p.items).map(([id, n]) => [S.items[id], n]).filter(([it]) => it);
  const icon = () => el('div', 'reveal-emoji', got.map(([it]) => it.emoji).join(''));
  const names = got.map(([it, n]) => `${it.name}×${n}`).join('、');
  const text = el('div');
  const name = el('b', null, names);
  name.style.color = r.color;
  text.append(el('div', 'tip', how), name, el('div', null, `${r.name} · 道具，已放进背包`));
  $('#decoReveal').replaceChildren(icon(), text);
  replay($('#decoReveal'));
  showMyReveal(icon(), names, r.color, `${r.name} · 道具`);
}

function revealDeco(id, isNew, how) {
  const d = decoById.get(id);
  if (!d) return;
  const r = S.decos.rarities[d.rarity];
  const text = el('div');
  const name = el('b', null, d.name);
  name.style.color = r.color;
  text.append(el('div', 'tip', how), name);
  if (isNew) text.append(el('span', 'new', 'NEW'));
  text.append(el('div', null, `${r.name}${isNew ? '' : ' · 重复，可用来合成'}`));
  $('#decoReveal').replaceChildren(decoIcon(d), text);
  replay($('#decoReveal'));
  showMyReveal(decoIcon(d), d.name, r.color, isNew ? `${r.name} · NEW` : `${r.name} · 重复`);
}

$('#chestBtn').addEventListener('click', openChest);
$('#bossChestBtn').addEventListener('click', openBossChest);
$('#myChest').addEventListener('click', () => (bossChests() ? openBossChest() : openChest()));

function buildMerge() {
  const box = $('#decoMerge');
  S.decos.rarities.forEach((r, ri) => {
    if (!S.decos.rarities[ri + 1]) return;
    const row = el('div', 'merge-row');
    const name = el('b', null, r.name);
    name.style.color = r.color;
    mergeRows[ri] = el('small');
    row.append(name, mergeRows[ri]);
    box.append(row);
  });
  const u = Object.assign(mergeUi, {
    status: el('div', 'merge-status'), chips: el('div', 'merge-chips'), start: el('button', 'mini', '挑材料合成'),
    fill: el('button', 'mini', '补满'), go: el('button', 'mini primary'), cancel: el('button', 'mini', '取消'),
  });
  u.fill.title = '先挑重复的，再挑只有一件的普通装扮（只有一件的 Boss 专属要自己点）';
  u.start.addEventListener('click', () => { picking = { rarity: null, picks: {}, confirm: false }; renderDecos(); });
  u.fill.addEventListener('click', fillPicks);
  u.go.addEventListener('click', mergePicked);
  u.cancel.addEventListener('click', stopPicking);
  const bar = el('div', 'merge-bar');
  bar.append(u.start, u.fill, u.go, u.cancel);
  box.append(u.status, u.chips, bar);
}

const pickedCount = () => Object.values(picking?.picks || {}).reduce((a, b) => a + b, 0);

function renderMerge() {
  const stats = S.decoState.stats || [];
  mergeRows.forEach((info, ri) => { info.textContent = `共 ${stats[ri]?.owned || 0} 件`; });
  const u = mergeUi;
  const r = S.decos.rarities;
  const n = pickedCount();
  u.start.classList.toggle('hidden', !!picking);
  for (const e of [u.status, u.chips, u.fill, u.go, u.cancel]) e.classList.toggle('hidden', !picking);
  if (!picking) return;
  u.status.textContent = picking.rarity === null ? '点下面已拥有的装扮挑材料，第一件决定合成哪种稀有度'
    : `已挑 ${n}/${S.decos.mergeCount} 件${r[picking.rarity].name}（点上面的图标退回）`;
  u.chips.replaceChildren(...Object.entries(picking.picks).map(([id, k]) => {
    const d = decoById.get(id);
    const chip = el('span', 'merge-chip');
    chip.title = `${d.name}${k > 1 ? ` ×${k}` : ''}\n点一下退回一件`;
    chip.append(decoIcon(d), el('small', null, k > 1 ? `×${k}` : ''));
    chip.addEventListener('click', () => unpick(id));
    return chip;
  }));
  u.fill.disabled = picking.rarity === null || n >= S.decos.mergeCount;
  u.go.disabled = n !== S.decos.mergeCount;
  u.go.textContent = picking.confirm ? `会用掉 ${picking.lose} 件只有一件的，再点确认` : picking.rarity === null ? '合成' : `合成 → ${r[picking.rarity + 1].name}`;
}

function pickDeco(d) {
  const r = S.decos.rarities;
  const owned = S.decoState.owned[d.id] || 0;
  if (!owned) return;
  if (picking.rarity === null && !r[d.rarity + 1]) return toast(`${r[d.rarity].name}是最高稀有度，不能再合成了`);
  if (picking.rarity !== null && d.rarity !== picking.rarity) return toast(`这次合成的是${r[picking.rarity].name}，只能挑${r[picking.rarity].name}的`);
  const have = picking.picks[d.id] || 0;
  const worn = Object.values(S.decoState.worn || {}).includes(d.id);
  if (have >= owned - (worn ? 1 : 0)) return toast(worn ? '正在穿的要留一件' : '这件已经全挑上了');
  if (pickedCount() >= S.decos.mergeCount) return toast(`已经挑够 ${S.decos.mergeCount} 件了`);
  picking.rarity = d.rarity;
  picking.picks[d.id] = have + 1;
  picking.confirm = false;
  renderDecos();
}

function unpick(id) {
  if (!picking?.picks[id]) return;
  if (--picking.picks[id] === 0) delete picking.picks[id];
  if (!pickedCount()) picking.rarity = null;
  picking.confirm = false;
  renderDecos();
}

function stopPicking() {
  clearTimeout(picking?.timer);
  picking = null;
  renderDecos();
}

async function fillPicks() {
  if (picking?.rarity == null) return;
  const r = await api.fillMerge(picking.rarity, picking.picks);
  if (!picking) return;
  picking.picks = r.picks;
  picking.confirm = false;
  renderDecos();
  const short = S.decos.mergeCount - pickedCount();
  if (short > 0) toast(`还差 ${short} 件，能自动挑的都挑上了（只有一件的 Boss 专属要自己点）`);
}

async function mergePicked() {
  if (!picking) return;
  const r = await api.mergeDecos(picking.picks, picking.confirm);
  if (!picking) return;
  clearTimeout(picking.timer);
  if (r.confirm) {
    // Using up the last copy of something needs a second click.
    const timer = setTimeout(() => { if (picking) { picking.confirm = false; renderDecos(); } }, 4000);
    Object.assign(picking, { confirm: true, lose: r.lose, timer });
    return renderDecos();
  }
  if (!r.ok) {
    picking.confirm = false;
    renderDecos();
    return toast(r.error);
  }
  S.decoState = r.decoState;
  stopPicking();
  revealDeco(r.item, r.isNew, '合成得到了');
}

// Wears `id` in `slot` ("" takes it off).
async function wear(slot, id) {
  const r = await api.equipDeco(slot, id);
  if (!r.ok) return toast(r.error);
  S.decoState = r.decoState;
  renderDecos();
  renderMe();
}

function toggleWear(id) {
  const d = decoById.get(id);
  if (!d || !S.decoState.owned[id]) return;
  wear(d.slot, S.decoState.worn?.[d.slot] === id ? '' : id);
}

// ---------------------------------------------------------------- calendar
// Key presses + mouse clicks per day (S.daily: "2026-11-04" -> count) and the bosses I landed
// the last hit on (S.dailyLastHits). Each day gets a rating by how busy it was; its colour is
// l0..l5 in pet.css.
const DAY_LEVELS = [
  { min: 0, emoji: '😴', name: '休息', text: '没怎么碰电脑，好好休息' },
  { min: 1, emoji: '🐟', name: '摸鱼', text: '今天主打一个摸鱼' },
  { min: 3000, emoji: '🧱', name: '搬砖', text: '正常搬砖，稳稳当当' },
  { min: 10000, emoji: '💪', name: '勤奋', text: '很努力的一天，给自己加个鸡腿' },
  { min: 20000, emoji: '🔥', name: '爆肝', text: '键盘都要冒烟了，记得喝水' },
  { min: 40000, emoji: '👑', name: '卷王', text: '卷王本王，同事瑟瑟发抖' },
];
const levelOf = (n) => DAY_LEVELS.findLastIndex((l) => n >= l.min);
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']; // weeks start on Monday
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (t) => `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
// 9999 / 1.2万 / 123万: short enough for a calendar cell. Rounded down, so 19999 isn't 2万 (the next rating).
const shortCount = (n) => (n < 1e4 ? String(n) : n < 1e6 ? `${Math.floor(n / 1e3) / 10}万` : `${Math.floor(n / 1e4)}万`);
// Only touch the DOM when something changed: the calendar re-renders on every key press.
const setText = (e, s) => { if (e.textContent !== s) e.textContent = s; };
const setClass = (e, c) => { if (e.className !== c) e.className = c; };

const calCells = []; // six weeks of { box, day, emoji, count, hits }
let calMonth = null; // first day of the month shown; null = this month

function buildCalendar() {
  const grid = $('#calGrid');
  for (const w of WEEKDAYS) grid.append(el('div', 'cal-wd', w));
  for (let k = 0; k < 42; k++) {
    const c = { box: el('div'), day: el('span', 'd'), emoji: el('span', 'e'), count: el('b'), hits: el('small') };
    c.box.append(c.day, c.emoji, c.count, c.hits);
    grid.append(c.box);
    calCells.push(c);
  }
  DAY_LEVELS.forEach((l, i) => {
    const key = el('span', 'cal-key');
    key.title = l.text;
    key.append(el('i', `l${i}`), `${l.emoji} ${l.name}`, el('small', null, l.min ? `${shortCount(l.min)}+` : '0'));
    $('#calLegend').append(key);
  });
  $('#calPrev').addEventListener('click', () => showMonth(-1));
  $('#calNext').addEventListener('click', () => showMonth(1));
}

// `step` months from the one shown; null: back to this month.
function showMonth(step) {
  const m = step === null ? new Date() : calMonth || new Date();
  calMonth = new Date(m.getFullYear(), m.getMonth() + (step || 0), 1);
  renderCalendar();
}

function renderCalendar() {
  const now = new Date();
  const today = dayKey(now);
  const first = calMonth || new Date(now.getFullYear(), now.getMonth(), 1);
  const [y, m] = [first.getFullYear(), first.getMonth()];
  const lead = (first.getDay() + 6) % 7;
  const weeks = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
  // From the first day on record, a past day without a count was a rest day; before it there's nothing to say.
  const since = Object.keys(S.daily).sort()[0] || today;
  let sum = 0;
  let hitSum = 0;
  calCells.forEach((c, k) => {
    const date = new Date(y, m, k - lead + 1);
    const key = dayKey(date);
    const inMonth = date.getMonth() === m;
    const n = inMonth ? S.daily[key] || 0 : 0;
    const hits = inMonth ? S.dailyLastHits[key] || 0 : 0;
    const lv = inMonth && key >= since && (key < today || (key === today && n > 0)) ? levelOf(n) : -1;
    const l = DAY_LEVELS[lv];
    sum += n;
    hitSum += hits;
    setClass(c.box, `cal-day${k >= weeks * 7 ? ' gone' : inMonth ? '' : ' blank'}${l ? ` l${lv}` : ''}${key === today ? ' today' : key > today ? ' future' : ''}`);
    setText(c.day, inMonth ? String(date.getDate()) : '');
    setText(c.emoji, l ? l.emoji : '');
    setText(c.count, n ? shortCount(n) : '');
    setText(c.hits, hits ? `⚔${hits}` : '');
    const what = l ? `${n.toLocaleString()} 次 · ${l.emoji} ${l.name}\n${l.text}` : n ? `${n.toLocaleString()} 次` : key > today ? '还没到' : key === today ? '今天还没开工' : '没有记录';
    c.box.title = inMonth ? `${m + 1}月${date.getDate()}日 周${WEEKDAYS[(date.getDay() + 6) % 7]}\n${what}${hits ? `\n⚔️ Boss 最后一击 ${hits} 次` : ''}` : '';
  });
  setText($('#calMonth'), `${y} 年 ${m + 1} 月`);
  setText($('#calSum'), `共 ${sum.toLocaleString()} 次${hitSum ? ` · ⚔️ ${hitSum}` : ''}`);
  $('#calPrev').disabled = dayKey(first) <= `${since.slice(0, 8)}01`;
  $('#calNext').disabled = y * 12 + m >= now.getFullYear() * 12 + now.getMonth();
}

// Today's count and rating (top of the calendar, and on the count bubble under my character);
// the calendar itself only while it's on screen.
function renderDays() {
  const today = dayKey(new Date());
  const n = S.daily[today] || 0;
  const l = DAY_LEVELS[levelOf(n)];
  const hits = S.dailyLastHits[today] || 0;
  const allHits = Object.values(S.dailyLastHits).reduce((a, b) => a + b, 0);
  setText($('#calToday'), n.toLocaleString());
  setText($('#calLevel'), n ? `${l.emoji} ${l.name} · ${l.text}` : '☕ 今天还没开工');
  setText($('#calHits'), `⚔️ Boss 最后一击：今天 ${hits} · 共 ${allHits}`);
  $('#bubble').title = `今日累计 ${n.toLocaleString()} 次${n ? `（${l.emoji} ${l.name}）` : ''}\n点一下看日历`;
  const shown = !$('#panel').classList.contains('hidden') && !$('section[data-pane="cal"]').classList.contains('hidden');
  if (shown) renderCalendar();
}

$('#bubble').addEventListener('click', () => openPanel('cal'));

// ---------------------------------------------------------------- updates
function renderUpdate() {
  const u = S.update || {};
  $('#verText').textContent = `v${S.version}`;
  const pct = u.total ? ` ${Math.floor((u.done / u.total) * 100)}%` : u.done ? ` ${(u.done / 1048576).toFixed(1)} MB` : '';
  const text = {
    checking: '正在检查更新…',
    latest: '已经是最新版',
    available: `当前 v${S.version} → 最新 v${u.version}（点下面的按钮才会更新）`,
    downloading: `正在下载 v${u.version}…${pct}`,
    restarting: '下载完成，正在重启…',
    error: `更新失败：${u.text || ''}${u.page ? `\n可以手动下载：${u.page}` : ''}`,
  }[u.state] || '';
  $('#updText').textContent = text;
  // The release notes stay visible while there's a version to install (also after a failed try).
  const notes = u.version && ['available', 'downloading', 'error'].includes(u.state) ? (u.notes || '').trim() : '';
  $('#updNotes').classList.toggle('hidden', !notes);
  $('#updNotesText').textContent = notes;
  $('#myUpdate').classList.toggle('hidden', u.state !== 'available');
  $('#myUpdate').title = `有新版本 v${u.version}，点击查看更新内容`;
  $('#updApplyBtn').classList.toggle('hidden', u.state !== 'available' && !(u.state === 'error' && u.version));
  $('#updApplyBtn').textContent = u.state === 'error' ? '重试' : `更新到 v${u.version}`;
  const busy = ['checking', 'downloading', 'restarting'].includes(u.state);
  $('#updCheckBtn').disabled = busy;
  $('#updApplyBtn').disabled = busy;
  document.querySelector('.tabs button[data-tab="room"]').classList.toggle('badge', u.state === 'available');
}

$('#updCheckBtn').addEventListener('click', () => api.checkUpdate());
$('#myUpdate').addEventListener('click', () => {
  openPanel('room');
  const box = $('#updateBox');
  box.scrollIntoView({ block: 'nearest' });
  box.classList.remove('flash');
  void box.offsetWidth;
  box.classList.add('flash');
});
$('#updApplyBtn').addEventListener('click', async () => {
  const r = await api.applyUpdate();
  if (!r.ok) toast(r.error);
});

// ---------------------------------------------------------------- log / toast
function log(text) {
  const box = $('#log');
  const line = el('div', 'logline', text);
  box.append(line);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => line.remove(), 6000);
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------------------------------------------------------------- click-through + drag
// The window is mostly transparent and lets clicks through; the Rust side makes it clickable
// only while the cursor is over one of these rectangles (the character, friend cards, panel).
let lastRects = '';
function reportRects() {
  const rects = [];
  for (const e of document.querySelectorAll('.hit')) {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push([r.left, r.top, r.width, r.height].map(Math.round));
  }
  const key = JSON.stringify(rects);
  if (key !== lastRects) {
    lastRects = key;
    api.hitRects(rects);
  }
}
new MutationObserver(() => requestAnimationFrame(reportRects)).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
setInterval(reportRects, 500); // catches layout shifts from animations

// Press on the character: a short click toggles the panel, moving while pressed drags the window.
let press = null;
$('#myImg').addEventListener('mousedown', (e) => {
  if (e.button === 0) press = { x: e.screenX, y: e.screenY };
});
document.addEventListener('mousemove', (e) => {
  if (press && (e.buttons & 1) && Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) > 4) {
    press = null;
    api.startDrag();
  }
});
window.addEventListener('mouseup', () => {
  if (!press) return;
  press = null;
  const p = $('#panel');
  if (p.classList.contains('hidden')) openPanel(); else p.classList.add('hidden');
});

// ---------------------------------------------------------------- wiring
// Events can arrive before init() resolves; init() returns the full current state anyway.
api.on('local', (d) => {
  if (!S.me) return;
  S.typing = d.typing;
  if (d.total > S.wallet.total) myTap.tap(); // new key presses / clicks (total only ever grows)
  S.wallet = { count: d.count, total: d.total, inv: d.inv };
  if (d.daily) Object.assign(S.daily, d.daily);
  renderMe();
  renderWallet();
  renderDays();
});
api.on('wallet', (w) => { if (S.me) { S.wallet = w; renderWallet(); } });
api.on('net-status', (s) => {
  if (!S.me) return;
  S.net = s.state;
  $('#netText').textContent = s.text;
  renderRoom();
  renderFriendButtons();
  renderMyItems();
  renderShop();
  renderBoss();
});
api.on('boss', (b) => {
  if (!S.me) return;
  S.boss = b;
  if (b) S.bossAt = Date.now() + b.in;
  renderBoss();
});
api.on('boss-down', (d) => {
  if (!S.me) return;
  bossDown = { until: Date.now() + 2500, killerName: d.killerName };
  renderBoss();
  if (d.dailyLastHits) Object.assign(S.dailyLastHits, d.dailyLastHits);
  renderDays();
  if (d.loot) revealDeco(d.loot.id, d.loot.isNew, '补最后一刀掉落了 Boss 专属装扮');
});
// Boss chests won (the reply to opening one carries the state too).
api.on('deco-state', (d) => { if (S.me) { S.decoState = d; renderDecos(); renderChest(); } });
api.on('server-items', (list) => {
  if (!S.me) return;
  S.serverItems = list;
  renderFriendButtons();
  renderMyItems();
  renderShop();
});
api.on('dnd', (on) => { if (S.me) { S.dnd = on; renderMyItems(); } });
api.on('players', (list) => {
  if (!S.me) return;
  S.players = list;
  renderFriends();
  renderRoom();
});
api.on('skin', ({ id, rev, skin }) => {
  if (!S.me) return;
  if (skin) S.skins[id] = { rev, skin }; else delete S.skins[id];
  renderFriends();
});
api.on('update', (u) => { S.update = u; if (S.me) renderUpdate(); });
api.on('log', log);
api.on('toast', toast);
api.on('hit', (hit) => { if (S.me) showHit(hit); });
api.on('steam-joined', (d) => {
  if (!S.me) return;
  if (d.joinAddress) $('#joinAddr').value = d.joinAddress;
  if (d.server) S.server = d.server;
  renderRoom();
});

(async () => {
  const d = await api.init();
  Object.assign(S, {
    me: d.me, wallet: d.wallet, items: d.items, serverItems: d.serverItems, dnd: d.dnd, characters: d.characters, maxPlayers: d.maxPlayers,
    players: d.players, skins: d.skins, net: d.net.state, server: d.server, steam: d.steam || d.server?.steam,
    decos: d.decos, decoState: d.decoState, version: d.version, update: d.update, boss: d.boss, bossAt: Date.now() + (d.boss?.in || 0),
    daily: d.daily || {}, dailyLastHits: d.dailyLastHits || {},
  });
  for (const x of d.decos.items) decoById.set(x.id, x);
  $('#nameInput').value = d.me.name;
  $('#hostPort').value = d.hostPort;
  $('#joinAddr').value = d.joinAddress;
  $('#joinRoom').value = d.joinRoom;
  $('#joinPwd').value = d.joinPassword;
  $('#hostPwd').value = d.hostPassword;
  preloadFrames();
  buildShop();
  buildMyItems();
  buildDecos();
  buildCalendar();
  renderDecos();
  renderUpdate();
  setInterval(() => { renderChest(); renderBoss(); renderDays(); }, 1000); // countdowns, a new day at midnight
  renderMe();
  renderWallet();
  renderChars();
  renderFriends();
  renderRoom();
  renderBoss();
  if (S.steam?.available && S.net === 'offline') refreshSteamRooms();
  if (d.justUpdated) toast(`已更新到 v${d.version}`);
})();
