'use strict';
// Minimal dependency-free PNG helpers for the asset tools (8-bit RGBA, non-interlaced).

const fs = require('fs');
const zlib = require('zlib');

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let w; let h; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${file}: need 8-bit RGBA, non-interlaced`);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[out + x - 4] : 0;
      const b = y > 0 ? px[out - stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[out - stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[out + x] = v & 255;
    }
  }
  return { w, h, px };
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(b) {
  let c = -1;
  for (const v of b) c = CRC_TABLE[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng({ w, h, px }) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      raw[y * (stride + 1) + 1 + x] = (v - (x >= 4 ? px[y * stride + x - 4] : 0)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Area-averaging downscale with premultiplied alpha (no dark fringes). */
function resize(img, nw, nh) {
  // Shrinks each row from w to nw pixels, averaging the source pixels each output pixel covers.
  const shrinkRows = (src, w, h, outW) => {
    const out = new Float64Array(outW * h * 4);
    const scale = w / outW;
    for (let j = 0; j < outW; j++) {
      const a = j * scale; const b = a + scale;
      for (let k = Math.floor(a); k < Math.min(w, Math.ceil(b)); k++) {
        const wgt = (Math.min(b, k + 1) - Math.max(a, k)) / scale;
        for (let y = 0; y < h; y++) {
          for (let c = 0; c < 4; c++) out[(y * outW + j) * 4 + c] += src[(y * w + k) * 4 + c] * wgt;
        }
      }
    }
    return out;
  };
  const transpose = (src, w, h) => {
    const out = new Float64Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) out[(x * h + y) * 4 + c] = src[(y * w + x) * 4 + c];
    }
    return out;
  };
  const pre = new Float64Array(img.w * img.h * 4);
  for (let p = 0; p < img.w * img.h; p++) {
    const a = img.px[p * 4 + 3] / 255;
    pre[p * 4] = img.px[p * 4] * a; pre[p * 4 + 1] = img.px[p * 4 + 1] * a; pre[p * 4 + 2] = img.px[p * 4 + 2] * a; pre[p * 4 + 3] = img.px[p * 4 + 3];
  }
  const wide = shrinkRows(pre, img.w, img.h, nw); // nw x h
  const result = transpose(shrinkRows(transpose(wide, nw, img.h), img.h, nw, nh), nh, nw); // nw x nh
  const out = { w: nw, h: nh, px: Buffer.alloc(nw * nh * 4) };
  for (let p = 0; p < nw * nh; p++) {
    const a = result[p * 4 + 3];
    const k = a > 0 ? 255 / a : 0;
    out.px[p * 4] = Math.min(255, Math.round(result[p * 4] * k));
    out.px[p * 4 + 1] = Math.min(255, Math.round(result[p * 4 + 1] * k));
    out.px[p * 4 + 2] = Math.min(255, Math.round(result[p * 4 + 2] * k));
    out.px[p * 4 + 3] = Math.min(255, Math.round(a));
  }
  return out;
}

module.exports = { decodePng, encodePng, resize };
