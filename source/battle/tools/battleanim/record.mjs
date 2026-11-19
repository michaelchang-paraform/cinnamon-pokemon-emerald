// Records every move animation by running the game's own anim engine (the fetched pokeemerald sources at the
// pinned commit) on the host: the decomp's preproc tool and clang's ARM assembler turn data/battle_anim_scripts.s
// into bytes, the anim and engine C files compile against host.c, and rec.c plays each script from both sides.
// Everything is built in `out` and deleted afterwards; only the recording leaves this function.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, readPal } from '../../lib/gba.mjs';

const TOOL = dirname(fileURLToPath(import.meta.url));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed:\n${(r.stderr || '').slice(0, 4000)}`);
  return r;
}

// the script bytes and, for every 4-byte field the assembler left to the linker, the symbol it names
function readElf(file) {
  const buf = readFileSync(file);
  const u16 = (o) => buf.readUInt16LE(o);
  const u32 = (o) => buf.readUInt32LE(o);
  const shoff = u32(0x20), shentsize = u16(0x2e), shnum = u16(0x30), shstrndx = u16(0x32);
  const secs = Array.from({ length: shnum }, (_, i) => {
    const o = shoff + i * shentsize;
    return { nameOff: u32(o), type: u32(o + 4), offset: u32(o + 16), size: u32(o + 20), link: u32(o + 24), info: u32(o + 28) };
  });
  const str = (sec, off) => {
    let s = '';
    for (let i = sec.offset + off; buf[i]; i++) s += String.fromCharCode(buf[i]);
    return s;
  };
  for (const s of secs) s.name = str(secs[shstrndx], s.nameOff);
  const dataIndex = secs.findIndex((s) => s.name === 'script_data');
  const data = buf.subarray(secs[dataIndex].offset, secs[dataIndex].offset + secs[dataIndex].size);
  const symtab = secs.find((s) => s.type === 2);
  const strtab = secs[symtab.link];
  const symbols = [];
  for (let o = symtab.offset; o < symtab.offset + symtab.size; o += 16) symbols.push({ name: str(strtab, u32(o)), value: u32(o + 4), shndx: u16(o + 14) });
  const relocs = [];
  const rel = secs.find((s) => s.type === 9 && s.info === dataIndex);
  for (let o = rel.offset; o < rel.offset + rel.size; o += 8) {
    const info = u32(o + 4);
    relocs.push({ at: u32(o), sym: symbols[info >> 8], type: info & 0xff });
  }
  const labels = Object.fromEntries(symbols.filter((s) => s.shndx === dataIndex && s.name).map((s) => [s.name, s.value]));
  return { data, relocs, labels, dataIndex };
}

// script_data as a C byte array whose pointer fields hold indices into a host pointer table
function scriptsToC(elf) {
  const bytes = Buffer.from(elf.data);
  const pointers = [];
  const index = new Map();
  for (const r of elf.relocs) {
    if (r.type !== 2) throw new Error(`unexpected relocation type ${r.type}`);
    const addend = bytes.readUInt32LE(r.at);
    const local = r.sym.shndx === elf.dataIndex;
    const expr = local ? `gSimScriptBlob + ${(r.sym.name ? elf.labels[r.sym.name] ?? r.sym.value : r.sym.value) + addend}` : `(const void *)&${r.sym.name}${addend ? ` + ${addend}` : ''}`;
    if (!index.has(expr)) index.set(expr, pointers.push(expr) - 1);
    bytes.writeUInt32LE(index.get(expr), r.at);
  }
  const externs = [...new Set(elf.relocs.filter((r) => r.sym.shndx !== elf.dataIndex).map((r) => r.sym.name))];
  // a table of script pointers runs from its label to the next label
  const tableEntries = (name) => {
    const start = elf.labels[name];
    const end = Math.min(...Object.values(elf.labels).filter((v) => v > start), bytes.length);
    const entries = [];
    for (let at = start; at < end && elf.relocs.some((x) => x.at === at); at += 4) entries.push(`(const u8 *)(${pointers[bytes.readUInt32LE(at)]})`);
    return entries;
  };
  const moveEntries = tableEntries('gBattleAnims_Moves');
  const moveCount = moveEntries.length;
  return [
    '#include "global.h"',
    ...externs.map((n) => `extern const char ${n}[];`),
    `const u8 gSimScriptBlob[${bytes.length}] = {${[...bytes].join(',')}};`,
    `const void *const gSimPtrs[${pointers.length}] = {${pointers.join(',\n')}};`,
    `const u8 *const gSimMoveScripts[${moveCount}] = {${moveEntries.join(',\n')}};`,
    `const u16 gSimMoveCount = ${moveCount};`,
    `const u8 *const gSimGeneralScripts[] = {${tableEntries('gBattleAnims_General').join(',\n')}};`,
    `const u8 *const gSimStatusScripts[] = {${tableEntries('gBattleAnims_StatusConditions').join(',\n')}};`,
  ].join('\n');
}

// a block of bytes as BIOS LZ77 data made only of literals, which the stand-in decompressor reads like the real one
function lzLiterals(bytes) {
  const out = [0x10, bytes.length & 255, (bytes.length >> 8) & 255, (bytes.length >> 16) & 255];
  for (let i = 0; i < bytes.length; i += 8) out.push(0, ...bytes.slice(i, i + 8));
  while (out.length % 4) out.push(0);
  return out;
}

// the bytes the game's build makes from a graphics source (gbagfx): 4bpp tiles from a PNG, RGB555 colours from a
// PNG or JASC palette, a tilemap as it is, each optionally LZ77 wrapped; null for what this does not convert
function gfxBytes(root, file, ext) {
  const kind = ext.replace(/\.lz$/, '');
  const path = join(root, file);
  if (!existsSync(path)) return null;
  let bytes;
  if (kind === '.4bpp' && file.endsWith('.png')) {
    const img = decodePng(path);
    bytes = [];
    for (let ty = 0; ty < img.height / 8; ty++)
      for (let tx = 0; tx < img.width / 8; tx++)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x += 2) {
            const at = (ty * 8 + y) * img.width + tx * 8 + x;
            bytes.push((img.pixels[at] & 15) | ((img.pixels[at + 1] & 15) << 4));
          }
  } else if (kind === '.gbapal') {
    const colors = file.endsWith('.pal') ? readPal(path) : decodePng(path).palette;
    bytes = colors.flatMap(([r, g, b]) => {
      const c = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
      return [c & 255, c >> 8];
    });
  } else if (kind === '' && file.endsWith('.bin')) bytes = [...readFileSync(path)];
  else return null;
  return ext.endsWith('.lz') ? lzLiterals(bytes) : bytes;
}

// every graphics symbol the sources define from a file: INCGFX_*("source", ".ext") or INCBIN_*("built.file")
function graphicsIndex(root) {
  const index = {};
  for (const f of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.c'))) {
    const text = readFileSync(join(root, 'src', f), 'utf8');
    for (const m of text.matchAll(/(\w+)\[\]\s*=\s*INCGFX_U\d+\("([^"]+)",\s*"([^"]+)"\)/g)) index[m[1]] = { file: m[2], ext: m[3] };
    for (const m of text.matchAll(/(\w+)\[\]\s*=\s*INCBIN_U\d+\("([^"]+)"\)/g)) {
      const [, base, ext] = /^(.+?)((?:\.4bpp|\.gbapal|\.bin)?(?:\.lz)?)$/.exec(m[2]);
      const file = ext.startsWith('.4bpp') ? `${base}.png` : ext.startsWith('.gbapal') ? (existsSync(join(root, `${base}.pal`)) ? `${base}.pal` : `${base}.png`) : `${base}.bin`;
      index[m[1]] = { file, ext: ext.replace(/^\.bin/, '') };
    }
  }
  return index;
}

// the build's sprite offsets probe: both battlers' pictures 16 px lower in turn, so each effect sprite's move
// says how much it follows the player's battler (k0) and the opponent's (k1), in quarters, packed into its flags
// above the recorder's own (bit 7 up)
const PROBE_DY = 16;
function anchorSprites(runs, probes) {
  const key = (r) => (r.j === undefined ? `${r.m}:${r.a}` : `j${r.j}`);
  const [moved0, moved1] = probes.map((list) => new Map(list.filter((r) => !r.fail).map((r) => [key(r), r])));
  for (const run of runs) {
    if (run.fail) continue;
    const p0 = moved0.get(key(run)), p1 = moved1.get(key(run));
    run.f.forEach((frame, f) => {
      const s0 = p0?.f[f]?.s, s1 = p1?.f[f]?.s;
      frame.s.forEach((sprite, i) => {
        const k = [s0, s1].map((list) => {
          const other = list?.[i];
          if (!other || other[0] !== sprite[0] || list.length !== frame.s.length) return 0;
          return Math.max(0, Math.min(4, Math.round(((other[4] - sprite[4]) / PROBE_DY) * 4)));
        });
        sprite[9] |= (k[0] * 5 + k[1]) << 7;
      });
    });
  }
}

// the general and status scripts the page plays, from both sides, named as the page asks for them: s:<Status>,
// g:<General>, a stat change per stat and step (g:StatsChange:atk+1) and a trapping move per move (g:TurnTrap:clamp)
function effectJobs(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const constant = (text, name) => Number(new RegExp(`#define ${name}\\s+(\\d+)`).exec(text)[1]);
  const labelsOf = (table) => {
    const text = read('data/battle_anim_scripts.s').split(`${table}::`)[1];
    return [...text.split(/\n\w+::/)[0].matchAll(/\.4byte (\w+)/g)].map((m) => m[1]);
  };
  const animH = read('include/battle_anim.h'), pokemonH = read('include/constants/pokemon.h'), movesH = read('include/constants/moves.h');
  const jobs = [];
  const add = (table, id, name, arg = 0, self = false) => {
    for (const a of [0, 1]) jobs.push({ table, id, a, t: self ? a : a ^ 1, arg, name });
  };
  labelsOf('gBattleAnims_StatusConditions').forEach((label, id) => add('s', id, label.replace(/^Status_/, 's:'), 0, true));
  labelsOf('gBattleAnims_General').forEach((label, id) => {
    const name = label.replace(/^General_/, 'g:');
    if (name === 'g:StatsChange') {
      const stats = { ATK: 'atk', DEF: 'def', SPEED: 'spe', SPATK: 'spa', SPDEF: 'spd', ACC: 'accuracy', EVASION: 'evasion' };
      for (const [step, kind] of [['+1', 'PLUS1'], ['+2', 'PLUS2'], ['-1', 'MINUS1'], ['-2', 'MINUS2']])
        for (const [stat, id2] of Object.entries(stats)) add('g', id, `${name}:${id2}${step}`, constant(animH, `STAT_ANIM_${kind}`) + constant(pokemonH, `STAT_${stat}`), true);
    } else if (name === 'g:TurnTrap') {
      add('g', id, name);
      for (const move of ['FIRE_SPIN', 'WHIRLPOOL', 'CLAMP', 'SAND_TOMB']) add('g', id, `${name}:${move.toLowerCase().replace('_', '')}`, constant(movesH, `MOVE_${move}`));
    } else add('g', id, name);
  });
  return jobs;
}

export function recordMoveAnims({ root, out, moves }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'inc', 'gba'), { recursive: true });
  try {
    // the decomp's own script preprocessor, then clang's assembler for the GBA's 32-bit ARM
    const preproc = join(out, 'preproc');
    run('c++', ['-O2', '-std=c++17', '-w', '-o', preproc, ...readdirSync(join(root, 'tools', 'preproc')).filter((f) => f.endsWith('.cpp')).map((f) => join(root, 'tools', 'preproc', f))]);
    writeFileSync(join(out, 'inc', 'map_groups.h'), '#define MAP_GROUPS_COUNT 1\n');
    const stage1 = run(preproc, ['data/battle_anim_scripts.s', 'charmap.txt'], { cwd: root }).stdout;
    const stage2 = run('clang', ['-E', '-x', 'assembler-with-cpp', '-I', join(out, 'inc'), '-I', 'include', '-I', '.', '-'], { cwd: root, input: stage1 }).stdout;
    const stage3 = run(preproc, ['-ie', 'data/battle_anim_scripts.s', 'charmap.txt'], { cwd: root, input: stage2 }).stdout;
    writeFileSync(join(out, 'scripts.s'), stage3);
    run('clang', ['-target', 'armv7-none-eabi', '-c', '-x', 'assembler', join(out, 'scripts.s'), '-I', root, '-I', join(root, 'asm'), '-I', join(root, 'include'), '-o', join(out, 'scripts.o')]);
    writeFileSync(join(out, 'scripts_host.c'), scriptsToC(readElf(join(out, 'scripts.o'))));
    // host builds: no GBA memory sections; the interpreter's pointer reads go through the pointer table
    // and video memory, palette RAM, OAM and the I/O registers live in host arrays (host.c)
    const hostMemory = (text) =>
      text
        .replace(/__attribute__\(\(section\("\w+"\)\)\)/g, '')
        .replace(/^#define (PLTT|VRAM|OAM|REG_BASE)\s+0x[0-9A-Fa-f]+.*$/gm, (_, name) => `extern unsigned char gSim_${name}[];\n#define ${name} ((unsigned long)gSim_${name})`);
    writeFileSync(join(out, 'inc', 'gba', 'defines.h'), hostMemory(readFileSync(join(root, 'include', 'gba', 'defines.h'), 'utf8')));
    writeFileSync(join(out, 'inc', 'gba', 'io_reg.h'), hostMemory(readFileSync(join(root, 'include', 'gba', 'io_reg.h'), 'utf8')));
    // register offsets written as differences of addresses, which are no longer constants on the host
    writeFileSync(join(out, 'inc', 'scanline_effect.h'), readFileSync(join(root, 'include', 'scanline_effect.h'), 'utf8').replace(/REG_ADDR_(\w+) - REG_ADDR_(\w+)/g, 'REG_OFFSET_$1 - REG_OFFSET_$2'));
    const interp = readFileSync(join(root, 'src', 'battle_anim.c'), 'utf8').replace(/\bT2_READ_32\(/g, 'SIM_READ_PTR(').replace(/\bT2_READ_PTR\(/g, '(void *)SIM_READ_PTR(');
    const traced = interp.replace(/(\n\s*)CreateSpriteAndAnimate\(\n(\s*)template,/, '$1gSimLastTemplate = template;$1CreateSpriteAndAnimate(\n$2template,');
    writeFileSync(join(out, 'battle_anim.c'), `extern const void *const gSimPtrs[];\nconst void *gSimLastTemplate;\n#define SIM_READ_PTR(p) ((uintptr_t)gSimPtrs[T1_READ_32(p)])\n${traced}`);
    // x86_64 under Rosetta with the image below 4 GB: the game keeps code and data pointers in pairs of 16-bit
    // sprite and task fields, which only round-trip when every such address fits in 32 bits
    const ARCH = ['-arch', 'x86_64'];
    const flags = [...ARCH, '-c', '-w', '-O1', '-g', '-DMODERN=1', '-DINCGFX_U8(...)={0}', '-DINCGFX_U16(...)={0}', '-DINCGFX_U32(...)={0}', `-I${join(out, 'inc')}`, `-I${join(root, 'include')}`, `-I${join(root, 'src')}`, `-I${root}`];
    // a 32-bit address kept as two signed halves: the low half must not sign-extend into the high one when
    // rebuilt, which on the GBA only held because of where its RAM sits
    const halves = (text) =>
      text.replace(/(?:\(u16\)\s*)?(\b(?:sprite|gTasks\[[^\]]+\])(?:->|\.)\w+(?:\[[^\]]+\])?)\s*\|\s*\((\b(?:sprite|gTasks\[[^\]]+\])(?:->|\.)\w+(?:\[[^\]]+\])?)\s*<<\s*16\)/g, '((u16)($1) | ((u32)(u16)($2) << 16))');
    mkdirSync(join(out, 'src'), { recursive: true });
    const gameFiles = [
      ...readdirSync(join(root, 'src')).filter((f) => /^battle_anim_.+\.c$/.test(f)),
      ...['sprite.c', 'task.c', 'palette.c', 'gpu_regs.c', 'trig.c', 'random.c', 'malloc.c', 'bg.c', 'scanline_effect.c'],
    ].map((f) => {
      const copy = join(out, 'src', f);
      // bg.c only takes tilemap buffers below the end of the GBA's work RAM, which host buffers are not
      const text = readFileSync(join(root, 'src', f), 'utf8').replace('sGpuBgConfigs2[bg].tilemap > (void *)IWRAM_END', 'FALSE');
      writeFileSync(copy, halves(text));
      return copy;
    });
    writeFileSync(join(out, 'battle_anim.c'), halves(readFileSync(join(out, 'battle_anim.c'), 'utf8')));
    // the battle's BG layer layout, from battle_bg.c (which itself is not built)
    const templates = /gBattleBgTemplates\[\]\s*=\s*(\{[\s\S]*?\n\});/.exec(readFileSync(join(root, 'src', 'battle_bg.c'), 'utf8'))[1];
    writeFileSync(join(out, 'sim_bg.c'), `#include "global.h"\n#include "bg.h"\nconst struct BgTemplate gSimBattleBgTemplates[4] = ${templates};\n`);
    const sources = [
      join(out, 'battle_anim.c'),
      join(out, 'sim_bg.c'),
      ...gameFiles,
      join(out, 'scripts_host.c'),
      join(TOOL, 'host.c'),
      join(TOOL, 'rec.c'),
    ];
    const objects = sources.map((file, i) => {
      const obj = join(out, `o${i}.o`);
      run('clang', [...flags, file, '-o', obj]);
      return obj;
    });
    // everything still unresolved is a function returning 0 or a zeroed block of data
    const LOW = ['-Wl,-pagezero_size,0x1000', '-Wl,-image_base,0x400000', '-Wl,-no_pie'];
    const probe = run('clang', [...ARCH, ...LOW, ...objects, '-o', join(out, 'probe')], { allowFail: true });
    const missing = [...new Set([...(probe.stderr || '').matchAll(/^\s+"_(\w+)", referenced from:/gm)].map((m) => m[1]))];
    const headers = readdirSync(join(root, 'include')).filter((f) => f.endsWith('.h')).map((f) => readFileSync(join(root, 'include', f), 'utf8')).join('\n');
    // graphics get the bytes the game's build makes from their sources, except effect sprite sheets, which the
    // page draws from the sheets themselves
    const gfx = graphicsIndex(root);
    const stubs = missing.map((name) => {
      if (new RegExp(`\\b${name}\\s*\\(`).test(headers)) return `long ${name}() { return 0; }`;
      const source = gfx[name];
      const bytes = source && !(source.file.startsWith('graphics/battle_anims/sprites/') && source.ext.startsWith('.4bpp')) && gfxBytes(root, source.file, source.ext);
      if (bytes) return `unsigned char ${name}[${Math.max(bytes.length, 0x10000)}] __attribute__((aligned(16))) = {${bytes.join(',')}};`;
      return `char ${name}[0x10000] __attribute__((aligned(16)));`;
    });
    writeFileSync(join(out, 'stubs.c'), stubs.join('\n'));
    run('clang', [...ARCH, '-c', '-w', '-O1', join(out, 'stubs.c'), '-o', join(out, 'stubs.o')]);
    const bin = join(out, 'battleanim');
    run('clang', [...ARCH, ...LOW, ...objects, join(out, 'stubs.o'), '-o', bin]);
    const jobs = effectJobs(root);
    const jobInput = jobs.map((j) => `${j.table} ${j.id} ${j.a} ${j.t} ${j.arg}`).join('\n');
    const record = (env, args, input) =>
      run('arch', ['-x86_64', bin, ...args], { timeout: 1800000, env: { ...process.env, ...env }, input })
        .stdout.split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const recordBoth = (args, input) => {
      const runs = record({}, args, input);
      anchorSprites(runs, [record({ SIM_DY: `${PROBE_DY},0` }, args, input), record({ SIM_DY: `0,${PROBE_DY}` }, args, input)]);
      return runs;
    };
    const moveRuns = recordBoth(moves ? moves.map(String) : [], undefined);
    const effects = moves ? [] : recordBoth(['jobs'], jobInput).map((r) => ({ ...r, name: jobs[r.j].name }));
    return { moves: moveRuns, effects };
  } finally {
    if (!process.env.KEEP_ANIM_BUILD) rmSync(out, { recursive: true, force: true });
  }
}
