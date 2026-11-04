'use strict';
/* global api */
// Full-screen, click-through layer that draws item effects: splats on your face, tomato rain and
// fireworks. Each must be gone within SPLAT_LIFETIME (main.rs).

const STAY_MS = 6000;
const FADE_MS = 1000;
const FLIGHT_MS = 380;
// Tomato rain: small splats falling from the top, landing over RAIN_SPREAD_MS.
const RAIN_DROPS = [7, 10];
const RAIN_SPREAD_MS = 1200;
const RAIN_FALL_MS = 550;
const RAIN_STAY_MS = 4500;
// Fireworks: shells go up until FIREWORKS_MS, then the last sparks burn out.
const FIREWORKS_MS = 3400;
const SHELL_RISE_MS = 900;

const THEMES = {
  tomato: { emoji: '🍅', name: '番茄', main: '#e53935', dark: '#b71c1c', light: '#ff7961', drips: [2, 4], dripLen: [60, 160] },
  ink: { emoji: '🦑', name: '墨鱼汁', main: '#1a1426', dark: '#07050c', light: '#3d3552', drips: [4, 7], dripLen: [120, 300] },
  poop: { emoji: '💩', name: '屎', main: '#7b4a1e', dark: '#5a3412', light: '#a0682f', drips: [1, 3], dripLen: [40, 110] },
};

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const f = (n) => n.toFixed(1);
let active = 0;
let seen = 0; // splats received; lets the app tell whether one is still in flight when we report idle

// Smooth closed path through points (Catmull-Rom -> cubic Bezier).
function smoothPath(pts) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}

function blob(cx, cy, r, n, spiky) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(-0.12, 0.12);
    let rr = r * rand(0.78, 1.08);
    if (spiky && i % 2 === 0 && Math.random() < 0.6) rr *= rand(1.2, 1.55);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return smoothPath(pts);
}

function droplets(cx, cy, r, count, fill) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2);
    const dist = r * rand(1.25, 1.85);
    s += `<circle cx="${f(cx + Math.cos(a) * dist)}" cy="${f(cy + Math.sin(a) * dist)}" r="${f(rand(3, r * 0.11))}" fill="${fill}"/>`;
  }
  return s;
}

function drips(cx, cy, r, t) {
  let s = '';
  const count = randInt(t.drips[0], t.drips[1]);
  for (let i = 0; i < count; i++) {
    const w = rand(10, 22);
    const x = cx + rand(-r * 0.6, r * 0.6);
    const y = cy + r * 0.45;
    const len = rand(t.dripLen[0], t.dripLen[1]);
    s += `<g class="drip" style="--d:${f(rand(2.5, 5))}s"><rect x="${f(x - w / 2)}" y="${f(y)}" width="${f(w)}" height="${f(len)}" rx="${f(w / 2)}" fill="${t.main}"/>` +
      `<circle cx="${f(x)}" cy="${f(y + len - w / 2)}" r="${f(w * 0.75)}" fill="${t.main}"/></g>`;
  }
  return s;
}

function tomatoBits(cx, cy, r, t) {
  let s = `<path d="${blob(cx + rand(-20, 20), cy + rand(-20, 20), r * 0.45, 9, false)}" fill="${t.light}" opacity=".7"/>`;
  for (let i = 0; i < 14; i++) {
    const a = rand(0, Math.PI * 2);
    const d = rand(0, r * 0.7);
    s += `<ellipse cx="${f(cx + Math.cos(a) * d)}" cy="${f(cy + Math.sin(a) * d)}" rx="5" ry="3" transform="rotate(${randInt(0, 180)} ${f(cx + Math.cos(a) * d)} ${f(cy + Math.sin(a) * d)})" fill="#ffe082"/>`;
  }
  // a bit of the stem
  const sx = cx + rand(-r * 0.3, r * 0.3);
  const sy = cy + rand(-r * 0.4, 0);
  let leaf = '';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    leaf += `${i ? 'L' : 'M'}${f(sx + Math.cos(a) * 26)} ${f(sy + Math.sin(a) * 26)} L${f(sx + Math.cos(a + 0.6) * 8)} ${f(sy + Math.sin(a + 0.6) * 8)} `;
  }
  return `${s}<path d="${leaf}Z" fill="#43a047"/>`;
}

function inkBits(cx, cy, r) {
  return `<ellipse cx="${f(cx - r * 0.3)}" cy="${f(cy - r * 0.35)}" rx="${f(r * 0.35)}" ry="${f(r * 0.14)}" transform="rotate(-25 ${f(cx)} ${f(cy)})" fill="#fff" opacity=".12"/>` +
    `<path d="${blob(cx + r * 0.2, cy + r * 0.1, r * 0.4, 8, false)}" fill="#2a1f3d" opacity=".6"/>`;
}

function poopBits(cx, cy, r, t) {
  // A swirl pile in the middle, some flies buzzing around and stink lines.
  const pile = [
    [0, 34, 70, 26], [0, 8, 54, 22], [0, -14, 38, 18],
  ].map(([dx, dy, rx, ry]) => `<ellipse cx="${f(cx + dx)}" cy="${f(cy + dy)}" rx="${rx}" ry="${ry}" fill="${t.light}" stroke="${t.dark}" stroke-width="3"/>`).join('') +
    `<path d="M${f(cx - 6)} ${f(cy - 30)} Q${f(cx + 4)} ${f(cy - 54)} ${f(cx + 14)} ${f(cy - 44)}" stroke="${t.dark}" stroke-width="10" stroke-linecap="round" fill="${t.light}"/>` +
    `<circle cx="${f(cx - 16)}" cy="${f(cy + 6)}" r="6" fill="#fff"/><circle cx="${f(cx + 16)}" cy="${f(cy + 6)}" r="6" fill="#fff"/>` +
    `<circle cx="${f(cx - 15)}" cy="${f(cy + 7)}" r="3" fill="#222"/><circle cx="${f(cx + 17)}" cy="${f(cy + 7)}" r="3" fill="#222"/>` +
    `<path d="M${f(cx - 12)} ${f(cy + 26)} Q${f(cx)} ${f(cy + 38)} ${f(cx + 12)} ${f(cy + 26)}" stroke="#222" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  let flies = '';
  for (let i = 0; i < 3; i++) {
    const orbit = r * rand(0.8, 1.2);
    flies += `<g class="fly" style="--d:${f(rand(1.2, 2.4))}s;transform-origin:${f(cx)}px ${f(cy)}px">` +
      `<g transform="rotate(${randInt(0, 360)} ${f(cx)} ${f(cy)})"><circle cx="${f(cx + orbit)}" cy="${f(cy)}" r="5" fill="#222"/>` +
      `<ellipse class="wing" cx="${f(cx + orbit - 4)}" cy="${f(cy - 7)}" rx="4" ry="6" fill="#cfe8ff" opacity=".8"/>` +
      `<ellipse class="wing" cx="${f(cx + orbit + 4)}" cy="${f(cy - 7)}" rx="4" ry="6" fill="#cfe8ff" opacity=".8"/></g></g>`;
  }
  let stink = '';
  for (let i = -1; i <= 1; i++) {
    const x = cx + i * 34;
    const y = cy - r * 0.75;
    stink += `<path class="stink" d="M${f(x)} ${f(y + 30)} q -10 -10 0 -20 q 10 -10 0 -20" stroke="#8bc34a" stroke-width="5" fill="none" stroke-linecap="round" style="animation-delay:${i * 0.3 + 0.3}s"/>`;
  }
  return pile + flies + stink;
}

function buildSplat(itemId, r) {
  const t = THEMES[itemId];
  const dripMax = t.dripLen[1] + 30;
  const W = r * 4;
  const H = r * 4 + dripMax;
  const cx = W / 2;
  const cy = r * 2;
  let inner = `<path d="${blob(cx, cy, r * 1.04, 16, true)}" fill="${t.dark}"/>` +
    `<path d="${blob(cx, cy, r, 16, true)}" fill="${t.main}"/>` +
    `<path d="${blob(cx + rand(-r, r) * 0.5, cy + rand(-r, r) * 0.5, r * 0.35, 9, true)}" fill="${t.main}"/>` +
    droplets(cx, cy, r, randInt(8, 16), t.main) +
    drips(cx, cy, r, t);
  if (itemId === 'tomato') inner += tomatoBits(cx, cy, r, t);
  if (itemId === 'ink') inner += inkBits(cx, cy, r);
  if (itemId === 'poop') inner += poopBits(cx, cy, r, t);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}" height="${f(H)}" viewBox="0 0 ${f(W)} ${f(H)}">${inner}</svg>`, W, cx, cy };
}

function banner(text) {
  const b = document.createElement('div');
  b.className = 'banner';
  b.textContent = text;
  document.getElementById('banners').append(b);
  setTimeout(() => b.remove(), 4000);
}

// Every effect calls this once when it's completely gone.
function done() {
  active -= 1;
  if (active === 0) api.overlayIdle(seen);
}

function missile(emoji, cls) {
  const m = document.createElement('div');
  m.className = cls;
  m.textContent = emoji;
  document.body.append(m);
  return m;
}

// Sticks a splat centred on (tx, ty); it fades out after `stay` ms, then calls gone().
function stick(item, r, tx, ty, stay, gone) {
  const { svg, W, cx, cy } = buildSplat(item, r);
  const wrap = document.createElement('div');
  wrap.className = 'splat in';
  wrap.style.setProperty('--rot', `${randInt(-25, 25)}deg`);
  wrap.style.left = `${tx - cx}px`;
  wrap.style.top = `${ty - cy}px`;
  wrap.style.width = `${W}px`;
  wrap.style.transformOrigin = `${cx}px ${cy}px`;
  wrap.innerHTML = svg; // generated markup only, contains no user text
  document.body.append(wrap);
  setTimeout(() => {
    wrap.classList.replace('in', 'out');
    setTimeout(() => {
      wrap.remove();
      gone();
    }, FADE_MS);
  }, stay);
}

function splat({ item, fromName }) {
  const t = THEMES[item];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = Math.min(vw, vh) * rand(0.16, 0.23);
  const tx = rand(vw * 0.18, vw * 0.82);
  const ty = rand(vh * 0.18, vh * 0.7);

  // The item flies in from a random screen edge.
  const m = missile(t.emoji, 'missile');
  const fromLeft = Math.random() < 0.5;
  const sx = fromLeft ? -160 : vw + 30;
  const sy = rand(vh * 0.2, vh * 0.9);
  m.animate([
    { transform: `translate(${sx}px, ${sy}px) rotate(0deg) scale(.6)` },
    { transform: `translate(${tx - 65}px, ${ty - 65}px) rotate(${fromLeft ? 540 : -540}deg) scale(1.3)` },
  ], { duration: FLIGHT_MS, easing: 'cubic-bezier(.5,0,1,1)' }).onfinish = () => {
    m.remove();
    stick(item, r, tx, ty, STAY_MS, done);
    banner(`${fromName} 用${t.name}糊了你一脸！`);
  };
}

// Small tomatoes pelting down all over the screen.
function rain({ fromName }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const n = randInt(RAIN_DROPS[0], RAIN_DROPS[1]);
  let left = n;
  banner(`${fromName} 下了一场番茄雨！`);
  for (let k = 0; k < n; k++) {
    setTimeout(() => {
      const r = Math.min(vw, vh) * rand(0.07, 0.11);
      const tx = rand(vw * 0.06, vw * 0.94);
      const ty = rand(vh * 0.12, vh * 0.85);
      const m = missile(THEMES.tomato.emoji, 'missile small');
      m.animate([
        { transform: `translate(${tx - 32}px, -90px) rotate(0deg)` },
        { transform: `translate(${tx - 32}px, ${ty - 32}px) rotate(${randInt(-240, 240)}deg)` },
      ], { duration: RAIN_FALL_MS, easing: 'cubic-bezier(.55,0,1,.45)' }).onfinish = () => {
        m.remove();
        stick('tomato', r, tx, ty, RAIN_STAY_MS, () => {
          left -= 1;
          if (left === 0) done();
        });
      };
    }, (k / n) * RAIN_SPREAD_MS + rand(0, 100));
  }
}

// Shells rise from the bottom and burst into sparks that droop and fade, leaving trails.
// `title` replaces the usual banner (e.g. when the room beats its boss).
function fireworks({ fromName, mine, title }) {
  banner(title || (mine ? '🎆 你放了一场烟花！' : `🎆 ${fromName} 放了一场烟花！`));
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'sky';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const dot = (x, y, r, color, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  const count = randInt(6, 8);
  const shells = [];
  for (let k = 0; k < count; k++) {
    const hue = randInt(0, 359);
    shells.push({
      at: (k / count) * (FIREWORKS_MS - SHELL_RISE_MS) + rand(0, 200),
      x: rand(W * 0.1, W * 0.9),
      top: rand(H * 0.1, H * 0.4),
      hue,
      hue2: Math.random() < 0.35 ? (hue + 150) % 360 : hue, // some shells are two-coloured
      crackle: Math.random() < 0.4, // sparks twinkle as they die out
      burst: false,
    });
  }
  const sparks = [];
  const flashes = [];
  const gravity = H * 0.12; // px/s²
  const t0 = performance.now();
  let last = t0;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    const t = now - t0;
    last = now;
    // Fade what's there instead of clearing it, so everything leaves a trail.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, .14)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const s of shells) {
      if (s.burst || t < s.at) continue;
      const p = Math.min(1, (t - s.at) / SHELL_RISE_MS);
      const y = H + 20 - (H + 20 - s.top) * (1 - (1 - p) ** 3);
      dot(s.x + Math.sin(p * 12) * 2, y, 3, `hsl(${s.hue}, 100%, 85%)`, 1);
      if (p < 1) continue;
      s.burst = true;
      const n = randInt(90, 130);
      const speed = Math.min(W, H) * rand(0.3, 0.42);
      flashes.push({ x: s.x, y: s.top, r: speed * 0.45, hue: s.hue, t: 0 });
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.05, 0.05);
        const v = speed * rand(0.45, 1);
        const life = rand(1.3, 2);
        const hue = (i % 2 ? s.hue2 : s.hue) + randInt(-15, 15);
        sparks.push({ x: s.x, y: s.top, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, hue, crackle: s.crackle });
      }
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const fl = flashes[i];
      fl.t += dt;
      const a = 1 - fl.t / 0.3;
      if (a <= 0) {
        flashes.splice(i, 1);
        continue;
      }
      const g = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, fl.r);
      g.addColorStop(0, `hsla(${fl.hue}, 100%, 95%, ${0.5 * a})`);
      g.addColorStop(1, `hsla(${fl.hue}, 100%, 60%, 0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(fl.x - fl.r, fl.y - fl.r, fl.r * 2, fl.r * 2);
    }
    const drag = 0.3 ** dt;
    for (let i = sparks.length - 1; i >= 0; i--) {
      const k = sparks[i];
      k.life -= dt;
      if (k.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      k.vx *= drag;
      k.vy = k.vy * drag + gravity * dt;
      k.x += k.vx * dt;
      k.y += k.vy * dt;
      const a = k.life / k.max;
      const twinkle = k.crackle && a < 0.5 && Math.random() < 0.4 ? 0.2 : 1;
      dot(k.x, k.y, 1.6 + a * 2.4, `hsl(${k.hue}, 100%, ${55 + a * 30}%)`, a * twinkle);
    }
    if (sparks.length || flashes.length || shells.some((s) => !s.burst)) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
      done();
    }
  };
  requestAnimationFrame(frame);
}

const EFFECTS = { rain, firework: fireworks };

api.on('effect', (e) => {
  seen += 1;
  const play = EFFECTS[e.item] || (THEMES[e.item] && splat);
  if (!play) {
    if (active === 0) api.overlayIdle(seen);
    return;
  }
  active += 1;
  play(e);
});
