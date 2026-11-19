// window.__peAudio: Emerald sound effects and cries for the Pokemon windows. The data comes from audio-sfx.css and
// audio-cries-*.css (built from pret/pokeemerald by source/audio/build-audio.mjs). seq.ts renders each effect once,
// in its own task; a cry is decoded and rendered on its first play. Everything plays through one GainNode per
// window, and no AudioContext exists until a click or key press asks for a sound.
declare const cinnamon: { onDispose(fn: () => void): void };

// pan -1 (left) to 1 (right), as m4aMPlayPanpotControl's -64..63; pitch in semitones, as m4aMPlayPitchControl's
// 1/256-semitone steps
type PlayOptions = { window?: string; pan?: number; pitch?: number };
// windows with a mute toggle in the shared state: battle, summary, and chat (partners' cry on a finished reply)
const WINDOWS = new Set(['battle', 'summary', 'chat']);
function windowName(win: unknown, fallback: string): string {
  return typeof win === 'string' && WINDOWS.has(win) ? win : fallback;
}
type PlayRecord = { id: string; window: string; gain: number; at: number; played: boolean; species?: number; ctx?: string };

const pageLib = (window as any).__peaLib;
const { SOUND_KEY, SOUND_EVENT, readSound, gainFor } = pageLib.state;
const { renderSong, Renderer, loopCut } = pageLib.seq;
const { Wave, crySong } = pageLib.ds;
const RATE = 48000;
// one CGB volume step; a full-volume square reads ±0.5 before the window gain
const STEP = 0.5 / 15;
const GLIDE = 0.01;
const LOG_MAX = 20;

const disposers: (() => void)[] = [];
// a rendered effect or cry; a looping effect (SE_LOW_HEALTH, SE_M_GUST) keeps its intro and one loop body
type Clip = { samples: Float32Array; loopStart?: number; loopEnd?: number };
const rendered = new Map<string, Clip>();
const log: PlayRecord[] = [];
const sfxWaves: Record<string, unknown> = {};
let data: { tables: any; songs: Record<string, unknown>; sfx?: any; cries?: { files: number; keys: Record<string, number>; params: any } } | null = null;
const cries = new Map<number, Clip>();
let ctx: AudioContext | null = null;
const gains = new Map<string, GainNode>();
const live = new Map<string, AudioBufferSourceNode>();
let state = readSound(safeStorage());
let disposed = false;

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function listen(target: EventTarget, type: string, fn: (event: any) => void): void {
  target.addEventListener(type, fn);
  disposers.push(() => target.removeEventListener(type, fn));
}

function normalizeId(id: string): string {
  const upper = String(id).toUpperCase();
  return upper.startsWith('SE_') ? upper : `SE_${upper}`;
}

function readData(): boolean {
  const probe = document.createElement('div');
  probe.className = 'pe-audio-data';
  probe.hidden = true;
  document.documentElement.append(probe);
  const raw = getComputedStyle(probe).getPropertyValue('--pe-audio-sfx').trim().replace(/^["']|["']$/g, '');
  probe.remove();
  if (!raw) return false;
  data = JSON.parse(atob(raw));
  return true;
}

// an effect's samples are decoded from audio-sfx-samples-N.css the first time an effect needs them
function sfxWave(name: string): unknown {
  if (sfxWaves[name]) return sfxWaves[name];
  const raw = readProp('pe-audio-sfx-samples', `--pe-sfx-${name}`);
  if (!raw) return null;
  return (sfxWaves[name] = new Wave(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)), data!.tables.delta));
}

// pitX in 1/256 semitones; each pitch is its own render
function renderOne(id: string, pitX = 0): Clip | null {
  const cacheKey = pitX ? `${id}@${pitX}` : id;
  let clip = rendered.get(cacheKey);
  if (clip) return clip;
  const song: any = data?.songs[id];
  if (!song) return null;
  const waves: Record<string, unknown> = {};
  for (const name of song.sn ?? []) waves[name] = sfxWave(name);
  const sx = data!.sfx ?? {};
  const r = new Renderer({ ...song, tones: sx.tones, splits: sx.splits, waves: sx.waves, samples: waves, pitX }, data!.tables, RATE, STEP, { loops: 2 });
  while (!r.step(1000));
  const res = r.result(true);
  const cut = res.loops.length >= 2 ? loopCut(res, Math.round(RATE * 0.02)) : null;
  clip = cut ? { samples: cut.samples, loopStart: cut.loopStart / RATE, loopEnd: cut.loopEnd / RATE } : { samples: res.samples };
  rendered.set(cacheKey, clip);
  return clip;
}

// CSS can land after the page files run, so poll briefly; then render one effect per task
const ready: Promise<void> = new Promise((resolve, reject) => {
  let tries = 0;
  const attempt = () => {
    if (disposed) return reject(new Error('disposed'));
    let ok = false;
    try {
      ok = readData();
    } catch (error) {
      return reject(error);
    }
    if (!ok) {
      if (++tries > 100) return reject(new Error('audio-sfx.css is not loaded'));
      const t = window.setTimeout(attempt, 100);
      disposers.push(() => window.clearTimeout(t));
      return;
    }
    // the interface sounds render ahead; battle effects render on their first play
    const queue: string[] = [...(data!.sfx?.interface ?? [])];
    const next = () => {
      if (disposed) return reject(new Error('disposed'));
      const id = queue.shift();
      if (!id) return resolve();
      renderOne(id);
      const t = window.setTimeout(next, 0);
      disposers.push(() => window.clearTimeout(t));
    };
    next();
  };
  attempt();
});
ready.catch(() => {});

function windowGain(win: string): GainNode | null {
  if (!ctx) return null;
  let node = gains.get(win);
  if (!node) {
    node = ctx.createGain();
    node.gain.value = gainFor(state, win);
    node.connect(ctx.destination);
    gains.set(win, node);
  }
  return node;
}

const stateListeners: ((next: any) => void)[] = [];
const cryListeners: ((win: string, seconds: number) => void)[] = [];

function applyState(next: unknown): void {
  state = next;
  for (const fn of stateListeners) {
    try {
      fn(state);
    } catch {}
  }
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [win, node] of gains) {
    const target = gainFor(state, win);
    // a suspended context never advances its automation, so set the value outright
    if (ctx.state !== 'running') {
      node.gain.cancelScheduledValues(0);
      node.gain.value = target;
      continue;
    }
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.setTargetAtTime(target, now, GLIDE);
  }
}

const unlockListeners: (() => void)[] = [];

// any click, key press or touch anywhere in the page creates or resumes the AudioContext, in the capture phase so
// it runs before the page's own handlers; nothing else ever creates it
function unlock(): void {
  if (disposed) return;
  try {
    if (!ctx) ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    if (ctx.state === 'suspended') void ctx.resume().then(() => unlockListeners.forEach((fn) => fn())).catch(() => {});
    else unlockListeners.forEach((fn) => fn());
  } catch {}
}
for (const type of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(type, unlock, true);
  disposers.push(() => window.removeEventListener(type, unlock, true));
}

function record(id: string, win: string, species?: number): PlayRecord {
  const entry: PlayRecord = { id, window: win, gain: gainFor(state, win), at: Date.now(), played: false, species };
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  return entry;
}

// the AudioContext, if a gesture has made one; a suspended one is asked to resume (that works only inside a gesture)
function context(): AudioContext | null {
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

function play(id: string, opts: PlayOptions = {}): boolean {
  const key = normalizeId(id);
  const win = windowName(opts.window, 'summary');
  const entry = record(key, win);
  if (disposed || entry.gain <= 0 || !data?.songs[key]) return false;
  try {
    if (!context()) return false;
    const pitX = Math.round(Math.max(-24, Math.min(24, Number(opts.pitch) || 0)) * 256);
    // a new start of the same effect cuts the last one, as the game's SE player does
    return (entry.played = start(renderOne(key, pitX), win, `${win}:${key}`, opts.pan));
  } catch {
    return false;
  }
}

// m4aSongNumStop: the game stops SE_EXP when the EXP bar is full; the channels go silent at once
function stop(id: string, opts: PlayOptions = {}): void {
  const slot = `${windowName(opts.window, 'summary')}:${normalizeId(id)}`;
  try {
    live.get(slot)?.stop();
  } catch {}
  live.delete(slot);
}

// national dex number, or a name in any case and punctuation ("Mr. Mime", "nidoran♀")
function dexOf(species: number | string): number | null {
  if (typeof species === 'number') return Number.isInteger(species) && species >= 1 && species <= 386 ? species : null;
  const key = String(species).toLowerCase().replace(/♀/g, 'f').replace(/♂/g, 'm').replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(key)) return dexOf(Number(key));
  return data?.cries?.keys[key] ?? null;
}

function readCry(dex: number): Uint8Array | null {
  const probe = document.createElement('div');
  probe.className = 'pe-audio-cries';
  probe.hidden = true;
  document.documentElement.append(probe);
  const raw = getComputedStyle(probe).getPropertyValue(`--pe-cry-${dex}`).trim().replace(/^["']|["']$/g, '');
  probe.remove();
  return raw ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : null;
}

function renderCry(dex: number): Clip | null {
  let clip = cries.get(dex);
  if (clip) return clip;
  const bin = data?.cries ? readCry(dex) : null;
  if (!bin) return null;
  const song = crySong(data!.cries!.params, new Wave(bin, data!.tables.delta));
  clip = { samples: renderSong(song, data!.tables, RATE, STEP).samples as Float32Array };
  cries.set(dex, clip);
  return clip;
}

// PlayCry_ByMode(species, 0, CRY_MODE_NORMAL); a new cry in the same window cuts the one still sounding
function cry(species: number | string, opts: PlayOptions = {}): boolean {
  const win = windowName(opts.window, 'summary');
  const dex = data ? dexOf(species) : null;
  const entry = record('CRY', win, dex ?? undefined);
  if (disposed || entry.gain <= 0 || !dex) return false;
  try {
    if (!context()) return false;
    const clip = renderCry(dex);
    entry.played = start(clip, win, `${win}:cry`);
    if (entry.played && clip) for (const fn of cryListeners) fn(win, clip.samples.length / RATE);
    return entry.played;
  } catch {
    return false;
  }
}

// TrkVolPitSet's pan law for y = -64..63: right (y + 128) / 128, left (127 - y) / 127 of the centre level
function panNode(out: AudioNode, pan: number): AudioNode {
  const y = Math.max(-64, Math.min(63, Math.round(pan * 64)));
  const merger = ctx!.createChannelMerger(2);
  const left = ctx!.createGain();
  const right = ctx!.createGain();
  left.gain.value = (127 - y) / 127;
  right.gain.value = (y + 128) / 128;
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  merger.connect(out);
  const split = ctx!.createGain();
  split.connect(left);
  split.connect(right);
  return split;
}

function start(clip: Clip | null, win: string, slot: string, pan?: number): boolean {
  const out = windowGain(win);
  const samples = clip?.samples;
  if (!ctx || !clip || !samples || !samples.length || !out) return false;
  const buffer = ctx.createBuffer(1, samples.length, RATE);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  try {
    live.get(slot)?.stop();
  } catch {}
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (clip.loopEnd) {
    source.loop = true;
    source.loopStart = clip.loopStart ?? 0;
    source.loopEnd = clip.loopEnd;
  }
  source.connect(typeof pan === 'number' && Number.isFinite(pan) && pan !== 0 ? panNode(out, pan) : out);
  source.onended = () => {
    if (live.get(slot) === source) live.delete(slot);
    source.disconnect();
  };
  source.start();
  live.set(slot, source);
  const last = log[log.length - 1];
  if (last) last.ctx = ctx.state;
  return true;
}

listen(window, SOUND_EVENT, (event: CustomEvent) => applyState(pageLib.state.cleanSound(event.detail)));
listen(window, 'storage', (event: StorageEvent) => {
  if (event.key === SOUND_KEY) applyState(readSound(safeStorage()));
});

const api = {
  ready,
  play,
  stop,
  cry,
  ids: () => Object.keys(data?.songs ?? {}),
  // every effect with what plays it: Showdown gen3 random battle moves, status animations, other battle events
  sfxList: () =>
    Object.keys(data?.songs ?? {}).map((id) => {
      const use = data?.sfx?.uses?.[id];
      return { id, moves: [...(use?.moves ?? [])], status: [...(use?.status ?? [])], battle: !!use?.battle, interface: (data?.sfx?.interface ?? []).includes(id) };
    }),
  // the gain a play() for this window uses right now: master volume, or 0 while muted
  gain: (win: string) => gainFor(state, win),
  // the live GainNode value, null before the first sound
  nodeGain: (win: string) => gains.get(win)?.gain.value ?? null,
  contextState: () => (ctx ? `${ctx.state} t=${ctx.currentTime.toFixed(3)} rate=${ctx.sampleRate}` : 'none'),
  log,
  // QA: the rendered samples for one effect, so a page check can compare them with an offline render
  samples: (id: string) => renderOne(normalizeId(id))?.samples ?? null,
  crySamples: (species: number | string) => {
    const dex = dexOf(species);
    return dex ? (renderCry(dex)?.samples ?? null) : null;
  },
};
(window as any).__peAudio = api;

// for music.ts, which adds music() and stopMusic() to the same API
function readProp(className: string, prop: string): string {
  const probe = document.createElement('div');
  probe.className = className;
  probe.hidden = true;
  document.documentElement.append(probe);
  const raw = getComputedStyle(probe).getPropertyValue(prop).trim().replace(/^["']|["']$/g, '');
  probe.remove();
  return raw;
}
pageLib.core = {
  api,
  ready,
  context,
  current: () => ctx,
  windowGain,
  gain: (win: string) => gainFor(state, win),
  windowName,
  onState: (fn: (next: any) => void) => stateListeners.push(fn),
  onCry: (fn: (win: string, seconds: number) => void) => cryListeners.push(fn),
  onUnlock: (fn: () => void) => unlockListeners.push(fn),
  data: () => data,
  readProp,
  listen,
  isDisposed: () => disposed,
};

cinnamon.onDispose(() => {
  disposed = true;
  disposers.splice(0).forEach((fn) => fn());
  for (const source of live.values()) {
    try {
      source.stop();
    } catch {}
  }
  live.clear();
  gains.clear();
  void ctx?.close().catch(() => {});
  ctx = null;
  if ((window as any).__peAudio === api) delete (window as any).__peAudio;
  delete (window as any).__peaLib;
});
