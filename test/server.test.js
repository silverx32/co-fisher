'use strict';
// Protocol tests for the Rust room server, driven over real WebSockets.
// The same server code runs inside the app (host mode) and as the standalone relay.
// Build first: cargo build -p cofisher-server
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PROTOCOL_VERSION = 2;
const MAX_PLAYERS = 16;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const BIN = process.env.RELAY_BIN || path.join(__dirname, '..', 'target', 'debug', process.platform === 'win32' ? 'cofisher-relay.exe' : 'cofisher-relay');

function startRelay(args = []) {
  const proc = spawn(BIN, ['--port', '0', '--host', '127.0.0.1', ...args]);
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (\d+)/);
      if (m) resolve({ port: Number(m[1]), proc });
    });
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`relay exited ${code}: ${out}`)));
  });
}

async function withServer(args, fn) {
  const { port, proc } = await startRelay(args);
  try { await fn(port); } finally { proc.kill(); }
}

function client(port, hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.on('error', () => {});
  ws.on('open', () => ws.send(JSON.stringify({
    t: 'hello', v: PROTOCOL_VERSION, inv: {}, count: 0, char: 'deepseek', secret: `secret-of-${hello.id}`, ...hello,
  })));
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return {
    ws, inbox, closed,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 2000) => {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      });
    },
  };
}

const id = (n) => `player-${String(n).padStart(4, '0')}`;

test('joins, sees roster and status updates', () => withServer([], async (port) => {
  const a = client(port, { id: id(1), name: 'A' });
  await a.wait((m) => m.t === 'welcome');
  const b = client(port, { id: id(2), name: 'B', char: 'kimi', deco: 'crown-ruby' });
  await b.wait((m) => m.t === 'welcome');
  b.send({ t: 'status', count: 10, typing: true, inv: { tomato: 2 }, chest: true });
  const st = await a.wait((m) => m.t === 'state' && m.players.some((p) => p.id === id(2) && p.count === 10));
  const pb = st.players.find((p) => p.id === id(2));
  assert.equal(pb.char, 'kimi');
  assert.equal(pb.typing, true);
  assert.equal(pb.inv.tomato, 2);
  assert.equal(pb.deco, 'crown-ruby');
  assert.equal(pb.chest, true);
  assert.equal(st.players.find((p) => p.id === id(1)).chest, false);
  assert.equal(st.players.find((p) => p.id === id(1)).deco, '');
  assert.deepEqual(st.players.map((p) => p.id), [id(1), id(2)], 'join order is stable');
  b.send({ t: 'profile', name: 'B', deco: '<img>' });
  await a.wait((m) => m.t === 'state' && m.players.some((p) => p.id === id(2) && p.deco === ''));
  a.ws.close(); b.ws.close();
}));

test('rejects wrong password and bad version', () => withServer(['--password', 'pw'], async (port) => {
  const a = client(port, { id: id(1), password: 'nope' });
  const err = await a.wait((m) => m.t === 'error');
  assert.match(err.text, /密码/);
  assert.equal(await a.closed, 4001);
  const b = client(port, { id: id(2), password: 'pw', v: 1 });
  assert.match((await b.wait((m) => m.t === 'error')).text, /版本/);
}));

test(`room caps at ${MAX_PLAYERS} players`, () => withServer([], async (port) => {
  const cs = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const c = client(port, { id: id(i) });
    await c.wait((m) => m.t === 'welcome');
    cs.push(c);
  }
  const extra = client(port, { id: id(99) });
  assert.match((await extra.wait((m) => m.t === 'error')).text, /已满/);
  // A reconnect of an existing player is still allowed when full.
  const again = client(port, { id: id(0) });
  await again.wait((m) => m.t === 'welcome');
  assert.equal(await cs[0].closed, 4002);
  for (const c of cs) c.ws.close();
  again.ws.close();
}));

test('relay keeps room codes apart; host mode ignores them', async () => {
  await withServer([], async (port) => {
    const a = client(port, { id: id(1), room: 'cats' });
    const b = client(port, { id: id(2), room: 'dogs' });
    const c = client(port, { id: id(3), room: 'cats' });
    await Promise.all([a, b, c].map((x) => x.wait((m) => m.t === 'welcome')));
    const st = await a.wait((m) => m.t === 'state' && m.players.length === 2);
    assert.deepEqual(st.players.map((p) => p.id).sort(), [id(1), id(3)]);
    await b.wait((m) => m.t === 'state');
    assert.ok(b.inbox.filter((m) => m.t === 'state').every((m) => m.players.length === 1));
    for (const x of [a, b, c]) x.ws.close();
  });
  await withServer(['--single-room'], async (port) => {
    const a = client(port, { id: id(1), room: 'cats' });
    const b = client(port, { id: id(2), room: 'dogs' });
    await Promise.all([a, b].map((x) => x.wait((m) => m.t === 'welcome')));
    await a.wait((m) => m.t === 'state' && m.players.length === 2);
    a.ws.close(); b.ws.close();
  });
});

test('throw is relayed and limited by inventory and rate', () => withServer([], async (port) => {
  const a = client(port, { id: id(1), name: 'A', inv: { tomato: 10, ink: 0 } });
  await a.wait((m) => m.t === 'welcome');
  const b = client(port, { id: id(2), name: 'B' });
  await b.wait((m) => m.t === 'welcome');

  a.send({ t: 'throw', seq: 1, item: 'tomato', target: id(2) });
  const hit = await b.wait((m) => m.t === 'hit');
  assert.deepEqual([hit.item, hit.from, hit.to, hit.fromName, hit.toName], ['tomato', id(1), id(2), 'A', 'B']);
  assert.equal((await a.wait((m) => m.t === 'throwResult' && m.seq === 1)).ok, true);

  a.send({ t: 'throw', seq: 2, item: 'ink', target: id(2) });
  assert.equal((await a.wait((m) => m.t === 'throwResult' && m.seq === 2)).ok, false);
  a.send({ t: 'throw', seq: 3, item: 'tomato', target: id(1) });
  assert.equal((await a.wait((m) => m.t === 'throwResult' && m.seq === 3)).ok, false);

  for (let s = 10; s < 14; s++) a.send({ t: 'throw', seq: s, item: 'tomato', target: id(2) });
  const results = await Promise.all([10, 11, 12, 13].map((s) => a.wait((m) => m.t === 'throwResult' && m.seq === s)));
  assert.equal(results.filter((r) => r.ok).length, 2, 'only 3 throws per second (1 already used)');
  a.ws.close(); b.ws.close();
}));

test('count growth is capped, custom skins are shared and validated', () => withServer([], async (port) => {
  const a = client(port, { id: id(1), skin: { idle: PNG, typing: PNG } });
  await a.wait((m) => m.t === 'welcome');
  const b = client(port, { id: id(2), skin: { idle: 'javascript:alert(1)', typing: PNG } });
  await b.wait((m) => m.t === 'welcome');
  const sk = await b.wait((m) => m.t === 'skin' && m.id === id(1));
  assert.equal(sk.skin.idle, PNG);
  const st = await a.wait((m) => m.t === 'state' && m.players.length === 2);
  assert.equal(st.players.find((p) => p.id === id(2)).skinRev, 0, 'invalid skin dropped');

  a.send({ t: 'status', count: 1e6, typing: true, inv: {} });
  const st2 = await b.wait((m) => m.t === 'state' && m.players.find((p) => p.id === id(1)).count > 0);
  assert.ok(st2.players.find((p) => p.id === id(1)).count < 100);
  a.ws.close(); b.ws.close();
}));

test('another peer cannot take over an id without its secret', () => withServer([], async (port) => {
  const victim = client(port, { id: id(1), name: 'V' });
  await victim.wait((m) => m.t === 'welcome');
  const thief = client(port, { id: id(1), name: 'T', secret: 'not-the-right-secret' });
  assert.match((await thief.wait((m) => m.t === 'error')).text, /已被别人使用/);
  victim.send({ t: 'status', count: 3, typing: false, inv: {} });
  await victim.wait((m) => m.t === 'state' && m.players.length === 1 && m.players[0].name === 'V' && m.players[0].count === 3);
  victim.ws.close();
}));

test('reconnecting does not bypass the count growth cap', () => withServer([], async (port) => {
  const a = client(port, { id: id(1), count: 10 });
  const keep = client(port, { id: id(2) }); // keeps the room alive while A is away
  await a.wait((m) => m.t === 'welcome');
  await keep.wait((m) => m.t === 'welcome');
  a.ws.close();
  await a.closed;
  await keep.wait((m) => m.t === 'state' && m.players.length === 1);
  const b = client(port, { id: id(1), count: 1e6 });
  const st = await b.wait((m) => m.t === 'state' && m.players.length === 2);
  const me = st.players.find((p) => p.id === id(1));
  assert.ok(me.count < 100, `count was ${me.count}`);
  b.ws.close(); keep.ws.close();
}));

test('rejections always arrive with their error message and close code', () => withServer(['--password', 'pw'], async (port) => {
  for (let i = 0; i < 15; i++) { // stays under the 20 hellos/minute per-IP limit
    const c = client(port, { id: id(i), password: 'wrong' });
    const code = await c.closed;
    assert.equal(code, 4001, `attempt ${i}: close code`);
    assert.ok(c.inbox.some((m) => m.t === 'error' && /密码/.test(m.text) && m.retry === false), `attempt ${i}: error message`);
  }
}));

test('many small status messages cannot inflate the count', () => withServer([], async (port) => {
  const a = client(port, { id: id(1) });
  const b = client(port, { id: id(2) });
  await a.wait((m) => m.t === 'welcome');
  await b.wait((m) => m.t === 'welcome');
  for (let n = 1; n <= 3000; n++) a.send({ t: 'status', count: n * 20, typing: true, inv: {} });
  await new Promise((r) => setTimeout(r, 600));
  const st = await b.wait((m) => m.t === 'state' && m.players.length === 2);
  const latest = b.inbox.filter((m) => m.t === 'state').pop();
  const count = latest.players.find((p) => p.id === id(1)).count;
  assert.ok(count <= 300, `count was ${count}`);
  assert.ok(st);
  a.ws.close(); b.ws.close();
}));

test('skin changes are rate limited and repeats are not rebroadcast', () => withServer([], async (port) => {
  const PNG2 = 'data:image/png;base64,AAAA';
  const a = client(port, { id: id(1) });
  const b = client(port, { id: id(2) });
  await a.wait((m) => m.t === 'welcome');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'profile', name: 'A', skin: { idle: PNG, typing: PNG } });
  a.send({ t: 'profile', name: 'A', skin: { idle: PNG, typing: PNG } });
  a.send({ t: 'profile', name: 'A', skin: { idle: PNG2, typing: PNG2 } });
  await b.wait((m) => m.t === 'skin' && m.id === id(1));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.inbox.filter((m) => m.t === 'skin' && m.id === id(1)).length, 1);
  a.ws.close(); b.ws.close();
}));

test('a throw right after buying uses the inventory sent with it', () => withServer([], async (port) => {
  const a = client(port, { id: id(1), inv: { poop: 0 } });
  const b = client(port, { id: id(2) });
  await a.wait((m) => m.t === 'welcome');
  await b.wait((m) => m.t === 'welcome');
  // No status in between: the server only learns about the new item from the throw itself.
  a.send({ t: 'throw', seq: 1, item: 'poop', target: id(2), inv: { poop: 1 } });
  assert.equal((await a.wait((m) => m.t === 'throwResult' && m.seq === 1)).ok, true);
  a.send({ t: 'throw', seq: 2, item: 'poop', target: id(2) });
  assert.equal((await a.wait((m) => m.t === 'throwResult' && m.seq === 2)).ok, false, 'server deducted it');
  a.ws.close(); b.ws.close();
}));

test('malformed messages are ignored, oversized frames close the socket',() => withServer([], async (port) => {
  const a = client(port, { id: id(1) });
  await a.wait((m) => m.t === 'welcome');
  for (const m of ['null', '42', '"x"', '{"t":5}', '{"t":"throw"}', '{"t":"status","count":"lots"}']) a.ws.send(m);
  a.send({ t: 'status', count: 4, typing: false, inv: {} });
  await a.wait((m) => m.t === 'state' && m.players[0].count === 4);
  a.ws.send('x'.repeat(2 * 1024 * 1024));
  assert.notEqual(await a.closed, 1000);
}));
