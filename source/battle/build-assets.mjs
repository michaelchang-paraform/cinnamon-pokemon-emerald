// Builds the extension-battle data CSS from pret/pokeemerald graphics (personal use only) and the helper's
// pokemon-showdown dex. PokeAPI sprites fill in only the forms pokeemerald lacks. Run: node source/battle/build-assets.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, readPal, readBin, Canvas, drawMap, tile, encodeRgba, encodeIndexed } from './lib/gba.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'extension-battle');
const PE = join(HERE, 'download', 'pokeemerald');
const G = join(PE, 'graphics');
const MON = join(G, 'pokemon');
const POKEAPI = join(HERE, 'download', 'pokeapi-sprites', 'sprites', 'pokemon', 'versions', 'generation-iii');
const MAX_CSS = 500 * 1024;

const require = createRequire(join(ROOT, 'helper', 'package.json'));
const { Dex } = require('pokemon-showdown');
const dex = Dex.forGen(3);
const TYPES = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', '???'];
const src = (path) => readFileSync(join(PE, path), 'utf8');
const b64 = (buf) => Buffer.from(buf).toString('base64');

// coordinate tables
const coordTable = (text) => Object.fromEntries([...text.matchAll(/\[SPECIES_(\w+)\]\s*=\s*\{\s*\.size = MON_COORDS_SIZE\(\d+, \d+\), \.y_offset = +(\d+)/g)].map((m) => [m[1], Number(m[2])]));
const front = coordTable(src('src/data/pokemon_graphics/front_pic_coordinates.h'));
const back = coordTable(src('src/data/pokemon_graphics/back_pic_coordinates.h'));
const elevation = Object.fromEntries([...src('src/data/pokemon_graphics/enemy_mon_elevation.h').matchAll(/\[SPECIES_(\w+)\] = (\d+),/g)].map((m) => [m[1], Number(m[2])]));
const iconPal = Object.fromEntries([...src('src/pokemon_icon.c').split('gMonIconPaletteIndices')[1].matchAll(/\[SPECIES_(\w+)\] = (\d+),/g)].map((m) => [m[1], Number(m[2])]));
const CASTFORM = { castform: ['normal', 17, 13], castformsunny: ['sunny', 9, 14], castformrainy: ['rainy', 9, 13], castformsnowy: ['snowy', 8, 13] };

const dirs = Object.fromEntries(readdirSync(MON).filter((d) => !d.includes('.')).map((d) => [d.replace(/_/g, ''), d]));
const unownDir = (letter) => (letter === 'exclamation' ? 'exclamation_mark' : letter === 'question' ? 'question_mark' : letter);
const unownKey = (letter) => (letter === 'exclamation' ? 'UNOWN_EMARK' : letter === 'question' ? 'UNOWN_QMARK' : `UNOWN_${letter.toUpperCase()}`);

const blobs = { f: { chunks: [], offset: 0 }, b: { chunks: [], offset: 0 }, i: { chunks: [], offset: 0 } };
const sprites = {};
function addSprite(key, png) {
  const blob = blobs[key[0]];
  sprites[key] = [blob.offset, png.length];
  blob.chunks.push(png);
  blob.offset += png.length;
}
const indexed = (path, palette, rows) => {
  const img = decodePng(path);
  const h = rows ?? img.height;
  return encodeIndexed(img.width, h, img.pixels.subarray(0, img.width * h), palette);
};

const species = {};
const done = new Set();
for (const s of dex.species.all()) {
  if (!s.exists || s.num < 1 || s.num > 386 || s.gen > 3) continue;
  const id = s.id;
  let dir = null, palPath = null, key = null, fy = 0, by = 0, elev = 0, icon = null, iconPalette = 0, file = id;
  if (CASTFORM[id]) {
    const [form, y, e] = CASTFORM[id];
    dir = `castform/${form}`; palPath = join(MON, dir, 'normal.pal'); fy = y; by = 0; elev = e; icon = join(MON, 'castform', 'icon.png'); iconPalette = iconPal.CASTFORM;
  } else if (/^deoxys./.test(id)) {
    const num = { deoxysattack: '10001', deoxysdefense: '10002', deoxysspeed: '10003' }[id];
    const f = join(POKEAPI, 'emerald', `${num}.png`), f2 = join(POKEAPI, 'firered-leafgreen', `${num}.png`);
    const bk = join(POKEAPI, 'firered-leafgreen', 'back', `${num}.png`), bk2 = join(POKEAPI, 'ruby-sapphire', 'back', '386.png');
    addSprite(`f${id}`, readFileSync(existsSync(f) ? f : f2));
    addSprite(`b${id}`, readFileSync(existsSync(bk) ? bk : bk2));
    species[id] = { n: s.num, t: s.types.map((t) => TYPES.indexOf(t)), fy: front.DEOXYS, by: back.DEOXYS, el: elevation.DEOXYS ?? 0, ic: 'deoxys' };
    continue;
  } else {
    dir = dirs[id];
    if (!dir) throw new Error(`no pokeemerald folder for ${id}`);
    key = dir.toUpperCase();
    palPath = join(MON, dir, 'normal.pal');
    if (dir === 'unown') { dir = 'unown/a'; palPath = join(MON, 'unown', 'normal.pal'); }
    fy = front[key]; by = back[key]; elev = elevation[key] ?? 0; icon = join(MON, dir, 'icon.png'); iconPalette = iconPal[key] ?? 0;
  }
  const pal = readPal(palPath);
  addSprite(`f${file}`, indexed(join(MON, dir, 'front.png'), pal, 64));
  addSprite(`b${file}`, indexed(join(MON, dir, 'back.png'), pal, 64));
  const iconKey = id.startsWith('castform') ? 'castform' : file;
  if (!done.has(iconKey)) {
    addSprite(`i${iconKey}`, indexed(icon, readPal(join(MON, 'icon_palettes', `icon_palette_${iconPalette}.pal`))));
    done.add(iconKey);
  }
  species[id] = { n: s.num, t: s.types.map((t) => TYPES.indexOf(t)), fy, by, el: elev, ic: iconKey };
}
for (const letter of readdirSync(join(MON, 'unown')).filter((d) => !d.includes('.'))) {
  const name = letter === 'exclamation_mark' ? 'exclamation' : letter === 'question_mark' ? 'question' : letter;
  const id = `unown${name}`;
  if (name === 'a') continue;
  const pal = readPal(join(MON, 'unown', 'normal.pal'));
  const key = unownKey(name);
  addSprite(`f${id}`, indexed(join(MON, 'unown', unownDir(name), 'front.png'), pal, 64));
  addSprite(`b${id}`, indexed(join(MON, 'unown', unownDir(name), 'back.png'), pal, 64));
  addSprite(`i${id}`, indexed(join(MON, 'unown', unownDir(name), 'icon.png'), readPal(join(MON, 'icon_palettes', `icon_palette_${iconPal[key] ?? 0}.pal`))));
  species[id] = { n: 201, t: [TYPES.indexOf('Psychic')], fy: front[key] ?? front.UNOWN, by: back[key] ?? back.UNOWN, el: elevation[key] ?? 0, ic: id };
}

const moves = {};
for (const m of dex.moves.all()) {
  if (!m.exists || m.num < 1 || m.num > 354 || m.isNonstandard) continue;
  moves[m.id] = TYPES.indexOf(m.type);
}

// interface graphics
const ui = {};
const put = (name, png) => (ui[name] = b64(png));
const fullPal = (n) => Array.from({ length: n * 16 }, () => [255, 0, 255]);
{
  const tiles = decodePng(join(G, 'battle_environment/tall_grass/tiles.png'));
  const pal = fullPal(8);
  readPal(join(G, 'battle_environment/tall_grass/palette.pal')).forEach((c, i) => (pal[32 + i] = c));
  const c = new Canvas(256, 512);
  drawMap(c, tiles, readBin(join(G, 'battle_environment/tall_grass/map.bin')), 32, pal, { transparent0: false });
  put('bg', encodeRgba(c.crop(0, 0, 240, 112)));
}
{
  const tiles = decodePng(join(G, 'battle_interface/textbox.png'));
  const pal = fullPal(2);
  readPal(join(G, 'battle_interface/textbox_0.pal')).forEach((c, i) => (pal[i] = c));
  readPal(join(G, 'battle_interface/textbox_1.pal')).forEach((c, i) => (pal[16 + i] = c));
  const c = new Canvas(256, 512);
  drawMap(c, tiles, readBin(join(G, 'battle_interface/textbox_map.bin')), 32, pal, { transparent0: false });
  put('tbMsg', encodeRgba(c.crop(0, 112, 240, 48)));
  put('tbAction', encodeRgba(c.crop(0, 272, 240, 48)));
  put('tbMove', encodeRgba(c.crop(0, 432, 240, 48)));
  // index 1 is the textbox fill; keeping it opaque let the cursor tile paint over neighbouring glyphs
  const cur = (a, b) => {
    const k = new Canvas(8, 16);
    [a, b].forEach((n, i) => { const t = tile(tiles, n); for (let p = 0; p < 64; p++) if ((t[p] & 15) > 1) k.set(p % 8, i * 8 + Math.floor(p / 8), pal[t[p]]); });
    return encodeRgba(k);
  };
  put('curAction', cur(1, 2));
}
for (const [name, file] of [['hbPlayer', 'healthbox_singles_player'], ['hbFoe', 'healthbox_singles_opponent'], ['hpbar', 'hpbar'], ['hbFrameEnd', 'misc_frameend'], ['expbar', 'expbar'], ['shadow', 'enemy_mon_shadow']]) {
  const img = decodePng(join(G, `battle_interface/${file}.png`));
  put(name, encodeIndexed(img.width, img.height, img.pixels, img.palette));
}
{
  const img = decodePng(join(G, 'battle_interface/status.png'));
  const c = new Canvas(img.width, img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const v = img.pixels[y * img.width + x]; if (v % 16) c.set(x, y, img.palette[v]); }
  put('status', encodeRgba(c));
}
// party menu
const partyTiles = decodePng(join(G, 'party_menu/bg.png'));
const partyPal = partyTiles.palette;
{
  const c = new Canvas(256, 256);
  drawMap(c, partyTiles, readBin(join(G, 'party_menu/bg.bin')), 32, partyPal, { transparent0: false });
  put('partyBg', encodeRgba(c.crop(0, 0, 240, 160)));
}
const SLOT_PALS = {
  plain: [[52, 53, 54], [49, 55, 56]],
  on: [[116, 117, 118], [97, 103, 104]],
  fnt: [[84, 85, 86], [81, 87, 88]],
  fntOn: [[148, 149, 150], [97, 103, 104]],
};
function slotPalette(base, state) {
  const pal = partyPal.slice(base * 16, base * 16 + 16).map((c) => [...c]);
  const [a, b] = SLOT_PALS[state];
  [4, 5, 6].forEach((o, i) => (pal[o] = partyPal[a[i]]));
  [1, 7, 8].forEach((o, i) => (pal[o] = partyPal[b[i]]));
  return pal;
}
for (const [name, file, w, h, base] of [['slotMain', 'slot_main', 10, 7, 3], ['slotWide', 'slot_wide', 18, 3, 4]]) {
  const map = [...readFileSync(join(G, `party_menu/${file}.bin`))];
  for (const state of Object.keys(SLOT_PALS)) {
    const pal = slotPalette(base, state);
    const c = new Canvas(w * 8, h * 8);
    map.forEach((n, i) => c.drawTile(tile(partyTiles, n), (i % w) * 8, Math.floor(i / w) * 8, (v) => pal[v & 15]));
    put(`${name}_${state}`, encodeRgba(c));
  }
}
{
  const map = readBin(join(G, 'party_menu/cancel_button.bin'));
  for (const state of ['plain', 'on']) {
    const pal = partyPal.map((c) => [...c]);
    if (state === 'on') [1, 7, 8].forEach((o, i) => (pal[16 + o] = partyPal[SLOT_PALS.on[1][i]]));
    const c = new Canvas(56, 16);
    drawMap(c, partyTiles, map, 7, pal);
    put(`cancel_${state}`, encodeRgba(c));
  }
}
const slotColors = (state) => {
  const pal = slotPalette(4, state);
  return { text: pal[3], shadow: pal[2], hpEmptyTop: pal[13], hpEmpty: pal[2] };
};
const hpColors = { g: [partyPal[57], partyPal[58]], y: [partyPal[73], partyPal[74]], r: [partyPal[89], partyPal[90]] };
// text window frame and fonts
{
  const img = decodePng(join(G, 'text_window/1.png'));
  put('frame', encodeIndexed(img.width, img.height, img.pixels, img.palette));
}
const fontsC = src('src/fonts.c');
const widths = (name) => [...fontsC.split(`${name}GlyphWidths[] = {`)[1].split('};')[0].matchAll(/\d+/g)].map(Number);
const fonts = {};
for (const [name, file, table, height] of [['normal', 'latin_normal', 'gFontNormalLatin', 16], ['small', 'latin_small', 'gFontSmallLatin', 13], ['narrow', 'latin_narrow', 'gFontNarrowLatin', 16]]) {
  const img = decodePng(join(G, `fonts/${file}.png`));
  const c = new Canvas(img.width, img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const v = img.pixels[y * img.width + x];
    if (v === 1) c.set(x, y, [255, 0, 0]);
    else if (v === 2) c.set(x, y, [0, 0, 255]);
  }
  put(`font_${name}`, encodeRgba(c));
  fonts[name] = { w: widths(table), h: height };
}
const chars = {};
for (const line of src('charmap.txt').split('\n')) {
  const m = /^'(.{1,2})'\s*=\s*([0-9A-F]{2})\s*$/.exec(line.trim());
  if (m && !(m[1] in chars)) chars[m[1]] = parseInt(m[2], 16);
}
chars['\u0001'] = 0x34;
chars["'"] = chars['’'];
chars['"'] = chars['”'];
delete chars.$;

const colors = {
  msg: [[255, 255, 255], [106, 90, 115]],
  menu: [[74, 74, 74], [213, 213, 205]],
  hb: [[65, 65, 65], [222, 213, 180]],
  std: [[98, 98, 98], [213, 213, 205]],
  pp1: [[213, 197, 0], [255, 246, 139]],
  pp2: [[255, 131, 0], [255, 238, 115]],
  pp3: [[230, 24, 0], [246, 222, 156]],
  party: [slotColors('plain').text, slotColors('plain').shadow],
};
const data = { types: TYPES, species, moves, sprites, fonts, chars, colors, hp: hpColors, slot: { plain: slotColors('plain'), on: slotColors('on'), fnt: slotColors('fnt'), fntOn: slotColors('fntOn') } };
const outputs = [
  ['battle-data.css', `.pkb-data { --pkb-data: "${b64(JSON.stringify(data))}"; }\n`],
  ['battle-ui.css', `.pkb-data { --pkb-ui: "${b64(JSON.stringify(ui))}"; }\n`],
  ['battle-front.css', `.pkb-data { --pkb-sprites-f: "${b64(Buffer.concat(blobs.f.chunks))}"; }\n`],
  ['battle-back.css', `.pkb-data { --pkb-sprites-b: "${b64(Buffer.concat(blobs.b.chunks))}"; }\n`],
  ['battle-icons.css', `.pkb-data { --pkb-sprites-i: "${b64(Buffer.concat(blobs.i.chunks))}"; }\n`],
];
for (const [name, css] of outputs) {
  if (css.length > MAX_CSS) throw new Error(`${name} is ${css.length} bytes, over ${MAX_CSS}: split it`);
  writeFileSync(join(OUT_DIR, name), css);
  console.log(`${name} ${css.length}`);
}
console.log(`species ${Object.keys(species).length}, sprites ${Object.keys(sprites).length}, ui images ${Object.keys(ui).length}`);
