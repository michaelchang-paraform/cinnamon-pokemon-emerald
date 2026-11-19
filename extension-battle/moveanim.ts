// a move's or a general or status effect's recorded animation (battle-moves.css, battle-moves2.css,
// battle-statusanims.css, battle-movesheets.css, battle-movebgs.css): per frame the effect sprites, the two
// battlers' offsets, turns and tints, the BG layers with their scroll, palettes, scanline offsets, blending,
// windows and mosaic, drawn over the battle scene with its sounds
type Sprite = number[];
type Frame = { s?: Sprite[]; b?: number[][]; p?: number[][]; P?: number[][]; g?: number[]; v?: number[]; l?: number[]; h?: number[] | 0 };
type Run = { f: Frame[]; snd: [frame: number, id: string, pan: number][] };
type Packed = { moves: Record<string, any>; status: Record<string, [Run | null, Run | null]>; sheets: Record<string, string>; colors: Record<string, number[]>; layers: [number, number, string][] };
type Layer = { w: number; h: number; px: Uint8Array };
type Side = 'me' | 'foe';

const ns = (window as any).__pkb;
const { el, place, toId, decodeBase64 } = ns;
const FRAME_MS = 1000 / 59.7275;
// the recorder's sheet for battler pictures: a sprite on it is a copy of the battler whose palette slot it uses
const BATTLER_SHEET = 0xfff0;
// OAM shape and size to pixels: square, wide, tall
const SIZES = [[8, 8], [16, 16], [32, 32], [64, 64], [16, 8], [32, 8], [32, 16], [64, 32], [8, 16], [8, 32], [16, 32], [32, 64]];
// the part of the screen above the text box, where the BG layers show
const W = 240;
const H = 112;
let packed: Promise<Packed | null> | null = null;
const sheetBytes = new Map<string, Uint8Array>();
const images = new Map<string, HTMLCanvasElement>();
const layerCache = new Map<number, Promise<Layer>>();

const inflateBytes = (bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<ArrayBuffer> =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer();

async function inflate(variable: string): Promise<any> {
  const probe = el('div', 'pkb-data');
  probe.hidden = true;
  document.body.append(probe);
  const raw = getComputedStyle(probe).getPropertyValue(variable).trim().replace(/^["']|["']$/g, '');
  probe.remove();
  if (!raw) return null;
  return JSON.parse(new TextDecoder().decode(await inflateBytes(decodeBase64(raw), 'deflate')));
}

function moveData(): Promise<Packed | null> {
  packed ??= Promise.all(['--pkb-moves', '--pkb-moves2', '--pkb-movesheets', '--pkb-movebgs', '--pkb-statusanims'].map(inflate))
    .then(([moves, moves2, sheets, layers, status]) => (moves && sheets ? { moves: { ...moves, ...moves2 }, ...sheets, layers: layers ?? [], status: status ?? {} } : null))
    .catch(() => null);
  return packed;
}

function layer(data: Packed, id: number): Promise<Layer> {
  let cached = layerCache.get(id);
  if (!cached) {
    const [w, h, raw] = data.layers[id];
    cached = inflateBytes(decodeBase64(raw), 'deflate-raw').then((buf) => ({ w, h, px: new Uint8Array(buf) }));
    layerCache.set(id, cached);
  }
  return cached;
}

const rgb = (color: number): [number, number, number] => [0, 5, 10].map((s) => (((color >> s) & 31) << 3) | (((color >> s) & 31) >> 2)) as [number, number, number];

// a palette slot's recorded black and white points: every colour maps linearly between them, per channel
function remap(color: number, low: number, high: number): [number, number, number] {
  return [0, 5, 10].map((shift) => {
    const lo = (low >> shift) & 31;
    const hi = (high >> shift) & 31;
    const value = lo + Math.round((((color >> shift) & 31) * (hi - lo)) / 31);
    return (value << 3) | (value >> 2);
  }) as [number, number, number];
}

function spriteImage(data: Packed, sprite: Sprite, low: number, high: number, real: number[] | undefined): HTMLCanvasElement | null {
  const [tag, tile, shapeSize, , , , , palTag, , flags] = sprite;
  const key = `${tag}:${tile}:${shapeSize}:${palTag}:${real ? real.join('.') : `${low}:${high}`}:${flags & 12}`;
  const cached = images.get(key);
  if (cached) return cached;
  let bytes = sheetBytes.get(String(tag));
  if (!bytes) {
    const raw = data.sheets[tag];
    if (!raw) return null;
    bytes = decodeBase64(raw) as Uint8Array;
    sheetBytes.set(String(tag), bytes);
  }
  const colors = data.colors[palTag] ?? data.colors[tag];
  const [w, h] = SIZES[shapeSize] ?? [8, 8];
  if (!colors && !real) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const across = w / 8;
  for (let k = 0; k < across * (h / 8); k++) {
    const base = (tile + k) * 64;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const index = bytes[base + y * 8 + x];
        if (!index) continue;
        const bx = (k % across) * 8 + x;
        const by = Math.floor(k / across) * 8 + y;
        const dx = flags & 4 ? w - 1 - bx : bx;
        const dy = flags & 8 ? h - 1 - by : by;
        const [r, g, b] = real ? rgb(real[index] ?? 0) : remap(colors[index] ?? 0, low, high);
        out.data.set([r, g, b, 255], (dy * w + dx) * 4);
      }
  }
  ctx.putImageData(out, 0, 0);
  images.set(key, canvas);
  return canvas;
}

// the inverse of an OAM matrix (8.8, screen to texture) as a canvas transform about a point
function setMatrix(ctx: CanvasRenderingContext2D, [a, b, c, d]: number[], cx: number, cy: number): void {
  const pa = a / 256, pb = b / 256, pc = c / 256, pd = d / 256;
  const det = pa * pd - pb * pc || 1;
  ctx.setTransform(pd / det, -pc / det, -pb / det, pa / det, cx, cy);
}

// every colour of a drawn area moved between a slot's black and white points
function tint(ctx: CanvasRenderingContext2D, w: number, h: number, low: number, high: number): void {
  if (low === 0 && high === 0x7fff) return;
  const pixels = ctx.getImageData(0, 0, w, h);
  const lo = [0, 5, 10].map((s) => (((low >> s) & 31) * 255) / 31);
  const hi = [0, 5, 10].map((s) => (((high >> s) & 31) * 255) / 31);
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (!pixels.data[i + 3]) continue;
    for (let c = 0; c < 3; c++) pixels.data[i + c] = lo[c] + (pixels.data[i + c] * (hi[c] - lo[c])) / 255;
  }
  ctx.putImageData(pixels, 0, 0);
}

// what the display registers say this frame: blending, windows 0 and 1, the OBJ window, mosaic, per-line scroll
type Region = { bits: number; rect?: number[]; shape?: HTMLCanvasElement };
type Video = {
  mode: number; first: number; alpha: number; fade: number;
  regions: Region[]; outside: number; masks: Map<number, HTMLCanvasElement | null>;
  bgMosaic: number[]; objMosaic: number[];
  lineX: (Int16Array | null)[]; lineY: (Int16Array | null)[];
};

const canvas = (w: number, h: number): HTMLCanvasElement => Object.assign(document.createElement('canvas'), { width: w, height: h });
const objWindow = canvas(W, 160);
const maskPool = new Map<number, HTMLCanvasElement>();
const covered = canvas(W, 160);
const piece = canvas(W, 160);
const tinted = canvas(W, 160);

// a window's [left, top, right, bottom] from its WINxH and WINxV values (an inverted edge runs to the screen's)
function windowRect(h: number, v: number): number[] {
  const left = h >> 8, right = h & 255, top = v >> 8, bottom = v & 255;
  return [left, top, right > W || right < left ? W : right, bottom > 160 || bottom < top ? 160 : bottom];
}

function readVideo(v: number[], h: number[] | 0): Video {
  const [dispcnt, , , , bldcnt, bldalpha, bldy, winin, winout, mosaic, win0h, win0v, win1h = 0, win1v = 0] = v;
  const regions: Region[] = [];
  if (dispcnt & 0x2000) regions.push({ bits: winin & 63, rect: windowRect(win0h, win0v) });
  if (dispcnt & 0x4000) regions.push({ bits: (winin >> 8) & 63, rect: windowRect(win1h, win1v) });
  if (dispcnt & 0x8000) regions.push({ bits: (winout >> 8) & 63, shape: objWindow });
  const lineX: Video['lineX'] = [null, null, null, null];
  const lineY: Video['lineY'] = [null, null, null, null];
  if (h) {
    const [reg, wide] = h;
    const bg = (reg - 0x10) >> 2;
    if (bg >= 0 && bg < 4) {
      const xs = new Int16Array(160), ys = new Int16Array(160);
      for (let y = 0; y < 160; y++) {
        xs[y] = h[2 + y] & 0xffff;
        ys[y] = (h[2 + y] >>> 16) & 0xffff;
      }
      if (reg & 2) lineY[bg] = xs;
      else {
        lineX[bg] = xs;
        if (wide) lineY[bg] = ys;
      }
    }
  }
  return {
    mode: (bldcnt >> 6) & 3, first: bldcnt & 63, alpha: Math.min(16, bldalpha & 31) / 16, fade: Math.min(16, bldy & 31) / 16,
    regions, outside: winout & 63, masks: new Map(),
    bgMosaic: [(mosaic & 15) + 1, ((mosaic >> 4) & 15) + 1], objMosaic: [((mosaic >> 8) & 15) + 1, ((mosaic >> 12) & 15) + 1],
    lineX, lineY,
  };
}

// where the windows let a layer (bit 0-3 BGs, 4 OBJ) or the colour effect (bit 5) through: window 0 over window 1
// over the OBJ window over the rest of the screen; null when no window is on
function mask(video: Video, bit: number): HTMLCanvasElement | null {
  if (!video.regions.length) return null;
  const cached = video.masks.get(bit);
  if (cached !== undefined) return cached;
  let out = maskPool.get(bit);
  if (!out) maskPool.set(bit, (out = canvas(W, 160)));
  const o = out.getContext('2d')!, c = covered.getContext('2d')!, p = piece.getContext('2d')!;
  o.clearRect(0, 0, W, 160);
  c.clearRect(0, 0, W, 160);
  const paint = (ctx: CanvasRenderingContext2D, region: Region) => {
    if (region.rect) ctx.fillRect(region.rect[0], region.rect[1], region.rect[2] - region.rect[0], region.rect[3] - region.rect[1]);
    else if (region.shape) ctx.drawImage(region.shape, 0, 0);
    else ctx.fillRect(0, 0, W, 160);
  };
  for (const region of [...video.regions, { bits: video.outside }]) {
    p.globalCompositeOperation = 'source-over';
    p.clearRect(0, 0, W, 160);
    paint(p, region);
    if (region.bits & (1 << bit)) {
      p.globalCompositeOperation = 'destination-out';
      p.drawImage(covered, 0, 0);
      o.drawImage(piece, 0, 0);
    }
    paint(c, region);
  }
  video.masks.set(bit, out);
  return out;
}

// keeps only the parts of a drawn layer its windows show; (ox, oy) is where the canvas sits on the screen
function applyMask(ctx: CanvasRenderingContext2D, video: Video, bit: number, ox = 0, oy = 0): void {
  const m = mask(video, bit);
  if (!m) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(m, -ox, -oy);
  ctx.restore();
}

// brighten or darken what a layer drew (its own pixels only, where the windows allow the effect) when the colour
// effect targets it
function fadeLayer(ctx: CanvasRenderingContext2D, video: Video, bit: number, ox = 0, oy = 0): void {
  if ((video.mode !== 2 && video.mode !== 3) || !(video.first & (1 << bit)) || !video.fade) return;
  const t = tinted.getContext('2d')!;
  t.globalCompositeOperation = 'source-over';
  t.clearRect(0, 0, W, 160);
  t.fillStyle = video.mode === 2 ? '#fff' : '#000';
  t.fillRect(0, 0, W, 160);
  applyMask(t, video, 5);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = video.fade;
  ctx.drawImage(tinted, -ox, -oy);
  ctx.restore();
}

// mosaic: every block of the screen grid takes its top-left pixel; (ox, oy) is where the canvas sits on the screen
function pixelate(ctx: CanvasRenderingContext2D, w: number, h: number, [mx, my]: number[], ox = 0, oy = 0): void {
  if (mx < 2 && my < 2) return;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, y - ((((y + oy) % my) + my) % my));
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, x - ((((x + ox) % mx) + mx) % mx));
      const from = (sy * w + sx) * 4, to = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[to + k] = src.data[from + k];
    }
  }
  ctx.putImageData(out, 0, 0);
}

const scratch = canvas(W, H);

// one BG layer as the GBA shows it: wrapped at its map size, scrolled per line, coloured by its palettes, through
// its windows, mosaic, blend and fade
function drawLayer(ctx: CanvasRenderingContext2D, img: Layer, bg: number, x: number, y: number, video: Video, palettes: Map<number, number[]>, cnt: number): void {
  const sctx = scratch.getContext('2d')!;
  const out = sctx.createImageData(W, H);
  const lineX = video.lineX[bg], lineY = video.lineY[bg];
  const [mx, my] = cnt & 0x40 ? video.bgMosaic : [1, 1];
  for (let row = 0; row < H; row++) {
    const r = row - (row % my);
    const sx0 = lineX ? (lineX[r] << 16) >> 16 : x;
    const sy = ((((lineY ? (lineY[r] << 16) >> 16 : y) + r) % img.h) + img.h) % img.h;
    for (let col = 0; col < W; col++) {
      const px = img.px[sy * img.w + ((((sx0 + col - (col % mx)) % img.w) + img.w) % img.w)];
      const colors = px && palettes.get(16 + (px >> 4));
      if (!colors) continue;
      const [cr, cg, cb] = rgb(colors[px & 15]);
      out.data.set([cr, cg, cb, 255], (row * W + col) * 4);
    }
  }
  sctx.putImageData(out, 0, 0);
  applyMask(sctx, video, bg);
  fadeLayer(sctx, video, bg);
  ctx.save();
  ctx.globalAlpha = video.mode === 1 && video.first & (1 << bg) ? video.alpha : 1;
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

const spriteLayer = canvas(W, 160);
const mosaicLayer = canvas(W, 160);

// the effect sprites, through the OBJ windows, mosaic and fade; OBJ window sprites draw only the window's shape
function drawSprites(data: Packed, frame: Frame, slots: Map<number, [number, number]>, palettes: Map<number, number[]>, pictures: (HTMLImageElement | null)[], shift: number[], video: Video, blend: number): void {
  const targets = [spriteLayer, mosaicLayer, objWindow].map((c) => c.getContext('2d')!);
  for (const t of targets) {
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.clearRect(0, 0, W, 160);
    t.imageSmoothingEnabled = false;
  }
  // the GBA draws lower priority numbers, then lower subpriorities, in front
  const order = [...(frame.s ?? [])].sort((p, q) => q[5] - p[5] || q[6] - p[6]);
  for (const sprite of order) {
    const [low, high] = slots.get(sprite[8]) ?? [0, 0x7fff];
    const img = sprite[0] === BATTLER_SHEET ? pictures[sprite[8]] : spriteImage(data, sprite, low, high, palettes.get(sprite[8]));
    if (!img) continue;
    const [w, h] = SIZES[sprite[2]] ?? [8, 8];
    const flags = sprite[9];
    const t = targets[flags & 32 ? 2 : flags & 64 ? 1 : 0];
    // which battler's picture centre the sprite follows, in quarters (the recorder's offsets probe)
    const anchor = flags >> 7;
    const y = sprite[4] + Math.round((Math.floor(anchor / 5) * shift[0] + (anchor % 5) * shift[1]) / 4);
    const box = flags & 2 ? 2 : 1;
    t.globalAlpha = flags & 16 ? blend : 1;
    if (flags & 1) {
      setMatrix(t, sprite.slice(10, 14), sprite[3] + (w * box) / 2, y + (h * box) / 2);
      t.drawImage(img, -w / 2, -h / 2, w, h);
      t.setTransform(1, 0, 0, 1, 0, 0);
    } else t.drawImage(img, sprite[3], y, w, h);
    t.globalAlpha = 1;
  }
  pixelate(targets[1], W, 160, video.objMosaic);
  targets[0].drawImage(mosaicLayer, 0, 0);
  applyMask(targets[0], video, 4);
  fadeLayer(targets[0], video, 4);
}

// a battler's picture moved, turned and tinted on its own 128 px canvas at (left, top) on the screen; on a BG layer
// with a scanline effect, each row moves by that line's scroll
function drawBattler(canvas: HTMLCanvasElement, img: HTMLImageElement, state: number[] | undefined, low: number, high: number, left: number, top: number, video: Video, scroll: number[], v: number[]): void {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, 128, 128);
  const [x2 = 0, y2 = 0, flags = 0] = state ?? [];
  if (flags & 1) return;
  ctx.imageSmoothingEnabled = false;
  const bg = flags & 4 ? (flags >> 3) & 3 : 0;
  const lines = bg ? video.lineX[bg] : null;
  if (lines) {
    for (let row = 0; row < 64; row++) {
      const screenY = top + 32 + y2 + row;
      const dx = screenY >= 0 && screenY < 160 ? -(((lines[screenY] << 16) >> 16) - scroll[bg === 1 ? 0 : 2]) : 0;
      ctx.drawImage(img, 0, row, 64, 1, 32 + x2 + dx, 32 + y2 + row, 64, 1);
    }
  } else {
    if (flags & 2) setMatrix(ctx, state!.slice(3, 7), 64 + x2, 64 + y2);
    else ctx.setTransform(1, 0, 0, 1, 64 + x2, 64 + y2);
    ctx.drawImage(img, -32, -32, 64, 64);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  tint(ctx, 128, 128, low, high);
  // the BG mosaic of the layer the battler is drawn on, or that its priority ties it to (Transform)
  if (flags & 32 || (bg && v[bg] & 0x40)) pixelate(ctx, 128, 128, video.bgMosaic, left, top);
  applyMask(ctx, video, 4, left, top);
  fadeLayer(ctx, video, 4, left, top);
}

// the battle background scrolled by BG3 (wrapping, as the layer does) and tinted by its palette
function drawTerrain(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, low: number, high: number): void {
  ctx.imageSmoothingEnabled = false;
  const ox = ((-x % W) + W) % W;
  const oy = ((-y % H) + H) % H;
  for (const dx of [ox - W, ox]) for (const dy of [oy - H, oy]) ctx.drawImage(img, dx, dy, W, H);
  tint(ctx, W, H, low, high);
}

// how far each battler's picture centre sits from where the recording put it (offset 0, no elevation)
function pictureShift(battle: any): number[] {
  const data = (key: Side) => ns.assets.mon(battle.sides?.[key === 'me' ? battle.mySide : battle.foeSide]?.active?.species ?? '');
  const me = data('me'), foe = data('foe');
  return [Math.min((me?.by ?? 8) + 88, 104) - 88, foe ? foe.fy - foe.el : 16];
}

// plays the move's animation from the attacker's side; false when there is no recording, so the caller falls back
async function playMoveAnim(battle: any, move: string, attacker: Side): Promise<boolean> {
  const data = await moveData();
  const run: Run | undefined = data?.moves[toId(move)]?.[attacker === 'me' ? 0 : 1];
  if (!data || !run || battle.dead) return false;
  return playRun(battle, data, run, attacker, toId(move));
}

// a general or status animation (s:Poison, g:StatsChange:atk+1, g:TurnTrap:clamp) on one mon's side
async function playEffectAnim(battle: any, name: string, side: Side): Promise<boolean> {
  const data = await moveData();
  const run: Run | undefined = data?.status[name]?.[side === 'me' ? 0 : 1];
  if (!data || !run || battle.dead) return false;
  return playRun(battle, data, run, side, name.replace(/\W/g, '').toLowerCase());
}

async function playRun(battle: any, data: Packed, run: Run, attacker: Side, freezeName: string): Promise<boolean> {
  const layerIds = new Set(run.f.flatMap((f) => f.l ?? []).filter((id) => id >= 0));
  const layers = new Map(await Promise.all([...layerIds].map(async (id) => [id, await layer(data, id)] as const)));
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  const soundTimers = run.snd.map(([frame, id, pan]) =>
    setTimeout(() => {
      if (battle.dead) return;
      if (id.startsWith('cry:')) battle.sound.cryOf(attacker, id.slice(4), pan / 64);
      else battle.sound.play(id, pan / 64);
    }, frame * FRAME_MS),
  );
  const keys: Side[] = ['me', 'foe'];
  const shift = pictureShift(battle);
  const overlay = place(el('canvas', 'pkb-moveanim') as HTMLCanvasElement, 0, 0, W, 160);
  overlay.width = W;
  overlay.height = 160;
  const battlers = keys.map((key) => {
    const view = battle.mons[key];
    const left = key === 'me' ? 40 : 144;
    const top = Number(/\* ([\d.-]+)\)$/.exec(view.root.style.top)?.[1] ?? 0);
    const canvas = place(el('canvas', 'pkb-moveanim') as HTMLCanvasElement, left - 32, top - 32, 128, 128);
    canvas.width = 128;
    canvas.height = 128;
    return { key, view, canvas, left: left - 32, top: top - 32, shown: !view.img.hidden && view.img.getAttribute('src') };
  });
  const terrain = battle.root.firstElementChild as HTMLImageElement | null;
  const backCanvas = place(el('canvas', 'pkb-moveanim') as HTMLCanvasElement, 0, 0, W, H);
  backCanvas.width = W;
  backCanvas.height = H;
  let backShown = false;
  const pictures = battlers.map((b) => (b.shown ? (b.view.img as HTMLImageElement) : null));
  let done = false;
  // whatever happens while it plays, the battlers come back and the canvases go
  try {
    if (!still) {
      battle.mons.me.root.after(overlay);
      for (const b of battlers) {
        if (!b.shown) continue;
        b.view.root.after(b.canvas);
        b.view.img.style.visibility = 'hidden';
      }
    }
    const ctx = overlay.getContext('2d')!;
    const back = backCanvas.getContext('2d')!;
    let v: number[] = data.moves['#v'] ?? [];
    let shown = [-1, -1, -1];
    let real: number[][] = [];
    let lines: number[] | 0 = 0;
    for (let f = 0; f < run.f.length && !battle.dead; f++) {
      const frame = run.f[f];
      v = frame.v ?? v;
      shown = frame.l ?? shown;
      real = frame.P ?? real;
      lines = frame.h ?? lines;
      if (!still) {
        const video = readVideo(v, lines);
        const slots = new Map<number, [number, number]>((frame.p ?? []).map(([slot, low, high]) => [slot, [low, high]]));
        const palettes = new Map<number, number[]>(real.map(([slot, ...colors]) => [slot, colors]));
        const [bg1x = 0, bg1y = 0, bg2x = 0, bg2y = 0, bg3x = 0, bg3y = 0] = frame.g ?? [];
        const scroll = [bg1x, bg1y, bg2x, bg2y, bg3x, bg3y];
        // BG layers 1 and 2 go behind the battlers at priority 2 and 3, in front of them otherwise
        const behind = (bg: number) => (v[bg] & 3) >= 2;
        const layerOf = (bg: number) => (shown[bg - 1] >= 0 ? layers.get(shown[bg - 1]) : undefined);
        const [terrainLow, terrainHigh] = slots.get(18) ?? slots.get(17) ?? [0, 0x7fff];
        const bg3 = layerOf(3);
        const backLayers = [2, 1].filter((bg) => behind(bg) && layerOf(bg));
        const terrainMoved = bg3x || bg3y || terrainLow !== 0 || terrainHigh !== 0x7fff;
        const backFade = (video.mode === 2 || video.mode === 3) && video.first & 8 && video.fade;
        if (bg3 || backLayers.length || terrainMoved || backFade) {
          if (!backShown && terrain) terrain.after(backCanvas);
          backShown = true;
          back.setTransform(1, 0, 0, 1, 0, 0);
          back.clearRect(0, 0, W, H);
          if (bg3) drawLayer(back, bg3, 3, bg3x, bg3y, video, palettes, v[3]);
          else if (terrain) {
            drawTerrain(back, terrain, bg3x, bg3y, terrainLow, terrainHigh);
            fadeLayer(back, video, 3);
          }
          for (const bg of backLayers) drawLayer(back, layerOf(bg)!, bg, scroll[(bg - 1) * 2], scroll[(bg - 1) * 2 + 1], video, palettes, v[bg]);
        } else if (backShown) {
          backCanvas.remove();
          backShown = false;
        }
        // the sprites first: their OBJ window shape is what the layers' windows read
        drawSprites(data, frame, slots, palettes, pictures, shift, video, v[5] & 31 ? video.alpha : 0.5);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, 160);
        for (const bg of [2, 1]) {
          const img = layerOf(bg);
          if (img && !behind(bg)) drawLayer(ctx, img, bg, scroll[(bg - 1) * 2], scroll[(bg - 1) * 2 + 1], video, palettes, v[bg]);
        }
        ctx.drawImage(spriteLayer, 0, 0);
        battlers.forEach((b, i) => {
          if (!b.shown) return;
          const [low, high] = slots.get(i) ?? [0, 0x7fff];
          drawBattler(b.canvas, b.view.img, frame.b?.[i], low, high, b.left, b.top, video, scroll, v);
        });
      }
      // guard hook: parks the animation on one named frame so a capture can look at it
      await ns.freezeAt(`${freezeName}-${f}`);
      const wait = start + (f + 1) * FRAME_MS - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    }
    done = true;
  } finally {
    overlay.remove();
    for (const b of battlers) {
      b.canvas.remove();
      b.view.img.style.visibility = '';
    }
    backCanvas.remove();
    if (!done) for (const timer of soundTimers) clearTimeout(timer);
  }
  return true;
}

Object.assign(ns, { playMoveAnim, playEffectAnim, moveData });
