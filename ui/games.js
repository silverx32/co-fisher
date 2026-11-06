'use strict';
/* global api */
(() => {
  const root = document.querySelector('#gamesRoot');
  const dock = document.querySelector('#gameDock');
  const roomSummary = document.querySelector('#roomGameSummary');
  const panel = document.querySelector('#panel');
  const stage = document.querySelector('#stage');
  const names = { blackjack: '21 点', holdem: '德州扑克', ddz: '斗地主', mahjong: '四川麻将' };
  const phases = { lobby: '等待报名', blackjack: '要牌 / 停牌', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', bid: '叫地主', play: '出牌', intermission: '下一轮准备中', finished: '已结束', mahjong: '血战中' };
  let me = '', online = false, supported = false, wallet = 0, state = null;
  let chosen = 'blackjack', folded = false, busy = false, confirmLeave = false, message = '', deadline = 0;
  let selection = new Set();
  let creating = false;
  const capacity = kind => ({ddz:3,holdem:9,mahjong:4}[kind] || 16);
  const tables = () => state?.tables || (state?.table && state.table.phase !== 'finished' ? [state.table] : []);
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
      else if (['play','discard','exchange','gang','hu'].includes(op)) selection.clear();
    } catch (_) { message = '未能发送操作，请检查连接'; }
    finally { busy = false; confirmLeave = false; render(); }
  }
  function button(parent, text, op, extra = {}, cls = '') {
    const b = node('button', cls, text); b.disabled = busy || !online || !supported;
    b.onclick = () => command(op, typeof extra === 'function' ? extra() : extra); parent.append(b); return b;
  }
  function updateDock() {
    const t = online && supported && state?.table?.phase !== 'finished' ? state?.table : null;
    const list=online&&supported?tables():[];
    dock.classList.toggle('hidden', !list.length);
    refreshPresence(t);
    if (!t) {if(list.length){dock.textContent=`房间有 ${list.length} 张牌桌 · 点击查看`;dock.title=dock.textContent;}return;}
    const myTurn = online && t.canAct;
    dock.classList.toggle('my-turn', myTurn);
    const status = t.phase === 'lobby' ? `等待报名 ${t.seats.length}/${capacity(t.kind)} 人` : `游戏中 · ${t.seats.filter(s => s.alive && !s.left).length} 人在玩`;
    const label = `${names[t.kind] || '牌桌'}房间${t.number ? ` · ${t.number} 号桌` : ''} · ${status}`;
    dock.textContent = `${list.length>1?`${list.length} 桌 · `:''}${myTurn ? '轮到你 · ' : ''}${label}　查看 ↗`;
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
      element.textContent = seat ? `${t.kind==='mahjong'?'川麻':names[t.kind] || '牌桌'} · ${t.phase === 'lobby' ? '已报名' : seat.alive ? '游戏中' : '观战'}` : '';
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
  function openTable() { folded=false;panel.classList.remove('hidden');document.querySelector('[data-tab="games"]').click();render(); }
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
    root.append(node('p', 'game-rule', '每人 500 点，可分组开多桌；首位报名者开局。斗地主 3 人、川麻 4 人，其余至少 3 人。总奖金为门票的 80%。'));
    if (folded) { root.append(node('div', 'game-folded', `${t ? `${names[t.kind]} · ${phases[t.phase]}` : '还没有牌桌'}。可随时展开，收起不会退票或结束牌局。`)); updateDock(); return; }
    if (!online || !supported) {
      root.append(node('div', 'game-empty', online ? '当前房间版本不支持小游戏，请更新房主或中转服务器。' : '连接房间后，和房间里的朋友一起开桌。断线期间牌局按倒计时托管，重连会恢复。'));
      if (!t || t.phase === 'finished') { updateDock(); return; }
    }
    if(online&&supported){
      const picker=node('div','table-picker');
      for(const table of tables()){const b=node('button',table.id===t?.id?'active':'',`${table.number||''}号桌 · ${names[table.kind]} · ${table.phase==='lobby'?`${table.seats.length}/${capacity(table.kind)}`:'进行中'}`);b.onclick=()=>{creating=false;command('watch',{tableId:table.id});};picker.append(b);}
      const newTable=node('button','new-table',creating?'收起开桌选项':'+ 新开一桌');newTable.onclick=()=>{creating=!creating;render();};picker.append(newTable);root.append(picker);
    }
    if (creating || !t || t.phase === 'finished') {
      const choices = node('div', 'game-choices');
      for (const [kind, name] of Object.entries(names)) {
        const b = node('button', `game-choice${kind === chosen ? ' active' : ''}`);
        b.append(node('small', '', kind === 'blackjack' ? '♠ 01' : kind === 'holdem' ? '♣ 02' : kind==='ddz'?'♦ 03':'🀄 04'), node('b', '', name), node('span', '', kind==='mahjong'?'4 人 · 血战到底':kind === 'ddz' ? '3 人 · 地主 vs 农民' : kind === 'holdem' ? '3–9 人 · 筹码淘汰赛' : '3–16 人 · 最高点数晋级'));
        b.onclick = () => { chosen = kind; render(); }; choices.append(b);
      }
      root.append(choices);
      const join = node('div', 'game-actions'); const b = button(join, `新开${names[chosen]} · 500 点`, 'join', () => ({ kind: chosen,create:true,tableId:null }), 'primary'); b.disabled ||= wallet < 500 || state?.receipt?.final===false; root.append(join);
      root.append(node('p', 'game-rule', chosen==='mahjong'?'四川血战：换三张、定缺、不吃牌、可碰杠，一炮多响。依胡牌顺序分 700 / 550 / 350 / 0 点；同时胡平分相应名次奖金，整局结束统一到账。':chosen === 'blackjack' ? '无庄家对战：A 算 1 或 11，爆牌或点数较低者淘汰。最高点数平局则继续加赛，直到只剩一人；全部爆牌则重发。' : chosen === 'holdem' ? '每人 1,000 局内筹码，盲注从 10/20 开始、每 8 手提升。支持全下和边池；筹码归零淘汰。局内下注不会额外扣点数。' : '轮流叫地主，支持顺子、连对、飞机、炸弹和王炸。地主赢独得奖金；农民赢由两位农民平分。'));
    }
    if (t) renderTable(t);
    root.append(node('div', 'game-message', message)); updateDock(); countdown();
  }
  function renderTable(t) {
    if(t.kind==='mahjong'&&t.mahjong){renderMahjong(t);return;}
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
      if (!self) { const b = button(actions, `报名 · 500 点（${t.seats.length}/${capacity(t.kind)}）`, 'join', {kind:t.kind}, 'primary'); b.disabled ||= wallet < 500 || state?.receipt?.final===false || t.seats.length>=capacity(t.kind); }
      if (self?.id === t.host) { const b = button(actions, '开始游戏', 'start', {}, 'primary'); b.disabled ||= t.seats.length < (t.kind==='mahjong'?4:3); }
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
    const handLabel=node('div','game-hand-label');handLabel.append(node('span','',myself?myself.won?'已胡牌，等待整局结算':'我的手牌':'观战中 · 仅显示公开牌'),node('span','game-timer'));table.append(handLabel);
    if(myself?.hand){const hand=node('div','game-hand');for(const id of myself.hand)hand.append(tile(id,online&&t.canAct&&['exchange','discard'].includes(m.phase),m.phase==='exchange'));if(myself.winTile!=null)hand.append(tile(myself.winTile));table.append(hand);}
    const actions=node('div','game-actions');
    if(t.canAct&&online){
      if(m.actions.includes('exchange'))button(actions,'交换选中的三张','exchange',()=>({tiles:[...selection]}),'primary');
      if(m.actions.includes('que'))for(let s=0;s<3;s++)button(actions,`定缺${['万','筒','条'][s]}`,'que',{suit:s},'primary');
      if(m.actions.includes('discard'))button(actions,'打出选中的牌','discard',()=>({tile:[...selection][0]}),'primary');
      for(const op of ['hu','peng','gang','pass'])if(m.actions.includes(op))button(actions,({hu:'胡牌',peng:'碰',gang:'杠',pass:'过'})[op],op,{},op==='hu'?'primary':'');
      for(const k of m.gangs||[])button(actions,`杠${tileName(k*4)}`,'gang',{tileKind:k});
    }
    if(myself&&!myself.left&&!myself.won&&!m.finished){const leave=node('button','surrender',confirmLeave?'确认弃权，不退门票':'退出牌局');leave.disabled=busy||!online;leave.onclick=()=>{if(confirmLeave)command('leave');else{confirmLeave=true;render();}};actions.append(leave);}
    table.append(actions,node('p','game-note',m.note));
    table.append(node('p','game-rule','顺位奖金：700 / 550 / 350 / 0。流局未胡者依听牌、未听、花猪排序；同名次平分相应奖金，不另扣点数。'));
    root.append(table);
  }
  function receive(next) {
    if(state?.table?.id!==next?.table?.id){selection.clear();creating=false;}
    if (state?.table?.round !== next?.table?.round || state?.table?.kind !== next?.table?.kind || state?.table?.mahjong?.phase!==next?.table?.mahjong?.phase) selection.clear();
    state = next; deadline = Date.now() + (state?.table?.remainingMs || 0);
    const index=state?.table?.seats?.findIndex(s=>s.id===me);
    const hand = state?.table?.mahjong?.players?.[index]?.hand || mine()?.cards || []; selection = new Set([...selection].filter(c => hand.includes(c)));
    render();
  }
  dock.onclick = () => toggleTable(state?.table?.id);
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
  setInterval(countdown,250);
})();
