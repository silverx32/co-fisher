'use strict';
// Browser checks for the friends-bar toggle (real pet.html + pet.js) and the
// overlay's top-right turn notice. Screenshots go to tmp/pet-extras-qa/.
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url'), { spawn } = require('child_process');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'tmp', 'pet-extras-qa');
fs.mkdirSync(out, { recursive: true });
const url = p => pathToFileURL(path.join(root, p)).href;
const delay = ms => new Promise(r => setTimeout(r, ms));
// Stands in for api.js: records calls; init never resolves, so the page waits for us.
const stub = `<script>window.__events={};window.api=new Proxy({calls:[]},{get:(t,k)=>k in t?t[k]:k==='on'?(c,f)=>(__events[c]??=[]).push(f):k==='init'?()=>new Promise(()=>{}):(...a)=>{t.calls.push([k,...a]);return Promise.resolve({ok:true})}});
const emit=(c,v)=>(__events[c]||[]).forEach(f=>f(v));</script>`;

function petPage() {
  let html = fs.readFileSync(path.join(root, 'ui/pet.html'), 'utf8');
  html = html.replace('<link rel="stylesheet" href="pet.css">', `<link rel="stylesheet" href="${url('ui/pet.css')}">`)
    .replace('<link rel="stylesheet" href="games.css">', `<link rel="stylesheet" href="${url('ui/games.css')}">`)
    .replace('<script src="api.js"></script>', stub)
    .replace('<script src="pet.js"></script>', `<script src="${url('ui/pet.js')}"></script>`)
    .replace('<script src="games.js"></script>', `<script>
setTimeout(async()=>{try{
const check=(ok,m)=>{if(!ok)throw Error(m)};localStorage.removeItem('friendsCollapsed');
S.me={id:'me',name:'me',char:'claude'};S.wallet={count:0,total:0,inv:{}};S.items={tomato:{id:'tomato',name:'番茄',emoji:'🍅',kind:'throw'}};S.serverItems=['tomato'];S.net='online';
S.players=[{id:'me',name:'me',char:'claude',count:1},...['fei','wei','kke'].map((n,i)=>({id:n,name:n,char:['deepseek','gemini','kimi'][i],count:100*i,decos:[]}))];
renderFriends();const toggle=document.querySelector('#friendsToggle'),friends=document.querySelector('#friends');
check(!toggle.classList.contains('hidden')&&toggle.textContent==='收起好友','toggle shown with friends');check(friends.querySelectorAll('.friend').length===3,'three friend cards');
document.body.dataset.qa='passed:expanded';await new Promise(r=>setTimeout(r,600));
toggle.click();check(friends.classList.contains('hidden')&&toggle.textContent==='👥 3','collapsed shows only me');check(localStorage.getItem('friendsCollapsed')==='1','remembered');
S.players.push({id:'zed',name:'zed',char:'codex',count:5,decos:[]});renderFriends();check(friends.classList.contains('hidden')&&toggle.textContent==='👥 4','stays collapsed when someone joins');
const rect=toggle.getBoundingClientRect(),me=document.querySelector('#me').getBoundingClientRect();check(rect.right<=me.left+2&&rect.bottom<=me.bottom,'toggle sits next to me');
document.body.dataset.qa='passed:collapsed';
}catch(e){document.body.dataset.qa='failed:'+e.message}},300);
</script>`);
  html = html.replace('<body>', '<body style="background:#e7ece6">');
  const file = path.join(out, 'pet.html');
  fs.writeFileSync(file, html);
  return file;
}
function overlayPage() {
  let html = fs.readFileSync(path.join(root, 'ui/overlay.html'), 'utf8');
  html = html.replace('<script src="api.js"></script>', stub).replace('<script src="overlay.js"></script>', `<script src="${url('ui/overlay.js')}"></script><script>
document.body.style.background='#d9dee6';
setTimeout(()=>{try{emit('effect',{item:'turn',title:'轮到你了',text:'斗地主 · 2 号桌'});
const n=document.querySelector('.turn-notice').getBoundingClientRect();if(!(n.right>innerWidth-40&&n.top<40))throw Error('notice not top-right');
setTimeout(()=>{document.body.dataset.qa='passed:shown'},700);setTimeout(()=>{document.body.dataset.qa=document.querySelector('.turn-notice')||!api.calls.some(c=>c[0]==='overlayIdle'&&c[1]===1)?'failed:notice did not finish':'passed:gone'},5400);
}catch(e){document.body.dataset.qa='failed:'+e.message}},200);</script>`);
  const file = path.join(out, 'overlay.html');
  fs.writeFileSync(file, html);
  return file;
}

(async () => {
  const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  if (!browser) throw Error('No browser for UI check');
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
    await call('Page.enable', {}, sessionId);
    const qa = async () => (await call('Runtime.evaluate', { expression: 'document.body?.dataset.qa || ""', returnByValue: true }, sessionId)).result.value;
    const shot = async name => fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from((await call('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64'));
    const run = async (name, file, width, height, steps) => {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await call('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
      for (const [want, picture] of steps) {
        let state = ''; for (let i = 0; i < 80 && !state.startsWith(want) && !state.startsWith('failed'); i++) { await delay(100); state = await qa(); }
        if (picture) await shot(picture);
        if (!state.startsWith(want)) { console.log(`FAILED ${name}: ${state || 'did not finish'}`); failures.push(name); return; }
      }
      console.log(`passed ${name}`);
    };
    await run('friends toggle', petPage(), 910, 720, [['passed:expanded', 'friends-expanded'], ['passed:collapsed', 'friends-collapsed']]);
    await run('turn notice', overlayPage(), 1280, 720, [['passed:shown', 'turn-notice'], ['passed:gone', null]]);
  } finally { for (const r of pending.values()) clearTimeout(r.timer); ws?.close(); proc.kill(); }
  if (failures.length) throw Error(`checks failed: ${failures.join(', ')}`);
  console.log(`Screenshots: ${out}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
