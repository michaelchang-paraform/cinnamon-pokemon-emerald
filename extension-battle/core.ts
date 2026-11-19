declare const cinnamon: {
  settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    onChange(fn: (all: Record<string, unknown>) => void): void;
  };
  onDispose(fn: () => void): void;
};


const DEFAULT_PORT = 41851;
const START_COMMAND = './helper/start.sh';
const TEXT_MS = 22;
const HOLD_MS = 800;
const HP_STEP_MS = 16;
const BAR = 48;
const RETRY_MS = [1000, 2000, 4000, 8000, 10000];
const NAME_MAX = 18;
const LAUNCH_ANCHORS = ['Session rail', 'Terminal', 'Changes', 'Browser', 'Files', 'View options'];
const NAV_SELECTOR = ['Hide sidebar', 'Show sidebar', 'Back', 'Forward'].map((label) => `button[aria-label="${label}"]`).join(',');
const POKEMON = 'POKéMON';
const LAUNCH_SELECTOR = LAUNCH_ANCHORS.map((label) => `button[aria-label="${label}"]`).join(',');

type SideId = 'p1' | 'p2';
type Conn = 'offline' | 'connecting' | 'online';
type Msg = Record<string, any>;

const rt = { disposed: false };
const debugLog = { errors: [] as string[], unknown: {} as Record<string, number> };
function report(err: unknown): void {
  const text = String((err as Error)?.stack ?? err).slice(0, 500);
  if (debugLog.errors.length < 30) debugLog.errors.push(text);
}

const timers = new Set<number>();
function later(fn: () => void, ms: number): number {
  const id = window.setTimeout(() => {
    timers.delete(id);
    if (rt.disposed) return;
    try {
      fn();
    } catch (err) {
      report(err);
    }
  }, ms);
  timers.add(id);
  return id;
}
function cancelLater(id: number): void {
  clearTimeout(id);
  timers.delete(id);
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      resolve();
    }, Math.max(0, ms));
    timers.add(id);
  });

const cleanups: Array<() => void> = [];
function listen(target: EventTarget, type: string, fn: (event: any) => void, options?: AddEventListenerOptions | boolean): void {
  const handler = (event: Event) => {
    try {
      fn(event);
    } catch (err) {
      report(err);
    }
  };
  target.addEventListener(type, handler, options);
  cleanups.push(() => target.removeEventListener(type, handler, options));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function place<T extends HTMLElement>(node: T, x: number, y: number, w?: number, h?: number): T {
  node.classList.add('pkb-abs');
  node.style.left = `calc(var(--u) * ${x})`;
  node.style.top = `calc(var(--u) * ${y})`;
  if (w !== undefined) node.style.width = `calc(var(--u) * ${w})`;
  if (h !== undefined) node.style.height = `calc(var(--u) * ${h})`;
  return node;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toId = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const upper = (text: string) => text.toUpperCase();
const moveText = (name: string) => {
  if (/^Hidden Power/.test(name)) return 'HIDDEN POWER';
  const text = upper(name.replace(/\s\d+$/, ''));
  return text.length > 12 ? text.replace(/[ -]/g, '') : text;
};
const monText = (name: string) => upper(name).replace(/^NIDORAN-F$/, 'NIDORAN♀').replace(/^NIDORAN-M$/, 'NIDORAN♂');

const SVG_NS = 'http://www.w3.org/2000/svg';
function pixelArt(rows: string[], palette: Record<string, string>, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const w = Math.max(...rows.map((row) => row.length));
  const h = rows.length;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `pkb-px ${cls}`.trim());
  svg.style.setProperty('--w', String(w));
  svg.style.setProperty('--h', String(h));
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === c) end++;
      const color = palette[c];
      if (color) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(end - x));
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', color);
        svg.append(rect);
      }
      x = end;
    }
  });
  return svg;
}

const CURSOR = ['x....', 'xx...', 'xxx..', 'xxxx.', 'xxxxx', 'xxxx.', 'xxx..', 'xx...', 'x....'];
const CURSOR_DARK = { x: '#404040' };
const CURSOR_LIGHT = { x: '#f8f8f8' };
const BALL = [
  '....kkkk....',
  '..kkrrrrkk..',
  '.krrrrrrwwk.',
  '.krrrrrrrwk.',
  'krrrrrrrrrrk',
  'kkkkkwwkkkkk',
  'kwwwkwwkwwwk',
  'kwwwwkkwwwwk',
  '.kwwwwwwwwk.',
  '.kwwwwwwwgk.',
  '..kkggggkk..',
  '....kkkk....',
];
const BALL_PAL = { k: '#202020', r: '#e83838', w: '#f8f8f8', g: '#b0b0b8' };
const BALL_SMALL = ['.kkk.', 'krrrk', 'kkwkk', 'kwwwk', '.kkk.'];
const BALL_SMALL_FNT = { k: '#383838', r: '#888888', w: '#c8c8c8' };
const BALL_SMALL_EMPTY = { k: '#888888' };
const CLOSE_ART = ['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'];

const TINY: Record<string, string[]> = {
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  H: ['101', '101', '111', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  N: ['101', '111', '111', '111', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  X: ['101', '101', '010', '101', '101'],
  v: ['000', '000', '101', '101', '010'],
  Z: ['111', '001', '010', '100', '111'],
};
function tinyText(text: string, color: string, background?: string): SVGSVGElement {
  const rows: string[] = [];
  for (let y = 0; y < 5; y++) {
    rows.push(
      [...text]
        .map((c) => (TINY[c] ?? ['000', '000', '000', '000', '000'])[y].replace(/1/g, 'x').replace(/0/g, background ? 'b' : '.'))
        .join(background ? 'b' : '.'),
    );
  }
  const framed = background ? [rows[0].replace(/./g, 'b'), ...rows, rows[0].replace(/./g, 'b')].map((row) => `b${row}b`) : rows;
  return pixelArt(framed, { x: color, b: background ?? '' });
}

const ACUTE = ['.x', 'x.'];
function withAcute(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text.split('É').forEach((part, i) => {
    if (i > 0) {
      const letter = el('span', 'pkb-acute', 'E');
      letter.append(pixelArt(ACUTE, { x: 'currentColor' }));
      fragment.append(letter);
    }
    if (part) fragment.append(part);
  });
  return fragment;
}

const STATUS_COLORS: Record<string, string> = { par: '#c8a000', brn: '#e05830', psn: '#a050c0', tox: '#a050c0', slp: '#8088a0', frz: '#4898e0', fnt: '#b03838' };
const STATUS_TAGS: Record<string, string> = { par: 'PAR', brn: 'BRN', psn: 'PSN', tox: 'PSN', slp: 'SLP', frz: 'FRZ', fnt: 'FNT' };

const cssString = (styles: CSSStyleDeclaration, property: string) => styles.getPropertyValue(property).trim().replace(/^["']|["']$/g, '');
function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const SOUND_KEY = 'pokemon-emerald-sound:v1';
const SOUND_EVENT = 'pe-sound-change';
type SoundState = { master: { volume: number }; windows: { battle: { muted: boolean } } & Record<string, unknown> } & Record<string, unknown>;
const soundObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const OLD_BATTLE_KEYS = ['music', 'musicMuted', 'sfx', 'sfxMuted'];

function cleanSound(raw: unknown): SoundState {
  const r = soundObj(raw);
  const windows = soundObj(r.windows);
  const summary = soundObj(windows.summary);
  const volume = soundObj(r.master).volume;
  return {
    ...r,
    master: { volume: typeof volume === 'number' && Number.isFinite(volume) ? clamp(volume, 0, 1) : 0.35 },
    windows: { ...windows, summary: { ...summary, muted: summary.muted === true }, battle: { muted: soundObj(windows.battle).muted !== false } },
  };
}

function readSound(): SoundState {
  try {
    return cleanSound(JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null'));
  } catch {
    return cleanSound(null);
  }
}

function writeBattleSound(patch: { muted: boolean }): SoundState {
  return writeSound((s) => ({ ...s, windows: { ...s.windows, battle: { ...s.windows.battle, ...patch } } }));
}

function writeSound(change: (state: SoundState) => Record<string, unknown>): SoundState {
  const next = cleanSound(change(readSound()));
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(next));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(SOUND_EVENT, { detail: next }));
  } catch {}
  return next;
}

type SoundName = 'hit' | 'super' | 'weak' | 'faint' | 'ball' | 'status' | 'up' | 'down' | 'heal' | 'win' | 'lose';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  sound = readSound();
  onChange: (() => void) | null = null;

  constructor() {
    this.migrate();
    listen(window, SOUND_EVENT, (event: CustomEvent) => this.apply(cleanSound(event.detail)));
    listen(window, 'storage', (event: StorageEvent) => {
      if (event.key === SOUND_KEY) this.apply(readSound());
    });
  }

  // earlier shapes carried mixer levels and no deliberate mute choice, so they restart at the muted default
  private migrate(): void {
    try {
      const raw = soundObj(JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null'));
      const battle = soundObj(soundObj(raw.windows).battle);
      if (!OLD_BATTLE_KEYS.some((key) => key in battle) && !('muted' in soundObj(raw.master))) return;
      this.sound = writeBattleSound({ muted: true });
    } catch {}
  }

  get level(): number {
    return this.sound.windows.battle.muted ? 0 : this.sound.master.volume;
  }

  get enabled(): boolean {
    return this.level > 0;
  }

  get gain(): number | null {
    return this.master ? this.master.gain.value : null;
  }

  private apply(state: SoundState): void {
    this.sound = state;
    if (this.master) this.master.gain.value = this.level;
    this.onChange?.();
  }

  unlock(): void {
    if (rt.disposed || !this.enabled) return;
    try {
      // the synth context only starts inside a user gesture; battle events before one stay silent
      if (!this.ctx && !(navigator as any).userActivation?.isActive) return;
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.level;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {}
  }

  play(name: SoundName): void {
    if (rt.disposed || !this.enabled) return;
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      const t = ctx.currentTime + 0.01;
      const note = (f0: number, dur: number, at = 0, f1 = f0, vol = 0.07, type: OscillatorType = 'square') => this.osc(type, f0, f1, t + at, dur, vol);
      switch (name) {
        case 'hit': this.noise(t, 0.14, 0.3, 2400); note(150, 0.1, 0, 60, 0.08); break;
        case 'super': this.noise(t, 0.24, 0.38, 4200); note(220, 0.2, 0, 45, 0.1); break;
        case 'weak': this.noise(t, 0.1, 0.18, 1200); break;
        case 'faint': note(900, 0.55, 0, 110, 0.07); break;
        case 'ball': note(300, 0.12, 0, 1400, 0.06); this.noise(t + 0.12, 0.09, 0.18, 6000); break;
        case 'status': note(420, 0.06, 0); note(320, 0.06, 0.07); note(420, 0.06, 0.14); note(320, 0.08, 0.21); break;
        case 'up': note(400, 0.28, 0, 1100, 0.05); break;
        case 'down': note(1000, 0.28, 0, 300, 0.05); break;
        case 'heal': note(660, 0.07, 0, 660, 0.05, 'triangle'); note(880, 0.07, 0.08, 880, 0.05, 'triangle'); note(1100, 0.1, 0.16, 1100, 0.05, 'triangle'); break;
        case 'win': [523, 659, 784, 1046].forEach((f, i) => note(f, i === 3 ? 0.35 : 0.12, i * 0.13)); break;
        case 'lose': [392, 330, 262].forEach((f, i) => note(f, 0.2, i * 0.22, f, 0.06)); break;
      }
    } catch {}
  }

  private osc(type: OscillatorType, f0: number, f1: number, start: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, start);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
    gain.gain.setValueAtTime(vol, start);
    gain.gain.setValueAtTime(vol, start + dur * 0.75);
    gain.gain.linearRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(this.master!);
    osc.start(start);
    osc.stop(start + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  private noise(start: number, dur: number, vol: number, cutoff: number): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = this.noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(filter).connect(gain).connect(this.master!);
    src.start(start);
    src.stop(start + dur + 0.02);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  dispose(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

class Link {
  conn: Conn = 'offline';
  attempts = 0;
  private ws: WebSocket | null = null;
  private retryTimer = 0;
  private connecting = false;

  constructor(
    private readonly onMessage: (msg: Msg) => void,
    private readonly onState: () => void,
    private readonly wantsRetry: () => boolean,
  ) {}

  get port(): number {
    const saved = Number(cinnamon.settings.get('port'));
    return Number.isInteger(saved) && saved > 0 && saved < 65536 ? saved : DEFAULT_PORT;
  }

  start(): void {
    if (this.ws || this.connecting || rt.disposed) return;
    cancelLater(this.retryTimer);
    this.retryTimer = 0;
    void this.connect();
  }

  retryNow(): void {
    this.attempts = 0;
    this.start();
  }

  send(msg: Msg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setConn(conn: Conn): void {
    if (this.conn === conn) return;
    this.conn = conn;
    this.onState();
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    this.attempts++;
    if (this.conn === 'offline' && this.attempts === 1) this.setConn('connecting');
    try {
      const controller = new AbortController();
      const abort = later(() => controller.abort(), 2000);
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, { cache: 'no-store', signal: controller.signal });
      cancelLater(abort);
      const health = (await res.json()) as Msg;
      if (!health?.ok || health.protocol !== 1) throw new Error('not the battle helper');
      if (rt.disposed) return;
      this.open();
    } catch {
      this.connecting = false;
      this.setConn('offline');
      this.scheduleRetry();
    }
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    } catch {
      this.connecting = false;
      this.setConn('offline');
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connecting = false;
      this.attempts = 0;
      const name = savedName();
      ws.send(JSON.stringify(name ? { type: 'hello', protocol: 1, name } : { type: 'hello', protocol: 1 }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Msg;
        if (msg && typeof msg.type === 'string') {
          if (msg.type === 'welcome') this.setConn('online');
          this.onMessage(msg);
        }
      } catch (err) {
        report(err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connecting = false;
      this.setConn('offline');
      this.scheduleRetry();
    };
    ws.onerror = () => {};
  }

  scheduleRetry(): void {
    if (rt.disposed || this.retryTimer || this.ws || this.connecting || !this.wantsRetry()) return;
    const delay = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)];
    this.retryTimer = later(() => {
      this.retryTimer = 0;
      this.start();
    }, delay);
  }

  dispose(): void {
    cancelLater(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {}
    }
  }
}

function savedName(): string {
  const raw = cinnamon.settings.get('name');
  return typeof raw === 'string' ? cleanName(raw) : '';
}
function cleanName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 ._'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

type MenuItem = { label: string; disabled?: boolean; pick: () => void; cls?: string; decorate?: (row: HTMLElement) => void };

// Emerald's 8 px cursor column: arrow ink in columns 1 to 6, label from column 8
const CURSOR_COL = 8;

function peSound(id: 'SE_SELECT' | 'SE_FAILURE'): void {
  try {
    (window as any).__peAudio?.play(id, { window: 'battle' });
  } catch {}
}

class Menu {
  index = 0;
  focused = true;
  private rows: HTMLElement[] = [];

  constructor(
    readonly box: HTMLElement,
    public items: MenuItem[],
    readonly opts: { cols?: number; light?: boolean; onMove?: (index: number) => void },
  ) {
    box.classList.add('pkb-menu');
    box.style.setProperty('--pkb-cur-col', String(CURSOR_COL));
    box.style.setProperty('--cols', String(opts.cols ?? 1));
  }

  render(): void {
    this.rows = [];
    this.index = clamp(this.index, 0, Math.max(0, this.items.length - 1));
    const rows = this.items.map((item, i) => {
      const row = el('div', `pkb-item ${item.cls ?? ''}`.trim());
      const assets = ns.assets;
      const cur = el('img', 'pkb-cur');
      cur.alt = '';
      cur.src = assets.url('curAction');
      row.append(cur);
      item.decorate?.(row);
      row.append(assets.text(item.label, { color: item.disabled ? 'gray' : 'std' }));
      if (item.disabled) row.classList.add('is-off');
      row.addEventListener('pointerenter', () => {
        if (this.index === i) return;
        this.index = i;
        this.paint();
        this.opts.onMove?.(i);
      });
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        this.index = i;
        this.paint();
        this.pick();
      });
      return row;
    });
    this.rows = rows;
    this.box.replaceChildren(...rows);
    this.paint();
  }

  paint(): void {
    this.box.classList.toggle('is-focus', this.focused);
    this.rows.forEach((row, i) => row.classList.toggle('is-on', i === this.index));
  }

  move(dx: number, dy: number): boolean {
    const cols = this.opts.cols ?? 1;
    const n = this.items.length;
    if (!n) return false;
    let next = this.index;
    if (cols === 1) {
      if (!dy) return false;
      next = (this.index + dy + n) % n;
    } else {
      const col = (this.index % cols) + dx;
      const row = Math.floor(this.index / cols) + dy;
      if (col < 0 || col >= cols || row < 0) return false;
      next = row * cols + col;
      if (next >= n) return false;
    }
    if (next !== this.index) {
      this.index = next;
      this.paint();
      peSound('SE_SELECT');
      this.opts.onMove?.(next);
    }
    return true;
  }

  pick(): void {
    const item = this.items[this.index];
    if (!item) return;
    peSound(item.disabled ? 'SE_FAILURE' : 'SE_SELECT');
    item.pick();
  }
}

type Action = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';


function parseLine(line: string): { cmd: string; args: string[]; kw: Record<string, string> } {
  const parts = line.split('|');
  parts.shift();
  const cmd = parts.shift() ?? '';
  const args: string[] = [];
  const kw: Record<string, string> = {};
  for (const part of parts) {
    const match = /^\[([a-zA-Z]+)\]\s?(.*)$/.exec(part);
    if (match) kw[match[1]] = match[2] ?? '';
    else args.push(part);
  }
  return { cmd, args, kw };
}

function parseIdent(ident: string | undefined): { side: SideId; name: string } | null {
  const match = /^(p[12])[a-z]?:\s?(.*)$/.exec(ident ?? '');
  return match ? { side: match[1] as SideId, name: match[2] } : null;
}

function parseDetails(details: string): { species: string; level: number; gender: string } {
  const parts = (details ?? '').split(',').map((part) => part.trim());
  const level = Number(/^L(\d+)$/.exec(parts.find((p) => /^L\d+$/.test(p)) ?? '')?.[1] ?? 100);
  const gender = parts.find((p) => p === 'M' || p === 'F') ?? '';
  return { species: parts[0] ?? '', level, gender };
}

function parseHp(text: string | undefined): { hp: number; max: number | null; status: string } {
  const [frac = '', status = ''] = (text ?? '').trim().split(/\s+/);
  if (frac === '0' || status === 'fnt') return { hp: 0, max: null, status: 'fnt' };
  const [hp, max] = frac.split('/').map(Number);
  return { hp: Number.isFinite(hp) ? hp : 0, max: Number.isFinite(max) && max > 0 ? max : null, status };
}

const hpPx = (hp: number, max: number) => (hp <= 0 ? 0 : clamp(Math.round((hp / Math.max(1, max)) * BAR), 1, BAR));
const effectName = (text: string | undefined) => (text ?? '').replace(/^(move|ability|item):\s*/, '');

const STAT_NAMES: Record<string, string> = { atk: 'ATTACK', def: 'DEFENSE', spa: 'SP. ATK', spd: 'SP. DEF', spe: 'SPEED', accuracy: 'accuracy', evasion: 'evasiveness' };
const WEATHER_START: Record<string, string> = { SunnyDay: 'The sunlight got bright!', RainDance: 'It started to rain!', Sandstorm: 'A sandstorm brewed!', Hail: 'It started to hail!' };
const WEATHER_UPKEEP: Record<string, string> = { SunnyDay: 'The sunlight is strong.', RainDance: 'Rain continues to fall.', Sandstorm: 'The sandstorm rages.', Hail: 'Hail continues to fall.' };
const WEATHER_END: Record<string, string> = { SunnyDay: 'The sunlight faded.', RainDance: 'The rain stopped.', Sandstorm: 'The sandstorm subsided.', Hail: 'The hail stopped.' };
const WEATHER_ABILITY: Record<string, string> = { SunnyDay: "intensified the sun's rays!", RainDance: 'made it rain!', Sandstorm: 'whipped up a sandstorm!', Hail: 'made it hail!' };
const WEATHER_LABEL: Record<string, string> = { SunnyDay: 'SUN', RainDance: 'RAIN', Sandstorm: 'SANDSTORM', Hail: 'HAIL' };

const TRAPS = ['Bind', 'Wrap', 'Fire Spin', 'Whirlpool', 'Sand Tomb', 'Clamp'];

function damageLine(from: string, L: string): string {
  const lines: Record<string, string> = {
    psn: `${L} is hurt by poison!`,
    tox: `${L} is hurt by poison!`,
    brn: `${L} is hurt by its burn!`,
    Sandstorm: `${L} is buffeted by the sandstorm!`,
    Hail: `${L} is pelted by HAIL!`,
    Recoil: `${L} is hit with recoil!`,
    recoil: `${L} is hit with recoil!`,
    'Leech Seed': `${L}'s health is sapped by LEECH SEED!`,
    confusion: 'It hurt itself in its confusion!',
    Spikes: `${L} is hurt by SPIKES!`,
    Curse: `${L} is afflicted by the CURSE!`,
    Nightmare: `${L} is locked in a NIGHTMARE!`,
    'Rough Skin': `${L} was hurt by ROUGH SKIN!`,
  };
  if (TRAPS.includes(from)) return `${L} is hurt by ${upper(from)}!`;
  return lines[from] ?? '';
}

function healLine(from: string, L: string, kw: Record<string, string>, ofLabel: string): string {
  if (from === 'Leftovers') return `${L} restored a little HP using its LEFTOVERS!`;
  if (from === 'drain') return `${ofLabel} had its energy drained!`;
  if (from === 'Ingrain') return `${L} absorbed nutrients with its roots!`;
  if (from === 'Wish') return `${L}'s wish came true!`;
  if (from === 'Rest') return `${L} slept and became healthy!`;
  if (/Berry$/.test(from) || from === 'Shell Bell' || kw.silent !== undefined) return '';
  if (kw.from?.startsWith('ability:')) return `${L} restored HP using its ${upper(from)}!`;
  return `${L} regained health!`;
}

function statusLine(start: boolean, status: string, L: string): string {
  const begin: Record<string, string> = {
    brn: `${L} was burned!`,
    par: `${L} is paralyzed!\nIt may be unable to move!`,
    slp: `${L} fell asleep!`,
    frz: `${L} was frozen solid!`,
    psn: `${L} was poisoned!`,
    tox: `${L} is badly poisoned!`,
  };
  const cure: Record<string, string> = {
    slp: `${L} woke up!`,
    frz: `${L} was defrosted!`,
    par: `${L} was cured of paralysis!`,
    brn: `${L}'s burn was healed!`,
    psn: `${L} was cured of its poisoning!`,
    tox: `${L} was cured of its poisoning!`,
  };
  return (start ? begin : cure)[status] ?? '';
}

function cantLine(L: string, reason: string, move: string): string {
  const text: Record<string, string> = {
    slp: `${L} is fast asleep.`,
    par: `${L} is paralyzed!\nIt can't move!`,
    frz: `${L} is frozen solid!`,
    flinch: `${L} flinched!`,
    recharge: `${L} must recharge!`,
    Attract: `${L} is immobilized by love!`,
    nopp: "But there's no PP left for the move!",
    Truant: `${L} is loafing around!`,
    Disable: `${L}'s ${move} is disabled!`,
    Taunt: `${L} can't use ${move} after the taunt!`,
    'Focus Punch': `${L} lost its focus and couldn't move!`,
    Imprison: `${L} can't use the sealed ${move}!`,
    Damp: `${L} can't use ${move}!`,
  };
  return text[reason] ?? `${L} can't move!`;
}

function sideLine(start: boolean, mine: boolean, effect: string): string {
  const team = mine ? 'your team' : "the foe's team";
  const Team = mine ? 'Your team' : "The foe's team";
  const startText: Record<string, string> = {
    Reflect: `REFLECT raised ${team}'s DEFENSE!`,
    'Light Screen': `LIGHT SCREEN raised ${team}'s SP. DEF!`,
    Safeguard: `${Team} became cloaked in a mystical veil!`,
    Mist: `${Team} became shrouded in MIST!`,
    Spikes: `SPIKES were scattered around ${team}!`,
  };
  const endText: Record<string, string> = {
    Reflect: `${Team}'s REFLECT wore off!`,
    'Light Screen': `${Team}'s LIGHT SCREEN wore off!`,
    Safeguard: `${Team} is no longer protected by SAFEGUARD!`,
    Mist: `${Team} is no longer protected by MIST!`,
    Spikes: `The SPIKES around ${team} disappeared!`,
  };
  return (start ? startText : endText)[effect] ?? '';
}

function effectLine(cmd: string, args: string[], kw: Record<string, string>, L: string, of: string): string {
  const effect = effectName(args[1]);
  const arg = upper(effectName(args[2]));
  let text = '';
  if (cmd === '-start') {
    const map: Record<string, string> = {
      confusion: kw.fatigue !== undefined ? `${L} became confused due to fatigue!` : `${L} became confused!`,
      Substitute: `${L} made a SUBSTITUTE!`,
      'Leech Seed': `${L} was seeded!`,
      'Focus Energy': `${L} is getting pumped!`,
      Encore: `${L} got an ENCORE!`,
      Taunt: `${L} fell for the TAUNT!`,
      Disable: `${L}'s ${arg} was disabled!`,
      Attract: `${L} fell in love!`,
      Yawn: `${L} grew drowsy!`,
      Curse: `${of} cut its own HP and laid a CURSE on ${L}!`,
      Nightmare: `${L} began having a NIGHTMARE!`,
      Ingrain: `${L} planted its roots!`,
      Bide: `${L} is storing energy!`,
      Uproar: `${L} caused an UPROAR!`,
      typechange: `${L} transformed into the ${arg} type!`,
      Charge: `${L} began charging power!`,
      Foresight: `${L} was identified!`,
      'Odor Sleuth': `${L} was identified!`,
      Torment: `${L} was subjected to TORMENT!`,
      Imprison: `${L} sealed the opponent's moves!`,
      'Flash Fire': `${L}'s FLASH FIRE raised its FIRE power!`,
      'Mud Sport': "Electricity's power was weakened!",
      'Water Sport': "Fire's power was weakened!",
      'Future Sight': `${L} foresaw an attack!`,
      'Doom Desire': `${L} chose DOOM DESIRE as its destiny!`,
      Stockpile: `${L} stockpiled ${args[2] ?? ''}!`,
      stockpile1: `${L} stockpiled 1!`,
      stockpile2: `${L} stockpiled 2!`,
      stockpile3: `${L} stockpiled 3!`,
      perish3: `${L}'s perish count fell to 3.`,
      perish2: `${L}'s perish count fell to 2.`,
      perish1: `${L}'s perish count fell to 1.`,
      perish0: `${L}'s perish count fell to 0.`,
      'Magic Coat': `${L} shrouded itself with MAGIC COAT!`,
    };
    text = map[effect] ?? '';
  } else if (cmd === '-end') {
    const map: Record<string, string> = {
      confusion: `${L} snapped out of confusion!`,
      Substitute: `${L}'s SUBSTITUTE faded!`,
      'Leech Seed': `${L} was freed from LEECH SEED!`,
      Encore: `${L}'s ENCORE ended!`,
      Disable: `${L} is no longer disabled!`,
      Bide: `${L} unleashed energy!`,
      Uproar: `${L} calmed down.`,
      'Future Sight': `${L} took the FUTURE SIGHT attack!`,
      'Doom Desire': `${L} took the DOOM DESIRE attack!`,
    };
    text = TRAPS.includes(effect) ? `${L} was freed from ${upper(effect)}!` : map[effect] ?? '';
  } else if (cmd === '-activate') {
    const map: Record<string, string> = {
      Protect: `${L} protected itself!`,
      Substitute: kw.damage !== undefined ? `The SUBSTITUTE took damage for ${L}!` : `${L}'s SUBSTITUTE blocked it!`,
      confusion: `${L} is confused!`,
      Attract: `${L} is in love with ${of}!`,
      Bind: `${L} was squeezed by ${of}!`,
      Wrap: `${L} was wrapped by ${of}!`,
      'Fire Spin': `${L} was trapped in the vortex!`,
      Whirlpool: `${L} was trapped in the vortex!`,
      'Sand Tomb': `${L} was trapped by SAND TOMB!`,
      Clamp: `${of} CLAMPED ${L}!`,
      'Destiny Bond': `${L} took its attacker down with it!`,
      Endure: `${L} endured the hit!`,
      'Focus Band': `${L} hung on using its FOCUS BAND!`,
      Spite: `It reduced the PP of ${L}'s ${arg}!`,
      Mimic: `${L} learned ${arg}!`,
      Snatch: `${L} snatched ${of}'s move!`,
      'Lock-On': `${L} took aim!`,
      'Mind Reader': `${L} took aim!`,
      Trick: `${L} switched items with its target!`,
      'Skill Swap': `${L} swapped abilities with its target!`,
      'Magic Coat': `${L} bounced the move back!`,
      Bide: `${L} is storing energy!`,
      'Shed Skin': `${L}'s SHED SKIN cured its status!`,
      Pursuit: '',
    };
    text = map[effect] ?? '';
  } else if (cmd === '-singleturn') {
    const map: Record<string, string> = {
      Protect: `${L} protected itself!`,
      Endure: `${L} braced itself!`,
      'Focus Punch': `${L} is tightening its focus!`,
      'Magic Coat': `${L} shrouded itself with MAGIC COAT!`,
      Snatch: `${L} waits for a target to make a move!`,
      'Follow Me': `${L} became the center of attention!`,
      'Helping Hand': `${L} is ready to help!`,
    };
    text = map[effect] ?? '';
  } else if (cmd === '-singlemove') {
    const map: Record<string, string> = {
      'Destiny Bond': `${L} is trying to take its foe down with it!`,
      Grudge: `${L} wants the foe to bear a GRUDGE!`,
      Rage: '',
    };
    text = map[effect] ?? '';
  } else if (cmd === '-prepare') {
    const map: Record<string, string> = {
      'Solar Beam': `${L} took in sunlight!`,
      SolarBeam: `${L} took in sunlight!`,
      Fly: `${L} flew up high!`,
      Dig: `${L} dug a hole!`,
      Dive: `${L} hid underwater!`,
      Bounce: `${L} sprang up!`,
      'Razor Wind': `${L} whipped up a whirlwind!`,
      'Sky Attack': `${L} is glowing!`,
      'Skull Bash': `${L} lowered its head!`,
    };
    text = map[effect] ?? '';
  }
  return text;
}

const ns = ((window as any).__pkb = {});
Object.assign(ns, { peSound, CURSOR_COL, readSound, writeSound, writeBattleSound, SOUND_EVENT, SOUND_KEY, DEFAULT_PORT, START_COMMAND, TEXT_MS, HOLD_MS, HP_STEP_MS, BAR, RETRY_MS, NAME_MAX, LAUNCH_ANCHORS, POKEMON, LAUNCH_SELECTOR, NAV_SELECTOR, rt, debugLog, report, timers, later, cancelLater, sleep, cleanups, listen, el, place, clamp, toId, upper, moveText, monText, SVG_NS, pixelArt, CURSOR, CURSOR_DARK, CURSOR_LIGHT, BALL, BALL_PAL, BALL_SMALL, BALL_SMALL_FNT, BALL_SMALL_EMPTY, CLOSE_ART, TINY, tinyText, withAcute, STATUS_COLORS, STATUS_TAGS, cssString, decodeBase64, Sfx, Link, savedName, cleanName, Menu, parseLine, parseIdent, parseDetails, parseHp, hpPx, effectName, STAT_NAMES, WEATHER_START, WEATHER_UPKEEP, WEATHER_END, WEATHER_ABILITY, WEATHER_LABEL, TRAPS, damageLine, healLine, statusLine, cantLine, sideLine, effectLine });
