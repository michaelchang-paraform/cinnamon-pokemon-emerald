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

// partner levels for stage 2 and stage 3; levels come from EXP on the Medium Fast curve (level^3)
const EVOLVE_AT = [15, 35];
const START_LEVEL = 5;
const MAX_LEVEL = 100;
const BASE_WEIGHT = 3;
const SINGLE_WEIGHT = 1;
const STORE_KEY = 'pokemon-partners:v1';
const STORE_CAP = 400;
const EXP_KEY = 'pokemon-partners:exp:v1';
const SHINY_KEY = 'pokemon-partners:shiny:v1';
const CRY_KEY = 'pokemon-partners:cries:v1';
// the Shiny odds setting; Gen 3's 1/8192 is the default
const SHINY_ODDS = [8192, 4096, 512, 64];
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_EXP = 100;
const EXP_PER_TOOL = 3;
// dedupe hashes kept per thread, and for how many threads; older ones fold into a row watermark
const EXP_HASH_CAP = 4000;
const EXP_THREAD_CAP = 80;
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
// seed EXP, output tokens and tool calls counted, row watermark (null: set on first open), max row seen, and the
// largest [tokens, tools] seen per stable id (hashed), so a re-render that reads differently only tops up
type ExpRecord = { e: number; t: number; k: number; w: number | null; m: number; v: Record<string, [number, number]> };
type ExpItem = { id: string; row: number; tokens: number; tools: number };
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

// the old reply-count level, only to seed EXP for partners from before EXP
const levelFor = (count: number) => Math.min(MAX_LEVEL, START_LEVEL + count);
const levelForExp = (exp: number) => {
  let level = Math.min(MAX_LEVEL, Math.max(1, Math.floor(Math.cbrt(exp))));
  while (level < MAX_LEVEL && (level + 1) ** 3 <= exp) level++;
  while (level > 1 && level ** 3 > exp) level--;
  return level;
};
const stageFor = (level: number) => EVOLVE_AT.filter((at) => level >= at).length;

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
  private exps: Record<string, ExpRecord> = {};
  private fresh = new Set<string>();
  // one roll per partner, never repeated: 0 not shiny, 1 shiny not yet seen, 2 shiny and its sparkle played
  private shinies: Record<string, number> = {};
  private saveTimer = 0;

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (raw && typeof raw.t === 'object') this.entries = raw.t;
    } catch {}
    try {
      const raw = JSON.parse(localStorage.getItem(EXP_KEY) || '{}');
      if (raw && typeof raw.x === 'object') this.exps = raw.x;
    } catch {}
    try {
      const raw = JSON.parse(localStorage.getItem(SHINY_KEY) || '{}');
      if (raw && typeof raw.s === 'object') this.shinies = raw.s;
    } catch {}
  }

  shinyState(key: string): number {
    let state = this.shinies[key];
    if (state !== 0 && state !== 1 && state !== 2) {
      const setting = Number(cinnamon.settings.get('shinyOdds'));
      const odds = SHINY_ODDS.includes(setting) ? setting : SHINY_ODDS[0];
      const draw = new Uint32Array(1);
      crypto.getRandomValues(draw);
      state = this.shinies[key] = draw[0] % odds === 0 ? 1 : 0;
      this.save();
    }
    return state;
  }

  // true the first time a turn id is seen: the cry plays once per turn across re-renders and reopens
  firstCry(id: string): boolean {
    const tag = hash(id).toString(36);
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(CRY_KEY) || '[]');
    } catch {}
    if (!Array.isArray(seen)) seen = [];
    if (seen.includes(tag)) return false;
    seen.push(tag);
    try {
      localStorage.setItem(CRY_KEY, JSON.stringify(seen.slice(-300)));
    } catch {}
    return true;
  }

  markShinySeen(key: string): void {
    if (this.shinyState(key) !== 1) return;
    this.shinies[key] = 2;
    this.save();
  }

  // partners from before EXP keep their level (seed level^3) and count only rows after the first open
  private expRecord(key: string): ExpRecord {
    let rec = this.exps[key];
    if (!rec || typeof rec.e !== 'number') {
      const entry = this.get(key);
      const fresh = this.fresh.has(key);
      rec = this.exps[key] = { e: levelFor(fresh ? 0 : entry[1]) ** 3, t: 0, k: 0, w: fresh ? -1 : null, m: -1, v: {} };
      this.save();
    }
    // records from the hash-set version: their counted rows stay behind the watermark
    if (!rec.v || typeof rec.v !== 'object') {
      if ((rec as any).h?.length) rec.w = Math.max(rec.w ?? -1, rec.m);
      delete (rec as any).h;
      rec.v = {};
    }
    return rec;
  }

  exp(key: string): number {
    const rec = this.expRecord(key);
    return Math.min(MAX_LEVEL ** 3, rec.e + Math.floor(rec.t / TOKENS_PER_EXP) + EXP_PER_TOOL * rec.k);
  }

  level(key: string): number {
    return levelForExp(this.exp(key));
  }

  expWatermark(key: string): number | null {
    return this.expRecord(key).w;
  }

  setExpWatermark(key: string, row: number): void {
    this.expRecord(key).w = row;
    this.save();
  }

  // each stable id (a message's data-turn-key, a tool group's data-item-key) counts its largest reading once;
  // returns the levels around the gain
  addExp(key: string, items: ExpItem[]): { from: number; to: number; level: number; before: number; after: number } | null {
    const rec = this.expRecord(key);
    if (rec.w === null) return null;
    const from = this.exp(key);
    const level = this.level(key);
    const before = this.species(key);
    let added = false;
    for (const item of items) {
      if (item.row <= rec.w) continue;
      const id = hash(item.id).toString(36);
      const had = rec.v[id] ?? [0, 0];
      const tokens = Math.max(had[0], item.tokens);
      const tools = Math.max(had[1], item.tools);
      rec.m = Math.max(rec.m, item.row);
      if (tokens === had[0] && tools === had[1]) continue;
      rec.t += tokens - had[0];
      rec.k += tools - had[1];
      rec.v[id] = [tokens, tools];
      added = true;
    }
    if (!added) return null;
    const ids = Object.keys(rec.v);
    if (ids.length > EXP_HASH_CAP) for (const id of ids.slice(0, ids.length - EXP_HASH_CAP)) delete rec.v[id];
    this.get(key, true);
    this.save();
    return { from, to: this.exp(key), level, before, after: this.species(key) };
  }

  get(key: string, touch = false): Entry {
    let entry = this.entries[key];
    if (!Array.isArray(entry) || !assets.data?.n[entry[0]]) {
      entry = this.entries[key] = [pickBase(key), 0, Date.now()];
      this.fresh.add(key);
      this.save();
    } else if (touch) {
      entry[2] = Date.now();
      this.save();
    }
    // the partner's one shiny roll happens as soon as it exists (or on the first load after shiny odds arrived)
    if (this.shinies[key] === undefined) this.shinyState(key);
    return entry;
  }

  species(key: string, level?: number): number {
    const entry = this.get(key);
    return speciesAt(key, entry[0], stageFor(level ?? this.level(key)));
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
    for (const key of Object.keys(this.exps)) if (!this.entries[key]) delete this.exps[key];
    for (const key of Object.keys(this.shinies)) if (!this.entries[key]) delete this.shinies[key];
    // threads past the hash cap keep their totals; their old rows stay out through the watermark
    const recent = Object.keys(this.exps).sort((a, b) => (this.entries[b]?.[2] ?? 0) - (this.entries[a]?.[2] ?? 0));
    for (const key of recent.slice(EXP_THREAD_CAP)) {
      const rec = this.exps[key];
      if (rec.v && Object.keys(rec.v).length) {
        rec.w = Math.max(rec.w ?? -1, rec.m);
        rec.v = {};
      }
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, t: this.entries }));
      localStorage.setItem(EXP_KEY, JSON.stringify({ v: 1, x: this.exps }));
      localStorage.setItem(SHINY_KEY, JSON.stringify({ v: 1, s: this.shinies }));
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


  snapshot(): Record<string, Entry> {
    return this.entries;
  }

  expSnapshot(key: string): ExpRecord {
    return this.expRecord(key);
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

// sounds that play on their own need the user looking: the page visible and the app window focused
const watching = () => !document.hidden && document.hasFocus();

const ns = ((window as any).__pkp = {});
Object.assign(ns, {
  EVOLVE_AT, START_LEVEL, MAX_LEVEL, SHINY_ODDS, levelFor, levelForExp, CHARS_PER_TOKEN, hash, rng, rt, errors, report, guard, cleanups, timers, later, cancel, listen, el, assets, store, stageFor, speciesAt,
  threadKeyFromRow, currentThread, watching, scale, applyScale, scaleStyle, trainerSetting, paintTrainer, groupBase,
});
