declare const cinnamon: { settings: { get(key: string): unknown } };
type Spark = [dx: number, dy: number, tile: number, flip: number];
// built by build-assets.mjs into battle-balls.css: the recorded throw paths and particle bursts, and the release
// timings read from the game's sources
type SendOutData = {
  start: [number, number];
  path: Record<string, [x: number, y: number, rotation: number][]>;
  particles: Record<string, Spark[][]>;
  ballBelow: number;
  sparksAbove: number;
  foeWait: number;
  open: [sheetFrame: number, frames: number][];
  emerge: { from: number; step: number; frames: number };
  rise: { from: number; step: number };
  tint: { colors: Record<string, [number, number, number]>; hold: number; frames: number };
  slide: { from: number; step: number };
};

const ns = (window as any).__pkb;
const { el, place, assets, decodeBase64 } = ns;
const FRAME_MS = 1000 / 59.7275;
let packed: Record<string, any> | null = null;
let sheets: Record<string, Promise<ImageData[] | null>> | null = null;
let sparkSheet: HTMLImageElement | null = null;

function sendOutEnabled(): boolean {
  return cinnamon.settings.get('sendOutV2') !== false;
}

function ballsCss(): Record<string, any> {
  if (!packed) {
    packed = {};
    try {
      const probe = el('div', 'pkb-data');
      probe.hidden = true;
      document.body.append(probe);
      const raw = getComputedStyle(probe).getPropertyValue('--pkb-balls').trim().replace(/^["']|["']$/g, '');
      probe.remove();
      if (raw) packed = JSON.parse(new TextDecoder().decode(decodeBase64(raw)));
    } catch {}
  }
  return packed!;
}

const sendOutData = (): SendOutData | null => ballsCss().so ?? null;

// the ball's own 16x48 sheet once decoded; null when it cannot load, never another ball's sheet in its place
function ballFrames(ball: string): Promise<ImageData[] | null> {
  if (!sheets) {
    sheets = {};
    const pngs = ballsCss();
    for (const id of Object.keys(sendOutData()?.tint.colors ?? {})) {
      if (typeof pngs[id] !== 'string') continue;
      const img = new Image();
      img.src = `data:image/png;base64,${pngs[id]}`;
      sheets[id] = img.decode().then(
        () => {
          const c = document.createElement('canvas');
          c.width = 16;
          c.height = 48;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          return [0, 1, 2].map((f) => ctx.getImageData(0, f * 16, 16, 16));
        },
        () => null,
      );
    }
  }
  return sheets[ball] ?? Promise.resolve(null);
}

function sparkImage(): HTMLImageElement | null {
  if (!sparkSheet) {
    const png = ballsCss().particles;
    if (typeof png !== 'string') return null;
    sparkSheet = new Image();
    sparkSheet.src = `data:image/png;base64,${png}`;
  }
  return sparkSheet.complete && sparkSheet.naturalWidth ? sparkSheet : null;
}

// a 16 px sprite in its 32 px double-size box, turned by `turn` (65536 to a full turn) with nearest-texel sampling
function drawBall(canvas: HTMLCanvasElement, frames: ImageData[], turn: number, frame: number): void {
  const src = frames[frame] ?? frames[0];
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(32, 32);
  const theta = (-turn * 2 * Math.PI) / 65536;
  const cos = Math.round(Math.cos(theta) * 256);
  const sin = Math.round(Math.sin(theta) * 256);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const tx = ((cos * (x - 16) + sin * (y - 16)) >> 8) + 8;
      const ty = ((-sin * (x - 16) + cos * (y - 16)) >> 8) + 8;
      if (tx < 0 || ty < 0 || tx > 15 || ty > 15) continue;
      out.data.set(src.data.subarray((ty * 16 + tx) * 4, (ty * 16 + tx) * 4 + 4), (y * 32 + x) * 4);
    }
  ctx.putImageData(out, 0, 0);
}

// one recorded burst frame: 8 px particles around the middle of a 160 px canvas
function drawSparks(canvas: HTMLCanvasElement, sheet: HTMLImageElement, sparks: Spark[]): void {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 160, 160);
  for (const [x, y, tile, flip] of sparks) {
    ctx.save();
    ctx.translate(80 + x - 4 + (flip ? 8 : 0), 80 + y - 4);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(sheet, 0, tile * 8, 8, 8, 0, 0, 8, 8);
    ctx.restore();
  }
}

// guard hook: parks a send-out on one named frame so a capture can look at it
async function hold(step: string): Promise<void> {
  if (ns.sendOutFreeze === step) await new Promise(() => {});
}

class FrameClock {
  private readonly start = performance.now();
  async until(frame: number): Promise<void> {
    if (ns.sendOutFastForward) return;
    const at = this.start + frame * FRAME_MS;
    const wait = at - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
  }
}

// battle-monanim.css: each entrance animation recorded frame by frame, and which one each species uses
let monAnimData: any;
const unpacked = new Map<number, number[][]>();
const FRAME_DEFAULTS = [0, 0, 0, 256, 256, 0, 0, 0];
function monAnimFrames(animId: number): number[][] | null {
  if (monAnimData === undefined) {
    monAnimData = null;
    try {
      const probe = el('div', 'pkb-data');
      probe.hidden = true;
      document.body.append(probe);
      const raw = getComputedStyle(probe).getPropertyValue('--pkb-monanim').trim().replace(/^["']|["']$/g, '');
      probe.remove();
      if (raw) monAnimData = JSON.parse(new TextDecoder().decode(decodeBase64(raw)));
    } catch {}
  }
  const list = monAnimData?.f?.[animId];
  if (!list) return null;
  if (!unpacked.has(animId)) {
    const out: number[][] = [];
    for (const item of list) {
      if (typeof item === 'number') for (let i = 0; i < item; i++) out.push(out[out.length - 1]);
      else out.push(FRAME_DEFAULTS.map((d, i) => item[i] ?? d));
    }
    unpacked.set(animId, out);
  }
  return unpacked.get(animId)!;
}

// the foe's front animation after its species delay, or the player's back animation from the species' set of
// three; Showdown sends no nature, so the back set uses the neutral (Serious) variant
function monAnimFor(key: 'me' | 'foe', dex: number): { id: number; delay: number } | null {
  monAnimFrames(0);
  if (!monAnimData) return null;
  if (key === 'foe') {
    const entry = monAnimData.front?.[dex];
    return entry ? { id: entry[0], delay: entry[1] } : null;
  }
  const set = monAnimData.sets?.[monAnimData.back?.[dex] ?? 0];
  return set ? { id: set[monAnimData.nature?.serious ?? 1], delay: 0 } : null;
}

// one recorded frame on a 128 px canvas (the affine double-size box): the recorded matrix maps screen to texture,
// so the canvas draws with its inverse; the recorded blend tints the opaque pixels
function drawMonFrame(canvas: HTMLCanvasElement, img: HTMLImageElement, frame: number[]): void {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, 128, 128);
  const [x2, y2, rot, sx, sy, coeff, color, invisible] = frame;
  if (invisible) return;
  const theta = ((rot & 0xffff) / 65536) * 2 * Math.PI;
  const pa = (sx * Math.cos(theta)) / 256;
  const pb = (-sx * Math.sin(theta)) / 256;
  const pc = (sy * Math.sin(theta)) / 256;
  const pd = (sy * Math.cos(theta)) / 256;
  const det = pa * pd - pb * pc || 1;
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(pd / det, -pc / det, -pb / det, pa / det, 64 + x2, 64 + y2);
  ctx.drawImage(img, -32, -32, 64, 64);
  if (coeff > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    const rgb = [color & 31, (color >> 5) & 31, (color >> 10) & 31].map((c) => (c << 3) | (c >> 2));
    ctx.fillStyle = `rgba(${rgb.join(',')},${coeff / 16})`;
    ctx.fillRect(0, 0, 128, 128);
    ctx.globalCompositeOperation = 'source-over';
  }
}

// the entrance animation's frames, null when the species has none
function entrance(key: 'me' | 'foe', dex: number): { delay: number; frames: number[][] } | null {
  const anim = monAnimFor(key, dex);
  const frames = anim ? monAnimFrames(anim.id) : null;
  return anim && frames?.length ? { delay: anim.delay, frames } : null;
}

function ballFor(battle: any, key: 'me' | 'foe', mon: { name: string }): string {
  const side = key === 'me' ? battle.mySide : battle.foeSide;
  const fromMap = battle.balls?.get?.(`${side}: ${mon.name}`);
  const fromTeam = key === 'me' ? battle.team?.find?.((e: any) => String(e.ident).endsWith(`: ${mon.name}`))?.ball : undefined;
  const ball = String(fromMap ?? fromTeam ?? 'poke').toLowerCase().replace(/ ?ball$/, '');
  return sendOutData()?.tint.colors[ball] ? ball : 'poke';
}

// the throw for the player's ball, the drop for the foe's, then the release: every count and step comes from
// sendOutData(); the order follows the game: the ball opens and hides, the mon grows in from a few pixels low
// in the ball's colour, the colour holds through the flash and fades, and once the growth ends the cry, the
// entrance animation and the health box start together
async function sendOutV2(battle: any, key: 'me' | 'foe', mon: any): Promise<boolean> {
  const data = sendOutData();
  const view = battle.mons[key];
  const ball = ballFor(battle, key, mon);
  const frames = data ? await ballFrames(ball) : null;
  const url = view.img.getAttribute('src');
  if (url) await view.img.decode().catch(() => {});
  if (!data || !frames || !url || !view.img.naturalWidth) return false;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const clock = new FrameClock();
  const monX = key === 'me' ? 40 : 144;
  const monTop = Number(/\* ([\d.-]+)\)$/.exec(view.root.style.top)?.[1] ?? 0) || (key === 'me' ? 56 : 16);
  const landX = monX + 32;
  // below the picture's centre; the player's picture sits 8 px lower here than in the game
  const landY = monTop + 32 + data.ballBelow - (key === 'me' ? 8 : 0);
  const ballCanvas = place(el('canvas', 'pkb-sendout-ball') as HTMLCanvasElement, 0, 0, 32, 32);
  ballCanvas.width = 32;
  ballCanvas.height = 32;
  battle.root.append(ballCanvas);
  const at = (x: number, y: number) => place(ballCanvas, Math.round(x) - 16, Math.round(y) - 16, 32, 32);
  view.ball.style.display = 'none';
  view.img.hidden = true;
  let release = data.foeWait;
  let ballX = landX;
  let ballY = landY;
  const targets = Object.keys(data.path).map(Number);
  const path = key === 'me' && !still ? data.path[String(Math.min(Math.max(Math.round(landY), Math.min(...targets)), Math.max(...targets)))] : null;
  if (path?.length) {
    for (let f = 0; f < path.length; f++) {
      at(path[f][0], path[f][1]);
      drawBall(ballCanvas, frames, path[f][2], 0);
      await hold(`${key}-throw-${f}`);
      await clock.until(f + 1);
    }
    [ballX, ballY] = path[path.length - 1];
    release = path.length + 1;
  } else {
    at(landX, landY);
    drawBall(ballCanvas, frames, 0, 0);
  }
  await clock.until(release);
  at(ballX, ballY);
  battle.sound.ballOpen();
  const sheet = still ? null : sparkImage();
  const burst = sheet ? data.particles[ball] ?? [] : [];
  const sparks = place(el('canvas', 'pkb-sendout-sparks') as HTMLCanvasElement, Math.round(ballX) - 80, Math.round(ballY) - data.sparksAbove - 80, 160, 160);
  sparks.width = 160;
  sparks.height = 160;
  battle.root.append(sparks);
  const monCanvas = place(el('canvas', 'pkb-monanim') as HTMLCanvasElement, monX - 32, monTop - 32, 128, 128);
  monCanvas.width = 128;
  monCanvas.height = 128;
  view.root.after(monCanvas);
  const box = battle.boxes[key];
  battle.renderBox(key);
  box.hidden = true;
  const species = assets.data?.species[assets.monId(mon.species) ?? '']?.n;
  const anim = still || !species ? null : entrance(key, species);
  const [tr, tg, tb] = data.tint.colors[ball] ?? [31, 31, 31];
  const tintColor = tr | (tg << 5) | (tb << 10);
  const full = data.tint.frames - 1;
  const openFor = data.open.reduce((sum, [, n]) => sum + n, 0);
  const grown = data.emerge.frames + 1;
  const cue = grown + 1;
  const animStart = cue + (anim?.delay ?? 0);
  const end = still ? 0 : Math.max(cue + Math.ceil(data.slide.from / data.slide.step), data.tint.hold + full, animStart + (anim?.frames.length ?? 0));
  for (let f = 0; f <= end && !battle.dead; f++) {
    if (sheet && burst[f]) drawSparks(sparks, sheet, burst[f]);
    else if (f >= burst.length) sparks.hidden = true;
    if (f < openFor && !still) {
      let left = f;
      const step = data.open.find(([, n]) => (left -= n) < 0) ?? data.open[data.open.length - 1];
      drawBall(ballCanvas, frames, 0, step[0]);
    } else ballCanvas.hidden = true;
    const growth = still ? 256 : data.emerge.from + data.emerge.step * Math.min(f, data.emerge.frames);
    const lift = still || f < 1 || f > data.emerge.frames ? 0 : (data.rise.from - data.rise.step * f) >> 8;
    const frame = [0, lift, 0, 65536 / growth, 65536 / growth, 0, 0, !still && f < 1 ? 1 : 0];
    const tint = still ? 0 : f < data.tint.hold ? full : Math.max(0, full - (f - data.tint.hold));
    if (tint) [frame[5], frame[6]] = [tint, tintColor];
    const step = anim && f >= animStart ? anim.frames[f - animStart] : null;
    if (step) {
      frame.splice(0, 5, step[0], step[1], step[2], step[3], step[4]);
      frame[7] = step[7];
      if (step[5]) [frame[5], frame[6]] = [step[5], step[6]];
    }
    drawMonFrame(monCanvas, view.img, frame);
    if (f === grown && key === 'foe' && !still) frontAnim(battle, view, mon);
    if (f === cue && species) battle.sound.cry(species, key, battle.sound.cryMode(mon));
    if (f >= cue || still) {
      box.hidden = false;
      const slide = still ? 0 : Math.max(0, data.slide.from - data.slide.step * (f - cue));
      box.style.transform = slide ? `translateX(calc(var(--u) * ${(key === 'me' ? 1 : -1) * slide}))` : '';
    }
    await hold(`${key}-release-${f}`);
    await clock.until(release + f + 1);
  }
  box.hidden = false;
  box.style.transform = '';
  ballCanvas.remove();
  monCanvas.remove();
  view.img.hidden = false;
  // the burst flies on while the battle carries on
  void (async () => {
    for (let f = end + 1; f < burst.length && !battle.dead; f++) {
      if (sheet) drawSparks(sparks, sheet, burst[f]);
      await hold(`${key}-sparks-${f}`);
      await clock.until(release + f + 1);
    }
    sparks.remove();
  })();
  return true;
}

// the species' two-frame picture animation on its recorded timings (game frames)
function frontAnim(battle: any, view: any, mon: any): void {
  const id = assets.monId(mon.species);
  const seq: number[] | undefined = id ? assets.data?.fa?.[id] : undefined;
  const second = id ? assets.sprite(mon.species, 'a') : null;
  const first = view.img.getAttribute('src');
  if (!seq || !second || !first) return;
  let t = 0;
  for (let i = 0; i < seq.length; i += 2) {
    const src = seq[i] === 1 ? second : first;
    setTimeout(() => {
      if (!battle.dead && view.img.isConnected) view.img.src = src;
    }, t);
    t += seq[i + 1] * FRAME_MS;
  }
  setTimeout(() => {
    if (!battle.dead && view.img.isConnected) view.img.src = first;
  }, t);
}

if (sendOutEnabled()) {
  void ballFrames('poke');
  sparkImage();
}
Object.assign(ns, { sendOutEnabled, sendOutV2, ballFor });
