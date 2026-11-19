#!/usr/bin/env node
// builds extension-audio/audio-sfx.css from the local pokeemerald clone: mid2agb song bytecode, the voicegroup
// entries each song selects, and the m4a tables the driver reads. `--check` prints sizes and writes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
export const SLICE = ['SE_SELECT', 'SE_FAILURE', 'SE_WIN_OPEN', 'SE_BALL', 'SE_EXP', 'SE_SHINY', 'SE_EXP_MAX'];
// battle effects outside move animations: ball, damage, faint, low HP, flee and stat change
export const BATTLE_SFX = ['SE_BALL_OPEN', 'SE_BALL_THROW', 'SE_BALL', 'SE_M_STAT_INCREASE', 'SE_M_STAT_DECREASE', 'SE_EFFECTIVE', 'SE_SUPER_EFFECTIVE', 'SE_NOT_EFFECTIVE', 'SE_FAINT', 'SE_LOW_HEALTH', 'SE_FLEE'];
// turn-end animations the battle shows: sandstorm damage, and Wrap, Bind or Fire Spin damage (General_TurnTrap)
export const GENERAL_ANIMS = { sandstorm: 'General_Sandstorm', trap: 'General_TurnTrap' };
export const STATUS_ANIMS = { sleep: 'Status_Sleep', poison: 'Status_Poison', burn: 'Status_Burn', paralysis: 'Status_Paralysis', freeze: 'Status_Freeze', confusion: 'Status_Confusion' };

// every SE_* an animation script reaches from `label`, following the labels it calls or jumps to
let animBlocks = null;
function animSes(label, seen = new Set()) {
  if (!animBlocks) {
    animBlocks = {};
    let cur = null;
    for (const line of read('data/battle_anim_scripts.s').split('\n')) {
      const m = line.match(/^(\w+):/);
      if (m) animBlocks[(cur = m[1])] = [];
      else if (cur) animBlocks[cur].push(line.replace(/@.*$/, ''));
    }
  }
  if (seen.has(label) || !animBlocks[label]) return new Set();
  seen.add(label);
  const out = new Set();
  for (const line of animBlocks[label]) {
    for (const m of line.matchAll(/\b(SE_[A-Z0-9_]+)\b/g)) out.add(m[1]);
    for (const m of line.matchAll(/\b([A-Z][A-Za-z0-9_]+)\b/g)) if (!m[1].startsWith('SE_') && animBlocks[m[1]]) for (const se of animSes(m[1], seen)) out.add(se);
  }
  return out;
}

// battle-moves.json lists the Showdown gen3randombattle moves; each maps to its Move_ label by name
function moveLabels() {
  const moves = JSON.parse(readFileSync(join(HERE, 'battle-moves.json'), 'utf8')).moves;
  animSes('__init__');
  return Object.keys(moves).map((id) => {
    const label = Object.keys(animBlocks).find((l) => l.startsWith('Move_') && l.slice(5).replace(/_/g, '') === id.toUpperCase());
    if (!label) throw new Error(`no animation script for move ${id}`);
    return [id, label];
  });
}

let usesCache = null;
function sfxUses() {
  if (usesCache) return usesCache;
  const uses = {};
  const entry = (se) => (uses[se] ??= { moves: [], status: [], general: [], battle: false });
  for (const [id, label] of moveLabels()) for (const se of animSes(label)) entry(se).moves.push(id);
  for (const [name, label] of Object.entries(STATUS_ANIMS)) for (const se of animSes(label)) entry(se).status.push(name);
  for (const [name, label] of Object.entries(GENERAL_ANIMS)) for (const se of animSes(label)) entry(se).general.push(name);
  for (const se of BATTLE_SFX) entry(se).battle = true;
  return (usesCache = uses);
}

function sfxIds() {
  return [...new Set([...SLICE, ...Object.keys(sfxUses())])];
}

// battle music: every track GetBattleBGM (pokemon.c) can pick, the victory tracks HandleEndTurn_BattleWon
// (battle_main.c) and Cmd_getexp (battle_script_commands.c) play, and the level-up fanfare
export const MUSIC = [
  'MUS_VS_TRAINER', 'MUS_VICTORY_TRAINER', 'MUS_LEVEL_UP', 'MUS_EVOLVED',
  'MUS_VS_WILD', 'MUS_VICTORY_WILD',
  'MUS_VS_GYM_LEADER', 'MUS_VICTORY_GYM_LEADER',
  'MUS_VS_ELITE_FOUR', 'MUS_VS_CHAMPION', 'MUS_VICTORY_LEAGUE',
  'MUS_VS_RIVAL', 'MUS_VS_AQUA_MAGMA', 'MUS_VS_AQUA_MAGMA_LEADER', 'MUS_VICTORY_AQUA_MAGMA',
  'MUS_VS_KYOGRE_GROUDON', 'MUS_VS_REGI', 'MUS_VS_RAYQUAZA', 'MUS_VS_FRONTIER_BRAIN',
];
const MUSIC_FILE_TARGET = 470000;

const read = (p) => readFileSync(join(DECOMP, p), 'utf8');

function ensureTool(out, name, std) {
  if (existsSync(out)) return;
  mkdirSync(dirname(out), { recursive: true });
  const dir = join(DECOMP, `tools/${name}`);
  const sources = readdirSync(dir).filter((f) => f.endsWith('.cpp')).sort();
  if (!sources.length) throw new Error(`no .cpp sources in ${dir}`);
  execFileSync('c++', [`-std=${std}`, '-O2', '-o', out, ...sources], { cwd: dir, stdio: 'inherit' });
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
  // the song header carries the .global name; track labels add _1, _2 and so on, and some song names end in a digit
  const globalName = source.match(/\.global\s+(\w+)/)[1];
  for (const raw of source.split('\n')) {
    const line = raw.replace(/@.*$/, '').trim();
    if (!line) continue;
    const label = line.match(/^([\w]+):$/);
    if (label) {
      labels[label[1]] = bytes.length;
      if (label[1] === globalName) header = label[1];
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
const report = [];
const sfx = buildSet(sfxIds(), 'sfx', base, cfg, songsH);
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
  songs: sfx.head.songs,
  sfx: { tones: sfx.head.tones, splits: sfx.head.splits, waves: sfx.head.waves, files: sfx.files, samples: sfx.samples, interface: SLICE, uses: sfxUses() },
  cries: buildCries(),
  music: buildSet(MUSIC, 'music', base, cfg, songsH),
};
// the whole voicegroup area as the ROM lays it out (voice_groups.inc include order), so an index past a group's
// own entries reads the next group, as the driver does; labels with a starting note point before their data
function voiceMemory() {
  const tones = [];
  const labels = {};
  for (const inc of read('sound/voice_groups.inc').matchAll(/\.include "([^"]+)"/g)) {
    for (const raw of read(inc[1]).split('\n')) {
      const line = raw.replace(/@.*$/, '').trim();
      const group = line.match(/^voice_group\s+(\w+)(?:\s*,\s*(\d+))?/);
      if (group) {
        labels[`voicegroup_${group[1]}`] = tones.length - Number(group[2] ?? 0);
        continue;
      }
      const voice = line.match(/^(voice_\w+|cry\w*)\s+(.*)$/);
      if (voice) tones.push({ macro: voice[1], args: voice[2].split(',').map((a) => a.trim()) });
    }
  }
  const splitBytes = [];
  const splits = {};
  let last = 0;
  for (const raw of read('sound/keysplit_tables.inc').split('\n')) {
    const line = raw.replace(/@.*$/, '').trim();
    const table = line.match(/^keysplit\s+(\w+)(?:\s*,\s*(\d+))?/);
    if (table) {
      last = Number(table[2] ?? 0);
      splits[`keysplit_${table[1]}`] = splitBytes.length - last;
      continue;
    }
    const split = line.match(/^split\s+(\d+)\s*,\s*(\d+)/);
    if (split) {
      for (let n = last; n < Number(split[2]); n++) splitBytes.push(Number(split[1]));
      last = Number(split[2]);
    }
  }
  const samples = Object.fromEntries([...read('sound/direct_sound_data.inc').matchAll(/^(\w+)::[^\n]*\n\s*\.incbin\s+"(sound\/direct_sound_samples\/[\w/]+)\.bin"/gm)].map((m) => [m[1], m[2]]));
  const waves = Object.fromEntries([...read('sound/programmable_wave_data.inc').matchAll(/^(\w+)::\s*\n\s*\.incbin\s+"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  return { tones, labels, splitBytes, splits, samples, waves };
}

// the (voice, key) pairs a track can reach, following GOTO, PATT/PEND and both ways out of REPT, without timing
function notesUsed(bytes, starts) {
  const used = new Map();
  const word = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
  for (const start of starts) {
    const work = [{ ptr: start, voice: 0, stack: [], running: 0, key: 60 }];
    const seen = new Set();
    while (work.length) {
      const st = work.pop();
      for (let guard = 0; guard < 200000; guard++) {
        const id = `${st.ptr}:${st.voice}:${st.stack.join(',')}:${st.running}:${st.key}`;
        if (seen.has(id)) break;
        seen.add(id);
        let cmd = bytes[st.ptr];
        if (cmd === undefined) break;
        if (cmd < 0x80) cmd = st.running;
        else {
          st.ptr++;
          if (cmd >= 0xbd) st.running = cmd;
        }
        if (cmd <= 0xb0) continue;
        if (cmd >= 0xce) {
          if (bytes[st.ptr] < 0x80) st.key = bytes[st.ptr++];
          if (cmd !== 0xce) {
            for (let k = 0; k < 2 && bytes[st.ptr] < 0x80; k++) st.ptr++;
            if (!used.has(st.voice)) used.set(st.voice, new Set());
            used.get(st.voice).add(st.key);
          }
          continue;
        }
        if (cmd === 0xb2) st.ptr = word(st.ptr);
        else if (cmd === 0xb3) {
          if (st.stack.length >= 3) break;
          st.stack = [...st.stack, st.ptr + 4];
          st.ptr = word(st.ptr);
        } else if (cmd === 0xb4) {
          if (st.stack.length) {
            st.ptr = st.stack[st.stack.length - 1];
            st.stack = st.stack.slice(0, -1);
          }
        } else if (cmd === 0xb5) {
          work.push({ ...st, stack: [...st.stack], ptr: word(st.ptr + 1) });
          st.ptr += 5;
        } else if (cmd === 0xbd) st.voice = bytes[st.ptr++];
        else if (cmd === 0xcd) st.ptr += 1 + (XCMD_OPERANDS[bytes[st.ptr]] ?? 1);
        else if ([0xb1, 0xb6, 0xb7, 0xb8, 0xc6, 0xc7, 0xc9, 0xca, 0xcb].includes(cmd)) break;
        else st.ptr += OPERANDS[cmd] ?? 1;
      }
    }
  }
  return used;
}

// songs plus the tones, key split tables, DirectSound samples and wave RAM images they reach. Music packs the
// samples after the song data in audio-music-N.css; effects keep the song data in audio-sfx.css and the samples in
// audio-sfx-samples-N.css, one property each, so a page decodes only the samples an effect uses
function buildSet(ids, kind, base, cfg, songsH) {
  const mem = voiceMemory();
  const tones = {};
  const sampleNames = new Set();
  const waveNames = new Set();
  const splitsUsed = {};
  const toneRecord = (index) => {
    if (tones[index]) return tones[index];
    const entry = mem.tones[index];
    if (!entry) throw new Error(`voice memory has no entry ${index}`);
    let rec;
    if (entry.macro === 'voice_keysplit' || entry.macro === 'voice_keysplit_all') {
      const g = mem.labels[entry.args[0]];
      if (g === undefined) throw new Error(`no ${entry.args[0]}`);
      rec = { b: [entry.macro === 'voice_keysplit' ? 0x40 : 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], g };
      if (entry.macro === 'voice_keysplit') {
        const at = mem.splits[entry.args[1]];
        if (at === undefined) throw new Error(`no ${entry.args[1]}`);
        rec.k = entry.args[1];
        splitsUsed[entry.args[1]] ??= Array.from({ length: 128 }, (_, key) => mem.splitBytes[at + key] ?? 0);
      }
    } else if (entry.macro.startsWith('voice_programmable_wave')) {
      const [key, p, wave, a, d, s2, r] = entry.args;
      if (!mem.waves[wave]) throw new Error(`no ${wave}`);
      waveNames.add(wave);
      rec = { b: [entry.macro.endsWith('_alt') ? 11 : 3, Number(key), Number(p) ? 0x80 | Number(p) : 0, 0, 0, 0, 0, 0, Number(a) & 7, Number(d) & 7, Number(s2) & 15, Number(r) & 7], w: wave };
    } else {
      rec = { b: toneBytes(entry.macro, entry.args) };
      if (entry.macro.startsWith('voice_directsound')) {
        if (!mem.samples[entry.args[2]]) throw new Error(`no ${entry.args[2]}`);
        rec.s = entry.args[2];
        sampleNames.add(entry.args[2]);
      }
    }
    tones[index] = rec;
    return rec;
  };
  const songs = {};
  for (const id of ids) {
    if (!new RegExp(`#define\\s+${id}\\s`).test(songsH)) throw new Error(`${id} is not in songs.h`);
    const file = id.toLowerCase();
    const flags = cfg.match(new RegExp(`^${file}\\.mid:(.*)$`, 'm'))[1].trim().split(/\s+/);
    const out = join(OUT_S, `${file}.s`);
    execFileSync(MID2AGB, [join(DECOMP, `sound/songs/midi/${file}.mid`), out, ...flags]);
    const song = assemble(readFileSync(out, 'utf8'), base);
    const groupBase = mem.labels[`voicegroup_${song.group}`];
    const v = {};
    const sn = new Set();
    for (const [voice, keys] of notesUsed(song.bytes, song.tracks)) {
      const index = groupBase + voice;
      const rec = toneRecord(index);
      v[voice] = index;
      if (rec.s) sn.add(rec.s);
      if (rec.b[0] & 0xc0) {
        for (const key of keys) {
          const sub = rec.b[0] & 0x40 ? rec.g + splitsUsed[rec.k][key] : rec.g + key;
          if (mem.tones[sub]) {
            const subRec = toneRecord(sub);
            if (subRec.s) sn.add(subRec.s);
          }
        }
      }
    }
    songs[id] = { p: song.priority, r: song.reverb, t: song.tracks, b: Buffer.from(song.bytes).toString('base64'), v, sn: [...sn] };
    report.push(`${id}: ${song.bytes.length} B bytecode, ${song.tracks.length} tracks, group ${song.group}, reverb ${song.reverb & 0x7f}, ${Object.keys(v).length} voices`);
  }
  const samples = {};
  let rawBytes = 0;
  for (const name of sampleNames) {
    const bin = join(OUT_S, 'samples', `${name}.bin`);
    mkdirSync(dirname(bin), { recursive: true });
    execFileSync(WAV2AGB, ['-b', join(DECOMP, `${mem.samples[name]}.wav`), bin]);
    const bytes = readFileSync(bin);
    rawBytes += bytes.length;
    samples[name] = bytes.toString('base64');
  }
  const waves = Object.fromEntries([...waveNames].map((name) => [name, [...readFileSync(join(DECOMP, mem.waves[name]))]]));
  report.push(`${kind}: ${ids.length} songs, ${sampleNames.size} samples (${rawBytes} B), ${waveNames.size} waves, ${Object.keys(tones).length} tones, ${Object.keys(splitsUsed).length} key split tables`);
  const head = { songs, tones, splits: splitsUsed, waves };
  const prefix = kind === 'music' ? 'audio-music' : 'audio-sfx-samples';
  const cssPath = (n) => join(HERE, `../../extension-audio/${prefix}-${n}.css`);
  // music: songs, tones, splits and waves first in file 1; then the samples over as many files as the cap needs
  const files = kind === 'music' ? [[`--pe-music: "${Buffer.from(JSON.stringify(head)).toString('base64')}";`]] : [[]];
  let size = files[0].reduce((sum, l) => sum + l.length, 0);
  for (const [name, b64] of Object.entries(samples)) {
    const line = kind === 'music' ? `--pe-music-${name}: "${b64}";` : `--pe-sfx-${name}: "${b64}";`;
    if (size + line.length > MUSIC_FILE_TARGET) {
      files.push([]);
      size = 0;
    }
    files[files.length - 1].push(line);
    size += line.length + 2;
  }
  if (!CHECK) {
    // the manifest lists exactly the CSS files this build wrote for this set
    const manifestPath = join(HERE, '../../extension-audio/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const own = new RegExp(`^${prefix}-\\d+\\.css$`);
    manifest.css = [...manifest.css.filter((f) => !own.test(f)), ...files.map((_, i) => `${prefix}-${i + 1}.css`)];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (let n = files.length + 1; existsSync(cssPath(n)); n++) unlinkSync(cssPath(n));
  }
  files.forEach((lines, i) => {
    const css = `/* generated by source/audio/build-audio.mjs from pret/pokeemerald ${kind}; local only */\n.pe-${prefix} {\n  ${lines.join('\n  ')}\n}\n`;
    if (css.length > CSS_LIMIT) throw new Error(`${prefix}-${i + 1}.css would be ${css.length} B`);
    report.push(`${prefix}-${i + 1}.css ${css.length} B`);
    if (!CHECK) writeFileSync(cssPath(i + 1), css);
  });
  const result = { files: files.length, samples: Object.keys(samples), ids: Object.keys(songs) };
  return kind === 'music' ? result : { ...result, head };
}

function cryMode(sound, mode) {
  const body = sound.match(new RegExp(`case ${mode}:([\\s\\S]*?)(?:break;|case CRY_MODE_)`))[1];
  const out = Object.fromEntries([...body.matchAll(/\b(length|release|pitch|chorus|volume) = (\d+);/g)].map((m) => [m[1], Number(m[2])]));
  if (/\breverse = TRUE;/.test(body)) out.reverse = true;
  return out;
}

// cries: one wav2agb .bin per national dex number (audio_rules.mk flags), base64 in --pe-cry-<n>, packed in order
function buildCries() {
  const names = [...read('include/constants/pokedex.h').matchAll(/^\s*NATIONAL_DEX_(\w+),/gm)].map((m) => m[1]).filter((n) => n !== 'NONE').slice(0, 386);
  const flags = read('audio_rules.mk').match(/\$\(WAV2AGB\) (-b -c[^$]*?)\$</)[1].trim().split(/\s+/);
  const macros = read('asm/macros/music_voice.inc');
  const toneOf = (name) => {
    const m = macros.match(new RegExp(`\\.macro ${name} sample:req\\s*\\n\\s*(\\w+)\\s+([^\\n]+)`));
    return toneBytes(m[1], m[2].split(',').map((x) => x.trim()));
  };
  const tone = toneOf('cry');
  const toneReverse = toneOf('cry_reverse');
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
    params: { volume: constant('CRY_VOLUME'), priority: constant('CRY_PRIORITY_NORMAL'), pan: 0, pitch: def('pitch'), length: def('length'), release: def('release'), chorus: def('chorus'), reverse: false, progress: 0, tone, toneReverse },
    // what PlayCryInternal's switch changes per mode (the weak, faint, battle animation and double-battle cries)
    modes: Object.fromEntries(['WEAK', 'FAINT', 'DOUBLES', 'HIGH_PITCH', 'ECHO_START', 'ECHO_END', 'ROAR_1', 'ROAR_2', 'GROWL_1', 'GROWL_2'].map((m) => [m.toLowerCase(), cryMode(sound, `CRY_MODE_${m}`)])),
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
