import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function rgba(color) {
  if (!color) return [0, 0, 0, 0];
  const hex = color.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
}

export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgba(pixel(x, y));
      const at = y * (width * 4 + 1) + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const dataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;

// 9-slice text box: layers[0] is the outer ring, fill is the centre
export function framePng({ layers, fill, size = 24, radius = 4 }) {
  return encodePng(size, size, (x, y) => {
    const cx = x + 0.5, cy = y + 0.5;
    const dx = Math.max(radius - cx, 0, cx - (size - radius));
    const dy = Math.max(radius - cy, 0, cy - (size - radius));
    const depth = dx > 0 && dy > 0 ? radius - Math.hypot(dx, dy) : Math.min(cx, size - cx, cy, size - cy);
    if (depth < 0) return null;
    return layers[Math.floor(depth)] ?? fill;
  });
}

export function gridPng(rows, palette) {
  return encodePng(rows[0].length, rows.length, (x, y) => palette[rows[y][x]] ?? null);
}
