'use strict';
/* global api */
(() => {
  const root = document.querySelector('#gamesRoot');
  const dock = document.querySelector('#gameDock');
  const roomSummary = document.querySelector('#roomGameSummary');
  const panel = document.querySelector('#panel');
  const stage = document.querySelector('#stage');
  const names = { blackjack: '21 点', holdem: '德州扑克', ddz: '斗地主', mahjong: '四川麻将', flight: '飞行棋', xiangqi: '中国象棋', monopoly: '大富翁' };
  const short = { mahjong: '川麻', xiangqi: '象棋' };
  const phases = { lobby: '等待报名', blackjack: '要牌 / 停牌', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', bid: '叫地主', play: '出牌', intermission: '下一轮准备中', finished: '已结束', mahjong: '血战中', flight: '飞行中', xiangqi: '对弈中', monopoly: '进行中' };
  // Icon, seats line and rules for the picker; seat counts mirror server/src/games.rs.
  const about = {
    blackjack: ['♠ 01', '3–16 人 · 最高点数晋级', '无庄家对战：A 算 1 或 11，爆牌或点数较低者淘汰。最高点数平局则继续加赛，直到只剩一人；全部爆牌则重发。'],
    holdem: ['♣ 02', '3–9 人 · 筹码淘汰赛', '每人 1,000 局内筹码，盲注从 10/20 开始、每 8 手提升。支持全下和边池；筹码归零淘汰。局内下注不会额外扣点数。'],
    ddz: ['♦ 03', '3 人 · 地主 vs 农民', '轮流叫地主，支持顺子、连对、飞机、炸弹和王炸。地主赢独得奖金；农民赢由两位农民平分。'],
    mahjong: ['🀄 04', '4 人 · 血战到底', '四川血战：换三张、定缺、不吃牌、可碰杠，一炮多响。依胡牌顺序分 700 / 550 / 350 / 0 点；同时胡平分相应名次奖金，整局结束统一到账。'],
    flight: ['✈ 05', '2–4 人 · 掷骰起飞', '每人 4 架飞机：掷到 6 才能起飞，6 点再掷一次（连续三次 6 本回合作废）。停在自己颜色的格子跳 4 格，第 18 格飞越捷径；落在别人飞机上把它撞回机库。终点要刚好掷到，四架全部到达者独得奖金。'],
    xiangqi: ['♜ 06', '2 人 · 红先黑后', '标准中国象棋，第一位报名者执红先走。将死或困毙对方获胜；双方同意和棋或 60 回合未吃子判和，和棋平分奖金。'],
    monopoly: ['🎲 07', '2–6 人 · 随机地图 · 8 角色', '每局随机生成 32 格地图，开局先挑角色（8 选 1，技能各不相同）。每人 1,500 局内现金，买地、升级、收过路费，破产出局；20 轮后总资产最高者获胜。局内现金不影响点数。'],
  };
  const seatRange = kind => ({ ddz: [3, 3], mahjong: [4, 4], holdem: [3, 9], xiangqi: [2, 2], flight: [2, 4], monopoly: [2, 6] }[kind] || [3, 16]);
  const capacity = kind => seatRange(kind)[1];
  let me = '', online = false, supported = false, wallet = 0, state = null;
  let chosen = 'blackjack', folded = false, busy = false, confirmLeave = false, message = '';
  let selection = new Set();
  let creating = false, picked = null, shownKey = '', wasActing = false;
  const tables = () => state?.tables || (state?.table && state.table.phase !== 'finished' ? [state.table] : []);
  // Rooms on v2.7 hosts don't list their games; they offer the original four.
  const offered = () => state?.kinds || ['blackjack', 'holdem', 'ddz', 'mahjong'];
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const mine = () => state?.table?.seats?.find(s => s.id === me);
  function card(c, selectable = false) {
    if (!Number.isInteger(c) || c < 0 || c > 53) return node('span', 'playing-card back', '♠');
    const suit = c < 52 ? ['♣','♦','♥','♠'][Math.floor(c / 13)] : '';
    const rank = c >= 52 ? (c === 52 ? '小王' : '大王') : ['2','3','4','5','6','7','8','9','10','J','Q','K','A'][c % 13];
    const n = node(selectable ? 'button' : 'span', `playing-card${[1,2].includes(Math.floor(c / 13)) || c === 53 ? ' red' : ''}${c >= 52 ? ' joker' : ''}`);
    n.append(node('span', '', rank), node('span', '', suit));
    n.setAttribute('aria-label', `${suit}${rank}`);
    if (selectable) {
      n.classList.toggle('selected', selection.has(c)); n.setAttribute('aria-pressed', String(selection.has(c)));
      n.onclick = () => { if (selection.has(c)) selection.delete(c); else selection.add(c); n.classList.toggle('selected', selection.has(c)); n.setAttribute('aria-pressed', String(selection.has(c))); };
    }
    return n;
  }
  async function command(op, extra = {}) {
    if (busy) return;
    busy = true; message = ''; render();
    try {
      const mj=state?.table?.mahjong;
      const r = await api.gameCommand({ op, tableId:state?.table?.id, revision: state?.tableRevision ?? state?.revision, mjPhase:mj?.phase, claimTile:mj?.claim?.tile, claimSource:mj?.claim?.source, ...extra });
      if (!r.ok) message = r.error || '操作失败，请重试';
      else { picked = null; if (['play','discard','exchange','gang','hu'].includes(op)) selection.clear(); }
    } catch (_) { message = '未能发送操作，请检查连接'; }
    finally { busy = false; confirmLeave = false; render(); }
  }
  function button(parent, text, op, extra = {}, cls = '') {
    const b = node('button', cls, text); b.disabled = busy || !online || !supported;
    b.onclick = () => command(op, typeof extra === 'function' ? extra() : extra); parent.append(b); return b;
  }
  // Quitting after the start is a forfeit: the ticket is not refunded.
  function leaveButton(actions, t, allowed, label = '退出牌局') {
    if (!allowed) return;
    const lobby = t.phase === 'lobby';
    const b = node('button', 'surrender', confirmLeave ? (lobby ? '确认退票' : `确认${label}，不退门票`) : (lobby ? '取消报名 / 退票' : label));
    b.disabled = busy || !online;
    b.onclick = () => { if (confirmLeave) command('leave'); else { confirmLeave = true; render(); } };
    actions.append(b);
  }
  function updateDock() {
    const t = online && supported && state?.table?.phase !== 'finished' ? state?.table : null;
    const list=online&&supported?tables():[];
    // The table waiting on me, even while I'm watching another one.
    const act = online && supported ? state?.act || (t?.canAct ? t : null) : null;
    dock.classList.toggle('hidden', !list.length);
    dock.classList.toggle('my-turn', !!act);
    refreshPresence(t);
    if (act && act.id !== t?.id) { dock.textContent = `轮到你 · ${names[act.kind] || '牌桌'} ${act.number} 号桌　去操作 ↗`; dock.title = dock.textContent; positionPanel(); return; }
    if (!t) {if(list.length){dock.textContent=`房间有 ${list.length} 张牌桌 · 点击查看`;dock.title=dock.textContent;}return;}
    const status = t.phase === 'lobby' ? `等待报名 ${t.seats.length}/${capacity(t.kind)} 人` : `游戏中 · ${t.seats.filter(s => s.alive && !s.left).length} 人在玩`;
    const label = `${names[t.kind] || '牌桌'}房间${t.number ? ` · ${t.number} 号桌` : ''} · ${status}`;
    dock.textContent = `${list.length>1?`${list.length} 桌 · `:''}${act ? '轮到你 · ' : ''}${label}　查看 ↗`;
    dock.title = `${label}，点击查看牌桌`;
    if (roomSummary && list.length===1) { roomSummary.textContent = `${label}　查看 ↗`; roomSummary.title = dock.title; }
    positionPanel();
  }
  function refreshPresence(table) {
    const list=online&&supported?tables():[];
    if (roomSummary) {roomSummary.classList.toggle('hidden', !list.length);roomSummary.textContent=list.length?`房间有 ${list.length} 张牌桌 · ${list.map(t=>names[t.kind]).join('、')}　查看 ↗`:'';}
    function badge(element, id) {
      if (!element) return;
      const t=list.find(t=>t.seats?.some(s=>s.id===id&&!s.left));
      const seat = t?.seats?.find(s => s.id === id && !s.left);
      element.classList.toggle('hidden', !seat);
      element.classList.toggle('playing', !!seat && t.phase !== 'lobby' && seat.alive);
      element.classList.toggle('watching', !!seat && t.phase !== 'lobby' && !seat.alive);
      element.textContent = seat ? `${short[t.kind] || names[t.kind] || '牌桌'} · ${t.phase === 'lobby' ? '已报名' : seat.alive ? '游戏中' : '观战'}` : '';
      element.title = seat ? `${element.textContent}，点击查看牌桌` : '';
      element.onclick = () => toggleTable(t?.id);
    }
    for (const friend of document.querySelectorAll('#friends .friend')) badge(friend.querySelector('.fgame'), friend.dataset.playerId);
    badge(document.querySelector('#myGameStatus'), me);
  }
  function positionPanel() {
    if (!stage || !panel) return;
    const height = `${Math.ceil(stage.getBoundingClientRect().height)}px`;
    if (panel.style.getPropertyValue('--game-stage-height') !== height) panel.style.setProperty('--game-stage-height', height);
  }
  function openTable() { folded=false;shownKey='';panel.classList.remove('hidden');document.querySelector('[data-tab="games"]').click();render(); }
  function toggleTable(id) {
    const shown=!panel.classList.contains('hidden')&&document.querySelector('[data-tab="games"]').classList.contains('active')&&!folded;
    if(shown&&(!id||id===state?.table?.id)){panel.classList.add('hidden');return;}
    openTable();if(id&&id!==state?.table?.id)command('watch',{tableId:id});
  }
  function render() {
    root.replaceChildren();
    const t = state?.table;
    const head = node('div', 'game-head');
    const title = node('div'); title.append(node('h3', '', '摸鱼牌桌'), node('small', '', `可用点数 ${wallet.toLocaleString()} · 每人门票 500 点`));
    head.append(title);
    const fold = node('button', '', folded ? '展开牌桌' : '收起牌桌'); fold.onclick = () => { folded = !folded; render(); }; head.append(fold); root.append(head);
    root.append(node('p', 'game-rule', '每人 500 点，可分组开多桌；首位报名者开局，总奖金为门票的 80%。轮到谁都不限时，开局后可随时退出，但门票不退。'));
    if (folded) { root.append(node('div', 'game-folded', `${t ? `${names[t.kind]} · ${phases[t.phase]}` : '还没有牌桌'}。可随时展开，收起不会退票或结束牌局。`)); updateDock(); return; }
    if (!online || !supported) {
      root.append(node('div', 'game-empty', online ? '当前房间版本不支持小游戏，请更新房主或中转服务器。' : '连接房间后，和房间里的朋友一起开桌。断线超过 1 分钟由系统代为操作，重连后恢复座位。'));
      if (!t || t.phase === 'finished') { updateDock(); return; }
    }
    if(online&&supported){
      const picker=node('div','table-picker');
      for(const table of tables()){const b=node('button',table.id===t?.id?'active':'',`${table.number||''}号桌 · ${names[table.kind]} · ${table.phase==='lobby'?`${table.seats.length}/${capacity(table.kind)}`:'进行中'}`);b.onclick=()=>{creating=false;command('watch',{tableId:table.id});};picker.append(b);}
      const newTable=node('button','new-table',creating?'收起开桌选项':'+ 新开一桌');newTable.onclick=()=>{creating=!creating;render();};picker.append(newTable);root.append(picker);
    }
    if (creating || !t || t.phase === 'finished') {
      if (!offered().includes(chosen)) chosen = 'blackjack';
      const choices = node('div', 'game-choices');
      for (const [kind, name] of Object.entries(names)) {
        const available = offered().includes(kind);
        const b = node('button', `game-choice${kind === chosen ? ' active' : ''}`);
        b.append(node('small', '', about[kind][0]), node('b', '', name), node('span', '', available ? about[kind][1] : '需要房主 / 中转升级到 v2.8'));
        b.disabled = !available;
        b.onclick = () => { chosen = kind; render(); }; choices.append(b);
      }
      root.append(choices);
      const join = node('div', 'game-actions'); const b = button(join, `新开${names[chosen]} · 500 点`, 'join', () => ({ kind: chosen,create:true,tableId:null }), 'primary'); b.disabled ||= wallet < 500 || state?.receipt?.final===false; root.append(join);
      root.append(node('p', 'game-rule', about[chosen][2]));
    }
    if (t) renderTable(t);
    root.append(node('div', 'game-message', message)); updateDock();
    if (t) reveal(t);
  }
  // The boards are taller than the room left under the panel header: bring the
  // table itself into view when it opens, starts, or turns to me.
  function reveal(t) {
    const felt = root.querySelector('.game-felt'), key = `${t.id}|${t.phase === 'lobby'}`;
    if (felt?.getClientRects().length && (key !== shownKey || (t.canAct && !wasActing))) {
      const tabs = panel.querySelector('.tabs')?.getBoundingClientRect().height || 0;
      panel.scrollTop += felt.getBoundingClientRect().top - panel.getBoundingClientRect().top - tabs - 4;
    }
    shownKey = key; wasActing = !!t.canAct;
  }
  // Right side of the hand label: whose move it is. Turns have no time limit.
  const waiting = t => t.phase === 'intermission' ? '即将开始下一轮' : ['finished','lobby'].includes(t.phase) ? '' : t.canAct ? '轮到你了' : '等待其他玩家';
  function handLabel(text, t) { const label = node('div', 'game-hand-label'); label.append(node('span', '', text), node('span', `game-turn${t.canAct ? ' mine' : ''}`, waiting(t))); return label; }
  function renderTable(t) {
    if(t.kind==='mahjong'&&t.mahjong){renderMahjong(t);return;}
    if(t.kind==='flight'&&t.flight){renderFlight(t);return;}
    if(t.kind==='xiangqi'&&t.xiangqi){renderXiangqi(t);return;}
    if(t.kind==='monopoly'&&t.monopoly){renderMonopoly(t);return;}
    const table = node('div', 'game-felt');
    const top = node('div', 'game-topline');
    top.append(node('b', '', `${names[t.kind] || '牌桌'} · ${phases[t.phase] || ''}`), node('span', '', `奖金 ${t.prize} 点${t.round ? ` · 第 ${t.round} 轮` : ''}`)); table.append(top);
    const seats = node('div', 'game-seats');
    const self = mine();
    for (const s of t.seats || []) {
      const seat = node('div', `game-seat${t.turn === s.id && t.canAct !== undefined && !['lobby','finished','intermission'].includes(t.phase) ? ' turn' : ''}${!s.alive ? ' out' : ''}`);
      const line = node('div', 'seat-name');
      line.append(node('b', '', `${s.name}${s.id === me ? '（我）' : ''}`), node('small', '', s.left ? '已弃权' : !s.alive ? '已淘汰 · 观战' : t.kind === 'ddz' && t.landlord ? (s.id === t.landlord ? '地主' : '农民') : t.phase === 'lobby' && s.id === t.host ? '发起人' : ''));
      seat.append(line);
      seat.append(node('p', '', t.phase === 'lobby' ? '已报名 · 500 点' : t.kind === 'holdem' ? `筹码 ${s.chips} · 本轮 ${s.bet}${s.folded ? ' · 弃牌' : s.chips === 0 ? ' · 全下' : ''}` : t.kind === 'blackjack' ? `${s.score != null ? `${s.score} 点${s.score > 21 ? ' · 爆牌' : ''}` : `${s.count} 张牌`}${s.stood && s.alive ? ' · 已停牌' : ''}` : `剩余 ${s.count} 张`));
      // Exposed showdown cards are supplied by the server; spectators never
      // reconstruct hands from another seat or from a shared client cache.
      if (s.cards && s.id !== me && s.cards.length && t.phase !== 'lobby') { const row = node('div', 'game-hand'); for (const c of s.cards) row.append(card(c)); seat.append(row); }
      seats.append(seat);
    }
    table.append(seats);
    if (t.board?.length || (t.kind === 'ddz' && t.bottom?.length)) {
      const board = node('div', 'game-board'); board.append(node('small', '', t.kind === 'ddz' ? '地主底牌' : '公共牌'));
      for (const c of t.kind === 'ddz' ? t.bottom : t.board) board.append(card(c)); table.append(board);
    }
    if (t.kind === 'ddz' && t.last?.length) {
      const last = node('div', 'game-board'); last.append(node('small', '', `${t.lastOwner} 出牌`)); for (const c of t.last) last.append(card(c)); table.append(last);
    }
    if (self?.cards?.length && t.phase !== 'lobby') {
      table.append(handLabel(self.alive ? '我的手牌' : '已淘汰，继续观战', t));
      const hand = node('div', 'game-hand'); for (const c of self.cards) hand.append(card(c, t.kind === 'ddz' && t.phase === 'play' && t.canAct && online)); table.append(hand);
    } else if (t.phase !== 'lobby' && t.phase !== 'finished') table.append(handLabel('观战中 · 仅显示公开牌', t));
    const actions = node('div', 'game-actions');
    if (t.phase === 'lobby') {
      if (!self) { const b = button(actions, `报名 · 500 点（${t.seats.length}/${capacity(t.kind)}）`, 'join', {kind:t.kind}, 'primary'); b.disabled ||= wallet < 500 || state?.receipt?.final===false || t.seats.length>=capacity(t.kind); }
      if (self?.id === t.host) { const b = button(actions, '开始游戏', 'start', {}, 'primary'); b.disabled ||= t.seats.length < seatRange(t.kind)[0]; }
    } else if (t.canAct && online) {
      if (t.kind === 'blackjack') { button(actions, '要牌', 'hit', {}, 'primary'); button(actions, '停牌', 'stand'); }
      else if (t.kind === 'holdem') {
        button(actions, '弃牌', 'fold'); button(actions, t.call ? `跟注 ${t.call}` : '过牌', t.call ? 'call' : 'check', {}, 'primary');
        if (t.canRaise && self.chips + self.bet > t.currentBet) {
          const amount = node('input'); amount.type = 'number'; amount.min = t.currentBet + t.minRaise; amount.max = self.chips + self.bet; amount.value = Math.min(t.currentBet + t.minRaise, self.chips + self.bet); amount.setAttribute('aria-label', '加注至本轮总筹码'); actions.append(amount);
          button(actions, '加注至', 'raise', () => ({amount:Number(amount.value)}));
        }
        if (t.canRaise || self.chips + self.bet <= t.currentBet) button(actions, '全下', 'allin');
      } else if (t.phase === 'bid') {
        button(actions, '不叫', 'bid', {bid:0}); for (let bid=t.bid+1; bid<=3; bid++) button(actions, `叫 ${bid} 分`, 'bid', {bid}, 'primary');
      } else { button(actions, '出选中的牌', 'play', () => ({cards:[...selection]}), 'primary'); if (t.last?.length) button(actions, '不出', 'pass'); }
    }
    leaveButton(actions, t, self && !self.left && self.alive && t.phase !== 'finished');
    table.append(actions, node('p', 'game-note', t.note));
    winnersLine(table, t);
    root.append(table);
  }
  function winnersLine(table, t) {
    if (t.phase !== 'finished') return;
    const winners = (t.seats || []).filter(s => t.winners?.includes(s.id));
    table.append(node('div', 'game-winners', winners.length ? `🏆 ${winners.map(s => s.name).join('、')} · ${winners.length > 1 ? '每人 ' : ''}${Math.floor(t.prize / winners.length)} 点` : '牌桌已取消'));
  }
  // Title line and one box per seat, shared by the board games.
  function boardFrame(t, title, info, describe) {
    const table = node('div', `game-felt ${t.kind}-felt`);
    const top = node('div', 'game-topline'); top.append(node('b', '', title), node('span', '', info)); table.append(top);
    const wrap = node('div', 'board-wrap'), side = node('div', 'board-side'), seats = node('div', 'board-seats');
    t.seats.forEach((s, i) => {
      const box = node('div', `game-seat${t.turn === s.id && t.phase !== 'finished' ? ' turn' : ''}${!s.alive || s.left ? ' out' : ''}`);
      const line = node('div', 'seat-name'); const [tag, text, color] = describe(s, i);
      const nameTag = node('b', '', `${s.name}${s.id === me ? '（我）' : ''}`); if (color) nameTag.style.setProperty('--seat', color);
      line.append(nameTag, node('small', '', s.left ? '已退出' : tag)); box.append(line, node('p', '', text)); seats.append(box);
    });
    side.append(seats); wrap.append(side); table.append(wrap);
    return { table, wrap, side };
  }
  // ---------------------------------------------------------------- 飞行棋
  // Geometry mirrors server/src/flight.rs: ring square k sits on the border of a
  // 14×14 grid; each colour's home column runs from its side's middle to the centre.
  const planeColors = ['#e05a47', '#e3b12f', '#3f7fd6', '#3fa36b'], colorNames = ['红', '黄', '蓝', '绿'];
  const hangars = [[2, 10], [10, 10], [10, 2], [2, 2]];
  const ringCell = k => k < 13 ? [0, k] : k < 26 ? [k - 13, 13] : k < 39 ? [13, 13 - (k - 26)] : [13 - (k - 39), 0];
  const ringSquare = (color, step) => (13 * color + 8 + step) % 52;
  function planeCell(color, step, k) {
    if (step === 0) return [hangars[color][0] + (k >> 1), hangars[color][1] + (k & 1)];
    if (step <= 50) return ringCell(ringSquare(color, step));
    const d = step - 50;
    return [[d, 6], [6, 13 - d], [13 - d, 7], [7, d]][color];
  }
  function renderFlight(t) {
    const f = t.flight, self = t.seats.findIndex(s => s.id === me);
    const { table, wrap, side } = boardFrame(t, `飞行棋 · ${f.finished ? '已结束' : phases.flight}`, `奖金 ${t.prize} 点`, (s, i) => {
      const p = f.players[i];
      return [`${colorNames[p.color]}方`, `到达终点 ${p.home}/4 · 机库 ${p.planes.filter(v => v === 0).length} 架`, planeColors[p.color]];
    });
    const board = node('div', 'flight-board'), cells = new Map();
    const cell = (r, c, cls) => { const key = `${r},${c}`; if (!cells.has(key)) { const n = node('div', `fl-cell ${cls}`); n.style.gridRow = r + 1; n.style.gridColumn = c + 1; cells.set(key, n); board.append(n); } return cells.get(key); };
    for (let k = 0; k < 52; k++) { const n = cell(...ringCell(k), 'ring'); n.style.setProperty('--tint', planeColors[(k + 2) % 4]); }
    for (const p of f.players) {
      for (let step = 51; step <= 56; step++) { const n = cell(...planeCell(p.color, step, 0), step === 56 ? 'home goal' : 'home'); n.style.setProperty('--tint', planeColors[p.color]); }
      for (let k = 0; k < 4; k++) { const n = cell(...planeCell(p.color, 0, k), 'hangar'); n.style.setProperty('--tint', planeColors[p.color]); }
      const start = cell(...ringCell(ringSquare(p.color, 1)), 'ring'); start.classList.add('start'); start.title = `${colorNames[p.color]}方起飞点`;
      const fly = cell(...ringCell(ringSquare(p.color, 18)), 'ring'); fly.classList.add('fly'); fly.title = `${colorNames[p.color]}方捷径：飞到第 30 格`;
    }
    const movable = t.canAct && online && f.dice != null ? f.movable : [];
    f.players.forEach((p, i) => p.planes.forEach((step, k) => {
      if (p.left) return;
      const target = cell(...planeCell(p.color, step, k), 'ring');
      const go = i === self && movable.includes(k);
      const token = node(go ? 'button' : 'span', `fl-plane${go ? ' movable' : ''}`, String(k + 1));
      token.style.setProperty('--seat', planeColors[p.color]);
      token.title = `${t.seats[i].name} 的 ${k + 1} 号飞机${step === 0 ? ' · 机库' : step === 56 ? ' · 已到终点' : ` · 第 ${step} 格`}`;
      if (go) token.onclick = () => command('move', { plane: k });
      target.append(token);
    }));
    wrap.prepend(board);
    const actions = node('div', 'game-actions');
    if (t.canAct && online) {
      if (f.dice == null) button(actions, '🎲 掷骰子', 'roll', {}, 'primary');
      else { actions.append(node('span', 'dice-face', String(f.dice))); for (const k of f.movable) button(actions, `走 ${k + 1} 号`, 'move', { plane: k }, 'primary'); }
    }
    side.append(actions);
    const self_ = t.seats[self];
    leaveButton(actions, t, self_ && !self_.left && self_.alive && t.phase !== 'finished');
    side.append(node('p', 'game-note', f.note), node('p', 'game-hint', self >= 0 && !f.finished ? (t.canAct ? (f.dice == null ? '轮到你了：先掷骰子' : '点亮的飞机可以走，也可以直接点棋盘上的飞机') : '等待其他玩家，不限时') : ''));
    winnersLine(table, t);
    root.append(table);
  }
  // ---------------------------------------------------------------- 中国象棋
  const pieceNames = { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵', k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒' };
  const XQ = 28, xqAt = n => XQ / 2 + n * XQ;
  // Board lines in a 9×10 grid of XQ px; the river breaks the inner files.
  const xqLines = (() => {
    const d = [];
    for (let r = 0; r < 10; r++) d.push(`M${xqAt(0)} ${xqAt(r)}H${xqAt(8)}`);
    for (let c = 0; c < 9; c++) d.push(c % 8 ? `M${xqAt(c)} ${xqAt(0)}V${xqAt(4)}M${xqAt(c)} ${xqAt(5)}V${xqAt(9)}` : `M${xqAt(c)} ${xqAt(0)}V${xqAt(9)}`);
    for (const [a, b] of [[0, 2], [7, 9]]) d.push(`M${xqAt(3)} ${xqAt(a)}L${xqAt(5)} ${xqAt(b)}M${xqAt(5)} ${xqAt(a)}L${xqAt(3)} ${xqAt(b)}`);
    const w = XQ * 9, h = XQ * 10, y = xqAt(4.5) + 5;
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d.join('')}" stroke="#8a5a2b" stroke-width="1.2" fill="none"/><text x="${xqAt(2)}" y="${y}" text-anchor="middle">楚 河</text><text x="${xqAt(6)}" y="${y}" text-anchor="middle">汉 界</text></svg>`;
  })();
  function renderXiangqi(t) {
    const x = t.xiangqi, self = t.seats.findIndex(s => s.id === me), flip = self === 1;
    const side = ['红方', '黑方'];
    const { table, wrap, side: column } = boardFrame(t, `中国象棋 · ${x.finished ? '已结束' : `${side[x.turn]}走棋${x.check ? ' · 将军！' : ''}`}`, `奖金 ${t.prize} 点 · 第 ${Math.floor(x.plies / 2) + 1} 回合`, (s, i) => {
      const taken = [...(x.captured[i] || '')].map(p => pieceNames[p]).join('');
      return [side[i], taken ? `吃子：${taken}` : '还没有吃子', i ? '#2b2b2b' : '#c8372d'];
    });
    const board = node('div', 'xq-board'); board.innerHTML = xqLines;
    const moves = x.moves || [];
    const targets = picked == null ? [] : moves.filter(m => m[0] === picked).map(m => m[1]);
    const place = (n, s) => { const r = Math.floor(s / 9), c = s % 9; n.style.left = `${(flip ? 8 - c : c) * XQ + 2}px`; n.style.top = `${(flip ? 9 - r : r) * XQ + 2}px`; };
    for (let s = 0; s < 90; s++) {
      const p = x.board[s], target = targets.includes(s), from = moves.some(m => m[0] === s);
      if (p === '.' && !target) continue;
      const n = node(from || target ? 'button' : 'span', `xq-piece${p === '.' ? ' spot' : p === p.toUpperCase() ? ' red' : ' black'}${s === picked ? ' picked' : ''}${target ? ' target' : ''}${x.last?.includes(s) ? ' last' : ''}`, p === '.' ? '' : pieceNames[p]);
      place(n, s);
      if (target) n.onclick = () => command('move', { from: picked, to: s });
      else if (from) n.onclick = () => { picked = picked === s ? null : s; render(); };
      board.append(n);
    }
    if (x.last && x.board[x.last[0]] === '.') { const n = node('span', 'xq-piece spot last'); place(n, x.last[0]); board.append(n); }
    wrap.prepend(board);
    const actions = node('div', 'game-actions'), seated = self >= 0 && !t.seats[self].left && t.phase !== 'finished';
    if (seated) {
      if (x.drawOffer === 1 - self) button(actions, '同意和棋', 'draw', {}, 'primary');
      else { const b = button(actions, x.drawOffer === self ? '已提议和棋' : '提议和棋', 'draw'); b.disabled ||= x.drawOffer === self; }
    }
    leaveButton(actions, t, seated, '认输');
    column.append(actions, node('p', 'game-note', x.note), node('p', 'game-hint', seated ? (t.canAct ? `轮到你（${side[self]}）：先点自己的棋子，再点落点` : '等待对方走棋，不限时') : self < 0 ? '观战中' : ''));
    winnersLine(table, t);
    root.append(table);
  }
  // ---------------------------------------------------------------- 大富翁
  // Square i of the server's 32-square ring on a 9×9 grid: start bottom-right, then clockwise.
  const mpCell = i => i <= 8 ? [8, 8 - i] : i <= 16 ? [8 - (i - 8), 0] : i <= 24 ? [0, i - 16] : [i - 24, 8];
  const ownerColors = ['#e05a47', '#3f7fd6', '#3fa36b', '#d49a1c', '#9b5fc0', '#1fa3a3'];
  const districtColors = ['#d9534f', '#f0ad4e', '#5bc0de', '#5cb85c', '#9370db', '#e377c2', '#a0703c', '#17a2b8', '#b5b520', '#7f8c8d'];
  const squareIcons = { start: '🏁', chance: '❓', tax: '🧾', bonus: '🧧', overtime: '💼', park: '🌳', lottery: '🎰' };
  const REMOTE = 7;
  function renderMonopoly(t) {
    const m = t.monopoly, self = t.seats.findIndex(s => s.id === me), you = m.players[self];
    const who = i => m.players[i].character == null ? '' : `${m.characters[m.players[i].character].emoji}`;
    const { table, wrap, side } = boardFrame(t, `大富翁 · ${m.finished ? '已结束' : m.phase === 'pick' ? '挑选角色' : `第 ${m.round}/${m.rounds} 轮`}`, `奖金 ${t.prize} 点`, (s, i) => {
      const p = m.players[i], c = p.character == null ? null : m.characters[p.character];
      const tag = p.broke ? '破产' : c ? `${c.emoji} ${c.name}` : m.phase === 'pick' ? '选角中' : '';
      return [tag, m.phase === 'pick' ? (c ? c.skill : '还没选角色') : `现金 ${p.cash} · 总资产 ${p.assets}${p.skip ? ' · 加班中' : ''}`, ownerColors[i]];
    });
    const actions = node('div', 'game-actions');
    if (m.phase === 'pick') {
      const grid = node('div', 'mp-characters');
      m.characters.forEach((c, k) => {
        const owner = m.players.findIndex(p => p.character === k && !p.left);
        const b = node('button', `mp-character${owner >= 0 ? ' taken' : ''}`);
        b.append(node('span', 'mp-emoji', c.emoji), node('b', '', c.name), node('small', '', c.skill), node('em', '', owner >= 0 ? `${t.seats[owner].name} 已选` : ''));
        b.disabled = owner >= 0 || !t.canAct || busy || !online;
        b.onclick = () => command('pick', { character: k });
        grid.append(b);
      });
      wrap.prepend(grid);
    } else {
      const board = node('div', 'mp-board');
      m.tiles.forEach((tile, i) => {
        const [r, c] = mpCell(i), n = node('div', `mp-tile ${tile.kind}${m.pending?.tile === i ? ' pending' : ''}`);
        n.style.gridRow = r + 1; n.style.gridColumn = c + 1;
        if (tile.kind === 'lot') {
          n.style.setProperty('--district', districtColors[tile.district % districtColors.length]);
          if (tile.owner != null) { n.classList.add('owned'); n.style.setProperty('--owner', ownerColors[tile.owner]); }
          n.append(node('b', '', tile.name), node('small', '', tile.owner == null ? `${tile.price}` : `${'★'.repeat(tile.level) || '地'}${tile.rent}`));
          n.title = `${tile.name} · 地价 ${tile.price}${tile.owner == null ? ' · 无主' : ` · ${t.seats[tile.owner].name} 的 ${tile.level} 级房 · 过路费 ${tile.rent}`}`;
        } else { n.append(node('span', 'mp-icon', squareIcons[tile.kind]), node('b', '', tile.name)); n.title = tile.name; }
        const here = m.players.map((p, j) => (!p.broke && !p.left && p.pos === i ? who(j) || '●' : '')).join('');
        if (here) n.append(node('span', 'mp-tokens', here));
        board.append(n);
      });
      const center = node('div', 'mp-center');
      if (m.dice?.length) center.append(node('div', 'mp-dice', m.dice.map(d => `🎲${d}`).join(' ')));
      if (t.canAct && online && m.phase === 'roll') {
        button(actions, '🎲 掷骰子', 'roll', {}, 'primary');
        if (you?.character === REMOTE && you.cooldown === 0) {
          const steps = node('select'); for (let n = 2; n <= 12; n++) steps.append(new Option(`${n} 点`, n)); steps.value = '7'; steps.setAttribute('aria-label', '遥控点数');
          actions.append(steps); button(actions, '🎮 遥控', 'roll', () => ({ steps: Number(steps.value) }));
        }
      } else if (t.canAct && online && m.pending) {
        const tile = m.tiles[m.pending.tile];
        button(actions, `${m.pending.kind === 'buy' ? '买下' : '升级'}「${tile.name}」· ${m.pending.cost}`, m.pending.kind, {}, 'primary');
        button(actions, '放弃', 'skip');
      }
      center.append(actions);
      const log = node('ol', 'mp-log'); for (const line of (m.log || []).slice(-6)) log.append(node('li', '', line)); center.append(log);
      board.append(center);
      wrap.prepend(board);
    }
    const self_ = t.seats[self];
    const leave = node('div', 'game-actions'); leaveButton(leave, t, self_ && !self_.left && self_.alive && t.phase !== 'finished');
    if (m.phase === 'pick') side.append(actions);
    side.append(leave, node('p', 'game-hint', you && !m.finished ? (t.canAct ? (m.phase === 'pick' ? '轮到你挑角色' : '轮到你了') : '等待其他玩家，不限时') : ''));
    if (you?.character === REMOTE && m.phase !== 'pick' && you.cooldown > 0) side.append(node('p', 'game-hint', `遥控骰子冷却中：还要 ${you.cooldown} 次普通掷骰`));
    winnersLine(table, t);
    root.append(table);
  }
  // ---------------------------------------------------------------- 四川麻将
  function tileName(tile) {const k=Math.floor(tile/4);return `${['一','二','三','四','五','六','七','八','九'][k%9]}${['万','筒','条'][Math.floor(k/9)]}`;}
  function tile(id,selectable=false,multiple=false,small=false) {
    const valid=Number.isInteger(id)&&id>=0&&id<108;
    const n=node(selectable?'button':'span',`mahjong-tile${small?' small':''}${valid?` suit-${Math.floor(id/36)}`:' back'}`,valid?tileName(id):'▥');
    if(valid)n.title=tileName(id);
    if(selectable){n.setAttribute('aria-pressed',String(selection.has(id)));n.classList.toggle('selected',selection.has(id));n.onclick=()=>{const selected=selection.has(id);if(!multiple)selection.clear();if(selected)selection.delete(id);else selection.add(id);render();};}
    return n;
  }
  function renderMahjong(t) {
    const m=t.mahjong, selfIndex=t.seats.findIndex(s=>s.id===me), myself=m.players[selfIndex];
    const table=node('div','game-felt mahjong-felt');
    const line=node('div','game-topline');line.append(node('b','',`四川血战 · ${({exchange:'换三张',que:'定缺',discard:'摸牌出牌',response:'等待回应',finished:'本局结束'})[m.phase]||'进行中'}`),node('span','',`牌墙 ${m.wall} 张 · 总奖金 1600 点`));table.append(line);
    const seats=node('div','game-seats mahjong-seats');
    for(let i=0;i<t.seats.length;i++){
      const s=t.seats[i],p=m.players[i];const box=node('div',`game-seat${m.phase==='discard'&&m.turn===i?' turn':''}${p.left?' out':''}`);
      const label=node('div','seat-name');label.append(node('b','',`${s.name}${i===selfIndex?'（我）':''}`),node('small','',p.left?'已弃权':p.won?`第 ${p.rank} 胡`:`缺${p.missing==null?'待定':['万','筒','条'][p.missing]}`));box.append(label);
      box.append(node('p','',p.won||m.finished?`${m.finished?'获得':'预计'} ${p.payout} 点${!m.finished?' · 观战中':''}`:m.phase==='exchange'?(p.exchanged?'已提交换牌':'选择三张同花色'): `手牌 ${p.count} 张`));
      if(p.melds?.length){const row=node('div','mahjong-melds');for(const meld of p.melds){const group=node('span','mahjong-meld');for(let k=0;k<meld.count;k++)group.append(tile(meld.tiles?.[k],false,false,true));row.append(group);}box.append(row);}
      if(p.river?.length){const details=node('details','mahjong-river');details.append(node('summary','',`弃牌 ${p.river.length} 张（展开）`));const row=node('div','mahjong-tiles');for(const id of p.river)row.append(tile(id,false,false,true));details.append(row);box.append(details);}
      if((p.won||m.finished)&&p.hand&&i!==selfIndex){const row=node('div','mahjong-tiles');for(const id of p.hand)row.append(tile(id,false,false,true));if(p.winTile!=null)row.append(tile(p.winTile,false,false,true));box.append(row);}
      seats.append(box);
    }
    table.append(seats);
    if(m.claim){const claim=node('div','game-board');claim.append(node('small','',`${t.seats[m.claim.source]?.name||''}${m.claim.rob?'补杠，等待抢杠胡':'打出'}`),tile(m.claim.tile));table.append(claim);}
    table.append(handLabel(myself?myself.won?'已胡牌，等待整局结算':'我的手牌':'观战中 · 仅显示公开牌',t));
    if(myself?.hand){const hand=node('div','game-hand');for(const id of myself.hand)hand.append(tile(id,online&&t.canAct&&['exchange','discard'].includes(m.phase),m.phase==='exchange'));if(myself.winTile!=null)hand.append(tile(myself.winTile));table.append(hand);}
    const actions=node('div','game-actions');
    if(t.canAct&&online){
      if(m.actions.includes('exchange'))button(actions,'交换选中的三张','exchange',()=>({tiles:[...selection]}),'primary');
      if(m.actions.includes('que'))for(let s=0;s<3;s++)button(actions,`定缺${['万','筒','条'][s]}`,'que',{suit:s},'primary');
      if(m.actions.includes('discard'))button(actions,'打出选中的牌','discard',()=>({tile:[...selection][0]}),'primary');
      for(const op of ['hu','peng','gang','pass'])if(m.actions.includes(op))button(actions,({hu:'胡牌',peng:'碰',gang:'杠',pass:'过'})[op],op,{},op==='hu'?'primary':'');
      for(const k of m.gangs||[])button(actions,`杠${tileName(k*4)}`,'gang',{tileKind:k});
    }
    leaveButton(actions,t,myself&&!myself.left&&!myself.won&&!m.finished);
    table.append(actions,node('p','game-note',m.note));
    table.append(node('p','game-rule','顺位奖金：700 / 550 / 350 / 0。流局未胡者依听牌、未听、花猪排序；同名次平分相应奖金，不另扣点数。'));
    root.append(table);
  }
  function receive(next) {
    if(state?.table?.id!==next?.table?.id){selection.clear();creating=false;picked=null;}
    if (state?.table?.round !== next?.table?.round || state?.table?.kind !== next?.table?.kind || state?.table?.mahjong?.phase!==next?.table?.mahjong?.phase) selection.clear();
    if (state?.table?.xiangqi?.plies !== next?.table?.xiangqi?.plies) picked = null;
    state = next;
    const index=state?.table?.seats?.findIndex(s=>s.id===me);
    const hand = state?.table?.mahjong?.players?.[index]?.hand || mine()?.cards || []; selection = new Set([...selection].filter(c => hand.includes(c)));
    render();
  }
  dock.onclick = () => toggleTable(state?.act?.id || state?.table?.id);
  if (roomSummary) roomSummary.onclick = openTable;
  window.addEventListener('friend-cards-rendered', () => {refreshPresence();positionPanel();});
  if (stage) new ResizeObserver(positionPanel).observe(stage);
  api.on('games', receive);
  function walletChanged(w) {const crossed=(wallet<500)!==(w.count<500);wallet=w.count;const n=root.querySelector('.game-head small');if(n)n.textContent=`可用点数 ${wallet.toLocaleString()} · 每人门票 500 点`;if(crossed)render();}
  api.on('wallet', walletChanged);
  api.on('local', walletChanged);
  api.on('net-status', s => { online=s.state==='online';if(!online)supported=false;render(); });
  api.on('games-online', value => {supported=value;render();});
  api.on('game-error', text => {message=text;confirmLeave=false;render();});
  api.init().then(d => {me=d.me.id;wallet=d.wallet.count;online=d.net.state==='online';supported=d.gamesSupported;receive(d.game);});
})();
