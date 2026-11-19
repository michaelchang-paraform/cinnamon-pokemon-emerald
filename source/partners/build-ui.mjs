// Builds extension-partners/partners-dex.css (stats, learnsets, moves, abilities, natures) and partners-ui.css (the
// Emerald summary and naming screen graphics, composed from pret/pokeemerald tilemaps). Run ./download.sh first,
// then: node source/partners/build-ui.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndexedPng } from './png-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'extension-partners');
const PRET = join(HERE, 'download', 'pret');
const SRC = join(PRET, 'src');
const MAX_NUM = 386;
const MAX_MOVE = 354;

const require = createRequire(join(ROOT, 'helper', 'package.json'));
const { Dex } = require('pokemon-showdown');
const dex = Dex.forGen(3);

// Gen 3 type order, as the summary screen's type icons are indexed
const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
const TYPE_FILES = ['normal', 'fight', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'mystery', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
const GROWTH = ['GROWTH_MEDIUM_FAST', 'GROWTH_ERRATIC', 'GROWTH_FLUCTUATING', 'GROWTH_MEDIUM_SLOW', 'GROWTH_FAST', 'GROWTH_SLOW'];
// Gen 3 nature order: index = personality % 25
const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax', 'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];

const text = (file) => readFileSync(join(SRC, file), 'utf8');
const gbaString = (body) => [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('').replace(/\\n/g, '\n').replace(/\\p|\\l/g, '\n').replace(/é/g, 'é');

// MOVE_X constant -> move number, from the order of gMoveNames
const moveNames = {};
const moveNum = {};
[...text('move_names.h').matchAll(/\[(MOVE_[A-Z0-9_]+)\]\s*=\s*_\("([^"]*)"\)/g)].forEach((m, i) => {
  moveNum[m[1]] = i;
  moveNames[i] = m[2];
});
const descBody = {};
for (const m of text('move_descriptions.h').matchAll(/static const u8 (s\w+Description)\[\] = _\(([\s\S]*?)\);/g)) descBody[m[1]] = gbaString(m[2]);
const moveDesc = {};
for (const m of text('move_descriptions.h').matchAll(/\[(MOVE_[A-Z0-9_]+) - 1\]\s*=\s*(s\w+)/g)) moveDesc[moveNum[m[1]]] = descBody[m[2]] ?? '';

const abilityText = text('abilities.h');
const abilityDescBody = {};
for (const m of abilityText.matchAll(/static const u8 (s\w+Description)\[\] = _\("([^"]*)"\)/g)) abilityDescBody[m[1]] = m[2];
const abilityName = {};
for (const m of abilityText.split('gAbilityNames')[1].split('gAbilityDescriptionPointers')[0].matchAll(/\[(ABILITY_[A-Z0-9_]+)\]\s*=\s*_\("([^"]*)"\)/g)) abilityName[m[1]] = m[2];
const abilityDesc = {};
for (const m of abilityText.split('gAbilityDescriptionPointers')[1].matchAll(/\[(ABILITY_[A-Z0-9_]+)\]\s*=\s*(s\w+)/g)) abilityDesc[m[1]] = abilityDescBody[m[2]] ?? '';
const abilityKeys = Object.keys(abilityName);
const abilityConst = (name) => abilityKeys.find((k) => k.slice(8).replace(/_/g, '') === name.toUpperCase().replace(/[^A-Z0-9]/g, ''));

const speciesInfo = {};
for (const block of text('species_info.h').split(/\n\s*\[SPECIES_/).slice(1)) {
  const id = block.slice(0, block.indexOf(']')).toLowerCase().replace(/_/g, '');
  const growth = /\.growthRate\s*=\s*(GROWTH_\w+)/.exec(block)?.[1];
  const gender = /\.genderRatio\s*=\s*([^,\n]+),/.exec(block)?.[1].trim();
  speciesInfo[id] = { growth, gender };
}
function genderThreshold(spec) {
  if (!spec || spec === 'MON_GENDERLESS') return 255;
  if (spec === 'MON_MALE') return 0;
  if (spec === 'MON_FEMALE') return 254;
  const pct = Number(/PERCENT_FEMALE\(([\d.]+)\)/.exec(spec)?.[1]);
  return Math.min(254, Math.floor((pct * 255) / 100));
}

const abilities = [];
const abilityIndex = {};
function ability(name) {
  if (!name) return -1;
  if (abilityIndex[name] !== undefined) return abilityIndex[name];
  const key = abilityConst(name);
  abilityIndex[name] = abilities.length;
  abilities.push([key ? abilityName[key] : name.toUpperCase(), key ? abilityDesc[key] : '']);
  return abilityIndex[name];
}

const stats = [];
const learn = [];
for (const s of dex.species.all()) {
  if (!s.exists || s.forme || s.num < 1 || s.num > MAX_NUM) continue;
  const info = speciesInfo[s.id] ?? {};
  const b = s.baseStats;
  stats[s.num] = [b.hp, b.atk, b.def, b.spa, b.spd, b.spe, TYPES.indexOf(s.types[0]), TYPES.indexOf(s.types[1] ?? s.types[0]), ability(s.abilities[0]), ability(s.abilities[1]), genderThreshold(info.gender), Math.max(0, GROWTH.indexOf(info.growth))];
  const list = [];
  for (const [id, sources] of Object.entries(dex.data.Learnsets[s.id]?.learnset ?? {})) {
    const move = dex.moves.get(id);
    if (!move.exists || move.num > MAX_MOVE) continue;
    for (const src of sources) if (/^3L\d+$/.test(src)) list.push([Number(src.slice(2)), move.num]);
  }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  learn[s.num] = list.flat();
}

const moves = [];
for (const m of dex.moves.all()) {
  if (!m.exists || m.num < 1 || m.num > MAX_MOVE) continue;
  moves[m.num] = [moveNames[m.num] ?? m.name.toUpperCase(), TYPES.indexOf(m.type), m.pp, m.basePower || 0, m.accuracy === true ? 0 : m.accuracy, moveDesc[m.num] ?? ''];
}

const natureData = NATURES.map((name) => {
  const n = dex.natures.get(name);
  const order = ['atk', 'def', 'spe', 'spa', 'spd'];
  return [name.toUpperCase(), n.plus ? order.indexOf(n.plus) : -1, n.minus ? order.indexOf(n.minus) : -1];
});

const dexData = { st: stats, ls: learn, mv: moves, ab: abilities, na: natureData, ty: TYPES.map((t) => (t === '???' ? '???' : t.toUpperCase())) };

// graphics
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
// 8 bpp indexed PNG; colors is an array of 'rrggbb' or null (transparent), at most 256
function paletted(width, height, pixels, colors) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixels[y * width + x];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  const plte = Buffer.from(colors.map((c) => (c ? [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)) : [0, 0, 0])).flat());
  const trns = Buffer.from(colors.map((c) => (c ? 255 : 0)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// renders a function (x, y) -> 'rrggbb' | null into an indexed PNG
function draw(width, height, color) {
  const colors = [null];
  const lookup = new Map([[null, 0]]);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = color(x, y) ?? null;
      if (!lookup.has(c)) {
        lookup.set(c, colors.length);
        colors.push(c);
      }
      pixels[y * width + x] = lookup.get(c);
    }
  }
  if (colors.length > 256) throw new Error('too many colors');
  return paletted(width, height, pixels, colors);
}
function spritePng(file) {
  const img = readIndexedPng(readFileSync(file));
  return draw(img.width, img.height, (x, y) => {
    const v = img.index[y * img.width + x] & 15;
    return v ? img.palette[v] : null;
  });
}
function readJasc(path) {
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(3).map((line) => line.trim().split(/\s+/).map((v) => Number(v).toString(16).padStart(2, '0')).join(''));
}
// a 32 tile wide BG tilemap over a tile sheet: (x, y) -> color or null
function tilemapLayer(tiles, palettes, map) {
  const tw = tiles.width / 8;
  return (x, y) => {
    const e = map[(y >> 3) * 32 + (x >> 3)];
    if (e === undefined) return null;
    const t = e & 0x3ff;
    const pal = e >> 12;
    let px = x & 7, py = y & 7;
    if (e & 0x400) px = 7 - px;
    if (e & 0x800) py = 7 - py;
    const tx = (t % tw) * 8 + px, ty = Math.floor(t / tw) * 8 + py;
    if (ty >= tiles.height) return null;
    const v = tiles.index[ty * tiles.width + tx] & 15;
    // palettes the screen loads at runtime (text windows) fall back to the first one
    return v ? (palettes[pal] ?? palettes[0])[v] ?? null : null;
  };
}
const words = (buf) => Array.from({ length: buf.length / 2 }, (_, i) => buf.readUInt16LE(i * 2));
const stack = (...layers) => (x, y) => {
  for (const layer of layers) {
    const c = layer(x, y);
    if (c) return c;
  }
  return null;
};

const images = {};
const SUM = join(PRET, 'summary');
const sumTiles = readIndexedPng(readFileSync(join(SUM, 'tiles.png')));
const sumPalettes = Array.from({ length: 8 }, (_, p) => sumTiles.palette.slice(p * 16, p * 16 + 16));
const infoMap = words(readFileSync(join(SUM, 'page_info.bin')));
// the page dots in the top bar, as the game draws them for 3 pages (contest moves left out)
function withDots(map, page) {
  const out = map.slice();
  for (let i = 0; i < 4; i++) {
    let top, bottom;
    if (i > 2) [top, bottom] = [[0x4a, 0x4a], [0x5a, 0x5a]];
    else if (i < page) [top, bottom] = [[0x46, 0x47], [0x56, 0x57]];
    else if (i === page) [top, bottom] = i !== 2 ? [[0x41, 0x42], [0x51, 0x52]] : [[0x4b, 0x4c], [0x5b, 0x5c]];
    else if (i !== 2) [top, bottom] = [[0x43, 0x44], [0x53, 0x54]];
    else [top, bottom] = [[0x48, 0x49], [0x58, 0x59]];
    out[11 + i * 2] = top[0];
    out[12 + i * 2] = top[1];
    out[32 + 11 + i * 2] = bottom[0];
    out[32 + 12 + i * 2] = bottom[1];
  }
  return out;
}
const pages = [
  ['sum-info', null, 0],
  ['sum-skills', 'page_skills.bin', 1],
  ['sum-moves', 'page_battle_moves.bin', 2],
  ['sum-moves-select', 'page_battle_moves.bin', 2],
];
// SetMonPicBackgroundPalette: a shiny mon's 8x8 tile picture frame (BG3 tiles 1..8, 4..11) uses palette 5
function shinyFrame(map) {
  const out = map.slice();
  for (let ty = 4; ty < 12; ty++) for (let tx = 1; tx < 9; tx++) out[ty * 32 + tx] = (out[ty * 32 + tx] & 0x0fff) | (5 << 12);
  return out;
}
for (const [name, file, page, shiny] of pages.flatMap((p) => [p, [`${p[0]}-shiny`, p[1], p[2], true]])) {
  const base = tilemapLayer(sumTiles, sumPalettes, shiny ? shinyFrame(withDots(infoMap, page)) : withDots(infoMap, page));
  let over = () => null;
  if (file) {
    const layer = tilemapLayer(sumTiles, sumPalettes, words(readFileSync(join(SUM, file))));
    // the EFFECT box at the bottom left only slides in while a move is selected
    over = name.startsWith('sum-moves') && !name.startsWith('sum-moves-select') ? (x, y) => (x < 80 ? null : layer(x, y)) : layer;
  }
  images[name] = draw(240, 160, stack(over, base));
}
for (const name of ['a_button', 'b_button']) images[name] = spritePng(join(SUM, `${name}.png`));
TYPE_FILES.forEach((file, i) => (images[`type${i}`] = spritePng(join(PRET, 'types', `${file}.png`))));

const NAM = join(PRET, 'naming');
const namTiles = readIndexedPng(readFileSync(join(NAM, 'menu.png')));
const namPalettes = ['menu', 'page_swap_upper', 'page_swap_lower', 'page_swap_others', 'buttons', 'cursor'].map((p) => readJasc(join(NAM, `${p}.pal`)));
const keyboardPal = readJasc(join(NAM, 'keyboard.pal'));
namPalettes[10] = keyboardPal;
const namBg = tilemapLayer(namTiles, namPalettes, words(readFileSync(join(NAM, 'background.bin'))));
for (const [name, file, fill] of [['nam-upper', 'keyboard_upper.bin', 13], ['nam-lower', 'keyboard_lower.bin', 14], ['nam-others', 'keyboard_symbols.bin', 15]]) {
  const kb = tilemapLayer(namTiles, namPalettes, words(readFileSync(join(NAM, file))));
  // keyboard window: 19x8 tiles at (3, 10), filled with the page color
  const win = (x, y) => (x >= 24 && x < 176 && y >= 80 && y < 144 ? keyboardPal[fill] : null);
  images[name] = draw(240, 160, (x, y) => stack(win, kb, namBg)(x, y) ?? '000000');
}
for (const name of ['cursor', 'input_arrow', 'underscore', 'back_button', 'ok_button', 'page_swap_frame', 'page_swap_button', 'page_swap_upper', 'page_swap_lower', 'page_swap_others']) {
  images[`nam-${name}`] = spritePng(join(NAM, `${name}.png`));
}

// player healthbox (battle_interface): the box art, and the HP capsule (cap, HP tag, six full segments) at full HP
const BAT = join(PRET, 'battle');
const box = readIndexedPng(readFileSync(join(BAT, 'healthbox_singles_player.png')));
images['hb-box'] = draw(106, 38, (x, y) => {
  const v = box.index[y * box.width + x];
  return v ? box.palette[v] : null;
});
const hpbar = readIndexedPng(readFileSync(join(BAT, 'hpbar.png')));
const HP_TILES = [0, 1, 2, 11, 11, 11, 11, 11, 11];
images['hb-hp'] = draw(72, 8, (x, y) => {
  const tile = HP_TILES[x >> 3];
  const v = hpbar.index[y * hpbar.width + tile * 8 + (x & 7)];
  return v ? hpbar.palette[v] : null;
});
// the shiny sparkle's ANIM_TAG_GOLD_STARS sheet: a 16x16 star at tile 0, 8x8 stars at tiles 4 and 5
if (existsSync(join(BAT, 'gold_stars.png'))) images['gold-stars'] = spritePng(join(BAT, 'gold_stars.png'));
dexData.hb = { ink: box.palette[1], shadow: box.palette[3], male: box.palette[11], female: box.palette[10], exp: box.palette[11] };

// FONT_SMALL and FONT_NORMAL: 2 bpp glyphs in 16x16 cells, codes 0x000-0x1FF (0x100 + n is extra symbol n), and
// their advance widths; the charmap names the characters both can draw, control characters stand for the symbols
function glyphFont(file, table) {
  const img = readIndexedPng(readFileSync(join(PRET, 'fonts', file)));
  const bits = Buffer.alloc((512 * 256) / 4);
  for (let code = 0; code < 512; code++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const v = img.index[((code >> 4) * 16 + y) * img.width + (code & 15) * 16 + x];
        const at = code * 256 + y * 16 + x;
        bits[at >> 2] |= v << ((at & 3) * 2);
      }
    }
  }
  const w = [...text('fonts.c').split(table)[1].split('};')[0].matchAll(/\d+/g)].map(Number).slice(0, 512);
  return { bits: bits.toString('base64'), w };
}
const charmap = {};
for (const line of readFileSync(join(ROOT, 'source', 'battle', 'download', 'pokeemerald', 'charmap.txt'), 'utf8').split(/\r?\n/)) {
  const m = /^'(.)'\s*=\s*([0-9A-F]{2})\s*$/.exec(line);
  if (m && charmap[m[1]] === undefined) charmap[m[1]] = parseInt(m[2], 16);
}
Object.assign(charmap, { '\u0001': 0x105, '\u0002': 0x106, '\u0003': 0x107, '\u0004': 0x108, '\u0005': 0x34 });
dexData.sf = { ...glyphFont('latin_small.png', 'gFontSmallLatinGlyphWidths'), c: charmap, lv: 0x105 };
dexData.nf = glyphFont('latin_normal.png', 'gFontNormalLatinGlyphWidths');
// summary text colors: PP palette (text_pp.pal loaded at palette 8 from entry 1) and the move selector colors
dexData.pp = readJasc(join(PRET, 'battle', 'text_pp.pal'));
{
  const sel = readIndexedPng(readFileSync(join(SUM, 'move_select.png')));
  dexData.ms = sel.palette;
}

const chunks = [];
const index = {};
let offset = 0;
for (const [name, png] of Object.entries(images)) {
  index[name] = [offset, png.length];
  chunks.push(png);
  offset += png.length;
}
dexData.ui = index;

const outputs = [
  ['partners-dex.css', `.pkp-data { --pkp-dex: "${Buffer.from(JSON.stringify(dexData)).toString('base64')}"; }\n`],
  ['partners-ui.css', `.pkp-data { --pkp-ui: "${Buffer.concat(chunks).toString('base64')}"; }\n`],
];
for (const [name, css] of outputs) writeFileSync(join(OUT_DIR, name), css);
console.log(`species ${stats.filter(Boolean).length}, moves ${moves.filter(Boolean).length}, abilities ${abilities.length}, images ${Object.keys(images).length}`);
const missingDesc = moves.filter((m) => m && !m[5]).length;
if (missingDesc) console.log(`moves without description: ${missingDesc}`);
for (const [name, css] of outputs) console.log(`${name} ${css.length}`);
