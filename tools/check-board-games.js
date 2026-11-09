'use strict';
// Renders 飞行棋 / 象棋 / 大富翁 from real relay snapshots in the actual pet window
// layout (910x720), checks the controls, and saves screenshots to tmp/board-games-qa/.
// Build first: cargo build -p cofisher-server
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url'), { spawn } = require('child_process');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'tmp', 'board-games-qa');
fs.mkdirSync(out, { recursive: true });
const url = p => pathToFileURL(path.join(root, p)).href;
const BIN = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'cofisher-relay.exe' : 'cofisher-relay');
const delay = ms => new Promise(r => setTimeout(r, ms));

function relay() {
  const proc = spawn(BIN, ['--port', '0', '--host', '127.0.0.1']);
  return new Promise((resolve, reject) => {
    let text = '';
    proc.stdout.on('data', d => { text += d; const m = text.match(/listening on (\d+)/); if (m) resolve({ port: Number(m[1]), proc }); });
    proc.on('error', reject);
  });
}
function client(port, id, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), inbox = [];
  ws.on('message', d => inbox.push(JSON.parse(d.toString())));
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 2, id, name, inv: {}, count: 3000, char: 'kimi', secret: `secret-of-${id}` })));
  const last = () => inbox.filter(m => m.t === 'gameState').at(-1);
  const until = async (pred, ms = 3000) => { for (let i = 0; i < ms / 20; i++) { const s = last(); if (s && pred(s)) return s; await delay(20); } throw Error(`timeout: ${id}`); };
  const send = (op, extra = {}) => { const s = last(); ws.send(JSON.stringify({ t: 'game', op, epoch: s.epoch, revision: s.tableRevision, tableId: s.table?.id, ...extra })); };
  return { id, ws, inbox, last, until, send };
}
// One move for whoever is due: keeps every game moving the way a player would.
async function step(players, pick) {
  for (const p of players) {
    const s = p.last(), t = s?.table;
    if (!t?.canAct) continue;
    const rev = s.tableRevision;
    pick(p, t);
    await p.until(n => n.tableRevision !== rev);
    return;
  }
  await delay(50);
}

async function snapshots() {
  const { port, proc } = await relay();
  try {
    const ps = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k, i) => client(port, `player-qa-${k}`, ['红方小明', '黑方阿强', '飞行员一', '飞行员二', '飞行员三', '大富翁甲', '大富翁乙', '大富翁丙'][i]));
    await Promise.all(ps.map(p => p.until(() => true)));
    const ticket = n => String(n).padStart(32, '0');
    async function table(group, kind, first) {
      group[0].send('join', { kind, create: true, tableId: null, ticket: ticket(first), count: 3000 });
      const key = (await group[0].until(s => s.table?.kind === kind)).table.id;
      for (let i = 1; i < group.length; i++) { group[i].send('join', { kind, tableId: key, ticket: ticket(first + i), count: 3000 }); await group[i].until(s => s.table?.seats.some(x => x.id === group[i].id)); }
      group[0].send('start'); for (const p of group) await p.until(s => s.table?.phase === kind);
    }
    const [xq, fl, mp] = [ps.slice(0, 2), ps.slice(2, 5), ps.slice(5, 8)];
    await table(xq, 'xiangqi', 10); await table(fl, 'flight', 20); await table(mp, 'monopoly', 30);
    const result = { monopolyPick: { me: mp[0].id, state: mp[0].last() } };
    // 象棋: central cannon for red, horse for black, then red to move again.
    xq[0].send('move', { from: 64, to: 67 }); await xq[1].until(s => s.table.xiangqi.turn === 1);
    xq[1].send('move', { from: 1, to: 20 }); await xq[0].until(s => s.table.xiangqi.turn === 0);
    result.xiangqi = { me: xq[0].id, state: xq[0].last() };
    result.xiangqiBlack = { me: xq[1].id, state: xq[1].last() };
    // A spectator watches the same game and drops a mark through the relay.
    const fan = client(port, 'player-qa-i', '围观群众'), xqKey = xq[0].last().table.id;
    await fan.until(() => true); fan.send('watch', { tableId: xqKey }); await fan.until(s => s.table?.id === xqKey && s.table.phase === 'xiangqi');
    fan.send('mark', { tableId: xqKey, square: 40 });
    let mark; for (let i = 0; i < 100 && !mark; i++) { mark = xq[0].inbox.find(m => m.t === 'gameMark'); await delay(20); }
    if (!mark) throw Error('no gameMark through the relay');
    result.xiangqiWatcher = { me: fan.id, state: fan.last(), mark };
    ps.push(fan);
    // 飞行棋: roll until a few planes are out, then stop on someone's turn.
    for (let i = 0; i < 60 && fl.every(p => p.last().table.flight.players.flatMap(x => x.planes).filter(v => v > 0).length < 5); i++) {
      await step(fl, (p, t) => (t.flight.dice == null ? p.send('roll') : p.send('move', { plane: t.flight.movable[0] })));
    }
    const flyer = fl.find(p => p.last().table.canAct) || fl[0];
    result.flight = { me: flyer.id, state: flyer.last() };
    // 大富翁: everyone picks, then a dozen turns, buying whatever they land on.
    for (const [i, p] of mp.entries()) { p.send('pick', { character: [7, 2, 4][i] }); await p.until(s => s.table.monopoly.players[i].character != null); }
    for (let i = 0; i < 24; i++) await step(mp, (p, t) => p.send(t.monopoly.pending ? t.monopoly.pending.kind : 'roll'));
    const owner = mp.find(p => p.last().table.canAct) || mp[0];
    result.monopoly = { me: owner.id, state: owner.last() };
    for (const [name, group, square] of [['flightWatcher', fl, 101], ['monopolyWatcher', mp, 20]]) {
      const key = group[0].last().table.id, seen = group[0].inbox.length;
      fan.send('watch', { tableId: key }); await fan.until(s => s.table?.id === key);
      fan.send('mark', { tableId: key, square });
      let mark; for (let i = 0; i < 100 && !mark; i++) { mark = group[0].inbox.slice(seen).find(m => m.t === 'gameMark'); await delay(20); }
      if (!mark) throw Error(`no gameMark on ${name}`);
      result[name] = { me: fan.id, state: fan.last(), mark };
    }
    for (const p of ps) p.ws.close();
    return result;
  } finally { proc.kill(); }
}

const petHtml = fs.readFileSync(path.join(root, 'ui/pet.html'), 'utf8');
const stage = petHtml.slice(petHtml.indexOf('  <div id="stage">'), petHtml.indexOf('  <div id="toast">'));
// Page checks per scenario; each sets document.body.dataset.qa.
const checks = {
  xiangqiWatcher: `const xb=document.querySelector('.xq-board');check(xb.parentElement.classList.contains('markable'),'spectator can mark');check(document.querySelector('.game-hint').textContent.includes('标记'),'mark hint');
    check(!document.querySelector('button.xq-piece'),'spectator cannot move pieces');
    const box=xb.getBoundingClientRect();xb.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:box.left+129,clientY:box.top+122}));await wait();
    check(api.calls.at(-1)?.op==='mark'&&api.calls.at(-1).square===40&&api.calls.at(-1).tableId===current.table.id,'click marks the nearest point');
    emit('game-mark',realMark);await wait();const first=document.querySelector('.board-mark');check(document.querySelectorAll('.board-mark').length===1,'relay mark drawn');
    check(first.textContent===realMark.name&&realMark.name==='围观群众','spectator name on the mark');check(first.style.left==='126px'&&first.style.top==='126px','mark sits on its point');
    await new Promise(r=>setTimeout(r,2600));check(!document.querySelector('.board-mark'),'mark gone after about 2 s');
    for(let i=0;i<6;i++)emit('game-mark',{...realMark,square:20+i,seq:100+i});
    emit('game-mark',{...realMark,by:'player-qa-x',name:'路人乙',square:66,seq:200});await wait();
    const squares=[...document.querySelectorAll('.board-mark')].map(n=>Number(n.dataset.square));
    check(squares.length===6&&!squares.includes(20)&&squares.includes(25)&&squares.includes(66),'five per spectator, the sixth drops the first: '+squares);
    emit('games',current);await wait();check(document.querySelectorAll('.board-mark').length===6,'marks survive a re-render');
    check(parseFloat(document.querySelector('.board-mark').style.getPropertyValue('--age'))>0,'re-rendered marks resume their animation');
    await new Promise(r=>setTimeout(r,650));`,
  xiangqi: `check(document.querySelectorAll('.xq-piece.red').length===16&&document.querySelectorAll('.xq-piece.black').length===16,'32 pieces');
    const own=[...document.querySelectorAll('button.xq-piece.red')];check(own.length>5,'red movable pieces');
    own.find(b=>b.textContent==='车').click();await wait();const target=document.querySelector('.xq-piece.target');check(target,'targets after picking');
    target.click();await wait();check(api.calls.at(-1)?.op==='move'&&Number.isInteger(api.calls.at(-1).from),'move command');
    check([...document.querySelectorAll('.game-actions button')].some(b=>b.textContent==='提议和棋'),'draw offer');visible('.surrender');`,
  flightWatcher: `check(document.querySelector('.mark-host').classList.contains('markable'),'spectator can mark');
    emit('game-mark',realMark);await wait();const pin=document.querySelector('.board-mark');check(pin&&pin.textContent===realMark.name,'relay mark with name');
    check(pin.style.left===(2+3*20+10)+'px'&&pin.style.top===(2+7*20+10)+'px','mark centred on cell 101 (row 7, column 3)');
    await new Promise(r=>setTimeout(r,500));`,
  monopolyWatcher: `const host=document.querySelector('.mark-host');check(host.classList.contains('markable'),'spectator can mark');
    emit('game-mark',realMark);await wait();const pin=document.querySelector('.board-mark'),tile=document.querySelector('.mp-tile[data-tile="20"]').getBoundingClientRect(),at=pin.getBoundingClientRect();
    check(pin.textContent===realMark.name&&Math.abs(at.left-(tile.left+tile.width/2))<1&&Math.abs(at.top-(tile.top+tile.height/2))<1,'mark sits on square 20');
    check(pin.parentElement===host&&getComputedStyle(host).overflow==='visible'&&pin.querySelector('.board-mark-name').getBoundingClientRect().top<document.querySelector('.mp-board').getBoundingClientRect().top,'top-row label floats above the board, unclipped');
    await new Promise(r=>setTimeout(r,500));`,
  xiangqiBlack: `const generals=[...document.querySelectorAll('.xq-piece')].filter(n=>n.textContent==='将');check(generals.length===1,'black general');
    check(generals[0].getBoundingClientRect().top>document.querySelector('.xq-board').getBoundingClientRect().top+140,'black sees own side at the bottom');
    check(!document.querySelector('button.xq-piece.red'),'cannot move red');`,
  flight: `check(document.querySelectorAll('.fl-cell.ring').length===52,'52 ring squares');check(document.querySelectorAll('.fl-plane').length===12,'12 planes');
    check(document.querySelectorAll('.fl-cell.goal').length===3,'three goals');visible('.flight-felt .game-actions button');
    const host=document.querySelector('.mark-host');check(host.classList.contains('markable'),'players mark 飞行棋 too');check([...document.querySelectorAll('.game-hint')].some(n=>n.textContent.includes('标记')),'mark hint');
    const hb=host.getBoundingClientRect();host.querySelector('.flight-board').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:hb.left+2+10*20+10,clientY:hb.top+2+7*20+10}));await wait();
    check(api.calls.at(-1)?.op==='mark'&&api.calls.at(-1).square===7*14+10,'click marks the cell under it');
    emit('games',{...current,table:{...current.table,canAct:true,flight:{...current.table.flight,dice:6,movable:[0,1,2,3]}}});await wait();
    const calls=api.calls.length,plane=document.querySelector('button.fl-plane.movable');check(plane,'movable plane');plane.click();await wait();
    check(api.calls.length===calls+1&&api.calls.at(-1).op==='move','a plane click moves and never marks');emit('games',current);await wait();`,
  monopolyPick: `check(document.querySelectorAll('.mp-character').length===8,'eight characters');check(document.querySelectorAll('.mp-character:not(:disabled)').length===8,'all pickable');
    document.querySelector('.mp-character').click();await wait();check(api.calls.at(-1)?.op==='pick'&&api.calls.at(-1).character===0,'pick command');`,
  monopoly: `check(document.querySelectorAll('.mp-tile').length===32,'32 squares');check(document.querySelectorAll('.mp-tile.lot').length===20,'20 lots');
    check(document.querySelector('.mp-log li'),'event log');check(document.querySelector('.mp-tokens'),'tokens');visible('.mp-center .game-actions button');
    check(document.querySelector('.mark-host').classList.contains('markable'),'players mark 大富翁 too');
    document.querySelector('.mp-tile[data-tile="5"] b').click();await wait();check(api.calls.at(-1)?.op==='mark'&&api.calls.at(-1).square===5,'click marks the square');
    let calls=api.calls.length;document.querySelector('.mp-log').click();await wait();check(api.calls.length===calls,'the centre panel is not a square');
    const go=document.querySelector('.mp-center .game-actions button');go.click();await wait();check(api.calls.length===calls+1&&api.calls.at(-1).op!=='mark','a game button never marks');`,
};
function page(name, scenario) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="${url('ui/pet.css')}"><link rel="stylesheet" href="${url('ui/games.css')}"><body style="background:#e7ece6"><div id="root"><div id="panel" class="hit games-panel"><div class="tabs"><button data-tab="room">房间</button><button data-tab="games" class="active">小游戏</button><button>角色</button><button>道具</button><button>装扮</button><button>日历</button><button id="closePanel">✕</button></div><section><div id="gamesRoot"></div></section><section class="hidden"><button id="roomGameSummary" class="hidden"></button></section></div>${stage}</div>
<script>
const errors=[],listeners={};onerror=m=>errors.push(m);const current=${JSON.stringify(scenario.state)},realMark=${JSON.stringify(scenario.mark || null)};const emit=(c,v)=>(listeners[c]||[]).forEach(f=>f(v));
window.api={calls:[],on:(c,f)=>(listeners[c]??=[]).push(f),init:()=>Promise.resolve({me:{id:${JSON.stringify(scenario.me)}},wallet:{count:2500},net:{state:'online'},gamesSupported:true,game:current}),gameCommand:async a=>{api.calls.push(a);return {ok:true}}};
document.querySelector('#myImg').src=${JSON.stringify(url('ui/assets/characters/claude/idle.png'))};document.querySelector('#myName').textContent='me';
</script><script src="${url('ui/games.js')}"></script><script>
setTimeout(async()=>{try{
const check=(ok,m)=>{if(!ok)throw Error(m)},wait=()=>new Promise(r=>setTimeout(r,40));
const visible=sel=>{const n=document.querySelector(sel);check(n,'missing '+sel);n.scrollIntoView({block:'nearest'});const a=n.getBoundingClientRect(),p=document.querySelector('#panel').getBoundingClientRect();check(a.bottom<=p.bottom+1&&a.top>=p.top-1,sel+' reachable inside the panel');};
check(!errors.length,errors.join(';'));check(!document.querySelector('.game-timer'),'no countdown');
const panel=document.querySelector('#panel'),revealed=panel.scrollTop,gap=document.querySelector('.game-felt').getBoundingClientRect().top-panel.getBoundingClientRect().top-document.querySelector('.tabs').getBoundingClientRect().height;
const board=document.querySelector('.xq-board,.flight-board,.mp-board,.mp-characters').getBoundingClientRect(),inner=panel.getBoundingClientRect();
check(revealed>0&&gap>=2&&board.bottom<=inner.bottom+1,'whole board scrolled into view: '+[revealed,gap,board.bottom,inner.bottom].join(' / '));
${checks[name]}
check(document.querySelector('#panel').scrollWidth<=document.querySelector('#panel').clientWidth+1,'no horizontal overflow');
check(!errors.length,errors.join(';'));panel.scrollTop=revealed;document.body.dataset.qa='passed';
}catch(e){document.body.dataset.qa='failed:'+e.message}},200);
</script></body></html>`;
  const file = path.join(out, `${name}.html`);
  fs.writeFileSync(file, html);
  return file;
}

(async () => {
  const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  if (!browser) throw Error('No browser for UI check');
  const scenarios = await snapshots();
  const profile = path.join(out, `browser-profile-${process.pid}`); fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let ws; const pending = new Map(); let nextId = 0;
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const failures = [];
  try {
    const active = path.join(profile, 'DevToolsActivePort'); for (let i = 0; i < 100 && !fs.existsSync(active); i++) await delay(50); if (!fs.existsSync(active)) throw Error('Browser did not start');
    const port = fs.readFileSync(active, 'utf8').split('\n')[0], version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', data => { const r = JSON.parse(data); const request = pending.get(r.id); if (request) { pending.delete(r.id); clearTimeout(request.timer); r.error ? request.reject(Error(r.error.message)) : request.resolve(r.result); } });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' }); const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    await call('Page.enable', {}, sessionId); await call('Emulation.setDeviceMetricsOverride', { width: 910, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
    for (const [name, scenario] of Object.entries(scenarios)) {
      await call('Page.navigate', { url: pathToFileURL(page(name, scenario)).href }, sessionId);
      let qa = ''; for (let i = 0; i < 60 && !qa; i++) { await delay(100); const r = await call('Runtime.evaluate', { expression: 'document.body?.dataset.qa || ""', returnByValue: true }, sessionId); qa = r.result.value; }
      const shot = await call('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(shot.data, 'base64'));
      console.log(`${qa === 'passed' ? 'passed' : 'FAILED'} ${name}${qa === 'passed' ? '' : `: ${qa || 'did not finish'}`}`);
      if (qa !== 'passed') failures.push(name);
    }
  } finally { for (const r of pending.values()) clearTimeout(r.timer); ws?.close(); proc.kill(); }
  if (failures.length) throw Error(`board game UI checks failed: ${failures.join(', ')}`);
  console.log(`Screenshots: ${out}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
