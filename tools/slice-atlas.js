'use strict';
// Slices the character atlases (3 x 2 grid, transparent PNG) into per-character frames:
//   art/atlas/{idle,typing1,typing2,typing3}.png
//   -> ui/assets/characters/<id>/{idle,typing1,typing2,typing3}.png
// Neighbouring characters' hair can overlap the grid lines, so cells are separated along the
// least-opaque path (a seam) instead of straight cuts. All frames of a character are cropped
// with the same box so switching frames doesn't make the sprite jump.
// Run: node tools/slice-atlas.js   (no dependencies)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'art', 'atlas');
const OUT = path.join(ROOT, 'ui', 'assets', 'characters');
const FRAMES = ['idle', 'typing1', 'typing2', 'typing3'];
// Grid order, left-to-right then top-to-bottom. Must match CHARACTERS in server/src/lib.rs.
const IDS = ['claude', 'codex', 'doubao', 'gemini', 'deepseek', 'kimi'];
const COLS = 3;
const ROWS = 2;
const TARGET_H = 360;
const ALPHA_ON = 24; // alpha above this counts as "drawn"
// Where a neighbour's hair crosses the seam, drop pixels of the neighbour's colour near that edge.
// deepseek: gemini's purple hair ends reach into deepseek's cell on the left.
const FOREIGN = { deepseek: { side: 'left', band: 90, hue: [255, 330] } };

const { decodePng, encodePng, resize } = require('./png');

// ---------------------------------------------------------------- segmentation

const alphaAt = (img, x, y) => img.px[(y * img.w + x) * 4 + 3];

/** Row with the fewest drawn pixels near the vertical middle. */
function rowSplit(img) {
  let best = 0; let bestCost = Infinity;
  for (let y = Math.floor(img.h * 0.4); y < img.h * 0.6; y++) {
    let cost = 0;
    for (let x = 0; x < img.w; x++) if (alphaAt(img, x, y) > ALPHA_ON) cost++;
    if (cost < bestCost) { bestCost = cost; best = y; }
  }
  return best;
}

/** Least-opaque top-to-bottom path within [y0, y1) staying near column `cx` (dynamic programming). */
function seam(img, cx, y0, y1, reach) {
  const xs = Math.max(1, cx - reach); const xe = Math.min(img.w - 2, cx + reach);
  const W = xe - xs + 1; const H = y1 - y0;
  const cost = new Float64Array(W * H);
  const from = new Int8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let i = 0; i < W; i++) {
      // Small pull towards the grid line keeps the seam from wandering through empty space.
      const own = alphaAt(img, xs + i, y0 + y) + Math.abs(xs + i - cx) * 0.02;
      if (y === 0) { cost[i] = own; continue; }
      let best = cost[(y - 1) * W + i]; let d = 0;
      if (i > 0 && cost[(y - 1) * W + i - 1] < best) { best = cost[(y - 1) * W + i - 1]; d = -1; }
      if (i < W - 1 && cost[(y - 1) * W + i + 1] < best) { best = cost[(y - 1) * W + i + 1]; d = 1; }
      cost[y * W + i] = best + own;
      from[y * W + i] = d;
    }
  }
  let i = 0;
  for (let k = 1; k < W; k++) if (cost[(H - 1) * W + k] < cost[(H - 1) * W + i]) i = k;
  const path = new Int32Array(H);
  for (let y = H - 1; y >= 0; y--) {
    path[y] = xs + i;
    i += from[y * W + i];
  }
  return path; // path[y - y0] = seam x for that row
}

/** Copies one cell (between seams) into its own image, dropping specks; returns it with its bbox. */
function hueOf(r, g, b) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s: d / max };
}

function extractCell(img, y0, y1, left, right, foreign) {
  const w = img.w; const h = y1 - y0;
  const cell = { w, h, px: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const xa = left ? left[y] + 1 : 0;
    const xb = right ? right[y] : w;
    img.px.copy(cell.px, (y * w + xa) * 4, ((y0 + y) * w + xa) * 4, ((y0 + y) * w + xb) * 4);
    if (!foreign) continue;
    const [fa, fb] = foreign.side === 'left' ? [xa, Math.min(xb, xa + foreign.band)] : [Math.max(xa, xb - foreign.band), xb];
    for (let x = fa; x < fb; x++) {
      const i = (y * w + x) * 4;
      const { h: hue, s: sat } = hueOf(cell.px[i], cell.px[i + 1], cell.px[i + 2]);
      if (sat > 0.2 && hue >= foreign.hue[0] && hue <= foreign.hue[1]) cell.px.fill(0, i, i + 4);
    }
  }
  // Connected components on the drawn mask; keep only sizeable ones (removes stray dots).
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || cell.px[start * 4 + 3] <= ALPHA_ON) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % w; const y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && label[q] === -1 && cell.px[q * 4 + 3] > ALPHA_ON) { label[q] = id; stack.push(q); }
      }
    }
    sizes.push(size);
  }
  const keepMin = Math.max(...sizes) * 0.01;
  let x0 = w; let x1 = -1; let by0 = h; let by1 = -1;
  for (let p = 0; p < w * h; p++) {
    const l = label[p];
    if (l === -1) {
      if (cell.px[p * 4 + 3] <= ALPHA_ON) continue; // faint edge pixels are kept as-is
    } else if (sizes[l] < keepMin) {
      cell.px.fill(0, p * 4, p * 4 + 4);
      continue;
    }
    if (cell.px[p * 4 + 3] <= ALPHA_ON) continue;
    const x = p % w; const y = (p - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  return { cell, y0, box: { x0, y0: by0 + y0, x1, y1: by1 + y0 } };
}

function crop(cellInfo, box) {
  const { cell, y0 } = cellInfo;
  const w = box.x1 - box.x0 + 1; const h = box.y1 - box.y0 + 1;
  const out = { w, h, px: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = box.y0 + y - y0;
    if (sy < 0 || sy >= cell.h) continue;
    cell.px.copy(out.px, y * w * 4, (sy * cell.w + box.x0) * 4, (sy * cell.w + box.x1 + 1) * 4);
  }
  return out;
}

// ---------------------------------------------------------------- main

const cells = {}; // id -> [{cell, y0, box} per frame]
for (const frame of FRAMES) {
  const img = decodePng(path.join(SRC, `${frame}.png`));
  const split = rowSplit(img);
  const bands = [[0, split], [split, img.h]];
  for (let r = 0; r < ROWS; r++) {
    const [y0, y1] = bands[r];
    const seams = [];
    for (let c = 1; c < COLS; c++) seams.push(seam(img, Math.round((img.w * c) / COLS), y0, y1, Math.round(img.w * 0.09)));
    for (let c = 0; c < COLS; c++) {
      const id = IDS[r * COLS + c];
      (cells[id] ||= []).push(extractCell(img, y0, y1, seams[c - 1], seams[c], FOREIGN[id]));
    }
  }
  console.log(`${frame}: ${img.w}x${img.h}, rows split at y=${split}`);
}

for (const id of IDS) {
  const frames = cells[id];
  const box = frames.reduce((u, f) => ({
    x0: Math.min(u.x0, f.box.x0), y0: Math.min(u.y0, f.box.y0), x1: Math.max(u.x1, f.box.x1), y1: Math.max(u.y1, f.box.y1),
  }), { x0: Infinity, y0: Infinity, x1: -1, y1: -1 });
  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((f, i) => {
    const full = crop(f, box);
    const nh = Math.min(TARGET_H, full.h);
    const nw = Math.round((full.w * nh) / full.h);
    const png = encodePng(resize(full, nw, nh));
    fs.writeFileSync(path.join(dir, `${FRAMES[i]}.png`), png);
  });
  console.log(`${id}: box ${box.x1 - box.x0 + 1}x${box.y1 - box.y0 + 1} -> ${FRAMES.length} frames`);
}
