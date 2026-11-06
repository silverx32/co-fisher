'use strict';
// Real stage markup, isolated saves and mocked room events for layout regression.
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'tmp','games-layout-qa');fs.mkdirSync(out,{recursive:true});
const url=p=>pathToFileURL(path.join(root,p)).href;
const first={id:'desk-one',number:1,kind:'ddz',phase:'play',round:1,turn:'a',host:'a',prize:1200,pot:1500,landlord:'a',bottom:[11,24,52],last:[],canAct:true,note:'选择手牌后出牌；点击角色状态可收起。',remainingMs:30000,seats:[
  {id:'a',name:'buyan',alive:true,left:false,count:20,cards:[1,14,27,2,15,3,16,4,17,5,18,6,19,7,8,9,10,11,24,52]},
  {id:'b',name:'fei',alive:true,left:false,count:17,cards:null},{id:'d',name:'HC',alive:true,left:false,count:17,cards:null}]};
const second={id:'desk-two',number:2,kind:'mahjong',phase:'mahjong',round:1,turn:'c',host:'c',prize:1600,pot:2000,canAct:false,note:'其他桌正在四川血战。',remainingMs:30000,seats:['c','e','f','g'].map((id,i)=>({id,name:['wei','kke','朋友F','朋友G'][i],alive:true,left:false})),mahjong:{phase:'exchange',wall:55,turn:0,actions:[],gangs:[],finished:false,note:'选择三张同花色的手牌。',players:[0,1,2,3].map(()=>({count:13,hand:null,missing:null,won:false,left:false,exchanged:false,river:[],melds:[],payout:0}))}};
const summary=t=>({id:t.id,number:t.number,kind:t.kind,phase:t.phase,seats:t.seats.map(({id,name,alive,left})=>({id,name,alive,left}))});
const initial={epoch:'preview',revision:7,tableRevision:7,table:first,tables:[summary(first),summary(second)]};
const petHtml=fs.readFileSync(path.join(root,'ui/pet.html'),'utf8');
const stage=petHtml.slice(petHtml.indexOf('  <div id="stage">'),petHtml.indexOf('  <div id="toast">'));
const friends=['b','c','e','d'].map((id,i)=>`<div class="friend hit" data-player-id="${id}"><span class="fchest">🎁</span><div class="avatar"><img class="fimg" src="${url(`ui/assets/characters/${['deepseek','gemini','kimi','codex'][i]}/idle.png`)}"></div><div class="fcount">⌨ ${[3608,6827,5279,1242][i]}</div><div class="fname">${['fei','wei','kke','HC'][i]}</div><button class="player-game-status fgame hidden"></button><div class="factions"><button class="fbtn">🍅<small>3</small></button><button class="fbtn">🦑<small>14</small></button><button class="fbtn">💩<small>5</small></button></div></div>`).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="${url('ui/pet.css')}"><link rel="stylesheet" href="${url('ui/games.css')}"><body style="background:#e7ece6"><div id="root"><div id="panel" class="hit games-panel"><div class="tabs"><button data-tab="room">房间</button><button data-tab="games" class="active">小游戏</button><button>角色</button><button>道具</button><button>装扮</button><button>日历</button><button id="closePanel">✕</button></div><section><div id="gamesRoot"></div></section><section class="hidden"><button id="roomGameSummary" class="hidden"></button></section></div>${stage}</div>
<script>
const errors=[],listeners={},first=${JSON.stringify(first)},second=${JSON.stringify(second)};let current=${JSON.stringify(initial)};onerror=m=>errors.push(m);
const emit=(c,v)=>(listeners[c]||[]).forEach(fn=>fn(v));window.api={calls:[],on:(c,f)=>(listeners[c]??=[]).push(f),init:()=>Promise.resolve({me:{id:'a'},wallet:{count:1726},net:{state:'online'},gamesSupported:true,game:current}),gameCommand:async a=>{api.calls.push(a);if(a.op==='watch'){current={...current,table:a.tableId===first.id?first:second};emit('games',current);}return {ok:true}}};
document.querySelector('#closePanel').onclick=()=>document.querySelector('#panel').classList.add('hidden');document.querySelector('#friends').innerHTML=${JSON.stringify(friends)};document.querySelector('#myImg').src=${JSON.stringify(url('ui/assets/characters/claude/idle.png'))};document.querySelector('#myName').textContent='buyan';document.querySelector('#myCount').textContent='1726';document.querySelector('#myChest').classList.remove('hidden');document.querySelector('#myChest').textContent='🎁 -3000';document.querySelector('#boss').classList.remove('hidden');document.querySelector('#bossEmoji').textContent='⏰';document.querySelector('#bossName').textContent='下一只：Deadline 怪';document.querySelector('#bossHp').textContent='12:38 后出现';
</script><script src="${url('ui/games.js')}"></script><script>
setTimeout(async()=>{try{
const check=(ok,m)=>{if(!ok)throw Error(m)},wait=()=>new Promise(r=>setTimeout(r,40)),tag=id=>document.querySelector('[data-player-id="'+id+'"] .fgame');
check(!errors.length,errors.join(';'));check(document.querySelectorAll('.game-hand button.playing-card').length===20,'twenty-card hand');
check(tag('b').textContent.includes('斗地主')&&tag('c').textContent.includes('川麻'),'different-table presence');check(document.querySelector('#roomGameSummary').textContent.includes('2'),'multi-table summary');
const lobby=JSON.parse(JSON.stringify(current));lobby.table.phase='lobby';lobby.tables[0].phase='lobby';emit('games',lobby);check(tag('b').textContent.includes('已报名'),'lobby registration badge');emit('games',current);
document.querySelector('#myGameStatus').click();check(document.querySelector('#panel').classList.contains('hidden'),'status click collapses');document.querySelector('#myGameStatus').click();check(!document.querySelector('#panel').classList.contains('hidden'),'status second click expands');check(!api.calls.length,'toggle must never send game leave');
document.querySelector('.game-head button').click();check(!document.querySelector('.game-felt'),'fold hides table');document.querySelector('#closePanel').click();document.querySelector('#gameDock').click();check(document.querySelector('.game-felt'),'dock restores table');
const card=document.querySelector('.game-hand button');card.click();check(card.getAttribute('aria-pressed')==='true','card selection');card.click();
tag('c').click();await wait();check(document.querySelector('.mahjong-felt'),'friend status opens correct table');check(!document.querySelector('.game-hand button.mahjong-tile'),'spectator cannot select concealed tiles');
second.seats[0]={id:'a',name:'buyan',alive:true,left:false};second.canAct=true;second.mahjong.players[0].hand=[0,1,2,4,5,8,9,12,13,16,17,20,21,24];second.mahjong.players[0].count=14;second.mahjong.actions=['exchange'];first.seats[0].left=true;current={...current,table:second,tables:[${JSON.stringify(summary(first))},${JSON.stringify(summary(second))}]};current.tables[0].seats[0].left=true;current.tables[1].seats[0]=second.seats[0];emit('games',current);check(document.querySelectorAll('.game-hand button.mahjong-tile').length===14,'mahjong hand render');
document.querySelector('.game-hand button.mahjong-tile').click();check(document.querySelector('.game-hand button.mahjong-tile').getAttribute('aria-pressed')==='true','mahjong selection');document.querySelector('.game-hand button.mahjong-tile').click();
const overlap=(a,b)=>{a=a.getBoundingClientRect();b=b.getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top};
const layout=()=>{const dock=document.querySelector('#gameDock');check(!overlap(dock,document.querySelector('#boss')),'entry overlaps Boss');for(const n of document.querySelectorAll('.factions,.fcount,.fname,#bubble'))check(!overlap(dock,n),'entry covers items');const a=dock.getBoundingClientRect(),b=document.querySelector('#boss').getBoundingClientRect();check(a.right<=b.left&&a.top<b.bottom&&a.bottom>b.top,'entry and Boss share row');check(document.querySelector('#panel').getBoundingClientRect().bottom<=document.querySelector('#stage').getBoundingClientRect().top-3,'panel overlaps stage');};
await wait();layout();check(document.querySelector('.mahjong-felt .game-actions button').getBoundingClientRect().bottom<=document.querySelector('#panel').getBoundingClientRect().bottom,'mahjong controls visible in four-friend layout '+document.querySelector('.mahjong-felt .game-actions button').getBoundingClientRect().bottom+' / '+document.querySelector('#panel').getBoundingClientRect().bottom);for(let i=4;i<15;i++){const c=document.querySelector('.friend').cloneNode(true);c.dataset.playerId='extra-'+i;c.dataset.qaClone='true';c.querySelector('.fgame').classList.add('hidden');document.querySelector('#friends').append(c);}window.dispatchEvent(new Event('friend-cards-rendered'));await wait();layout();for(const c of document.querySelectorAll('[data-qa-clone]'))c.remove();window.dispatchEvent(new Event('friend-cards-rendered'));await wait();layout();
emit('net-status',{state:'offline'});check(tag('b').classList.contains('hidden'),'offline clears status');emit('net-status',{state:'online'});emit('games-online',true);emit('games',{...current,table:{...second,phase:'finished'},tables:[]});check(document.querySelector('#myGameStatus').classList.contains('hidden'),'finish clears status');emit('games',current);await wait();layout();check(api.calls.every(a=>a.op==='watch'),'UI toggles must not debit or quit');check(!errors.length,errors.join(';'));document.body.dataset.qa='passed';
}catch(e){document.body.dataset.qa='failed:'+e.message}},200);
</script></body></html>`;
const file=path.join(out,'preview.html');fs.writeFileSync(file,html);
const browser=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);if(!browser)throw Error('No browser for UI check');
const screenshot=path.join(out,'games-preview.png');
// Set the viewport through CDP: Windows Chrome's outer window includes toolbar
// space even when headless; --window-size alone does not model a Tauri webview.
(async()=>{
  const {spawn}=require('child_process'),WebSocket=require('ws');
  const profile=path.join(out,`browser-profile-${process.pid}`);fs.mkdirSync(profile,{recursive:true});
  const proc=spawn(browser,['--headless=new','--disable-gpu','--allow-file-access-from-files','--hide-scrollbars','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let ws;const pending=new Map();let nextId=0;
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  try{
    const active=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(active);i++)await delay(50);if(!fs.existsSync(active))throw Error('Browser did not start');
    const port=fs.readFileSync(active,'utf8').split('\n')[0],version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.on('message',data=>{const r=JSON.parse(data);const request=pending.get(r.id);if(request){pending.delete(r.id);clearTimeout(request.timer);r.error?request.reject(Error(r.error.message)):request.resolve(r.result);}});
    const {targetId}=await call('Target.createTarget',{url:'about:blank'});const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    await call('Page.enable',{},sessionId);await call('Emulation.setDeviceMetricsOverride',{width:910,height:720,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.navigate',{url:pathToFileURL(file).href},sessionId);
    let qa='';for(let i=0;i<60&&!qa;i++){await delay(100);const r=await call('Runtime.evaluate',{expression:'document.body?.dataset.qa || ""',returnByValue:true},sessionId);qa=r.result.value;}
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));
    if(qa!=='passed')throw Error(qa||'UI checks did not finish');
    console.log('UI passed at 910x720: multi-table status/toggle, cards/mahjong, privacy, cleanup, controls visible, and no overlaps at 4/15 friends.');console.log(screenshot);
  }finally{for(const r of pending.values())clearTimeout(r.timer);ws?.close();proc.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
