// Builds the extension-battle data CSS from pret/pokeemerald graphics (personal use only) and the helper's
// pokemon-showdown dex. PokeAPI sprites fill in only the forms pokeemerald lacks. Run: node source/battle/build-assets.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

const blobs = { f: { chunks: [], offset: 0 }, b: { chunks: [], offset: 0 }, i: { chunks: [], offset: 0 }, a: { chunks: [], offset: 0 } };
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
  // anim_front.png stacks the entrance animation's two frames; the second one goes in battle-anim.css
  const two = join(MON, dir, 'anim_front.png');
  if (existsSync(two)) {
    const img = decodePng(two);
    if (img.height >= 128) addSprite(`a${file}`, encodeIndexed(img.width, 64, img.pixels.subarray(img.width * 64, img.width * 128), pal));
  }
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
// the entrance animation per species: [frame, duration in game frames] pairs from sAnim_<Species>_1 (front_pic_anims.h)
const frontAnims = {};
for (const m of src('src/data/pokemon_graphics/front_pic_anims.h').matchAll(/sAnim_(\w+?)_1\[\] =\s*\{([\s\S]*?)\};/g)) {
  const id = species[m[1].toLowerCase().replace(/_/g, '')] ? m[1].toLowerCase().replace(/_/g, '') : null;
  const frames = [...m[2].matchAll(/ANIMCMD_FRAME\((\d+),\s*(\d+)\)/g)].flatMap((f) => [Number(f[1]), Number(f[2])]);
  if (id && frames.length) frontAnims[id] = frames;
}
// the twelve ball sheets (graphics/balls, 16x48: closed, opening, open) and the particle sheet when it was fetched
const BALLS = ['poke', 'great', 'safari', 'ultra', 'master', 'net', 'dive', 'nest', 'repeat', 'timer', 'luxury', 'premier'];
const BALL_DIR = join(HERE, '..', 'sprites', 'download', 'pret', 'balls');
const balls = {};
for (const ball of BALLS) {
  const file = join(BALL_DIR, `${ball}.png`);
  if (!existsSync(file)) throw new Error(`missing ${file}: run source/sprites/download-balls.sh`);
  const img = decodePng(file);
  balls[ball] = b64(encodeIndexed(img.width, img.height, img.pixels, img.palette));
}
const PARTICLES = join(HERE, 'download', 'pret-anims');
if (existsSync(join(PARTICLES, 'particles.png')) && existsSync(join(PARTICLES, 'circle_impact.png'))) {
  const sheet = decodePng(join(PARTICLES, 'particles.png'));
  const pal = decodePng(join(PARTICLES, 'circle_impact.png')).palette;
  balls.particles = b64(encodeIndexed(sheet.width, sheet.height, sheet.pixels, pal));
}
balls.so = buildSendOut('clang', join(HERE, 'tools', 'monanim'));
const se = buildSoundTimelines();
// the battle screen's type names (gTypeNames, battle_main.c), per TYPES entry
const typeNameTable = readFileSync(join(HERE, 'download', 'pret-anims', 'src', 'battle_main.c'), 'utf8').split('gTypeNames[')[1].split('};')[0];
const gameTypes = Object.fromEntries([...typeNameTable.matchAll(/\[TYPE_(\w+)\] = _\("([^"]*)"\)/g)].map((m) => [m[1], m[2]]));
const typeNames = TYPES.map((t) => gameTypes[t === '???' ? 'MYSTERY' : t.toUpperCase()] ?? t.toUpperCase());
const data = { types: TYPES, species, moves, sprites, fonts, chars, colors, fa: frontAnims, hp: hpColors, se, typeNames, slot: { plain: slotColors('plain'), on: slotColors('on'), fnt: slotColors('fnt'), fntOn: slotColors('fntOn') } };
const outputs = [
  ['battle-data.css', `.pkb-data { --pkb-data: "${b64(JSON.stringify(data))}"; }\n`],
  ['battle-ui.css', `.pkb-data { --pkb-ui: "${b64(JSON.stringify(ui))}"; }\n`],
  ['battle-front.css', `.pkb-data { --pkb-sprites-f: "${b64(Buffer.concat(blobs.f.chunks))}"; }\n`],
  ['battle-back.css', `.pkb-data { --pkb-sprites-b: "${b64(Buffer.concat(blobs.b.chunks))}"; }\n`],
  ['battle-icons.css', `.pkb-data { --pkb-sprites-i: "${b64(Buffer.concat(blobs.i.chunks))}"; }\n`],
  ['battle-anim.css', `.pkb-data { --pkb-sprites-a: "${b64(Buffer.concat(blobs.a.chunks))}"; }\n`],
  ['battle-balls.css', `.pkb-data { --pkb-balls: "${b64(JSON.stringify(balls))}"; }\n`],
  ['battle-monanim.css', `.pkb-data { --pkb-monanim: "${b64(JSON.stringify(buildMonAnims()))}"; }\n`],
];
for (const [name, css] of outputs) {
  if (css.length > MAX_CSS) throw new Error(`${name} is ${css.length} bytes, over ${MAX_CSS}: split it`);
  writeFileSync(join(OUT_DIR, name), css);
  console.log(`${name} ${css.length}`);
}
console.log(`species ${Object.keys(species).length}, sprites ${Object.keys(sprites).length}, ui images ${Object.keys(ui).length}`);

// Every sound a battle anim script plays (data/battle_anim_scripts.s), as [end, frame, se, pan, ...] per script.
// The pan stays the script's argument (SOUND_PAN_ATTACKER -64, SOUND_PAN_TARGET 63) so the page can apply
// BattleAnimAdjustPanning for the real sides. waitforvisualfinish waits on sprite work no script states; it
// counts VISUAL_WAIT frames.
function buildSoundTimelines() {
  const VISUAL_WAIT = 16;
  const file = join(HERE, 'download', 'pret-anims', 'data', 'battle_anim_scripts.s');
  if (!existsSync(file)) throw new Error(`missing ${file}: run source/battle/fetch-anims.sh`);
  const labels = {};
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/@.*$/, '').trim();
    const label = /^(\w+):{1,2}$/.exec(line);
    if (label) {
      current = labels[label[1]] = labels[label[1]] ?? [];
      continue;
    }
    if (current && line) current.push(line);
  }
  // a run of labels with no commands between them shares the next label's commands
  const lines = Object.entries(labels);
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i][1].length && i + 1 < lines.length) labels[lines[i][0]] = lines[i + 1][1];
  const value = (arg) => {
    const a = arg.trim();
    if (a === 'SOUND_PAN_ATTACKER') return -64;
    if (a === 'SOUND_PAN_TARGET') return 63;
    const n = Number(a.replace(/^\+/, ''));
    return Number.isFinite(n) ? n : null;
  };
  const names = [];
  const nameIndex = (se) => {
    let i = names.indexOf(se);
    if (i < 0) i = names.push(se) - 1;
    return i;
  };
  const toward = (from, to, step, frames) => {
    const dir = Math.sign(to - from);
    return Math.max(-64, Math.min(63, dir > 0 ? Math.min(to, from + step * frames) : Math.max(to, from - step * frames)));
  };
  function run(entry, turn) {
    const out = [];
    let t = 0;
    let soundEnd = 0;
    let steps = 0;
    let fadeStart = -Infinity;
    // return values the script branches on that do not depend on the battle: random battle sets carry the
    // friendship that gives Return and Frustration their strongest animation, and this is never a contest
    const RETURNS = { AnimTask_GetReturnPowerLevel: 3, AnimTask_GetFrustrationPowerLevel: 3, AnimTask_IsContest: 0 };
    let ret;
    const play = (at, se, pan) => {
      out.push([at, nameIndex(se), pan]);
      soundEnd = Math.max(soundEnd, at);
    };
    const exec = (name, stack) => {
      const body = labels[name];
      if (!body) throw new Error(`anim script label ${name} not found`);
      for (let i = 0; i < body.length; i++) {
        if (++steps > 5000) throw new Error(`anim script ${entry} does not end`);
        const [cmd, ...rest] = body[i].split(/\s+/);
        const args = rest.join(' ').split(',').map((s) => s.trim());
        switch (cmd) {
          case 'delay': t += value(args[0]) ?? 0; break;
          case 'waitforvisualfinish': t += VISUAL_WAIT; break;
          case 'waitsound': t = Math.max(t, soundEnd); break;
          case 'playsewithpan': play(t, args[0], value(args[1]) ?? 0); break;
          case 'playse': play(t, args[0], 0); break;
          case 'panse': case 'panse_adjustnone': case 'panse_adjustall': play(t, args[0], value(args[1]) ?? 0); break;
          case 'waitplaysewithpan': play(t + (value(args[2]) ?? 0), args[0], value(args[1]) ?? 0); break;
          case 'loopsewithpan': {
            const wait = value(args[2]) ?? 0;
            for (let n = 0; n < (value(args[3]) ?? 1); n++) play(t + n * (wait + 1), args[0], value(args[1]) ?? 0);
            break;
          }
          // Task_FadeToBg: a hardware fade out to the move's background and back, 18 frames each way
          case 'fadetobg': case 'fadetobgfromset': case 'restorebg': fadeStart = t; break;
          case 'waitbgfadeout': t = Math.max(t, fadeStart + 18); break;
          case 'waitbgfadein': t = Math.max(t, fadeStart + 36); break;
          case 'createvisualtask': {
            const [task, , ...rest] = args;
            ret = RETURNS[task];
            if (task === 'SoundTask_PlaySE1WithPanning' || task === 'SoundTask_PlaySE2WithPanning') play(t, rest[0], value(rest[1]) ?? 0);
            // the attacker's (or target's) own cry in a PlayCry_ByMode mode; the page plays it through cry()
            else if (task === 'SoundTask_PlayCryHighPitch') play(t, `CRY:high_pitch:${rest[0]}`, -64);
            else if (task === 'SoundTask_PlayDoubleCry') play(t, `CRY:${rest[1] === 'DOUBLE_CRY_GROWL' ? 'growl' : 'roar'}:${rest[0]}`, -64);
            else if (task === 'SoundTask_PlayCryWithEcho') play(t, `CRY:echo:ANIM_ATTACKER`, -64);
            break;
          }
          case 'createsoundtask': {
            if (args[0] === 'SoundTask_LoopSEAdjustPanning') {
              const [from, to, step, count, , every] = args.slice(2).map(value);
              for (let n = 0; n < count; n++) play(t + n * (every + 1), args[1], toward(from, to, step, n * (every + 1)));
            } else if (args[0] === 'SoundTask_FireBlast') {
              for (let f = 1; f <= 100; f += 11) play(t + f, args[1], toward(-64, 63, 2, f));
              play(t + 112, args[2], 63);
              play(t + 118, args[2], 63);
            }
            break;
          }
          case 'jumpreteq': if (ret === value(args[0])) return exec(args[1], stack); break;
          case 'jumprettrue': if (ret) return exec(args[0], stack); break;
          case 'jumpretfalse': if (ret === 0) return exec(args[0], stack); break;
          case 'call': exec(args[0], stack + 1); break;
          case 'goto': return exec(args[0], stack);
          case 'choosetwoturnanim': return exec(turn === 1 ? args[0] : args[1], stack);
          case 'return': return;
          case 'end': return;
        }
      }
    };
    exec(entry, 0);
    out.sort((a, b) => a[0] - b[0]);
    return [Math.max(t, soundEnd), ...out.flat()];
  }
  const table = (name) => {
    const start = labels[name];
    if (!start) throw new Error(`anim table ${name} not found`);
    return start.filter((l) => l.startsWith('.4byte')).map((l) => l.split(/\s+/)[1]);
  };
  const scripts = {};
  const movesTable = table('gBattleAnims_Moves');
  for (const m of dex.moves.all()) {
    if (!m.exists || m.num < 1 || m.num > 354 || m.isNonstandard) continue;
    const label = movesTable[m.num];
    scripts[m.id] = run(label, 2);
    if (labels[label].some((l) => l.startsWith('choosetwoturnanim'))) scripts[`${m.id}@1`] = run(label, 1);
  }
  for (const group of ['gBattleAnims_StatusConditions', 'gBattleAnims_General', 'gBattleAnims_Special'])
    for (const label of table(group)) if (labels[label]) scripts[label.replace(/^(Status|General|Special)_/, (p, g) => `${{ Status: 's', General: 'g', Special: 'x' }[g]}:`)] = run(label, 2);
  const withSound = Object.values(scripts).filter((s) => s.length > 1).length;
  console.log(`anim scripts ${Object.keys(scripts).length}, with sound ${withSound}, effects ${names.length}`);
  return { n: names, a: scripts };
}

// The entrance animations: the game's own sprite callbacks from the fetched pokemon_animation.c, compiled with
// clang against the engine stub in tools/monanim and run once per build; nothing recorded is kept in the repo.
// Frames are [x2, y2, rotation, xScale, yScale, blend coeff, blend RGB555, invisible] with default trailing values
// dropped; a number repeats the previous frame that many more times.
function buildMonAnims() {
  const TOOL = join(HERE, 'tools', 'monanim');
  const A = join(HERE, 'download', 'pret-anims');
  const out = join(TOOL, 'out');
  mkdirSync(out, { recursive: true });
  let frames;
  try {
    const bin = join(out, 'mon_anim');
    const cc = spawnSync('clang', ['-O1', '-w', `-I${join(TOOL, 'include')}`, `-I${join(A, 'include')}`, `-I${join(PE, 'include')}`, `-DPOKEMON_ANIMATION_C="${join(A, 'src', 'pokemon_animation.c')}"`, join(TOOL, 'mon_anim.c'), join(TOOL, 'engine.c'), join(A, 'src', 'trig.c'), '-o', bin], { encoding: 'utf8' });
    if (cc.error) throw new Error('clang is needed to record the entrance animations: xcode-select --install');
    if (cc.status !== 0) throw new Error(`monanim compile failed:\n${cc.stderr}`);
    const run = spawnSync(bin, [], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`monanim run failed: ${run.stderr || run.signal}`);
    const DEFAULTS = [0, 0, 0, 256, 256, 0, 0, 0];
    frames = JSON.parse(run.stdout).map((recorded) => {
      const list = [];
      let prev = null;
      for (const [x2, y2, sx, sy, rot, coeff, color, inv] of recorded) {
        const frame = [x2, y2, rot, sx, sy, coeff, color, inv];
        while (frame.length && frame[frame.length - 1] === DEFAULTS[frame.length - 1]) frame.pop();
        const key = JSON.stringify(frame);
        if (key === prev) {
          if (typeof list[list.length - 1] === 'number') list[list.length - 1]++;
          else list.push(1);
        } else list.push(frame);
        prev = key;
      }
      return list;
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const header = readFileSync(join(A, 'include', 'pokemon_animation.h'), 'utf8');
  const ids = Object.fromEntries([...header.matchAll(/#define ((?:BACK_)?ANIM_\w+)\s+(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const code = readFileSync(join(A, 'src', 'pokemon_animation.c'), 'utf8');
  const pokemon = src('src/pokemon.c');
  const block = (text, name) => text.split(name)[1].split('};')[0];
  const dexOf = (constName) => dex.species.get(constName.toLowerCase().replace(/_/g, ''))?.num ?? null;
  const front = {};
  for (const m of block(pokemon, 'sMonFrontAnimIdsTable[NUM_SPECIES - 1] =').matchAll(/\[SPECIES_(\w+) - 1\]\s*=\s*(ANIM_\w+)/g)) {
    const num = dexOf(m[1]);
    if (num) front[num] = [ids[m[2]], 0];
  }
  for (const m of block(pokemon, 'sMonAnimationDelayTable[NUM_SPECIES - 1] =').matchAll(/\[SPECIES_(\w+) - 1\]\s*=\s*(\d+)/g)) {
    const num = dexOf(m[1]);
    if (num && front[num]) front[num][1] = Number(m[2]);
  }
  // GetSpeciesBackAnimSet: BACK_ANIM_NONE falls back to the first set
  const back = {};
  for (const m of block(code, 'sSpeciesToBackAnimSet[] =').matchAll(/\[SPECIES_(\w+)\]\s*=\s*(BACK_ANIM_\w+)/g)) {
    const num = dexOf(m[1]);
    if (num) back[num] = Math.max(0, ids[m[2]] - 1);
  }
  const sets = [];
  for (const m of block(code, 'sBackAnimationIds[] =').matchAll(/\[\((BACK_ANIM_\w+) - 1\) \* 3\]\s*=\s*(ANIM_\w+),\s*(ANIM_\w+),\s*(ANIM_\w+)/g)) sets[ids[m[1]] - 1] = [ids[m[2]], ids[m[3]], ids[m[4]]];
  const nature = Object.fromEntries([...block(code, 'sBackAnimNatureModTable[NUM_NATURES] =').matchAll(/\[NATURE_(\w+)\]\s*=\s*(\d)/g)].map((m) => [m[1].toLowerCase(), Number(m[2])]));
  console.log(`mon anims ${frames.length}, front ${Object.keys(front).length}, back ${Object.keys(back).length}, back sets ${sets.length}`);
  return { f: frames, front, back, sets, nature };
}

// C source helpers for the recorders: a top-level definition by name, found by its opening line and its braces
function cDefinition(text, name) {
  const head = new RegExp(`^(?:static )?(?:const )?[\\w *]+?\\b${name}(?:\\[[^\\]]*\\])*(?:\\([^)]*\\))?\\s*=?\\s*\\n?\\{`, 'm').exec(text);
  if (!head) throw new Error(`definition of ${name} not found`);
  let depth = 0;
  for (let i = head.index + head[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(head.index, text[i + 1] === ';' ? i + 2 : i + 1);
  }
  throw new Error(`definition of ${name} has no end`);
}

// every definition the entry points reach in the given files, callees and tables before their users
function cClosure(files, entries, skip) {
  const defined = new Map();
  for (const text of files)
    for (const m of text.matchAll(/^(?:static )?(?:const )?[\w *]+?\b(\w+)(?:\[[^\]]*\])*(?:\([^)]*\))?\s*=?\s*\n\{/gm)) if (!defined.has(m[1])) defined.set(m[1], text);
  const order = [];
  const seen = new Set(skip);
  const visit = (name) => {
    if (seen.has(name) || !defined.has(name)) return;
    seen.add(name);
    const body = cDefinition(defined.get(name), name);
    for (const id of new Set(body.match(/\b[A-Za-z_]\w*\b/g))) if (id !== name) visit(id);
    order.push(body);
  };
  entries.forEach(visit);
  const prototypes = order.filter((body) => /^[^=\n]*\)\s*\n\{/.test(body)).map((body) => `${body.split('\n')[0].trim()};`);
  return `${prototypes.join('\n')}\n\n${order.join('\n\n')}\n`;
}

// The send-out: the game's own throw arc and ball-open particle callbacks, pulled out of the fetched sources,
// compiled against tools/monanim's engine stub and run once per throw target and per ball; plus the release
// timing read from the same sources. The page plays the recording and these numbers, nothing else.
function buildSendOut(clang, tool) {
  const A = join(HERE, 'download', 'pret-anims');
  const read = (path) => readFileSync(join(A, path), 'utf8');
  const pokeball = read('src/pokeball.c');
  const mons = read('src/battle_anim_mons.c');
  const throwC = read('src/battle_anim_throw.c');
  const pick = (text, re, what) => {
    const m = re.exec(text);
    if (!m) throw new Error(`send-out: ${what} not found`);
    return m;
  };
  const start = pick(pokeball, /case POKEBALL_PLAYER_SENDOUT:[\s\S]*?\.x = (\d+);[\s\S]*?\.y = (\d+);/, 'player ball start').slice(1, 3).map(Number);
  // what tools/monanim/engine.c stands in for, never pulled from the game
  const ENGINE_STUBS = ['GetBattlerSpriteCoord', 'GetBattlerAtPosition', 'IsDoubleBattle', 'StartSpriteAffineAnim', 'StartSpriteAnim', 'CreateSprite', 'CreateTask', 'DestroyTask', 'DestroySprite', 'DestroySpriteAndFreeResources', 'Sin', 'Cos'];
  const TARGET_X = 72;
  const TARGET_Y = [60, 130];
  const out = join(tool, 'out');
  mkdirSync(out, { recursive: true });
  let recorded;
  try {
    const lines = (text, re) => [...text.matchAll(re)].map((m) => m[0]).join('\n');
    const game = [
      lines(read('include/pokeball.h'), /^enum\s*\{[\s\S]*?^\};/gm),
      lines(pokeball, /^#define (sBattler|HIBYTE)\b.*$/gm),
      lines(throwC, /^#define TAG_PARTICLES_\w+\s+\d+$/gm),
      'static void SpriteCB_ReleaseMonFromBall(struct Sprite *sprite) {}',
      'static void SpriteCB_ReleaseMon2FromBall(struct Sprite *sprite) {}',
      'static void DestroyBallOpenAnimationParticle(struct Sprite *sprite) { DestroySprite(sprite); }',
      cClosure([pokeball, mons], ['SpriteCB_PlayerMonSendOut_1', 'sAffineAnim_BallRotate'], ['SpriteCB_ReleaseMonFromBall', 'SpriteCB_ReleaseMon2FromBall', ...ENGINE_STUBS]),
      cClosure([throwC], ['sBallParticleAnimationFuncs', 'sBallParticleAnimNums'], ['DestroyBallOpenAnimationParticle', 'gBattleAnimSpriteGfx_Particles', 'gBattleAnimSpritePal_CircleImpact', ...ENGINE_STUBS]),
      // the catch shake the launcher ball repeats: its state enum, its macros and its two callbacks as written
      pick(throwC, /^enum \{\s*BALL_ROLL_1,[\s\S]*?^\};/m, 'shake states')[0],
      '#define SE_BALL 0\n#define BALL_3_SHAKES_SUCCESS 4',
      'static void SpriteCB_Ball_Release(struct Sprite *sprite) {}',
      'static void SpriteCB_Ball_Capture(struct Sprite *sprite) {}',
      'static void SpriteCB_Ball_Wobble_Step(struct Sprite *sprite);',
      (() => {
        const from = pick(throwC, /^#define sTimer data\[3\]\n#define sState data\[3\]/m, 'shake start').index;
        return throwC.slice(from, from + pick(throwC.slice(from), /^static void SpriteCB_Ball_Release\(struct Sprite \*sprite\)$/m, 'shake end').index);
      })(),
      '#define WOBBLE_START SpriteCB_Ball_Wobble',
      '#define PLAYER_THROW_START SpriteCB_PlayerMonSendOut_1',
      '#define BALL_ROTATION_TABLE sAffineAnim_BallRotate',
      '#define PARTICLE_TASKS sBallParticleAnimationFuncs',
    ].join('\n\n');
    const gameFile = join(out, 'sendout_game.c');
    writeFileSync(gameFile, game);
    const bin = join(out, 'sendout_rec');
    const cc = spawnSync(clang, ['-O1', '-w', `-I${join(tool, 'include')}`, `-I${join(A, 'include')}`, `-I${join(PE, 'include')}`, `-DSENDOUT_C="${gameFile}"`, join(tool, 'sendout_rec.c'), join(tool, 'engine.c'), join(A, 'src', 'trig.c'), '-o', bin], { encoding: 'utf8' });
    if (cc.status !== 0) throw new Error(`send-out compile failed:\n${cc.stderr}`);
    const run = spawnSync(bin, [start[0], start[1], TARGET_X, ...TARGET_Y].map(String), { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`send-out run failed: ${run.stderr || run.signal}`);
    recorded = JSON.parse(run.stdout);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const ballNames = [...pick(read('include/pokeball.h'), /enum\s*\{([\s\S]*?)POKEBALL_COUNT/, 'ball enum')[1].matchAll(/BALL_(\w+)/g)].map((m) => m[1].toLowerCase());
  const fadeTable = pick(throwC, /gBallOpenFadeColors\[\] =\s*\{([\s\S]*?)\};/, 'ball fade colours')[1];
  const tint = Object.fromEntries([...fadeTable.matchAll(/\[BALL_(\w+)\] = RGB\((\d+), (\d+), (\d+)\)/g)].map((m) => [m[1].toLowerCase(), [m[2], m[3], m[4]].map(Number)]));
  const openSeq = [...pick(pokeball, /sBallAnimSeq1\[\] =\s*\{([\s\S]*?)\};/, 'ball open sequence')[1].matchAll(/ANIMCMD_FRAME\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]) / 4, Number(m[2])]);
  const emerge = [...pick(read('src/data.c'), /sAffineAnim_Battler_Emerge\[\] =\s*\{([\s\S]*?)\};/, 'emerge')[1].matchAll(/AFFINEANIMCMD_FRAME\((\w+), \w+, \d+, (\d+)\)/g)];
  const fadeStep = Number(pick(read('src/palette.c'), /gPaletteFade\.deltaY = (\d+);/, 'palette fade step')[1]);
  const fadeLast = Number(pick(cDefinition(throwC, 'Task_FadeMon_ToNormal_Step'), /tTimer <= (\d+)/, 'mon fade length')[1]);
  const so = {
    start,
    targetX: TARGET_X,
    path: recorded.throw,
    particles: Object.fromEntries(ballNames.map((name, i) => [name, recorded.particles[i]])),
    wobble: recorded.wobble,
    ballBelow: Number(pick(cDefinition(pokeball, 'SpriteCB_PlayerMonSendOut_1'), /BATTLER_COORD_Y_PIC_OFFSET\) \+ (\d+);/, 'ball drop below the picture')[1]),
    sparksAbove: Number(pick(cDefinition(pokeball, 'SpriteCB_ReleaseMonFromBall'), /AnimateBallOpenParticles\(sprite->x, sprite->y - (\d+)/, 'burst above the ball')[1]),
    foeWait: Number(pick(cDefinition(pokeball, 'SpriteCB_OpponentMonSendOut'), /data\[0\] > (\d+)/, 'foe ball wait')[1]) + 1,
    open: openSeq,
    emerge: { from: Number(emerge[0][1]), step: Number(emerge[1][1]), frames: Number(emerge[1][2]) },
    rise: { from: Number(pick(pokeball, /\.data\[1\] = (0x[\dA-F]+);/i, 'rise start')[1]), step: Number(pick(pokeball, /data\[1\] -= (\d+);/, 'rise step')[1]) },
    tint: { colors: tint, hold: 16 / fadeStep + 2, frames: fadeLast + 1 },
    slide: { from: Number(pick(cDefinition(pokeball, 'StartHealthboxSlideIn'), /x2 = (0x[\dA-F]+|\d+);/i, 'slide start')[1]), step: Number(pick(cDefinition(pokeball, 'StartHealthboxSlideIn'), /sSpeedX = (\d+);/, 'slide speed')[1]) },
  };
  console.log(`send-out: ${Object.keys(so.path).length} throw targets, ${ballNames.length} particle bursts`);
  return so;
}
