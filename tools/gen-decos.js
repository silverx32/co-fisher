'use strict';
// Draws the cosmetics ("装扮") procedurally:
//   ui/assets/decos/<id>.png    one transparent PNG per item
//   ui/assets/decos/decos.json  [{ id, name, rarity, slot, layer, box, boss? }] (read by the app at build time)
//                               box = [x0, y0, x1, y1]: square crop around the art, for icons
//                               boss = id of the room boss whose last hit drops it (only there:
//                               never from chests or merges)
// Every PNG covers the character's image box widened by 20% on both sides and 25% upwards, so
// one picture fits every character (and custom skins): hats on top, pets / balloons beside.
// layer "back" is drawn behind the character (wings, auras), "front" in front of it.
// Run: node tools/gen-decos.js [--preview]   (--preview also writes dist/decos-preview-*.png)
const fs = require('fs');
const path = require('path');
const { decodePng, encodePng, resize } = require('./png');

const W = 336;
const H = 330;
const SS = 4; // supersampling for anti-aliasing
// The character box inside the canvas, and the top of the head.
const BOX = { x: 48, y: 66, w: 240, h: 264 };
const HX = 168;
const HY = 78;

// ---------------------------------------------------------------- colors
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
const lighten = (c, t) => mix(c, [255, 255, 255], t);
const darken = (c, t) => mix(c, [0, 0, 0], t);
const col = (c) => (typeof c === 'string' ? hex(c) : c);
const hsv = (h, s, v) => {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
};

// Paints: a function (x, y) -> [r, g, b, a] in canvas units.
const solid = (c, a = 1) => { const v = [...col(c), a]; return () => v; };
const vgrad = (top, bottom, y0, y1, a = 1) => {
  const t0 = col(top); const b0 = col(bottom);
  return (x, y) => [...mix(t0, b0, Math.max(0, Math.min(1, (y - y0) / (y1 - y0)))), a];
};
const shade = (c, y0, y1, a = 1) => vgrad(lighten(col(c), 0.3), darken(col(c), 0.12), y0, y1, a);
const radial = (inner, outer, cx, cy, r, a0 = 1, a1 = 1) => {
  const i0 = col(inner); const o0 = col(outer);
  return (x, y) => {
    const t = Math.min(1, Math.hypot(x - cx, y - cy) / r);
    return [...mix(i0, o0, t), a0 + (a1 - a0) * t];
  };
};

// ---------------------------------------------------------------- shapes (arrays of contours)
const ellipse = (cx, cy, rx, ry, rot = 0, n = 96) => {
  const pts = [];
  const c = Math.cos(rot); const s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.cos(t) * rx; const y = Math.sin(t) * ry;
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
};
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const roundRect = (x, y, w, h, r) => {
  const pts = [];
  const corners = [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = ((a0 + (i / 8) * 90) * Math.PI) / 180;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
};
const star = (cx, cy, R, r, n = 5, rot = -Math.PI / 2) => {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const rr = i % 2 ? r : R;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
};
const heart = (cx, cy, s) => {
  const pts = [];
  for (let i = 0; i < 80; i++) {
    const t = (i / 80) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + (x * s) / 16, cy - (y * s) / 16]);
  }
  return pts;
};
const bezier = (p0, p1, p2, p3, n = 24) => {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n; const u = 1 - t;
    pts.push([0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]));
  }
  return pts;
};
const rotate = (pts, cx, cy, a) => {
  const c = Math.cos(a); const s = Math.sin(a);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};
const mirror = (pts) => pts.map(([x, y]) => [2 * HX - x, y]).reverse();
// A thick polyline: one quad per segment plus round joints, as separate parts (unioned).
const stroke = (pts, width) => {
  const parts = [];
  const r = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]; const [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * r; const ny = ((bx - ax) / len) * r;
    parts.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]]);
  }
  for (const [x, y] of pts) parts.push([ellipse(x, y, r, r, 0, 16)]);
  return parts;
};
// Annulus (or partial arc band) of an ellipse, optionally rotated.
const ring = (cx, cy, rx, ry, w, rot = 0, a0 = 0, a1 = Math.PI * 2) => {
  const n = 96; const outer = []; const inner = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    outer.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    inner.push([cx + Math.cos(t) * (rx - w), cy + Math.sin(t) * (ry - w)]);
  }
  const full = a1 - a0 >= Math.PI * 2 - 1e-9;
  const parts = full ? [[outer, inner]] : [[[...outer, ...inner.reverse()]]];
  return parts.map((p) => p.map((c) => rotate(c, cx, cy, rot)));
};

// ---------------------------------------------------------------- raster
class Canvas {
  constructor() {
    this.W = W * SS; this.H = H * SS;
    this.px = new Float32Array(this.W * this.H * 4); // premultiplied, 0..1
  }

  /**
   * shape: a contour, or an array of parts; each part is an array of contours filled even-odd,
   * parts are unioned. mode: 'over' | 'atop' (only where already painted) | 'erase'.
   */
  fill(shape, paint, mode = 'over') {
    const parts = typeof shape[0][0] === 'number' ? [[shape]] : typeof shape[0][0][0] === 'number' ? [shape] : shape;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const part of parts) {
      for (const c of part) {
        for (const [x, y] of c) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    const x0 = Math.max(0, Math.floor(minX * SS)); const x1 = Math.min(this.W - 1, Math.ceil(maxX * SS));
    const y0 = Math.max(0, Math.floor(minY * SS)); const y1 = Math.min(this.H - 1, Math.ceil(maxY * SS));
    if (x1 < x0 || y1 < y0) return;
    const row = new Uint8Array(x1 - x0 + 1);
    const p = this.px;
    for (let py = y0; py <= y1; py++) {
      row.fill(0);
      const sy = (py + 0.5) / SS;
      for (const part of parts) {
        const xs = [];
        for (const c of part) {
          for (let i = 0; i < c.length; i++) {
            const [ax, ay] = c[i]; const [bx, by] = c[(i + 1) % c.length];
            if ((ay <= sy) !== (by <= sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a = Math.max(x0, Math.ceil(xs[k] * SS - 0.5)); const b = Math.min(x1, Math.floor(xs[k + 1] * SS - 0.5));
          for (let px = a; px <= b; px++) row[px - x0] = 1;
        }
      }
      for (let i = 0; i < row.length; i++) {
        if (!row[i]) continue;
        const px = x0 + i;
        const o = (py * this.W + px) * 4;
        const [r, g, b, a] = paint((px + 0.5) / SS, sy);
        if (a <= 0) continue;
        const sr = (r / 255) * a; const sg = (g / 255) * a; const sb = (b / 255) * a;
        if (mode === 'over') {
          p[o] = sr + p[o] * (1 - a); p[o + 1] = sg + p[o + 1] * (1 - a); p[o + 2] = sb + p[o + 2] * (1 - a); p[o + 3] = a + p[o + 3] * (1 - a);
        } else if (mode === 'atop') {
          const da = p[o + 3];
          p[o] = sr * da + p[o] * (1 - a); p[o + 1] = sg * da + p[o + 1] * (1 - a); p[o + 2] = sb * da + p[o + 2] * (1 - a);
        } else {
          for (let k = 0; k < 4; k++) p[o + k] *= 1 - a;
        }
      }
    }
  }

  /** Paints another canvas on top of this one. */
  draw(other) {
    const p = this.px; const q = other.px;
    for (let o = 0; o < p.length; o += 4) {
      const a = q[o + 3];
      if (a === 0) continue;
      for (let k = 0; k < 4; k++) p[o + k] = q[o + k] + p[o + k] * (1 - a);
    }
  }

  /** Downsampled to W x H, premultiplied floats. */
  reduce() {
    const out = new Float32Array(W * H * 4);
    const n = SS * SS;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let k = 0; k < 4; k++) {
          let s = 0;
          for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += this.px[(((y * SS + j) * this.W) + x * SS + i) * 4 + k];
          out[(y * W + x) * 4 + k] = s / n;
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- post effects (final size)
function dilate(alpha, r) {
  const out = new Float32Array(W * H);
  const R = Math.ceil(r) + 1;
  const offs = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const w = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(dx, dy)));
      if (w > 0) offs.push([dx, dy, w]);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (const [dx, dy, w] of offs) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const v = alpha[yy * W + xx] * w;
        if (v > m) m = v;
      }
      out[y * W + x] = m;
    }
  }
  return out;
}

function blur(alpha, r) {
  let a = alpha;
  for (let pass = 0; pass < 3; pass++) {
    const h = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += a[y * W + Math.max(0, Math.min(W - 1, x + i))];
        h[y * W + x] = s / (2 * r + 1);
      }
    }
    const v = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += h[Math.max(0, Math.min(H - 1, y + i)) * W + x];
        v[y * W + x] = s / (2 * r + 1);
      }
    }
    a = v;
  }
  return a;
}

/** Sticker outline (+ optional glow) under the art, then 8-bit RGBA. */
function finish(item, opts) {
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = item[i * 4 + 3];
  const layers = [];
  if (opts.glow) {
    const g = blur(alpha, 5);
    const c = col(opts.glow).map((v) => v / 255);
    layers.push((i) => { const a = Math.min(1, g[i] * 1.6) * 0.85; return [c[0] * a, c[1] * a, c[2] * a, a]; });
  }
  if (opts.outline !== 0) {
    const d = dilate(alpha, opts.outline ?? 2);
    const c = col(opts.outlineColor || '#3b2a36').map((v) => v / 255);
    layers.push((i) => [c[0] * d[i], c[1] * d[i], c[2] * d[i], d[i]]);
  }
  const out = { w: W, h: H, px: Buffer.alloc(W * H * 4) };
  for (let i = 0; i < W * H; i++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (const layer of [...layers, (j) => [item[j * 4], item[j * 4 + 1], item[j * 4 + 2], item[j * 4 + 3]]]) {
      const [lr, lg, lb, la] = layer(i);
      r = lr + r * (1 - la); g = lg + g * (1 - la); b = lb + b * (1 - la); a = la + a * (1 - la);
    }
    if (a > 0) {
      out.px[i * 4] = Math.round(Math.min(1, r / a) * 255);
      out.px[i * 4 + 1] = Math.round(Math.min(1, g / a) * 255);
      out.px[i * 4 + 2] = Math.round(Math.min(1, b / a) * 255);
      out.px[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return out;
}

// Deterministic randomness so re-running gives the same pictures.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- small parts
const WHITE = '#ffffff';
const INK = '#3b2a36';
function shine(c, x, y, rx, ry, rot = -0.5, a = 0.55) {
  c.fill(ellipse(x, y, rx, ry, rot), solid(WHITE, a));
}
function face(c, x, y, s = 1, blush = '#ff8fa3') {
  c.fill(ellipse(x - 7 * s, y, 2.6 * s, 3.6 * s), solid(INK));
  c.fill(ellipse(x + 7 * s, y, 2.6 * s, 3.6 * s), solid(INK));
  c.fill(circle(x - 6.2 * s, y - 1.3 * s, 0.9 * s), solid(WHITE));
  c.fill(circle(x + 7.8 * s, y - 1.3 * s, 0.9 * s), solid(WHITE));
  c.fill(stroke(bezier([x - 3 * s, y + 4 * s], [x - 1.5 * s, y + 6.5 * s], [x + 1.5 * s, y + 6.5 * s], [x + 3 * s, y + 4 * s], 8), 1.4 * s), solid(INK));
  c.fill(ellipse(x - 12 * s, y + 4.5 * s, 3.4 * s, 2 * s), solid(blush, 0.6));
  c.fill(ellipse(x + 12 * s, y + 4.5 * s, 3.4 * s, 2 * s), solid(blush, 0.6));
}
function sparkle(c, x, y, r, color = '#fff6c2', a = 1) {
  c.fill(star(x, y, r, r * 0.28, 4, 0), solid(color, a));
}
function gem(c, x, y, r, color) {
  const k = col(color);
  c.fill(star(x, y, r, r * 0.92, 4, 0), radial(lighten(k, 0.55), darken(k, 0.2), x - r * 0.3, y - r * 0.3, r * 1.4));
  c.fill(star(x - r * 0.25, y - r * 0.25, r * 0.35, r * 0.12, 4, 0), solid(WHITE, 0.9));
}
function balloonString(c, x0, y0, x1, y1, bend = 18) {
  c.fill(stroke(bezier([x0, y0], [x0 - bend, y0 + (y1 - y0) * 0.35], [x1 + bend, y1 - (y1 - y0) * 0.35], [x1, y1]), 1.8), solid('#8a7f88'));
}
function cloudShape(cx, cy, s = 1) {
  return [[circle(cx - 22 * s, cy + 4 * s, 17 * s)], [circle(cx, cy - 6 * s, 23 * s)], [circle(cx + 22 * s, cy + 3 * s, 17 * s)],
    [circle(cx + 4 * s, cy + 10 * s, 19 * s)], [roundRect(cx - 36 * s, cy + 2 * s, 72 * s, 22 * s, 11 * s)]];
}
const GOLD = ['#fff1a8', '#f6c445', '#c98a14'];
const goldPaint = (y0, y1) => vgrad(GOLD[0], GOLD[2], y0, y1);

// ---------------------------------------------------------------- items
// Common
function partyHat(c, color, dot) {
  const L = new Canvas();
  const base = HY + 18;
  const tri = rotate([[HX - 36, base], [HX + 8, HY - 56], [HX + 36, base]], HX, base, -0.12);
  L.fill(tri, shade(color, HY - 56, base));
  for (const [t, u] of [[0.25, 0.35], [0.55, 0.62], [0.45, 0.15], [0.78, 0.4], [0.8, 0.82], [0.62, 0.38]]) {
    const [ax, ay] = tri[1]; const [bx, by] = tri[0]; const [cx, cy] = tri[2];
    const lx = ax + (bx - ax) * t; const ly = ay + (by - ay) * t; const rx = ax + (cx - ax) * t; const ry = ay + (cy - ay) * t;
    L.fill(circle(lx + (rx - lx) * u, ly + (ry - ly) * u, 4.5), solid(dot), 'atop');
  }
  c.draw(L);
  const [bl, , br] = tri;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    c.fill(circle(bl[0] + (br[0] - bl[0]) * t, bl[1] + (br[1] - bl[1]) * t, 6.5), solid('#fffaf0'));
  }
  c.fill(circle(tri[1][0], tri[1][1], 9), shade(dot, tri[1][1] - 9, tri[1][1] + 9));
  shine(c, tri[1][0] - 3, tri[1][1] - 3, 3, 2);
}

function beanie(c, color) {
  const L = new Canvas();
  const dome = [];
  for (let i = 0; i <= 48; i++) { const t = Math.PI + (i / 48) * Math.PI; dome.push([HX + Math.cos(t) * 58, HY + 22 + Math.sin(t) * 50]); }
  L.fill(dome, shade(color, HY - 28, HY + 22));
  for (let x = -40; x <= 40; x += 16) L.fill(stroke([[HX + x * 0.7, HY - 22], [HX + x, HY + 20]], 3), solid(darken(col(color), 0.12)), 'atop');
  c.draw(L);
  c.fill(roundRect(HX - 62, HY + 8, 124, 24, 11), shade(lighten(col(color), 0.15), HY + 8, HY + 32));
  for (let x = -52; x <= 52; x += 10) c.fill(stroke([[HX + x, HY + 12], [HX + x, HY + 28]], 2.2), solid(darken(col(color), 0.08)));
  c.fill(circle(HX, HY - 30, 15), shade('#fbf7ef', HY - 45, HY - 15));
  shine(c, HX - 28, HY - 6, 10, 5, -0.6, 0.35);
}

function hairBow(c, color) {
  const cx = HX + 44; const cy = HY + 4;
  const k = col(color);
  c.fill(rotate([[cx - 4, cy + 4], [cx - 16, cy + 32], [cx - 6, cy + 28], [cx, cy + 36], [cx + 2, cy + 6]], cx, cy, 0.1), shade(darken(k, 0.08), cy, cy + 36));
  c.fill(rotate([[cx + 2, cy + 4], [cx + 18, cy + 30], [cx + 9, cy + 28], [cx + 6, cy + 36], [cx - 2, cy + 6]], cx, cy, 0.1), shade(darken(k, 0.08), cy, cy + 36));
  c.fill(ellipse(cx - 20, cy - 2, 22, 14, -0.35), shade(k, cy - 16, cy + 12));
  c.fill(ellipse(cx + 20, cy - 2, 22, 14, 0.35), shade(k, cy - 16, cy + 12));
  c.fill(ellipse(cx - 18, cy - 1, 10, 5, -0.35), solid(darken(k, 0.2), 0.5));
  c.fill(ellipse(cx + 18, cy - 1, 10, 5, 0.35), solid(darken(k, 0.2), 0.5));
  c.fill(ellipse(cx, cy, 8, 9), shade(lighten(k, 0.1), cy - 9, cy + 9));
  shine(c, cx - 26, cy - 8, 6, 3);
}

function catEars(c, color) {
  const k = col(color);
  const ear = [[HX - 64, HY + 22], [HX - 54, HY - 36], [HX - 16, HY + 4]];
  const inner = [[HX - 56, HY + 14], [HX - 51, HY - 22], [HX - 28, HY + 4]];
  for (const m of [(p) => p, mirror]) {
    c.fill(m(ear), shade(k, HY - 36, HY + 22));
    c.fill(m(inner), solid('#ffb3c4'));
  }
}

function flowerPin(c, color) {
  const cx = HX - 50; const cy = HY + 10;
  c.fill(ellipse(cx - 6, cy + 18, 11, 5, 0.6), shade('#7cc46b', cy + 12, cy + 24));
  c.fill(ellipse(cx + 14, cy + 14, 11, 5, -0.4), shade('#7cc46b', cy + 8, cy + 20));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    c.fill(ellipse(cx + Math.cos(a) * 12, cy + Math.sin(a) * 12, 11, 7.5, a), shade(color, cy - 22, cy + 22));
  }
  c.fill(circle(cx, cy, 8), radial('#fff3a0', '#f2b134', cx - 2, cy - 2, 10));
}

function balloon(c, color) {
  const cx = 292; const cy = 58;
  balloonString(c, cx, cy + 38, 262, 215);
  c.fill([[cx - 5, cy + 40], [cx + 5, cy + 40], [cx, cy + 33]], solid(darken(col(color), 0.15)));
  c.fill(ellipse(cx, cy, 28, 34), radial(lighten(col(color), 0.35), darken(col(color), 0.1), cx - 10, cy - 12, 44));
  shine(c, cx - 11, cy - 14, 6, 11, 0.4, 0.6);
}

function antenna(c, color) {
  for (const s of [-1, 1]) {
    const pts = bezier([HX + 18 * s, HY + 12], [HX + 22 * s, HY - 10], [HX + 40 * s, HY - 24], [HX + 42 * s, HY - 44]);
    c.fill(stroke(pts, 3.5), solid('#4a3f48'));
    const [x, y] = pts[pts.length - 1];
    c.fill(circle(x, y, 10), radial(lighten(col(color), 0.4), col(color), x - 3, y - 3, 12));
    shine(c, x - 3, y - 4, 3, 2);
  }
}

function sprout(c, leaf, petal) {
  c.fill(stroke(bezier([HX, HY + 10], [HX - 2, HY - 4], [HX + 6, HY - 14], [HX + 4, HY - 26]), 3.5), solid('#5e9e4f'));
  c.fill(ellipse(HX - 10, HY - 32, 16, 8, -0.55), shade(leaf, HY - 42, HY - 22));
  c.fill(ellipse(HX + 18, HY - 34, 16, 8, 0.5), shade(leaf, HY - 44, HY - 24));
  c.fill(stroke([[HX - 22, HY - 24], [HX - 2, HY - 36]], 1.2), solid(darken(col(leaf), 0.25), 0.6));
  c.fill(stroke([[HX + 6, HY - 30], [HX + 30, HY - 40]], 1.2), solid(darken(col(leaf), 0.25), 0.6));
  if (petal) c.fill(circle(HX + 4, HY - 28, 6), radial(lighten(col(petal), 0.4), col(petal), HX + 2, HY - 30, 7));
}

// Rare
function topHat(c, body, band) {
  const L = new Canvas();
  const tilt = (pts) => rotate(pts, HX, HY + 14, -0.12);
  L.fill(tilt(ellipse(HX, HY + 14, 54, 11)), shade(body, HY + 3, HY + 25));
  L.fill(tilt([[HX - 32, HY + 12], [HX - 35, HY - 52], [HX + 35, HY - 52], [HX + 32, HY + 12]]), shade(body, HY - 52, HY + 12));
  L.fill(tilt(rect(HX - 34, HY - 6, 68, 14)), shade(band, HY - 6, HY + 8));
  L.fill(tilt(ellipse(HX, HY - 52, 35, 7)), solid(lighten(col(body), 0.18)));
  c.draw(L);
  shine(c, HX - 22, HY - 28, 4, 16, -0.12, 0.25);
  const [fx, fy] = tilt([[HX + 24, HY - 4]])[0];
  c.fill(ellipse(fx + 6, fy - 18, 5, 18, 0.35), shade(lighten(col(band), 0.2), fy - 36, fy));
}

function bunnyEars(c, color) {
  const k = col(color);
  c.fill(stroke(ellipse(HX, HY + 44, 62, 52).slice(56, 89), 7), solid(darken(k, 0.25)));
  for (const [x, rot] of [[HX - 24, -0.22], [HX + 26, 0.28]]) {
    c.fill(ellipse(x, HY - 30, 15, 46, rot), shade(k, HY - 76, HY + 16));
    c.fill(ellipse(x, HY - 26, 7, 34, rot), solid('#ffb7c9', 0.9));
  }
}

function witchHat(c, color, band) {
  const L = new Canvas();
  const tip = [HX + 58, HY - 70];
  const cone = [...bezier([HX - 38, HY + 10], [HX - 26, HY - 40], [HX + 10, HY - 70], tip), ...bezier(tip, [HX + 20, HY - 50], [HX + 36, HY - 20], [HX + 38, HY + 10]).slice(1)];
  c.fill(ellipse(HX, HY + 14, 72, 14), shade(color, HY, HY + 28));
  L.fill(cone, shade(color, HY - 70, HY + 10));
  L.fill(rect(HX - 60, HY - 6, 120, 14), shade(band, HY - 6, HY + 8), 'atop');
  c.draw(L);
  c.fill([...rect(HX - 9, HY - 8, 18, 18)], solid(GOLD[1]));
  c.fill([...rect(HX - 4, HY - 3, 8, 8)], solid(darken(col(band), 0.1)));
  c.fill(star(HX + 22, HY - 36, 7, 3), solid(GOLD[0]));
}

function starBuddy(c, color) {
  const cx = 290; const cy = 62;
  for (const [x, y, r] of [[256, 92, 3], [244, 110, 2.4], [234, 126, 1.8]]) c.fill(circle(x, y, r), solid(color, 0.8));
  c.fill(rotate(star(cx, cy, 32, 15), cx, cy, 0.15), radial(lighten(col(color), 0.45), darken(col(color), 0.08), cx - 8, cy - 8, 36));
  face(c, cx + 1, cy + 2, 0.75);
  sparkle(c, 320, 28, 7);
  sparkle(c, 250, 40, 5);
}

function heartBalloons(c, colors) {
  const tie = [272, 210];
  const spots = [[278, 42, 22], [310, 74, 18], [252, 82, 18]];
  for (const [x, y] of spots) balloonString(c, x, y + 16, tie[0], tie[1], 8);
  spots.forEach(([x, y, s], i) => {
    c.fill(heart(x, y, s), radial(lighten(col(colors[i]), 0.35), col(colors[i]), x - s * 0.4, y - s * 0.4, s * 1.5));
    shine(c, x - s * 0.45, y - s * 0.35, s * 0.18, s * 0.3, 0.5);
  });
}

function slime(c, color) {
  const cx = 48; const cy = 284;
  const body = ellipse(cx, cy, 36, 30).map(([x, y]) => [x, Math.min(y, cy + 22)]);
  c.fill(body, radial(lighten(col(color), 0.4), darken(col(color), 0.05), cx - 10, cy - 14, 44, 0.92, 0.92));
  c.fill(ellipse(cx + 22, cy + 22, 7, 4), solid(color, 0.85));
  shine(c, cx - 16, cy - 14, 8, 5, -0.6, 0.7);
  face(c, cx + 2, cy, 1.05);
}

function cloudBuddy(c, kind) {
  const cx = 46; const cy = 92;
  const style = {
    cotton: ['#fff4fb', '#ffc6e3'], rain: ['#eef2f7', '#a8b4c6'], storm: ['#a9aec0', '#5c6178'], sunny: ['#ffffff', '#d6e6f5'],
  }[kind];
  if (kind === 'sunny') {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      c.fill(rotate([[cx + 24, cy - 40], [cx + 28, cy - 62], [cx + 32, cy - 40]], cx + 28, cy - 26, a), solid('#ffb733'));
    }
    c.fill(circle(cx + 28, cy - 26, 20), radial('#fff3a0', '#ffb733', cx + 22, cy - 32, 24));
  }
  if (kind === 'rain') for (const [x, y] of [[cx - 22, cy + 38], [cx, cy + 46], [cx + 20, cy + 36]]) c.fill([...bezier([x, y - 9], [x + 1, y - 4], [x + 6, y], [x, y + 5], 8), ...bezier([x, y + 5], [x - 6, y], [x - 1, y - 4], [x, y - 9], 8)], solid('#6fb6ff'));
  if (kind === 'storm') c.fill([[cx - 2, cy + 22], [cx + 14, cy + 22], [cx + 6, cy + 36], [cx + 16, cy + 36], [cx - 6, cy + 62], [cx + 2, cy + 42], [cx - 8, cy + 42]], solid('#ffd84a'));
  c.fill(cloudShape(cx, cy), vgrad(style[0], style[1], cy - 30, cy + 24));
  face(c, cx, cy + 4, 0.8, kind === 'storm' ? '#c9a0ff' : '#ff8fa3');
}

// Epic
function crown(c, gemColor, h = 1, w = 1) {
  const L = new Canvas();
  const pts = [[HX - 46 * w, HY + 14], [HX - 52 * w, HY - 30 * h], [HX - 26 * w, HY - 6 * h], [HX, HY - 44 * h], [HX + 26 * w, HY - 6 * h], [HX + 52 * w, HY - 30 * h], [HX + 46 * w, HY + 14]];
  L.fill(pts, goldPaint(HY - 44 * h, HY + 14));
  L.fill(rect(HX - 60 * w, HY + 1, 120 * w, 13), solid(GOLD[2], 0.55), 'atop');
  c.draw(L);
  for (const i of [1, 3, 5]) c.fill(circle(pts[i][0], pts[i][1], 6), radial(GOLD[0], GOLD[1], pts[i][0] - 2, pts[i][1] - 2, 7));
  gem(c, HX, HY + 7, 8, gemColor);
  for (const s of [-1, 1]) c.fill(circle(HX + 28 * w * s, HY + 8, 4.5), radial(lighten(col(gemColor), 0.5), col(gemColor), HX + 28 * w * s - 1, HY + 7, 5));
  shine(c, HX - 30 * w, HY - 10, 3, 9, 0.3, 0.45);
}

function halo(c, color) {
  c.fill(ring(HX, HY - 28, 58, 16, 9), vgrad(lighten(col(color), 0.6), col(color), HY - 44, HY - 12));
}

// One wing per side: feathers fanning out from the shoulder, from straight up to horizontal.
// elev = angle above the horizontal, pointing away from the body.
function wing(c, s, ox, oy, elev0, step, n, len, width, paint, edge) {
  for (let i = 0; i < n; i++) {
    const e = elev0 - i * step;
    const l = len - i * (len * 0.07);
    const ux = Math.cos(e) * s; const uy = -Math.sin(e);
    if (edge) c.fill(ellipse(ox + ux * l * 0.55, oy + uy * l * 0.55, l * 0.55 + 1.6, width + 1.6, Math.atan2(uy, ux)), solid(edge));
    c.fill(ellipse(ox + ux * l * 0.55, oy + uy * l * 0.55, l * 0.55, width, Math.atan2(uy, ux)), paint(ox, oy, l));
  }
}

function angelWings(c, color, tip) {
  const k = col(color); const t = col(tip);
  for (const s of [-1, 1]) {
    const ox = HX + 34 * s; const oy = 200;
    wing(c, s, ox, oy, 1.35, 0.25, 7, 112, 13, (x, y, l) => radial(k, mix(k, t, 0.85), x, y, l));
    wing(c, s, ox, oy, 1.2, 0.28, 5, 40, 12, () => solid(lighten(k, 0.35)));
  }
}

function horns(c, color) {
  const k = col(color);
  const horn = [...bezier([HX - 48, HY + 18], [HX - 68, HY - 4], [HX - 74, HY - 30], [HX - 60, HY - 48]), ...bezier([HX - 60, HY - 48], [HX - 56, HY - 22], [HX - 42, HY - 2], [HX - 24, HY + 10]).slice(1)];
  for (const m of [(p) => p, mirror]) {
    c.fill(m(horn), vgrad(lighten(k, 0.45), darken(k, 0.1), HY - 48, HY + 18));
    for (const y of [-26, -12, 2]) c.fill(stroke(m([[HX - 70, HY + y], [HX - 40, HY + y + 6]]), 1.6), solid(darken(k, 0.25), 0.35), 'atop');
  }
}

function moonNight(c, moon, stars) {
  const L = new Canvas();
  L.fill(circle(292, 62, 30), radial(lighten(col(moon), 0.4), col(moon), 280, 50, 40));
  L.fill(circle(306, 50, 26), solid(WHITE), 'erase');
  c.draw(L);
  c.fill(ellipse(273, 66, 2.5, 1.2), solid(INK));
  c.fill(ellipse(276, 76, 3, 1.6), solid('#ff8fa3', 0.6));
  for (const [x, y, r] of [[252, 32, 8], [322, 104, 6], [248, 98, 5], [318, 20, 4]]) c.fill(star(x, y, r, r * 0.45), solid(stars));
}

function sparkleAura(c, color) {
  const rand = rng(hashStr(color));
  const spots = [[34, 70, 12], [304, 128, 10], [24, 196, 8], [318, 236, 12], [62, 140, 6], [272, 48, 9], [20, 292, 10], [312, 310, 7], [84, 40, 7], [252, 176, 5], [44, 250, 5], [296, 70, 5]];
  for (const [x, y, r] of spots) sparkle(c, x, y, r, color);
  for (let i = 0; i < 14; i++) c.fill(circle(10 + rand() * 316, 30 + rand() * 290, 1.5 + rand() * 1.8), solid(color, 0.85));
}

// Legendary
function grandCrown(c, gold, velvet, gems) {
  const [g0, g1, g2] = gold;
  const gp = vgrad(g0, g2, HY - 70, HY + 16);
  const dome = [];
  for (let i = 0; i <= 40; i++) { const t = Math.PI + (i / 40) * Math.PI; dome.push([HX + Math.cos(t) * 50, HY + 4 + Math.sin(t) * 56]); }
  c.fill(dome, radial(lighten(col(velvet), 0.3), darken(col(velvet), 0.2), HX - 14, HY - 30, 70));
  for (const s of [-1, 0, 1]) {
    const pts = s === 0 ? [[HX, HY + 2], [HX, HY - 52]] : bezier([HX + 50 * s, HY + 2], [HX + 54 * s, HY - 30], [HX + 26 * s, HY - 52], [HX, HY - 52]);
    c.fill(stroke(pts, 7), gp);
    for (let i = 4; i < pts.length - 1; i += 6) c.fill(circle(pts[i][0], pts[i][1], 3), solid(WHITE, 0.9));
  }
  c.fill(circle(HX, HY - 58, 9), radial(g0, g1, HX - 3, HY - 61, 10));
  c.fill(stroke([[HX, HY - 66], [HX, HY - 84]], 4.5), gp);
  c.fill(stroke([[HX - 8, HY - 76], [HX + 8, HY - 76]], 4.5), gp);
  c.fill(roundRect(HX - 58, HY - 2, 116, 20, 6), vgrad(g0, g2, HY - 2, HY + 18));
  gems.forEach((g, i) => gem(c, HX + (i - (gems.length - 1) / 2) * 26, HY + 8, i === (gems.length - 1) / 2 ? 9 : 6, g));
}

function butterflyWings(c, paintFor, spot) {
  const lobes = [[-92, 132, 70, 40, -0.55], [-74, 244, 50, 30, 0.6]];
  for (const s of [-1, 1]) {
    const L = new Canvas();
    for (const [dx, y, rx, ry, rot] of lobes) L.fill(ellipse(HX + dx * s, y, rx, ry, rot * s), paintFor(s));
    for (const [dx, y, rx, ry, rot] of lobes) L.fill(ring(HX + dx * s, y, rx, ry, 6, rot * s), solid(INK, 0.55), 'atop');
    for (const [dx, y, r] of [[-140, 108, 6], [-122, 92, 5], [-104, 262, 5], [-152, 136, 4], [-88, 76, 4]]) L.fill(circle(HX + dx * s, y, r), solid(spot, 0.95), 'atop');
    for (const [dx, y] of [[-140, 100], [-104, 262], [-120, 170], [-70, 84]]) L.fill(stroke([[HX + 10 * s, 196], [HX + dx * s, y]], 2), solid(INK, 0.35), 'atop');
    c.draw(L);
  }
}

function flameAura(c, colors) {
  const [core, mid, edge] = colors.map(col);
  for (const [scale, a] of [[1, 0.9], [0.78, 1]]) {
    const pts = [];
    for (let i = 0; i < 180; i++) {
      const t = (i / 180) * Math.PI * 2;
      const up = Math.max(0, -Math.sin(t));
      const r = (118 + 16 * Math.sin(7 * t) + 10 * Math.sin(13 * t + 1)) * scale;
      pts.push([HX + Math.cos(t) * r * 1.05, 214 + Math.sin(t) * r * (1 + up * 0.35) - up * 30 * scale]);
    }
    c.fill(pts, (x, y) => {
      const d = Math.min(1, Math.hypot(x - HX, (y - 214) * 0.8) / (150 * scale));
      return [...(d < 0.6 ? mix(core, mid, d / 0.6) : mix(mid, edge, (d - 0.6) / 0.4)), a];
    });
  }
}

function planet(c) {
  const cx = 288; const cy = 64;
  const rot = -0.35;
  c.fill(ring(cx, cy, 46, 13, 6, rot, Math.PI, Math.PI * 2), solid('#e9c88f'));
  c.fill(circle(cx, cy, 25), radial('#ffd7a6', '#d9824a', cx - 8, cy - 8, 32));
  c.fill(ring(cx, cy - 2, 25, 6, 3, rot), solid('#b8653a', 0.4), 'atop');
  c.fill(ring(cx, cy, 46, 13, 6, rot, 0, Math.PI), solid('#f5dcae'));
  c.fill(circle(242, 32, 7), radial('#ffffff', '#bfc8d6', 240, 30, 8));
  face(c, cx, cy + 2, 0.7);
}

function rainbowArch(c) {
  const bands = ['#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#4dabf7', '#9775fa'];
  bands.forEach((b, i) => c.fill(ring(HX, 236, 158 - i * 10, 170 - i * 10, 10, 0, Math.PI, Math.PI * 2), solid(b)));
  for (const x of [26, 310]) c.fill(cloudShape(x, 232, 0.9), vgrad('#ffffff', '#dbe7f5', 205, 255));
}

function starRing(c) {
  for (let i = 0; i < 9; i++) {
    const t = (i / 9) * Math.PI * 2;
    const depth = (Math.sin(t) + 1) / 2;
    const x = HX + Math.cos(t) * 66; const y = HY - 26 + Math.sin(t) * 16;
    c.fill(star(x, y, 6 + depth * 6, 3 + depth * 2.6), radial('#fffbe0', '#f6c445', x - 2, y - 2, 12, 0.7 + depth * 0.3, 0.7 + depth * 0.3));
  }
}

// Mythic
function seraph(c) {
  c.fill(ring(HX, 118, 92, 92, 9), vgrad('#fff6c8', '#e8a71c', 26, 210));
  const paint = (x, y, l) => radial('#ffffff', '#ffe9a8', x, y, l);
  for (const s of [-1, 1]) {
    wing(c, s, HX + 28 * s, 170, 1.25, 0.16, 5, 96, 12, paint, '#e0a526');
    wing(c, s, HX + 28 * s, 202, 0.45, 0.14, 7, 134, 13, paint, '#e0a526');
    wing(c, s, HX + 28 * s, 234, -0.35, 0.16, 5, 92, 12, paint, '#e0a526');
  }
}

function galaxy(c) {
  const rand = rng(7);
  c.fill(circle(HX, 196, 160), (x, y) => {
    const d = Math.hypot(x - HX, y - 196) / 160;
    return [...mix(hex('#3a2a8c'), hex('#0d0b2e'), d), Math.min(1, (1 - d) * 3) * 0.95];
  });
  for (const [x, y, rx, ry, cc] of [[110, 140, 70, 30, '#ff6ec7'], [230, 250, 80, 34, '#4dd8ff'], [200, 120, 50, 22, '#b48cff']]) {
    c.fill(ellipse(x, y, rx, ry, -0.5), radial(cc, cc, x, y, rx, 0.45, 0));
  }
  for (let i = 0; i < 90; i++) {
    const a = rand() * Math.PI * 2; const r = Math.sqrt(rand()) * 150;
    c.fill(circle(HX + Math.cos(a) * r, 196 + Math.sin(a) * r, 0.6 + rand() * 1.6), solid(rand() < 0.2 ? '#fff3a0' : WHITE, 0.6 + rand() * 0.4));
  }
  for (const [x, y, r] of [[56, 96, 10], [292, 150, 12], [80, 300, 8], [260, 300, 9], [168, 40, 9]]) sparkle(c, x, y, r, '#fff6c2');
  c.fill(ring(HX, 196, 162, 162, 3), solid('#b9a8ff', 0.8));
}

function rainbowHalo(c) {
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    c.fill(rotate([[HX - 7, 124], [HX, 124 - 160], [HX + 7, 124]], HX, 124, a), radial('#fff6c8', '#fff6c8', HX, 124, 160, 0.55, 0));
  }
  const bands = ['#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#4dabf7', '#9775fa'];
  bands.forEach((b, i) => c.fill(ring(HX, 124, 120 - i * 8, 120 - i * 8, 6), solid(b, 0.95)));
  for (const [x, y, r] of [[40, 60, 10], [300, 52, 12], [26, 210, 8], [312, 220, 9]]) sparkle(c, x, y, r);
}

function godCrown(c) {
  crown(c, '#ff4d6d', 1.5, 1.2);
  for (const [x, y, g, r] of [[HX - 96, HY - 10, '#4dabf7', 10], [HX + 96, HY - 10, '#69db7c', 10], [HX - 76, HY - 54, '#b48cff', 8], [HX + 78, HY - 56, '#ffd43b', 8]]) gem(c, x, y, r, g);
  for (const [x, y, r] of [[HX, HY - 86, 11], [HX - 120, HY + 30, 7], [HX + 120, HY + 28, 7]]) sparkle(c, x, y, r);
}

function hashStr(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- catalogue
// rarity: 0 普通, 1 稀有, 2 史诗, 3 传说, 4 神话 (names / odds live in app/src/decos.rs).
const ITEMS = [];
// slot: what it's worn as, one of each at a time: "head" 头饰 / "pet" 宠物 / "fx" 特效.
// The first 100 items predate slots; their slot follows from the id.
const slotOf = (id) => {
  if (/^(balloon|hearts|wings|moon|sparkle|butterfly|flame|rainbow|seraph|galaxy)/.test(id)) return 'fx';
  if (/^(star-(gold|pink|ice|moon)|slime|cloud|planet)/.test(id)) return 'pet';
  return 'head';
};
const add = (id, name, rarity, draw, opts = {}) => ITEMS.push({ id, name, rarity, slot: opts.slot || slotOf(id), layer: opts.layer || 'front', boss: opts.boss, draw, opts });
const C6 = [['red', '红', '#ff5a5a'], ['orange', '橙', '#ff9f43'], ['yellow', '黄', '#ffd43b'], ['green', '绿', '#51cf66'], ['blue', '蓝', '#4dabf7'], ['purple', '紫', '#b197fc']];

for (const [k, n, cc] of C6) add(`party-${k}`, `${n}色派对帽`, 0, (c) => partyHat(c, cc, k === 'yellow' ? '#ff6b9a' : '#fff3bf'));
for (const [k, n, cc] of [['red', '红', '#e8590c'], ['gray', '灰', '#adb5bd'], ['blue', '蓝', '#4c6ef5'], ['pink', '粉', '#f783ac'], ['green', '绿', '#40c057']]) add(`beanie-${k}`, `${n}色毛线帽`, 0, (c) => beanie(c, cc));
for (const [k, n, cc] of [['red', '红', '#fa5252'], ['pink', '粉', '#faa2c1'], ['blue', '蓝', '#74c0fc'], ['yellow', '黄', '#ffe066'], ['purple', '紫', '#b197fc'], ['black', '黑', '#495057']]) add(`bow-${k}`, `${n}色蝴蝶结`, 0, (c) => hairBow(c, cc));
for (const [k, n, cc] of [['white', '白', '#f8f9fa'], ['black', '黑', '#495057'], ['orange', '橘', '#ff922b'], ['gray', '灰', '#adb5bd']]) add(`cat-${k}`, `${n}猫耳朵`, 0, (c) => catEars(c, cc));
for (const [k, n, cc] of [['pink', '粉', '#ff8cc6'], ['white', '白', '#fdfdfd'], ['red', '红', '#ff6b6b'], ['blue', '蓝', '#74c0fc'], ['purple', '紫', '#c08cff']]) add(`flower-${k}`, `${n}色小花`, 0, (c) => flowerPin(c, cc));
for (const [k, n, cc] of C6) add(`balloon-${k}`, `${n}气球`, 0, (c) => balloon(c, cc));
for (const [k, n, cc] of [['red', '红', '#ff6b6b'], ['green', '绿', '#69db7c'], ['blue', '蓝', '#4dabf7'], ['yellow', '黄', '#ffd43b']]) add(`antenna-${k}`, `${n}色触角`, 0, (c) => antenna(c, cc));
for (const [k, n, leaf, petal] of [['green', '嫩芽', '#69db7c'], ['mint', '薄荷芽', '#63e6be'], ['sakura', '樱花芽', '#8ce99a', '#ffc2d9'], ['gold', '金叶芽', '#ffd43b']]) add(`sprout-${k}`, n, 0, (c) => sprout(c, leaf, petal));

for (const [k, n, body, band] of [['black', '绅士礼帽', '#343a40', '#e03131'], ['navy', '午夜礼帽', '#283a6e', '#f6c445'], ['white', '白色礼帽', '#f1f3f5', '#f783ac'], ['brown', '复古礼帽', '#7a5236', '#2f9e44']]) add(`tophat-${k}`, n, 1, (c) => topHat(c, body, band));
for (const [k, n, cc] of [['white', '白', '#f8f9fa'], ['pink', '粉', '#ffc9de'], ['brown', '棕', '#c08a5e'], ['black', '黑', '#5c5f66']]) add(`bunny-${k}`, `${n}兔耳朵`, 1, (c) => bunnyEars(c, cc));
for (const [k, n, cc, band] of [['purple', '紫', '#7048e8', '#ffd43b'], ['black', '黑', '#3b3b4f', '#e64980'], ['green', '绿', '#2b8a3e', '#fab005'], ['blue', '蓝', '#1c5fc2', '#ced4da']]) add(`witch-${k}`, `${n}色魔女帽`, 1, (c) => witchHat(c, cc, band));
for (const [k, n, cc] of [['gold', '金色', '#ffd43b'], ['pink', '粉色', '#ff8cc6'], ['ice', '冰蓝', '#74e0ff'], ['moon', '月白', '#f1f3f5']]) add(`star-${k}`, `${n}小星星`, 1, (c) => starBuddy(c, cc));
for (const [k, n, cs] of [['love', '恋爱', ['#ff4d6d', '#ff8fa3', '#ff4d6d']], ['candy', '糖果', ['#ff8cc6', '#74c0fc', '#ffe066']], ['ocean', '海洋', ['#4dabf7', '#3bc9db', '#748ffc']], ['rainbow', '彩虹', ['#ff6b6b', '#69db7c', '#9775fa']]]) add(`hearts-${k}`, `${n}心形气球`, 1, (c) => heartBalloons(c, cs));
for (const [k, n, cc] of [['green', '绿', '#69db7c'], ['blue', '蓝', '#4dabf7'], ['pink', '粉', '#faa2c1'], ['purple', '紫', '#b197fc']]) add(`slime-${k}`, `${n}史莱姆`, 1, (c) => slime(c, cc));
for (const [k, n] of [['cotton', '棉花糖云'], ['rain', '小雨云'], ['storm', '雷雨云'], ['sunny', '晴天云']]) add(`cloud-${k}`, n, 1, (c) => cloudBuddy(c, k));

for (const [k, n, g] of [['ruby', '红宝石', '#fa5252'], ['sapphire', '蓝宝石', '#339af0'], ['emerald', '翡翠', '#40c057'], ['amethyst', '紫晶', '#9c36b5']]) add(`crown-${k}`, `${n}王冠`, 2, (c) => crown(c, g), { glow: '#ffe8a3' });
for (const [k, n, cc, glow] of [['gold', '金色光环', '#f6c445', '#fff1a8'], ['silver', '银色光环', '#ced4da', '#ffffff'], ['pink', '粉色光环', '#ff8cc6', '#ffc2e0']]) add(`halo-${k}`, n, 2, (c) => halo(c, cc), { glow });
for (const [k, n, cc, tip] of [['angel', '天使之翼', '#ffffff', '#cfe3ff'], ['fallen', '堕天之翼', '#3b3555', '#7b5bd6'], ['sakura', '樱花之翼', '#fff0f6', '#ff9fc9']]) add(`wings-${k}`, n, 2, (c) => angelWings(c, cc, tip), { layer: 'back' });
for (const [k, n, cc] of [['devil', '恶魔角', '#e03131'], ['shadow', '暗影角', '#4c3b6b'], ['gold', '黄金角', '#f6c445']]) add(`horns-${k}`, n, 2, (c) => horns(c, cc));
for (const [k, n, moon, stars] of [['gold', '金月星夜', '#ffd43b', '#fff3bf'], ['silver', '银月星夜', '#dee2e6', '#a5d8ff']]) add(`moon-${k}`, n, 2, (c) => moonNight(c, moon, stars), { glow: stars });
for (const [k, n, cc] of [['gold', '金色闪光', '#ffe066'], ['ice', '冰晶闪光', '#a5f3ff'], ['pink', '粉色闪光', '#ffb3d9']]) add(`sparkle-${k}`, n, 2, (c) => sparkleAura(c, cc), { glow: cc, outline: 1.2 });

add('crown-emperor', '帝王之冠', 3, (c) => grandCrown(c, GOLD, '#c92a2a', ['#4dabf7', '#fa5252', '#40c057']), { glow: '#ffd43b' });
add('crown-frost', '冰雪王冠', 3, (c) => grandCrown(c, ['#ffffff', '#c5d8f0', '#7d93b8'], '#1c5fc2', ['#a5f3ff', '#e7f5ff', '#a5f3ff']), { glow: '#a5f3ff' });
add('butterfly-morpho', '蓝闪蝶之翼', 3, (c) => butterflyWings(c, () => radial('#a5f3ff', '#1c3faa', HX, 196, 150), '#e7f5ff'), { layer: 'back', glow: '#74c0fc' });
add('butterfly-monarch', '帝王蝶之翼', 3, (c) => butterflyWings(c, () => radial('#ffd8a8', '#e8590c', HX, 196, 140), '#ffffff'), { layer: 'back', glow: '#ffa94d' });
add('butterfly-prism', '幻彩蝶之翼', 3, (c) => butterflyWings(c, () => (x, y) => [...hsv(((Math.atan2(y - 196, x - HX) / Math.PI + 1) * 0.5 + Math.hypot(x - HX, y - 196) / 300) % 1, 0.45, 1), 1], '#ffffff'), { layer: 'back', glow: '#e599f7' });
add('flame-red', '烈焰光环', 3, (c) => flameAura(c, ['#fff3bf', '#ff922b', '#e03131']), { layer: 'back', glow: '#ff922b', outline: 0 });
add('flame-blue', '蓝焰光环', 3, (c) => flameAura(c, ['#e3fafc', '#3bc9db', '#5f3dc4']), { layer: 'back', glow: '#66d9e8', outline: 0 });
add('planet', '土星伙伴', 3, planet, { glow: '#ffd8a8' });
add('rainbow', '彩虹桥', 3, rainbowArch, { layer: 'back', glow: '#fff3bf' });
add('star-ring', '星环', 3, starRing, { glow: '#ffe066', outline: 1.4 });

add('seraph', '炽天使', 4, seraph, { layer: 'back', glow: '#ffe066' });
add('galaxy', '银河', 4, galaxy, { layer: 'back', glow: '#9775fa', outline: 0 });
add('rainbow-halo', '七彩圣环', 4, rainbowHalo, { layer: 'back', glow: '#fff3bf', outline: 0 });
add('crown-god', '神之冠', 4, godCrown, { glow: '#ffd43b' });

// ---------------------------------------------------------------- masks (头饰)
// Where the eyes are, averaged over the six characters (their faces sit a little left of
// centre); eye masks leave holes there so the eyes still show.
const EX = 150;
const EY = 176;
const mirrorAt = (pts, x0) => pts.map(([x, y]) => [2 * x0 - x, y]).reverse();

/** Draws on a fresh layer, then pastes it rotated by `a` and scaled by `k` around (cx, cy). */
function tilted(c, cx, cy, a, draw, k = 1) {
  const L = new Canvas();
  draw(L);
  const R = new Canvas();
  const cos = Math.cos(-a); const sin = Math.sin(-a);
  for (let y = 0; y < R.H; y++) {
    for (let x = 0; x < R.W; x++) {
      const dx = (x + 0.5) / SS - cx; const dy = (y + 0.5) / SS - cy;
      const sx = Math.floor((cx + (dx * cos - dy * sin) / k) * SS); const sy = Math.floor((cy + (dx * sin + dy * cos) / k) * SS);
      if (sx < 0 || sy < 0 || sx >= L.W || sy >= L.H) continue;
      const s = (sy * L.W + sx) * 4; const d = (y * R.W + x) * 4;
      for (let k = 0; k < 4; k++) R.px[d + k] = L.px[s + k];
    }
  }
  c.draw(R);
}

const eyeHoles = () => [[ellipse(EX - 20.5, EY + 1, 10.5, 8, -0.1)], [ellipse(EX + 20.5, EY + 1, 10.5, 8, 0.1)]];

// Outline of a masquerade mask: swept-up outer corners, a bridge over the nose.
function masqueradeShape(lift = 1) {
  const left = [
    ...bezier([EX, EY - 7], [EX - 12, EY - 17], [EX - 36, EY - 18 - 4 * lift], [EX - 56, EY - 20 - 10 * lift]),
    ...bezier([EX - 56, EY - 20 - 10 * lift], [EX - 52, EY - 4], [EX - 44, EY + 15], [EX - 24, EY + 17]).slice(1),
    ...bezier([EX - 24, EY + 17], [EX - 12, EY + 18], [EX - 6, EY + 9], [EX, EY + 8]).slice(1),
  ];
  return [...left, ...mirrorAt(left, EX).slice(1, -1)];
}

function domino(c, color) {
  const L = new Canvas();
  L.fill([[ellipse(EX - 21, EY, 27, 16, -0.15)], [ellipse(EX + 21, EY, 27, 16, 0.15)]], shade(color, EY - 16, EY + 16));
  L.fill(eyeHoles(), solid(WHITE), 'erase');
  c.draw(L);
  shine(c, EX - 34, EY - 8, 7, 3, -0.3, 0.45);
}

function sunglasses(c) {
  const lens = vgrad('#5a6070', '#0e1015', EY - 12, EY + 12);
  c.fill(stroke([[EX - 7, EY - 6], [EX + 7, EY - 6]], 3.5), solid('#2b2f38'));
  c.fill(roundRect(EX - 45, EY - 12, 38, 25, 10), lens);
  c.fill(roundRect(EX + 7, EY - 12, 38, 25, 10), lens);
  for (const x of [EX - 38, EX + 14]) c.fill([[x, EY + 10], [x + 8, EY - 10], [x + 14, EY - 10], [x + 6, EY + 10]], solid(WHITE, 0.3));
}

function shapedGlasses(c, lensFor, color) {
  c.fill(stroke([[EX - 6, EY - 4], [EX + 6, EY - 4]], 3), solid(darken(col(color), 0.3)));
  for (const s of [-1, 1]) {
    const x = EX + 21 * s;
    c.fill(lensFor(x, EY), radial(lighten(col(color), 0.45), col(color), x - 6, EY - 6, 24, 0.82, 0.82));
    shine(c, x - 7, EY - 6, 5, 2.5, -0.5, 0.6);
  }
}

function masquerade(c, base, trim, gemColor, feather) {
  const L = new Canvas();
  const shape = masqueradeShape();
  L.fill(shape, typeof base === 'function' ? base : shade(base, EY - 30, EY + 18));
  L.fill(eyeHoles(), solid(WHITE), 'erase');
  c.draw(L);
  c.fill(stroke([...shape, shape[0]], 2.6), solid(trim));
  for (const s of [-1, 1]) c.fill(ring(EX + 20.5 * s, EY + 1, 12.5, 10, 2.4, 0.1 * s), solid(trim));
  if (feather) {
    for (const [a, len, w] of [[-1.15, 46, 8], [-0.8, 40, 7], [-1.45, 34, 6]]) {
      const ox = EX + 52; const oy = EY - 26;
      const ux = Math.cos(a); const uy = Math.sin(a);
      c.fill(ellipse(ox + ux * len * 0.5, oy + uy * len * 0.5, len * 0.5, w, a), radial(lighten(col(feather), 0.5), col(feather), ox + ux * len * 0.7, oy + uy * len * 0.7, len * 0.6));
      c.fill(stroke([[ox, oy], [ox + ux * len * 0.9, oy + uy * len * 0.9]], 1.2), solid(darken(col(feather), 0.35), 0.8));
    }
  }
  if (gemColor) gem(c, EX, EY - 9, 6.5, gemColor);
}

function butterflyMask(c, inner, outer) {
  const L = new Canvas();
  const lobes = [[ellipse(EX - 27, EY - 7, 30, 19, -0.5)], [ellipse(EX - 17, EY + 10, 17, 11, 0.45)], [ellipse(EX + 27, EY - 7, 30, 19, 0.5)], [ellipse(EX + 17, EY + 10, 17, 11, -0.45)]];
  L.fill(lobes, radial(inner, outer, EX, EY, 48));
  for (const s of [-1, 1]) {
    for (const [dx, dy, r] of [[-46, -18, 4], [-36, -26, 3], [-28, 16, 3]]) L.fill(circle(EX - dx * s, EY + dy, r), solid(WHITE, 0.85), 'atop');
  }
  L.fill(eyeHoles(), solid(WHITE), 'erase');
  c.draw(L);
  c.fill(roundRect(EX - 3.5, EY - 14, 7, 28, 3.5), solid(INK));
  for (const s of [-1, 1]) c.fill(stroke(bezier([EX, EY - 12], [EX + 4 * s, EY - 26], [EX + 12 * s, EY - 34], [EX + 18 * s, EY - 34]), 1.6), solid(INK));
}

function roseMask(c) {
  masquerade(c, '#c92a2a', '#f6c445', null, null);
  const rx = EX - 54; const ry = EY - 26;
  c.fill(ellipse(rx + 12, ry + 10, 10, 5, 0.6), shade('#51cf66', ry + 5, ry + 15));
  c.fill(circle(rx, ry, 12), radial('#ff6b6b', '#a51111', rx - 3, ry - 3, 14));
  for (const [r, a0] of [[8, 0.3], [5, 2.2], [2.5, 4]]) c.fill(stroke(ellipse(rx, ry, r, r).slice(Math.round(a0 * 10), Math.round(a0 * 10) + 50), 1.4), solid('#7a0b0b', 0.75));
}

function moonMask(c) {
  masquerade(c, vgrad('#e7f5ff', '#91a7ff', EY - 30, EY + 18), '#dbe4ff', null, null);
  const L = new Canvas();
  L.fill(circle(EX, EY - 34, 15), radial('#fffbe6', '#ffd43b', EX - 4, EY - 38, 18));
  L.fill(circle(EX + 7, EY - 39, 13), solid(WHITE), 'erase');
  c.draw(L);
  for (const [x, y, r] of [[EX - 40, EY - 34, 5], [EX + 34, EY - 32, 6], [EX + 54, EY - 10, 4], [EX - 58, EY - 6, 4]]) sparkle(c, x, y, r, '#fff6c2');
  gem(c, EX, EY - 9, 6, '#74c0fc');
}

// Festival masks worn on the side of the head (not over the face).
const MX = HX - 64;
const MY = HY + 36;
function sideMask(c, kind, k = 1.3) {
  tilted(c, MX, MY, -0.42, (L) => {
    const s = k;
    const pal = {
      fox: ['#ffffff', '#e9ecef', '#e03131'], cat: ['#fff5f8', '#f3d9e2', '#f06595'], bunny: ['#ffffff', '#f1f3f5', '#f783ac'],
      panda: ['#ffffff', '#e9ecef', '#212529'], pig: ['#ffc9de', '#faa2c1', '#e64980'], oni: ['#ff6b6b', '#c92a2a', '#212529'],
      tengu: ['#fa5252', '#a51111', '#212529'], kitsune: ['#ffffff', '#fff3d6', '#f6c445'],
    }[kind];
    const [f0, f1, mark] = pal;
    const fp = vgrad(f0, f1, MY - 30 * s, MY + 32 * s);
    const ears = (inner, tall = 1) => {
      for (const m of [(p) => p, (p) => mirrorAt(p, MX)]) {
        L.fill(m([[MX - 21 * s, MY - 14 * s], [MX - 22 * s, MY - (36 + 6 * tall) * s], [MX - 4 * s, MY - 24 * s]]), fp);
        if (inner) L.fill(m([[MX - 18 * s, MY - 17 * s], [MX - 19 * s, MY - (30 + 5 * tall) * s], [MX - 8 * s, MY - 23 * s]]), solid(inner));
      }
    };
    if (kind === 'fox' || kind === 'kitsune') ears(mark, 1.4);
    if (kind === 'cat') ears('#ffb3c4');
    if (kind === 'pig') for (const m of [(p) => p, (p) => mirrorAt(p, MX)]) L.fill(m([[MX - 20 * s, MY - 18 * s], [MX - 27 * s, MY - 31 * s], [MX - 8 * s, MY - 25 * s]]), solid(f1));
    if (kind === 'bunny') for (const sx of [-1, 1]) { L.fill(ellipse(MX + 9 * sx * s, MY - 38 * s, 7 * s, 20 * s, 0.15 * sx), fp); L.fill(ellipse(MX + 9 * sx * s, MY - 36 * s, 3.5 * s, 14 * s, 0.15 * sx), solid('#ffb3c4')); }
    if (kind === 'panda') for (const sx of [-1, 1]) L.fill(circle(MX + 19 * sx * s, MY - 22 * s, 9 * s), solid(mark));
    if (kind === 'oni') for (const sx of [-1, 1]) L.fill([[MX + 8 * sx * s, MY - 22 * s], [MX + 15 * sx * s, MY - 42 * s], [MX + 18 * sx * s, MY - 20 * s]], vgrad('#fff9db', '#e9d8a6', MY - 42 * s, MY - 20 * s));
    // the face: foxes get a pointed chin
    const pointed = kind === 'fox' || kind === 'kitsune';
    const faceShape = ellipse(MX, MY, 25 * s, 28 * s).map(([x, y]) => {
      const t = Math.max(0, (y - MY) / (28 * s));
      return pointed ? [MX + (x - MX) * (1 - 0.5 * t), y + 7 * s * t] : [x, y];
    });
    L.fill(faceShape, fp);
    const eye = (sx) => [MX + 10 * sx * s, MY - 2 * s];
    if (kind === 'fox' || kind === 'kitsune') {
      for (const sx of [-1, 1]) {
        const [x, y] = eye(sx);
        L.fill(stroke(bezier([x - 6 * sx * s, y + 2 * s], [x - 2 * sx * s, y - 1 * s], [x + 3 * sx * s, y - 2 * s], [x + 7 * sx * s, y - 5 * s]), 2.4 * s), solid(INK));
        L.fill(stroke(bezier([x - 4 * sx * s, y - 7 * s], [x, y - 11 * s], [x + 4 * sx * s, y - 12 * s], [x + 8 * sx * s, y - 16 * s]), 2.2 * s), solid(mark));
      }
      L.fill(ellipse(MX, MY - 16 * s, 2.5 * s, 5 * s), solid(mark));
      L.fill(ellipse(MX, MY + 26 * s, 3 * s, 2.2 * s), solid(INK));
    } else if (kind === 'cat') {
      for (const sx of [-1, 1]) {
        const [x, y] = eye(sx);
        L.fill(stroke(bezier([x - 5 * s, y + 1 * s], [x - 3 * s, y - 4 * s], [x + 3 * s, y - 4 * s], [x + 5 * s, y + 1 * s]), 2 * s), solid(INK));
        for (const dy of [-2, 2]) L.fill(stroke([[MX + 13 * sx * s, MY + (9 + dy) * s], [MX + 25 * sx * s, MY + (8 + dy * 2) * s]], 1.1 * s), solid(INK, 0.6));
        L.fill(ellipse(MX + 15 * sx * s, MY + 6 * s, 4 * s, 2.4 * s), solid('#ff8fa3', 0.6));
      }
      L.fill(ellipse(MX, MY + 5 * s, 2.4 * s, 1.8 * s), solid('#f06595'));
      for (const sx of [-1, 1]) L.fill(stroke(bezier([MX, MY + 7 * s], [MX + 1 * sx * s, MY + 10 * s], [MX + 4 * sx * s, MY + 10 * s], [MX + 5 * sx * s, MY + 7 * s], 8), 1.3 * s), solid(INK));
    } else if (kind === 'oni' || kind === 'tengu') {
      for (const sx of [-1, 1]) {
        const [x, y] = eye(sx);
        L.fill(rotate(roundRect(x - 7 * s, y - 12 * s, 14 * s, 4.5 * s, 2 * s), x, y - 10 * s, 0.35 * sx), solid(kind === 'tengu' ? WHITE : INK));
        L.fill(ellipse(x, y, 5 * s, 4 * s), solid('#ffd43b'));
        L.fill(circle(x, y, 2 * s), solid(INK));
      }
      if (kind === 'oni') {
        L.fill(roundRect(MX - 12 * s, MY + 10 * s, 24 * s, 8 * s, 4 * s), solid('#5c0f0f'));
        for (const sx of [-1, 1]) L.fill([[MX + 7 * sx * s, MY + 10 * s], [MX + 11 * sx * s, MY + 10 * s], [MX + 9 * sx * s, MY + 16 * s]], solid(WHITE));
      } else {
        // the long nose, sticking out sideways
        const nose = [[MX - 3 * s, MY + 1 * s], [MX + 30 * s, MY + 12 * s], [MX + 33 * s, MY + 16 * s], [MX + 29 * s, MY + 18 * s], [MX - 3 * s, MY + 13 * s]];
        L.fill(nose, vgrad('#ff8787', '#a51111', MY, MY + 18 * s));
        L.fill(stroke([[MX + 2 * s, MY + 4 * s], [MX + 27 * s, MY + 13 * s]], 1.6 * s), solid(WHITE, 0.45));
        L.fill(stroke(bezier([MX - 9 * s, MY + 20 * s], [MX - 4 * s, MY + 23 * s], [MX + 4 * s, MY + 23 * s], [MX + 9 * s, MY + 20 * s], 10), 1.6 * s), solid(INK));
      }
    } else if (kind === 'panda') {
      for (const sx of [-1, 1]) {
        const [x, y] = eye(sx);
        L.fill(ellipse(x, y + 1 * s, 6.5 * s, 8.5 * s, -0.5 * sx), solid(mark));
        L.fill(circle(x + 1 * sx * s, y, 2.2 * s), solid(WHITE));
      }
      L.fill(ellipse(MX, MY + 9 * s, 3.5 * s, 2.5 * s), solid(mark));
    } else {
      for (const sx of [-1, 1]) {
        const [x, y] = eye(sx);
        L.fill(ellipse(x, y, 2.6 * s, 3.4 * s), solid(kind === 'bunny' ? '#c92a2a' : INK));
        L.fill(ellipse(MX + 15 * sx * s, MY + 7 * s, 4 * s, 2.4 * s), solid('#ff8fa3', 0.6));
      }
      if (kind === 'pig') {
        L.fill(ellipse(MX, MY + 9 * s, 9 * s, 6.5 * s), solid(lighten(col(f1), 0.25)));
        for (const sx of [-1, 1]) L.fill(ellipse(MX + 3.2 * sx * s, MY + 9 * s, 1.6 * s, 2.4 * s), solid('#c2255c'));
      } else {
        L.fill(ellipse(MX, MY + 7 * s, 2.4 * s, 1.8 * s), solid(mark));
      }
    }
    if (kind === 'kitsune') {
      for (const [x, y, r] of [[MX - 30 * s, MY - 30 * s, 5], [MX + 30 * s, MY - 34 * s, 6]]) sparkle(L, x, y, r, '#fff3bf');
    }
    // the cord holding it on
    L.fill(stroke(bezier([MX + 24 * s, MY - 4 * s], [MX + 40 * s, MY - 8 * s], [MX + 52 * s, MY - 4 * s], [MX + 62 * s, MY + 4 * s]), 2), solid(mark === INK ? '#e03131' : mark));
  });
}

// ---------------------------------------------------------------- pets (宠物)
// A chibi animal sitting at the character's lower left, drawn small and scaled up around its feet.
const PX = 50;
const PY = 280;
const PET_SCALE = 1.35;
function animal(c, o) {
  tilted(c, PX - 6, PY + 40, 0, (L) => drawAnimal(L, o), PET_SCALE);
}

function drawAnimal(c, o) {
  const k = col(o.body);
  const bodyPaint = o.paint || shade(k, PY - 32, PY + 36);
  const other = (p) => mirrorAt(p, PX);
  const both = (p, paint, mode) => { c.fill(p, paint, mode); c.fill(other(p), paint, mode); };
  if (o.back) o.back(c);
  // tail (behind)
  const tc = o.tailColor || k;
  if (o.tail === 'cat') c.fill(stroke(bezier([PX + 16, PY + 28], [PX + 38, PY + 30], [PX + 40, PY + 6], [PX + 30, PY - 6]), 7), solid(tc));
  if (o.tail === 'fox') {
    c.fill(ellipse(PX + 28, PY + 14, 11, 23, 0.7), shade(tc, PY - 8, PY + 34));
    c.fill(ellipse(PX + 41, PY + 2, 6, 8, 0.7), solid(o.tailTip || WHITE));
  }
  if (o.tail === 'nine') {
    for (let i = 0; i < 5; i++) {
      const a = -0.5 + i * 0.5;
      const ux = Math.cos(a - Math.PI / 2 + 0.9); const uy = Math.sin(a - Math.PI / 2 + 0.9);
      const cx = PX + 6 + ux * 30; const cy = PY + 18 + uy * 30;
      c.fill(ellipse(cx, cy, 10, 22, Math.atan2(uy, ux) + Math.PI / 2), shade(tc, cy - 20, cy + 20));
      c.fill(ellipse(cx + ux * 15, cy + uy * 15, 6, 8, Math.atan2(uy, ux) + Math.PI / 2), solid(o.tailTip || '#ffd43b'));
    }
  }
  if (o.tail === 'curl') c.fill(ring(PX + 24, PY + 14, 8, 8, 3.5), solid(tc));
  if (o.tail === 'puff') c.fill(circle(PX + 22, PY + 28, 7), solid(o.tailColor || WHITE));
  if (o.tail === 'dragon') c.fill([[PX + 14, PY + 22], [PX + 44, PY + 30], [PX + 40, PY + 20], [PX + 50, PY + 14], [PX + 36, PY + 14], [PX + 18, PY + 12]], shade(tc, PY + 10, PY + 32));
  // ears that stand up are drawn before the head so their base tucks behind it
  const ec = o.earColor || k;
  const earPaint = shade(ec, PY - 50, PY - 10);
  const inner = o.earInner || '#ffb3c4';
  if (o.ears === 'cat') { both([[PX - 23, PY - 18], [PX - 20, PY - 40], [PX - 5, PY - 28]], earPaint); both([[PX - 19, PY - 21], [PX - 18, PY - 34], [PX - 9, PY - 27]], solid(inner)); }
  if (o.ears === 'fox') { both([[PX - 25, PY - 16], [PX - 23, PY - 46], [PX - 4, PY - 28]], earPaint); both([[PX - 20, PY - 20], [PX - 20, PY - 38], [PX - 9, PY - 27]], solid(inner)); }
  if (o.ears === 'big') { both([[PX - 26, PY - 14], [PX - 27, PY - 50], [PX - 6, PY - 28]], earPaint); both([[PX - 22, PY - 19], [PX - 23, PY - 41], [PX - 11, PY - 27]], solid(inner)); }
  if (o.ears === 'bunny') for (const s of [-1, 1]) { c.fill(ellipse(PX + 10 * s, PY - 44, 7.5, 21, 0.15 * s), earPaint); c.fill(ellipse(PX + 10 * s, PY - 42, 3.5, 15, 0.15 * s), solid(inner)); }
  if (o.ears === 'bear') for (const s of [-1, 1]) { c.fill(circle(PX + 19 * s, PY - 26, 9), earPaint); c.fill(circle(PX + 19 * s, PY - 26, 4.5), solid(inner)); }
  if (o.ears === 'small') for (const s of [-1, 1]) { c.fill(circle(PX + 17 * s, PY - 27, 7), earPaint); c.fill(circle(PX + 17 * s, PY - 27, 3.5), solid(inner)); }
  if (o.ears === 'koala') for (const s of [-1, 1]) { c.fill(circle(PX + 25 * s, PY - 20, 13), earPaint); c.fill(circle(PX + 24 * s, PY - 19, 7.5), solid(inner)); }
  if (o.ears === 'pig') both([[PX - 20, PY - 22], [PX - 26, PY - 36], [PX - 8, PY - 28]], earPaint);
  if (o.ears === 'horse') both([[PX - 18, PY - 22], [PX - 18, PY - 38], [PX - 8, PY - 27]], earPaint);
  if (o.ears === 'dragon') both([[PX - 14, PY - 24], [PX - 22, PY - 44], [PX - 6, PY - 28]], vgrad('#fff9db', '#e9c46a', PY - 44, PY - 24));
  // body + head on one layer so patches / stripes can be painted onto them
  const L = new Canvas();
  if (o.blob) {
    L.fill(ellipse(PX, PY + 8, 30, 29), bodyPaint);
  } else {
    L.fill(ellipse(PX, PY + 18, 23, 18), bodyPaint);
    L.fill(ellipse(PX, PY - 8, 26, 22), bodyPaint);
  }
  if (o.belly) L.fill(o.blob ? ellipse(PX, PY + 16, 19, 18) : ellipse(PX, PY + 22, 13, 11), solid(o.belly), 'atop');
  if (o.muzzle) L.fill(ellipse(PX, PY + 2, 15, 10), solid(o.muzzle), 'atop');
  for (const [x, y, rx, ry, rot, cc] of o.patches || []) L.fill(ellipse(PX + x, PY + y, rx, ry, rot), solid(cc), 'atop');
  if (o.stripes) for (const dx of [-7, 0, 7]) L.fill(stroke([[PX + dx, PY - 29], [PX + dx * 0.8, PY - 21]], 3), solid(o.stripes), 'atop');
  if (o.stars) { const rand = rng(hashStr(o.body)); for (let i = 0; i < 26; i++) L.fill(circle(PX - 30 + rand() * 60, PY - 32 + rand() * 70, 0.7 + rand() * 1.3), solid(WHITE, 0.9), 'atop'); }
  c.draw(L);
  if (o.ears === 'floppy') for (const s of [-1, 1]) c.fill(ellipse(PX + 24 * s, PY - 6, 8, 15, -0.35 * s), shade(o.earColor || darken(k, 0.25), PY - 20, PY + 10));
  // feet
  const fc = o.feet || darken(k, 0.08);
  for (const s of [-1, 1]) c.fill(ellipse(PX + 10 * s, PY + 35, 7, 4.5), solid(fc));
  // face
  const ey = o.blob ? PY + 2 : PY - 7;
  const ex = o.blob ? 10 : 9;
  if (o.eyePatch) for (const s of [-1, 1]) c.fill(ellipse(PX + ex * s, ey + 1, 6.5, 8, -0.5 * s), solid(o.eyePatch));
  for (const s of [-1, 1]) {
    const x = PX + ex * s;
    if (o.frogEyes) {
      c.fill(circle(x + 4 * s, ey - 17, 9), shade(k, ey - 26, ey - 8));
      c.fill(circle(x + 4 * s, ey - 17, 6), solid(WHITE));
      c.fill(circle(x + 4 * s, ey - 16, 3.4), solid(INK));
      continue;
    }
    if (o.happy) c.fill(stroke(bezier([x - 4, ey + 1], [x - 3, ey - 3.5], [x + 3, ey - 3.5], [x + 4, ey + 1], 8), 1.8), solid(INK));
    else {
      c.fill(ellipse(x, ey, 3.3, 4.3), solid(o.eyes || INK));
      if (o.eyes) c.fill(ellipse(x, ey, 1.3, 3.4), solid(INK));
      c.fill(circle(x + 1, ey - 1.6, 1.2), solid(WHITE));
    }
    c.fill(ellipse(PX + 16 * s, ey + 7, 4, 2.4), solid(o.blush || '#ff8fa3', 0.6));
  }
  if (o.beak === 'chick') c.fill([[PX - 4, ey + 6], [PX + 4, ey + 6], [PX, ey + 11]], solid('#ff922b'));
  if (o.beak === 'duck') c.fill(ellipse(PX, ey + 8, 8, 4), shade('#ff922b', ey + 4, ey + 12));
  if (o.beak === 'penguin') c.fill([[PX - 4, ey + 5], [PX + 4, ey + 5], [PX, ey + 10]], solid('#ffa94d'));
  if (o.snout) { c.fill(ellipse(PX, ey + 8, 7.5, 5.5), solid(o.snout)); for (const s of [-1, 1]) c.fill(ellipse(PX + 2.7 * s, ey + 8, 1.4, 2), solid('#c2255c')); }
  if (o.nose) c.fill(ellipse(PX, ey + 5.5, o.bigNose ? 4.5 : 2.2, o.bigNose ? 3.5 : 1.6), solid(o.nose));
  if (o.mouth === 'w') for (const s of [-1, 1]) c.fill(stroke(bezier([PX, ey + 7], [PX + 0.8 * s, ey + 10], [PX + 3.5 * s, ey + 10], [PX + 4.5 * s, ey + 7], 8), 1.3), solid(INK));
  if (o.mouth === 'smile') c.fill(stroke(bezier([PX - 6, ey + 9], [PX - 3, ey + 13], [PX + 3, ey + 13], [PX + 6, ey + 9], 10), 1.4), solid(INK));
  if (o.tuft) for (const [x, rot] of [[-4, -0.5], [0, 0], [4, 0.5]]) c.fill(ellipse(PX + x, PY - 22, 3, 7, rot), solid(o.tuft));
  if (o.flippers) for (const s of [-1, 1]) c.fill(ellipse(PX + 28 * s, PY + 14, 6, 13, 0.4 * s), solid(o.flippers));
  if (o.wings) for (const s of [-1, 1]) c.fill(ellipse(PX + 26 * s, PY + 12, 7, 11, -0.5 * s), shade(lighten(k, 0.15), PY, PY + 24));
  if (o.front) o.front(c);
}

function unicornExtras(c) {
  ['#ff8fab', '#ffd43b', '#69db7c', '#74c0fc', '#b197fc'].forEach((cc, i) => c.fill(circle(PX + 6 + i * 4, PY - 28 + i * 6, 7), solid(cc)));
  c.fill([[PX - 6, PY - 26], [PX + 1, PY - 56], [PX + 6, PY - 26]], vgrad('#fff3bf', '#f6c445', PY - 56, PY - 26));
  for (const y of [-34, -42]) c.fill(stroke([[PX - 3, PY + y + 3], [PX + 4, PY + y]], 1.2), solid('#c98a14', 0.7));
}

function dragonWings(c) {
  for (const s of [-1, 1]) {
    const pts = [[PX + 12 * s, PY + 8], [PX + 40 * s, PY - 28], [PX + 44 * s, PY - 6], [PX + 36 * s, PY - 2], [PX + 38 * s, PY + 10], [PX + 26 * s, PY + 8], [PX + 24 * s, PY + 18]];
    c.fill(s < 0 ? pts : pts.reverse(), shade('#38d9a9', PY - 28, PY + 18));
  }
}

// ---------------------------------------------------------------- new catalogue: masks + pets
const HEAD = { slot: 'head' };
const PET = { slot: 'pet' };
for (const [k, n, cc] of [['black', '黑色', '#343a40'], ['red', '红色', '#e03131'], ['blue', '蓝色', '#1c7ed6']]) add(`eyemask-${k}`, `${n}眼罩`, 0, (c) => domino(c, cc), HEAD);
add('shades', '酷炫墨镜', 0, sunglasses, HEAD);
add('glasses-heart', '爱心眼镜', 0, (c) => shapedGlasses(c, (x, y) => heart(x, y + 1, 21), '#ff6b9a'), HEAD);
add('glasses-star', '星星眼镜', 0, (c) => shapedGlasses(c, (x, y) => star(x, y + 1, 21, 11), '#ffd43b'), HEAD);
for (const [k, n] of [['fox', '狐狸面具'], ['cat', '猫咪面具'], ['bunny', '兔子面具'], ['panda', '熊猫面具'], ['pig', '小猪面具'], ['oni', '鬼面']]) add(`mask-${k}`, n, 1, (c) => sideMask(c, k), HEAD);
add('masq-violet', '紫羽舞会面具', 2, (c) => masquerade(c, '#7048e8', '#f6c445', '#e599f7', '#b197fc'), HEAD);
add('masq-noir', '金边夜宴面具', 2, (c) => masquerade(c, '#212529', '#f6c445', '#fa5252', '#343a40'), HEAD);
add('masq-butterfly', '蓝蝶面具', 2, (c) => butterflyMask(c, '#a5f3ff', '#1c3faa'), HEAD);
add('masq-rose', '红玫瑰面具', 2, roseMask, HEAD);
add('masq-gold', '黄金假面', 3, (c) => masquerade(c, vgrad('#fff3bf', '#d9a21a', EY - 30, EY + 18), '#fff9db', '#4dabf7', '#ffd43b'), { ...HEAD, glow: '#ffd43b' });
add('mask-tengu', '天狗面具', 3, (c) => sideMask(c, 'tengu', 1.42), { ...HEAD, glow: '#ff8787' });
add('mask-kitsune', '白狐神面', 3, (c) => sideMask(c, 'kitsune', 1.48), { ...HEAD, glow: '#ffe066' });
add('masq-moon', '月光假面', 4, moonMask, { ...HEAD, glow: '#a5d8ff' });

add('pet-chick', '小黄鸡', 0, (c) => animal(c, { body: '#ffe066', blob: true, beak: 'chick', tuft: '#fcc419', wings: true, feet: '#ff922b' }), PET);
add('pet-duck', '小白鸭', 0, (c) => animal(c, { body: '#f8f9fa', blob: true, beak: 'duck', tuft: '#e9ecef', wings: true, feet: '#ff922b' }), PET);
add('pet-frog', '小青蛙', 0, (c) => animal(c, { body: '#8ce99a', belly: '#e6fcf5', frogEyes: true, mouth: 'smile', feet: '#69db7c' }), PET);
add('pet-pig', '小粉猪', 0, (c) => animal(c, { body: '#ffc9de', ears: 'pig', snout: '#ffdeeb', tail: 'curl', tailColor: '#faa2c1' }), PET);
add('pet-hamster', '小仓鼠', 0, (c) => animal(c, { body: '#f7c07a', belly: '#fff8ec', muzzle: '#fff8ec', ears: 'small', nose: '#f06595', mouth: 'w' }), PET);
add('pet-bunny', '小白兔', 0, (c) => animal(c, { body: '#ffffff', ears: 'bunny', nose: '#f783ac', mouth: 'w', tail: 'puff', eyes: '#e03131' }), PET);
add('pet-orange-cat', '橘猫', 1, (c) => animal(c, { body: '#ffa94d', belly: '#fff4e6', ears: 'cat', stripes: '#e8590c', nose: '#f06595', mouth: 'w', tail: 'cat', tailColor: '#ff922b' }), PET);
add('pet-black-cat', '黑猫', 1, (c) => animal(c, { body: '#3b3b45', ears: 'cat', eyes: '#ffd43b', nose: '#f783ac', mouth: 'w', tail: 'cat', feet: '#2b2b33' }), PET);
add('pet-calico', '三花猫', 1, (c) => animal(c, { body: '#ffffff', ears: 'cat', earColor: '#ff922b', patches: [[-14, -14, 11, 9, 0.4, '#ff922b'], [14, -18, 9, 8, -0.3, '#343a40'], [8, 22, 10, 8, 0, '#ff922b']], nose: '#f783ac', mouth: 'w', tail: 'cat', tailColor: '#343a40' }), PET);
add('pet-shiba', '柴犬', 1, (c) => animal(c, { body: '#f0a04b', belly: '#fff8ec', muzzle: '#fff8ec', ears: 'cat', earInner: '#fff0d6', nose: INK, mouth: 'w', tail: 'curl', happy: true }), PET);
add('pet-corgi', '柯基', 1, (c) => animal(c, { body: '#f4a259', belly: '#ffffff', muzzle: '#ffffff', patches: [[0, -20, 4, 9, 0, '#ffffff']], ears: 'big', earInner: '#ffe3c2', nose: INK, mouth: 'smile', tail: 'puff' }), PET);
add('pet-bear', '小棕熊', 1, (c) => animal(c, { body: '#a9714b', muzzle: '#e9c9a8', belly: '#d9a77e', ears: 'bear', earInner: '#e9c9a8', nose: INK, bigNose: true, mouth: 'w' }), PET);
add('pet-fox', '小狐狸', 2, (c) => animal(c, { body: '#ff8a3d', muzzle: '#ffffff', belly: '#ffffff', ears: 'fox', earInner: '#4a3f48', nose: INK, mouth: 'w', tail: 'fox' }), PET);
add('pet-panda', '熊猫', 2, (c) => animal(c, { body: '#ffffff', patches: [[0, 24, 26, 9, 0, '#2b2b33']], ears: 'bear', earColor: '#2b2b33', earInner: '#2b2b33', eyePatch: '#2b2b33', nose: INK, mouth: 'w', feet: '#2b2b33' }), PET);
add('pet-penguin', '企鹅', 2, (c) => animal(c, { body: '#334061', belly: '#ffffff', blob: true, beak: 'penguin', flippers: '#26314d', feet: '#ffa94d', patches: [[0, 0, 20, 14, 0, '#ffffff']] }), PET);
add('pet-koala', '考拉', 2, (c) => animal(c, { body: '#adb5bd', belly: '#e9ecef', ears: 'koala', earInner: '#f8f9fa', nose: '#343a40', bigNose: true }), PET);
add('pet-unicorn', '独角兽', 3, (c) => animal(c, { body: '#fff9fb', belly: '#ffffff', ears: 'horse', earInner: '#ffc2d9', mouth: 'w', blush: '#ff8fab', front: unicornExtras, tail: 'puff', tailColor: '#d0bfff' }), { ...PET, glow: '#ffc2e0' });
add('pet-dragon', '小飞龙', 3, (c) => animal(c, { body: '#63e6be', belly: '#fff3bf', ears: 'dragon', nose: '#0ca678', mouth: 'smile', tail: 'dragon', back: dragonWings }), { ...PET, glow: '#96f2d7' });
add('pet-ninetail', '九尾狐', 3, (c) => animal(c, { body: '#ffffff', belly: '#fff9db', ears: 'fox', earInner: '#f6c445', nose: '#e03131', mouth: 'w', tail: 'nine', tailTip: '#ffd43b', front: (cc) => cc.fill(ellipse(PX, PY - 22, 2.4, 5), solid('#e03131')) }), { ...PET, glow: '#ffe066' });
add('pet-cosmic-cat', '星空猫', 4, (c) => animal(c, { body: '#5f3dc4', paint: radial('#9775fa', '#1b1464', PX - 6, PY - 12, 60), stars: true, ears: 'cat', earInner: '#e599f7', eyes: '#ffe066', nose: '#f783ac', mouth: 'w', tail: 'cat', tailColor: '#3b2a8c', front: (cc) => { sparkle(cc, PX - 34, PY - 40, 7); sparkle(cc, PX + 34, PY - 24, 5); } }), { ...PET, glow: '#b197fc' });

// ---------------------------------------------------------------- boss drops
// Five pieces per room boss (boss ids as in the server), dropped only by that boss to whoever lands
// its last hit: a clip (普通), a chibi of the boss as a pet (稀有), a hat (史诗), an effect (传说)
// and its signature piece (神话). Each set keeps to its boss's palette and motif.

/** Local coordinates: offsets (dx, dy) rotated by a and scaled by s around (x, y). */
function frame(x, y, a = 0, s = 1) {
  const cs = Math.cos(a) * s; const sn = Math.sin(a) * s;
  const p = (dx, dy) => [x + dx * cs - dy * sn, y + dx * sn + dy * cs];
  p.pts = (pts) => pts.map(([dx, dy]) => p(dx, dy));
  p.ell = (dx, dy, rx, ry, rot = 0) => ellipse(...p(dx, dy), rx * s, ry * s, rot + a);
  p.circ = (dx, dy, r) => ellipse(...p(dx, dy), r * s, r * s);
  p.line = (pts, w) => stroke(p.pts(pts), w * s);
  p.rect = (dx, dy, w, h, r = 0) => p.pts(r ? roundRect(dx, dy, w, h, r) : rect(dx, dy, w, h));
  p.s = s;
  return p;
}
const glossy = (color, x, y, r) => { const k = col(color); return radial(lighten(k, 0.5), darken(k, 0.15), x - r * 0.35, y - r * 0.4, r * 1.6); };
// Boss pets are drawn like the animals: small around (PX, PY), then scaled up around their feet.
const bossPet = (c, draw) => tilted(c, PX - 6, PY + 40, 0, draw, PET_SCALE);
const leafShape = (f, len, w) => f.pts([...bezier([-len, 0], [-len / 2, -w], [len / 2, -w], [len, 0], 16), ...bezier([len, 0], [len / 2, w], [-len / 2, w], [-len, 0], 16).slice(1, -1)]);
// A teardrop flame standing on (cx, by); lean moves the tip sideways and wig bends it into an S
// (both in units of h).
function flameShape(cx, by, w, h, lean = 0, wig = 0) {
  const pts = []; const n = 72;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = (1 - Math.cos(t)) / 2; // 0 at the tip, 1 at the bottom
    const v = 1 - u;
    pts.push([cx + ((Math.sin(t) * Math.sin(t / 2) ** 1.4) / 0.72) * (w / 2) + (lean * v * v + wig * Math.sin(v * Math.PI * 1.5) * v) * h, by - h + u * h]);
  }
  return pts;
}
// A polyline whose width runs from w0 to w1 (like stroke(), quads + round joints).
function taper(pts, w0, w1) {
  const parts = []; const n = pts.length - 1;
  const r = (i) => (w0 + ((w1 - w0) * i) / n) / 2;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i]; const [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len; const ny = (bx - ax) / len;
    parts.push([[[ax + nx * r(i), ay + ny * r(i)], [bx + nx * r(i + 1), by + ny * r(i + 1)], [bx - nx * r(i + 1), by - ny * r(i + 1)], [ax - nx * r(i), ay - ny * r(i)]]]);
  }
  pts.forEach(([x, y], i) => parts.push([ellipse(x, y, r(i), r(i), 0, 16)]));
  return parts;
}
// How far a ray from (x, y) at angle a (0 = up, clockwise, as rotate() turns it) stays on the canvas.
const reach = (x, y, a, margin = 6) => {
  const dx = Math.sin(a); const dy = -Math.cos(a);
  const tx = dx > 1e-9 ? (W - margin - x) / dx : dx < -1e-9 ? (margin - x) / dx : Infinity;
  const ty = dy > 1e-9 ? (H - margin - y) / dy : dy < -1e-9 ? (margin - y) / dy : Infinity;
  return Math.min(tx, ty);
};
const spiral = (cx, cy, r0, r1, a0, a1, n = 120, squash = 1) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n; const r = r0 + (r1 - r0) * t; const a = a0 + (a1 - a0) * t;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r * squash];
});
// Two little arcs ")" around (x, y), facing angle a0: something ringing.
const ringLines = (c, x, y, a0, color, r0 = 14, n = 2) => {
  for (let i = 0; i < n; i++) {
    const r = r0 + i * 7;
    const arc = []; for (let k = 0; k <= 10; k++) { const a = a0 - 0.5 + k * 0.1; arc.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
    c.fill(stroke(arc, 2.6), solid(color));
  }
};
// A gear: one part, outer teeth with a hole in the middle.
function gearShape(cx, cy, R, teeth, rot = 0, hole = 0.38) {
  const pts = []; const r0 = R * 0.78; const d = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = rot + i * d;
    for (const [da, rr] of [[-0.27, r0], [-0.17, R], [0.17, R], [0.27, r0], [0.5, r0], [0.73, r0]]) pts.push([cx + Math.cos(a + da * d) * rr, cy + Math.sin(a + da * d) * rr]);
  }
  return [[pts, circle(cx, cy, R * hole)]];
}

// Bug 虫: lime green and ladybug red.
const LIME = '#94d82d';
const BUG_RED = '#f03e3e';
const BUG_INK = '#2b2b33';
function ladybug(c, x, y, s = 1, a = 0, wings = false) {
  const f = frame(x, y, a, s);
  for (const sx of [-1, 1]) {
    for (const dy of [-4, 2, 8]) c.fill(f.line([[0, dy], [sx * 14, dy + 3]], 1.8), solid(BUG_INK));
    c.fill(f.line(bezier([sx * 2, -14], [sx * 3, -19], [sx * 7, -21], [sx * 10, -21], 8), 1.5), solid(BUG_INK));
    c.fill(f.circ(sx * 10, -21, 2), solid(BUG_INK));
    if (wings) c.fill(f.ell(sx * 15, -2, 13, 6.5, sx * -0.45), vgrad('#ffffff', '#d0ebff', y - 10 * s, y + 6 * s));
  }
  c.fill(f.ell(0, -10, 8, 6), solid(BUG_INK));
  for (const sx of [-1, 1]) c.fill(f.circ(sx * 3.5, -12, 1.7), solid(WHITE));
  c.fill(f.ell(0, 3, 12.5, 13), glossy(BUG_RED, ...f(0, 3), 13 * s));
  c.fill(f.line([[0, -8.5], [0, 15.5]], 1.4), solid(BUG_INK));
  for (const [dx, dy, r] of [[-6, -2, 3], [6, -2, 3], [-7, 7, 2.6], [7, 7, 2.6], [-3, 12, 1.8], [3, 12, 1.8]]) c.fill(f.circ(dx, dy, r), solid(BUG_INK));
  c.fill(f.ell(-5, -4, 3.4, 1.8, -0.6), solid(WHITE, 0.55));
}
// A round lime bug with big eyes, flying.
function limeBug(c, x, y, s = 1, a = 0) {
  const f = frame(x, y, a, s);
  for (const sx of [-1, 1]) {
    c.fill(f.ell(sx * 12, -8, 11, 6, sx * -0.6), vgrad('#ffffff', '#d3f9d8', y - 14 * s, y));
    c.fill(f.line(bezier([sx * 3, -10], [sx * 4, -16], [sx * 8, -18], [sx * 11, -17], 8), 1.4), solid('#5c940d'));
    c.fill(f.circ(sx * 11, -17, 2.2), solid(BUG_RED));
  }
  c.fill(f.circ(0, 0, 11), glossy('#a9e34b', ...f(0, 0), 11 * s));
  for (const sx of [-1, 1]) { c.fill(f.circ(sx * 4.2, -1, 2.4), solid(INK)); c.fill(f.circ(sx * 4.2 + 0.8, -2, 0.9), solid(WHITE)); }
  c.fill(f.line([[-6, 6], [6, 6]], 1.2), solid('#5c940d', 0.7));
}

function bugClip(c) {
  const f = frame(HX - 52, HY + 16, -0.5);
  c.fill(leafShape(f, 25, 13), vgrad('#c0eb75', '#5c940d', HY, HY + 30));
  c.fill(f.line([[-21, 0], [21, 0]], 1.6), solid('#5c940d', 0.8));
  for (const dx of [-12, -3, 6]) c.fill(f.line([[dx, 0], [dx + 7, -6]], 1.2), solid('#5c940d', 0.6));
  ladybug(c, HX - 46, HY + 6, 1, -0.55);
}

function bugPet(c) {
  bossPet(c, (L) => {
    // a caterpillar coming towards you: tail far behind on the upper left, the head in front
    const segs = [[PX - 27, PY - 8, 7], [PX - 21, PY + 6, 11], [PX - 9, PY + 19, 15]];
    for (const [x, y, r] of segs) {
      for (const sx of [-1, 1]) L.fill(ellipse(x + sx * r * 0.5, y + r * 0.95, r * 0.28, r * 0.2), solid('#5c940d'));
      L.fill(circle(x, y, r), glossy('#a9e34b', x, y, r));
      L.fill(ellipse(x - r * 0.1, y - r * 0.15, r * 0.35, r * 0.28), solid(BUG_RED, 0.9));
    }
    const hx = PX + 10; const hy = PY - 2;
    for (const sx of [-1, 1]) {
      L.fill(stroke(bezier([hx + sx * 7, hy - 19], [hx + sx * 9, hy - 30], [hx + sx * 16, hy - 36], [hx + sx * 20, hy - 36], 10), 2.6), solid('#5c940d'));
      L.fill(circle(hx + sx * 20, hy - 36, 4.5), glossy(BUG_RED, hx + sx * 20, hy - 36, 4.5));
    }
    for (const sx of [-1, 1]) L.fill(ellipse(hx + sx * 11, hy + 21, 6, 4), solid('#5c940d'));
    L.fill(circle(hx, hy, 23), glossy('#b2f05a', hx, hy, 23));
    face(L, hx, hy + 2, 1.25, '#ff6b6b');
  });
}

function bugHelmet(c) {
  // a beetle seen from the front: the shell is the dome, the horn rises off the plate over the brow
  const L = new Canvas();
  const dome = [];
  for (let i = 0; i <= 48; i++) { const t = Math.PI + (i / 48) * Math.PI; dome.push([HX + Math.cos(t) * 64, HY + 26 + Math.sin(t) * 54]); }
  L.fill(dome, (x, y) => {
    const d = Math.min(1, Math.hypot(x - HX + 24, y - HY + 18) / 92);
    return [...(d < 0.55 ? mix(hex('#e9fac8'), hex('#5fb52b'), d / 0.55) : mix(hex('#5fb52b'), hex('#0b5c4a'), (d - 0.55) / 0.45)), 1];
  });
  for (const s of [-1, 1]) L.fill(stroke(bezier([HX + 6 * s, HY - 22], [HX + 34 * s, HY - 22], [HX + 50 * s, HY - 4], [HX + 52 * s, HY + 18], 16), 5), solid(WHITE, 0.22), 'atop');
  L.fill(stroke([[HX, HY - 28], [HX, HY + 26]], 2.4), solid('#0b4d3c', 0.9), 'atop');
  c.draw(L);
  for (const s of [-1, 1]) {
    c.fill(stroke(bezier([HX + 30 * s, HY - 18], [HX + 36 * s, HY - 34], [HX + 48 * s, HY - 44], [HX + 58 * s, HY - 46], 12), 2.6), solid('#2b5d1f'));
    c.fill(circle(HX + 58 * s, HY - 46, 5), glossy(BUG_RED, HX + 58 * s, HY - 46, 5));
  }
  c.fill(roundRect(HX - 68, HY + 16, 136, 16, 8), vgrad('#5fb52b', '#0b5c4a', HY + 16, HY + 32));
  // the front plate with its eyes, and the forked horn
  c.fill([...bezier([HX - 40, HY + 26], [HX - 40, HY + 2], [HX - 22, HY - 8], [HX, HY - 8], 12), ...bezier([HX, HY - 8], [HX + 22, HY - 8], [HX + 40, HY + 2], [HX + 40, HY + 26], 12).slice(1)], radial('#c0eb75', '#1f6b35', HX - 10, HY - 4, 44));
  for (const s of [-1, 1]) { c.fill(circle(HX + 24 * s, HY + 12, 6), solid(BUG_INK)); c.fill(circle(HX + 24 * s + 2, HY + 10, 2), solid(WHITE)); }
  const horn = [...bezier([HX - 10, HY + 6], [HX - 14, HY - 30], [HX - 8, HY - 56], [HX + 4, HY - 68]), ...bezier([HX + 4, HY - 68], [HX + 6, HY - 60], [HX + 12, HY - 58], [HX + 20, HY - 62]).slice(1),
    ...bezier([HX + 20, HY - 62], [HX + 10, HY - 50], [HX + 8, HY - 30], [HX + 10, HY + 6]).slice(1)];
  c.fill(horn, vgrad('#69db7c', '#0b4d3c', HY - 68, HY + 6));
  c.fill(stroke(bezier([HX - 5, HY], [HX - 8, HY - 28], [HX - 4, HY - 48], [HX + 2, HY - 58], 12), 2.4), solid(WHITE, 0.5));
  c.fill(circle(HX, HY + 16, 5), glossy(BUG_RED, HX, HY + 16, 5));
  shine(c, HX - 36, HY - 4, 9, 4, -0.7, 0.45);
}

function bugSwarm(c) {
  const bugs = [[58, 66, -0.5, 1], [292, 52, 0.6, 0], [310, 160, 1.4, 1], [28, 166, -1.4, 0], [300, 270, 2.4, 0], [214, 30, 0.9, 1], [34, 280, -2.5, 1]];
  bugs.forEach(([x, y, a, kind], i) => {
    // a dotted flight path behind the bug, looping once
    const f = frame(x, y, a + Math.PI / 2);
    const sw = i % 2 ? 1 : -1;
    for (let k = 2; k < 26; k++) {
      const t = k / 26;
      const [qx, qy] = f(12 + t * 64 + 14 * Math.sin(t * Math.PI * 2), 14 * (1 - Math.cos(t * Math.PI * 2)) * sw);
      if (qx > 10 && qx < W - 10 && qy > 10 && qy < H - 10) c.fill(circle(qx, qy, 2.1 - t * 0.9), solid(kind ? '#ff8787' : LIME, 1 - t * 0.4));
    }
    if (kind) ladybug(c, x, y, 0.78, a, true); else limeBug(c, x, y, 0.95, a);
  });
}

// Egyptian winged scarab (the sun pusher) above the head, holding a red sun.
function scarab(c) {
  const gold = vgrad('#fff3bf', '#c98a14', 20, 110);
  for (const s of [-1, 1]) {
    const arm = bezier([HX + 26 * s, 96], [HX + 66 * s, 74], [HX + 100 * s, 60], [HX + 124 * s, 38], 20);
    // long primaries hanging off the arm, then the coverts and a red band on top
    for (let i = 2; i < arm.length; i += 2) {
      const [x, y] = arm[i]; const t = i / (arm.length - 1);
      const len = 44 + t * 22; const ang = Math.PI / 2 - s * (0.12 + t * 0.33);
      const ux = Math.cos(ang); const uy = Math.sin(ang);
      c.fill(ellipse(x + ux * len * 0.5, y + uy * len * 0.5, len * 0.52 + 1.5, 7.5, ang), solid('#9c6b12'));
      c.fill(ellipse(x + ux * len * 0.5, y + uy * len * 0.5, len * 0.52, 6, ang), radial('#fff3bf', '#e0a526', x, y, len));
      c.fill(ellipse(x + ux * len * 0.88, y + uy * len * 0.88, 5, 4, ang), solid('#74b816'));
    }
    for (let i = 1; i < arm.length; i += 2) {
      const [x, y] = arm[i]; const t = i / (arm.length - 1);
      const ang = Math.PI / 2 - s * (0.3 + t * 0.5);
      c.fill(ellipse(x + Math.cos(ang) * 12, y + Math.sin(ang) * 12, 15, 7, ang), vgrad('#c0eb75', '#2f9e44', y, y + 24));
    }
    c.fill(stroke(arm, 11), vgrad('#ff8787', '#c92a2a', 30, 96));
    c.fill(stroke(arm, 4), solid(GOLD[0], 0.8));
  }
  // the scarab, its front legs raising the red sun
  c.fill(circle(HX, 24, 17), radial('#ffd8d8', BUG_RED, HX, 24, 17, 0.5, 0));
  for (const s of [-1, 1]) {
    for (const [y, len] of [[56, 22], [68, 18]]) c.fill(stroke([[HX + 10 * s, y], [HX + 24 * s, y - 4], [HX + (26 + len * 0.4) * s, y + len * 0.5]], 3.6), solid('#9c6b12'));
    c.fill(stroke([[HX + 9 * s, 42], [HX + 20 * s, 36], [HX + 13 * s, 22]], 3.6), solid('#9c6b12'));
  }
  c.fill(circle(HX, 24, 13), glossy(BUG_RED, HX, 24, 13));
  c.fill(ring(HX, 24, 13, 13, 2), solid(GOLD[1]));
  c.fill(ellipse(HX, 68, 25, 27), gold);
  c.fill(stroke([[HX, 56], [HX, 94]], 2.2), solid('#9c6b12', 0.8));
  c.fill(ellipse(HX, 50, 19, 10), vgrad('#fff3bf', '#e0a526', 40, 60));
  c.fill([[HX - 13, 45], [HX - 9, 34], [HX - 3, 40], [HX, 33], [HX + 3, 40], [HX + 9, 34], [HX + 13, 45]], vgrad(GOLD[0], GOLD[2], 33, 45));
  shine(c, HX - 9, 64, 4.5, 10, 0.2, 0.5);
  gem(c, HX, 50, 5.5, '#69db7c');
  for (const [x, y, r] of [[30, 116, 8], [306, 108, 9], [HX - 50, 22, 6], [HX + 50, 16, 7]]) sparkle(c, x, y, r);
}

add('boss-bug-clip', '瓢虫发夹', 0, bugClip, { slot: 'head', boss: 'bug' });
add('boss-bug-pet', '小 Bug', 1, bugPet, { slot: 'pet', boss: 'bug' });
add('boss-bug-helmet', '甲虫头盔', 2, bugHelmet, { slot: 'head', boss: 'bug', glow: '#d8f5a2' });
add('boss-bug-swarm', 'Bug 虫群', 3, bugSwarm, { slot: 'fx', boss: 'bug', glow: '#d8f5a2', outline: 1.5 });
add('boss-bug-scarab', '金圣甲虫', 4, scarab, { slot: 'fx', boss: 'bug', layer: 'back', glow: '#ffd43b' });

// Deadline 怪: alarm red, silver and orange; every clock reads five to twelve.
const ALARM = '#f03e3e';
function clockFace(c, f, r, hands = true) {
  const [x, y] = f(0, 0);
  c.fill(f.circ(0, 0, r), radial('#ffffff', '#e9ecef', x - r * 0.3 * f.s, y - r * 0.3 * f.s, r * 1.3 * f.s));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2; const big = i % 3 === 0;
    const r0 = r * (big ? 0.64 : 0.74);
    c.fill(f.line([[Math.sin(a) * r0, -Math.cos(a) * r0], [Math.sin(a) * r * 0.86, -Math.cos(a) * r * 0.86]], r * (big ? 0.11 : 0.07)), solid(INK, 0.75));
  }
  if (!hands) return;
  c.fill(f.line([[0, 0], [Math.sin(-0.52) * r * 0.72, -Math.cos(-0.52) * r * 0.72]], r * 0.09), solid(INK));
  c.fill(f.line([[0, 0], [Math.sin(-0.05) * r * 0.48, -Math.cos(-0.05) * r * 0.48]], r * 0.13), solid(INK));
  c.fill(f.circ(0, 0, r * 0.11), solid(ALARM));
}
// A red alarm clock with twin bells and little legs, radius 20 at s = 1.
function alarmClock(c, x, y, s = 1, a = 0, dial = true) {
  const f = frame(x, y, a, s);
  for (const sx of [-1, 1]) {
    c.fill(f.line([[sx * 11, 14], [sx * 16, 24]], 3.6), solid('#868e96'));
    c.fill(f.ell(sx * 17.5, 24.5, 5, 2.8), solid('#495057'));
    c.fill(f.ell(sx * 14, -17, 9.5, 7.5, sx * 0.62), glossy('#dee2e6', ...f(sx * 14, -18), 10 * s));
    c.fill(f.circ(sx * 19, -23, 2.4), solid('#adb5bd'));
  }
  c.fill(f.line([[0, -19], [0, -27]], 2.2), solid('#868e96'));
  c.fill(f.ell(0, -28, 4.5, 2.6), solid('#adb5bd'));
  c.fill(f.circ(0, 0, 20), glossy(ALARM, ...f(0, 0), 20 * s));
  if (dial) clockFace(c, f, 15);
  c.fill(f.ell(-11, -10, 4, 2.2, -0.8), solid(WHITE, 0.5));
}

function deadlineClip(c) {
  alarmClock(c, HX + 48, HY + 6, 0.8, 0.3);
  for (const a0 of [-2.3, -0.5]) ringLines(c, HX + 48, HY + 6, a0, '#ff922b', 24, 2);
}

function deadlinePet(c) {
  bossPet(c, (L) => {
    const f = frame(PX, PY + 6, 0, 1.3);
    alarmClock(L, PX, PY + 6, 1.3, 0, false);
    L.fill(f.circ(0, 0, 15.5), radial('#ffffff', '#f1f3f5', PX - 4, PY, 22));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      L.fill(f.circ(Math.sin(a) * 13, -Math.cos(a) * 13, i % 3 ? 0.7 : 1.1), solid(INK, 0.6));
    }
    L.fill(f.line([[0, -4], [-4.5, -11]], 1.3), solid(INK));
    L.fill(f.line([[0, -4], [0, -10]], 1.8), solid(INK));
    face(L, PX, PY + 9, 1.1, '#ff8787');
    for (const sx of [-1, 1]) for (const [dx, dy, ex, ey] of [[25, -24, 30, -28], [27, -16, 32, -17]]) L.fill(stroke([[PX + sx * dx, PY + dy], [PX + sx * ex, PY + dy + (ey - dy)]], 1.8), solid('#ff922b'));
  });
}

function hourglassHat(c) {
  const top = HY - 56; const bot = HY + 10; const mid = (top + bot) / 2;
  const half = [...bezier([HX - 22, top + 4], [HX - 34, top + 22], [HX - 14, mid - 8], [HX - 3, mid], 16), ...bezier([HX - 3, mid], [HX - 14, mid + 8], [HX - 34, bot - 22], [HX - 22, bot - 4], 16).slice(1)];
  const glass = [...half, ...mirror(half)];
  const sand = vgrad('#ffd8a8', '#f76707', top, bot);
  const L = new Canvas();
  L.fill(glass, vgrad('#ffffff', '#d0ebff', top, bot));
  L.fill([[HX - 34, mid - 15], [HX, mid - 9], [HX + 34, mid - 15], [HX + 34, mid], [HX - 34, mid]], sand, 'atop');
  L.fill([[HX - 34, bot], [HX - 34, bot - 14], [HX, bot - 27], [HX + 34, bot - 14], [HX + 34, bot]], sand, 'atop');
  L.fill(rect(HX - 1, mid, 2, bot - 27 - mid), solid('#ff922b'), 'atop');
  c.draw(L);
  for (const y0 of [top + 8, mid + 6]) c.fill(stroke(bezier([HX - 22, y0 + 4], [HX - 28, y0 + 10], [HX - 24, y0 + 18], [HX - 16, y0 + 22], 10), 2.4), solid(WHITE, 0.85));
  for (const s of [-1, 1]) c.fill(stroke([[HX + 36 * s, top + 2], [HX + 36 * s, bot - 2]], 5), vgrad('#f8f9fa', '#868e96', top, bot));
  c.fill(roundRect(HX - 44, top - 6, 88, 12, 6), vgrad('#ff8787', '#c92a2a', top - 6, top + 6));
  c.fill(roundRect(HX - 52, bot - 4, 104, 16, 8), vgrad('#ff8787', '#c92a2a', bot - 4, bot + 12));
  for (const s of [-1, 1]) { c.fill(circle(HX + 36 * s, top, 3.4), solid(GOLD[1])); c.fill(circle(HX + 36 * s, bot + 4, 3.4), solid(GOLD[1])); }
  c.fill(circle(HX, top - 10, 6), glossy(GOLD[1], HX, top - 10, 6));
  c.fill(roundRect(HX - 46, bot - 2, 92, 3, 1.5), solid(WHITE, 0.35));
}

function deadlineRing(c) {
  const cx = HX; const cy = 160; const R = 136;
  c.fill(ring(cx, cy, R, R, 13), vgrad('#f8f9fa', '#868e96', cy - R, cy + R));
  c.fill(ring(cx, cy, R - 13, R - 13, 3), solid('#495057'));
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2; const big = i % 5 === 0;
    const r0 = R - (big ? 12 : 8);
    c.fill(stroke([[cx + Math.sin(a) * r0, cy - Math.cos(a) * r0], [cx + Math.sin(a) * (R - 2.5), cy - Math.cos(a) * (R - 2.5)]], big ? 2.6 : 1.2), solid(big ? ALARM : '#495057'));
  }
  // what is left of the time: an orange arc running out at the top
  c.fill(ring(cx, cy, R - 20, R - 20, 9, 0, -Math.PI / 2, Math.PI * 1.15), vgrad('#ffc078', '#f03e3e', cy - R, cy + R));
  const ea = Math.PI * 1.15;
  c.fill(circle(cx + Math.cos(ea) * (R - 24.5), cy + Math.sin(ea) * (R - 24.5), 8), glossy('#ff922b', cx + Math.cos(ea) * (R - 24.5), cy + Math.sin(ea) * (R - 24.5), 8));
  for (const s of [-1, 1]) {
    const f = frame(cx + Math.sin(0.5 * s) * (R + 2), cy - Math.cos(0.5 * s) * (R + 2), 0.5 * s);
    c.fill(f.ell(0, -6, 14, 11), glossy('#dee2e6', ...f(0, -8), 14));
    c.fill(f.circ(0, -18, 3), solid('#adb5bd'));
  }
  c.fill(stroke([[cx, cy - R - 4], [cx, cy - R - 12]], 3), solid('#868e96'));
  c.fill(ellipse(cx, cy - R - 13, 6, 3.4), solid('#adb5bd'));
  for (const [x, y, r] of [[22, 40, 7], [314, 40, 7], [10, 230, 5], [326, 220, 5]]) sparkle(c, x, y, r, '#ffe8cc');
}

// Wings of long clock hands (with the ring near the tip of a Breguet hand), on clockwork joints.
function timeWings(c) {
  for (const s of [-1, 1]) {
    const ox = HX + 34 * s; const oy = 192;
    const gear = (dx, dy, r, n, cc) => {
      const gx = ox + dx * s; const gy = oy + dy;
      c.fill(gearShape(gx, gy, r, n, s * 0.2), glossy(cc, gx, gy, r));
      c.fill(ring(gx, gy, r * 0.6, r * 0.6, 2.2), solid(darken(col(cc), 0.35), 0.7));
    };
    gear(88, -84, 28, 12, '#f6c445');
    for (let i = 0; i < 8; i++) {
      const e = 1.42 - i * 0.235; const len = 150 - i * 9;
      const ux = Math.cos(e) * s; const uy = -Math.sin(e);
      const p = (t, w) => [ox + ux * len * t - uy * w, oy + uy * len * t + ux * w];
      const blade = [...bezier(p(0.05, 0), p(0.35, 9), p(0.75, 9), p(1, 0), 14), ...bezier(p(1, 0), p(0.75, -9), p(0.35, -9), p(0.05, 0), 14).slice(1, -1)];
      c.fill(stroke([...blade, blade[0]], 3.2), solid('#d9480f'));
      c.fill(blade, (x, y) => [...mix(hex('#ffffff'), hex('#adb5bd'), Math.min(1, Math.hypot(x - ox, y - oy) / len)), 1]);
      c.fill(stroke([p(0.12, 0), p(0.66, 0)], 1.6), solid('#868e96'));
      c.fill(ring(...p(0.78, 0), 5.4, 5.4, 2.4), solid(i % 2 ? '#ff922b' : ALARM));
    }
    for (let i = 0; i < 5; i++) {
      const e = 1.3 - i * 0.3;
      const ux = Math.cos(e) * s; const uy = -Math.sin(e);
      c.fill(ellipse(ox + ux * 26, oy + uy * 26, 26, 11, Math.atan2(uy, ux)), vgrad('#ffe8cc', '#ff922b', oy - 40, oy + 10));
    }
    gear(102, -20, 18, 10, '#ffa94d');
    gear(64, -128, 16, 8, '#dee2e6');
    const [kx, ky] = [ox + 88 * s, oy - 84];
    clockFace(c, frame(kx, ky), 15);
  }
  for (const [x, y, r] of [[24, 30, 9], [312, 26, 10], [HX - 64, 16, 6], [HX + 70, 14, 6]]) sparkle(c, x, y, r, '#ffe8cc');
}

add('boss-deadline-clip', '闹钟发卡', 0, deadlineClip, { slot: 'head', boss: 'deadline' });
add('boss-deadline-pet', '小闹钟', 1, deadlinePet, { slot: 'pet', boss: 'deadline' });
add('boss-deadline-hourglass', '沙漏帽', 2, hourglassHat, { slot: 'head', boss: 'deadline', glow: '#ffd8a8' });
add('boss-deadline-ring', '倒计时光环', 3, deadlineRing, { slot: 'fx', boss: 'deadline', layer: 'back', glow: '#ffa94d' });
add('boss-deadline-wings', '时光之翼', 4, timeWings, { slot: 'fx', boss: 'deadline', layer: 'back', glow: '#ffc078' });

// 卡纸打印机: printer grey, paper white and the three inks.
const INKS = ['#22b8cf', '#e64980', '#fcc419'];
const dropShape = (f, r) => f.pts([...bezier([0, -r * 1.7], [r * 0.4, -r * 0.9], [r, -r * 0.3], [r, r * 0.25], 10), ...bezier([r, r * 0.25], [r, r * 1.3], [-r, r * 1.3], [-r, r * 0.25], 12).slice(1), ...bezier([-r, r * 0.25], [-r, -r * 0.3], [-r * 0.4, -r * 0.9], [0, -r * 1.7], 10).slice(1, -1)]);
// A newspaper hat, folded from a printout (with a jammed, crumpled corner).
function paperHat(c) {
  const f = frame(HX + 2, HY + 16, -0.1);
  c.fill(f.pts([[-52, 0], [-2, -54], [52, 0]]), vgrad('#ffffff', '#e9ecef', HY - 40, HY + 16));
  c.fill(f.rect(-14, -36, 26, 8, 2), solid('#495057'));
  for (let k = 0; k < 3; k++) {
    const y = -22 + k * 7; const hw = (52 * (54 + y)) / 54 - 12;
    c.fill(f.line([[-hw, y], [hw - (k % 2) * 10, y]], 2.4), solid('#ced4da'));
  }
  c.fill(f.line([[-2, -54], [-1, -30]], 1.2), solid('#adb5bd', 0.8));
  c.fill(f.rect(-56, -8, 112, 20, 3), vgrad('#ffffff', '#ced4da', HY + 4, HY + 30));
  c.fill(f.line([[-54, 5], [54, 5]], 1.1), solid('#adb5bd', 0.8));
  c.fill(f.pts([[56, -8], [44, -8], [48, 0], [43, 6], [56, 12]]), solid('#dee2e6'));
  c.fill(f.line([[48, -7], [48, 0], [44, 6]], 1), solid('#adb5bd'));
  INKS.forEach((cc, i) => c.fill(f.circ(-40 + i * 9, 2, 3.4), solid(cc)));
  c.fill(dropShape(frame(...f(28, -14), 0.3), 4), solid(INKS[1]));
}

function printerPet(c) {
  bossPet(c, (L) => {
    L.fill(rotate(rect(PX - 17, PY - 46, 34, 34), PX, PY - 30, -0.08), vgrad('#ffffff', '#e9ecef', PY - 46, PY - 12));
    for (let k = 0; k < 3; k++) L.fill(rotate(stroke([[PX - 11, PY - 40 + k * 6], [PX + 9 - k * 4, PY - 40 + k * 6]], 2), PX, PY - 30, -0.08), solid('#ced4da'));
    for (const sx of [-1, 1]) L.fill(roundRect(PX + sx * 20 - 6, PY + 24, 12, 10, 4), solid('#868e96'));
    L.fill(roundRect(PX - 33, PY - 22, 66, 50, 14), vgrad('#f8f9fa', '#adb5bd', PY - 22, PY + 28));
    L.fill(roundRect(PX - 29, PY - 20, 58, 9, 4.5), solid(WHITE, 0.6));
    INKS.forEach((cc, i) => L.fill(circle(PX + 11 + i * 7, PY - 15, 2.7), solid(cc)));
    for (const sx of [-1, 1]) {
      L.fill(ellipse(PX + sx * 11, PY - 2, 3.3, 4.3), solid(INK));
      L.fill(circle(PX + sx * 11 + 1, PY - 3.6, 1.2), solid(WHITE));
      L.fill(ellipse(PX + sx * 20, PY + 5, 4, 2.4), solid('#ff8fa3', 0.6));
    }
    L.fill(roundRect(PX - 21, PY + 9, 42, 6, 3), solid('#495057'));
    // the printout sticking out like a tongue
    L.fill([...bezier([PX - 13, PY + 12], [PX - 14, PY + 26], [PX - 12, PY + 36], [PX - 4, PY + 40], 10), ...bezier([PX - 4, PY + 40], [PX + 6, PY + 43], [PX + 12, PY + 38], [PX + 13, PY + 30], 10).slice(1), [PX + 13, PY + 12]], vgrad('#ffffff', '#e9ecef', PY + 12, PY + 42));
    INKS.forEach((cc, i) => L.fill(rect(PX - 9 + i * 6.5, PY + 19, 5, 12), solid(cc)));
    L.fill(stroke(bezier([PX - 8, PY + 37], [PX - 2, PY + 40], [PX + 6, PY + 39], [PX + 11, PY + 33], 8), 1.2), solid('#ced4da'));
  });
}

function inkCartridge(c, x, y, a, cc) {
  const f = frame(x, y, a); const k = col(cc);
  c.fill(f.rect(-12, -48, 24, 48, 5), vgrad(lighten(k, 0.3), darken(k, 0.12), y - 48, y));
  c.fill(f.rect(-12, -48, 24, 10, 4), solid(darken(k, 0.25)));
  c.fill(f.rect(-8, -34, 16, 20, 3), solid(WHITE, 0.95));
  c.fill(dropShape(frame(...f(0, -23)), 4.2), solid(cc));
  c.fill(f.rect(-4, -9, 8, 5, 2), solid('#495057'));
  c.fill(f.line([[-8, -44], [-8, -12]], 1.6), solid(WHITE, 0.4));
}
function inkClips(c) {
  c.fill(stroke(bezier([HX - 56, HY + 26], [HX - 30, HY + 8], [HX + 30, HY + 8], [HX + 56, HY + 26], 24), 6), vgrad('#f1f3f5', '#868e96', HY + 8, HY + 28));
  [[-36, 20, -0.42], [0, 10, 0], [36, 20, 0.42]].forEach(([dx, dy, a], i) => inkCartridge(c, HX + dx, HY + dy, a, INKS[i]));
  for (const [x, y, i, r, a] of [[HX - 66, HY - 42, 0, 4, -0.5], [HX - 18, HY - 62, 1, 3.4, -0.1], [HX + 22, HY - 60, 1, 4, 0.2], [HX + 66, HY - 44, 2, 4.4, 0.5], [HX + 50, HY - 62, 0, 3, 0.4], [HX - 48, HY - 60, 2, 3, -0.3]]) c.fill(dropShape(frame(x, y, a), r), solid(INKS[i]));
  for (const [x, y, r] of [[HX - 84, HY - 10, 6], [HX + 86, HY - 14, 7]]) sparkle(c, x, y, r);
}

function paperPlane(c, x, y, a, s, tint) {
  const f = frame(x, y, a, s);
  c.fill(f.pts([[24, 0], [-16, 12], [-8, 2]]), solid('#ced4da'));
  c.fill(f.pts([[24, 0], [-18, -14], [-8, 2]]), vgrad('#ffffff', '#e9ecef', y - 14 * s, y + 4 * s));
  c.fill(f.pts([[24, 0], [-18, -14], [-14, -8]]), solid(tint));
  c.fill(f.line([[23, 0], [-8, 2]], 1), solid('#adb5bd'));
}
function planeOrbit(c) {
  const planes = [[52, 60, -0.35, 1.1, 0], [290, 44, 0.3, 1, 1], [302, 168, 1.75, 1.05, 2], [30, 196, -1.8, 1, 1], [292, 286, 2.6, 0.9, 0], [196, 18, 0.1, 0.85, 2]];
  for (const [x, y, a, s, i] of planes) {
    const f = frame(x, y, a, s);
    const path = bezier([-24, 4], [-50, 10], [-70, -14], [-104, -4], 30).map(([u, v]) => f(u, v));
    for (let k = 0; k + 1 < path.length; k += 3) if (path[k][0] > 12 && path[k][0] < W - 12 && path[k][1] > 12) c.fill(stroke([path[k], path[k + 1]], 2.2), solid(INKS[i], 0.9 - k * 0.02));
    paperPlane(c, x, y, a, s, INKS[i]);
  }
}

function inkNebula(c) {
  const cx = HX; const cy = 170;
  c.fill(circle(cx, cy, 166), radial('#fff0f6', '#e7f5ff', cx, cy, 166, 0.5, 0));
  const arms = INKS.map((cc, k) => [cc, spiral(cx, cy, 30, 158, (k * Math.PI * 2) / 3 - 0.5, (k * Math.PI * 2) / 3 + 3.3, 70, 0.92)]);
  for (const [cc, arm] of arms) arm.forEach(([x, y], i) => { if (i % 2) return; const r = 46 - i * 0.45; c.fill(circle(x, y, r), radial(cc, cc, x, y, r, 0.42, 0)); });
  for (const [cc, arm] of arms) {
    c.fill(taper(arm, 24, 3), solid(cc, 0.92));
    c.fill(taper(arm.slice(8).map(([x, y]) => [x + (cx - x) * 0.06, y + (cy - y) * 0.06]), 7, 1.5), solid(WHITE, 0.55));
  }
  const rand = rng(31);
  for (let i = 0; i < 80; i++) {
    const a = rand() * Math.PI * 2; const r = 50 + rand() * 120;
    c.fill(circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.92, 0.8 + rand() * 1.8), solid(rand() < 0.3 ? INKS[i % 3] : WHITE, 0.95));
  }
  for (const [x, y, i, r, a] of [[40, 40, 1, 7, -0.6], [300, 64, 0, 8, 0.5], [18, 250, 2, 6, -2.4], [318, 270, 1, 7, 2.6], [HX + 6, 14, 0, 5, 0.1], [HX - 66, 26, 2, 5, -0.3]]) c.fill(dropShape(frame(x, y, a), r), solid(INKS[i]));
  for (const [x, y, r] of [[70, 110, 10], [282, 120, 11], [60, 300, 8], [286, 316, 7], [HX - 34, 30, 7], [HX + 64, 30, 9], [24, 170, 6], [314, 190, 6]]) sparkle(c, x, y, r, '#ffffff');
}

add('boss-printer-hat', '纸折帽', 0, paperHat, { slot: 'head', boss: 'printer' });
add('boss-printer-pet', '迷你打印机', 1, printerPet, { slot: 'pet', boss: 'printer' });
add('boss-printer-ink', '三色墨盒发卡', 2, inkClips, { slot: 'head', boss: 'printer', glow: '#e3fafc' });
add('boss-printer-planes', '纸飞机环绕', 3, planeOrbit, { slot: 'fx', boss: 'printer', glow: '#c5f6fa' });
add('boss-printer-nebula', '彩墨星云', 4, inkNebula, { slot: 'fx', boss: 'printer', layer: 'back', glow: '#f3d9fa', outline: 0 });

// 邮件海怪: sea blue, envelope white and teal.
const TEAL = '#20c997';
function envelope(c, x, y, w, h, a = 0, heartColor = '#fa5252') {
  const f = frame(x, y, a);
  const x0 = -w / 2; const y0 = -h / 2;
  c.fill(f.rect(x0, y0, w, h, Math.min(w, h) * 0.14), vgrad('#ffffff', '#d0ebff', y + y0, y - y0));
  for (const sx of [-1, 1]) c.fill(f.line([[sx * (-x0 - 2.5), -y0 - 2.5], [sx * w * 0.1, h * 0.06]], 1.3), solid('#a5d8ff'));
  c.fill(f.pts([[x0 + 1, y0 + 1], [0, h * 0.16], [-x0 - 1, y0 + 1]]), vgrad('#ffffff', '#e7f5ff', y + y0, y + h * 0.16));
  c.fill(f.line([[x0 + 2, y0 + 2], [0, h * 0.16], [-x0 - 2, y0 + 2]], 1.5), solid('#74c0fc'));
  if (heartColor) c.fill(heart(...f(0, h * 0.13), h * 0.2), solid(heartColor));
}
const badgeOne = (c, x, y, r) => {
  c.fill(circle(x, y, r), glossy('#fa5252', x, y, r));
  c.fill(stroke([[x - r * 0.25, y - r * 0.3], [x + r * 0.05, y - r * 0.55], [x + r * 0.05, y + r * 0.55]], r * 0.26), solid(WHITE));
};
function mailClip(c) {
  envelope(c, HX + 48, HY + 8, 40, 28, 0.25);
  badgeOne(c, ...frame(HX + 48, HY + 8, 0.25)(19, -13), 7.5);
}

function mailPet(c) {
  bossPet(c, (L) => {
    const paint = glossy('#4dabf7', PX - 4, PY, 40);
    for (const [x0, d] of [[-15, -0.7], [-5, -0.3], [7, 0.35], [18, 0.95]]) {
      const arm = bezier([PX + x0, PY + 8], [PX + x0 + d * 4, PY + 28], [PX + x0 + d * 16, PY + 38], [PX + x0 + d * 22, PY + 31], 16);
      L.fill(taper(arm, 13, 5), paint);
      for (const k of [7, 11]) L.fill(circle(arm[k][0], arm[k][1] + 1.5, 1.6), solid('#d0ebff'));
    }
    L.fill(taper(bezier([PX + 18, PY + 4], [PX + 30, PY + 2], [PX + 34, PY - 8], [PX + 32, PY - 16], 14), 11, 6), paint);
    L.fill(ellipse(PX - 2, PY - 8, 27, 25), paint);
    for (const [x, y, r] of [[-16, -22, 3], [-21, -12, 2.2], [12, -26, 2.4]]) L.fill(circle(PX + x, PY + y, r), solid('#a5d8ff', 0.8));
    face(L, PX - 3, PY - 3, 1.15);
    envelope(L, PX + 32, PY - 22, 26, 18, 0.35);
    L.fill(ellipse(PX - 4, PY - 31, 15, 5), solid('#1864ab'));
    L.fill(bezier([PX - 16, PY - 32], [PX - 14, PY - 44], [PX + 8, PY - 44], [PX + 8, PY - 32], 12), vgrad('#339af0', '#1864ab', PY - 44, PY - 30));
    L.fill(roundRect(PX - 15, PY - 36, 22, 4, 2), solid(WHITE, 0.9));
  });
}

function tentacleHat(c) {
  // an octopus sitting on the head, its arms hanging down the sides of the hair (clear of the face)
  const paint = vgrad('#74c0fc', '#1864ab', HY - 30, HY + 110);
  for (const s of [-1, 1]) {
    for (const [x0, y0, x1, y1, w, up] of [[44, 14, 96, 40, 14, 1], [44, 30, 90, 84, 15, 1], [36, 38, 80, 112, 15, -1]]) {
      const pts = bezier([HX + x0 * s, HY + y0], [HX + (x0 + 26) * s, HY + y0 + 6], [HX + (x1 - 4) * s, HY + y1 - 26], [HX + x1 * s, HY + y1], 18);
      const [lx, ly] = pts[pts.length - 1];
      const curl = bezier([lx, ly], [lx + 6 * s, ly + 10 * up], [lx + 16 * s, ly + 6 * up], [lx + 14 * s, ly - 3 * up], 8).slice(1);
      const all = [...pts, ...curl];
      c.fill(taper(all, w, 5), paint);
      for (let k = 5; k < all.length - 4; k += 3) c.fill(circle(all[k][0] - 2.5 * s, all[k][1] + 3, 1.9 - k * 0.04), solid('#d0ebff'));
    }
  }
  c.fill(ellipse(HX, HY + 4, 56, 42), radial('#a5d8ff', '#1971c2', HX - 18, HY - 18, 76));
  for (const [x, y, r] of [[-34, -16, 5.5], [-42, 2, 3.6], [30, -24, 4.4], [42, -8, 3]]) c.fill(circle(HX + x, HY + y, r), solid('#d0ebff', 0.75));
  face(c, HX, HY + 10, 1.7, '#ff8fa3');
  envelope(c, HX + 112, HY + 68, 26, 18, 0.3);
  shine(c, HX - 24, HY - 20, 11, 5, -0.5, 0.5);
}

function mailSwirl(c) {
  const cx = HX; const cy = 168;
  for (const [a0, cc] of [[-Math.PI / 2, '#1c7ed6'], [Math.PI / 2, '#0ca678']]) {
    const arm = spiral(cx, cy, 30, 150, a0, a0 + Math.PI * 1.7, 120, 0.94);
    c.fill(taper(arm, 3, 22), radial('#e7f5ff', cc, cx, cy, 170, 0.9, 0.9));
    c.fill(taper(arm.slice(40), 1.5, 5), solid('#e3fafc', 0.85));
    for (const t of [0.55, 0.75, 0.95]) {
      const i = Math.round(t * 120); const [x, y] = arm[i]; const [px, py] = arm[i - 1];
      const sz = 14 + t * 14;
      envelope(c, x, y, sz * 1.4, sz, Math.atan2(y - py, x - px), t > 0.9 ? '#fa5252' : TEAL);
    }
  }
  for (const [x, y, r] of [[30, 120, 5], [42, 104, 3], [306, 230, 6], [296, 250, 3.5], [60, 300, 4], [290, 30, 4], [118, 26, 3.5]]) c.fill(ring(x, y, r, r, 1.6), solid('#d0ebff'));
}

// Coral branching off: a tapered stem, then two smaller branches (deterministic).
function coral(c, x, y, a, len, w, depth, paint, rand) {
  const ex = x + Math.cos(a) * len; const ey = y + Math.sin(a) * len;
  c.fill(taper(bezier([x, y], [x + Math.cos(a) * len * 0.4, y + Math.sin(a) * len * 0.4], [ex - Math.cos(a + 0.4) * len * 0.3, ey - Math.sin(a + 0.4) * len * 0.3], [ex, ey], 10), w, w * 0.7), paint);
  if (depth === 0) { c.fill(circle(ex, ey, w * 0.45), solid('#e6fcf5')); return; }
  for (const d of [-0.5, 0.45]) coral(c, ex, ey, a + d + (rand() - 0.5) * 0.3, len * 0.62, w * 0.7, depth - 1, paint, rand);
}
function seaCrown(c) {
  const rand = rng(77);
  const paint = vgrad('#e6fcf5', '#0ca678', HY - 70, HY + 10);
  for (const [dx, a, len, w] of [[-44, -2.2, 30, 9], [-24, -1.85, 34, 10], [24, -1.3, 34, 10], [44, -0.95, 30, 9], [-8, -1.62, 30, 8], [8, -1.52, 30, 8]]) coral(c, HX + dx, HY + 6, a, len, w, 2, paint, rand);
  for (const s of [-1, 1]) {
    const strand = bezier([HX + 54 * s, HY + 14], [HX + 70 * s, HY + 40], [HX + 74 * s, HY + 58], [HX + 92 * s, HY + 64], 12);
    strand.forEach(([x, y], i) => c.fill(circle(x, y, i % 3 === 2 ? 4.4 : 3.2), radial('#ffffff', '#d0bfff', x - 1, y - 1, 5)));
  }
  c.fill(roundRect(HX - 58, HY, 116, 20, 9), vgrad('#4dabf7', '#1864ab', HY, HY + 20));
  for (let i = 0; i < 13; i++) { const x = HX - 54 + i * 9; c.fill(circle(x, HY + 19, 4), radial('#ffffff', '#d0bfff', x - 1.2, HY + 17.6, 5)); }
  // the scallop at the front holding a pearl
  const sx = HX; const sy = HY + 2;
  const fan = [[sx, sy + 12]];
  for (let i = 0; i <= 40; i++) { const t = Math.PI * (1 + i / 40); const bump = 1 + 0.07 * Math.abs(Math.sin(i * Math.PI / 5)); fan.push([sx + Math.cos(t) * 26 * bump, sy + 8 + Math.sin(t) * 30 * bump]); }
  c.fill(fan, vgrad('#fff3bf', '#e0a526', sy - 22, sy + 12));
  for (let i = 1; i < 8; i++) { const t = Math.PI * (1 + i / 8); c.fill(stroke([[sx, sy + 10], [sx + Math.cos(t) * 24, sy + 8 + Math.sin(t) * 27]], 1.4), solid('#c98a14', 0.7)); }
  c.fill(circle(sx, sy - 2, 9), radial('#ffffff', '#c5f6fa', sx - 3, sy - 5, 11));
  c.fill(circle(sx - 3, sy - 5, 2.6), solid(WHITE));
  for (const s of [-1, 1]) gem(c, HX + 36 * s, HY + 10, 6, '#339af0');
  const st = rotate(star(HX - 50, HY - 30, 11, 5), HX - 50, HY - 30, 0.3);
  c.fill(st, radial('#ffe8cc', '#ff922b', HX - 52, HY - 33, 13));
  for (const [x, y] of st.filter((_, i) => i % 2 === 0)) c.fill(circle(x + (HX - 50 - x) * 0.45, y + (HY - 30 - y) * 0.45, 1.1), solid('#fff4e6'));
  for (const [x, y, r] of [[HX - 74, HY - 30, 4], [HX - 66, HY - 46, 2.6], [HX + 72, HY - 38, 4.4], [HX + 80, HY - 54, 2.6], [HX + 6, HY - 66, 3]]) c.fill(ring(x, y, r, r, 1.4), solid('#c5f6fa'));
  for (const [x, y, r] of [[HX - 92, HY + 6, 7], [HX + 94, HY - 4, 8], [HX - 30, HY - 64, 5]]) sparkle(c, x, y, r, '#e3fafc');
}

add('boss-email-clip', '信封发夹', 0, mailClip, { slot: 'head', boss: 'email' });
add('boss-email-pet', '章鱼信使', 1, mailPet, { slot: 'pet', boss: 'email' });
add('boss-email-tentacle', '触手帽', 2, tentacleHat, { slot: 'head', boss: 'email', glow: '#c5f6fa' });
add('boss-email-swirl', '邮件漩涡', 3, mailSwirl, { slot: 'fx', boss: 'email', layer: 'back', glow: '#74c0fc' });
add('boss-email-crown', '深海王冠', 4, seaCrown, { slot: 'head', boss: 'email', glow: '#63e6be' });

// 夺命连环 Call: answer green, hang-up red and the curly cord.
const CALL_GREEN = '#40c057';
const CALL_RED = '#f03e3e';
// The 📞 handset: a slim arched grip with a flared cup at each end, about 60 x 28 at s = 1.
function handset(c, x, y, s, a, color) {
  const f = frame(x, y, a, s);
  const cup = (cx, rot) => [f.pts(rotate(roundRect(cx - 9.5, -1, 19, 14, 6.5), cx, 6, rot))];
  c.fill([...f.line(bezier([-19, 0], [-10, -11], [10, -11], [19, 0], 16), 6.5), cup(-20, -0.45), cup(20, 0.45)], glossy(color, ...f(-8, -8), 36 * s));
  c.fill(f.line(bezier([-14, -5], [-8, -10], [4, -11], [10, -9], 10), 2), solid(WHITE, 0.55));
}
// A coiled cord following a path: loops seen from the side.
function coil(path, r, turns) {
  const out = []; const n = turns * 18;
  const at = (t) => { const k = Math.min(path.length - 2, Math.floor(t * (path.length - 1))); const u = t * (path.length - 1) - k; return [path[k], path[k + 1], u]; };
  for (let i = 0; i <= n; i++) {
    const t = i / n; const [[ax, ay], [bx, by], u] = at(t);
    const len = Math.hypot(bx - ax, by - ay) || 1; const tx = (bx - ax) / len; const ty = (by - ay) / len;
    const ph = t * turns * Math.PI * 2;
    out.push([ax + (bx - ax) * u - ty * r * Math.sin(ph) + tx * r * 0.8 * Math.cos(ph), ay + (by - ay) * u + tx * r * Math.sin(ph) + ty * r * 0.8 * Math.cos(ph)]);
  }
  return out;
}
function callClip(c) {
  const [hx, hy] = [HX - 50, HY + 10];
  const [ex, ey] = frame(hx, hy, -0.5, 1.1)(-24, 14);
  c.fill(stroke(coil(bezier([ex, ey], [ex - 2, ey + 10], [ex + 4, ey + 18], [ex + 2, ey + 28], 20), 3, 4), 1.8), solid('#2b8a3e'));
  handset(c, hx, hy, 1.1, -0.5, CALL_GREEN);
  ringLines(c, hx + 8, hy - 2, -1.75, '#ff922b', 26);
}

function callPet(c) {
  bossPet(c, (L) => {
    const body = [...bezier([PX - 34, PY + 32], [PX - 35, PY + 8], [PX - 30, PY - 8], [PX - 16, PY - 10], 12), ...bezier([PX + 16, PY - 10], [PX + 30, PY - 8], [PX + 35, PY + 8], [PX + 34, PY + 32], 12), [PX + 28, PY + 37], [PX - 28, PY + 37]];
    L.fill(stroke(coil(bezier([PX + 40, PY - 16], [PX + 54, PY - 2], [PX + 50, PY + 18], [PX + 34, PY + 24], 20), 3.5, 5), 2), solid('#a51111'));
    for (const sx of [-1, 1]) L.fill(roundRect(PX + sx * 22 - 5, PY - 18, 10, 12, 4), solid('#c92a2a'));
    L.fill(body, glossy(CALL_RED, PX - 6, PY + 4, 46));
    face(L, PX, PY + 2, 1.1);
    L.fill(circle(PX, PY + 23, 11.5), solid('#fff5f5'));
    for (let i = 0; i < 8; i++) { const a = -2.4 + i * 0.62; L.fill(circle(PX + Math.cos(a) * 7.6, PY + 23 + Math.sin(a) * 7.6, 2), solid('#c92a2a')); }
    L.fill(circle(PX, PY + 23, 2.6), solid(GOLD[1]));
    handset(L, PX, PY - 19, 1.12, 0, CALL_RED);
    shine(L, PX - 22, PY + 2, 3, 7, 0.3, 0.45);
  });
}

function headset(c) {
  const band = bezier([HX - 78, 160], [HX - 82, HY - 30], [HX + 78, HY - 30], [HX + 72, 160], 40);
  c.fill(stroke(band, 10), vgrad('#868e96', '#343a40', HY, 170));
  c.fill(stroke(band.slice(13, 28), 5), solid(CALL_GREEN));
  c.fill(stroke(bezier([HX - 74, 176], [HX - 70, 204], [HX - 58, 216], [HX - 40, 218], 16), 4.5), solid('#343a40'));
  c.fill(ellipse(HX - 36, 218, 8.5, 6.5), radial('#495057', '#212529', HX - 38, 216, 10));
  for (const [x, s] of [[HX - 78, -1], [HX + 72, 1]]) {
    c.fill(roundRect(x - 13, 146, 26, 42, 12), vgrad('#495057', '#212529', 146, 188));
    c.fill(ellipse(x + 5 * s, 167, 10, 17), glossy(CALL_GREEN, x + 2 * s, 160, 18));
    c.fill(ellipse(x + 3 * s, 160, 3, 7), solid(WHITE, 0.35));
  }
  c.fill(circle(HX - 78, 180, 3), solid('#ff6b6b'));
  handset(c, HX + 77, 167, 0.42, -0.6, WHITE);
}

function callWaves(c) {
  const cx = HX; const cy = 146;
  const arc = (r, a0, a1) => Array.from({ length: 25 }, (_, i) => [cx + Math.cos(a0 + ((a1 - a0) * i) / 24) * r, cy + Math.sin(a0 + ((a1 - a0) * i) / 24) * r]);
  [108, 132, 156].forEach((r, i) => {
    for (const base of [0, Math.PI]) c.fill(stroke(arc(r, base - 0.62 + i * 0.08, base + 0.62 - i * 0.08), 10 - i * 2.4), solid(i % 2 ? '#8ce99a' : CALL_GREEN, 1 - i * 0.18));
    if (i < 2) c.fill(stroke(arc(r, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42), 10 - i * 2.4), solid(i % 2 ? '#8ce99a' : CALL_GREEN, 1 - i * 0.18));
  });
  for (const [x, y, a] of [[34, 64, -0.5], [302, 64, 0.5], [30, 250, 0.3], [306, 252, -0.3]]) handset(c, x, y, 0.75, a, CALL_GREEN);
}

// Music notes: ♪ (one) or ♫ (two, beamed), standing on (x, y).
function note(c, x, y, s, a, color, two) {
  const f = frame(x, y, a, s);
  const p = glossy(color, x, y - 10 * s, 18 * s);
  if (two) {
    c.fill([[f.ell(-8, 0, 6, 4.4, -0.4)], [f.ell(10, -4, 6, 4.4, -0.4)], ...f.line([[-3, -1], [-3, -24]], 2.6), ...f.line([[15, -5], [15, -28]], 2.6), [f.pts([[-4.3, -27], [16.3, -31], [16.3, -24], [-4.3, -20]])]], p);
  } else {
    c.fill([[f.ell(0, 0, 6.5, 4.8, -0.4)], ...f.line([[5, -1], [5, -26]], 2.6), ...f.line(bezier([5, -26], [7, -20], [14, -18], [12, -8], 10), 2.6)], p);
  }
}
function callStorm(c) {
  // two streaks spiralling in over the head, clear of the lap
  for (const [r0, r1, a0, a1, cc] of [[158, 104, Math.PI * 0.78, Math.PI * 2.2, '#ffe066'], [140, 96, Math.PI * 0.92, Math.PI * 2.05, '#8ce99a']]) c.fill(taper(spiral(HX, 166, r0, r1, a0, a1, 90, 0.95), 2, 9), solid(cc, 0.85));
  const spots = [[30, 120, -0.3, 1.1, CALL_GREEN, 1], [52, 52, -0.2, 0.9, '#f6c445', 0], [300, 112, 0.3, 1.15, CALL_RED, 0], [300, 210, 0.2, 0.95, CALL_GREEN, 1], [26, 220, -0.2, 0.9, CALL_RED, 0], [292, 290, 0.3, 1, '#f6c445', 1], [40, 300, -0.2, 0.85, CALL_GREEN, 0], [262, 42, 0.2, 0.85, CALL_GREEN, 0]];
  for (const [x, y, a, s, cc, two] of spots) note(c, x, y, s, a, cc, two);
  // the golden handset above the head, ringing
  ringLines(c, HX + 8, 52, -Math.PI / 2 - 0.9, '#f6c445', 36, 2);
  ringLines(c, HX + 8, 52, -Math.PI / 2 + 0.9, '#f6c445', 36, 2);
  handset(c, HX + 8, 52, 1.4, -0.12, GOLD[1]);
  for (const [x, y, r] of [[HX - 52, 20, 7], [HX + 64, 16, 6], [86, 92, 5], [262, 96, 5]]) sparkle(c, x, y, r);
}

add('boss-call-clip', '听筒发卡', 0, callClip, { slot: 'head', boss: 'call' });
add('boss-call-pet', '复古电话', 1, callPet, { slot: 'pet', boss: 'call' });
add('boss-call-headset', '客服耳麦', 2, headset, { slot: 'head', boss: 'call', glow: '#d3f9d8' });
add('boss-call-waves', '来电铃波', 3, callWaves, { slot: 'fx', boss: 'call', layer: 'back', glow: '#b2f2bb' });
add('boss-call-storm', '铃声风暴', 4, callStorm, { slot: 'fx', boss: 'call', glow: '#ffe066' });

// 周报巨魔: chart blue, orange and green, and the troll's moss green.
const CHART = ['#339af0', '#ff922b', '#51cf66'];
const TROLL = '#94c25a';
// A white card with a little bar chart; f = frame at the card's centre.
function chartCard(c, f, w, h, bars = [0.35, 0.6, 0.9]) {
  c.fill(f.rect(-w / 2, -h / 2, w, h, 4), solid('#fcfdff'));
  const bw = (w - 10) / bars.length - 3;
  bars.forEach((v, i) => c.fill(f.rect(-w / 2 + 6 + i * (bw + 3), h / 2 - 5 - (h - 11) * v, bw, (h - 11) * v, 1.5), solid(CHART[i % 3])));
  c.fill(f.line([[-w / 2 + 4, h / 2 - 4.5], [w / 2 - 4, h / 2 - 4.5]], 1.2), solid('#868e96'));
}
function chartPin(c) {
  const f = frame(HX + 48, HY + 6, 0.22);
  chartCard(c, f, 34, 30);
  c.fill(f.line([[-11, 2], [-3, -4], [3, 0], [12, -11]], 2), solid('#e03131'));
  c.fill(f.pts([[15, -14], [7, -12.5], [13.5, -6.5]]), solid('#e03131'));
}

function trollPet(c) {
  bossPet(c, (L) => {
    const k = col(TROLL);
    const paint = shade(TROLL, PY - 32, PY + 36);
    for (const [x, a, h] of [[-10, -0.5, 22], [-3, -0.15, 28], [5, 0.2, 26], [12, 0.55, 20]]) L.fill(rotate(flameShape(PX + x, PY - 22, 13, h), PX + x, PY - 22, a), vgrad('#ffc078', '#e8590c', PY - 50, PY - 22));
    for (const s of [-1, 1]) L.fill([[PX + 18 * s, PY - 16], [PX + 34 * s, PY - 24], [PX + 22 * s, PY - 2]], paint);
    for (const s of [-1, 1]) L.fill([[PX + 20 * s, PY - 14], [PX + 29 * s, PY - 19], [PX + 22 * s, PY - 6]], solid('#d8f5a2'));
    for (const s of [-1, 1]) L.fill(ellipse(PX + 10 * s, PY + 35, 8, 4.5), solid(darken(k, 0.2)));
    L.fill(ellipse(PX, PY + 18, 23, 18), paint);
    L.fill(ellipse(PX, PY - 8, 26, 22), paint);
    for (const s of [-1, 1]) {
      L.fill(ellipse(PX + 9 * s, PY - 11, 3.3, 4.3), solid(INK));
      L.fill(circle(PX + 9 * s + 1, PY - 12.6, 1.2), solid(WHITE));
      L.fill(ellipse(PX + 17 * s, PY - 3, 4, 2.4), solid('#ff8fa3', 0.6));
      L.fill([[PX + 6 * s, PY + 4], [PX + 8.5 * s, PY - 1], [PX + 10 * s, PY + 4]], solid(WHITE));
    }
    L.fill(ellipse(PX, PY - 3, 6, 4.5), solid(darken(k, 0.15)));
    L.fill(stroke(bezier([PX - 9, PY + 4], [PX - 4, PY + 8], [PX + 4, PY + 8], [PX + 9, PY + 4], 10), 1.5), solid(INK));
    const f = frame(PX, PY + 22, -0.06);
    chartCard(L, f, 30, 24);
    for (const s of [-1, 1]) L.fill(circle(...f(16 * s, 2), 5), solid(lighten(k, 0.1)));
  });
}

function growthCrown(c) {
  [[-42, 22], [-22, 32], [0, 42], [22, 54]].forEach(([dx, h], i) => c.fill(roundRect(HX + dx - 8, HY + 4 - h, 16, h + 6, 3), vgrad(lighten(col(CHART[i % 3]), 0.35), CHART[i % 3], HY - h, HY + 6)));
  c.fill(roundRect(HX - 58, HY, 116, 20, 7), goldPaint(HY, HY + 20));
  for (let i = 0; i < 3; i++) gem(c, HX - 30 + i * 30, HY + 10, i === 1 ? 7 : 5.5, CHART[i]);
  const line = [[HX - 54, HY - 10], [HX - 32, HY - 24], [HX - 14, HY - 19], [HX + 8, HY - 42], [HX + 24, HY - 37], [HX + 46, HY - 58]];
  c.fill(stroke(line, 8), solid(WHITE));
  c.fill(stroke(line, 4.5), solid('#2f9e44'));
  for (const [x, y] of line.slice(1, -1)) { c.fill(circle(x, y, 5), solid(WHITE)); c.fill(circle(x, y, 3), solid('#2f9e44')); }
  const f = frame(HX + 46, HY - 58, Math.atan2(-21, 22));
  c.fill(f.pts([[14, 0], [-6, -12], [-6, 12]]), solid(WHITE));
  c.fill(f.pts([[10, 0], [-4, -8.5], [-4, 8.5]]), solid('#2f9e44'));
  shine(c, HX - 40, HY + 6, 8, 2.5, 0, 0.5);
}

function reportBoard(c) {
  const panel = (x, y, w, h) => {
    c.fill(roundRect(x, y, w, h, 8), vgrad('#f8fbff', '#d0ebff', y, y + h));
    c.fill(roundRect(x, y, w, 12, 6), solid('#339af0'));
    c.fill(rect(x, y + 6, w, 6), solid('#339af0'));
    for (let i = 0; i < 3; i++) c.fill(circle(x + 8 + i * 7, y + 6, 2), solid(WHITE, 0.85));
  };
  panel(12, 30, 90, 70);
  chartCard(c, frame(57, 70), 70, 46, [0.3, 0.55, 0.45, 0.85]);
  panel(236, 22, 90, 66);
  const pts = [[246, 76], [264, 66], [280, 70], [298, 50], [314, 40]];
  c.fill(stroke(pts, 3.5), solid('#2f9e44'));
  for (const [x, y] of pts) c.fill(circle(x, y, 3.2), solid('#2f9e44'));
  const pc = [292, 152]; const R = 26;
  c.fill(roundRect(pc[0] - 34, pc[1] - 34, 68, 68, 10), vgrad('#f8fbff', '#d0ebff', pc[1] - 34, pc[1] + 34));
  [[0, 0.45, 0], [0.45, 0.75, 1], [0.75, 1, 2]].forEach(([a, b, i]) => {
    const pts2 = [pc];
    for (let k = 0; k <= 20; k++) { const t = (-0.25 + a + ((b - a) * k) / 20) * Math.PI * 2; pts2.push([pc[0] + Math.cos(t) * R, pc[1] + Math.sin(t) * R]); }
    c.fill(pts2, solid(CHART[i]));
  });
  c.fill(circle(pc[0], pc[1], 10), solid('#f8fbff'));
  const gx = 46; const gy = 186;
  c.fill(roundRect(gx - 36, gy - 30, 72, 50, 10), vgrad('#f8fbff', '#d0ebff', gy - 30, gy + 20));
  c.fill(ring(gx, gy + 8, 26, 26, 7, 0, Math.PI, Math.PI * 1.62), solid(CHART[2]));
  c.fill(ring(gx, gy + 8, 26, 26, 7, 0, Math.PI * 1.62, Math.PI * 2), solid('#dee2e6'));
  c.fill(stroke([[gx, gy + 8], [gx + Math.cos(Math.PI * 1.62) * 20, gy + 8 + Math.sin(Math.PI * 1.62) * 20]], 2.6), solid(INK));
  c.fill(circle(gx, gy + 8, 3.5), solid(INK));
  for (const [x, y, r] of [[120, 24, 6], [216, 104, 5], [30, 120, 5], [310, 214, 6]]) sparkle(c, x, y, r, '#d0ebff');
}

// A golden ring with growth arrows shooting out of its upper half (shorter on top, where the
// canvas ends).
function kpiHalo(c) {
  const cx = HX; const cy = 146; const R = 102;
  for (let i = 0; i < 9; i++) {
    const ang = -Math.PI * 0.94 + i * ((Math.PI * 0.88) / 8);
    const ux = Math.cos(ang); const uy = Math.sin(ang);
    const len = 20 + 26 * Math.abs(ux) + (i % 2 ? 0 : 8);
    const f = frame(cx + ux * (R + len), cy + uy * (R + len), ang);
    c.fill(stroke([[cx + ux * R, cy + uy * R], f(-4, 0)], 7), vgrad('#b2f2bb', '#2f9e44', cy - 170, cy));
    c.fill(f.pts([[8, 0], [-8, -10], [-8, 10]]), solid(i % 2 ? '#51cf66' : GOLD[1]));
  }
  c.fill(ring(cx, cy, R, R, 14), vgrad(GOLD[0], GOLD[2], cy - R, cy + R));
  c.fill(ring(cx, cy, R - 8, R - 8, 3), solid(WHITE, 0.6));
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.fill(circle(cx + Math.cos(a) * (R - 7), cy + Math.sin(a) * (R - 7), 3), solid('#fff9db')); }
  for (const [x, y, r] of [[26, 70, 9], [310, 66, 9], [20, 236, 7], [318, 240, 7]]) sparkle(c, x, y, r);
}

add('boss-report-pin', '柱状图发卡', 0, chartPin, { slot: 'head', boss: 'report' });
add('boss-report-pet', '小巨魔', 1, trollPet, { slot: 'pet', boss: 'report' });
add('boss-report-crown', '增长头冠', 2, growthCrown, { slot: 'head', boss: 'report', glow: '#d3f9d8' });
add('boss-report-board', '数据看板', 3, reportBoard, { slot: 'fx', boss: 'report', layer: 'back', glow: '#a5d8ff' });
add('boss-report-halo', 'KPI 光环', 4, kpiHalo, { slot: 'fx', boss: 'report', layer: 'back', glow: '#ffe066' });

// 报销单妖: receipt white, stamp red, and money gold and green.
const STAMP = '#e03131';
// A receipt with zigzag torn ends, its print and a red seal; f at its centre.
function receipt(c, f, w, h, stamped = true) {
  const zig = (y, dir) => Array.from({ length: 9 }, (_, i) => [-w / 2 + (i * w) / 8, y + (i % 2 ? dir * 3 : 0)]);
  c.fill(f.pts([...zig(-h / 2, -1), ...zig(h / 2, 1).reverse()]), solid('#fffdf7'));
  for (let k = 0; k < 4; k++) c.fill(f.line([[-w / 2 + 5, -h / 2 + 7 + k * 5.5], [w / 2 - 5 - (k % 2) * 7, -h / 2 + 7 + k * 5.5]], 1.5), solid('#adb5bd'));
  c.fill(f.line([[-w / 2 + 5, h / 2 - 7], [w / 2 - 5, h / 2 - 7]], 2), solid('#495057'));
  if (stamped) seal(c, f, w * 0.18, h * 0.12, Math.min(w, h) * 0.24);
}
// A red seal: a ring round a star.
function seal(c, f, dx, dy, r) {
  c.fill(ring(...f(dx, dy), r, r, r * 0.16), solid(STAMP, 0.85));
  c.fill(star(...f(dx, dy), r * 0.55, r * 0.22), solid(STAMP, 0.85));
}
const yen = (c, f, s, color) => {
  for (const pts of [[[-5, -7], [0, -1], [5, -7]], [[0, -1], [0, 7]], [[-4.5, 1.5], [4.5, 1.5]], [[-4.5, 4.8], [4.5, 4.8]]]) c.fill(f.line(pts.map(([u, v]) => [u * s, v * s]), 1.9 * s), solid(color));
};
function receiptClip(c) {
  const f = frame(HX - 50, HY + 14, -0.3);
  receipt(c, f, 30, 42);
  c.fill(f.rect(-9, -26, 18, 8, 2), vgrad('#495057', '#212529', HY - 14, HY));
  c.fill(f.line([[-6, -26], [-4, -32], [4, -32], [6, -26]], 1.6), solid(GOLD[1]));
}

function receiptPet(c) {
  bossPet(c, (L) => {
    for (const sx of [-1, 1]) { L.fill(stroke([[PX + 9 * sx, PY + 28], [PX + 11 * sx, PY + 36]], 3), solid('#495057')); L.fill(ellipse(PX + 12 * sx, PY + 37, 6, 3), solid('#495057')); }
    L.fill(stroke(bezier([PX - 22, PY + 2], [PX - 32, PY + 4], [PX - 34, PY + 12], [PX - 30, PY + 18], 8), 2.6), solid('#495057'));
    L.fill(stroke(bezier([PX + 22, PY + 2], [PX + 32, PY], [PX + 36, PY - 6], [PX + 36, PY - 12], 8), 2.6), solid('#495057'));
    const zig = Array.from({ length: 11 }, (_, i) => [PX + 23 - i * 4.6, PY + 30 + (i % 2 ? 5 : 0)]);
    L.fill([[PX - 23, PY - 30], [PX + 23, PY - 30], ...zig], vgrad('#ffffff', '#e9ecef', PY - 30, PY + 34));
    L.fill(roundRect(PX - 27, PY - 40, 54, 13, 6.5), vgrad('#ffffff', '#ced4da', PY - 40, PY - 27));
    L.fill(ellipse(PX + 27, PY - 33.5, 3, 6.5), solid('#dee2e6'));
    for (const sx of [-1, 1]) {
      L.fill(ellipse(PX + 9 * sx, PY - 14, 3.3, 4.3), solid(INK));
      L.fill(circle(PX + 9 * sx + 1, PY - 15.6, 1.2), solid(WHITE));
      L.fill(ellipse(PX + 16 * sx, PY - 7, 4, 2.4), solid('#ff8fa3', 0.6));
    }
    L.fill(stroke(bezier([PX - 8, PY - 7], [PX - 3, PY - 2], [PX + 3, PY - 2], [PX + 8, PY - 7], 10), 1.6), solid(INK));
    L.fill([[PX + 3, PY - 3.4], [PX + 6.4, PY - 4.6], [PX + 5, PY - 0.6]], solid(WHITE));
    for (let k = 0; k < 3; k++) L.fill(stroke([[PX - 16, PY + 4 + k * 6], [PX + 10 - k * 6, PY + 4 + k * 6]], 1.8), solid('#adb5bd'));
    seal(L, frame(PX + 10, PY + 18), 0, 0, 7.5);
    const cx = PX + 37; const cy = PY - 18;
    L.fill(circle(cx, cy, 7), radial(GOLD[0], GOLD[2], cx - 2, cy - 2, 9));
    yen(L, frame(cx, cy), 0.6, '#c98a14');
  });
}

function stampHat(c) {
  c.fill([[HX - 20, HY - 6], [HX - 12, HY - 30], [HX + 12, HY - 30], [HX + 20, HY - 6]], vgrad('#ff6b6b', '#a51111', HY - 30, HY - 6));
  c.fill(circle(HX, HY - 46, 21), glossy(STAMP, HX, HY - 46, 21));
  c.fill(ring(HX, HY - 30, 14, 4, 3), solid(GOLD[1]));
  c.fill(roundRect(HX - 52, HY - 8, 104, 28, 7), vgrad('#ff8787', '#c92a2a', HY - 8, HY + 20));
  c.fill(rect(HX - 52, HY + 12, 104, 5), goldPaint(HY + 12, HY + 17));
  c.fill(roundRect(HX - 48, HY + 18, 96, 7, 3), solid('#7a0b0b'));
  c.fill(ellipse(HX, HY + 3, 15, 10), solid('#fff5f5'));
  seal(c, frame(HX, HY + 3), 0, 0, 8.5);
  shine(c, HX - 9, HY - 54, 6, 4, -0.6, 0.6);
  shine(c, HX - 38, HY - 2, 8, 2.5, 0, 0.45);
}

function coin(c, x, y, r, tilt = 1) {
  const rx = r * tilt;
  c.fill(ellipse(x + (1 - tilt) * r * 0.3, y + r * 0.08, rx, r), solid('#c98a14'));
  c.fill(ellipse(x, y, rx, r), radial(GOLD[0], GOLD[1], x - rx * 0.35, y - r * 0.35, r * 1.3));
  c.fill(ring(x, y, rx * 0.78, r * 0.78, r * 0.09), solid(GOLD[2], 0.6));
  if (tilt > 0.6) yen(c, frame(x, y), r / 11, '#c98a14');
}
function coinRain(c) {
  const coins = [[46, 52, 13, 1], [100, 36, 9, 0.5], [246, 42, 11, 0.8], [298, 70, 14, 1], [314, 160, 10, 0.4], [302, 232, 12, 0.9], [26, 140, 11, 0.7], [34, 226, 13, 1], [292, 300, 10, 0.6], [56, 300, 9, 0.9], [HX + 2, 28, 8, 1]];
  for (const [x, y, r, t] of coins) {
    for (const dx of [-r * 0.5, 0, r * 0.5]) c.fill(stroke([[x + dx, y - r - 6 - Math.abs(dx) * 0.3], [x + dx, y - r - 16 + Math.abs(dx) * 0.4]], 1.8), solid('#ffe066', 0.9));
    coin(c, x, y, r, t);
  }
  for (const [x, y, r] of [[72, 100, 6], [270, 112, 6], [20, 80, 5], [320, 112, 5], [150, 30, 5]]) sparkle(c, x, y, r);
}

// A gold ingot (元宝): a boat with turned-up ends and a dome in the middle.
function ingot(c, x, y, s) {
  c.fill(ellipse(x, y - 3 * s, 13 * s, 11 * s), radial(GOLD[0], GOLD[1], x - 4 * s, y - 9 * s, 15 * s));
  const boat = [...bezier([x - 28 * s, y - 10 * s], [x - 24 * s, y + 12 * s], [x + 24 * s, y + 12 * s], [x + 28 * s, y - 10 * s], 16), ...bezier([x + 28 * s, y - 10 * s], [x + 14 * s, y + s], [x - 14 * s, y + s], [x - 28 * s, y - 10 * s], 16).slice(1, -1)];
  c.fill(boat, goldPaint(y - 10 * s, y + 12 * s));
  c.fill(stroke(bezier([x - 24 * s, y - 6 * s], [x - 12 * s, y + 2 * s], [x + 12 * s, y + 2 * s], [x + 24 * s, y - 6 * s], 12), 1.6 * s), solid(WHITE, 0.5));
}
function banknote(c, x, y, a) {
  const f = frame(x, y, a);
  c.fill(f.rect(-19, -10, 38, 20, 2.5), vgrad('#8ce99a', '#2b8a3e', y - 12, y + 12));
  c.fill(f.rect(-16, -7, 32, 14, 2), solid('#d3f9d8', 0.55));
  c.fill(f.circ(0, 0, 5.5), solid('#b2f2bb'));
  yen(c, frame(...f(0, 0), a), 0.5, '#2b8a3e');
}
function fullRefund(c) {
  const cx = HX; const cy = 150;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2; const len = Math.min(i % 2 ? 160 : 200, reach(cx, cy, a));
    c.fill(rotate([[cx - 11, cy], [cx, cy - len], [cx + 11, cy]], cx, cy, a), radial('#fff3bf', '#ffd43b', cx, cy, len, 0.75, 0));
  }
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 - Math.PI / 2; const x = cx + Math.cos(a) * 148; const y = cy - 20 + Math.sin(a) * 110;
    if (y > 270) continue;
    coin(c, x, y, 10, 0.55 + 0.45 * Math.abs(Math.cos(a * 1.3)));
  }
  for (const [x, y, a] of [[40, 100, -0.4], [298, 112, 0.35], [30, 250, 0.3], [306, 262, -0.3]]) banknote(c, x, y, a);
  ingot(c, cx, 30, 1.2);
  ingot(c, 70, 40, 0.8);
  ingot(c, 268, 36, 0.8);
  for (const [x, y, r] of [[20, 30, 8], [316, 26, 8], [HX - 46, 14, 6], [HX + 48, 16, 6], [16, 180, 6], [320, 190, 6]]) sparkle(c, x, y, r);
}

add('boss-expense-clip', '发票发夹', 0, receiptClip, { slot: 'head', boss: 'expense' });
add('boss-expense-pet', '报销小妖', 1, receiptPet, { slot: 'pet', boss: 'expense' });
add('boss-expense-stamp', '印章帽', 2, stampHat, { slot: 'head', boss: 'expense', glow: '#ffe8a3' });
add('boss-expense-coins', '金币雨', 3, coinRain, { slot: 'fx', boss: 'expense', glow: '#ffe066' });
add('boss-expense-gold', '全额报销', 4, fullRefund, { slot: 'fx', boss: 'expense', layer: 'back', glow: '#ffd43b' });

// 会议机器人: robot silver and blue, LED cyan.
const LED = '#3bc9db';
const ROBOT = '#4c6ef5';
const hexagon = (f, r, rot = 0) => f.pts(Array.from({ length: 6 }, (_, i) => [Math.cos(rot + (i * Math.PI) / 3) * r, Math.sin(rot + (i * Math.PI) / 3) * r]));
// A screw through the hair with a blue nut on it.
function boltClip(c) {
  const f = frame(HX + 44, HY + 8, -0.7);
  c.fill(f.pts([[-5.5, 6], [5.5, 6], [5.5, 34], [0, 42], [-5.5, 34]]), vgrad('#ffffff', '#adb5bd', HY, HY + 40));
  for (let y = 12; y < 35; y += 4.5) c.fill(f.line([[-5, y + 2], [5, y - 1]], 1.4), solid('#868e96', 0.8));
  c.fill(hexagon(frame(...f(0, 24)), 11, 0.3), vgrad('#91a7ff', '#3b5bdb', HY + 10, HY + 36));
  c.fill(f.circ(0, 24, 4.6), solid('#1b2a6b'));
  c.fill(f.circ(0, 0, 13), radial('#ffffff', '#adb5bd', ...f(-4, -5), 17));
  const [sx, sy] = f(0, 0);
  c.fill(stroke([[sx - 7, sy], [sx + 7, sy]], 3), solid('#495057'));
  c.fill(stroke([[sx, sy - 7], [sx, sy + 7]], 3), solid('#495057'));
  c.fill(circle(sx + 14, sy - 12, 3.6), radial('#e3fafc', LED, sx + 13, sy - 13, 4.5));
}

function robotPet(c) {
  bossPet(c, (L) => {
    const steel = vgrad('#f8f9fa', '#adb5bd', PY - 36, PY + 6);
    L.fill(stroke([[PX, PY - 34], [PX, PY - 46]], 2.6), solid('#868e96'));
    L.fill(circle(PX, PY - 48, 5), radial('#ffffff', LED, PX - 1.5, PY - 49.5, 6));
    for (const sx of [-1, 1]) {
      const hy = sx > 0 ? PY + 10 : PY + 22; // waving with the right hand
      L.fill(stroke([[PX + 18 * sx, PY + 14], [PX + 30 * sx, hy]], 5), solid('#adb5bd'));
      L.fill(circle(PX + 31 * sx, hy, 4.5), solid('#868e96'));
      L.fill(roundRect(PX + 12 * sx - 6, PY + 32, 12, 7, 3), solid('#495057'));
    }
    L.fill(roundRect(PX - 20, PY + 4, 40, 31, 9), vgrad('#748ffc', '#364fc7', PY + 4, PY + 35));
    L.fill(roundRect(PX - 11, PY + 12, 22, 13, 4), solid('#1b2a6b'));
    ['#ff6b6b', '#ffd43b', '#69db7c'].forEach((cc, i) => L.fill(circle(PX - 6 + i * 6, PY + 18.5, 2), solid(cc)));
    for (const sx of [-1, 1]) L.fill(roundRect(PX + 26 * sx - 4, PY - 20, 8, 14, 3), solid(ROBOT));
    L.fill(roundRect(PX - 27, PY - 34, 54, 40, 13), steel);
    L.fill(roundRect(PX - 20, PY - 27, 40, 26, 9), vgrad('#1b2a6b', '#0b1440', PY - 27, PY - 1));
    for (const sx of [-1, 1]) L.fill(stroke(bezier([PX + 9 * sx - 5, PY - 13], [PX + 9 * sx - 3, PY - 18], [PX + 9 * sx + 3, PY - 18], [PX + 9 * sx + 5, PY - 13], 8), 2.2), solid('#99e9f2'));
    L.fill(stroke(bezier([PX - 5, PY - 8], [PX - 2, PY - 5], [PX + 2, PY - 5], [PX + 5, PY - 8], 8), 1.8), solid('#99e9f2'));
    for (const sx of [-1, 1]) L.fill(ellipse(PX + 14 * sx, PY - 7, 3.4, 2), solid('#ff8fa3', 0.7));
    L.fill(roundRect(PX - 23, PY - 32, 30, 4, 2), solid(WHITE, 0.6));
  });
}

// A holographic visor over the eyes, with holes so the eyes still show.
function visor(c) {
  const L = new Canvas();
  const top = bezier([EX - 62, EY - 8], [EX - 30, EY - 24], [EX + 30, EY - 24], [EX + 62, EY - 8], 20);
  const band = [...top, ...bezier([EX + 62, EY - 8], [EX + 66, EY + 6], [EX + 58, EY + 15], [EX + 44, EY + 16], 8).slice(1), ...bezier([EX + 44, EY + 16], [EX + 20, EY + 21], [EX - 20, EY + 21], [EX - 44, EY + 16], 16).slice(1), ...bezier([EX - 44, EY + 16], [EX - 58, EY + 15], [EX - 66, EY + 6], [EX - 62, EY - 8], 8).slice(1, -1)];
  L.fill(band, (x) => [...mix(hex('#99e9f2'), hex('#4263eb'), Math.max(0, Math.min(1, (x - EX + 62) / 124))), 0.95]);
  for (let y = EY - 22; y < EY + 22; y += 4) L.fill(rect(EX - 66, y, 132, 1.3), solid(WHITE, 0.3), 'atop');
  L.fill(eyeHoles(), solid(WHITE), 'erase');
  c.draw(L);
  c.fill(stroke(top, 3), solid('#dee2e6'));
  for (const s of [-1, 1]) {
    c.fill(ring(EX + 20.5 * s, EY + 1, 12.6, 10.1, 2.2, 0.1 * s), solid('#e3fafc'));
    c.fill(roundRect(EX + 66 * s - 7, EY - 10, 14, 22, 6), vgrad('#f1f3f5', '#868e96', EY - 10, EY + 12));
    c.fill(circle(EX + 66 * s, EY + 1, 3), solid(LED));
  }
  for (const [x, y, a] of [[EX - 37, EY - 11, 0], [EX + 37, EY - 11, Math.PI / 2]]) c.fill(stroke(rotate([[x, y + 5], [x, y], [x + 5, y]], x, y, a), 1.4), solid(WHITE, 0.9));
  [4, 7, 5].forEach((h, i) => c.fill(rect(EX + 42 + i * 4, EY + 10 - h, 2.5, h), solid('#e3fafc')));
}

function projScreen(c) {
  c.fill(roundRect(22, 20, 292, 182, 4), vgrad('#ffffff', '#e7f5ff', 20, 202));
  c.fill(roundRect(40, 30, 256, 26, 6), vgrad('#5c7cfa', '#364fc7', 30, 56));
  for (const [x0, x1, y] of [[52, 150, 40], [52, 112, 47]]) c.fill(stroke([[x0, y], [x1, y]], 3.2), solid(WHITE, 0.9));
  c.fill(circle(280, 43, 7), radial('#ffffff', LED, 278, 41, 8));
  for (let i = 0; i < 4; i++) {
    const y = 78 + i * 22;
    c.fill(circle(42, y, 3.4), solid(LED));
    c.fill(stroke([[52, y], [86 - (i % 2) * 12, y]], 3), solid('#adb5bd'));
  }
  [[0.4, 0], [0.65, 1], [0.5, 2], [0.95, 0]].forEach(([v, i], k) => c.fill(rect(244 + k * 15, 170 - v * 90, 11, v * 90), solid([ROBOT, LED, '#ffd43b'][i])));
  c.fill(stroke([[240, 170.5], [306, 170.5]], 1.6), solid('#868e96'));
  c.fill(roundRect(12, 12, 312, 14, 7), vgrad('#f8f9fa', '#868e96', 12, 26));
  for (const x of [12, 318]) c.fill(roundRect(x, 10, 6, 18, 3), solid('#495057'));
  c.fill(stroke([[300, 202], [300, 222]], 1.6), solid('#868e96'));
  c.fill(ring(300, 228, 6, 6, 2.4), solid('#868e96'));
}

function aiHalo(c) {
  const cx = HX; const cy = 138; const R = 100;
  const rand = rng(5);
  for (let i = 0; i < 18; i++) {
    const a = -Math.PI / 2 + ((i - 8.5) / 18) * Math.PI * 1.9;
    const l1 = 16 + rand() * 18; const turn = (rand() < 0.5 ? -1 : 1) * 0.35;
    const p0 = [cx + Math.cos(a) * R, cy + Math.sin(a) * R];
    const p1 = [cx + Math.cos(a) * (R + l1), cy + Math.sin(a) * (R + l1)];
    const p2 = [p1[0] + Math.cos(a + turn) * 22, p1[1] + Math.sin(a + turn) * 22];
    if (p2[1] < 12 || p2[0] < 12 || p2[0] > W - 12) continue; // the chip covers the top; keep on the canvas
    c.fill(stroke([p0, p1, p2], 3), solid('#99e9f2'));
    c.fill(ring(p2[0], p2[1], 4.5, 4.5, 2.2), solid(LED));
  }
  c.fill(ring(cx, cy, R + 6, R + 6, 16), vgrad('#5c7cfa', '#1b2a6b', cy - R, cy + R));
  c.fill(ring(cx, cy, R - 1, R - 1, 2.4), solid('#99e9f2'));
  c.fill(ring(cx, cy, R + 4, R + 4, 1.6), solid('#99e9f2', 0.7));
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; c.fill(circle(cx + Math.cos(a) * (R + 4), cy + Math.sin(a) * (R + 4), i % 3 ? 1.6 : 2.6), solid('#e3fafc')); }
  const chip = [cx, cy - R - 2];
  for (let i = -2; i <= 2; i++) for (const s of [-1, 1]) c.fill(stroke([[chip[0] + i * 6, chip[1] + 16 * s], [chip[0] + i * 6, chip[1] + 22 * s]], 2.2), solid('#dee2e6'));
  c.fill(roundRect(chip[0] - 18, chip[1] - 16, 36, 32, 6), vgrad('#364fc7', '#0b1440', chip[1] - 16, chip[1] + 16));
  c.fill(stroke([[chip[0] - 11, chip[1] + 8], [chip[0] - 5, chip[1] - 8], [chip[0] + 1, chip[1] + 8]], 2.6), solid('#99e9f2'));
  c.fill(stroke([[chip[0] - 8.5, chip[1] + 2], [chip[0] - 1.5, chip[1] + 2]], 2.2), solid('#99e9f2'));
  c.fill(stroke([[chip[0] + 8, chip[1] - 8], [chip[0] + 8, chip[1] + 8]], 2.6), solid('#99e9f2'));
  for (const [x, y, r] of [[28, 60, 8], [310, 56, 9], [18, 220, 6], [320, 214, 6]]) sparkle(c, x, y, r, '#e3fafc');
}

add('boss-meeting-bolt', '螺丝发卡', 0, boltClip, { slot: 'head', boss: 'meeting' });
add('boss-meeting-pet', '会议小机器人', 1, robotPet, { slot: 'pet', boss: 'meeting' });
add('boss-meeting-visor', '全息眼罩', 2, visor, { slot: 'head', boss: 'meeting' });
add('boss-meeting-screen', '投影幕布', 3, projScreen, { slot: 'fx', boss: 'meeting', layer: 'back', glow: '#c5f6fa' });
add('boss-meeting-halo', 'AI 光环', 4, aiHalo, { slot: 'fx', boss: 'meeting', layer: 'back', glow: '#66d9e8' });

// 已读不回幽灵: ghost white and lavender, chat-bubble green.
const CHAT_GREEN = '#69db7c';
// A speech bubble centred on (x, y); the tail points down on the side `tail` (-1 left, 1 right).
function bubble(c, x, y, w, h, color, tail = -1, a = 0) {
  const f = frame(x, y, a);
  const k = col(color);
  const paint = vgrad(lighten(k, 0.25), darken(k, 0.05), y - h / 2, y + h / 2);
  c.fill([[f.rect(-w / 2, -h / 2, w, h, Math.min(h / 2, 12))], [f.pts([[tail * w * 0.12, h / 2 - 2], [tail * w * 0.42, h / 2 + 9], [tail * w * 0.34, h / 2 - 2]])]], paint);
  return f;
}
const ticks = (c, f, color, s = 1) => {
  for (const dx of [-5, 3]) c.fill(f.line([[dx - 6 * s, 0], [dx - 2 * s, 4 * s], [dx + 6 * s, -5 * s]], 2.6 * s), solid(color));
};
const dots = (c, f, color, r = 2.4) => { for (const dx of [-8, 0, 8]) c.fill(f.circ(dx * r / 2.4, 0, r), solid(color)); };
function readBubble(c) {
  const f = bubble(c, HX + 48, HY - 4, 46, 30, CHAT_GREEN, -1, 0.12);
  ticks(c, f, WHITE, 1.1);
}

const ghostShape = (x, y, w, h, waves = 3) => {
  const pts = [];
  for (let i = 0; i <= 24; i++) { const t = Math.PI + (i / 24) * Math.PI; pts.push([x + Math.cos(t) * w / 2, y + Math.sin(t) * w / 2]); }
  pts.push([x + w / 2, y + h]);
  for (let i = 1; i <= waves * 8; i++) { const t = i / (waves * 8); pts.push([x + w / 2 - t * w, y + h - Math.abs(Math.sin(t * waves * Math.PI)) * w * 0.12]); }
  return pts;
};
function ghostPet(c) {
  bossPet(c, (L) => {
    L.fill(ellipse(PX, PY + 37, 22, 4.5), solid('#b197fc', 0.35));
    for (const sx of [-1, 1]) L.fill(ellipse(PX + 27 * sx, PY + 6, 7, 10, -0.6 * sx), vgrad('#ffffff', '#e5dbff', PY - 4, PY + 16));
    L.fill(ghostShape(PX, PY - 6, 56, 34), vgrad('#ffffff', '#d0bfff', PY - 34, PY + 30));
    face(L, PX, PY - 4, 1.2, '#f783ac');
    const f = bubble(L, PX + 28, PY - 42, 26, 17, CHAT_GREEN, -1, 0);
    dots(L, f, WHITE, 2);
  });
}

// A sheer veil pinned on by a little ghost, falling down both sides of the hair (drawn without the
// sticker outline so the hair shows through; the ghost gets its own).
function ghostVeil(c) {
  for (const s of [-1, 1]) {
    const edge = bezier([HX + 30 * s, HY + 4], [HX + 92 * s, HY + 6], [HX + 104 * s, 170], [HX + 96 * s, 238], 24);
    const inner = bezier([HX + 82 * s, 236], [HX + 84 * s, 180], [HX + 72 * s, 120], [HX + 26 * s, HY + 16], 24);
    const hem = Array.from({ length: 13 }, (_, i) => { const t = i / 12; return [HX + (96 - 14 * t) * s, 238 + Math.sin(t * Math.PI * 2) * 4]; });
    const veil = [...edge, ...hem.slice(1), ...inner.slice(1)];
    c.fill(veil, vgrad('#ffffff', '#d0bfff', HY, 240, 0.62));
    c.fill(stroke(edge, 1.8), solid('#9775fa', 0.65));
    hem.forEach(([x, y], i) => { if (i % 2 === 0) c.fill(circle(x, y + 2, 3), solid('#e5dbff', 0.95)); });
    for (const t of [0.35, 0.6, 0.85]) { const [x, y] = edge[Math.round(t * 24)]; sparkle(c, x - 8 * s, y + 6, 4, '#ffffff', 0.9); }
  }
  const g = ghostShape(HX, HY - 4, 66, 28);
  c.fill(stroke([...g, g[0]], 4), solid('#7950f2', 0.7));
  c.fill(g, vgrad('#ffffff', '#e5dbff', HY - 36, HY + 24));
  for (const sx of [-1, 1]) { c.fill(ellipse(HX + 13 * sx, HY + 2, 4.5, 6.2), solid(INK)); c.fill(circle(HX + 13 * sx + 1.4, HY - 0.6, 1.5), solid(WHITE)); c.fill(ellipse(HX + 22 * sx, HY + 10, 4.6, 2.4), solid('#f783ac', 0.6)); }
  c.fill(ellipse(HX, HY + 12, 3.2, 4), solid(INK));
  for (const [x, y, r] of [[HX - 52, HY - 26, 6], [HX + 54, HY - 30, 7]]) sparkle(c, x, y, r, '#d0bfff');
}

function chatCloud(c) {
  const items = [[56, 62, 62, 38, CHAT_GREEN, 1, 'dots'], [282, 50, 64, 38, WHITE, -1, 'ticks'], [298, 156, 46, 34, '#d0bfff', -1, 'heart'], [34, 168, 46, 32, WHITE, 1, 'q'], [HX + 2, 22, 40, 26, CHAT_GREEN, 1, 'ticks'], [296, 248, 44, 28, WHITE, -1, 'dots'], [38, 250, 40, 28, '#d0bfff', 1, 'dots']];
  for (const [x, y, w, h, cc, tail, kind] of items) {
    const f = bubble(c, x, y, w, h, cc, tail, tail * -0.08);
    const ink = cc === WHITE ? '#40c057' : WHITE;
    if (kind === 'dots') dots(c, f, ink, h / 12);
    if (kind === 'ticks') ticks(c, f, ink, h / 30);
    if (kind === 'heart') c.fill(heart(...f(0, 1), h * 0.42), solid('#f06595'));
    if (kind === 'q') { c.fill(f.line(bezier([-6, -4], [-6, -12], [6, -12], [6, -5], 10).concat([[0, 0], [0, 3]]), 3), solid('#9775fa')); c.fill(f.circ(0, 9, 2), solid('#9775fa')); }
  }
}

// Will-o'-wisps: a glowing round head trailing a wavy flame, with a soft halo.
function wisp(c, x, y, s, a, k) {
  const f = frame(x, y, a, s);
  const [light, deep] = [['#e5dbff', '#7048e8'], ['#d0ebff', '#1c7ed6']][k];
  c.fill(circle(x, y, 30 * s), radial(light, light, x, y, 30 * s, 0.5, 0));
  const tail = f.pts(bezier([0, 0], [10, -26], [-16, -36], [-4, -60], 20).map(([u, v], i) => [u + Math.sin(i * 0.9) * 2.5, v]));
  c.fill(taper(tail, 25 * s, 1.5 * s), radial(light, deep, x, y, 62 * s, 0.95, 0.6));
  c.fill(taper(tail.slice(0, 12), 13 * s, 3 * s), solid(WHITE, 0.7));
  c.fill(f.circ(0, 1, 12.5), radial('#ffffff', light, ...f(-2, -2), 14 * s));
  for (const sx of [-1, 1]) c.fill(f.ell(4.2 * sx, 1, 1.6, 2.5), solid(deep));
}
function wispRing(c) {
  const mist = spiral(HX, 176, 150, 128, Math.PI * 0.7, Math.PI * 2.3, 100, 0.95);
  c.fill(taper(mist, 4, 16), radial('#e5dbff', '#a5d8ff', HX, 176, 160, 0.4, 0.5));
  const spots = [[44, 92, 1.05, -0.4, 0], [292, 72, 1.1, 0.4, 1], [306, 184, 0.92, 0.6, 0], [32, 198, 0.95, -0.3, 1], [300, 290, 0.85, 0.5, 1], [40, 294, 0.85, -0.5, 0], [HX - 62, 62, 0.82, -0.2, 1], [HX + 72, 58, 0.78, 0.3, 0]];
  for (const [x, y, s, a, k] of spots) wisp(c, x, y, s, a, k);
  for (const [x, y, r] of [[96, 140, 5], [250, 130, 6], [HX, 12, 6], [16, 122, 5], [326, 124, 5], [170, 300, 5]]) sparkle(c, x, y, r, '#ffffff');
}

add('boss-ghost-bubble', '已读气泡', 0, readBubble, { slot: 'head', boss: 'ghost' });
add('boss-ghost-pet', '小幽灵', 1, ghostPet, { slot: 'pet', boss: 'ghost' });
add('boss-ghost-veil', '幽灵面纱', 2, ghostVeil, { slot: 'head', boss: 'ghost', outline: 0 });
add('boss-ghost-chat', '消息气泡云', 3, chatCloud, { slot: 'fx', boss: 'ghost', layer: 'back', glow: '#e5dbff' });
add('boss-ghost-wisp', '幽冥鬼火', 4, wispRing, { slot: 'fx', boss: 'ghost', glow: '#9775fa', outline: 0 });

// 画饼大师: crust gold-brown, cream and cherry red.
const CRUST = '#e8a33d';
const CHERRY = '#e03131';
function cherry(c, x, y, r) {
  c.fill(stroke(bezier([x, y - r * 0.6], [x + r * 0.2, y - r * 1.4], [x + r * 0.8, y - r * 1.9], [x + r * 1.2, y - r * 2.1], 8), r * 0.25), solid('#5c940d'));
  c.fill(circle(x, y, r), glossy(CHERRY, x, y, r));
}
function cookieClip(c) {
  const x = HX - 52; const y = HY + 12;
  const L = new Canvas();
  L.fill(circle(x, y, 18), radial('#ffd8a8', '#c97b2a', x - 5, y - 5, 24));
  L.fill(ring(x, y, 18, 18, 2.6), solid('#a8641e', 0.5), 'atop');
  for (const [dx, dy, r] of [[-7, -6, 3], [5, -9, 2.6], [8, 4, 3.2], [-4, 7, 2.8], [-10, 2, 2]]) L.fill(ellipse(x + dx, y + dy, r, r * 0.8, 0.5), solid('#6b3d1a'), 'atop');
  for (const [dx, dy, r] of [[14, -12, 6], [19, -5, 5], [10, -17, 4.5]]) L.fill(circle(x + dx, y + dy, r), solid(WHITE), 'erase');
  c.draw(L);
  for (const [dx, dy, r] of [[22, -16, 1.8], [25, -10, 1.4]]) c.fill(circle(x + dx, y + dy, r), solid('#e0a050'));
}

// A cherry pie seen from the front and a little above, its top centred on (x, y); s = 1 is 64 wide.
function cherryPie(c, x, y, s) {
  const rx = 32 * s; const ry = 16 * s; const h = 16 * s;
  const side = [[x - rx, y], ...Array.from({ length: 25 }, (_, i) => { const t = Math.PI - (i / 24) * Math.PI; return [x + Math.cos(t) * rx * 0.94, y + h + Math.sin(t) * ry]; }), [x + rx, y]];
  c.fill(side, vgrad('#f4b860', '#b8701f', y, y + h + ry));
  const L = new Canvas();
  L.fill(ellipse(x, y, rx * 0.86, ry * 0.8), radial('#ff6b6b', '#a51111', x, y, rx));
  const strip = vgrad('#ffd8a8', '#e8a33d', y - ry, y + ry);
  for (let i = -2; i <= 2; i++) L.fill(rect(x + i * 11 * s - 3 * s, y - ry, 6 * s, ry * 2), strip, 'atop');
  for (let i = -1; i <= 1; i++) L.fill(rect(x - rx, y + i * 7.5 * s - 2.4 * s, rx * 2, 4.8 * s), strip, 'atop');
  c.draw(L);
  for (let i = 0; i < 28; i++) { const t = (i / 28) * Math.PI * 2; c.fill(circle(x + Math.cos(t) * rx * 0.92, y + Math.sin(t) * ry * 0.92, 3.6 * s), vgrad('#ffe8b0', '#d18b2c', y - ry - 4, y + ry + 4)); }
}
function piePet(c) {
  bossPet(c, (L) => {
    for (const sx of [-1, 1]) L.fill(ellipse(PX + 16 * sx, PY + 39, 7, 4), solid('#b8701f'));
    cherryPie(L, PX, PY + 2, 1.05);
    face(L, PX, PY + 25, 1.0, '#ff8787');
    for (const [dx, dy, r] of [[12, -4, 6], [20, -6, 5], [16, -10, 5]]) L.fill(circle(PX + dx, PY + dy, r), vgrad('#ffffff', '#fff0d1', PY - 16, PY + 4));
    cherry(L, PX + 16, PY - 15, 5.5);
  });
}

function chefHat(c) {
  const puff = [[-34, -20, 22], [34, -20, 22], [-16, -34, 24], [16, -34, 24], [0, -44, 22], [0, -18, 26]];
  for (const [dx, dy, r] of puff) c.fill(circle(HX + dx, HY + dy, r + 1.5), solid('#dee2e6'));
  for (const [dx, dy, r] of puff) c.fill(circle(HX + dx, HY + dy, r), radial('#ffffff', '#e9ecef', HX + dx - r * 0.4, HY + dy - r * 0.4, r * 1.4));
  c.fill(roundRect(HX - 46, HY - 6, 92, 30, 7), vgrad('#ffffff', '#dee2e6', HY - 6, HY + 24));
  for (let x = -36; x <= 36; x += 12) c.fill(stroke([[HX + x, HY - 2], [HX + x, HY + 20]], 1.4), solid('#ced4da'));
  c.fill(rect(HX - 46, HY + 12, 92, 6), solid(CRUST));
  cherryPie(c, HX + 26, HY + 8, 0.36);
  cherry(c, HX - 28, HY + 12, 5);
}

function pieHalo(c) {
  const cx = HX; const cy = 136; const R = 106;
  const rim = [];
  for (let i = 0; i < 240; i++) { const t = (i / 240) * Math.PI * 2; rim.push([cx + Math.cos(t) * (R + 4 * Math.abs(Math.sin(t * 20))), cy + Math.sin(t) * (R + 4 * Math.abs(Math.sin(t * 20)))]); }
  c.fill(rim, radial('#ffe8b0', '#c4741f', cx, cy, R + 6));
  const L = new Canvas();
  L.fill(circle(cx, cy, R - 14), radial('#ff6b6b', '#a51111', cx - 20, cy - 30, R));
  for (const a of [Math.PI / 4, -Math.PI / 4]) for (let i = -5; i <= 5; i++) L.fill(rotate(rect(cx + i * 22 - 6, cy - R, 12, R * 2), cx, cy, a), vgrad('#ffe8b0', '#e8a33d', cy - R, cy + R), 'atop');
  c.draw(L);
  for (const [x, y, r] of [[cx - 66, cy - 44, 7], [cx + 66, cy - 40, 6], [cx - 30, cy - 82, 6], [cx + 34, cy - 84, 7], [cx - 92, cy + 10, 6], [cx + 94, cy + 6, 6]]) cherry(c, x, y, r);
  for (const s of [-1, 1]) c.fill(stroke(bezier([cx + 40 * s, cy - R - 4], [cx + 47 * s, cy - R - 11], [cx + 35 * s, cy - R - 15], [cx + 41 * s, cy - R - 22], 12), 3), solid(WHITE, 0.8));
  for (const [x, y, r] of [[24, 60, 8], [312, 64, 9], [20, 230, 6], [316, 228, 6]]) sparkle(c, x, y, r);
}

// A golden pie as big as the sun, with a slice being served from it.
function goldPie(c) {
  const cx = HX; const cy = 118; const R = 86;
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2; const len = Math.min(i % 2 ? 132 : 162, reach(cx, cy, a));
    c.fill(rotate([[cx - 9, cy], [cx, cy - len], [cx + 9, cy]], cx, cy, a), radial('#fff3bf', '#ffd43b', cx, cy, len, 0.8, 0));
  }
  const disc = (L, x, y) => {
    const rim = [];
    for (let i = 0; i < 200; i++) { const t = (i / 200) * Math.PI * 2; const r = R + 4 * Math.abs(Math.sin(t * 18)); rim.push([x + Math.cos(t) * r, y + Math.sin(t) * r]); }
    L.fill(rim, radial('#fff3bf', '#c98a14', x - 20, y - 20, R + 10));
    L.fill(circle(x, y, R - 13), radial('#fffbe6', '#f59f00', x - 24, y - 28, R));
    for (const a of [Math.PI / 4, -Math.PI / 4]) for (let i = -3; i <= 3; i++) L.fill(rotate(rect(x + i * 26 - 6, y - R, 12, R * 2), x, y, a), vgrad('#fff9db', '#f6c445', y - R, y + R), 'atop');
  };
  const a0 = -1.25; const a1 = -0.45;
  const wedge = (x, y) => [[x, y], ...Array.from({ length: 13 }, (_, i) => { const t = a0 + ((a1 - a0) * i) / 12; return [x + Math.cos(t) * (R + 9), y + Math.sin(t) * (R + 9)]; })];
  const P = new Canvas();
  disc(P, cx, cy);
  P.fill(wedge(cx, cy), solid(WHITE), 'erase');
  c.draw(P);
  const sx = cx + Math.cos((a0 + a1) / 2) * 22; const sy = cy + Math.sin((a0 + a1) / 2) * 18 - 2;
  const S = new Canvas();
  disc(S, sx, sy);
  S.fill([[rect(0, 0, W, H), wedge(sx, sy)]], solid(WHITE), 'erase');
  c.draw(S);
  shine(c, cx - 40, cy - 40, 18, 7, -0.7, 0.4);
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) / 8) * Math.PI * 2; const r = 120;
    const x = cx + Math.cos(a) * r * 1.12; const y = cy + 30 + Math.sin(a) * r;
    if (y > 250) continue;
    c.fill(star(x, y, 11, 5), radial('#ffffff', GOLD[1], x - 2, y - 3, 13));
  }
  for (const [x, y, r] of [[30, 40, 10], [306, 34, 11], [22, 200, 8], [316, 196, 8]]) sparkle(c, x, y, r);
}

add('boss-pie-cookie', '饼干发夹', 0, cookieClip, { slot: 'head', boss: 'pie' });
add('boss-pie-pet', '小派', 1, piePet, { slot: 'pet', boss: 'pie' });
add('boss-pie-chef', '厨师帽', 2, chefHat, { slot: 'head', boss: 'pie', glow: '#fff3bf' });
add('boss-pie-halo', '大饼光环', 3, pieHalo, { slot: 'fx', boss: 'pie', layer: 'back', glow: '#ffd8a8' });
add('boss-pie-gold', '黄金大饼', 4, goldPie, { slot: 'fx', boss: 'pie', layer: 'back', glow: '#ffe066' });

// 加班僵尸: zombie green, night blue and coffee brown.
const ZOMBIE = '#a9d18e';
function bandAid(c, x, y, a, len = 46, w = 14) {
  const f = frame(x, y, a);
  c.fill(f.rect(-len / 2, -w / 2, len, w, w / 2), vgrad('#f8d7a8', '#e0aa70', y - w, y + w));
  c.fill(f.rect(-8, -w / 2 + 2.5, 16, w - 5, 2), solid('#fff0db'));
  for (const sx of [-1, 1]) for (const [dx, dy] of [[14, -2.5], [18, 1], [14, 2.5]]) c.fill(f.circ(sx * dx, dy, 0.9), solid('#c98a4a'));
}
function bandages(c) {
  bandAid(c, HX + 46, HY + 16, 0.6);
  bandAid(c, HX + 46, HY + 16, -0.6);
}

function zombieCup(c) {
  const X = PX + 5; // a little right of the animals, to leave room for the handle
  bossPet(c, (L) => {
    const body = [[X - 27, PY - 14], [X + 27, PY - 14], [X + 22, PY + 32], [X - 22, PY + 32]];
    for (const [dx, ph] of [[-8, 0], [8, 1]]) L.fill(stroke(Array.from({ length: 12 }, (_, i) => [X + dx + Math.sin(i * 0.7 + ph * 2) * 3.5, PY - 18 - i * 2.4]), 2.6), solid(WHITE, 0.75));
    L.fill(ring(X - 29, PY + 6, 10, 11.5, 4.6), solid(darken(col(ZOMBIE), 0.1)));
    for (const dy of [0, 9]) L.fill(stroke([[X + 20, PY + 4 + dy], [X + 40, PY + 1 + dy]], 6.5), solid(ZOMBIE));
    for (const dy of [0, 9]) L.fill(circle(X + 41, PY + 1 + dy, 4), solid(lighten(col(ZOMBIE), 0.1)));
    const M = new Canvas();
    M.fill(body, vgrad('#c3e3ae', '#7fae68', PY - 14, PY + 32));
    M.fill(stroke([[X - 26, PY + 26], [X + 26, PY + 26]], 5), solid('#6f9a58'), 'atop');
    L.draw(M);
    L.fill(ellipse(X, PY - 14, 27, 7), solid('#7fae68'));
    L.fill(ellipse(X, PY - 13, 23, 5), radial('#c08552', '#5c3a21', X - 5, PY - 15, 24));
    for (const sx of [-1, 1]) {
      L.fill(ellipse(X + 10 * sx, PY + 4, 6, 3), solid('#5f4b8b', 0.45));
      L.fill(ellipse(X + 10 * sx, PY + 1, 3.6, 3.2), solid(INK));
      L.fill(rect(X + 10 * sx - 4.5, PY - 3.6, 9, 3.4), solid('#9fc787'));
      L.fill(stroke([[X + 10 * sx - 4.5, PY - 0.5], [X + 10 * sx + 4.5, PY - 0.5]], 1.4), solid(INK));
    }
    L.fill(stroke(bezier([X - 7, PY + 14], [X - 3, PY + 11], [X + 3, PY + 16], [X + 7, PY + 12], 10), 1.6), solid(INK));
    L.fill([[X - 1, PY + 13.4], [X + 3, PY + 14.6], [X + 1, PY + 18]], solid(WHITE));
    L.fill(stroke([[X - 22, PY - 6], [X - 14, PY + 2]], 1.4), solid('#5c7a4a'));
    for (const t of [0.25, 0.55, 0.85]) { const x = X - 22 + 8 * t; const y = PY - 6 + 8 * t; L.fill(stroke([[x - 2.2, y + 2.2], [x + 2.2, y - 2.2]], 1.2), solid('#5c7a4a')); }
    bandAid(L, X + 15, PY - 6, -0.5, 18, 7);
  });
}

// A sleepy "Z" as a polyline, sz from the middle to each corner.
const zGlyph = (x, y, sz) => [[x - sz, y - sz], [x + sz, y - sz], [x - sz, y + sz], [x + sz, y + sz]];
// Dark circles hugging the lower lashes (soft, without the sticker outline), a sweat drop and "zZ".
function eyeBags(c) {
  for (const s of [-1, 1]) {
    const x = EX + 22.5 * s;
    c.fill(ellipse(x, EY + 12, 11, 4.6), radial('#5f3dc4', '#5f3dc4', x, EY + 12, 11, 0.5, 0));
    const L = new Canvas();
    L.fill(ellipse(x, EY + 10, 9.5, 4.4), solid('#4c2fa8', 0.7));
    L.fill(ellipse(x, EY + 7.6, 10.5, 4.4), solid(WHITE), 'erase');
    c.draw(L);
    c.fill(stroke(bezier([x - 6, EY + 16], [x - 2, EY + 17.6], [x + 2, EY + 17.6], [x + 6, EY + 16], 8), 1.1), solid('#5f3dc4', 0.4));
  }
  const drop = dropShape(frame(EX + 62, EY - 26, 0.2), 5);
  c.fill(stroke([...drop, drop[0]], 2.4), solid('#1864ab'));
  c.fill(drop, vgrad('#e7f5ff', '#74c0fc', EY - 36, EY - 20));
  for (const [x, y, sz] of [[EX + 70, EY - 64, 7], [EX + 84, EY - 80, 9.5]]) {
    c.fill(stroke(zGlyph(x, y, sz), 5.4), solid('#1b2a6b'));
    c.fill(stroke(zGlyph(x, y, sz), 2.8), solid('#91a7ff'));
  }
}

function nightMoon(c) {
  const mx = 252; const my = 64;
  c.fill(circle(mx, my, 92), radial('#4c6ef5', '#4c6ef5', mx, my, 92, 0.42, 0));
  const L = new Canvas();
  L.fill(circle(mx, my, 44), radial('#fffbe6', '#ffd43b', mx - 12, my - 12, 54));
  L.fill(circle(mx + 22, my - 14, 38), solid(WHITE), 'erase');
  c.draw(L);
  for (const [x, y, r] of [[222, 50, 4], [228, 82, 5], [238, 100, 3]]) c.fill(circle(x, y, r), solid('#f6c445', 0.5));
  for (const [x, y, sz] of [[70, 120, 9], [48, 82, 12], [74, 42, 15]]) c.fill(stroke(zGlyph(x, y, sz), sz * 0.5), solid('#dbe4ff'));
  const rand = rng(21);
  for (let i = 0; i < 26; i++) c.fill(circle(10 + rand() * 316, 10 + rand() * 230, 0.8 + rand() * 1.5), solid(rand() < 0.3 ? '#fff3bf' : WHITE, 0.95));
  for (const [x, y, r] of [[312, 140, 8], [20, 200, 7], [140, 20, 7], [304, 236, 6], [190, 12, 5]]) c.fill(star(x, y, r, r * 0.45), solid('#fff3bf'));
}

// The sleepless soul: a ghostly green flame rising behind, its heavy-lidded face over the head.
function sleeplessSoul(c) {
  const tongues = [[HX, 330, 250, 318, 0], [HX - 98, 330, 100, 214, -0.14], [HX + 100, 330, 100, 224, 0.14], [HX - 62, 330, 110, 262, -0.08], [HX + 66, 330, 110, 270, 0.08]];
  const paint = (a) => (px, py) => {
    const d = Math.min(1, Math.hypot(px - HX, (py - 250) * 0.7) / 190);
    return [...(d < 0.5 ? mix(hex('#e6fcf5'), hex('#63e6be'), d / 0.5) : mix(hex('#63e6be'), hex('#087f5b'), (d - 0.5) / 0.5)), a * (1 - Math.max(0, d - 0.75) * 1.6)];
  };
  for (const [scale, a] of [[1, 0.62], [0.78, 0.72], [0.52, 0.8]]) for (const [x, by, w, h, lean] of tongues) c.fill(flameShape(x, by, w * scale, h * scale, lean), paint(a));
  for (const [x, y, w, h, lean] of [[34, 120, 18, 34, -0.2], [300, 104, 20, 38, 0.2], [70, 40, 14, 26, -0.1], [270, 30, 16, 30, 0.15]]) c.fill(flameShape(x, y, w, h, lean), paint(0.85));
  for (const sx of [-1, 1]) {
    const x = HX + 24 * sx;
    c.fill(ellipse(x, 44, 11, 9), solid('#0b4d3c', 0.9));
    c.fill(rect(x - 12, 33, 24, 9.5), solid('#c3fae8'));
    c.fill(stroke([[x - 11, 42.5], [x + 11, 42.5]], 2.2), solid('#0b4d3c'));
    c.fill(stroke(bezier([x - 9, 55], [x - 4, 59], [x + 4, 59], [x + 9, 55], 8), 2), solid('#0b4d3c', 0.5));
  }
  c.fill(ellipse(HX, 66, 5, 6.5), solid('#0b4d3c', 0.85));
  const rand = rng(44);
  for (let i = 0; i < 24; i++) { const x = 16 + rand() * 304; const y = 16 + rand() * 270; c.fill(circle(x, y, 1.2 + rand() * 2.2), solid(rand() < 0.5 ? '#b2f2bb' : '#ffffff', 0.95)); }
  for (const [x, y, sz] of [[300, 186, 7], [316, 160, 9]]) c.fill(stroke(zGlyph(x, y, sz), sz * 0.45), solid('#e6fcf5'));
}

add('boss-overtime-bandage', '创可贴', 0, bandages, { slot: 'head', boss: 'overtime' });
add('boss-overtime-pet', '僵尸咖啡杯', 1, zombieCup, { slot: 'pet', boss: 'overtime' });
add('boss-overtime-eyes', '黑眼圈', 2, eyeBags, { slot: 'head', boss: 'overtime', outline: 0 });
add('boss-overtime-moon', '深夜月光', 3, nightMoon, { slot: 'fx', boss: 'overtime', layer: 'back', glow: '#91a7ff' });
add('boss-overtime-soul', '不眠之魂', 4, sleeplessSoul, { slot: 'fx', boss: 'overtime', layer: 'back', glow: '#69db7c', outline: 0 });

// 祖传代码恐龙: dino green and orange, and code braces.
const DINO = '#51cf66';
// A curly brace, "{" for dir 1 and "}" for -1, h tall around (0, 0) of frame f.
const brace = (f, h, dir) => f.pts([...bezier([6 * dir, -h / 2], [0, -h / 2], [0, -h / 2 + 3], [0, -h / 4], 8), ...bezier([0, -h / 4], [0, -3], [-dir, -1.5], [-6 * dir, 0], 8).slice(1),
  ...bezier([-6 * dir, 0], [-dir, 1.5], [0, 3], [0, h / 4], 8).slice(1), ...bezier([0, h / 4], [0, h / 2 - 3], [0, h / 2], [6 * dir, h / 2], 8).slice(1)]);
function braceClip(c) {
  const f = frame(HX + 48, HY + 8, 0.25);
  for (const [dx, dir, cc] of [[-13, 1, '#ff922b'], [13, -1, '#40c057']]) {
    const g = frame(...f(dx, 0), 0.25);
    c.fill(stroke(brace(g, 42, dir), 5.6), solid(cc));
    c.fill(stroke(brace(g, 42, dir).slice(3, 12), 1.6), solid(WHITE, 0.55));
  }
  c.fill(f.circ(0, 12, 3.2), solid('#2b8a3e'));
}

function dinoPet(c) {
  bossPet(c, (L) => {
    const k = col(DINO);
    const paint = shade(DINO, PY - 32, PY + 36);
    L.fill(taper(bezier([PX + 12, PY + 24], [PX + 30, PY + 32], [PX + 44, PY + 24], [PX + 48, PY + 8], 14), 17, 3), paint);
    for (const [x, y, a, sz] of [[PX - 15, PY - 25, -0.7, 7], [PX - 3, PY - 30, -0.15, 8.5], [PX + 11, PY - 28, 0.4, 8], [PX + 22, PY - 20, 0.95, 7], [PX + 28, PY - 6, 1.4, 6], [PX + 38, PY + 18, 1.2, 5]]) {
      L.fill(rotate([[x - sz * 0.8, y + 5], [x, y - sz * 1.2], [x + sz * 0.8, y + 5]], x, y, a), vgrad('#ffd8a8', '#f76707', y - sz, y + 5));
    }
    for (const sx of [-1, 1]) L.fill(ellipse(PX + 11 * sx, PY + 35, 8, 4.5), solid(darken(k, 0.2)));
    L.fill(ellipse(PX, PY + 17, 23, 18), paint);
    L.fill(ellipse(PX, PY + 21, 13, 12), solid('#fff3bf'));
    for (const dy of [15, 21, 27]) L.fill(stroke([[PX - 9, PY + dy], [PX + 9, PY + dy]], 1.2), solid('#ffd8a8'));
    L.fill(ellipse(PX + 2, PY - 8, 27, 22), paint);
    for (const [x, y, r] of [[-14, -20, 2.4], [-8, -24, 1.8], [16, -18, 2.2]]) L.fill(circle(PX + x, PY + y, r), solid('#ff922b', 0.8));
    for (const sx of [-1, 1]) L.fill(ellipse(PX + 16 * sx, PY + 8, 4.5, 3, 0.6 * sx), solid(darken(k, 0.08)));
    for (const sx of [-1, 1]) {
      L.fill(ellipse(PX + 2 + 9 * sx, PY - 11, 3.3, 4.3), solid(INK));
      L.fill(circle(PX + 3 + 9 * sx, PY - 12.6, 1.2), solid(WHITE));
      L.fill(ellipse(PX + 2 + 17 * sx, PY - 3, 4, 2.4), solid('#ff8fa3', 0.6));
      L.fill(circle(PX + 2 + 3 * sx, PY - 4, 0.9), solid(darken(k, 0.4)));
    }
    L.fill(stroke(bezier([PX - 6, PY], [PX - 2, PY + 4], [PX + 6, PY + 4], [PX + 10, PY], 10), 1.5), solid(INK));
    L.fill([[PX + 5, PY + 2.6], [PX + 8, PY + 2], [PX + 6.8, PY + 5.4]], solid(WHITE));
  });
}

function dinoSpikes(c) {
  const cx = HX; const cy = HY + 54; const rx = 64; const ry = 58;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = Math.PI + 0.5 + (i * (Math.PI - 1)) / (n - 1);
    const x = cx + Math.cos(t) * rx; const y = cy + Math.sin(t) * ry;
    const sz = 13 + (3 - Math.abs(i - 3)) * 5;
    const f = frame(x, y, t + Math.PI / 2);
    const plate = f.pts([...bezier([-sz * 0.75, 4], [-sz * 0.7, -sz * 0.6], [-sz * 0.2, -sz * 1.1], [0, -sz * 1.45], 10), ...bezier([0, -sz * 1.45], [sz * 0.2, -sz * 1.1], [sz * 0.7, -sz * 0.6], [sz * 0.75, 4], 10).slice(1)]);
    c.fill(plate, radial('#ffe8cc', '#e8590c', ...f(-sz * 0.2, -sz * 0.8), sz * 1.6));
    c.fill(f.line([[0, -sz * 1.1], [0, 0]], 1.6), solid('#d9480f', 0.5));
  }
  const band = ellipse(cx, cy, rx, ry);
  c.fill(stroke(band.slice(55, 90), 9), vgrad('#69db7c', '#2b8a3e', HY - 10, HY + 40));
  for (const k of [60, 72, 84]) c.fill(circle(...band[k], 2), solid('#d3f9d8'));
}

function codeRain(c) {
  const rand = rng(99);
  for (let i = 0; i < 19; i++) {
    const x = 14 + i * 17 + (rand() - 0.5) * 4;
    let y = 8 + rand() * 84;
    const end = 150 + rand() * 170;
    while (y < end) {
      const len = 4 + rand() * 12; const t = Math.min(1, y / end);
      c.fill(roundRect(x - 1.8, y, 3.6, len, 1.8), solid(mix(hex('#2b8a3e'), hex('#b2f2bb'), t), 0.35 + 0.6 * t));
      y += len + 4;
    }
    c.fill(roundRect(x - 2.6, y, 5.2, 9, 2.6), solid('#ebfbee'));
  }
  for (const [x, y, dir] of [[24, 64, 1], [310, 52, 1], [300, 140, -1], [40, 150, -1], [HX + 70, 26, 1], [HX - 72, 30, -1]]) {
    const f = frame(x, y);
    c.fill(stroke(brace(f, 26, dir), 4.4), solid('#ff922b'));
  }
}

function fossilWings(c) {
  for (const s of [-1, 1]) {
    const sh = [HX + 30 * s, 190]; const wr = [HX + 104 * s, 84];
    const tips = [[HX + 150 * s, 34], [HX + 154 * s, 116], [HX + 140 * s, 186], [HX + 106 * s, 236]];
    const L = new Canvas();
    const edge = [sh, ...bezier(sh, [HX + 56 * s, 140], [HX + 78 * s, 96], wr, 12).slice(1), ...bezier(wr, [HX + 118 * s, 58], [HX + 136 * s, 40], tips[0], 8).slice(1)];
    for (let i = 0; i < tips.length; i++) {
      const a = tips[i]; const b = tips[i + 1] || [HX + 40 * s, 234];
      edge.push(...bezier(a, [a[0] + (wr[0] - a[0]) * 0.35, a[1] + (wr[1] - a[1]) * 0.35 + 10], [b[0] + (wr[0] - b[0]) * 0.35, b[1] + (wr[1] - b[1]) * 0.35 - 6], b, 12).slice(1));
    }
    L.fill(edge, radial('#ffe8cc', '#d9480f', wr[0], wr[1], 160, 0.75, 0.4));
    for (const [dx, dy, rx, ry] of [[128, 70, 7, 4.5], [132, 150, 8, 5.5], [110, 198, 6, 4], [142, 104, 4, 3], [118, 128, 4, 2.6], [92, 168, 5, 3]]) L.fill(ellipse(HX + dx * s, dy, rx, ry, 0.5 * s), solid(WHITE), 'erase');
    c.draw(L);
    const bone = vgrad('#fffdf0', '#d8c9a3', 20, 240);
    c.fill(taper([sh, wr], 11, 8), bone);
    for (const t of tips) c.fill(taper([wr, [wr[0] + (t[0] - wr[0]) * 0.5, wr[1] + (t[1] - wr[1]) * 0.5 - 4], t], 7, 2.5), bone);
    for (const t of tips) c.fill(circle(wr[0] + (t[0] - wr[0]) * 0.5, wr[1] + (t[1] - wr[1]) * 0.5 - 4, 4), bone);
    c.fill(circle(wr[0], wr[1], 8), bone);
    c.fill(circle(sh[0] + (wr[0] - sh[0]) * 0.5, sh[1] + (wr[1] - sh[1]) * 0.5, 6), bone);
    c.fill([[wr[0] - 4 * s, wr[1] - 4], [wr[0] - 2 * s, wr[1] - 20], [wr[0] + 6 * s, wr[1] - 4]], solid('#fffdf0'));
  }
  const rand = rng(65);
  for (let i = 0; i < 22; i++) c.fill(circle(10 + rand() * 316, 10 + rand() * 280, 1 + rand() * 2.2), solid(rand() < 0.5 ? '#ffa94d' : '#ffe066', 0.9));
  for (const [x, y, r] of [[HX - 60, 24, 7], [HX + 64, 20, 8], [20, 250, 6], [316, 256, 6]]) sparkle(c, x, y, r, '#ffe8cc');
}

add('boss-legacy-brace', '括号发卡', 0, braceClip, { slot: 'head', boss: 'legacy' });
add('boss-legacy-pet', '小恐龙', 1, dinoPet, { slot: 'pet', boss: 'legacy' });
add('boss-legacy-spikes', '恐龙背刺', 2, dinoSpikes, { slot: 'head', boss: 'legacy', glow: '#ffd8a8' });
add('boss-legacy-code', '代码瀑布', 3, codeRain, { slot: 'fx', boss: 'legacy', layer: 'back', glow: '#8ce99a', outline: 1.2 });
add('boss-legacy-fossil', '远古龙骨翼', 4, fossilWings, { slot: 'fx', boss: 'legacy', layer: 'back', glow: '#ffa94d' });

// 需求变更龙: dragon red and gold, with jade teal.
const DRAGON = '#f03e3e';
const JADE = '#20c997';
// A dragon's antler: a curved tapered stem with two tines; k = 1 leans right, -1 left.
function antler(c, x, y, s, k) {
  const paint = vgrad(GOLD[0], GOLD[2], y - 40 * s, y);
  const stem = bezier([x, y], [x + 2 * k * s, y - 14 * s], [x + 12 * k * s, y - 24 * s], [x + 9 * k * s, y - 40 * s], 12);
  c.fill(taper(stem, 8 * s, 3.5 * s), paint);
  for (const [i, dx, dy] of [[5, 12, -7], [8, -9, -8]]) { const [px, py] = stem[i]; c.fill(taper([[px, py], [px + dx * k * s * 0.6, py + dy * s * 0.5], [px + dx * k * s, py + dy * s]], 5 * s, 2.4 * s), paint); }
}
function dragonHorns(c) {
  for (const s of [-1, 1]) {
    antler(c, HX + 26 * s, HY + 14, 1, s);
    c.fill(ellipse(HX + 26 * s, HY + 14, 8.5, 4.5), vgrad('#ff6b6b', '#a51111', HY + 10, HY + 18));
    c.fill(circle(HX + 26 * s, HY + 13, 2.2), solid(JADE));
  }
}

function stickyNote(c, x, y, a, s, color, mark) {
  const f = frame(x, y, a, s);
  const k = col(color);
  c.fill(f.pts([[-14, -14], [14, -14], [14, 7], [7, 14], [-14, 14]]), vgrad(lighten(k, 0.3), k, y - 14 * s, y + 14 * s));
  c.fill(f.pts([[14, 7], [7, 7], [7, 14]]), solid(darken(k, 0.18)));
  c.fill(f.rect(-14, -14, 28, 5), solid(darken(k, 0.07)));
  for (const [y0, x1] of [[-3, 8], [3, 3], [9, -2]]) c.fill(f.line([[-9, y0], [x1, y0]], 1.7), solid(INK, 0.5));
  if (mark === 'x') { c.fill(f.line([[-6, -6], [8, 8]], 2.6), solid('#e03131')); c.fill(f.line([[8, -6], [-6, 8]], 2.6), solid('#e03131')); }
  if (mark === 'v') c.fill(f.line([[-7, 0], [-2, 6], [9, -7]], 2.6), solid('#2b8a3e'));
}
function dragonPet(c) {
  const back = (L) => {
    for (const [x, y, a, h] of [[PX - 20, PY - 20, -0.8, 17], [PX - 22, PY - 4, -1.4, 13], [PX + 20, PY - 20, 0.8, 17], [PX + 22, PY - 4, 1.4, 13], [PX, PY - 28, 0, 18]]) L.fill(rotate(flameShape(x, y + 6, 14, h), x, y + 6, a), vgrad('#96f2d7', '#0ca678', y - h, y + 6));
    const tail = bezier([PX + 14, PY + 26], [PX + 40, PY + 34], [PX + 46, PY + 8], [PX + 34, PY - 4], 16);
    L.fill(taper(tail, 13, 4), shade(DRAGON, PY - 4, PY + 34));
    L.fill(rotate(flameShape(PX + 34, PY - 2, 12, 18), PX + 34, PY - 2, -0.5), vgrad('#96f2d7', '#0ca678', PY - 20, PY));
  };
  const front = (L) => {
    for (const s of [-1, 1]) antler(L, PX + 11 * s, PY - 24, 0.62, s);
    for (const s of [-1, 1]) L.fill(stroke(bezier([PX + 5 * s, PY + 1], [PX + 18 * s, PY + 2], [PX + 26 * s, PY - 6], [PX + 32 * s, PY + 2], 12), 1.6), solid(JADE));
    stickyNote(L, PX + 30, PY + 14, 0.25, 0.62, '#ffe066', 'x');
    L.fill(circle(PX + 22, PY + 16, 4.5), solid(DRAGON));
  };
  animal(c, { body: DRAGON, belly: '#ffe066', muzzle: '#ff8787', nose: '#a51111', mouth: 'w', blush: '#ffc9c9', back, front });
}

function scaleCrown(c) {
  for (const [dx, h, w] of [[-44, 24, 13], [-22, 34, 15], [0, 48, 20], [22, 34, 15], [44, 24, 13]]) c.fill(flameShape(HX + dx, HY + 6, w, h, dx * 0.004), goldPaint(HY - h, HY + 6));
  const L = new Canvas();
  L.fill(roundRect(HX - 58, HY - 2, 116, 24, 8), solid(WHITE));
  for (let row = 0; row < 3; row++) {
    for (let i = -7; i <= 7; i++) {
      const x = HX + i * 9 + (row % 2 ? 4.5 : 0); const y = HY - 2 + row * 8;
      L.fill(circle(x, y + 7, 6.5), vgrad('#ff8787', '#a51111', y, y + 14), 'atop');
      L.fill(ring(x, y + 7, 6.5, 6.5, 1.3, 0, Math.PI * 0.05, Math.PI * 0.95), solid(GOLD[1]), 'atop');
    }
  }
  c.draw(L);
  for (const y of [HY - 2, HY + 22]) c.fill(stroke([[HX - 56, y], [HX + 56, y]], 3), goldPaint(y - 2, y + 2));
  c.fill(circle(HX, HY - 16, 10), radial('#e6fcf5', JADE, HX - 3, HY - 19, 12));
  c.fill(circle(HX - 3, HY - 19, 2.6), solid(WHITE));
  for (const s of [-1, 1]) gem(c, HX + 34 * s, HY + 10, 5.5, JADE);
}

function noteStorm(c) {
  for (const [r0, r1, a0, a1, cc] of [[150, 118, Math.PI * 0.75, Math.PI * 2.25, '#ffe066'], [128, 100, Math.PI * 0.9, Math.PI * 2.1, '#96f2d7']]) c.fill(taper(spiral(HX, 170, r0, r1, a0, a1, 90, 0.95), 1.5, 6), solid(cc, 0.8));
  const notes = [[40, 70, -0.4, 1.1, '#ffe066', 'x'], [104, 26, 0.3, 0.9, '#ffa8a8', 0], [236, 22, -0.25, 0.95, '#96f2d7', 'v'], [298, 74, 0.35, 1.1, '#ffc078', 0], [304, 160, -0.2, 1, '#ffe066', 'x'], [302, 246, 0.4, 1, '#ffa8a8', 'v'], [28, 156, 0.3, 1, '#96f2d7', 0], [26, 240, -0.35, 1, '#ffc078', 'x'], [62, 306, 0.2, 0.9, '#ffe066', 0], [280, 306, -0.3, 0.85, '#96f2d7', 0]];
  for (const [x, y, a, s, cc, mark] of notes) stickyNote(c, x, y, a, s, cc, mark);
}

// A Chinese dragon coiling round behind the girl, chasing its pearl over her head.
function dragonCoil(c) {
  const path = [...bezier([256, 78], [304, 92], [308, 170], [286, 214], 24), ...bezier([286, 214], [256, 270], [80, 280], [50, 222], 24).slice(1),
    ...bezier([50, 222], [24, 160], [34, 78], [88, 48], 24).slice(1), ...bezier([88, 48], [112, 34], [126, 40], [138, 26], 12).slice(1)];
  const n = path.length - 1;
  for (let i = 4; i < n - 4; i += 4) {
    const [x, y] = path[i]; const [x2, y2] = path[i + 1];
    const len = Math.hypot(x2 - x, y2 - y) || 1; const nx = (y2 - y) / len; const ny = -(x2 - x) / len;
    const w = 15 - (i / n) * 10;
    c.fill([[x + nx * w * 0.6, y + ny * w * 0.6], [x + nx * (w + 10) + (x2 - x) / len * 4, y + ny * (w + 10) + (y2 - y) / len * 4], [x + nx * w * 0.6 + (x2 - x) / len * 8, y + ny * w * 0.6 + (y2 - y) / len * 8]], solid(JADE));
  }
  c.fill(taper(path, 30, 7), (x, y) => [...mix(hex('#ff6b6b'), hex('#c92a2a'), Math.min(1, Math.abs(x - HX) / 170)), 1]);
  const belly = path.map(([x, y], i) => { const [x2, y2] = path[Math.min(n, i + 1)]; const [x0, y0] = path[Math.max(0, i - 1)]; const len = Math.hypot(x2 - x0, y2 - y0) || 1; const k = (15 - (i / n) * 10) * 0.45; return [x - (y2 - y0) / len * k, y + (x2 - x0) / len * k]; });
  c.fill(taper(belly, 9, 2), solid('#ffe066'));
  for (let i = 5; i < n - 6; i += 3) {
    const [x, y] = path[i]; const [x2, y2] = path[i + 1]; const r = 7 - (i / n) * 4;
    c.fill(ring(x, y, r, r, 1.4, Math.atan2(y2 - y, x2 - x), Math.PI * 0.6, Math.PI * 1.4), solid('#a51111', 0.55));
  }
  for (const i of [20, 48, 70]) { const [x, y] = path[i]; for (const d of [-0.5, 0, 0.5]) c.fill(stroke([[x, y], [x + Math.cos(Math.PI / 2 + d) * 10, y + Math.sin(Math.PI / 2 + d) * 10]], 2.6), solid(GOLD[1])); }
  // the head, facing left towards the pearl
  const f = frame(256, 66, 0, 1.3);
  for (const [x, y, a, h] of [[16, -8, 0.9, 26], [20, 8, 1.5, 22], [10, -18, 0.4, 22]]) c.fill(rotate(flameShape(...f(x, y), 16 * f.s, h * f.s), ...f(x, y), a), vgrad('#96f2d7', '#0ca678', f(0, y - h)[1], f(0, y)[1]));
  antler(c, ...f(6, -14), 0.95, 1);
  antler(c, ...f(-6, -14), 0.85, -1);
  c.fill(f.ell(4, 0, 21, 17), glossy(DRAGON, ...f(0, -4), 24 * f.s));
  c.fill(f.rect(-34, -6, 34, 18, 8), glossy('#ff6b6b', ...f(-20, 0), 22 * f.s));
  c.fill(f.rect(-31, 8, 27, 7, 3.5), solid('#ffe066'));
  for (const x of [-26, -18, -10]) c.fill(f.pts([[x, 8], [x + 3, 8], [x + 1.5, 11.5]]), solid(WHITE));
  c.fill(f.circ(-29, -1, 2), solid('#a51111'));
  c.fill(f.ell(-3, -6, 6, 5), solid(WHITE));
  c.fill(f.circ(-4.5, -6, 3), solid(INK));
  c.fill(f.circ(-5.5, -7.2, 1), solid(WHITE));
  c.fill(f.line([[-11, -13], [4, -12]], 2.4), solid('#a51111'));
  for (const [dy, ey, cy2] of [[0, -40, -30], [4, 24, 30]]) c.fill(f.line(bezier([-32, dy], [-48, dy + cy2 * 0.3], [-40, ey], [-58, ey], 14), 1.8), solid(JADE));
  c.fill(circle(HX - 10, 30, 14), radial('#ffffff', JADE, HX - 14, 26, 17));
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; c.fill(flameShape(HX - 10 + Math.cos(a) * 17, 30 + Math.sin(a) * 17 + 4, 7, 10), solid('#ffe066', 0.85)); }
  const cloud = (x, y, s) => {
    c.fill([[circle(x - 10 * s, y, 8 * s)], [circle(x + 2 * s, y - 5 * s, 10 * s)], [circle(x + 14 * s, y, 7 * s)], [roundRect(x - 18 * s, y, 40 * s, 8 * s, 4 * s)]], vgrad('#ffffff', '#c3fae8', y - 15 * s, y + 8 * s));
    c.fill(ring(x + 2 * s, y - 4 * s, 5 * s, 5 * s, 1.6 * s, 0, Math.PI, Math.PI * 2.5), solid(JADE, 0.8));
  };
  cloud(36, 290, 1.1); cloud(308, 290, 1); cloud(220, 18, 0.8);
}

add('boss-change-horns', '小龙角', 0, dragonHorns, { slot: 'head', boss: 'change' });
add('boss-change-pet', '需求小龙', 1, dragonPet, { slot: 'pet', boss: 'change' });
add('boss-change-scales', '龙鳞头冠', 2, scaleCrown, { slot: 'head', boss: 'change', glow: '#ffe8a3' });
add('boss-change-notes', '便利贴风暴', 3, noteStorm, { slot: 'fx', boss: 'change', glow: '#fff3bf' });
add('boss-change-dragon', '祥龙环绕', 4, dragonCoil, { slot: 'fx', boss: 'change', layer: 'back', glow: '#ffd43b' });

// 线上事故: fire orange and red, alert yellow.
const ALERT = '#ffd43b';
function sirenClip(c) {
  const x = HX + 6; const y = HY + 8;
  for (const s of [-1, 1]) for (const a of [-0.45, 0, 0.45]) {
    const ang = (s < 0 ? Math.PI : 0) - a * s;
    c.fill(stroke([[x + Math.cos(ang) * 24, y - 16 + Math.sin(ang) * 24], [x + Math.cos(ang) * 36, y - 16 + Math.sin(ang) * 36]], 3.2), solid(ALERT));
  }
  c.fill(Array.from({ length: 25 }, (_, i) => { const t = Math.PI + (i / 24) * Math.PI; return [x + Math.cos(t) * 15, y - 2 + Math.sin(t) * 24]; }), glossy('#ff6b6b', x, y - 14, 22));
  c.fill(ellipse(x, y - 12, 5.5, 9), solid('#fff3bf', 0.85));
  for (const dx of [-8, 8]) c.fill(stroke([[x + dx, y - 4], [x + dx * 0.8, y - 18]], 1.4), solid('#c92a2a', 0.5));
  c.fill(roundRect(x - 21, y - 4, 42, 12, 4), vgrad('#868e96', '#343a40', y - 4, y + 8));
  shine(c, x - 6, y - 16, 2.5, 6, 0.2, 0.7);
}

function flamePet(c) {
  bossPet(c, (L) => {
    for (const s of [-1, 1]) L.fill(rotate(flameShape(PX + 22 * s, PY + 18, 14, 19, 0), PX + 22 * s, PY + 18, 0.6 * s), radial('#ffd43b', '#f03e3e', PX + 22 * s, PY + 10, 22));
    L.fill(flameShape(PX, PY + 38, 62, 88, 0.08), radial('#ffe066', '#e03131', PX, PY + 20, 64));
    L.fill(flameShape(PX + 2, PY + 36, 42, 58, 0.06), radial('#ffffff', '#ffd43b', PX, PY + 22, 36));
    face(L, PX + 1, PY + 16, 1.1, '#ff6b6b');
    for (const [x, y, r] of [[PX - 26, PY - 30, 2.4], [PX + 30, PY - 36, 2], [PX + 20, PY - 50, 1.6]]) L.fill(circle(x, y, r), solid('#ff922b'));
  });
}

function fireHelmet(c) {
  // the brim droops at the sides, the dome sits in it with its ridge and the front badge
  const brim = [...bezier([HX - 76, HY + 44], [HX - 66, HY + 14], [HX + 66, HY + 14], [HX + 76, HY + 44], 24), ...bezier([HX + 76, HY + 44], [HX + 60, HY + 30], [HX - 60, HY + 30], [HX - 76, HY + 44], 24).slice(1, -1)];
  c.fill(brim, vgrad('#ff6b6b', '#a51111', HY + 14, HY + 44));
  const L = new Canvas();
  const dome = Array.from({ length: 49 }, (_, i) => { const t = Math.PI + (i / 48) * Math.PI; return [HX + Math.cos(t) * 54, HY + 30 + Math.sin(t) * 56]; });
  L.fill(dome, glossy('#fa5252', HX - 16, HY - 4, 64));
  L.fill(rect(HX - 60, HY + 12, 120, 8), solid(ALERT), 'atop');
  L.fill(rect(HX - 60, HY + 14, 120, 2), solid(WHITE, 0.7), 'atop');
  c.draw(L);
  c.fill(roundRect(HX - 8, HY - 28, 16, 50, 8), vgrad('#ff8787', '#c92a2a', HY - 28, HY + 22));
  c.fill(roundRect(HX - 4, HY - 24, 4, 40, 2), solid(WHITE, 0.4));
  const shield = [...bezier([HX - 17, HY - 12], [HX - 6, HY - 16], [HX + 6, HY - 16], [HX + 17, HY - 12], 8), ...bezier([HX + 17, HY - 12], [HX + 18, HY + 6], [HX + 10, HY + 14], [HX, HY + 20], 10).slice(1), ...bezier([HX, HY + 20], [HX - 10, HY + 14], [HX - 18, HY + 6], [HX - 17, HY - 12], 10).slice(1, -1)];
  c.fill(shield, goldPaint(HY - 16, HY + 20));
  c.fill(flameShape(HX, HY + 13, 14, 22), radial('#fff3bf', '#e03131', HX, HY + 6, 14));
  shine(c, HX - 34, HY, 9, 4, -0.7, 0.5);
}

function alertRing(c) {
  const cx = HX; const cy = 164; const R = 140; const w = 20;
  c.fill(ring(cx, cy, R, R, w), (x, y) => {
    const a = Math.atan2(y - cy, x - cx); const r = Math.hypot(x - cx, y - cy);
    const k = Math.floor((a * R + r) / 13);
    return [...hex(((k % 2) + 2) % 2 ? '#212529' : ALERT), 1];
  });
  for (const r of [R, R - w]) c.fill(ring(cx, cy, r + 1, r + 1, 2.4), solid('#212529'));
  for (const a of [-Math.PI * 0.82, -Math.PI / 2, -Math.PI * 0.18]) {
    const x = cx + Math.cos(a) * (R - w / 2); const y = cy + Math.sin(a) * (R - w / 2);
    const tri = [[x, y - 22], [x + 22, y + 16], [x - 22, y + 16]];
    c.fill(stroke([...tri, tri[0]], 7), solid('#c92a2a'));
    c.fill(tri, vgrad('#fff3bf', ALERT, y - 22, y + 16));
    c.fill(stroke([[x, y - 9], [x, y + 3]], 4), solid('#212529'));
    c.fill(circle(x, y + 9.5, 2.4), solid('#212529'));
  }
}

// Wings of fire: feathered like the angel wings, each feather licking up into a flame.
function phoenixWings(c) {
  const fire = (ox, oy, r) => (x, y) => {
    const d = Math.min(1, Math.hypot(x - ox, y - oy) / r);
    return [...(d < 0.45 ? mix(hex('#fff9db'), hex('#ffa94d'), d / 0.45) : mix(hex('#ffa94d'), hex('#e03131'), (d - 0.45) / 0.55)), 1];
  };
  // a flame pointing from (x, y) along angle a (0 = right, -pi/2 = up)
  const plume = (x, y, a, w, len, lean, paint) => c.fill(rotate(flameShape(x, y, w, len, lean), x, y, a + Math.PI / 2), paint);
  for (const s of [-1, 1]) {
    const ox = HX + 30 * s; const oy = 196;
    // e = elevation above the horizontal, pointing away from the body
    const out = (e) => Math.atan2(-Math.sin(e), Math.cos(e) * s);
    for (const [a, len] of [[0.42, 84], [0.8, 72]]) plume(ox + 8 * s, 236, Math.PI / 2 - s * a, 24, len, -0.14 * s, fire(ox, 236, len));
    for (let i = 0; i < 8; i++) {
      const e = 1.3 - i * 0.21; const l = 146 * (1 - i * 0.07);
      plume(ox + Math.cos(e) * s * l * 0.98, oy - Math.sin(e) * l * 0.98, out(e + 0.25), 20, 40, 0.3 * s, radial('#ffe066', '#f03e3e', ox + Math.cos(e) * s * l, oy - Math.sin(e) * l, 40));
    }
    wing(c, s, ox, oy, 1.3, 0.21, 8, 146, 15, (x, y, l) => fire(x, y, l * 1.1), '#c92a2a');
    wing(c, s, ox, oy, 1.15, 0.26, 5, 70, 13, (x, y, l) => radial('#fffbe6', '#ffa94d', x, y, l), '#e8590c');
  }
  for (const [dx, h, lean] of [[-16, 30, -0.2], [0, 42, 0], [16, 30, 0.2]]) c.fill(flameShape(HX + dx, 70, 18, h, lean), fire(HX, 70, 46));
  const rand = rng(8);
  for (let i = 0; i < 26; i++) c.fill(circle(10 + rand() * 316, 10 + rand() * 300, 1 + rand() * 2.2), solid(rand() < 0.5 ? '#ffd43b' : '#ff922b', 0.95));
}

add('boss-incident-siren', '警报灯', 0, sirenClip, { slot: 'head', boss: 'incident' });
add('boss-incident-pet', '小火苗', 1, flamePet, { slot: 'pet', boss: 'incident' });
add('boss-incident-helmet', '消防头盔', 2, fireHelmet, { slot: 'head', boss: 'incident', glow: '#ffc078' });
add('boss-incident-alert', '红色警报', 3, alertRing, { slot: 'fx', boss: 'incident', layer: 'back', glow: '#ff6b6b' });
add('boss-incident-phoenix', '凤凰涅槃', 4, phoenixWings, { slot: 'fx', boss: 'incident', layer: 'back', glow: '#ff922b', outline: 1.4 });

// 老板的凝视: navy suit, red tie and gold.
const NAVY = '#243b6b';
function necktie(c, f, len = 38) {
  const L = new Canvas();
  L.fill(f.pts([[-5, 6], [5, 6], [8, len - 8], [0, len], [-8, len - 8]]), vgrad('#ff6b6b', '#c92a2a', ...[f(0, 0)[1], f(0, len)[1]].sort((a, b) => a - b)));
  for (let k = 0; k < 5; k++) L.fill(f.line([[-10, 8 + k * 7], [10, 2 + k * 7]], 2.2), solid(NAVY, 0.85), 'atop');
  c.draw(L);
  c.fill(f.pts([[-7, -3], [7, -3], [4.5, 7], [-4.5, 7]]), solid('#a51111'));
}
function tieClip(c) {
  const f = frame(HX + 48, HY - 2, 0.45);
  necktie(c, f, 38);
  c.fill(f.rect(-12, 15, 24, 4.5, 2), goldPaint(HY, HY + 30));
}

// An almond eye looking along `look` (unit-ish vector), lid half down for a stern look.
function stareEye(c, x, y, w, h, look, lid = 0.25) {
  const shape = [...bezier([x - w, y], [x - w * 0.4, y - h * 1.35], [x + w * 0.4, y - h * 1.35], [x + w, y], 16), ...bezier([x + w, y], [x + w * 0.4, y + h * 1.25], [x - w * 0.4, y + h * 1.25], [x - w, y], 16).slice(1, -1)];
  const L = new Canvas();
  L.fill(shape, vgrad('#ffffff', '#dbe4ff', y - h, y + h));
  const ix = x + look[0] * w * 0.32; const iy = y + look[1] * h * 0.3;
  L.fill(circle(ix, iy, h * 0.82), radial('#5c7cfa', NAVY, ix - h * 0.2, iy - h * 0.2, h), 'atop');
  L.fill(ring(ix, iy, h * 0.82, h * 0.82, h * 0.12), solid(GOLD[1]), 'atop');
  L.fill(circle(ix, iy, h * 0.36), solid('#0b1440'), 'atop');
  L.fill(circle(ix - h * 0.25, iy - h * 0.28, h * 0.16), solid(WHITE), 'atop');
  if (lid) L.fill(rect(x - w, y - h * 1.4, w * 2, h * (0.4 + lid * 1.6)), vgrad('#3b5bdb', NAVY, y - h * 1.4, y), 'atop');
  c.draw(L);
  c.fill(stroke(bezier([x - w - 1, y], [x - w * 0.4, y - h * 1.35 + h * lid * 1.1], [x + w * 0.4, y - h * 1.35 + h * lid * 1.1], [x + w + 1, y], 16), h * 0.22), solid('#0b1440'));
}
// A floating eyeball in a little suit and tie, keeping an eye on you.
function eyePet(c) {
  bossPet(c, (L) => {
    L.fill(ellipse(PX, PY + 40, 18, 4), solid(NAVY, 0.25));
    L.fill(ellipse(PX, PY + 24, 19, 12), vgrad('#3b5bdb', NAVY, PY + 12, PY + 36));
    L.fill([[PX - 8, PY + 12], [PX + 8, PY + 12], [PX, PY + 30]], solid(WHITE));
    necktie(L, frame(PX, PY + 13), 20);
    for (const sx of [-1, 1]) { L.fill(ellipse(PX + 19 * sx, PY + 24, 5, 8, 0.5 * sx), solid(NAVY)); L.fill(circle(PX + 22 * sx, PY + 31, 3.6), solid(WHITE)); }
    const E = new Canvas();
    E.fill(circle(PX, PY - 8, 26), radial('#ffffff', '#c5d0f0', PX - 9, PY - 17, 34));
    E.fill(circle(PX + 5, PY - 6, 12.5), radial('#5c7cfa', NAVY, PX + 2, PY - 9, 13), 'atop');
    E.fill(ring(PX + 5, PY - 6, 12.5, 12.5, 1.8), solid(GOLD[1]), 'atop');
    E.fill(circle(PX + 5, PY - 6, 5.5), solid('#0b1440'), 'atop');
    E.fill(circle(PX + 1.5, PY - 10, 2.6), solid(WHITE), 'atop');
    const lid = bezier([PX - 28, PY - 16], [PX - 12, PY - 23], [PX + 12, PY - 20], [PX + 28, PY - 11], 16);
    E.fill([...lid, [PX + 30, PY - 40], [PX - 30, PY - 40]], vgrad('#e5e9fb', '#b7c3ee', PY - 34, PY - 14), 'atop');
    L.draw(E);
    L.fill(stroke(lid.slice(1, -1), 3), solid('#0b1440'));
    for (const t of [4, 8, 12]) { const [x, y] = lid[t]; L.fill(stroke([[x, y], [x + 2, y + 5]], 1.6), solid('#0b1440')); }
    for (const sx of [-1, 1]) L.fill(ellipse(PX + 16 * sx, PY + 7, 5, 2.6), solid('#ff8fa3', 0.6));
  });
}

function goldGlasses(c) {
  const gp = vgrad(GOLD[0], GOLD[2], EY - 16, EY + 16);
  for (const s of [-1, 1]) {
    const x = EX + 21 * s;
    c.fill(ring(x, EY + 1, 15.5, 13, 2.8), gp);
    c.fill(stroke([[x - 9, EY + 3], [x - 2, EY - 7]], 2.8), solid(WHITE, 0.9));
    c.fill(stroke([[x - 3.5, EY + 7], [x + 3.5, EY - 3]], 1.6), solid(WHITE, 0.75));
    c.fill(stroke([[EX + 36 * s, EY - 3], [EX + 54 * s, EY - 6]], 2.4), gp);
    bezier([EX + 54 * s, EY - 5], [EX + 62 * s, EY + 20], [EX + 58 * s, EY + 44], [EX + 66 * s, EY + 62], 14).forEach(([bx, by]) => c.fill(circle(bx, by, 1.9), solid(GOLD[1])));
  }
  c.fill(stroke(bezier([EX - 6, EY - 3], [EX - 3, EY - 8], [EX + 3, EY - 8], [EX + 6, EY - 3], 8), 2.4), gp);
  sparkle(c, EX + 34, EY - 12, 6, '#ffffff');
}

function watchEyes(c) {
  for (const [x, y, w] of [[52, 70, 22], [288, 58, 24], [HX + 4, 24, 18], [24, 168, 15], [306, 166, 16], [40, 262, 13], [300, 268, 14]]) {
    const dx = HX - 10 - x; const dy = 180 - y; const d = Math.hypot(dx, dy) || 1;
    stareEye(c, x, y, w, w * 0.5, [dx / d, dy / d], 0.3);
  }
  for (const [x, y, r] of [[110, 40, 5], [230, 34, 5], [16, 110, 5], [326, 110, 5]]) sparkle(c, x, y, r, '#dbe4ff');
}

// The all-seeing eye: a golden triangle over the head with its eye, and rays.
function providence(c) {
  const cx = HX; const cy = 70;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2; const len = Math.min(i % 2 ? 140 : 180, reach(cx, cy, a));
    c.fill(rotate([[cx - 7, cy], [cx, cy - len], [cx + 7, cy]], cx, cy, a), radial('#fff9db', '#ffd43b', cx, cy, len, 0.85, 0));
  }
  const tri = [[cx, 8], [cx + 100, 176], [cx - 100, 176]];
  const inner = [[cx, 33], [cx + 79, 164], [cx - 79, 164]];
  c.fill(tri, vgrad(GOLD[0], GOLD[2], 8, 176));
  c.fill(inner, vgrad('#3b5bdb', '#0b1440', 33, 164));
  for (let i = 0; i < 12; i++) {
    const a = -Math.PI / 2 + ((i - 5.5) / 12) * 2.2;
    c.fill(stroke([[cx + Math.cos(a) * 24, 66 + Math.sin(a) * 15], [cx + Math.cos(a) * 34, 66 + Math.sin(a) * 23]], 2), solid('#ffe066', 0.9));
  }
  stareEye(c, cx, 68, 24, 12, [0, 0.3], 0);
  for (const [x, y, r] of [[30, 40, 10], [306, 40, 10], [22, 220, 8], [316, 220, 8], [cx - 120, 130, 6], [cx + 120, 130, 6]]) sparkle(c, x, y, r);
}

add('boss-glare-tie', '领带发夹', 0, tieClip, { slot: 'head', boss: 'glare' });
add('boss-glare-pet', '监工小眼', 1, eyePet, { slot: 'pet', boss: 'glare' });
add('boss-glare-glasses', '金丝眼镜', 2, goldGlasses, { slot: 'head', boss: 'glare', glow: '#fff3bf' });
add('boss-glare-eyes', '凝视之眼', 3, watchEyes, { slot: 'fx', boss: 'glare', layer: 'back', glow: '#91a7ff' });
add('boss-glare-eye', '全知之眼', 4, providence, { slot: 'fx', boss: 'glare', layer: 'back', glow: '#ffd43b' });

// 996 魔王: demon purple and red, black, and hellfire.
// A bat wing from (ox, oy): the arm out to the wrist, fingers to the tips, scalloped between them;
// k scales it, rot turns it about the shoulder.
function batWing(c, s, ox, oy, k, membrane, bone, rot = 0) {
  const R = (pts) => rotate(pts, ox, oy, rot);
  const [wr] = R([[ox + 78 * k * s, oy - 116 * k]]);
  const tips = R([[ox + 138 * k * s, oy - 122 * k], [ox + 136 * k * s, oy - 36 * k], [ox + 116 * k * s, oy + 26 * k], [ox + 66 * k * s, oy + 60 * k]]);
  const edge = [[ox, oy], ...bezier([ox, oy], ...R([[ox + 20 * k * s, oy - 66 * k], [ox + 50 * k * s, oy - 108 * k]]), wr, 12).slice(1), ...bezier(wr, ...R([[ox + 100 * k * s, oy - 130 * k], [ox + 120 * k * s, oy - 130 * k]]), tips[0], 8).slice(1)];
  for (let i = 0; i < tips.length; i++) {
    const a = tips[i]; const [b] = tips[i + 1] ? [tips[i + 1]] : R([[ox + 10 * k * s, oy + 44 * k]]);
    edge.push(...bezier(a, [a[0] + (wr[0] - a[0]) * 0.3, a[1] + (wr[1] - a[1]) * 0.3], [b[0] + (wr[0] - b[0]) * 0.3, b[1] + (wr[1] - b[1]) * 0.3], b, 10).slice(1));
  }
  c.fill(edge, membrane);
  for (const t of tips) c.fill(taper([wr, t], 4.5 * k + 1, 1.5), solid(bone));
  c.fill(taper([[ox, oy], wr], 7 * k + 1, 4 * k + 1), solid(bone));
  c.fill([[wr[0] - 3 * s, wr[1]], [wr[0] - 2 * s, wr[1] - 14 * k], [wr[0] + 5 * s, wr[1] - 2]], solid('#e9ecef'));
}
// Little imp horns: short, curling out and up, purple fading to red at the tip.
function demonHorns(c) {
  for (const s of [-1, 1]) {
    const bx = HX + 28 * s; const by = HY + 20;
    const horn = [...bezier([bx - 10 * s, by], [bx - 6 * s, by - 20], [bx + 10 * s, by - 26], [bx + 20 * s, by - 38], 14), ...bezier([bx + 20 * s, by - 38], [bx + 16 * s, by - 22], [bx + 12 * s, by - 10], [bx + 11 * s, by], 14).slice(1)];
    c.fill(horn, vgrad('#ff8787', '#5f3dc4', by - 38, by - 4));
    c.fill(stroke(bezier([bx - 5 * s, by - 6], [bx - 2 * s, by - 16], [bx + 6 * s, by - 22], [bx + 13 * s, by - 29], 10), 2.2), solid(WHITE, 0.45));
    c.fill(ellipse(bx, by, 12, 4.5), solid('#3b1f78'));
  }
}

function demonPet(c) {
  const back = (L) => {
    // little bat wings at its sides (there is no room on the left for big ones)
    for (const s of [-1, 1]) {
      const wr = [PX + 30 * s, PY - 16];
      const tips = [[PX + 35 * s, PY - 2], [PX + 33 * s, PY + 10], [PX + 25 * s, PY + 19]];
      const edge = [[PX + 16 * s, PY + 2], ...bezier([PX + 16 * s, PY + 2], [PX + 20 * s, PY - 10], [PX + 26 * s, PY - 15], wr, 8).slice(1), tips[0]];
      tips.forEach((a, i) => { const b = tips[i + 1] || [PX + 16 * s, PY + 16]; edge.push(...bezier(a, [a[0] - 4 * s, a[1] + 2], [b[0] - 3 * s, b[1] - 3], b, 6).slice(1)); });
      L.fill(edge, vgrad('#7048e8', '#2b1b4f', PY - 16, PY + 20));
      for (const t of tips) L.fill(stroke([wr, t], 1.6), solid('#1a1033'));
    }
    const tail = bezier([PX + 14, PY + 26], [PX + 36, PY + 34], [PX + 40, PY + 14], [PX + 34, PY + 2], 14);
    L.fill(stroke(tail, 3.4), solid('#5f3dc4'));
    L.fill(rotate([[PX + 34, PY - 10], [PX + 41, PY + 2], [PX + 34, PY + 6], [PX + 27, PY + 2]], PX + 34, PY + 2, 0.3), solid('#e03131'));
  };
  const front = (L) => {
    for (const s of [-1, 1]) L.fill([[PX + 9 * s, PY - 26], [PX + 18 * s, PY - 44], [PX + 19 * s, PY - 24]], vgrad('#ff8787', '#1a1033', PY - 44, PY - 24));
    L.fill([[PX + 2, PY + 7], [PX + 6, PY + 7], [PX + 4, PY + 11]], solid(WHITE));
  };
  animal(c, { body: '#845ef7', belly: '#d0bfff', eyes: '#ffd43b', mouth: 'w', blush: '#f783ac', back, front });
}

// The demon king's crown: black iron spikes, the outer ones curling out like horns.
function demonCrown(c) {
  const iron = vgrad('#9775fa', '#1a1033', HY - 62, HY + 8);
  const spike = (x, w, h, bend) => [...bezier([x - w / 2, HY + 6], [x - w / 2, HY - h * 0.5], [x + bend * 0.4, HY - h * 0.8], [x + bend, HY - h], 12), ...bezier([x + bend, HY - h], [x + w * 0.1 + bend * 0.3, HY - h * 0.6], [x + w / 2, HY - h * 0.4], [x + w / 2, HY + 6], 12).slice(1)];
  for (const [dx, w, h, bend] of [[-46, 20, 44, -18], [-24, 16, 44, -4], [0, 20, 60, 0], [24, 16, 44, 4], [46, 20, 44, 18]]) {
    c.fill(spike(HX + dx, w, h, bend), iron);
    c.fill(stroke(bezier([HX + dx - w * 0.2, HY], [HX + dx - w * 0.2, HY - h * 0.45], [HX + dx + bend * 0.3, HY - h * 0.7], [HX + dx + bend * 0.85, HY - h * 0.92], 10), 1.8), solid('#e599f7', 0.6));
  }
  for (const [dx, h, bend] of [[-24, 44, -4], [0, 60, 0], [24, 44, 4]]) c.fill(circle(HX + dx + bend, HY - h + 1, 4.5), glossy('#fa5252', HX + dx + bend, HY - h + 1, 4.5));
  c.fill(roundRect(HX - 58, HY, 116, 22, 6), vgrad('#3b1f78', '#1a1033', HY, HY + 22));
  for (const y of [HY + 1, HY + 21]) c.fill(stroke([[HX - 56, y], [HX + 56, y]], 2.6), goldPaint(y - 2, y + 2));
  for (let i = -5; i <= 5; i++) if (i % 2) c.fill(circle(HX + i * 10, HY + 11, 2.2), solid(GOLD[1]));
  gem(c, HX, HY + 11, 8, '#fa5252');
  for (const s of [-1, 1]) gem(c, HX + 24 * s, HY + 11, 5.5, '#e03131');
}

function demonWings(c) {
  for (const s of [-1, 1]) batWing(c, s, HX + 30 * s, 196, 0.92, radial('#c2255c', '#1a1033', HX + 60 * s, 160, 170), '#140b26');
  for (const [x, y, r] of [[HX - 58, 30, 6], [HX + 60, 24, 6]]) sparkle(c, x, y, r, '#e599f7');
}

// Hellfire rising from the ground round the girl: three ranks of flame tongues, the tallest at the
// back burning purple into black, the front ones white-hot into red.
function hellfire(c) {
  const rand = rng(67);
  for (const [k, base, tip, a] of [[1, '#e64980', '#5f3dc4', 0.88], [0.72, '#ff8787', '#be4bdb', 0.94], [0.45, '#fff0f6', '#fa5252', 1]]) {
    for (let i = 0; i < 9; i++) {
      // the outer tongues lean in so the fire stays on the canvas
      const x = 30 + i * 34.5 + (rand() - 0.5) * 10;
      const side = Math.min(1, Math.abs(x - HX) / 150);
      const h = (80 + 220 * side ** 1.2) * k * (0.8 + rand() * 0.4);
      const out = x < HX ? -1 : 1;
      const w = Math.min((64 + rand() * 34) * Math.sqrt(k), 2 * (Math.min(x, W - x) - 8));
      const paint = (px, py) => { const t = Math.max(0, Math.min(1, (344 - py) / h)); return [...mix(col(base), col(tip), t), a * (1 - 0.3 * t)]; };
      c.fill(flameShape(x, 344, w, h, -out * (0.03 + rand() * 0.06), out * (0.05 + rand() * 0.05)), paint);
    }
  }
  for (const [x, y, h, s] of [[22, 96, 34, -1], [312, 80, 38, 1], [56, 40, 24, -1], [286, 30, 26, 1], [HX - 92, 120, 22, -1], [HX + 96, 112, 22, 1]]) c.fill(flameShape(x, y, h * 0.5, h, 0.1 * s, 0.12 * s), vgrad('#be4bdb', '#ff8787', y - h, y, 0.9));
  c.fill(ellipse(HX, 336, 190, 40), radial('#f03e3e', '#9c36b5', HX, 336, 190, 0.6, 0));
  for (let i = 0; i < 34; i++) {
    const x = 8 + rand() * 320; const y = 10 + rand() * 260; const r = 1 + rand() * 2.4;
    if (rand() < 0.3) c.fill(star(x, y, r * 2, r * 0.7, 4, 0), solid('#ffc9c9')); else c.fill(circle(x, y, r), solid(rand() < 0.5 ? '#e599f7' : '#ff8787', 0.95));
  }
}

add('boss-demon-horns', '魔王小角', 0, demonHorns, { slot: 'head', boss: 'demon' });
add('boss-demon-pet', '小魔王', 1, demonPet, { slot: 'pet', boss: 'demon' });
add('boss-demon-crown', '魔王之冠', 2, demonCrown, { slot: 'head', boss: 'demon', glow: '#d0bfff' });
add('boss-demon-wings', '恶魔之翼', 3, demonWings, { slot: 'fx', boss: 'demon', layer: 'back', glow: '#9775fa' });
add('boss-demon-fire', '地狱业火', 4, hellfire, { slot: 'fx', boss: 'demon', layer: 'back', glow: '#be4bdb', outline: 0 });

// ---------------------------------------------------------------- meme collection (append-only ids)
function memeBuddy(c, theme, mythic) {
  const x=278,y=252;
  if(theme==='cat'){
    c.fill(ellipse(x,y+21,23,32),shade('#e8a048',y-10,y+55));
    c.fill([[x-25,y-23],[x-28,y-58],[x-5,y-39]],solid('#d78e36'));c.fill([[x+25,y-23],[x+28,y-58],[x+5,y-39]],solid('#d78e36'));
    c.fill(ellipse(x,y-22,29,24),shade('#e8ae65',y-48,y+5));
    for(const s of [-1,1]){c.fill(ellipse(x+s*12,y-25,8,4,-s*.2),solid('#91b86b'));c.fill(ellipse(x+s*12,y-25,2,4),solid('#263524'));}
    c.fill([[x-8,y-12],[x+8,y-12],[x,y+4]],solid('#443127'));c.fill([[x-6,y-12],[x-2,y-12],[x-4,y-6]],solid('#fffbe7'));
    for(const s of [-1,1])for(let k=0;k<3;k++)c.fill(stroke([[x+s*16,y-10+k*4],[x+s*36,y-13+k*5]],1),solid('#875e36'));
  }else if(theme==='frog'){
    c.fill(ellipse(x,y+15,27,35),shade('#f4ca3d',y-20,y+55));c.fill(ellipse(x,y+25,19,25),shade('#fff0b2',y,y+55));
    c.fill(ellipse(x,y-18,29,22),shade('#f6d64b',y-44,y+8));
    for(const s of [-1,1]){c.fill(ellipse(x+s*15,y-38,13,16),shade('#c6da5a',y-55,y-20));c.fill(ellipse(x+s*15,y-39,8,11),solid('#b9f28b'));c.fill(ellipse(x+s*16,y-36,4,7),solid('#3d3928'));c.fill(ellipse(x+s*28,y+26,6,15,s*.7),shade('#716440',y+10,y+40));}
    c.fill(ellipse(x,y-9,17,12),solid('#67512b'));c.fill(ellipse(x,y-3,11,5),solid('#d98465'));
  }else if(theme==='ball'){
    c.fill(circle(x,y,27),shade('#e89334',y-27,y+27));c.fill(stroke([[x-27,y],[x+27,y]],2),solid('#70502f'));c.fill(stroke([[x,y-27],[x,y+27]],2),solid('#70502f'));c.fill(ellipse(x,y,14,27),solid('#6a4a2e'));c.fill(ellipse(x,y,12,27),shade('#dc8832',y-27,y+27));
    c.fill(ellipse(x,y+34,31,6),solid('#392365',.6));
  }else{
    c.fill(roundRect(x-17,y-32,34,79,8),vgrad('#ee9b34','#94491a',y-32,y+47));c.fill(roundRect(x-13,y-42,26,13,3),shade('#d64131',y-42,y-29));c.fill(roundRect(x-18,y-5,36,27,3),shade('#dc4e35',y-5,y+22));c.fill(ellipse(x,y+7,11,9),solid('#fff1a5'));c.fill(ellipse(x,y+7,8,6),solid('#e8ba39'));
  }
  if(mythic){c.fill(star(x,y-67,14,6),goldPaint(y-80,y-53));for(const [dx,dy]of[[-37,-34],[35,-13],[-32,32],[33,48]])sparkle(c,x+dx,y+dy,5,'#fff0a5');}
}
function memeHood(c,theme,mythic){
  const color=theme==='cat'?'#e5a659':theme==='frog'?'#f0d451':theme==='ball'?'#7c4bcc':'#df5632';
  if(theme==='cat'){
    c.fill([[109,74],[117,18],[153,60]],shade(color,18,87));c.fill([[227,74],[219,18],[183,60]],shade(color,18,87));c.fill(ellipse(HX,69,62,27),shade(color,43,94));
    for(const s of [-1,1])c.fill(stroke([[HX+s*27,59],[HX+s*38,68]],4),solid('#6e4e36'));
  }else if(theme==='frog'){
    c.fill(ellipse(HX,68,62,29),shade(color,35,97));for(const s of [-1,1]){c.fill(ellipse(HX+s*31,35,22,25),shade('#dce866',10,61));c.fill(ellipse(HX+s*31,35,13,17),solid('#b9ed88'));c.fill(ellipse(HX+s*31,39,6,10),solid('#564c2d'));}
    c.fill(ellipse(HX,72,24,12),solid('#725334'));c.fill(ellipse(HX,76,16,6),solid('#d98e78'));
  }else if(theme==='ball'){
    c.fill(roundRect(HX-64,65,128,22,8),shade('#7845b2',65,87));for(const y of[66,84])c.fill(rect(HX-59,y,118,3),goldPaint(y,y+3));c.fill(star(HX,75,9,4),solid('#ffe07d'));
  }else{
    c.fill(roundRect(HX-31,15,62,63,12),vgrad('#f2c458','#b45a21',15,80));c.fill(roundRect(HX-24,4,48,15,4),shade('#d73d31',4,19));c.fill(roundRect(HX-34,39,68,28,3),shade('#df5137',39,67));c.fill(circle(HX,53,11),solid('#ffe19a'));c.fill(ellipse(HX,82,63,12),shade('#eeaa43',70,94));
  }
  if(mythic){for(const s of[-1,1]){c.fill(star(HX+s*76,55,12,5),goldPaint(40,68));sparkle(c,HX+s*48,14,6,'#fff3bc');}c.fill(star(HX,4,11,5),solid('#ffe7a1'));}
}
function digit(c,n,x,y){const segments={2:[0,1,3,4,6],4:[1,2,3,5]};const bars=[[x,y,16,3],[x+13,y,3,16],[x,y,3,16],[x,y+14,16,3],[x,y+16,3,16],[x+13,y+16,3,16],[x,y+29,16,3]];for(const k of segments[n])c.fill(roundRect(...bars[k],1),solid('#fff0ad'));}
function memeClothes(c,theme,mythic){
  const tea=theme==='tea',color=tea?'#d9472d':'#6536a0';
  c.fill([[111,211],[137,201],[151,212],[175,212],[191,201],[216,214],[223,243],[201,251],[198,316],[125,316],[122,251],[101,242]],shade(color,201,316));
  c.fill(stroke([[137,202],[151,216],[175,216],[191,202]],5),solid(tea?'#ffda62':'#f2c64b'));
  for(const x of[128,194])c.fill(rect(x,241,3,68),solid('#f7d37c'));
  if(tea){c.fill(roundRect(130,236,65,37,4),shade('#efa94c',236,273));c.fill(ellipse(163,254,18,12),solid('#ffe59a'));c.fill(ellipse(163,254,12,8),solid('#e0b43f'));c.fill(stroke([[148,254],[178,254]],1),solid('#fff2b1'));}
  else{digit(c,2,140,237);digit(c,4,163,237);}
  if(mythic){for(const s of[-1,1]){c.fill(star(HX+s*55,222,9,4),goldPaint(210,235));sparkle(c,HX+s*60,282,6,'#fff0ae');}c.fill(rect(128,309,67,4),goldPaint(309,315));}
}
function memeAura(c,theme,mythic){
  const cc=theme==='cat'?'#ffc56c':theme==='frog'?'#d8ef6e':'#e0c1ff';
  c.fill(ellipse(HX,193,142,125),radial(cc,cc,HX,193,150,.08,0));
  for(let i=0;i<(mythic?16:10);i++){const a=i*Math.PI*2/(mythic?16:10),x=HX+Math.cos(a)*135,y=187+Math.sin(a)*126;if(theme==='frog'){c.fill(circle(x,y,7),glossy('#efdd54',x,y,7));}else if(theme==='ball'){c.fill(circle(x,y,7),glossy('#eaa344',x,y,7));}else{c.fill(star(x,y,mythic?8:6,3),solid(cc));}}
  if(mythic)c.fill(ring(HX,187,149,135,2.5),solid(cc,.7));
}
for(const [theme,label,third]of[['cat','哈基米','fx'],['frog','奶蛙','fx'],['ball','牢大','body'],['tea','冰红茶','body']]){
  for(const [rarity,mythic,suffix]of[[3,false,'传说'],[4,true,'神话']]){
    const glow=theme==='frog'?'#e3ed8b':theme==='ball'?'#c4a0ed':'#ffd58e';
    add(`meme-${theme}-hood-${rarity}`,`${label}·${theme==='ball'?'紫金头带':theme==='tea'?'茶瓶帽':'整活头套'}·${suffix}`,rarity,c=>memeHood(c,theme,mythic),{slot:'head',glow});
    add(`meme-${theme}-buddy-${rarity}`,`${label}·${mythic?'金色传说伙伴':'摸鱼伙伴'}`,rarity,c=>memeBuddy(c,theme,mythic),{slot:'pet',glow});
    add(`meme-${theme}-${third}-${rarity}`,`${label}·${third==='body'?(theme==='ball'?'紫金24号球衣':'红茶卫衣'):'抽象圣环'}·${suffix}`,rarity,c=>third==='body'?memeClothes(c,theme,mythic):memeAura(c,theme,mythic),{slot:third,layer:third==='fx'?'back':'front',glow,outline:third==='fx'?0:1.3});
  }
}

// ---------------------------------------------------------------- output
function main() {
  const root = path.join(__dirname, '..');
  const out = path.join(root, 'ui', 'assets', 'decos');
  const counts = [0, 0, 0, 0, 0];
  for (const it of ITEMS) counts[it.rarity]++;
  if (new Set(ITEMS.map((i) => i.id)).size !== ITEMS.length) throw new Error('duplicate ids');
  const onlyNew=process.argv.includes('--only-new');
  const previous=onlyNew&&fs.existsSync(path.join(out,'decos.json'))?new Map(JSON.parse(fs.readFileSync(path.join(out,'decos.json'),'utf8')).map(it=>[it.id,it])):new Map();
  if(!onlyNew) fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const images = [];
  for (const it of ITEMS) {
    if(onlyNew&&previous.has(it.id)&&fs.existsSync(path.join(out,`${it.id}.png`))){it.box=previous.get(it.id).box;if(process.argv.includes('--preview'))images.push(decodePng(path.join(out,`${it.id}.png`)));continue;}
    const c = new Canvas();
    it.draw(c);
    const img = finish(c.reduce(), it.opts);
    fs.writeFileSync(path.join(out, `${it.id}.png`), encodePng(img));
    images.push(img);
    it.box = iconBox(img);
    process.stdout.write('.');
  }
  const manifest = ITEMS.map(({ id, name, rarity, slot, layer, box, boss }) => ({ id, name, rarity, slot, layer, box, ...(boss && { boss }) }));
  fs.writeFileSync(path.join(out, 'decos.json'), `[\n${manifest.map((m) => `  ${JSON.stringify(m)}`).join(',\n')}\n]\n`);
  const slots = ['head', 'body', 'pet', 'fx'].map((k) => `${k} ${ITEMS.filter((i) => i.slot === k).length}`).join(', ');
  console.log(`\n${ITEMS.length} decos (by rarity: ${counts.join(' / ')}; ${slots}) -> ${path.relative(root, out)}`);
  if (process.argv.includes('--preview')) preview(root, images);
}

/** Square crop around the visible art (with a margin), clamped to the canvas. */
function iconBox(img) {
  let x0 = W; let y0 = H; let x1 = 0; let y1 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (img.px[(y * W + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
    }
  }
  const side = Math.min(Math.min(W, H), Math.max(x1 - x0, y1 - y0) + 8);
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  const left = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const top = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  return [left, top, left + side, top + side];
}

/** Contact sheets, one per slot: every item worn by a character (cycling through all six). */
function preview(root, images) {
  const chars = ['claude', 'codex', 'doubao', 'gemini', 'deepseek', 'kimi'].map((id) => {
    const im = decodePng(path.join(root, 'ui', 'assets', 'characters', id, 'idle.png'));
    const ch = Math.round(BOX.h); const cw = Math.round((im.w / im.h) * ch);
    return { img: resize(im, cw, ch), x: BOX.x + Math.round((BOX.w - cw) / 2) };
  });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  for (const slot of ['head', 'body', 'pet', 'fx']) {
    const idx = ITEMS.map((it, i) => (it.slot === slot ? i : -1)).filter((i) => i >= 0);
    const cols = 8; const rows = Math.ceil(idx.length / cols);
    const sheet = { w: cols * W, h: rows * H, px: Buffer.alloc(cols * W * rows * H * 4) };
    idx.forEach((i, n) => {
      const ox = (n % cols) * W; const oy = Math.floor(n / cols) * H;
      const put = (img, dx, dy) => {
        for (let y = 0; y < img.h; y++) {
          for (let x = 0; x < img.w; x++) {
            const s = (y * img.w + x) * 4; const d = ((oy + dy + y) * sheet.w + ox + dx + x) * 4;
            const a = img.px[s + 3] / 255;
            for (let k = 0; k < 3; k++) sheet.px[d + k] = img.px[s + k] * a + sheet.px[d + k] * (1 - a);
            sheet.px[d + 3] = 255;
          }
        }
      };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = ((oy + y) * sheet.w + ox + x) * 4; sheet.px.fill(((x >> 4) + (y >> 4)) % 2 ? 236 : 248, d, d + 3); sheet.px[d + 3] = 255; }
      const { img: char, x: cx } = chars[n % chars.length];
      if (ITEMS[i].layer === 'back') { put(images[i], 0, 0); put(char, cx, BOX.y); } else { put(char, cx, BOX.y); put(images[i], 0, 0); }
    });
    const half = resize(sheet, sheet.w / 2, sheet.h / 2);
    fs.writeFileSync(path.join(root, 'dist', `decos-preview-${slot}.png`), encodePng(half));
  }
  console.log('previews -> dist/decos-preview-*.png');
}

main();
