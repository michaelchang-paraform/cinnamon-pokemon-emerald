import { inflateSync } from 'node:zlib';

// reads a non-interlaced indexed PNG (bit depth 1 to 8): { width, height, palette: ['rrggbb'], index: Uint8Array, chunks }
export function readIndexedPng(buf) {
  let at = 8;
  const chunks = [];
  const idat = [];
  let width = 0, height = 0, depth = 0, colorType = 0, palette = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data });
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i < data.length; i += 3) palette.push(data.subarray(i, i + 3).toString('hex'));
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  if (colorType !== 3) throw new Error(`not an indexed PNG (color type ${colorType})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * depth) / 8);
  const rows = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x > 0 ? out[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const index = new Uint8Array(width * height);
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = rows[y * stride + Math.floor(x / perByte)];
      const shift = 8 - depth * ((x % perByte) + 1);
      index[y * width + x] = (byte >> shift) & mask;
    }
  }
  return { width, height, depth, palette, index, chunks };
}
