// Shared state for the partner page files: assets, the per-thread partner store, trainer rendering and helpers.
// Page files cannot import, so core.ts publishes everything on window.__pkp for ui.ts, settings.ts and page.ts.
declare const cinnamon: {
  settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    onChange(fn: (all: Record<string, unknown>) => void): void;
  };
  onDispose(fn: () => void): void;
};

// partner levels for stage 2 and stage 3; level is 5 + assistant replies, so 10 and 30 replies
const EVOLVE_AT = [15, 35];
const START_LEVEL = 5;
const MAX_LEVEL = 100;
const BASE_WEIGHT = 3;
const SINGLE_WEIGHT = 1;
const STORE_KEY = 'pokemon-partners:v1';
const STORE_CAP = 400;
const THREAD_KINDS = ['code', 'chat', 'cowork'];

type Group = [string, Array<[number[], number, number]>];
type TrainerData = { id: string; label: string; name: string; pal: string[]; frames: string[]; groups: Group[] };
type Data = {
  n: string[];
  e: Record<string, number[]>;
  b: number[];
  s: number[];
  i: Record<string, [number, number]>;
  f: Record<string, [number, number]>;
  t: TrainerData[];
};
type Entry = [base: number, count: number, used: number, nickname?: string];
type TrainerSetting = { base: string; colors: Array<string | null>; name: string };

const rt = { disposed: false };
const errors: string[] = [];
function report(err: unknown): void {
  if (errors.length < 30) errors.push(String((err as Error)?.stack ?? err).slice(0, 400));
}
function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    if (rt.disposed) return;
    try {
      fn(...args);
    } catch (err) {
      report(err);
    }
  };
}

const cleanups: Array<() => void> = [];
const timers = new Set<number>();
function later(fn: () => void, ms: number): number {
  const id = window.setTimeout(() => {
    timers.delete(id);
    guard(fn)();
  }, ms);
  timers.add(id);
  return id;
}
function cancel(id: number): void {
  clearTimeout(id);
  timers.delete(id);
}
function listen(target: EventTarget, type: string, fn: (event: any) => void, options?: AddEventListenerOptions | boolean): void {
  const handler = guard(fn);
  target.addEventListener(type, handler, options);
  cleanups.push(() => target.removeEventListener(type, handler, options));
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const cssString = (styles: CSSStyleDeclaration, property: string) => styles.getPropertyValue(property).trim().replace(/^["']|["']$/g, '');

class Assets {
  data: Data | null = null;
  dex: any = null;
  private bytes: { i: Uint8Array; f: Uint8Array; a: Uint8Array; u: Uint8Array } | null = null;
  private urls = new Map<string, string>();

  load(): boolean {
    if (this.data) return true;
    const host = el('div', 'pkp-data');
    host.hidden = true;
    document.body.append(host);
    try {
      const styles = getComputedStyle(host);
      const data = cssString(styles, '--pkp-data');
      const icons = cssString(styles, '--pkp-icons');
      const fronts = cssString(styles, '--pkp-fronts');
      const dex = cssString(styles, '--pkp-dex');
      const ui = cssString(styles, '--pkp-ui');
      const anim = cssString(styles, '--pkp-anim');
      if (!data || !icons || !fronts || !dex || !ui || !anim) return false;
      this.bytes = { i: decodeBase64(icons), f: decodeBase64(fronts), a: decodeBase64(anim), u: decodeBase64(ui) };
      this.data = JSON.parse(new TextDecoder().decode(decodeBase64(data))) as Data;
      this.dex = JSON.parse(new TextDecoder().decode(decodeBase64(dex)));
      return true;
    } finally {
      host.remove();
    }
  }

  url(kind: 'i' | 'f' | 'a', num: number): string | null {
    const key = `${kind}${num}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const range = (this.data as any)?.[kind]?.[num];
    const bytes = this.bytes?.[kind];
    if (!range || !bytes) return kind === 'f' ? this.url('i', num) : null;
    const url = URL.createObjectURL(new Blob([bytes.slice(range[0], range[0] + range[1])], { type: 'image/png' }));
    this.urls.set(key, url);
    return url;
  }

  ui(name: string): string | null {
    const key = `u${name}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const range = this.dex?.ui[name];
    if (!range || !this.bytes) return null;
    const url = URL.createObjectURL(new Blob([this.bytes.u.slice(range[0], range[0] + range[1])], { type: 'image/png' }));
    this.urls.set(key, url);
    return url;
  }

  // the Emerald front sprite (frame 1 is anim_front's second frame); shiny swaps in the species' shiny palette
  front(num: number, shiny = false, frame = 0): string | null {
    const kind = frame && (this.data as any)?.a?.[num] ? 'a' : 'f';
    const shinyPal: string | undefined = this.data?.f[num] ? (this.data as any).sh?.[num] : undefined;
    if (!shiny || !shinyPal) return this.url(kind, num);
    const key = `s${kind}${num}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const range = (this.data as any)[kind][num];
    const png = this.bytes![kind].slice(range[0], range[0] + range[1]);
    const bytes = withPalette(png, shinyPal);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    this.urls.set(key, url);
    return url;
  }

  name(num: number): string {
    return this.data?.n[num] ?? '';
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
const assets = new Assets();

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// replaces a PNG's PLTE colors (hex string, 6 characters per color) and fixes the chunk CRC
function withPalette(png: Uint8Array, hex: string): Uint8Array {
  const out = png.slice();
  const view = new DataView(out.buffer);
  let at = 8;
  while (at < out.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...out.subarray(at + 4, at + 8));
    if (type === 'PLTE') {
      for (let i = 0; i * 2 < hex.length && i < length; i++) out[at + 8 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      view.setUint32(at + 8 + length, crc32(out.subarray(at + 4, at + 8 + length)));
      break;
    }
    at += 12 + length;
  }
  return out;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickBase(key: string): number {
  const data = assets.data!;
  const total = data.b.length * BASE_WEIGHT + data.s.length * SINGLE_WEIGHT;
  let roll = Math.floor(rng(hash(key))() * total);
  if (roll < data.b.length * BASE_WEIGHT) return data.b[Math.floor(roll / BASE_WEIGHT)];
  roll -= data.b.length * BASE_WEIGHT;
  return data.s[Math.floor(roll / SINGLE_WEIGHT)];
}

const levelFor = (count: number) => Math.min(MAX_LEVEL, START_LEVEL + count);
const stageFor = (count: number) => EVOLVE_AT.filter((at) => levelFor(count) >= at).length;

// walks the family from the base, choosing branches with a draw per stage from the thread's own seed
function speciesAt(key: string, base: number, stage: number): number {
  const draw = rng(hash(`${key}#evolve`));
  let num = base;
  for (let s = 0; s < stage; s++) {
    const roll = draw();
    const next = assets.data?.e[num];
    if (!next?.length) break;
    num = next[Math.floor(roll * next.length)];
  }
  return num;
}

// one entry per thread, [base species, assistant replies counted, last use]; localStorage, oldest dropped past STORE_CAP
class Store {
  private entries: Record<string, Entry> = {};
  private saveTimer = 0;

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (raw && typeof raw.t === 'object') this.entries = raw.t;
    } catch {}
  }

  get(key: string, touch = false): Entry {
    let entry = this.entries[key];
    if (!Array.isArray(entry) || !assets.data?.n[entry[0]]) {
      entry = this.entries[key] = [pickBase(key), 0, Date.now()];
      this.save();
    } else if (touch) {
      entry[2] = Date.now();
      this.save();
    }
    return entry;
  }

  species(key: string, count?: number): number {
    const entry = this.get(key);
    return speciesAt(key, entry[0], stageFor(count ?? entry[1]));
  }

  addReply(key: string): { before: number; after: number } {
    const entry = this.get(key, true);
    const before = this.species(key);
    entry[1]++;
    this.save();
    return { before, after: this.species(key) };
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = later(() => {
      this.saveTimer = 0;
      this.flush();
    }, 500);
  }

  flush(): void {
    const keys = Object.keys(this.entries);
    if (keys.length > STORE_CAP) {
      keys.sort((a, b) => this.entries[b][2] - this.entries[a][2]);
      for (const key of keys.slice(STORE_CAP)) delete this.entries[key];
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, t: this.entries }));
    } catch {}
  }

  nickname(key: string): string | null {
    const nick = this.entries[key]?.[3];
    return typeof nick === 'string' && nick ? nick : null;
  }

  setNickname(key: string, nickname: string | null): void {
    const entry = this.get(key, true);
    if (nickname) entry[3] = nickname;
    else entry.length = 3;
    this.save();
  }

  setCount(key: string, count: number): void {
    this.get(key, true)[1] = Math.max(0, count);
    this.save();
  }

  snapshot(): Record<string, Entry> {
    return this.entries;
  }
}
const store = new Store();

function threadKeyFromRow(row: Element | null): string | null {
  const key = row?.getAttribute('data-row-key');
  if (!key) return null;
  return THREAD_KINDS.includes(key.split(':')[0]) ? key : null;
}

function currentThread(): string | null {
  const path = location.pathname;
  const code = /\/epitaxy\/(local_[\w-]+)/.exec(path);
  if (code) return `code:${code[1]}`;
  const chat = /\/chat\/([\w-]+)/.exec(path);
  if (chat) return `chat:${chat[1]}`;
  const selected = document.querySelector('[data-testid="sidebar"] [data-row][data-selected="open"], [data-testid="sidebar"] [data-row][data-selected="focused"]');
  return threadKeyFromRow(selected?.closest('[data-row-key]') ?? null);
}

// device pixels per sprite pixel: the theme's own zoom-aware scale (its --pe-px), else round(dpr * 1.2)
const scaleStyle = el('style');
scaleStyle.setAttribute('data-pkp-scale', '');
document.head.append(scaleStyle);
const scale = { k: 3, dpr: 2, big: 1.5, small: 1 };
function applyScale(): void {
  const dpr = window.devicePixelRatio || 1;
  const themePx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pe-px'));
  const k = themePx > 0 ? Math.max(1, Math.round(themePx * dpr)) : Math.max(1, Math.round(dpr * 1.2));
  Object.assign(scale, { k, dpr, big: k / dpr, small: Math.max(1, k - 1) / dpr });
  const text = `:root{--pkp-u:${scale.big.toFixed(5)}px;--pkp-u2:${scale.small.toFixed(5)}px}`;
  if (scaleStyle.textContent !== text) scaleStyle.textContent = text;
}

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255)) as [number, number, number];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255)) as [number, number, number];
}
const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// indices a group recolors, in palette order
function groupIndices(group: Group): number[] {
  return [...new Set(group[1].flatMap((part) => part[0]))].sort((a, b) => a - b);
}
// the group's middle shade: the swatch shown in the color picker
function groupBase(trainer: TrainerData, group: Group): string {
  const shades = groupIndices(group).map((i) => trainer.pal[i]).sort((a, b) => hexToHsl(a)[2] - hexToHsl(b)[2]);
  return `#${shades[Math.floor(shades.length / 2)]}`;
}
// keeps each shade's lightness offset from the group's middle shade, with the picked hue and saturation
function recolor(trainer: TrainerData, group: Group, target: string): Map<number, [number, number, number]> {
  const [th, ts, tl] = hexToHsl(target);
  const ref = hexToHsl(groupBase(trainer, group))[2];
  const out = new Map<number, [number, number, number]>();
  for (const i of groupIndices(group)) {
    const l = Math.min(0.97, Math.max(0.03, tl + hexToHsl(trainer.pal[i])[2] - ref));
    out.set(i, hslToRgb(th, ts, l));
  }
  return out;
}

function trainerSetting(): TrainerSetting {
  const raw = cinnamon.settings.get('trainer') as Partial<TrainerSetting> | undefined;
  const trainers = assets.data?.t ?? [];
  const base = trainers.find((t) => t.id === raw?.base) ?? trainers[0];
  const colors = Array.isArray(raw?.colors) ? raw!.colors.map((c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null)) : [];
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 10) : base?.name ?? 'BRENDAN';
  return { base: base?.id ?? 'brendan', colors, name };
}

// paints one 16x32 frame of a trainer with the chosen group colors
function paintTrainer(canvas: HTMLCanvasElement, trainer: TrainerData, frame: number, colors: Array<string | null>): void {
  canvas.width = 16;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(16, 32);
  const base = trainer.pal.map(rgbOf);
  const swaps = trainer.groups.map((group, g) => (colors[g] ? { group, map: recolor(trainer, group, colors[g]!) } : null));
  const packed = decodeBase64(trainer.frames[frame] ?? trainer.frames[0]);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 16; x++) {
      const byte = packed[(y * 16 + x) >> 1];
      const index = x & 1 ? byte & 15 : byte >> 4;
      if (!index) continue;
      let rgb = base[index];
      for (const swap of swaps) {
        if (!swap) continue;
        if (swap.group[1].some(([indices, y0, y1]) => y >= y0 && y <= y1 && indices.includes(index))) rgb = swap.map.get(index) ?? rgb;
      }
      const at = (y * 16 + x) * 4;
      image.data.set([rgb[0], rgb[1], rgb[2], 255], at);
    }
  }
  ctx.putImageData(image, 0, 0);
}

// battle extension's 8-bit sounds toggle; no battle extension means no sound
function soundOn(): boolean {
  try {
    const Sfx = (window as any).__pkb?.Sfx;
    return !!Sfx && new Sfx().enabled === true;
  } catch {
    return false;
  }
}

let audio: AudioContext | null = null;
// the evolution jingle, at the shared sound state's gain (master volume times the summary window's level)
function jingle(): void {
  const level = (window as any).__pkp?.sound?.gain('summary') ?? 0;
  if (level <= 0) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    const t = audio.currentTime + 0.02;
    [523, 659, 784, 1046, 784, 1046].forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.13 * level, t + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + (i === 5 ? 0.4 : 0.11));
      osc.connect(gain).connect(audio!.destination);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.42);
    });
  } catch {}
}

const ns = ((window as any).__pkp = {});
Object.assign(ns, {
  EVOLVE_AT, START_LEVEL, MAX_LEVEL, levelFor, hash, rng, rt, errors, report, guard, cleanups, timers, later, cancel, listen, el, assets, store, stageFor, speciesAt,
  threadKeyFromRow, currentThread, scale, applyScale, scaleStyle, trainerSetting, paintTrainer, groupBase, jingle, soundOn,
  closeAudio: () => {
    void audio?.close().catch(() => {});
    audio = null;
  },
});
