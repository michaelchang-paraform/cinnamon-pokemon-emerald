#!/usr/bin/env node
// builds extension-audio/audio-sfx.css from the local pokeemerald clone: mid2agb song bytecode, the voicegroup
// entries each song selects, and the m4a tables the driver reads. `--check` prints sizes and writes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECOMP = join(HERE, 'download/pokeemerald');
const MID2AGB = join(HERE, 'tools/mid2agb');
const WAV2AGB = join(HERE, 'tools/wav2agb');
const CRY_CSS = (n) => join(HERE, `../../extension-audio/audio-cries-${n}.css`);
// each cry CSS file stays well under the 500,000 B cap
const CRY_FILE_TARGET = 470000;
const OUT_S = join(HERE, 'out');
const CSS_OUT = join(HERE, '../../extension-audio/audio-sfx.css');
const CSS_LIMIT = 500000;
const CHECK = process.argv.includes('--check');

// slice 1: the interface sounds, by songs.h constant
export const SLICE = ['SE_SELECT', 'SE_FAILURE', 'SE_WIN_OPEN', 'SE_BALL'];

const read = (p) => readFileSync(join(DECOMP, p), 'utf8');

function ensureTool(out, name, std) {
  if (existsSync(out)) return;
  mkdirSync(dirname(out), { recursive: true });
  const dir = join(DECOMP, `tools/${name}`);
  const sources = readFileSync(join(dir, 'Makefile'), 'utf8').match(/[\w]+\.cpp/g);
  execFileSync('c++', [`-std=${std}`, '-O2', '-o', out, ...new Set(sources)], { cwd: dir, stdio: 'inherit' });
}

// GAS integer expressions: + - * / and parentheses over numbers and .equ symbols, left to right by precedence
function evaluate(expr, symbols) {
  const tokens = expr.match(/0x[0-9a-fA-F]+|\d+|[A-Za-z_][\w]*|[-+*/()]/g) ?? [];
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = sum();
      i++;
      return v;
    }
    if (t === '-') return -atom();
    if (/^0x/i.test(t)) return parseInt(t, 16);
    if (/^\d/.test(t)) return parseInt(t, 10);
    if (!(t in symbols)) throw new Error(`unknown symbol ${t} in "${expr}"`);
    return symbols[t];
  };
  const product = () => {
    let v = atom();
    while (tokens[i] === '*' || tokens[i] === '/') v = tokens[i++] === '*' ? v * atom() : Math.trunc(v / atom());
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') v = tokens[i++] === '+' ? v + product() : v - product();
    return v;
  };
  return sum();
}

function equates(text, symbols = {}) {
  for (const m of text.matchAll(/^\s*\.equ\s+([\w]+)\s*,\s*([^@\n]+)/gm)) {
    if (!/^voicegroup_/.test(m[2].trim())) symbols[m[1]] = evaluate(m[2].trim(), symbols);
  }
  return symbols;
}

// assembles one mid2agb .s into a byte array; .word operands become absolute offsets in that array
function assemble(source, base) {
  const symbols = equates(source, { ...base });
  const bytes = [];
  const labels = {};
  const fixups = [];
  let header = null;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/@.*$/, '').trim();
    if (!line) continue;
    const label = line.match(/^([\w]+):$/);
    if (label) {
      labels[label[1]] = bytes.length;
      if (!header && /^[a-z_0-9]+$/.test(label[1]) && !/_\d+$/.test(label[1])) header = label[1];
      continue;
    }
    if (header) continue;
    const byte = line.match(/^\.byte\s+(.*)$/);
    if (byte) {
      for (const part of byte[1].split(',').map((s) => s.trim()).filter(Boolean)) bytes.push(evaluate(part, symbols) & 0xff);
      continue;
    }
    const word = line.match(/^\.word\s+([\w]+)$/);
    if (word) {
      fixups.push([bytes.length, word[1]]);
      bytes.push(0, 0, 0, 0);
    }
  }
  for (const [at, name] of fixups) {
    if (!(name in labels)) throw new Error(`unresolved ${name}`);
    const v = labels[name];
    bytes.splice(at, 4, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
  }
  const head = source.slice(source.indexOf(`${header}:`));
  const n = (key) => evaluate(head.match(new RegExp(`\\.byte\\s+([^@\\n]+)@ ${key}`))[1].trim(), symbols);
  const tracks = [...head.matchAll(/\.word\s+([\w]+)/g)].slice(1).map((m) => labels[m[1]]);
  const group = source.match(/\.equ\s+\w+_grp\s*,\s*voicegroup_(\w+)/)[1];
  return { bytes, tracks, priority: n('Priority'), reverb: n('Reverb\\.'), group };
}

// the twelve ToneData bytes a voicegroup macro emits (asm/macros/music_voice.inc)
function toneBytes(macro, args) {
  const num = (v) => Number(v);
  const pan = (p) => (num(p) ? 0x80 | num(p) : 0);
  switch (macro) {
    case 'voice_square_1':
    case 'voice_square_1_alt': {
      const [key, p, sweep, duty, a, d, s, r] = args.map(num);
      return [macro.endsWith('_alt') ? 9 : 1, key, pan(p), sweep, duty & 3, 0, 0, 0, a & 7, d & 7, s & 15, r & 7];
    }
    case 'voice_square_2':
    case 'voice_square_2_alt': {
      const [key, p, duty, a, d, s, r] = args.map(num);
      return [macro.endsWith('_alt') ? 10 : 2, key, pan(p), 0, duty & 3, 0, 0, 0, a & 7, d & 7, s & 15, r & 7];
    }
    case 'voice_noise':
    case 'voice_noise_alt': {
      const [key, p, period, a, d, s, r] = args.map(num);
      return [macro.endsWith('_alt') ? 12 : 4, key, pan(p), 0, period & 1, 0, 0, 0, a & 7, d & 7, s & 15, r & 7];
    }
    case 'voice_directsound':
    case 'voice_directsound_no_resample':
    case 'voice_directsound_reverse':
    case 'voice_directsound_compressed':
    case 'voice_directsound_compressed_reverse': {
      const type = { voice_directsound: 0, voice_directsound_no_resample: 0x08, voice_directsound_reverse: 0x10, voice_directsound_compressed: 0x20, voice_directsound_compressed_reverse: 0x30 }[macro];
      const [key, p, , a, d, s, r] = args;
      return [type, num(key), 0, pan(p), 0, 0, 0, 0, num(a), num(d), num(s), num(r)];
    }
    default:
      // wave and keysplit voices need data no slice uses yet, so fail loudly instead of guessing
      throw new Error(`voice macro ${macro} is not built yet`);
  }
}

function voicegroup(name) {
  const lines = read(`sound/voicegroups/${name}.inc`).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('voice_') && !l.startsWith('voice_group'));
  return lines.map((l) => {
    const [, macro, rest] = l.match(/^(\w+)\s+(.*)$/);
    return { macro, args: rest.split(',').map((s) => s.trim()) };
  });
}

// operand bytes after each command (m4a_1.s jump table after MPlayExtender); notes and EOT take optional operands
const OPERANDS = { 0xb2: 4, 0xb3: 4, 0xb5: 5, 0xb9: 3, 0xcc: 2 };
const XCMD_OPERANDS = { 0x01: 4, 0x0c: 2, 0x0d: 4 };

// every VOICE operand in the bytecode, read as the driver reads it: running status from VOICE (0xBD) upward
function voicesUsed(bytes) {
  const used = new Set();
  let running = 0;
  for (let i = 0; i < bytes.length; ) {
    let cmd = bytes[i];
    if (cmd < 0x80) cmd = running;
    else {
      i++;
      if (cmd >= 0xbd) running = cmd;
    }
    if (cmd <= 0xb0 || cmd === 0xb1 || cmd === 0xb4) continue;
    if (cmd >= 0xce) {
      for (let k = 0; k < (cmd === 0xce ? 1 : 3) && bytes[i] < 0x80; k++) i++;
      continue;
    }
    if (cmd === 0xcd) {
      const sub = bytes[i];
      i += 1 + (XCMD_OPERANDS[sub] ?? 1);
      continue;
    }
    if (cmd === 0xbd) used.add(bytes[i]);
    i += OPERANDS[cmd] ?? 1;
  }
  return [...used].sort((a, b) => a - b);
}

function cArray(name) {
  const body = read('src/m4a_tables.c').match(new RegExp(`${name}\\[\\]\\s*=\\s*\\{([^}]*)\\}`))[1];
  return body.split(',').map((s) => s.trim().replace(/u$/i, '')).filter(Boolean).map((s) => Number(s));
}

ensureTool(MID2AGB, 'mid2agb', 'c++11');
ensureTool(WAV2AGB, 'wav2agb', 'c++17');
mkdirSync(OUT_S, { recursive: true });
const base = equates(read('sound/MPlayDef.s'));
const cfg = read('sound/songs/midi/midi.cfg');
const songsH = read('include/constants/songs.h');
const songs = {};
const report = [];
for (const id of SLICE) {
  if (!new RegExp(`#define\\s+${id}\\s`).test(songsH)) throw new Error(`${id} is not in songs.h`);
  const file = id.toLowerCase();
  const flags = cfg.match(new RegExp(`^${file}\\.mid:(.*)$`, 'm'))[1].trim().split(/\s+/);
  const out = join(OUT_S, `${file}.s`);
  execFileSync(MID2AGB, [join(DECOMP, `sound/songs/midi/${file}.mid`), out, ...flags]);
  const song = assemble(readFileSync(out, 'utf8'), base);
  const group = voicegroup(song.group);
  const voices = {};
  for (const v of voicesUsed(song.bytes)) {
    const entry = group[v];
    voices[v] = toneBytes(entry.macro, entry.args);
    report.push(`  ${id} voice ${v}: ${entry.macro} ${entry.args.join(', ')}`);
  }
  songs[id] = { p: song.priority, r: song.reverb, t: song.tracks, b: Buffer.from(song.bytes).toString('base64'), v: voices };
  report.push(`${id}: ${song.bytes.length} B bytecode, ${song.tracks.length} track(s), group ${song.group}, flags ${flags.join(' ')}`);
}
const data = {
  v: 1,
  tables: {
    clock: cArray('gClockTable'),
    cgbScale: cArray('gCgbScaleTable'),
    cgbFreq: cArray('gCgbFreqTable'),
    noise: cArray('gNoiseTable'),
    cgb3Vol: cArray('gCgb3Vol'),
    scale: cArray('gScaleTable'),
    freq: cArray('gFreqTable'),
    delta: cArray('gDeltaEncodingTable'),
  },
  songs,
  cries: buildCries(),
};
// cries: one wav2agb .bin per national dex number (audio_rules.mk flags), base64 in --pe-cry-<n>, packed in order
function buildCries() {
  const names = [...read('include/constants/pokedex.h').matchAll(/^\s*NATIONAL_DEX_(\w+),/gm)].map((m) => m[1]).filter((n) => n !== 'NONE').slice(0, 386);
  const flags = read('audio_rules.mk').match(/\$\(WAV2AGB\) (-b -c[^$]*?)\$</)[1].trim().split(/\s+/);
  const macro = read('asm/macros/music_voice.inc').match(/\.macro cry sample:req\s*\n\s*(\w+)\s+([^\n]+)/);
  const tone = toneBytes(macro[1], macro[2].split(',').map((s) => s.trim()));
  const sound = read('src/sound.c').match(/void PlayCryInternal[\s\S]*?\n\}/)[0];
  const def = (name) => Number(sound.match(new RegExp(`\\b${name} = (\\d+);`))[1]);
  const constant = (name) => Number(read('include/constants/sound.h').match(new RegExp(`#define ${name}\\s+(\\d+)`))[1]);
  const outDir = join(OUT_S, 'cries');
  mkdirSync(outDir, { recursive: true });
  const files = [[]];
  let fileSize = 0;
  let total = 0;
  const index = {};
  const keys = {};
  names.forEach((name, i) => {
    const dex = i + 1;
    const file = name.toLowerCase();
    const bin = join(outDir, `${file}.bin`);
    execFileSync(WAV2AGB, [...flags, join(DECOMP, `sound/direct_sound_samples/cries/${file}.wav`), bin]);
    const line = `--pe-cry-${dex}: "${readFileSync(bin).toString('base64')}";`;
    if (fileSize + line.length > CRY_FILE_TARGET) {
      files.push([]);
      fileSize = 0;
    }
    files[files.length - 1].push(line);
    fileSize += line.length + 2;
    total += readFileSync(bin).length;
    index[dex] = files.length;
    keys[file.replace(/[^a-z0-9]/g, '')] = dex;
  });
  files.forEach((lines, i) => {
    const css = `/* generated by source/audio/build-audio.mjs from pret/pokeemerald cries; local only */\n.pe-audio-cries {\n  ${lines.join('\n  ')}\n}\n`;
    if (css.length > CSS_LIMIT) throw new Error(`audio-cries-${i + 1}.css would be ${css.length} B`);
    report.push(`audio-cries-${i + 1}.css ${css.length} B, ${lines.length} cries`);
    if (!CHECK) writeFileSync(CRY_CSS(i + 1), css);
  });
  report.push(`cries: ${names.length}, ${total} B of wav2agb ${flags.join(' ')} data, ${files.length} CSS files`);
  return {
    files: files.length,
    keys,
    // PlayCryInternal defaults (CRY_MODE_NORMAL) and PlayCry_ByMode's volume and priority
    params: { volume: constant('CRY_VOLUME'), priority: constant('CRY_PRIORITY_NORMAL'), pan: 0, pitch: def('pitch'), length: def('length'), release: def('release'), progress: 0, tone },
  };
}

const css = `/* generated by source/audio/build-audio.mjs from pret/pokeemerald; local only */\n.pe-audio-data { --pe-audio-sfx: "${Buffer.from(JSON.stringify(data)).toString('base64')}"; }\n`;
if (css.length > CSS_LIMIT) throw new Error(`audio-sfx.css would be ${css.length} B (limit ${CSS_LIMIT})`);
console.log(report.join('\n'));
console.log(`audio-sfx.css ${css.length} B`);
if (!CHECK) {
  writeFileSync(CSS_OUT, css);
  console.log(`wrote ${CSS_OUT}`);
}
