declare const cinnamon: {
  settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    onChange(fn: (all: Record<string, unknown>) => void): void;
  };
  onDispose(fn: () => void): void;
};

type Rgb = [number, number, number];
type ColorPair = [Rgb, Rgb];
type MonData = { n: number; t: number[]; fy: number; by: number; el: number; ic: string };
type SlotColors = { text: Rgb; shadow: Rgb; hpEmptyTop: Rgb; hpEmpty: Rgb };
type GameData = {
  types: string[];
  species: Record<string, MonData>;
  moves: Record<string, number>;
  sprites: Record<string, [number, number]>;
  fonts: Record<string, { w: number[]; h: number }>;
  chars: Record<string, number>;
  colors: Record<string, ColorPair>;
  hp: Record<string, ColorPair>;
  slot: Record<string, SlotColors>;
};
type FontName = 'normal' | 'small' | 'narrow';
type TextOpts = { font?: FontName; color?: string | ColorPair; width?: number; lineHeight?: number; align?: 'left' | 'right' | 'center' };

const ns = (window as any).__pkb;
const { el, report, toId, upper, cssString, decodeBase64, place, CURSOR_COL, cleanups } = ns;
// marks a waiting label: drawn as 0 to 3 looping dots, laid out as '...' so nothing shifts
const WAIT = '\u0007';
let glyphRun = 0;
const DOT_MS = 450;
const waiting = new Map<HTMLCanvasElement, () => void>();
let dotStep = 3;
let dotTimer = 0;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function tickDots(): void {
  if (document.hidden) return;
  dotStep = (dotStep + 1) % 4;
  for (const [canvas, render] of waiting) {
    if (!canvas.isConnected) waiting.delete(canvas);
    else if (canvas.getClientRects().length) render();
  }
  if (!waiting.size) {
    clearInterval(dotTimer);
    dotTimer = 0;
  }
}
cleanups.push(() => clearInterval(dotTimer));
function forceDots(step: number): void {
  dotStep = step;
  for (const render of waiting.values()) render();
}

const EXTRA_COLORS: Record<string, ColorPair> = {
  white: [[255, 255, 255], [74, 74, 74]],
  gray: [[160, 160, 160], [220, 220, 216]],
  male: [[106, 148, 255], [222, 213, 180]],
  female: [[255, 156, 148], [222, 213, 180]],
  green: [[64, 168, 96], [200, 232, 200]],
};

class Assets {
  data: GameData | null = null;
  ready = false;
  private bytes: Record<string, Uint8Array> = {};
  private readonly urls = new Map<string, string>();
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly fontMasks = new Map<string, ImageData>();
  private readonly tinted = new Map<string, HTMLCanvasElement>();
  private readonly waiters: Array<() => void> = [];
  private parent: HTMLElement | null = null;

  load(parent: HTMLElement | null = this.parent): boolean {
    if (this.data) return true;
    this.parent = parent;
    if (!parent) return false;
    const host = el('div', 'pkb-data');
    host.hidden = true;
    parent.append(host);
    try {
      const styles = getComputedStyle(host);
      const read = (name: string) => cssString(styles, name);
      const data = read('--pkb-data');
      const ui = read('--pkb-ui');
      if (!data || !ui) return false;
      for (const kind of ['f', 'b', 'i', 'a']) {
        const blob = read(`--pkb-sprites-${kind}`);
        if (blob) this.bytes[kind] = decodeBase64(blob);
      }
      this.data = JSON.parse(new TextDecoder().decode(decodeBase64(data))) as GameData;
      const images = JSON.parse(new TextDecoder().decode(decodeBase64(ui))) as Record<string, string>;
      let pending = Object.keys(images).length;
      for (const [name, value] of Object.entries(images)) {
        const url = URL.createObjectURL(new Blob([decodeBase64(value)], { type: 'image/png' }));
        this.urls.set(`ui:${name}`, url);
        const img = new Image();
        img.onload = img.onerror = () => {
          if (--pending === 0) this.finish();
        };
        img.src = url;
        this.images.set(name, img);
      }
      return true;
    } catch (err) {
      report(err);
      return false;
    } finally {
      host.remove();
    }
  }

  private finish(): void {
    try {
      for (const font of ['normal', 'small', 'narrow']) {
        const img = this.images.get(`font_${font}`);
        if (!img?.naturalWidth) continue;
        const canvas = el('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        this.fontMasks.set(font, ctx.getImageData(0, 0, canvas.width, canvas.height));
      }
    } catch (err) {
      report(err);
    }
    this.ready = true;
    for (const fn of this.waiters.splice(0)) {
      try {
        fn();
      } catch (err) {
        report(err);
      }
    }
  }

  onReady(fn: () => void): void {
    if (this.ready) fn();
    else this.waiters.push(fn);
  }

  url(name: string): string {
    return this.urls.get(`ui:${name}`) ?? '';
  }

  image(name: string): HTMLImageElement | null {
    const img = this.images.get(name);
    return img?.complete && img.naturalWidth ? img : null;
  }

  mon(species: string): MonData | null {
    const all = this.data?.species;
    if (!all) return null;
    return all[toId(species)] ?? all[toId(species.split('-')[0])] ?? null;
  }

  monId(species: string): string | null {
    const all = this.data?.species;
    if (!all) return null;
    const id = toId(species);
    if (all[id]) return id;
    const base = toId(species.split('-')[0]);
    return all[base] ? base : null;
  }

  sprite(species: string, kind: 'f' | 'b' | 'i' | 'a'): string | null {
    if (!this.data) this.load();
    const id = this.monId(species);
    if (!id || !this.data) return null;
    const key = `${kind}${kind === 'i' ? this.data.species[id].ic : id}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const range = this.data.sprites[key];
    const bytes = this.bytes[kind];
    if (!range || !bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes.slice(range[0], range[0] + range[1])], { type: 'image/png' }));
    this.urls.set(key, url);
    return url;
  }

  moveType(id: string, name: string): string {
    // gTypeNames (battle_main.c) caps type names at 6 letters
    const game = (type: string) => ({ FIGHTING: 'FIGHT', ELECTRIC: 'ELECTR', PSYCHIC: 'PSYCHC' })[upper(type)] ?? upper(type);
    const hidden = /^Hidden Power (\w+)/.exec(name);
    if (hidden) return game(hidden[1]);
    const data = this.data;
    const index = data?.moves[id] ?? data?.moves[toId(name)] ?? data?.moves[id.replace(/\d+$/, '')];
    return index === undefined || !data ? '???' : game(data.types[index]);
  }

  colors(color: string | ColorPair): ColorPair {
    if (typeof color !== 'string') return color;
    return this.data?.colors[color] ?? EXTRA_COLORS[color] ?? EXTRA_COLORS.white;
  }

  private sheet(font: FontName, pair: ColorPair): HTMLCanvasElement | null {
    const key = `${font}:${pair.flat().join(',')}`;
    const cached = this.tinted.get(key);
    if (cached) return cached;
    const mask = this.fontMasks.get(font);
    if (!mask) return null;
    const out = new ImageData(mask.width, mask.height);
    const [fg, shadow] = pair;
    for (let i = 0; i < mask.data.length; i += 4) {
      if (!mask.data[i + 3]) continue;
      const color = mask.data[i] > 127 ? fg : shadow;
      out.data[i] = color[0];
      out.data[i + 1] = color[1];
      out.data[i + 2] = color[2];
      out.data[i + 3] = 255;
    }
    const canvas = el('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    canvas.getContext('2d')!.putImageData(out, 0, 0);
    this.tinted.set(key, canvas);
    return canvas;
  }

  private code(ch: string): number {
    const chars = this.data?.chars ?? {};
    return chars[ch] ?? chars[ch.toUpperCase()] ?? chars['?'] ?? 0;
  }

  measure(text: string, font: FontName = 'normal'): number {
    const widths = this.data?.fonts[font]?.w ?? [];
    let width = 0;
    for (const ch of text) width += ch === WAIT ? this.measure('...', font) : ch === ' ' ? widths[0] ?? 3 : ch === '~' ? 6 : widths[this.code(ch)] ?? 6;
    return width;
  }

  fit(text: string, width: number, font: FontName = 'normal'): string {
    if (this.measure(text, font) <= width) return text;
    let out = text;
    while (out && this.measure(`${out}…`, font) > width) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  }

  wrap(text: string, font: FontName, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && this.measure(next, font) > width) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  }

  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: FontName = 'normal', color: string | ColorPair = 'menu'): number {
    const sheet = this.sheet(font, this.colors(color));
    const widths = this.data?.fonts[font]?.w ?? [];
    const run = ns.glyphLog ? ++glyphRun : 0;
    let cx = x;
    for (const ch of text) {
      if (ch === ' ') {
        cx += widths[0] ?? 3;
        continue;
      }
      if (ch === '~') {
        this.tilde(ctx, cx, y, font, color);
        cx += 6;
        continue;
      }
      const code = this.code(ch);
      // CopyGlyphToWindow copies only the glyph's advance width; columns past it hold the next glyph's pixels
      const span = this.glyphSpan(font, code);
      if (sheet && span.w > 0) ctx.drawImage(sheet, (code % 16) * 16, Math.floor(code / 16) * 16, span.w, span.h, cx, y, span.w, span.h);
      ns.glyphLog?.push({ run, ch, font, x: cx, code, w: span.w, h: span.h });
      cx += widths[code] ?? 6;
    }
    return cx - x;
  }

  glyphSpan(font: FontName, code: number): { w: number; h: number } {
    return { w: this.data?.fonts[font]?.w[code] ?? 6, h: font === 'small' ? 13 : 15 };
  }

  inkCols(font: FontName, code: number): [number, number] | null {
    const mask = this.fontMasks.get(font);
    if (!mask) return null;
    const { w, h } = this.glyphSpan(font, code);
    const ox = (code % 16) * 16;
    const oy = Math.floor(code / 16) * 16;
    let lo = 99, hi = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (mask.data[((oy + y) * mask.width + ox + x) * 4 + 3]) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
    return hi < 0 ? null : [lo, hi];
  }

  private tilde(ctx: CanvasRenderingContext2D, x: number, y: number, font: FontName, color: string | ColorPair): void {
    const [fg, shadow] = this.colors(color);
    const base = font === 'small' ? 6 : 7;
    const dots: Array<[number, number]> = [[0, 1], [1, 0], [2, 0], [3, 1], [4, 0]];
    for (const [pair, dx] of [[shadow, 1], [fg, 0]] as Array<[Rgb, number]>) {
      ctx.fillStyle = `rgb(${pair.join(',')})`;
      for (const [px, py] of dots) ctx.fillRect(x + px + dx, y + base + py + dx, 1, 1);
    }
  }

  text(text: string, opts: TextOpts = {}): HTMLCanvasElement {
    const canvas = el('canvas', 'pkb-t');
    this.paint(canvas, text, opts);
    return canvas;
  }

  paint(canvas: HTMLCanvasElement, text: string, opts: TextOpts = {}): void {
    const font = opts.font ?? 'normal';
    const lineHeight = opts.lineHeight ?? this.data?.fonts[font]?.h ?? 16;
    canvas.dataset.text = text.replaceAll(WAIT, '...').slice(0, 40);
    const lines = text.split('\n');
    const animated = text.includes(WAIT);
    const width = opts.width ?? Math.max(1, ...lines.map((line) => this.measure(line, font)));
    const height = Math.max(1, lines.length * lineHeight);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `calc(var(--u) * ${width})`;
    canvas.style.height = `calc(var(--u) * ${height})`;
    const render = () => {
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, width, height);
      const dots = '.'.repeat(reducedMotion() ? 3 : dotStep);
      lines.forEach((line, i) => {
        const w = this.measure(line, font);
        const x = opts.align === 'right' ? width - w : opts.align === 'center' ? Math.floor((width - w) / 2) : 0;
        this.draw(ctx, line.replaceAll(WAIT, dots), x, i * lineHeight, font, opts.color ?? 'menu');
      });
    };
    if (animated) {
      waiting.set(canvas, render);
      if (!dotTimer) dotTimer = window.setInterval(tickDots, DOT_MS);
    } else waiting.delete(canvas);
    if (this.ready) render();
    else this.onReady(render);
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.images.clear();
    this.tinted.clear();
  }
}

function canvasEl(width: number, height: number, cls = ''): HTMLCanvasElement {
  const canvas = el('canvas', cls);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `calc(var(--u) * ${width})`;
  canvas.style.height = `calc(var(--u) * ${height})`;
  return canvas;
}

function imgEl(assets: Assets, name: string, cls = ''): HTMLImageElement {
  const img = el('img', cls);
  img.alt = '';
  img.draggable = false;
  img.src = assets.url(name);
  return img;
}

function frameBox(x: number, y: number, w: number, h: number): HTMLElement {
  return ns.place(el('div', 'pkb-std'), x - 8, y - 8, w + 16, h + 16);
}

class SettingsRow {
  private observer: MutationObserver | null = null;
  private queued = false;

  constructor(private readonly app: any) {}

  start(): void {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (SettingsRow.isOurs(mutation.target) || (mutation.removedNodes.length === 0 && [...mutation.addedNodes].every(SettingsRow.isOurs))) continue;
        this.schedule();
        return;
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.schedule();
  }

  dispose(): void {
    this.observer?.disconnect();
    document.querySelectorAll('[data-pkb-row]').forEach((row) => row.remove());
  }

  private static isOurs(node: Node | null): boolean {
    return !!node && node.nodeType === 1 && !!((node as Element).closest('[data-pkb-row]') || (node as Element).closest('.pkb-overlay') || (node as Element).closest('.pkb-launch'));
  }

  private static leaves(row: Element): Element[] {
    const text = row.querySelector('[data-settings-text]') ?? row;
    return [...text.querySelectorAll('*')].filter((node) => node.childElementCount === 0 && node.textContent?.trim() && !node.closest('[data-settings-control]'));
  }

  private static anchor(): Element | null {
    const rows = [...document.querySelectorAll('[data-settings-row]')].filter((row) => !row.hasAttribute('data-pkb-row') && !row.hasAttribute('data-fy-font-row'));
    const labelled = (test: (text: string) => boolean) => rows.filter((row) => SettingsRow.leaves(row).some((leaf) => test(leaf.textContent!.trim()))).pop();
    return rows.filter((row) => row.hasAttribute('data-cm-ext-row')).pop() ?? labelled((text) => text === 'Transcript width') ?? null;
  }

  private schedule(): void {
    if (this.queued || ns.rt.disposed) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      try {
        this.ensure();
      } catch (err) {
        report(err);
      }
    });
  }

  private ensure(): void {
    const anchor = SettingsRow.anchor();
    if (!anchor) return;
    const existing = document.querySelector('[data-pkb-row]');
    if (existing?.isConnected && existing.parentElement === anchor.parentElement) {
      this.sync(existing as HTMLElement);
      return;
    }
    existing?.remove();
    const row = anchor.cloneNode(true) as HTMLElement;
    for (const node of [row, ...row.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) if (/^(id|for|name|aria-|data-cm-|data-cinnamon-)/.test(attr.name)) node.removeAttribute(attr.name);
    }
    const [title, description, ...rest] = SettingsRow.leaves(row);
    rest.forEach((leaf) => leaf.remove());
    if (title) title.textContent = 'Pokemon battle';
    if (description) description.textContent = 'Battle the CPU or trainers on your Wi-Fi. Open it from the Poke Ball in the top bar or with Ctrl+Shift+B.';
    let control = row.querySelector<HTMLElement>('[data-settings-control]');
    if (!control) {
      control = el('div');
      control.setAttribute('data-settings-control', '');
      row.append(control);
    }
    const wrap = el('div', 'pkb-settings-control');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.className = 'pkb-sound-toggle';
    const label = el('label');
    label.append(toggle, '8-bit sounds');
    toggle.addEventListener('change', () => {
      ns.writeBattleSound({ muted: !toggle.checked });
      if (toggle.checked) ns.peSound('SE_SELECT');
    });
    const mode = el('select', 'pkb-settings-mode');
    mode.setAttribute('aria-label', 'Battle window');
    for (const [value, text] of [['overlay', 'Overlay'], ['floating', 'Floating window']]) {
      const option = el('option', '', text);
      option.value = value;
      mode.append(option);
    }
    mode.addEventListener('change', () => cinnamon.settings.set('window', mode.value === 'floating' ? 'floating' : null));
    const modeLabel = el('label');
    modeLabel.append('Battle window', mode);
    const auto = el('input');
    auto.type = 'checkbox';
    auto.className = 'pkb-auto-toggle';
    auto.addEventListener('change', () => cinnamon.settings.set('openAtStart', auto.checked ? null : false));
    const autoLabel = el('label');
    autoLabel.append(auto, 'Open battle window at start');
    const model = el('select', 'pkb-settings-model');
    model.setAttribute('aria-label', 'Claude model');
    for (const id of ['haiku', 'sonnet', 'opus', 'fable']) {
      const option = el('option', '', id.charAt(0).toUpperCase() + id.slice(1));
      option.value = id;
      model.append(option);
    }
    model.addEventListener('change', () => cinnamon.settings.set('claudeModel', model.value === 'haiku' ? null : model.value));
    const modelLabel = el('label');
    modelLabel.append('Claude model', model);
    const stats = el('input');
    stats.type = 'checkbox';
    stats.className = 'pkb-stats-toggle';
    stats.addEventListener('change', () => cinnamon.settings.set('showClaudeStats', stats.checked ? true : null));
    const statsLabel = el('label');
    statsLabel.append(stats, 'Show Claude stats');
    const open = el('button', 'pkb-settings-open', 'Open battle');
    open.type = 'button';
    open.addEventListener('click', () => this.app.show());
    wrap.append(label, autoLabel, modeLabel, modelLabel, statsLabel, open);
    control.replaceChildren(wrap);
    row.setAttribute('data-pkb-row', '');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Pokemon battle');
    anchor.after(row);
    this.sync(row);
  }

  sync(row: HTMLElement): void {
    const toggle = row.querySelector<HTMLInputElement>('.pkb-sound-toggle');
    if (toggle) toggle.checked = !this.app.sfx.sound.windows.battle.muted;
    const model = row.querySelector<HTMLSelectElement>('.pkb-settings-model');
    if (model) model.value = ns.claudeModel?.() ?? 'haiku';
    const stats = row.querySelector<HTMLInputElement>('.pkb-stats-toggle');
    if (stats) stats.checked = cinnamon.settings.get('showClaudeStats') === true;
    const auto = row.querySelector<HTMLInputElement>('.pkb-auto-toggle');
    if (auto) auto.checked = cinnamon.settings.get('openAtStart') !== false;
    const mode = row.querySelector<HTMLSelectElement>('.pkb-settings-mode');
    if (mode) mode.value = cinnamon.settings.get('window') === 'floating' ? 'floating' : 'overlay';
  }
}

const assets = new Assets();
function cursorAt(textX: number, textY: number): HTMLElement {
  return place(imgEl(assets, 'curAction'), textX - CURSOR_COL, textY - 1, 8, 16);
}

Object.assign(ns, { WAIT, forceDots, assets, canvasEl, imgEl, frameBox, cursorAt, SettingsRow });
