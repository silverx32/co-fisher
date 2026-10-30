'use strict';
// Builds app/icons/icon.ico + icon.png from the head of a character's idle frame.
// Run: node tools/make-icon.js [character]   (no dependencies)
const fs = require('fs');
const path = require('path');
const { decodePng, encodePng, resize } = require('./png');

const char = process.argv[2] || 'claude';
const SIZES = [256, 64, 48, 32, 16];
const root = path.join(__dirname, '..');
const src = decodePng(path.join(root, 'ui', 'assets', 'characters', char, 'idle.png'));

// Square crop around the head (top-centre), so it still reads at 16x16.
const side = Math.round(Math.min(src.w, src.h) * 0.7);
const sq = { w: side, h: side, px: Buffer.alloc(side * side * 4) };
const x0 = Math.floor((src.w - side) / 2);
const y0 = Math.round(src.h * 0.04);
for (let y = 0; y < side; y++) src.px.copy(sq.px, y * side * 4, ((y0 + y) * src.w + x0) * 4, ((y0 + y) * src.w + x0 + side) * 4);

const pngs = SIZES.map((size) => ({ size, png: encodePng(resize(sq, size, size)) }));

// ICO with PNG-compressed entries.
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const dir = Buffer.alloc(16 * pngs.length);
let offset = 6 + dir.length;
pngs.forEach(({ size, png }, i) => {
  const o = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, o);
  dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(png.length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += png.length;
});
const out = path.join(root, 'app', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, dir, ...pngs.map((p) => p.png)]));
fs.writeFileSync(path.join(out, 'icon.png'), pngs[0].png);
console.log('icon written:', SIZES.join(', '));
