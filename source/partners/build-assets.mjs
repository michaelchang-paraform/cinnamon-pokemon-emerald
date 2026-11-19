// Builds extension-partners/partners-{data,icons,fronts}.css: Gen 3 party icons, front pics with shiny palettes and
// trainer overworld sprites (pret/pokeemerald, PokeAPI fronts as a fallback) and a compact evolution table
// from the helper's pokemon-showdown package. Run ./download.sh first, then: node source/partners/build-assets.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndexedPng } from './png-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'extension-partners');
const PRET = join(HERE, 'download', 'pret');
const FRONTS = join(ROOT, 'source', 'battle', 'download', 'pokeapi-sprites', 'sprites', 'pokemon', 'versions', 'generation-iii', 'emerald');
const MAX_NUM = 386;

const require = createRequire(join(ROOT, 'helper', 'package.json'));
const { Dex } = require('pokemon-showdown');
const dex = Dex.forGen(3);

// [id, name, file, group list]: each group is [label, parts], each part is [palette indices, first row, last row]
const TRAINERS = [
  ['brendan', 'BRENDAN', 'brendan_walking', [['Hat', [[[5, 9, 14], 0, 17]]], ['Hat band', [[[10, 11], 0, 17]]], ['Clothes', [[[8, 10, 12, 13], 18, 31]]]]],
  ['may', 'MAY', 'may_walking', [['Bandana', [[[5, 9, 10, 11, 14], 0, 16]]], ['Hair', [[[7, 8], 0, 22]]], ['Clothes', [[[5, 6, 10, 11, 13], 17, 31]]]]],
  ['youngster', 'JOEY', 'youngster', [['Cap', [[[8, 9, 10, 12], 0, 18]]], ['Hair', [[[13], 0, 21]]], ['Clothes', [[[8, 9, 10, 14], 19, 31]]]]],
  ['lass', 'HALEY', 'lass', [['Hair', [[[5, 6, 7], 0, 22]]], ['Clothes', [[[5, 6, 7, 11, 12, 13, 14], 23, 31]]]]],
  ['bug_catcher', 'RICK', 'bug_catcher', [['Hat', [[[2, 3, 11, 13], 0, 15], [[11, 13], 16, 18]]], ['Hair', [[[9, 10], 16, 18]]], ['Clothes', [[[8, 9, 10], 19, 31]]]]],
  ['hiker', 'CLARK', 'hiker', [['Hat', [[[5, 6, 7], 0, 18]]], ['Beard', [[[12, 13], 16, 21]]], ['Clothes', [[[8, 9, 10, 12, 13], 22, 31]]]]],
  ['black_belt', 'NOB', 'black_belt', [['Headband', [[[5, 7, 14], 15, 17]]], ['Hair', [[[11, 12, 13], 0, 16]]], ['Gi', [[[5, 6, 7, 8, 9, 10, 14], 18, 31]]]]],
  ['hex_maniac', 'TAMMY', 'hex_maniac', [['Hair', [[[12, 13], 0, 21]]], ['Robe', [[[6, 7, 8, 9, 10], 22, 31]]]]],
  ['aqua_grunt', 'GRUNT', 'team_aqua_aqua_member_m', [['Bandana', [[[5, 6, 7, 11, 14], 0, 18]]], ['Clothes', [[[5, 6, 7, 11, 12, 13, 14], 19, 31]]]]],
  ['magma_grunt', 'GRUNT', 'team_magma_magma_member_m', [['Hood', [[[8, 9, 10], 0, 17]]], ['Clothes', [[[8, 9, 10, 12, 13], 18, 31]]]]],
];
// more trainer classes with a 16x32 overworld sheet: [id, label, default name, sheet]; Cap, Hair and Clothes come from autoGroups
const MORE_TRAINERS = [
  ['aqua_grunt_f', 'Aqua Grunt F', 'GRUNT', 'team_aqua_aqua_member_f'], ['magma_grunt_f', 'Magma Grunt F', 'GRUNT', 'team_magma_magma_member_f'],
  ['beauty', 'Beauty', 'JESSICA', 'beauty'], ['camper', 'Camper', 'ETHAN', 'camper'], ['picnicker', 'Picnicker', 'DIANA', 'picnicker'],
  ['expert_m', 'Expert M', 'FREDRICK', 'expert_m'], ['expert_f', 'Expert F', 'SHELBY', 'expert_f'], ['fisherman', 'Fisherman', 'ELLIOT', 'fisherman'],
  ['gentleman', 'Gentleman', 'WALTER', 'gentleman'], ['pokefan_m', 'Pok\u00e9fan M', 'ISAAC', 'pokefan_m'], ['pokefan_f', 'Pok\u00e9fan F', 'ISABEL', 'pokefan_f'],
  ['psychic', 'Psychic', 'EDWARD', 'psychic_m'], ['rich_boy', 'Rich Boy', 'WINSTON', 'rich_boy'], ['runner_m', 'Runner M', 'HUEY', 'running_triathlete_m'],
  ['runner_f', 'Runner F', 'KATELYN', 'running_triathlete_f'], ['sailor', 'Sailor', 'EDMOND', 'sailor'], ['school_kid', 'School Kid', 'JERRY', 'school_kid_m'],
  ['swimmer_m', 'Swimmer M', 'TONY', 'swimmer_m'], ['swimmer_f', 'Swimmer F', 'JENNY', 'swimmer_f'], ['twins', 'Twins', 'AMY', 'twin'],
];

// Cap (above the face), Hair (beside the face) and Clothes (below it) from the down-facing frame: palette indices per
// row band, skipping skin and outline; a band that matches the one beside the face is hair, not a cap
function autoGroups(img) {
  const hsl = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  };
  const kind = img.palette.map((hex) => {
    const [h, s, l] = hsl(hex);
    if (l < 0.2) return 'ink';
    if (h >= 8 && h <= 45 && s >= 0.2 && l >= 0.55 && l <= 0.92) return 'skin';
    if (l > 0.9 && s < 0.2) return 'white';
    return 'paint';
  });
  const at = (x, y) => img.index[y * img.width + x];
  const rowsWith = (test) => Array.from({ length: 32 }, (_, y) => y).filter((y) => Array.from({ length: 16 }, (_, x) => at(x, y)).some((i) => i && test(i)));
  const skin = rowsWith((i) => kind[i] === 'skin').filter((y) => y < 26);
  if (!skin.length) return [['Clothes', [[[...new Set(Array.from({ length: 512 }, (_, n) => at(n % 16, n >> 4)))].filter((i) => i && kind[i] !== 'ink'), 0, 31]]]];
  const faceTop = skin[0];
  let faceBottom = faceTop;
  // a face is at most 9 rows; skin further down the same run is neck, hands or legs
  for (const y of skin) if (y <= faceBottom + 1 && y <= faceTop + 8) faceBottom = y;
  const band = (y0, y1, allowWhite) => {
    const out = new Set();
    for (let y = y0; y <= y1; y++) for (let x = 0; x < 16; x++) {
      const i = at(x, y);
      if (i && (kind[i] === 'paint' || (allowWhite && kind[i] === 'white'))) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  };
  const top = faceTop > 0 ? band(0, faceTop - 1, true) : [];
  const side = band(faceTop, faceBottom, false);
  const body = band(faceBottom + 1, 31, true);
  const groups = [];
  const sameAsSide = top.length && side.length && top.every((i) => side.includes(i));
  if (sameAsSide) groups.push(['Hair', [[[...new Set([...top, ...side])], 0, faceBottom]]]);
  else {
    if (top.length) groups.push(['Cap', [[top, 0, faceTop - 1]]]);
    const hair = side.filter((i) => !top.includes(i));
    if (hair.length) groups.push(['Hair', [[hair, faceTop, faceBottom]]]);
  }
  if (body.length) groups.push(['Clothes', [[body, faceBottom + 1, 31]]]);
  return groups;
}

const TRAINER_LABELS = { brendan: 'Brendan', may: 'May', youngster: 'Youngster', lass: 'Lass', bug_catcher: 'Bug Catcher', hiker: 'Hiker', black_belt: 'Black Belt', hex_maniac: 'Hex Maniac', aqua_grunt: 'Aqua Grunt', magma_grunt: 'Magma Grunt' };
// walking sheet frames: 0 faces down, 3 and 4 walk down
const TRAINER_FRAMES = [0, 3, 4];

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
function readJasc(path) {
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(3).map((line) => line.trim().split(/\s+/).map(Number));
}

// a 4 bpp indexed PNG with the game palette and index 0 transparent
function indexedPng(img, palette) {
  const stride = img.width / 2;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x += 2) raw[y * (stride + 1) + 1 + x / 2] = (img.index[y * img.width + x] << 4) | img.index[y * img.width + x + 1];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 4;
  header[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('PLTE', Buffer.from(palette.flat())),
    chunk('tRNS', Buffer.from([0])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const names = [''];
const speciesId = [];
const evos = {};
const prevo = {};
for (const s of dex.species.all()) {
  if (!s.exists || s.forme || s.num < 1 || s.num > MAX_NUM) continue;
  speciesId[s.num] = s.id;
  names[s.num] = s.name
    .replace(/^Nidoran-F$/, 'NIDORAN♀')
    .replace(/^Nidoran-M$/, 'NIDORAN♂')
    .replace(/’/g, "'")
    .toUpperCase();
  const next = s.evos.map((name) => dex.species.get(name)).filter((e) => e.exists && !e.forme && e.num <= MAX_NUM).map((e) => e.num);
  if (next.length) evos[s.num] = next;
  const before = s.prevo ? dex.species.get(s.prevo) : null;
  if (before?.exists && before.num <= MAX_NUM) prevo[s.num] = before.num;
}
const bases = [];
const singles = [];
for (let num = 1; num <= MAX_NUM; num++) {
  if (prevo[num]) continue;
  (evos[num] ? bases : singles).push(num);
}

const iconPalettes = [0, 1, 2].map((i) => readJasc(join(PRET, `icon_palette_${i}.pal`)));
const paletteOf = {};
for (const m of readFileSync(join(PRET, 'pokemon_icon.c'), 'utf8').split('gMonIconPaletteIndices')[1].matchAll(/\[SPECIES_([A-Z0-9_]+)\]\s*=\s*(\d)/g)) {
  paletteOf[m[1].toLowerCase()] = Number(m[2]);
}
const iconFile = {};
for (const file of readdirSync(join(PRET, 'icons'))) iconFile[file.slice(0, -4).replace(/_/g, '')] = file.slice(0, -4);

const blobs = { i: { chunks: [], offset: 0 }, f: { chunks: [], offset: 0 }, a: { chunks: [], offset: 0 } };
const index = { i: {}, f: {}, a: {} };
function add(kind, num, bytes) {
  const blob = blobs[kind];
  index[kind][num] = [blob.offset, bytes.length];
  blob.chunks.push(bytes);
  blob.offset += bytes.length;
}

const missing = [];
const shinyPalettes = {};
for (let num = 1; num <= MAX_NUM; num++) {
  const file = iconFile[speciesId[num]];
  if (!file) {
    missing.push(`icon ${num}`);
    continue;
  }
  const img = readIndexedPng(readFileSync(join(PRET, 'icons', `${file}.png`)));
  const pal = iconPalettes[paletteOf[file] ?? 0];
  add('i', num, indexedPng(img, pal));
  // Emerald front pics with the game's normal palette; the shiny palette is swapped in at runtime
  const front = join(PRET, 'fronts', `${file}.png`);
  const normal = join(PRET, 'fronts', `${file}.normal.pal`);
  const shiny = join(PRET, 'fronts', `${file}.shiny.pal`);
  if (existsSync(front)) {
    const pic = readIndexedPng(readFileSync(front));
    const pal = existsSync(normal) ? readJasc(normal) : pic.palette.map((hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)));
    add('f', num, indexedPng(pic, pal));
    // anim_front.png stacks the summary's two frames; the second one goes in partners-anim.css
    const anim = join(PRET, 'anim', `${file}.png`);
    if (existsSync(anim)) {
      const two = readIndexedPng(readFileSync(anim));
      if (two.height >= 128) add('a', num, indexedPng({ width: 64, height: 64, index: two.index.subarray(64 * 64) }, pal));
    }
    if (existsSync(shiny)) shinyPalettes[num] = readJasc(shiny).map((rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('')).join('');
  } else if (existsSync(join(FRONTS, `${num}.png`))) add('f', num, readFileSync(join(FRONTS, `${num}.png`)));
  else missing.push(`front ${num}`);
}

const ALL_TRAINERS = [
  ...TRAINERS,
  ...MORE_TRAINERS.map(([id, label, name, file]) => {
    TRAINER_LABELS[id] = label;
    return [id, name, file, autoGroups(readIndexedPng(readFileSync(join(PRET, 'people', `${file}.png`))))];
  }),
];
const trainers = ALL_TRAINERS.map(([id, name, file, groups]) => {
  const img = readIndexedPng(readFileSync(join(PRET, 'people', `${file}.png`)));
  const frames = TRAINER_FRAMES.map((frame) => {
    const out = Buffer.alloc(16 * 32 / 2);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 16; x += 2) {
        const at = y * img.width + frame * 16 + x;
        out[(y * 16 + x) / 2] = (img.index[at] << 4) | img.index[at + 1];
      }
    }
    return out.toString('base64');
  });
  return { id, label: TRAINER_LABELS[id], name, pal: img.palette, frames, groups };
});

// the summary's front animation per species: [frame, duration in 1/60 s] pairs from sAnim_<Species>_1
const frontAnims = {};
const animText = readFileSync(join(PRET, 'src', 'front_pic_anims.h'), 'utf8');
for (const m of animText.matchAll(/sAnim_(\w+?)_1\[\] =\s*\{([\s\S]*?)\};/g)) {
  const id = m[1].toLowerCase().replace(/_/g, '');
  const frames = [...m[2].matchAll(/ANIMCMD_FRAME\((\d+),\s*(\d+)\)/g)].flatMap((f) => [Number(f[1]), Number(f[2])]);
  const num = speciesId.indexOf(id);
  if (num > 0 && frames.length) frontAnims[num] = frames;
}
const data = { n: names, e: evos, b: bases, s: singles, i: index.i, f: index.f, a: index.a, fa: frontAnims, sh: shinyPalettes, t: trainers };
// one file per blob: Cinnamon silently drops a CSS file past roughly 750 KB
const outputs = [
  ['partners-data.css', `.pkp-data { --pkp-data: "${Buffer.from(JSON.stringify(data)).toString('base64')}"; }\n`],
  ['partners-icons.css', `.pkp-data { --pkp-icons: "${Buffer.concat(blobs.i.chunks).toString('base64')}"; }\n`],
  ['partners-fronts.css', `.pkp-data { --pkp-fronts: "${Buffer.concat(blobs.f.chunks).toString('base64')}"; }\n`],
  ['partners-anim.css', `.pkp-data { --pkp-anim: "${Buffer.concat(blobs.a.chunks).toString('base64')}"; }\n`],
];
for (const [name, css] of outputs) writeFileSync(join(OUT_DIR, name), css);
console.log(`species ${names.length - 1}, bases ${bases.length}, singles ${singles.length}, icons ${Object.keys(index.i).length}, fronts ${Object.keys(index.f).length}, trainers ${trainers.length}`);
if (missing.length) console.log(`missing: ${missing.join(', ')}`);
for (const [name, css] of outputs) console.log(`${name} ${css.length}`);
