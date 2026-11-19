// GBA screen drawing for the summary and naming screens: one 240x160 canvas composed at 1x in game coordinates
// (art, FONT_NORMAL / FONT_SMALL glyphs from pokeemerald, sprites), scaled once at the root with pixelated
// rendering. Also the shared sound state the partners and battle windows read.
const G = (window as any).__pkp;

type Color = [string, string];
type Rect = { x: number; y: number; w: number; h: number };
type Box = Rect & { kind: 'text' | 'cursor' | 'control'; name: string; inside?: Rect };

const GLYPH_CACHE = new Map<string, Uint8Array>();
function glyphBits(font: 'nf' | 'sf'): Uint8Array | null {
  const data = G.assets.dex?.[font];
  if (!data) return null;
  let bits = GLYPH_CACHE.get(font);
  if (!bits) {
    bits = Uint8Array.from(atob(data.bits), (c) => c.charCodeAt(0));
    GLYPH_CACHE.set(font, bits);
  }
  return bits;
}
const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

// one text run as a 1x canvas plus its ink bounds; characters the GBA font lacks (Hangul) fall back to Galmuri
function glyphRun(value: string, color: Color, font: 'nf' | 'sf' = 'nf'): { canvas: HTMLCanvasElement; ink: Rect } {
  const data = G.assets.dex?.[font];
  const map = G.assets.dex?.sf?.c ?? {};
  const bits = glyphBits(font);
  const chars = [...value];
  const plan = chars.map((ch) => {
    const code = map[ch];
    if (code !== undefined && bits) return { code, w: data.w[code] ?? 6 };
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `${font === 'nf' ? 12 : 10}px "PE Galmuri", "PE Galmuri Mono", sans-serif`;
    return { ch, w: Math.ceil(probe.measureText(ch).width) + 1 };
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, plan.reduce((sum, p) => sum + p.w, 0));
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, 16);
  const ink = rgb(color[0]);
  const shade = rgb(color[1]);
  let pen = 0;
  const fallback: Array<{ ch: string; x: number }> = [];
  for (const p of plan) {
    if ('code' in p && p.code !== undefined && bits) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < p.w; x++) {
          const at = p.code * 256 + y * 16 + x;
          const v = (bits[at >> 2] >> ((at & 3) * 2)) & 3;
          if (v === 1 || v === 2) image.data.set([...(v === 1 ? ink : shade), 255], (y * canvas.width + pen + x) * 4);
        }
      }
    } else fallback.push({ ch: (p as any).ch, x: pen });
    pen += p.w;
  }
  ctx.putImageData(image, 0, 0);
  for (const f of fallback) {
    ctx.font = `${font === 'nf' ? 12 : 10}px "PE Galmuri", "PE Galmuri Mono", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = `#${color[1]}`;
    ctx.fillText(f.ch, f.x + 1, 3);
    ctx.fillStyle = `#${color[0]}`;
    ctx.fillText(f.ch, f.x, 2);
  }
  const px = ctx.getImageData(0, 0, canvas.width, 16).data;
  let x0 = canvas.width, y0 = 16, x1 = -1, y1 = -1;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (px[(y * canvas.width + x) * 4 + 3] > 40) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { canvas, ink: x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

const textWidth = (value: string, font: 'nf' | 'sf' = 'nf') => glyphRun(value, ['000000', '000000'], font).canvas.width;

const images = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  let pending = images.get(url);
  if (!pending) {
    const img = new Image();
    img.src = url;
    pending = img.decode().then(() => img).catch(() => null);
    images.set(url, pending);
  }
  return pending;
}

// a 240x160 game screen: draw calls in game pixels, hit regions as DOM buttons, and a box log for the overlap guard
class Screen {
  readonly root = G.el('div', 'pkp-gba');
  readonly canvas = G.el('canvas', 'pkp-gba-canvas') as HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  boxes: Box[] = [];
  private hits: HTMLElement[] = [];

  constructor() {
    this.canvas.width = 240;
    this.canvas.height = 160;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.root.append(this.canvas);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, 240, 160);
    this.boxes = [];
    for (const hit of this.hits) hit.remove();
    this.hits = [];
  }

  image(img: HTMLImageElement | null, x: number, y: number, sx = 0, sy = 0, w?: number, h?: number): void {
    if (!img) return;
    const ww = w ?? img.naturalWidth;
    const hh = h ?? img.naturalHeight;
    this.ctx.drawImage(img, sx, sy, ww, hh, x, y, ww, hh);
  }

  // draws a run at the window's printer position; align right/center within a span like GetStringRightAlignXOffset
  text(value: string, x: number, y: number, color: Color, opts: { font?: 'nf' | 'sf'; right?: number; center?: number; name?: string; inside?: Rect } = {}): Rect {
    const run = glyphRun(value, color, opts.font);
    let left = x;
    if (opts.right !== undefined) left = opts.right - run.canvas.width;
    else if (opts.center !== undefined) left = x + Math.floor((opts.center - run.canvas.width) / 2);
    this.ctx.drawImage(run.canvas, left, y);
    const ink = { x: left + run.ink.x, y: y + run.ink.y, w: run.ink.w, h: run.ink.h };
    if (ink.w) this.boxes.push({ ...ink, kind: 'text', name: opts.name ?? value, inside: opts.inside });
    return { x: left, y, w: run.canvas.width, h: 16 };
  }

  // a selector ring: inner color on the rect's edge pixels, outer color one pixel outside, so the marked text inside
  // and its neighbours never touch it
  cursor(rect: Rect, outer: string, inner: string, name: string): void {
    const ring = (r: Rect, color: string) => {
      const c = this.ctx;
      c.fillStyle = `#${color}`;
      c.fillRect(r.x, r.y, r.w, 1);
      c.fillRect(r.x, r.y + r.h - 1, r.w, 1);
      c.fillRect(r.x, r.y, 1, r.h);
      c.fillRect(r.x + r.w - 1, r.y, 1, r.h);
    };
    const out = { x: rect.x - 1, y: rect.y - 1, w: rect.w + 2, h: rect.h + 2 };
    ring(out, outer);
    ring(rect, inner);
    for (const edge of [
      { x: out.x, y: out.y, w: out.w, h: 2 },
      { x: out.x, y: rect.y + rect.h - 1, w: out.w, h: 2 },
      { x: out.x, y: out.y, w: 2, h: out.h },
      { x: rect.x + rect.w - 1, y: out.y, w: 2, h: out.h },
    ]) this.boxes.push({ ...edge, kind: 'cursor', name });
  }

  // a keyboard key hint: FONT_SMALL label in a light keycap, then a FONT_NORMAL caption; returns its rect
  keycap(key: string, caption: string, right: number, y: number, name: string): Rect {
    const label = glyphRun(key, ['404040', 'd0d0c8'], 'sf');
    const cap = glyphRun(caption, ['000000', 'd5d5cd'], 'nf');
    const capW = label.ink.w + 6;
    const total = capW + 3 + cap.canvas.width;
    const x = right - total;
    const c = this.ctx;
    c.fillStyle = '#404040';
    c.fillRect(x + 1, y, capW - 2, 1);
    c.fillRect(x + 1, y + 12, capW - 2, 2);
    c.fillRect(x, y + 1, 1, 11);
    c.fillRect(x + capW - 1, y + 1, 1, 11);
    c.fillStyle = '#f8f8f8';
    c.fillRect(x + 1, y + 1, capW - 2, 11);
    c.drawImage(label.canvas, x + 3 - label.ink.x, y + 3 - label.ink.y);
    this.boxes.push({ x, y, w: capW, h: 14, kind: 'control', name });
    c.drawImage(cap.canvas, x + capW + 3, y - 2);
    const ink = { x: x + capW + 3 + cap.ink.x, y: y - 2 + cap.ink.y, w: cap.ink.w, h: cap.ink.h };
    this.boxes.push({ ...ink, kind: 'text', name: caption });
    return { x, y, w: total, h: 14 };
  }

  hit(rect: Rect, label: string, onClick: () => void): HTMLElement {
    const node = G.el('button', 'pkp-gba-hit') as HTMLButtonElement;
    node.type = 'button';
    node.tabIndex = -1;
    node.setAttribute('aria-label', label);
    node.style.left = `calc(var(--pkp-u) * ${rect.x})`;
    node.style.top = `calc(var(--pkp-u) * ${rect.y})`;
    node.style.width = `calc(var(--pkp-u) * ${rect.w})`;
    node.style.height = `calc(var(--pkp-u) * ${rect.h})`;
    node.addEventListener('click', G.guard((event: MouseEvent) => {
      event.stopPropagation();
      onClick();
    }));
    this.root.append(node);
    this.hits.push(node);
    return node;
  }
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

// every text ink box against every other one, the cursors and the controls, and against its own window
function auditBoxes(state: string, boxes: Box[]): string[] {
  const issues: string[] = [];
  boxes.forEach((a, i) => {
    if (a.kind === 'text' && a.inside && !contains(a.inside, a)) issues.push(`${state}: "${a.name}" leaves its window`);
    if (a.kind === 'text' && !contains({ x: 0, y: 0, w: 240, h: 160 }, a)) issues.push(`${state}: "${a.name}" is off screen`);
    boxes.slice(i + 1).forEach((b) => {
      if (a.kind === 'cursor' && b.kind === 'cursor') return;
      if (overlaps(a, b)) issues.push(`${state}: ${a.kind} "${a.name}" touches ${b.kind} "${b.name}"`);
    });
  });
  return issues;
}

// shared with the battle window: master volume and one mute toggle per window
const SOUND_KEY = 'pokemon-emerald-sound:v1';
const SOUND_EVENT = 'pe-sound-change';
type SoundState = { master: { volume: number }; windows: Record<string, { muted: boolean }> };
function readSound(): SoundState {
  const base: SoundState = { master: { volume: 0.35 }, windows: { battle: { muted: true }, summary: { muted: false } } };
  try {
    const raw = JSON.parse(localStorage.getItem(SOUND_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const volume = raw.master?.volume;
      if (typeof volume === 'number' && Number.isFinite(volume)) base.master.volume = Math.min(1, Math.max(0, volume));
      for (const [name, value] of Object.entries((raw.windows ?? {}) as Record<string, any>)) base.windows[name] = { ...value, muted: !!value?.muted };
    }
  } catch {}
  return base;
}
function writeSound(next: SoundState): void {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(next));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(SOUND_EVENT, { detail: next }));
  } catch {}
}
const sound = {
  read: readSound,
  event: SOUND_EVENT,
  // master volume, or 0 while the window is muted
  gain(win = 'summary'): number {
    const s = readSound();
    return s.windows[win]?.muted ? 0 : s.master.volume;
  },
  // only windows.summary.muted is ours to write; the rest of the store is kept as read
  setMuted(win: string, muted: boolean): void {
    const s = readSound();
    s.windows[win] = { ...(s.windows[win] ?? {}), muted };
    writeSound(s);
  },
  lastGain: 0,
};

let ctxAudio: AudioContext | null = null;
// the summary's select blip; only from a click or key press, at the shared gain
function blip(): void {
  const gain = sound.gain('summary');
  sound.lastGain = gain;
  if (gain <= 0) return;
  try {
    ctxAudio ??= new AudioContext();
    if (ctxAudio.state === 'suspended') void ctxAudio.resume().catch(() => {});
    const t = ctxAudio.currentTime + 0.01;
    [[880, 0, 0.04], [1320, 0.045, 0.06]].forEach(([freq, at, dur]) => {
      const osc = ctxAudio!.createOscillator();
      const g = ctxAudio!.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.2 * gain, t + at);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      osc.connect(g).connect(ctxAudio!.destination);
      osc.start(t + at);
      osc.stop(t + at + dur + 0.02);
    });
  } catch {}
}
G.cleanups.push(() => {
  void ctxAudio?.close().catch(() => {});
  ctxAudio = null;
});

// an Emerald sound effect (songs.h name) from the pokemon-audio extension; silent when that extension is off
function sfx(id: 'SE_SELECT' | 'SE_FAILURE' | 'SE_WIN_OPEN' | 'SE_BALL'): void {
  try {
    (window as any).__peAudio?.play(id, { window: 'summary' });
  } catch {}
}

// the species' Emerald cry (national dex number); silent when the pokemon-audio extension is off
function cry(species: number): void {
  try {
    (window as any).__peAudio?.cry(species, { window: 'summary' });
  } catch {}
}

Object.assign(G, { Screen, glyphRun, textWidth, loadImage, auditBoxes, overlaps, sound, blip, sfx, cry });
