// The partner tooltip (hover) and the Emerald POKEMON SUMMARY screen (click), laid out on the GBA's 240x160 grid
// with the positions from pokeemerald's src/pokemon_summary_screen.c window templates.
declare const cinnamon: { settings: { get(key: string): unknown; set(key: string, value: unknown): void } };
const Q = (window as any).__pkp;

const TARGETS = '.pkp-ri, .pkp-ht, .pkp-av';
// the header thumb opens the summary on click but shows no card: it would cover the title and the first row
const HOVER_TARGETS = '.pkp-ri, .pkp-av';
const PAGES = ['POKéMON INFO', 'POKéMON SKILLS', 'BATTLE MOVES'];
const OPEN_CRY_MS = (22 * 1000) / 59.7275;
const FEMALE_TRAINERS = ['may', 'lass', 'hex_maniac'];

function keyOf(target: Element): string | null {
  if (target.matches('.pkp-ri')) return Q.threadKeyFromRow(target.closest('[data-row-key]'));
  return Q.currentThread();
}

// summary palette 6 and 7 text colors: [ink, shadow]
const DARK: Color = ['000000', 'd5d5cd'];
const WHITE: Color = ['ffffff', '626262'];
const RED: [string, string] = ['e60808', 'ffbd73'];
const BLUE: [string, string] = ['41cdff', '008bbd'];
const PINK: [string, string] = ['ff9c94', 'bd5a52'];
const OT_BLUE: [string, string] = ['8bf6ff', '18a4d5'];
const OT_PINK: [string, string] = ['ffbdb4', 'd5736a'];
const SHINY: [string, string] = ['eeeeac', 'a4a462'];

// the theme's pixel: k device pixels, as extension-theme publishes it in --pe-bpx; follows zoom both ways
function themeK(): number {
  const dpr = window.devicePixelRatio || 1;
  const bpx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pe-bpx'));
  return bpx > 0 ? Math.max(1, Math.round(bpx * dpr)) : Q.scale.k;
}

// hover card pixel in device pixels: as large as 2k but no wider than 40% of the transcript column, and never below
// the multiple that puts FONT_SMALL's 7 px capitals at the body text's measured cap height
let capCache: { font: string; cap: number } | null = null;
function bodyCapDevice(): number {
  const prose = document.querySelector('[data-cds="Prose"]') ?? document.body;
  const cs = getComputedStyle(prose);
  const font = `${cs.fontSize} ${cs.fontFamily}`;
  if (capCache?.font !== font) {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = font;
    const m = ctx.measureText('H');
    capCache = { font, cap: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent };
  }
  return capCache.cap * (window.devicePixelRatio || 1);
}
function cardMultiple(): number {
  const k = themeK();
  const dpr = window.devicePixelRatio || 1;
  const column = document.querySelector('[data-testid="transcript-rows"]')?.getBoundingClientRect().width || innerWidth;
  const widest = Math.floor((0.4 * column * dpr) / 106);
  return Math.max(Math.ceil(bodyCapDevice() / 7), Math.min(2 * k, widest));
}

// Emerald FONT_SMALL drawn from its glyph sheet: one canvas per run, whole sprite pixels; null if a character is missing
let glyphs: Uint8Array | null = null;
function smallText(value: string, ink: string, shadow: string, rows = 16): HTMLCanvasElement | null {
  const sf = Q.assets.dex?.sf;
  if (!sf) return null;
  glyphs ??= Uint8Array.from(atob(sf.bits), (c) => c.charCodeAt(0));
  const codes: number[] = [];
  for (const ch of value) {
    const code = ch === '\u0001' ? sf.lv : sf.c[ch];
    if (code === undefined) return null;
    codes.push(code);
  }
  const width = codes.reduce((sum, code) => sum + (sf.w[code] ?? 6), 0);
  const canvas = Q.el('canvas', 'pkp-hb-text') as HTMLCanvasElement;
  canvas.width = Math.max(1, width);
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, rows);
  const colors = [null, ink, shadow].map((hex) => (hex ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null));
  let pen = 0;
  for (const code of codes) {
    const w = sf.w[code] ?? 6;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < w; x++) {
        const at = code * 256 + y * 16 + x;
        const v = (glyphs[at >> 2] >> ((at & 3) * 2)) & 3;
        const rgb = colors[v];
        if (rgb) image.data.set([...rgb, 255], (y * canvas.width + pen + x) * 4);
      }
    }
    pen += w;
  }
  ctx.putImageData(image, 0, 0);
  canvas.style.width = `calc(var(--pkp-u) * ${canvas.width})`;
  canvas.style.height = `calc(var(--pkp-u) * ${rows})`;
  return canvas;
}

// places a run at healthbox coordinates; text the small font can't draw falls back to the theme font
function hbText(parent: HTMLElement, value: string, x: number, y: number, ink: string, shadow: string, opts: { rows?: number; right?: number } = {}): void {
  const run: HTMLElement = smallText(value, ink, shadow, opts.rows) ?? Object.assign(Q.el('span', 'pkp-hb-fallback', value), {});
  run.style.position = 'absolute';
  run.style.top = `calc(var(--pkp-u) * ${y})`;
  if (opts.right !== undefined) {
    const w = (run as HTMLCanvasElement).width;
    run.style.left = `calc(var(--pkp-u) * ${opts.right - (run instanceof HTMLCanvasElement ? w : 0)})`;
  } else run.style.left = `calc(var(--pkp-u) * ${x})`;
  if (!(run instanceof HTMLCanvasElement)) run.style.color = `#${ink}`;
  parent.append(run);
}

// Emerald's player healthbox (battle_interface.c): name at (16, 3), Lv at (72, 3), HP capsule at (24, 16),
// HP numbers at (60, 21) and (80, 21) clipped to the box's fourth tile row, EXP track at (32, 35)
class Tooltip {
  private node: HTMLElement | null = null;
  pinnedUntil = 0;

  // view: the level and bar pixels to draw instead of the live ones, for the level-up moment
  show(target: Element, view?: { level: number; px: number }): void {
    const key = keyOf(target);
    const mon = key ? Q.mon(key) : null;
    const hb = Q.assets.dex?.hb;
    if (!mon || !hb) return this.hide();
    const node = (this.node ??= Q.el('div', 'pkp-tip'));
    const m = cardMultiple();
    node.style.setProperty('--pkp-u', `${m / (window.devicePixelRatio || 1)}px`);
    node.dataset.scale = String(m);
    // measured and placed while hidden, then shown once, so it never paints at a first position
    node.style.visibility = 'hidden';
    node.setAttribute('role', 'tooltip');
    node.setAttribute('aria-label', `${mon.nickname}, level ${mon.level}, HP ${mon.stats[0]} of ${mon.stats[0]}`);
    node.replaceChildren();
    node.style.backgroundImage = `url("${Q.assets.ui('hb-box')}")`;
    let name = mon.nickname;
    hbText(node, name, 16, 3, hb.ink, hb.shadow);
    const nameWidth = smallText(name, hb.ink, hb.shadow)?.width ?? name.length * 6;
    if (mon.gender && !((mon.species === 29 || mon.species === 32) && mon.nickname === mon.name)) {
      hbText(node, mon.gender === 'M' ? '♂' : '♀', 16 + nameWidth, 3, mon.gender === 'M' ? hb.male : hb.female, hb.shadow);
    }
    const lv = String(view?.level ?? mon.level);
    hbText(node, `\u0001${lv}`, 72 + 5 * (3 - lv.length), 3, hb.ink, hb.shadow);
    const hp = Q.el('div', 'pkp-hb-hp');
    hp.style.backgroundImage = `url("${Q.assets.ui('hb-hp')}")`;
    node.append(hp);
    const pad = (n: number) => String(n).padStart(3, ' ');
    hbText(node, `${pad(mon.stats[0])}/`, 60, 21, hb.ink, hb.shadow, { rows: 11 });
    hbText(node, pad(mon.stats[0]), 80, 21, hb.ink, hb.shadow, { rows: 11 });
    const exp = Q.el('div', 'pkp-hb-exp');
    exp.style.setProperty('--fill', String((view?.px ?? Q.expPixels(mon)) / 64));
    exp.style.setProperty('--exp', `#${hb.exp}`);
    node.append(exp);
    if (!node.isConnected) document.body.append(node);
    this.place(node, target);
    node.style.visibility = '';
  }

  // the healthbox tail sits on the sprite's vertical centre, so the card rises above it; right of the sprite with a
  // 6 px gap, flipped left only when it would not fit, below only at the very top
  private place(node: HTMLElement, target: Element): void {
    const r = target.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    const gap = 6;
    const scroller = target.closest('[data-testid="epitaxy-virtual-transcript"], [data-testid="sidebar"]')?.getBoundingClientRect();
    const ceiling = Math.max(4, scroller ? scroller.top : 4);
    const x = r.right + gap + w <= window.innerWidth - 4 ? r.right + gap : r.left - gap - w;
    // the sprite's own box, never its row: a three-line card's middle sits below the sprite
    const mid = r.top + r.height / 2;
    const y = mid - h >= ceiling ? mid - h : mid;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    node.style.left = `${snap(Math.max(4, x))}px`;
    node.style.top = `${snap(Math.min(window.innerHeight - h - 4, y))}px`;
    node.dataset.anchor = y === mid ? 'below' : 'above';
  }

  hide(force = false): void {
    if (!force && Date.now() < this.pinnedUntil) return;
    this.node?.remove();
    this.node = null;
  }
}

// pokeemerald window templates (tiles) as game-pixel rects, for placement and for the overlap guard
const W = (left: number, top: number, w: number, h: number) => ({ x: left * 8, y: top * 8, w: w * 8, h: h * 8 });
const WIN = {
  title: W(0, 0, 11, 2),
  prompt: W(22, 0, 8, 2),
  dex: W(1, 2, 4, 2),
  nickname: W(1, 12, 9, 2),
  species: W(1, 14, 9, 4),
  ot: W(11, 4, 11, 2),
  id: W(22, 4, 7, 2),
  type: W(11, 6, 18, 2),
  ability: W(11, 9, 18, 4),
  memo: W(11, 14, 18, 6),
  item: W(10, 4, 10, 2),
  ribbon: W(20, 4, 10, 2),
  statLabelsL: W(10, 7, 6, 6),
  statLabelsR: W(22, 7, 5, 6),
  statsL: W(16, 7, 6, 6),
  statsR: W(27, 7, 3, 6),
  expLabels: W(10, 14, 11, 4),
  exp: W(24, 14, 6, 4),
  moveNames: W(15, 4, 9, 10),
  movePP: W(24, 4, 6, 10),
  powerAcc: W(1, 15, 9, 4),
  description: W(10, 15, 20, 4),
};
// PP text at full PP: palette 8 colors 7 and 8 (text_pp.pal loaded from entry 1)
const PP_COLOR: Color = ['4a4a4a', 'dedede'];
const SELECT_OUTER = 'ff5231';
const SELECT_INNER = 'ffff00';
type Color = [string, string];

class Summary {
  expShown: { exp: number; next: number; px: number } | null = null;
  node: HTMLElement | null = null;
  screen: any = null;
  key: string | null = null;
  page = 0;
  selecting = -1;
  frame = 0;
  animating = false;
  nOverride: number | null = null;
  private restoreFocus: HTMLElement | null = null;
  private titleBar: HTMLElement | null = null;
  private soundBox: HTMLElement | null = null;
  private pos: { x: number; y: number; w: number; h: number } | null = null;
  private renderToken = 0;
  private animTimers: number[] = [];

  // a floating window: no backdrop, so the transcript and composer stay usable while it is open
  open(key: string, page = 0): void {
    if (this.key !== key) this.stopAnim();
    this.key = key;
    this.page = page;
    this.selecting = -1;
    if (!this.node) {
      this.restoreFocus = document.activeElement as HTMLElement | null;
      const node = (this.node = Q.el('div', 'pkp-popup'));
      node.setAttribute('role', 'group');
      node.setAttribute('aria-label', 'Pokemon summary');
      node.tabIndex = -1;
      const title = (this.titleBar = Q.el('div', 'pkp-popup-title'));
      const close = Q.el('button', 'pkp-popup-close') as HTMLButtonElement;
      close.type = 'button';
      close.setAttribute('aria-label', 'Close summary');
      close.addEventListener('click', Q.guard(() => {
        Q.sfx('SE_SELECT');
        this.close();
      }));
      this.soundBox = Q.el('div', 'pkp-sound');
      const label = Q.el('span', 'pkp-popup-label', 'POKéMON SUMMARY');
      const right = Q.el('div', 'pkp-popup-tools');
      right.append(this.soundBox!, close);
      title.append(label, right);
      title.addEventListener('pointerdown', Q.guard((event: PointerEvent) => this.drag(event, 'move')));
      title.addEventListener('dblclick', Q.guard((event: MouseEvent) => {
        if (!(event.target as Element).closest('button')) this.toggleFit();
      }));
      const grip = Q.el('div', 'pkp-grip');
      grip.setAttribute('aria-hidden', 'true');
      grip.addEventListener('pointerdown', Q.guard((event: PointerEvent) => this.drag(event, 'size')));
      this.screen = new Q.Screen();
      node.append(title, this.screen.root, grip);
      node.addEventListener('pointerdown', Q.guard((event: PointerEvent) => {
        if (!(event.target as Element).closest('button')) node.focus({ preventScroll: true });
      }));
      document.body.append(node);
      this.renderSound();
      this.layout();
      node.focus({ preventScroll: true });
    }
    void this.render();
  }

  // the speaker: the one mute toggle for this window (windows.summary.muted in the shared sound state)
  renderSound(): void {
    const box = this.soundBox;
    if (!box) return;
    const state = Q.sound.read();
    const win = state.windows.summary ?? { muted: false };
    box.replaceChildren();
    const mute = Q.el('button', 'pkp-sound-mute') as HTMLButtonElement;
    mute.type = 'button';
    mute.setAttribute('aria-label', win.muted ? 'Unmute summary sounds' : 'Mute summary sounds');
    mute.setAttribute('aria-pressed', String(!!win.muted));
    mute.toggleAttribute('data-muted', !!win.muted);
    mute.addEventListener('click', Q.guard(() => {
      Q.sound.setMuted('summary', !Q.sound.read().windows.summary?.muted);
      Q.sfx('SE_SELECT');
    }));
    box.append(mute);
  }

  // the frame is sized freely (grip, double-click); the screen draws inside it at the largest whole number
  // of device pixels per game pixel that fits, centred on the matte, so it stays crisp and 3:2
  private metrics() {
    const dpr = window.devicePixelRatio || 1;
    const k = themeK();
    const tu = k / dpr;
    const bw = Math.max(1, Math.round(tu * dpr / k)) / dpr;
    const titleH = 20 * tu;
    const top = Summary.appTop();
    const minW = 2 * bw + (240 * k) / dpr;
    const minH = titleH + 3 * bw + (160 * k) / dpr;
    return { dpr, k, tu, bw, titleH, top, minW, minH, maxW: Math.max(minW, innerWidth - 16), maxH: Math.max(minH, innerHeight - top - 8) };
  }

  // frame size that holds the screen at s device pixels per game pixel
  private sizeFor(s: number) {
    const m = this.metrics();
    return { w: 2 * m.bw + (240 * s) / m.dpr, h: m.titleH + 3 * m.bw + (160 * s) / m.dpr };
  }

  private largestFit(): number {
    const m = this.metrics();
    return Math.max(m.k, Math.floor(Math.min(((m.maxW - 2 * m.bw) * m.dpr) / 240, ((m.maxH - m.titleH - 3 * m.bw) * m.dpr) / 160)));
  }

  layout(): void {
    const node = this.node;
    if (!node) return;
    const m = this.metrics();
    const snap = (v: number) => Math.round(v * m.dpr) / m.dpr;
    if (!this.pos) {
      const saved = cinnamon.settings.get('summaryWindow') as Record<string, unknown> | null;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      // first open: a moderate size, twice the theme pixel (the battle window opens near this too)
      const first = this.sizeFor(Math.min(2 * m.k, this.largestFit()));
      const w = num(saved?.w) ?? first.w;
      const h = num(saved?.h) ?? first.h;
      this.pos = { x: num(saved?.x) ?? (innerWidth - w) / 2, y: num(saved?.y) ?? Math.max(m.top, (innerHeight - h) / 2), w, h };
    }
    if (this.nOverride) Object.assign(this.pos, this.sizeFor(this.nOverride * m.k));
    const p = this.pos;
    p.w = Math.min(Math.max(p.w, m.minW), m.maxW);
    p.h = Math.min(Math.max(p.h, m.minH), m.maxH);
    p.x = Math.min(Math.max(0, p.x), Math.max(0, innerWidth - p.w));
    p.y = Math.min(Math.max(m.top, p.y), Math.max(m.top, innerHeight - p.h - 4));
    const bodyW = p.w - 2 * m.bw;
    const bodyH = p.h - m.titleH - 3 * m.bw;
    // the epsilon keeps a frame sized by sizeFor() from flooring one step short on float error
    const s = Math.max(1, Math.floor(Math.min((bodyW * m.dpr) / 240, (bodyH * m.dpr) / 160) + 1e-6));
    const u = s / m.dpr;
    Object.assign(node.style, { left: `${snap(p.x)}px`, top: `${snap(p.y)}px`, width: `${snap(p.w)}px`, height: `${snap(p.h)}px` });
    node.style.setProperty('--pkp-tu', `${m.tu}px`);
    node.style.setProperty('--pkp-bw', `${m.bw}px`);
    node.style.setProperty('--pkp-u', `${u}px`);
    node.style.setProperty('--pkp-sx', `${snap((bodyW - 240 * u) / 2)}px`);
    node.style.setProperty('--pkp-sy', `${snap(m.titleH + m.bw + (bodyH - 160 * u) / 2)}px`);
    node.dataset.scale = `${s}`;
  }

  private save(): void {
    const p = this.pos;
    if (p) cinnamon.settings.set('summaryWindow', { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) });
  }

  // double-clicking the bar toggles between the last size and the largest fit
  private lastSize: { w: number; h: number } | null = null;
  toggleFit(): void {
    if (!this.pos) return;
    const fit = this.sizeFor(this.largestFit());
    if (this.lastSize && Math.abs(this.pos.w - fit.w) < 2 && Math.abs(this.pos.h - fit.h) < 2) {
      Object.assign(this.pos, this.lastSize);
      this.lastSize = null;
    } else {
      this.lastSize = { w: this.pos.w, h: this.pos.h };
      Object.assign(this.pos, fit, { x: (innerWidth - fit.w) / 2, y: this.metrics().top });
    }
    this.layout();
    this.save();
  }

  // bottom of the app's own top bar (traffic lights and header): the popup never goes above it
  static appTop(): number {
    let top = 0;
    for (const bar of document.querySelectorAll('.df-titlebar, [data-cds="Toolbar"], [data-perf-region="header"], [data-testid="sidebar"] > :first-child')) {
      const r = bar.getBoundingClientRect();
      if (r.height > 0 && r.top < 12 && r.bottom < 120) top = Math.max(top, r.bottom);
    }
    return top || 44;
  }

  // title bar drag moves the window, the corner grip resizes it; pointer capture keeps the drag past the handle
  private drag(event: PointerEvent, kind: 'move' | 'size' = 'move'): void {
    if (event.button !== 0 || (event.target as Element).closest('button') || !this.node || !this.pos) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {}
    const start = { ...this.pos };
    const move = Q.guard((e: PointerEvent) => {
      if (!this.pos) return;
      const dx = e.clientX - event.clientX;
      const dy = e.clientY - event.clientY;
      if (kind === 'move') Object.assign(this.pos, { x: start.x + dx, y: start.y + dy });
      else Object.assign(this.pos, { w: start.w + dx, h: start.h + dy });
      this.layout();
    });
    const up = Q.guard(() => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      this.save();
      this.node?.focus({ preventScroll: true });
    });
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  hasFocus(): boolean {
    return !!this.node && this.node.contains(document.activeElement);
  }

  close(): void {
    this.stopAnim();
    this.node?.remove();
    this.node = this.screen = this.titleBar = this.soundBox = null;
    this.pos = null;
    this.key = null;
    Q.naming?.close(false);
    try {
      this.restoreFocus?.focus({ preventScroll: true });
    } catch {}
  }

  turn(delta: number): void {
    const next = Math.max(0, Math.min(2, this.page + delta));
    // pokemon_summary_screen.c ChangePage: silent at the first and last page
    if (next === this.page) return;
    Q.sfx('SE_SELECT');
    this.page = next;
    this.selecting = -1;
    void this.render();
  }

  // Return (or Z) is the game's A, Delete (or X) is B, arrows move, Esc backs out then closes; Space or Return on
  // the focused picture plays its animation
  key_(event: KeyboardEvent): boolean {
    const k = event.key;
    if ((k === 'Enter' || k === ' ') && (document.activeElement as Element | null)?.closest?.('.pkp-gba-sprite')) {
      this.animate();
      return true;
    }
    const a = k === 'Enter' || k === 'z' || k === 'Z';
    const b = k === 'Backspace' || k === 'x' || k === 'X';
    if (this.selecting >= 0) {
      const count = Q.mon(this.key!)?.moves.length || 1;
      // Task_HandleInput_MoveSelect: A with a single move is refused with SE_FAILURE and stays put
      if (a && count <= 1) {
        Q.sfx('SE_FAILURE');
        return true;
      }
      if (k === 'ArrowUp') this.selecting = (this.selecting + count - 1) % count;
      else if (k === 'ArrowDown') this.selecting = (this.selecting + 1) % count;
      else if (k === 'Escape' || b || a) this.selecting = -1;
      else return false;
      Q.sfx('SE_SELECT');
      void this.render();
      return true;
    }
    if (k === 'Escape' || b) {
      Q.sfx('SE_SELECT');
      this.close();
    } else if (k === 'ArrowLeft') this.turn(-1);
    else if (k === 'ArrowRight') this.turn(1);
    else if (a && this.page === 0) {
      Q.sfx('SE_SELECT');
      Q.naming.open(this.key);
    } else if (a && this.page === 2) {
      Q.sfx('SE_SELECT');
      this.selecting = 0;
      void this.render();
    } else return false;
    return true;
  }

  // the summary's front animation: anim_front's two frames on the species' sAnim timings (1/60 s each), with the
  // cry (pokemon_summary_screen.c SpriteCB_Pokemon: PlayMonCry, then the animation). Reduced motion swaps to the
  // second frame once for the same span instead of flipping
  // the shiny sparkle centred on the 64x64 picture at (8, 32), at the screen's own pixel scale
  sparkle(): Promise<void> {
    const canvas = this.screen?.canvas;
    if (!canvas) return Promise.resolve();
    const r = canvas.getBoundingClientRect();
    const unit = r.width / 240;
    return Q.sparkle({ x: r.left + 40 * unit, y: r.top + 64 * unit }, unit);
  }

  animate(slow = 1): void {
    const mon = this.key ? Q.mon(this.key) : null;
    if (!mon || this.animating) return;
    let seq: number[] = Q.assets.data?.fa?.[mon.species] ?? [0, 30, 1, 30, 0, 1];
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      seq = [1, seq.reduce((sum, value, i) => (i % 2 ? sum + value : sum), 0)];
    }
    this.animating = true;
    Q.cry(mon.species);
    let t = 0;
    for (let i = 0; i < seq.length; i += 2) {
      const frame = seq[i];
      this.animTimers.push(Q.later(() => {
        this.frame = frame;
        void this.render();
      }, t));
      t += (seq[i + 1] * 1000 * slow) / 60;
    }
    this.animTimers.push(Q.later(() => {
      this.frame = 0;
      this.animating = false;
      void this.render();
    }, t));
  }

  private stopAnim(): void {
    for (const id of this.animTimers) Q.cancel(id);
    this.animTimers = [];
    this.animating = false;
    this.frame = 0;
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    const screen = this.screen;
    const mon = this.key ? Q.mon(this.key) : null;
    if (!screen || !mon) return;
    const dex = Q.assets.dex;
    const ui = (name: string) => Q.assets.ui(name);
    const bgName = ['sum-info', 'sum-skills', this.selecting >= 0 ? 'sum-moves-select' : 'sum-moves'][this.page];
    const moves = this.page === 2 ? mon.moves.map((m: number) => dex.mv[m]) : [];
    const typeNames = this.page === 0 ? mon.types : this.page === 2 ? moves.map((m: any) => m[1]) : [];
    const [bg, pic, ...types] = await Promise.all([
      Q.loadImage(ui(mon.shiny ? `${bgName}-shiny` : bgName)),
      Q.loadImage(Q.assets.front(mon.species, mon.shiny, this.frame)),
      ...typeNames.map((t: number) => Q.loadImage(ui(`type${t}`))),
    ]);
    if (token !== this.renderToken || screen !== this.screen) return;
    screen.clear();
    screen.image(bg, 0, 0);
    screen.text(PAGES[this.page], 2, 1, WHITE, { inside: WIN.title });
    const prompt = this.page === 0 ? ['RETURN', 'NAME'] : this.page === 1 ? ['ESC', 'CLOSE'] : this.selecting >= 0 ? ['ESC', 'BACK'] : ['RETURN', 'INFO'];
    const cap = screen.keycap(prompt[0], prompt[1], 238, 1, `${prompt[0]} key`);
    screen.hit(cap, `${prompt[0] === 'ESC' ? 'Escape' : 'Return'}: ${prompt[1].toLowerCase()}`, () => this.key_(new KeyboardEvent('keydown', { key: prompt[0] === 'ESC' ? 'Escape' : 'Enter' })));
    for (let i = 0; i < 3; i++) {
      screen.hit({ x: 88 + i * 16, y: 0, w: 16, h: 16 }, PAGES[i], () => {
        if (i !== this.page) Q.sfx('SE_SELECT');
        this.page = i;
        this.selecting = -1;
        void this.render();
      });
    }

    // left column: dex number, picture, nickname, species, level, gender (the EFFECT box covers the lower part)
    screen.text(`\u0004${String(mon.species).padStart(3, '0')}`, 8, 17, mon.shiny ? SHINY : WHITE, { inside: WIN.dex, name: 'dex number' });
    screen.image(pic, 8, 32);
    const sprite = screen.hit({ x: 8, y: 32, w: 64, h: 64 }, `Play ${mon.nickname}'s animation`, () => this.animate());
    sprite.classList.add('pkp-gba-sprite');
    sprite.tabIndex = 0;
    if (this.selecting < 0) {
      screen.text(mon.nickname, 8, 97, WHITE, { inside: WIN.nickname, name: 'nickname' });
      screen.text(`/${mon.name}`, 8, 113, WHITE, { inside: WIN.species, name: 'species' });
      screen.text(`\u0005${mon.level}`, 32, 129, WHITE, { inside: WIN.species, name: 'level' });
      if (mon.gender && !((mon.species === 29 || mon.species === 32) && mon.nickname === mon.name)) {
        screen.text(mon.gender === 'M' ? '♂' : '♀', 65, 129, mon.gender === 'M' ? BLUE : PINK, { inside: WIN.species, name: 'gender' });
      }
    }

    if (this.page === 0) {
      const female = FEMALE_TRAINERS.includes(Q.trainerSetting().base);
      const ot = screen.text('OT/', 88, 33, WHITE, { inside: WIN.ot });
      screen.text(Q.trainerName(), 88 + ot.w, 33, female ? OT_PINK : OT_BLUE, { inside: WIN.ot, name: 'OT name' });
      screen.text(`\u0003\u0004.${String(mon.otId & 0xffff).padStart(5, '0')}`, 0, 33, WHITE, { right: 232, inside: WIN.id, name: 'ID' });
      screen.text('TYPE/', 88, 49, DARK, { inside: WIN.type });
      types.forEach((img: HTMLImageElement | null, i: number) => screen.image(img, 120 + i * 40, 48));
      const ability = dex.ab[mon.ability] ?? ['-------', ''];
      screen.text(ability[0], 88, 73, WHITE, { inside: WIN.ability, name: 'ability' });
      screen.text(ability[1], 88, 89, DARK, { inside: WIN.ability, name: 'ability text' });
      // memo, as gText_XNatureMetAtYZ: the nature, level and place in red
      const nature = screen.text(dex.na[mon.nature][0], 88, 113, RED, { inside: WIN.memo, name: 'nature' });
      screen.text(' nature,', 88 + nature.w, 113, DARK, { inside: WIN.memo });
      const met = screen.text('met at ', 88, 129, DARK, { inside: WIN.memo });
      const lv = screen.text('\u00015', 88 + met.w, 129, RED, { inside: WIN.memo, name: 'met level' });
      screen.text(',', 88 + met.w + lv.w, 129, DARK, { inside: WIN.memo });
      const place = this.fit(this.threadTitle(), 144 - Q.textWidth('.'));
      const where = screen.text(place, 88, 145, RED, { inside: WIN.memo, name: 'met place' });
      screen.text('.', 88 + where.w, 145, DARK, { inside: WIN.memo });
      screen.hit({ x: 8, y: 96, w: 72, h: 16 }, 'Nickname', () => {
        Q.sfx('SE_SELECT');
        Q.naming.open(this.key);
      });
    } else if (this.page === 1) {
      screen.text('NONE', 86, 33, DARK, { center: 72, inside: WIN.item, name: 'item' });
      screen.text('NONE', 166, 33, DARK, { center: 70, inside: WIN.ribbon, name: 'ribbon' });
      const labels = ['HP', 'ATTACK', 'DEFENSE', 'SP. ATK', 'SP. DEF', 'SPEED'];
      labels.forEach((label, i) => {
        const mod = i === 0 ? 1 : Q.natureMod(mon.nature, i);
        const color = mod > 1 ? RED : mod < 1 ? BLUE : WHITE;
        const left = i < 3;
        screen.text(label, left ? 86 : 178, 57 + (i % 3) * 16, color, { center: left ? 42 : 36, inside: left ? WIN.statLabelsL : WIN.statLabelsR });
      });
      screen.text(`${mon.stats[0]}/${mon.stats[0]}`, 0, 57, DARK, { right: 174, inside: WIN.statsL, name: 'HP value' });
      screen.text(String(mon.stats[1]), 0, 73, DARK, { right: 174, inside: WIN.statsL, name: 'attack value' });
      screen.text(String(mon.stats[2]), 0, 89, DARK, { right: 174, inside: WIN.statsL, name: 'defense value' });
      [3, 4, 5].forEach((stat, i) => screen.text(String(mon.stats[stat]), 0, 57 + i * 16, DARK, { right: 238, inside: WIN.statsR, name: `stat ${stat}` }));
      screen.text('EXP. POINTS', 86, 113, WHITE, { inside: WIN.expLabels });
      screen.text('NEXT LV.', 86, 129, WHITE, { inside: WIN.expLabels });
      screen.text(String(mon.exp), 0, 113, DARK, { right: 236, inside: WIN.exp, name: 'exp' });
      screen.text(String(Math.max(0, mon.expNext - mon.exp)), 0, 129, DARK, { right: 236, inside: WIN.exp, name: 'next' });
      const fill = Q.expPixels(mon);
      this.expShown = { exp: mon.exp, next: Math.max(0, mon.expNext - mon.exp), px: fill };
      if (fill > 0) {
        screen.ctx.fillStyle = '#41cdff';
        screen.ctx.fillRect(168, 146, fill, 2);
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const data = moves[i];
        const y = 32 + i * 16;
        screen.text(data ? data[0] : '-', 120, y + 1, WHITE, { inside: WIN.moveNames, name: `move ${i + 1}` });
        screen.text(data ? `\u0002${String(data[2]).padStart(2, ' ')}/${String(data[2]).padStart(2, ' ')}` : '--', 0, y + 1, PP_COLOR, { right: 236, inside: WIN.movePP, name: `pp ${i + 1}` });
        if (data) screen.image(types[i], 85, y);
        if (data) {
          screen.hit({ x: 84, y, w: 154, h: 16 }, `${data[0]}, show info`, () => {
            if (i !== this.selecting) Q.sfx('SE_SELECT');
            this.selecting = i;
            void this.render();
          });
        }
      }
      if (this.selecting >= 0) {
        const data = moves[this.selecting];
        screen.cursor({ x: 83, y: 32 + this.selecting * 16, w: 155, h: 16 }, SELECT_OUTER, SELECT_INNER, 'move selector');
        screen.text('POWER', 8, 121, WHITE, { inside: WIN.powerAcc });
        screen.text('ACCURACY', 8, 137, WHITE, { inside: WIN.powerAcc });
        screen.text(data[3] > 1 ? String(data[3]) : '---', 0, 121, DARK, { right: 79, inside: WIN.powerAcc, name: 'power' });
        screen.text(data[4] ? String(data[4]) : '---', 0, 137, DARK, { right: 79, inside: WIN.powerAcc, name: 'accuracy' });
        String(data[5]).split('\n').forEach((line, i) => screen.text(line, 86, 121 + i * 16, DARK, { inside: WIN.description, name: `description ${i + 1}` }));
      }
    }
  }

  // trims a run with an ellipsis to fit a width in game pixels
  private fit(value: string, width: number): string {
    if (Q.textWidth(value) <= width) return value;
    let out = value;
    while (out.length > 1 && Q.textWidth(`${out}…`) > width) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  }

  private threadTitle(): string {
    const key = this.key;
    if (key && key === Q.currentThread()) {
      const title = document.querySelector('[data-pane-title]')?.textContent?.trim();
      if (title) return title.toUpperCase();
    }
    const row = key ? document.querySelector(`[data-row-key="${CSS.escape(key)}"] [data-row-label]`) : null;
    return (row?.textContent?.trim() || 'a chat').toUpperCase();
  }
}

const tooltip = new Tooltip();

// the battle's EXP gain on the newest partner sprite (or the sidebar one): the old level's bar fills with a tick, the level number
// changes with one MUS_LEVEL_UP, the new bar fills to its value, then done() (the evolution, if any)
function levelUp(key: string, from: number, done: () => void, sounds = true): void {
  const mon = Q.mon(key);
  const onScreen = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  };
  // the newest transcript partner, else the thread's sidebar sprite when the reply has scrolled it away
  const target =
    [...document.querySelectorAll('.pkp-av')].reverse().find(onScreen) ??
    [...document.querySelectorAll(`[data-row-key="${CSS.escape(key)}"] .pkp-ri`)].find(onScreen);
  if (!mon || !target) return done();
  const oldLevel: number = Q.levelForExp(from);
  const startPx = Math.floor((64 * (from - oldLevel ** 3)) / ((oldLevel + 1) ** 3 - oldLevel ** 3));
  const endPx: number = Q.expPixels(mon);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hold = (ms: number) => {
    tooltip.pinnedUntil = Date.now() + ms + 100;
  };
  const fanfare = () => sounds && Q.fanfare('MUS_LEVEL_UP');
  const se = (id: string) => sounds && Q.sfx(id);
  const seStop = (id: string) => sounds && Q.sfxStop(id);
  const finish = () => {
    hold(1200);
    Q.later(() => {
      tooltip.hide(true);
      done();
    }, 1200);
  };
  // SE_EXP is one held note: it starts with the fill and is cut the moment the bar stops, as the game does
  const fill = (level: number, px: number, to: number, next: () => void, first = true) => {
    tooltip.show(target, { level, px });
    hold(400);
    if (px >= to) {
      if (!first) seStop('SE_EXP');
      return next();
    }
    if (first) se('SE_EXP');
    Q.later(() => fill(level, Math.min(to, px + 1), to, next, false), 17);
  };
  if (reduced) {
    tooltip.show(target, { level: mon.level, px: endPx });
    fanfare();
    return finish();
  }
  fill(oldLevel, startPx, 64, () => {
    se('SE_EXP_MAX');
    tooltip.show(target, { level: mon.level, px: 64 });
    fanfare();
    hold(1800);
    Q.later(() => fill(mon.level, 0, endPx, finish), 1800);
  });
}
const summary = new Summary();
let hovered: Element | null = null;

Q.listen(document, 'pointerover', (event: PointerEvent) => {
  const target = (event.target as Element | null)?.closest?.(HOVER_TARGETS) ?? null;
  if (target === hovered) return;
  hovered = target;
  if (target) tooltip.show(target);
  else tooltip.hide();
}, true);
// a scroll elsewhere (the transcript streaming) keeps the card on its icon; it hides only when the icon is gone
Q.listen(document, 'scroll', () => {
  if (hovered?.isConnected && tooltip.node) tooltip.show(hovered);
  else tooltip.hide();
}, true);
Q.listen(document, 'pointerdown', (event: PointerEvent) => {
  if ((event.target as Element | null)?.closest?.(TARGETS)) {
    event.stopPropagation();
    event.preventDefault();
  }
}, true);
Q.listen(document, 'click', (event: MouseEvent) => {
  const target = (event.target as Element | null)?.closest?.(TARGETS);
  if (!target) return;
  event.stopPropagation();
  event.preventDefault();
  const key = keyOf(target);
  if (!key) return;
  tooltip.hide();
  // party_menu.c CursorCb_Summary plays SE_SELECT; the cry and animation wait for the summary's fade-in
  // (BeginNormalPaletteFade 16 to 0, then SpriteCB_Pokemon), about 22 frames
  Q.sfx('SE_SELECT');
  summary.open(key);
  Q.later(() => {
    if (summary.key !== key || !summary.node) return;
    // a shiny opens with the battle's sparkle over its picture, then the cry and animation, as a send-out does
    if (!Q.mon(key)?.shiny) return summary.animate();
    Q.store.markShinySeen(key);
    void summary.sparkle().then(() => {
      if (summary.key === key && summary.node) summary.animate();
    });
  }, OPEN_CRY_MS);
}, true);
// keys act only while the popup (or the naming screen) has focus, so typing in the composer never turns pages
Q.listen(window, 'keydown', (event: KeyboardEvent) => {
  if (Q.naming?.isOpen()) {
    if (!(document.activeElement as Element | null)?.closest?.('.pkp-naming')) return;
    if (Q.naming.key_(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
  if (!summary.hasFocus()) return;
  if (summary.key_(event)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
Q.listen(window, 'resize', () => summary.layout());
Q.cleanups.push(() => {
  tooltip.hide(true);
  summary.close();
});

Q.listen(window, 'pe-sound-change', () => summary.renderSound());
Object.assign(Q, { summary, tooltip, levelUp, Summary, DARK, WHITE, themeK, cardMultiple });
