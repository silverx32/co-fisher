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
  return { id, ws, last, until, send };
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
    for (const p of ps) p.ws.close();
    return result;
  } finally { proc.kill(); }
}

const petHtml = fs.readFileSync(path.join(root, 'ui/pet.html'), 'utf8');
const stage = petHtml.slice(petHtml.indexOf('  <div id="stage">'), petHtml.indexOf('  <div id="toast">'));
// Page checks per scenario; each sets document.body.dataset.qa.
const checks = {
  xiangqi: `check(document.querySelectorAll('.xq-piece.red').length===16&&document.querySelectorAll('.xq-piece.black').length===16,'32 pieces');
    const own=[...document.querySelectorAll('button.xq-piece.red')];check(own.length>5,'red movable pieces');
    own.find(b=>b.textContent==='车').click();await wait();const target=document.querySelector('.xq-piece.target');check(target,'targets after picking');
    target.click();await wait();check(api.calls.at(-1)?.op==='move'&&Number.isInteger(api.calls.at(-1).from),'move command');
    check([...document.querySelectorAll('.game-actions button')].some(b=>b.textContent==='提议和棋'),'draw offer');visible('.surrender');`,
  xiangqiBlack: `const generals=[...document.querySelectorAll('.xq-piece')].filter(n=>n.textContent==='将');check(generals.length===1,'black general');
    check(generals[0].getBoundingClientRect().top>document.querySelector('.xq-board').getBoundingClientRect().top+140,'black sees own side at the bottom');
    check(!document.querySelector('button.xq-piece.red'),'cannot move red');`,
  flight: `check(document.querySelectorAll('.fl-cell.ring').length===52,'52 ring squares');check(document.querySelectorAll('.fl-plane').length===12,'12 planes');
    check(document.querySelectorAll('.fl-cell.goal').length===3,'three goals');visible('.flight-felt .game-actions button');`,
  monopolyPick: `check(document.querySelectorAll('.mp-character').length===8,'eight characters');check(document.querySelectorAll('.mp-character:not(:disabled)').length===8,'all pickable');
    document.querySelector('.mp-character').click();await wait();check(api.calls.at(-1)?.op==='pick'&&api.calls.at(-1).character===0,'pick command');`,
  monopoly: `check(document.querySelectorAll('.mp-tile').length===32,'32 squares');check(document.querySelectorAll('.mp-tile.lot').length===20,'20 lots');
    check(document.querySelector('.mp-log li'),'event log');check(document.querySelector('.mp-tokens'),'tokens');visible('.mp-center .game-actions button');`,
};
function page(name, scenario) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="${url('ui/pet.css')}"><link rel="stylesheet" href="${url('ui/games.css')}"><body style="background:#e7ece6"><div id="root"><div id="panel" class="hit games-panel"><div class="tabs"><button data-tab="room">房间</button><button data-tab="games" class="active">小游戏</button><button>角色</button><button>道具</button><button>装扮</button><button>日历</button><button id="closePanel">✕</button></div><section><div id="gamesRoot"></div></section><section class="hidden"><button id="roomGameSummary" class="hidden"></button></section></div>${stage}</div>
<script>
const errors=[],listeners={};onerror=m=>errors.push(m);const current=${JSON.stringify(scenario.state)};
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
