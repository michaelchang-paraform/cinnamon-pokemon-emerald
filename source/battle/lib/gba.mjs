// Indexed PNG decode, GBA tile and tilemap rendering, and PNG encode for the battle asset build.
import { readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

export function decodePng(path) {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, palette = [], trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    else if (kind === 'PLTE') { for (let i = 0; i < data.length; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]); }
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (type !== 3 && type !== 0) throw new Error(`${path}: color type ${type} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = depth;
  const stride = Math.ceil((width * bpp) / 8);
  const out = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const bpx = Math.max(1, bpp >> 3);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpx ? line[i - bpx] : 0, b = prev[i], c = i >= bpx ? prev[i - bpx] : 0;
      if (f === 1) line[i] = (line[i] + a) & 255;
      else if (f === 2) line[i] = (line[i] + b) & 255;
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    }
    for (let x = 0; x < width; x++) {
      const bit = x * bpp;
      const byte = line[bit >> 3];
      out[y * width + x] = bpp === 8 ? byte : (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
    }
    prev = line;
  }
  return { width, height, depth, palette, trns, pixels: out };
}

export function readPal(path) {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  return lines.slice(3).map((l) => l.trim().split(/\s+/).map(Number).slice(0, 3));
}

export function readBin(path) {
  const b = readFileSync(path);
  const out = [];
  for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readUInt16LE(i));
  return out;
}

// tile n of a sheet, as 64 palette indices
export function tile(img, n) {
  const per = img.width / 8;
  const tx = (n % per) * 8, ty = Math.floor(n / per) * 8;
  const t = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) t[y * 8 + x] = img.pixels[(ty + y) * img.width + tx + x];
  return t;
}

export class Canvas {
  constructor(width, height) { this.width = width; this.height = height; this.rgba = new Uint8Array(width * height * 4); }
  set(x, y, rgb, a = 255) { if (x < 0 || y < 0 || x >= this.width || y >= this.height) return; const i = (y * this.width + x) * 4; this.rgba[i] = rgb[0]; this.rgba[i + 1] = rgb[1]; this.rgba[i + 2] = rgb[2]; this.rgba[i + 3] = a; }
  drawTile(t, x0, y0, colors, { hflip = false, vflip = false, transparent0 = true } = {}) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const v = t[(vflip ? 7 - y : y) * 8 + (hflip ? 7 - x : x)];
      if ((v & 15) === 0 && transparent0) continue;
      this.set(x0 + x, y0 + y, colors(v));
    }
  }
  crop(x0, y0, w, h) { const c = new Canvas(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = ((y0 + y) * this.width + x0 + x) * 4, d = (y * w + x) * 4; for (let k = 0; k < 4; k++) c.rgba[d + k] = this.rgba[s + k]; } return c; }
}

// tilemap of u16 entries (tile 0-9, hflip 10, vflip 11, palette 12-15), mapWidth tiles wide
export function drawMap(canvas, sheet, map, mapWidth, palettes, { x0 = 0, y0 = 0, tileBase = 0, transparent0 = true } = {}) {
  map.forEach((e, i) => {
    const n = (e & 0x3ff) - tileBase;
    const pal = (e >> 12) & 15;
    if (n < 0 || n >= (sheet.width / 8) * (sheet.height / 8)) return;
    canvas.drawTile(tile(sheet, n), x0 + (i % mapWidth) * 8, y0 + Math.floor(i / mapWidth) * 8, (v) => palettes[pal * 16 + (v & 15)] ?? [255, 0, 255], { hflip: !!(e & 0x400), vflip: !!(e & 0x800), transparent0 });
  });
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; }
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function encodeRgba(canvas) {
  const { width, height, rgba } = canvas;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const h = Buffer.alloc(13); h.writeUInt32BE(width, 0); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', h), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// indexed 4-bit PNG, index 0 transparent
export function encodeIndexed(width, height, pixels, palette) {
  const stride = Math.ceil(width / 2);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = pixels[y * width + x] & 15;
    raw[y * (stride + 1) + 1 + (x >> 1)] |= x & 1 ? v : v << 4;
  }
  const h = Buffer.alloc(13); h.writeUInt32BE(width, 0); h.writeUInt32BE(height, 4); h[8] = 4; h[9] = 3;
  const pal = Buffer.alloc(16 * 3); palette.slice(0, 16).forEach((c, i) => { pal[i * 3] = c[0]; pal[i * 3 + 1] = c[1]; pal[i * 3 + 2] = c[2]; });
  return Buffer.concat([SIG, chunk('IHDR', h), chunk('PLTE', pal), chunk('tRNS', Buffer.from([0])), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
