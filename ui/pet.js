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
  characters: [],
  players: [],
  skins: {}, // playerId -> { rev, skin }
  net: 'offline',
  server: { running: false, ips: [] },
  steam: { available: false, appId: 480 },
  steamRooms: [],
  steamLoading: false,
  decos: { items: [], rarities: [] }, // catalogue
  decoState: { owned: {}, equipped: '', nextChestAt: 0, stats: [] },
  version: '',
  update: { state: 'idle' },
};

// Each built-in character has one idle frame and three typing frames. Every key press flashes
// one random typing frame (never the same one twice in a row), then it's straight back to idle.
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

// ---------------------------------------------------------------- me
function renderMe() {
  setSrc($('#myImg'), srcFor(S.me.char, S.me.skin, myTap.frame));
  setDeco($('#myDeco'), S.decoState.equipped);
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
      const actions = el('div', 'factions');
      for (const item of Object.values(S.items)) {
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
      avatar.append(el('img', 'deco hidden'), img);
      node.append(el('span', 'ftyping', '⌨'), el('span', 'fcount'), avatar, el('div', 'fname'), actions);
      box.append(node);
      friendEls.set(p.id, node);
    }
    node.classList.toggle('typing', !!p.typing);
    node.querySelector('.fcount').textContent = p.count;
    node.querySelector('.fname').textContent = p.name;
    const deco = decoById.get(p.deco);
    node.title = `${p.name}\n点数 ${p.count}\n🍅${p.inv?.tomato ?? 0} 🦑${p.inv?.ink ?? 0} 💩${p.inv?.poop ?? 0}${deco ? `\n装扮：${deco.name}` : ''}`;
    setDeco(node.querySelector('.deco'), p.deco);
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
}

// Each friend card has one button per item, showing how many we own; 0 = disabled.
function renderFriendButtons() {
  const online = S.net === 'online';
  for (const node of friendEls.values()) {
    for (const b of node.querySelectorAll('.fbtn')) {
      const n = S.wallet.inv[b.dataset.item] || 0;
      b.querySelector('small').textContent = n;
      b.disabled = n < 1 || !online;
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

function showFriendHit(hit) {
  const node = friendEls.get(hit.to);
  if (!node) return;
  const item = S.items[hit.item];
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
  const sp = el('div', 'fsplat', item?.emoji || '💥');
  node.append(sp);
  setTimeout(() => sp.remove(), 2000);
}

// ---------------------------------------------------------------- panel
function openPanel(tab) {
  $('#panel').classList.remove('hidden');
  if (tab) switchTab(tab);
  if (S.net === 'offline' && S.steam?.available) refreshSteamRooms();
}

function switchTab(tab) {
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('section[data-pane]').forEach((s) => s.classList.toggle('hidden', s.dataset.pane !== tab));
  if (tab === 'room' && S.net === 'offline' && S.steam?.available) refreshSteamRooms();
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
    info.append(el('b', null, item.name), owned);
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
    owned.textContent = `${item.cost} 点 · 已有 ${S.wallet.inv[item.id] || 0} 个`;
    for (const { b, qty } of buttons) b.disabled = S.wallet.count < item.cost * qty;
  }
}

// ---------------------------------------------------------------- cosmetics
const decoTiles = new Map(); // id -> { tile, count }
const decoSections = []; // per rarity: { head, merge, confirm }

function buildDecos() {
  const list = $('#decoList');
  S.decos.rarities.forEach((r, ri) => {
    const sec = el('div', 'deco-sec');
    const head = el('div', 'deco-head');
    const name = el('b', null, r.name);
    name.style.color = r.color;
    const info = el('small');
    head.append(name, info);
    const next = S.decos.rarities[ri + 1];
    const merge = next ? el('button', 'mini', `合成 → ${next.name}`) : null;
    if (merge) {
      merge.addEventListener('click', () => mergeDecos(ri));
      head.append(merge);
    }
    const grid = el('div', 'deco-grid');
    for (const d of S.decos.items.filter((x) => x.rarity === ri)) {
      const tile = el('div', 'tile');
      const img = decoIcon(d);
      img.loading = 'lazy';
      const count = el('small');
      tile.append(img, count);
      tile.addEventListener('click', () => equipDeco(d.id));
      grid.append(tile);
      decoTiles.set(d.id, { tile, count, d });
    }
    sec.append(head, grid);
    list.append(sec);
    decoSections.push({ info, merge, confirm: false, timer: null });
  });
}

function renderDecos() {
  const ds = S.decoState;
  for (const [id, { tile, count, d }] of decoTiles) {
    const n = ds.owned[id] || 0;
    tile.classList.toggle('owned', n > 0);
    tile.classList.toggle('equipped', ds.equipped === id);
    tile.title = n > 0 ? `${d.name}（${S.decos.rarities[d.rarity].name}）× ${n}${ds.equipped === id ? '\n点击卸下' : '\n点击穿上'}` : '？？？';
    count.textContent = n > 1 ? `×${n}` : '';
  }
  decoSections.forEach((sec, ri) => {
    const st = ds.stats[ri] || {};
    sec.info.textContent = `${st.kinds || 0}/${st.total || 0} 种 · 共 ${st.owned || 0} 个`;
    if (sec.merge && !sec.confirm) {
      sec.merge.disabled = !st.canMerge;
      sec.merge.title = st.lose ? `会用掉 ${st.lose} 个只有一件的装扮` : '';
    }
  });
  const cur = decoById.get(ds.equipped);
  $('#decoCur').textContent = cur ? cur.name : '无';
  $('#decoCur').style.color = cur ? S.decos.rarities[cur.rarity].color : '';
  $('#decoOff').classList.toggle('hidden', !cur);
}

function renderChest() {
  if (!S.decos.chestCost) return;
  const wait = S.decoState.nextChestAt - Date.now();
  const cooling = wait > 0 && wait <= S.decos.chestCooldownMs;
  const btn = $('#chestBtn');
  btn.disabled = cooling || S.wallet.count < S.decos.chestCost;
  const odds = S.decos.rarities.map((r) => `${r.name} ${r.odds}%`).join('  ');
  btn.title = `概率：${odds}`;
  if (cooling) {
    const sec = Math.ceil(wait / 1000);
    btn.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  } else {
    btn.textContent = '开箱';
  }
  $('#chestInfo').textContent = `${S.decos.chestCost} 点开一次，每 ${S.decos.chestCooldownMs / 60000} 分钟一次`;
}

function revealDeco(id, isNew, how) {
  const d = decoById.get(id);
  if (!d) return;
  const r = S.decos.rarities[d.rarity];
  const box = $('#decoReveal');
  const img = decoIcon(d);
  const text = el('div');
  const name = el('b', null, d.name);
  name.style.color = r.color;
  text.append(el('div', 'tip', how), name);
  if (isNew) text.append(el('span', 'new', 'NEW'));
  text.append(el('div', null, `${r.name}${isNew ? '' : ' · 重复，可用来合成'}`));
  box.replaceChildren(img, text);
  box.classList.remove('hidden');
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
  toast(`获得${r.name}装扮：${d.name}`);
}

$('#chestBtn').addEventListener('click', async () => {
  const btn = $('#chestBtn');
  btn.disabled = true;
  const r = await api.openChest();
  if (!r.ok) { renderChest(); return toast(r.error); }
  S.wallet = r.wallet;
  S.decoState = r.decoState;
  renderWallet();
  renderDecos();
  revealDeco(r.item, r.isNew, '宝箱开出了');
});

async function mergeDecos(rarity) {
  const sec = decoSections[rarity];
  const r = await api.mergeDecos(rarity, sec.confirm);
  clearTimeout(sec.timer);
  if (r.confirm) {
    // Using up an item that's the only one of its kind needs a second click.
    sec.confirm = true;
    sec.merge.textContent = `会用掉 ${r.lose} 个独有的，再点确认`;
    sec.timer = setTimeout(() => { sec.confirm = false; sec.merge.textContent = `合成 → ${S.decos.rarities[rarity + 1].name}`; renderDecos(); }, 4000);
    return;
  }
  sec.confirm = false;
  sec.merge.textContent = `合成 → ${S.decos.rarities[rarity + 1].name}`;
  if (!r.ok) return toast(r.error);
  S.decoState = r.decoState;
  renderDecos();
  revealDeco(r.item, r.isNew, '合成得到了');
}

async function equipDeco(id) {
  if (!S.decoState.owned[id]) return;
  const r = await api.equipDeco(S.decoState.equipped === id ? '' : id);
  if (!r.ok) return toast(r.error);
  S.decoState = r.decoState;
  renderDecos();
  renderMe();
}

$('#decoOff').addEventListener('click', async () => {
  const r = await api.equipDeco('');
  S.decoState = r.decoState;
  renderDecos();
  renderMe();
});

// ---------------------------------------------------------------- updates
function renderUpdate() {
  const u = S.update || {};
  $('#verText').textContent = `v${S.version}`;
  const pct = u.total ? ` ${Math.floor((u.done / u.total) * 100)}%` : u.done ? ` ${(u.done / 1048576).toFixed(1)} MB` : '';
  const text = {
    checking: '正在检查更新…',
    latest: '已经是最新版',
    available: `发现新版本 v${u.version}${u.notes ? `\n${u.notes}` : ''}`,
    downloading: `正在下载 v${u.version}…${pct}`,
    restarting: '下载完成，正在重启…',
    error: `更新失败：${u.text || ''}${u.page ? `\n可以手动下载：${u.page}` : ''}`,
  }[u.state] || '';
  $('#updText').textContent = text;
  $('#updApplyBtn').classList.toggle('hidden', u.state !== 'available' && !(u.state === 'error' && u.version));
  $('#updApplyBtn').textContent = u.state === 'error' ? '重试' : `更新到 v${u.version}`;
  const busy = ['checking', 'downloading', 'restarting'].includes(u.state);
  $('#updCheckBtn').disabled = busy;
  $('#updApplyBtn').disabled = busy;
  document.querySelector('.tabs button[data-tab="room"]').classList.toggle('badge', u.state === 'available');
}

$('#updCheckBtn').addEventListener('click', () => api.checkUpdate());
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
  if (d.total > S.wallet.total) myTap.tap(); // new key presses (total only ever grows)
  S.wallet = { count: d.count, total: d.total, inv: d.inv };
  renderMe();
  renderWallet();
});
api.on('wallet', (w) => { if (S.me) { S.wallet = w; renderWallet(); } });
api.on('net-status', (s) => {
  if (!S.me) return;
  S.net = s.state;
  $('#netText').textContent = s.text;
  renderRoom();
  renderFriendButtons();
});
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
api.on('hit', showFriendHit);
api.on('steam-joined', (d) => {
  if (!S.me) return;
  if (d.joinAddress) $('#joinAddr').value = d.joinAddress;
  if (d.server) S.server = d.server;
  renderRoom();
});

(async () => {
  const d = await api.init();
  Object.assign(S, {
    me: d.me, wallet: d.wallet, items: d.items, characters: d.characters, maxPlayers: d.maxPlayers,
    players: d.players, skins: d.skins, net: d.net.state, server: d.server, steam: d.steam || d.server?.steam,
    decos: d.decos, decoState: d.decoState, version: d.version, update: d.update,
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
  buildDecos();
  renderDecos();
  renderUpdate();
  setInterval(renderChest, 1000);
  renderMe();
  renderWallet();
  renderChars();
  renderFriends();
  renderRoom();
  if (S.steam?.available && S.net === 'offline') refreshSteamRooms();
  if (d.justUpdated) toast(`已更新到 v${d.version}`);
})();
