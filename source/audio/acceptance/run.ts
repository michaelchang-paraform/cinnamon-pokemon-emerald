// Acceptance test for any pokemon-audio engine build: loads the extension's page files (in manifest order) under
// stand-ins for the browser APIs they use, drives only the public window.__peAudio API, captures every buffer the
// extension would play, and compares SHA-256 hashes with a recorded set. See README.md.
//
//   bun source/audio/acceptance/run.ts [--ext <extension dir>] [--expect <hashes.json>] [--write <hashes.json>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name: string, fallback: string | null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const EXT = argOf('--ext', join(HERE, '../../../extension-audio'))!;
const EXPECT = argOf('--expect', join(HERE, 'golden.json'));
const WRITE = argOf('--write', null);
const ONLY = argOf('--only', null);

// every CSS custom property the extension ships, as getComputedStyle would report it
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const props = new Map<string, string>();
for (const file of manifest.css) {
  const text = readFileSync(join(EXT, file), 'utf8');
  for (const m of text.matchAll(/(--[\w-]+):\s*("[^"]*")/g)) props.set(m[1], m[2]);
}

// the last buffer handed to a source that started, with its loop settings
type Capture = { samples: Float32Array; rate: number; loop: boolean; loopStart: number; loopEnd: number };
let captured: Capture | null = null;

class Param {
  value = 1;
  setValueAtTime() {}
  setTargetAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
class Node {
  gain = new Param();
  connect(target?: unknown) {
    return target;
  }
  disconnect() {}
}
class FakeBuffer {
  data: Float32Array;
  readonly sampleRate: number;
  constructor(opts: { length: number; numberOfChannels?: number; sampleRate: number }) {
    this.data = new Float32Array(opts.length);
    this.sampleRate = opts.sampleRate;
  }
  get length() {
    return this.data.length;
  }
  get duration() {
    return this.data.length / this.sampleRate;
  }
  copyToChannel(source: Float32Array) {
    this.data = Float32Array.from(source);
  }
}
class Source extends Node {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  addEventListener() {}
  start() {
    if (this.buffer) captured = { samples: this.buffer.data, rate: this.buffer.sampleRate, loop: this.loop, loopStart: this.loopStart, loopEnd: this.loopEnd };
  }
  stop() {}
}
class FakeContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new Node();
  constructor(opts?: { sampleRate?: number }) {
    if (opts?.sampleRate) this.sampleRate = opts.sampleRate;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createGain() {
    return new Node();
  }
  createChannelMerger() {
    return new Node();
  }
  createBufferSource() {
    return new Source();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return new FakeBuffer({ length, sampleRate });
  }
}

const g = globalThis as any;
g.window = g;
g.AudioContext = FakeContext;
g.AudioBuffer = FakeBuffer;
const store = new Map<string, string>([['pokemon-emerald-sound:v1', JSON.stringify({ master: { volume: 0.35 }, windows: { battle: { muted: false }, summary: { muted: false }, chat: { muted: false } } })]]);
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
const element = () => ({ className: '', hidden: false, style: {}, append() {}, remove() {}, addEventListener() {}, setAttribute() {} });
g.document = { createElement: element, documentElement: element(), body: element(), querySelector: () => null, addEventListener() {}, removeEventListener() {} };
g.getComputedStyle = () => ({ getPropertyValue: (p: string) => props.get(p) ?? '' });
g.cinnamon = { id: 'pokemon-audio', onDispose() {}, send() {}, settings: { get: () => undefined, set() {}, all: () => ({}), onChange() {} } };
if (!g.addEventListener) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  g.addEventListener = (type: string, fn: (e: unknown) => void) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type))!.add(fn);
  g.removeEventListener = (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn);
  g.dispatchEvent = (e: { type: string }) => {
    for (const fn of listeners.get(e.type) ?? []) fn(e);
    return true;
  };
}

for (const file of manifest.page) await import(join(EXT, file));
const audio = g.__peAudio;
if (!audio) throw new Error('the extension did not publish window.__peAudio');
await audio.ready;
// a gesture, so the extension makes its AudioContext
g.dispatchEvent(new Event('pointerdown'));
await new Promise((r) => setTimeout(r, 0));

// --samples-only hashes the samples alone (16 hex digits), for comparing with a hash list made outside the page
const SAMPLES_ONLY = process.argv.includes('--samples-only');
const hash = (c: Capture | null) => {
  if (!c) return 'none';
  const h = createHash('sha256');
  h.update(new Uint8Array(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength));
  if (SAMPLES_ONLY) return h.digest('hex').slice(0, 16);
  h.update(`|${c.rate}|${c.loop}|${c.loop ? `${c.loopStart}|${c.loopEnd}` : ''}`);
  return h.digest('hex').slice(0, 24);
};
const take = () => {
  const c = captured;
  captured = null;
  return c;
};
const results: Record<string, string> = {};
const want = (key: string) => !ONLY || key.startsWith(ONLY);

// effects, at their own pitch and 3 semitones up
for (const { id } of audio.sfxList()) {
  for (const pitch of [0, 3]) {
    const key = `sfx:${id}:${pitch}`;
    if (!want(key)) continue;
    audio.stop(id, { window: 'summary' });
    audio.play(id, { window: 'summary', pitch });
    results[key] = hash(take());
  }
}
// every cry in every mode
const modes = ['normal', 'weak', 'faint', 'doubles', 'high_pitch', 'growl', 'roar', 'echo'];
for (let dex = 1; dex <= 386; dex++) {
  for (const mode of modes) {
    const key = `cry:${dex}:${mode}`;
    if (!want(key)) continue;
    audio.cry(dex, { window: 'summary', mode });
    results[key] = hash(take());
  }
}
// music: every battle track, every victory track and the fanfares, as music() would start them
const music = new Set<string>();
for (const m of audio.musicList()) music.add(m.id).add(m.victoryId);
const fanfares = ['MUS_LEVEL_UP', 'MUS_EVOLVED'];
for (const id of [...music, ...fanfares]) {
  const key = `music:${id}`;
  if (!want(key)) continue;
  audio.stopMusic({ free: true });
  await audio.prepareMusic(id);
  take();
  if (fanfares.includes(id)) audio.fanfare(id, { window: 'summary' });
  else audio.music(id, { window: 'battle' });
  await new Promise((r) => setTimeout(r, 0));
  results[key] = hash(take());
  audio.stopMusic({ free: true });
}

const total = Object.keys(results).length;
if (WRITE) {
  writeFileSync(WRITE, `${JSON.stringify(results, null, 1)}\n`);
  console.log(`wrote ${total} hashes to ${WRITE}`);
}
if (EXPECT && !WRITE) {
  const expected: Record<string, string> = JSON.parse(readFileSync(EXPECT, 'utf8'));
  const keys = Object.keys(expected).filter(want);
  const missing = keys.filter((k) => !(k in results));
  const differ = keys.filter((k) => k in results && results[k] !== expected[k]);
  const extra = Object.keys(results).filter((k) => !(k in expected));
  console.log(`checked ${keys.length}: ${keys.length - missing.length - differ.length} match, ${differ.length} differ, ${missing.length} missing, ${extra.length} not in the expected set`);
  for (const k of [...differ, ...missing].slice(0, 40)) console.log(`  ${missing.includes(k) ? 'missing' : 'differs'} ${k}`);
  process.exit(differ.length || missing.length ? 1 : 0);
}
