declare const cinnamon: { settings: { get(key: string): unknown; set(key: string, value: unknown): void }; onDispose(fn: () => void): void };
type BallState = [rot: number, x: number];

const ns = (window as any).__pkb;
const { el, listen, NAV_SELECTOR, LAUNCH_SELECTOR } = ns;
const LAUNCH_BALLS = ['poke', 'great', 'ultra', 'master', 'safari', 'net', 'dive', 'nest', 'repeat', 'timer', 'luxury', 'premier'];
const LAUNCH_BALL_LABELS = ['Poké Ball', 'Great Ball', 'Ultra Ball', 'Master Ball', 'Safari Ball', 'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball', 'Luxury Ball', 'Premier Ball'];
const GAME_FRAME_MS = 1000 / 59.7275;
// BALL_WAIT_NEXT_SHAKE: the game waits 31 frames between shakes
const SHAKE_WAIT_FRAMES = 31;

// one catch shake, SpriteCB_Ball_Wobble_Step (battle_anim_throw.c): roll 8, pivot, roll back 13, pivot into roll 5
function catchShake(): BallState[] {
  const states: BallState[] = [];
  let rot = 0, x = 0, dir = 1, sub = 0, step = 3;
  for (const limit of [8, 0, 13, 5]) {
    if (!limit) {
      dir = -dir;
      step = -step;
      rot += step;
      states.push([rot, x]);
      continue;
    }
    for (let t = 0; t < limit; t++) {
      if (sub > 255) {
        x += dir;
        sub &= 0xff;
      } else sub += 176;
      rot += step;
      states.push([rot, x]);
    }
    sub = 0;
    if (limit === 13) {
      dir = -dir;
      step = -step;
    }
  }
  states.push([rot, x]);
  return states;
}

const SHAKE = catchShake();
const WAIT: BallState[] = Array.from({ length: SHAKE_WAIT_FRAMES }, () => [0, 0]);
// the next shake tips the other way, as sDirection flips between shakes in SpriteCB_Ball_Wobble_Step
const LAUNCH_ANIM: BallState[] = [...SHAKE, ...WAIT, ...SHAKE.map(([rot, x]): BallState => [-rot, -x]), ...WAIT];

// GBA double-size affine sprite: nearest texel, 256 units per turn, the 12 px ball sits at (2,2) of its 16 px cell
function affineFrame(src: ImageData, [rot, shift]: BallState): Uint8ClampedArray {
  const out = new Uint8ClampedArray(32 * 32 * 4);
  const theta = (rot * 2 * Math.PI) / 256;
  const pa = Math.round(Math.cos(theta) * 256);
  const pb = Math.round(Math.sin(theta) * 256);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const tx = ((pa * (x - 16) + pb * (y - 16)) >> 8) + 8 - 2;
      const ty = ((-pb * (x - 16) + pa * (y - 16)) >> 8) + 8 - 2;
      const ox = x + shift;
      if (tx < 0 || ty < 0 || tx >= src.width || ty >= src.height || ox < 0 || ox >= 32) continue;
      out.set(src.data.subarray((ty * src.width + tx) * 4, (ty * src.width + tx) * 4 + 4), (y * 32 + ox) * 4);
    }
  return out;
}

function ballUrl(id: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--pe-ball-${id}`).trim();
  return /^url\(["']?(data:[^"')]+)["']?\)$/.exec(raw)?.[1] ?? '';
}

function launcherBall(): string {
  const saved = String(cinnamon.settings.get('launcherBall') ?? '');
  return LAUNCH_BALLS.includes(saved) ? saved : 'poke';
}

class LauncherArt {
  readonly art = el('span', 'pkb-launch-ball');
  private readonly style = el('style');
  private readonly picker = el('div', 'pkb-ballpick');
  private built = '';

  constructor(private readonly button: HTMLElement) {
    this.style.setAttribute('data-pkb-ball', '');
    document.head.append(this.style);
    button.prepend(this.art);
    this.picker.hidden = true;
    this.picker.setAttribute('role', 'menu');
    this.picker.setAttribute('aria-label', 'Launcher ball');
    document.body.append(this.picker);
    button.addEventListener('contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      this.openPicker();
    });
    listen(document, 'pointerdown', (event: PointerEvent) => {
      if (!this.picker.hidden && !this.picker.contains(event.target as Node)) this.closePicker(false);
    }, true);
    cinnamon.onDispose(() => {
      this.style.remove();
      this.picker.remove();
    });
    this.sync();
  }

  sync(): void {
    const ball = launcherBall();
    const url = ballUrl(ball);
    if (!url || this.built === url) return;
    const img = new Image();
    img.onload = () => this.build(img, url);
    img.src = url;
  }

  box = { w: 18, h: 13 };

  private build(img: HTMLImageElement, url: string): void {
    const read = document.createElement('canvas');
    read.width = img.naturalWidth;
    read.height = img.naturalHeight;
    const rctx = read.getContext('2d')!;
    rctx.drawImage(img, 0, 0);
    const src = rctx.getImageData(0, 0, read.width, read.height);
    const keys = [...new Set(['0,0', ...LAUNCH_ANIM.map((state) => state.join())])];
    const frames = keys.map((key) => affineFrame(src, key.split(',').map(Number) as BallState));
    let x0 = 32, y0 = 32, x1 = 0, y1 = 0;
    for (const f of frames)
      for (let i = 3; i < f.length; i += 4)
        if (f[i]) {
          const p = (i - 3) / 4;
          x0 = Math.min(x0, p % 32);
          x1 = Math.max(x1, p % 32);
          y0 = Math.min(y0, Math.floor(p / 32));
          y1 = Math.max(y1, Math.floor(p / 32));
        }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const sheet = document.createElement('canvas');
    sheet.width = w * frames.length;
    sheet.height = h;
    const sctx = sheet.getContext('2d')!;
    frames.forEach((f, n) => sctx.putImageData(new ImageData(f, 32, 32), n * w - x0, -y0, x0, y0, w, h));
    const total = LAUNCH_ANIM.length;
    // percent offsets pick frame n of the sheet at any --pe-px, so a zoom change needs no rebuild
    const at = (n: number) => `${((n / (frames.length - 1)) * 100).toFixed(4)}%`;
    const stops = LAUNCH_ANIM.map((state, n) => `${((n / total) * 100).toFixed(4)}%{background-position-x:${at(keys.indexOf(state.join()))}}`);
    stops.push(`100%{background-position-x:0%}`);
    this.style.textContent = `@keyframes pkb-ball-idle{${stops.join('')}}`;
    Object.assign(this.art.style, {
      width: `calc(var(--pkb-bpx) * ${w})`,
      height: `calc(var(--pkb-bpx) * ${h})`,
      backgroundImage: `url("${sheet.toDataURL()}")`,
      backgroundSize: `calc(var(--pkb-bpx) * ${sheet.width}) 100%`,
      animationDuration: `${Math.round(total * GAME_FRAME_MS)}ms`,
    });
    this.built = url;
    this.box = { w, h };
  }

  private openPicker(): void {
    const current = launcherBall();
    const items = LAUNCH_BALLS.map((id, i) => {
      const item = el('button', 'pkb-ballpick-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(id === current));
      item.setAttribute('aria-label', LAUNCH_BALL_LABELS[i]);
      item.style.backgroundImage = `var(--pe-ball-${id})`;
      item.addEventListener('click', () => {
        cinnamon.settings.set('launcherBall', id === 'poke' ? null : id);
        ns.peSound?.('SE_SELECT');
        this.closePicker(true);
        queueMicrotask(() => this.sync());
      });
      item.addEventListener('keydown', (event: KeyboardEvent) => {
        const move: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 };
        if (event.key === 'Escape') this.closePicker(true);
        else if (event.key in move) items[(i + move[event.key] + items.length) % items.length].focus();
        else return;
        event.preventDefault();
        event.stopPropagation();
      });
      return item;
    });
    this.picker.replaceChildren(...items);
    this.picker.style.setProperty('--pkb-bpx', this.button.style.getPropertyValue('--pkb-bpx') || 'var(--pe-px, 1.375px)');
    this.picker.hidden = false;
    const r = this.button.getBoundingClientRect();
    const pw = this.picker.offsetWidth;
    this.picker.style.left = `${Math.max(4, Math.min(innerWidth - pw - 4, r.right - pw))}px`;
    const ph = this.picker.offsetHeight;
    this.picker.style.top = `${Math.max(4, Math.min(innerHeight - ph - 4, r.bottom + 4))}px`;
    items[LAUNCH_BALLS.indexOf(current)].focus();
  }

  private closePicker(refocus: boolean): void {
    this.picker.hidden = true;
    if (refocus) this.button.focus({ preventScroll: true });
  }
}

function placeLauncher(app: any): void {
  const dpr = window.devicePixelRatio || 1;
  app.launcherArt.sync();
  const head = app.topInset() || 45;
  const { w, h } = app.launcherArt.box;
  const pad = 4;
  const topRects = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].map((button) => button.getBoundingClientRect()).filter((rect) => rect.width >= 10 && rect.top >= 0 && rect.top <= 60);
  const nav = topRects(NAV_SELECTOR)
    .filter((rect) => rect.top < 30)
    .sort((a, b) => a.left - b.left);
  let navEnd = nav[0];
  for (const rect of nav.slice(1)) {
    if (Math.abs(rect.top - navEnd.top) > 3 || rect.left - navEnd.right > 12) break;
    navEnd = rect;
  }
  const panes = topRects(LAUNCH_SELECTOR);
  let spot: [number, number, number, number] | null = null;
  // one step under the largest fit leaves visible headroom; the full fit reads too large
  for (let k = Math.max(1, Math.floor(((head - 2 * pad) * dpr) / h) - 1); k >= 1 && !spot; k--) {
    const bw = (w * k) / dpr + 2 * pad;
    const bh = (h * k) / dpr + 2 * pad;
    const mid = navEnd ? navEnd.top + navEnd.height / 2 : head / 2;
    const top = Math.max(0, Math.min(head - bh, mid - bh / 2));
    const candidates: Array<[number, number]> = [];
    if (navEnd) candidates.push([navEnd.right + 4, top]);
    if (panes.length) candidates.push([Math.min(...panes.map((rect) => rect.left)) - bw - 4, top], [Math.max(...panes.map((rect) => rect.right)) + 4, top]);
    const hit = candidates.find(([cx, cy]) => slotFree(app, cx, cy, bw, bh));
    if (hit) {
      spot = [hit[0], hit[1], bw, k];
      app.launcher.style.setProperty('--pkb-bpx', `${k / dpr}px`);
      Object.assign(app.launcher.style, { width: `${bw}px`, height: `${bh}px` });
    }
  }
  const [x, y] = spot ?? [innerWidth - 38, innerHeight - 38];
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const transform = `translate(${snap(x)}px, ${snap(y)}px)`;
  if (app.launcher.style.transform !== transform) app.launcher.style.transform = transform;
}

function slotFree(app: any, x: number, y: number, w: number, h: number): boolean {
  if (x < 0 || x + w > innerWidth) return false;
  for (const px of [x + 1, x + w / 2, x + w - 1])
    for (const py of [y + 1, y + h / 2, y + h - 1]) {
      for (const hit of document.elementsFromPoint(px, py)) {
        if (hit === app.launcher || app.launcher.contains(hit)) continue;
        if (hit.closest('button, a[href], [role="button"], [role="tab"], input, textarea')) return false;
        break;
      }
    }
  return true;
}

Object.assign(ns, { LauncherArt, placeLauncher });
