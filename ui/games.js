'use strict';
/* global api */
(() => {
  const root = document.querySelector('#gamesRoot');
  const dock = document.querySelector('#gameDock');
  const names = { blackjack: '21 点', holdem: '德州扑克', ddz: '斗地主' };
  const phases = { lobby: '等待报名', blackjack: '要牌 / 停牌', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', bid: '叫地主', play: '出牌', intermission: '下一轮准备中', finished: '已结束' };
  let me = '', online = false, supported = false, wallet = 0, state = null;
  let chosen = 'blackjack', folded = false, busy = false, confirmLeave = false, message = '', deadline = 0;
  let selection = new Set();
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
      const r = await api.gameCommand({ op, revision: state?.revision, ...extra });
      if (!r.ok) message = r.error || '操作失败，请重试';
      else if (op === 'play') selection.clear();
    } catch (_) { message = '未能发送操作，请检查连接'; }
    finally { busy = false; confirmLeave = false; render(); }
  }
  function button(parent, text, op, extra = {}, cls = '') {
    const b = node('button', cls, text); b.disabled = busy || !online || !supported;
    b.onclick = () => command(op, typeof extra === 'function' ? extra() : extra); parent.append(b); return b;
  }
  function updateDock() {
    const t = state?.table;
    dock.classList.toggle('hidden', !t || t.phase === 'finished');
    if (!t) return;
    const myTurn = online && t.canAct;
    dock.classList.toggle('my-turn', myTurn);
    dock.textContent = `${myTurn ? '轮到你了 · ' : ''}${names[t.kind] || '牌桌'} · ${phases[t.phase] || ''}　展开 ↗`;
  }
  function render() {
    root.replaceChildren();
    const t = state?.table;
    const head = node('div', 'game-head');
    const title = node('div'); title.append(node('h3', '', '摸鱼牌桌'), node('small', '', `可用点数 ${wallet.toLocaleString()} · 每人门票 500 点`));
    head.append(title);
    const fold = node('button', '', folded ? '展开牌桌' : '收起牌桌'); fold.onclick = () => { folded = !folded; render(); }; head.append(fold); root.append(head);
    root.append(node('p', 'game-rule', '报名后至少 3 人，由首位报名者开局；斗地主固定 3 人。奖金为总门票的 80%。收起继续游戏，超时自动托管。'));
    if (folded) { root.append(node('div', 'game-folded', `${t ? `${names[t.kind]} · ${phases[t.phase]}` : '还没有牌桌'}。可随时展开，收起不会退票或结束牌局。`)); updateDock(); return; }
    if (!online || !supported) {
      root.append(node('div', 'game-empty', online ? '当前房间版本不支持小游戏，请更新房主或中转服务器。' : '连接房间后，和房间里的朋友一起开桌。断线期间牌局按倒计时托管，重连会恢复。'));
      if (!t || t.phase === 'finished') { updateDock(); return; }
    }
    if (!t || t.phase === 'finished') {
      const choices = node('div', 'game-choices');
      for (const [kind, name] of Object.entries(names)) {
        const b = node('button', `game-choice${kind === chosen ? ' active' : ''}`);
        b.append(node('small', '', kind === 'blackjack' ? '♠ 01' : kind === 'holdem' ? '♣ 02' : '♦ 03'), node('b', '', name), node('span', '', kind === 'ddz' ? '3 人 · 地主 vs 农民' : kind === 'holdem' ? '3–9 人 · 筹码淘汰赛' : '3–16 人 · 最高点数晋级'));
        b.onclick = () => { chosen = kind; render(); }; choices.append(b);
      }
      root.append(choices);
      const join = node('div', 'game-actions'); const b = button(join, `报名${names[chosen]} · 500 点`, 'join', () => ({ kind: chosen }), 'primary'); b.disabled ||= wallet < 500; root.append(join);
      root.append(node('p', 'game-rule', chosen === 'blackjack' ? '无庄家对战：A 算 1 或 11，爆牌或点数较低者淘汰。最高点数平局则继续加赛，直到只剩一人；全部爆牌则重发。' : chosen === 'holdem' ? '每人 1,000 局内筹码，盲注从 10/20 开始、每 8 手提升。支持全下和边池；筹码归零淘汰。局内下注不会额外扣点数。' : '轮流叫地主，支持顺子、连对、飞机、炸弹和王炸。地主赢独得奖金；农民赢由两位农民平分。'));
    }
    if (t) renderTable(t);
    root.append(node('div', 'game-message', message)); updateDock(); countdown();
  }
  function renderTable(t) {
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
      const label = node('div', 'game-hand-label'); label.append(node('span', '', self.alive ? '我的手牌' : '已淘汰，继续观战'), node('span', 'game-timer')); table.append(label);
      const hand = node('div', 'game-hand'); for (const c of self.cards) hand.append(card(c, t.kind === 'ddz' && t.phase === 'play' && t.canAct && online)); table.append(hand);
    } else if (t.phase !== 'lobby' && t.phase !== 'finished') { const label = node('div', 'game-hand-label'); label.append(node('span', '', '观战中 · 仅显示公开牌'), node('span', 'game-timer')); table.append(label); }
    const actions = node('div', 'game-actions');
    if (t.phase === 'lobby') {
      if (!self) { const b = button(actions, `报名 · 500 点（${t.seats.length}/${t.kind === 'ddz' ? 3 : t.kind === 'holdem' ? 9 : 16}）`, 'join', {kind:t.kind}, 'primary'); b.disabled ||= wallet < 500; }
      if (self?.id === t.host) { const b = button(actions, '开始游戏', 'start', {}, 'primary'); b.disabled ||= t.seats.length < 3; }
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
    if (self && !self.left && self.alive && t.phase !== 'finished') {
      const leave = node('button', 'surrender', confirmLeave ? (t.phase === 'lobby' ? '确认退票' : '确认弃权，不退门票') : (t.phase === 'lobby' ? '取消报名 / 退票' : '退出牌局'));
      leave.disabled = busy || !online;
      leave.onclick = () => { if (confirmLeave) command('leave'); else {confirmLeave=true;render();} }; actions.append(leave);
    }
    table.append(actions, node('p', 'game-note', t.note));
    if (t.phase === 'finished') {
      const winners = (t.seats || []).filter(s => t.winners?.includes(s.id));
      table.append(node('div', 'game-winners', winners.length ? `🏆 ${winners.map(s => s.name).join('、')} · ${winners.length > 1 ? '每人 ' : ''}${t.prize / winners.length} 点` : '牌桌已取消'));
    }
    root.append(table);
  }
  function countdown() {
    const n = root.querySelector('.game-timer'); if (!n) return;
    const seconds = Math.max(0,Math.ceil((deadline - Date.now()) / 1000));
    const t = state?.table;
    n.textContent = t?.phase === 'intermission' ? `${seconds} 秒后继续` : ['finished','lobby'].includes(t?.phase) ? '' : `${t?.canAct ? '轮到你' : '等待操作'} · ${seconds} 秒`;
    n.classList.toggle('urgent', seconds <= 8 && t?.canAct);
  }
  function receive(next) {
    if (state?.table?.round !== next?.table?.round || state?.table?.kind !== next?.table?.kind) selection.clear();
    state = next; deadline = Date.now() + (state?.table?.remainingMs || 0);
    const hand = mine()?.cards || []; selection = new Set([...selection].filter(c => hand.includes(c)));
    render();
  }
  dock.onclick = () => { folded=false;document.querySelector('#panel').classList.remove('hidden'); document.querySelector('[data-tab="games"]').click();render(); };
  api.on('games', receive);
  function walletChanged(w) {const crossed=(wallet<500)!==(w.count<500);wallet=w.count;const n=root.querySelector('.game-head small');if(n)n.textContent=`可用点数 ${wallet.toLocaleString()} · 每人门票 500 点`;if(crossed)render();}
  api.on('wallet', walletChanged);
  api.on('local', walletChanged);
  api.on('net-status', s => { online=s.state==='online';if(!online)supported=false;render(); });
  api.on('games-online', value => {supported=value;render();});
  api.on('game-error', text => {message=text;confirmLeave=false;render();});
  api.init().then(d => {me=d.me.id;wallet=d.wallet.count;online=d.net.state==='online';supported=d.gamesSupported;receive(d.game);});
  setInterval(countdown,250);
})();
