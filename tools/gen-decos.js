'use strict';
// Draws the cosmetics ("装扮") procedurally:
//   ui/assets/decos/<id>.png    one transparent PNG per item
//   ui/assets/decos/decos.json  [{ id, name, rarity, layer, box }] (read by the app at build time)
//                               box = [x0, y0, x1, y1]: square crop around the art, for icons
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
const add = (id, name, rarity, draw, opts = {}) => ITEMS.push({ id, name, rarity, layer: opts.layer || 'front', draw, opts });
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

// ---------------------------------------------------------------- output
function main() {
  const root = path.join(__dirname, '..');
  const out = path.join(root, 'ui', 'assets', 'decos');
  const counts = [0, 0, 0, 0, 0];
  for (const it of ITEMS) counts[it.rarity]++;
  if (ITEMS.length !== 100 || new Set(ITEMS.map((i) => i.id)).size !== ITEMS.length) throw new Error(`need 100 unique items, got ${ITEMS.length}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const images = [];
  for (const it of ITEMS) {
    const c = new Canvas();
    it.draw(c);
    const img = finish(c.reduce(), it.opts);
    fs.writeFileSync(path.join(out, `${it.id}.png`), encodePng(img));
    images.push(img);
    it.box = iconBox(img);
    process.stdout.write('.');
  }
  const manifest = ITEMS.map(({ id, name, rarity, layer, box }) => ({ id, name, rarity, layer, box }));
  fs.writeFileSync(path.join(out, 'decos.json'), `[\n${manifest.map((m) => `  ${JSON.stringify(m)}`).join(',\n')}\n]\n`);
  console.log(`\n${ITEMS.length} decos (by rarity: ${counts.join(' / ')}) -> ${path.relative(root, out)}`);
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

/** Contact sheets: every item worn by a character, one sheet per rarity. */
function preview(root, images) {
  const charImg = decodePng(path.join(root, 'ui', 'assets', 'characters', 'claude', 'idle.png'));
  const ch = Math.round(BOX.h); const cw = Math.round((charImg.w / charImg.h) * ch);
  const char = resize(charImg, cw, ch);
  const cx = BOX.x + Math.round((BOX.w - cw) / 2);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  for (let r = 0; r <= 4; r++) {
    const idx = ITEMS.map((it, i) => (it.rarity === r ? i : -1)).filter((i) => i >= 0);
    const cols = 6; const rows = Math.ceil(idx.length / cols);
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
      if (ITEMS[i].layer === 'back') { put(images[i], 0, 0); put(char, cx, BOX.y); } else { put(char, cx, BOX.y); put(images[i], 0, 0); }
    });
    const half = resize(sheet, sheet.w / 2, sheet.h / 2);
    fs.writeFileSync(path.join(root, 'dist', `decos-preview-${r}.png`), encodePng(half));
  }
  console.log('previews -> dist/decos-preview-*.png');
}

main();
