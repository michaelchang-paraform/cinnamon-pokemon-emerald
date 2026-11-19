// window.__peAudio: Emerald sound effects and cries for the Pokemon windows. The data comes from audio-sfx.css and
// audio-cries-*.css (built from pret/pokeemerald by source/audio/build-audio.mjs). seq.ts renders each effect once,
// in its own task; a cry is decoded and rendered on its first play. Everything plays through one GainNode per
// window, and no AudioContext exists until a click or key press asks for a sound.
declare const cinnamon: { onDispose(fn: () => void): void };

type PlayOptions = { window?: 'battle' | 'summary' };
type PlayRecord = { id: string; window: string; gain: number; at: number; played: boolean; species?: number; ctx?: string };

const pageLib = (window as any).__peaLib;
const { SOUND_KEY, SOUND_EVENT, readSound, gainFor } = pageLib.state;
const { renderSong } = pageLib.seq;
const { Wave, crySong } = pageLib.ds;
const RATE = 48000;
// one CGB volume step; a full-volume square reads ±0.5 before the window gain
const STEP = 0.5 / 15;
const GLIDE = 0.01;
const LOG_MAX = 20;

const disposers: (() => void)[] = [];
const rendered = new Map<string, Float32Array>();
const log: PlayRecord[] = [];
let data: { tables: any; songs: Record<string, unknown>; cries?: { files: number; keys: Record<string, number>; params: any } } | null = null;
const cries = new Map<number, Float32Array>();
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

function renderOne(id: string): Float32Array | null {
  let samples = rendered.get(id);
  if (samples) return samples;
  const song = data?.songs[id];
  if (!song) return null;
  samples = renderSong(song, data!.tables, RATE, STEP).samples as Float32Array;
  rendered.set(id, samples);
  return samples;
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
    const queue = Object.keys(data!.songs);
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

function applyState(next: unknown): void {
  state = next;
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

function gestureActive(): boolean {
  const activation = (navigator as any).userActivation;
  return activation ? !!activation.isActive : true;
}

function record(id: string, win: string, species?: number): PlayRecord {
  const entry: PlayRecord = { id, window: win, gain: gainFor(state, win), at: Date.now(), played: false, species };
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  return entry;
}

function context(): AudioContext | null {
  if (!ctx) {
    if (!gestureActive()) return null;
    ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

function play(id: string, opts: PlayOptions = {}): boolean {
  const key = normalizeId(id);
  const win = opts.window === 'battle' ? 'battle' : 'summary';
  const entry = record(key, win);
  if (disposed || entry.gain <= 0 || !data?.songs[key]) return false;
  try {
    if (!context()) return false;
    // a new start of the same effect cuts the last one, as the game's SE player does
    return (entry.played = start(renderOne(key), win, `${win}:${key}`));
  } catch {
    return false;
  }
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

function renderCry(dex: number): Float32Array | null {
  let samples = cries.get(dex);
  if (samples) return samples;
  const bin = data?.cries ? readCry(dex) : null;
  if (!bin) return null;
  const song = crySong(data!.cries!.params, new Wave(bin, data!.tables.delta));
  samples = renderSong(song, data!.tables, RATE, STEP).samples as Float32Array;
  cries.set(dex, samples);
  return samples;
}

// PlayCry_ByMode(species, 0, CRY_MODE_NORMAL); a new cry in the same window cuts the one still sounding
function cry(species: number | string, opts: PlayOptions = {}): boolean {
  const win = opts.window === 'battle' ? 'battle' : 'summary';
  const dex = data ? dexOf(species) : null;
  const entry = record('CRY', win, dex ?? undefined);
  if (disposed || entry.gain <= 0 || !dex) return false;
  try {
    if (!context()) return false;
    return (entry.played = start(renderCry(dex), win, `${win}:cry`));
  } catch {
    return false;
  }
}

function start(samples: Float32Array | null, win: string, slot: string): boolean {
  const out = windowGain(win);
  if (!ctx || !samples || !samples.length || !out) return false;
  const buffer = ctx.createBuffer(1, samples.length, RATE);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  try {
    live.get(slot)?.stop();
  } catch {}
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(out);
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
  cry,
  ids: () => Object.keys(data?.songs ?? {}),
  // the gain a play() for this window uses right now: master volume, or 0 while muted
  gain: (win: string) => gainFor(state, win),
  // the live GainNode value, null before the first sound
  nodeGain: (win: string) => gains.get(win)?.gain.value ?? null,
  contextState: () => (ctx ? `${ctx.state} t=${ctx.currentTime.toFixed(3)} rate=${ctx.sampleRate}` : 'none'),
  log,
  // QA: the rendered samples for one effect, so a page check can compare them with an offline render
  samples: (id: string) => renderOne(normalizeId(id)),
  crySamples: (species: number | string) => {
    const dex = dexOf(species);
    return dex ? renderCry(dex) : null;
  },
};
(window as any).__peAudio = api;

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
