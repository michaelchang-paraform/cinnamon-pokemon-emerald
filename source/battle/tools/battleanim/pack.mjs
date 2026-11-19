// Turns the move recordings into the page's data: per move (and per general or status animation, by name) the
// frames from each side, the sound ids and cry
// modes by name, and for every sprite sheet and palette tag the frames use, the sheet's pixel indices in tile
// order (one byte per pixel) and its 16 colours (RGB555); and every BG layer image the frames show, once
// (deflated (palette << 4 | index) bytes). The display registers ("v"), layer images ("l"), real palettes ("P")
// and scanline values ("h") are written only on the frames where they change, starting from "#v" and nothing
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decodePng } from '../../lib/gba.mjs';

const CRY_MODES = { HIGH_PITCH: 'high_pitch', ECHO_START: 'echo', ROAR_1: 'roar', GROWL_1: 'growl', FAINT: 'faint', WEAK: 'weak' };

// a frame without the parts that are at rest: a battler with no offset, flag or turn, no changed palette, no scroll
function compactFrame(frame) {
  const out = {};
  if (frame.s.length) out.s = frame.s;
  const battlers = frame.b.map((b) => (b[2] === 2 && b[3] === 256 && !b[4] && !b[5] && b[6] === 256 ? [b[0], b[1], 0] : b));
  if (battlers.some((b) => b[0] || b[1] || b[2])) out.b = battlers;
  if (frame.p.length) out.p = frame.p;
  if (frame.g.some(Boolean)) out.g = frame.g;
  return out;
}

// display features the page does not draw: an affine BG mode
const undrawn = (v) => (v[0] & 7) !== 0;

export function packMoveAnims({ root, runs, effects = [], moveIds }) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const se = [];
  for (const m of read('include/constants/songs.h').matchAll(/^#define (SE_\w+)\s+(\d+)/gm)) se[Number(m[2])] = m[1];
  const cry = {};
  for (const m of read('include/constants/sound.h').matchAll(/^#define CRY_MODE_(\w+)\s+(\d+)/gm)) cry[m[2]] = CRY_MODES[m[1]] ?? null;
  const moves = {};
  const status = {};
  const tags = new Set();
  const pals = new Set();
  // a script that never ends here (Pokeblock Throw waits on the Safari Zone) is left out, like one that failed
  const kept = [...runs.filter((run) => moveIds[run.m]), ...effects].filter((run) => !run.fail && !run.stuck);
  const counts = {};
  for (const run of kept) counts[JSON.stringify(run.f[0].v)] = (counts[JSON.stringify(run.f[0].v)] ?? 0) + 1;
  const baseVideo = Object.entries(counts).sort((p, q) => q[1] - p[1])[0]?.[0] ?? '[]';
  const layers = [];
  const layerIds = new Map();
  const partial = new Set();
  for (const run of kept) {
    const id = run.name ?? moveIds[run.m];
    const images = run.L.map(([w, h, data]) => {
      const key = `${w}:${data}`;
      if (!layerIds.has(key)) layerIds.set(key, layers.push([w, h, deflateRawSync(Buffer.from(data, 'base64'), { level: 9 }).toString('base64')]) - 1);
      return layerIds.get(key);
    });
    let last = { v: baseVideo, l: '[-1,-1,-1]', P: '[]', h: '0' };
    const frames = run.f.map((frame) => {
      const out = compactFrame(frame);
      const now = { v: JSON.stringify(frame.v), l: JSON.stringify(frame.l.map((i) => (i < 0 ? -1 : images[i]))), P: JSON.stringify(frame.P), h: JSON.stringify(frame.h ?? 0) };
      for (const key of ['v', 'l', 'P', 'h']) if (now[key] !== last[key]) out[key] = JSON.parse(now[key]);
      if (undrawn(frame.v)) partial.add(id);
      last = now;
      return out;
    });
    // cry modes the page plays as one call ('roar' covers both halves), so the second halves drop out here
    const sounds = run.snd.filter(([, kind, value]) => kind === 0 || cry[value]).map(([frame, kind, value, pan]) => [frame, kind ? `cry:${cry[value]}` : se[value] ?? `SE_${value}`, pan]);
    ((run.name ? status : moves)[id] ??= [null, null])[run.a] = { f: frames, snd: sounds };
    for (const frame of run.f)
      for (const sprite of frame.s) {
        tags.add(sprite[0]);
        pals.add(sprite[7]);
      }
  }
  const tagNames = {};
  for (const m of read('include/constants/battle_anim.h').matchAll(/^#define ANIM_TAG_(\w+)\s+\(ANIM_SPRITES_START \+ (\d+)\)/gm)) tagNames[10000 + Number(m[2])] = m[1];
  const data = read('src/data/battle_anim.h');
  const graphics = read('src/graphics.c');
  const rawRules = read('graphics_file_rules.mk');
  const vars = Object.fromEntries([...rawRules.matchAll(/^(\w+)\s*:=\s*(\S+)\s*$/gm)].map((m) => [m[1], m[2]]));
  const rules = rawRules.replace(/\$\((\w+)\)/g, (_, name) => vars[name] ?? '');
  const gfxPath = (symbol) => new RegExp(`\\b${symbol}\\[\\] = INCGFX_U32\\("([^"]+)"`).exec(graphics)?.[1] ?? null;
  const pictures = Object.fromEntries([...data.split('gBattleAnimPicTable[]')[1].split('};')[0].matchAll(/\{(\w+), (0x[0-9A-Fa-f]+), ANIM_TAG_(\w+)\}/g)].map((m) => [m[3], { gfx: m[1], size: Number(m[2]) }]));
  const palettes = Object.fromEntries([...data.split('gBattleAnimPaletteTable[]')[1].split('};')[0].matchAll(/\{(\w+), ANIM_TAG_(\w+)\}/g)].map((m) => [m[2], m[1]]));
  // a sheet the build concatenates from parts (graphics_file_rules.mk) is their tiles in order
  const tilesOf = (png) => {
    const base = png.replace(/\.(png|4bpp)$/, '');
    const parts = new RegExp(`^${base.replace(/[/.]/g, '\\$&')}\\.4bpp:((?:\\s*\\S+\\.4bpp\\s*\\\\?\\n?)+)`, 'm').exec(rules);
    const files = parts ? [...parts[1].matchAll(/(\S+)\.4bpp/g)].map((m) => `${m[1]}.png`) : [`${base}.png`];
    const out = [];
    for (const file of files) {
      const img = decodePng(join(root, file));
      for (let ty = 0; ty < img.height / 8; ty++)
        for (let tx = 0; tx < img.width / 8; tx++)
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out.push(img.pixels[(ty * 8 + y) * img.width + tx * 8 + x] & 15);
    }
    return out;
  };
  const rgb555 = ([r, g, b]) => (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
  const colorsOf = (path) => {
    if (path.endsWith('.pal')) {
      const lines = read(path).split(/\r?\n/).slice(3).filter((l) => l.trim());
      return lines.slice(0, 16).map((l) => rgb555(l.trim().split(/\s+/).map(Number)));
    }
    return decodePng(join(root, path)).palette.slice(0, 16).map(rgb555);
  };
  const sheets = {};
  for (const tag of tags) {
    const pic = pictures[tagNames[tag]];
    const path = pic && gfxPath(pic.gfx);
    if (!path) continue;
    sheets[tag] = Buffer.from(tilesOf(path).slice(0, pic.size * 2)).toString('base64');
  }
  const colors = {};
  for (const tag of pals) {
    const path = palettes[tagNames[tag]] && gfxPath(palettes[tagNames[tag]]);
    if (path && existsSync(join(root, path))) colors[tag] = colorsOf(path);
  }
  return { moves, status, sheets, colors, layers, video: JSON.parse(baseVideo), bgOnly: [...partial].sort() };
}
