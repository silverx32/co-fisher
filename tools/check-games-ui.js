'use strict';
// Local browser smoke check and preview, without touching the user's save.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'tmp', 'games-ui-qa');
fs.mkdirSync(out, { recursive: true });
const url = (p) => pathToFileURL(path.join(root, p)).href;
const snapshot = {epoch:'preview',revision:7,table:{kind:'ddz',phase:'play',round:1,turn:'a',host:'a',prize:1200,pot:1500,landlord:'a',bottom:[11,24,52],last:[],canAct:true,note:'你是地主，选择手牌后点击出牌。',remainingMs:30000,seats:[
  {id:'a',name:'摸鱼搭子',alive:true,left:false,count:20,cards:[1,14,27,2,15,3,16,4,17,5,18,6,19,7,8,9,10,11,24,52]},
  {id:'b',name:'键盘侠',alive:true,left:false,count:17,cards:null},
  {id:'c',name:'下午茶',alive:true,left:false,count:17,cards:null},
]}};
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="${url('ui/pet.css')}"><link rel="stylesheet" href="${url('ui/games.css')}"><body style="background:#e7ece6"><div id="root"><div id="panel" class="hit games-panel"><div class="tabs"><button data-tab="room">房间</button><button data-tab="games" class="active">小游戏</button><button>角色</button><button>道具</button><button>装扮</button><button>日历</button><button id="closePanel">✕</button></div><section><div id="gamesRoot"></div></section></div><div style="position:absolute;right:25px;bottom:10px;text-align:center"><img style="height:165px" src="${url('ui/assets/characters/claude/idle.png')}"><div>摸鱼搭子</div></div><button id="gameDock" class="hit hidden"></button></div>
<script>window.errors=[];onerror=(m)=>errors.push(m);const listeners={};window.api={calls:[],on:(c,f)=>(listeners[c]??=[]).push(f),init:()=>Promise.resolve({me:{id:'a'},wallet:{count:4500},net:{state:'online'},gamesSupported:true,game:${JSON.stringify(snapshot)}}),gameCommand:async(a)=>{api.calls.push(a);return {ok:true}}};document.querySelector('#closePanel').onclick=()=>document.querySelector('#panel').classList.add('hidden');</script>
<script src="${url('ui/games.js')}"></script><script>
setTimeout(async()=>{try{
const check=(p,m)=>{if(!p)throw Error(m)};
check(!errors.length,errors.join(';'));
check(document.querySelectorAll('#gamesRoot .game-hand button.playing-card').length===20,'twenty-card hand');
document.querySelector('#gamesRoot .game-head button').click();check(!document.querySelector('.game-felt'),'fold hides only table UI');check(!api.calls.length,'fold must not leave');
document.querySelector('#closePanel').click();check(!api.calls.length,'closing panel must not leave');
document.querySelector('#gameDock').click();check(!document.querySelector('#panel').classList.contains('hidden'),'dock restores panel');check(document.querySelector('.game-felt'),'dock restores table');
const card=document.querySelector('.game-hand button');card.click();check(card.getAttribute('aria-pressed')==='true','card selection');card.click();
const b=document.querySelector('.game-felt').getBoundingClientRect();const p=document.querySelector('#panel').getBoundingClientRect();check(b.left>=p.left&&b.right<=p.right,'table fits panel width');
check(!api.calls.length,'all collapse and restore actions are local');
document.body.dataset.qa='passed';
}catch(e){document.body.dataset.qa='failed:'+e.message}},200);
</script></body></html>`;
const htmlPath = path.join(out, 'preview.html');
fs.writeFileSync(htmlPath, html);
const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
if (!browser) throw Error('No browser for UI check');
const screenshot = path.join(out, 'games-preview.png');
const dom = execFileSync(browser, ['--headless=new','--disable-gpu','--allow-file-access-from-files','--hide-scrollbars','--force-device-scale-factor=1','--window-size=910,720',`--user-data-dir=${path.join(out,'browser-profile')}`,`--screenshot=${screenshot}`,'--virtual-time-budget=1500','--dump-dom',pathToFileURL(htmlPath).href], {encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
const result=dom.match(/data-qa="([^"]+)"/);
if(result?.[1]!=='passed')throw Error(result?.[1]||'Browser did not complete UI assertions');
console.log('UI passed: 20-card hand, selection, collapse, close, restore and panel width.');
console.log(screenshot);
