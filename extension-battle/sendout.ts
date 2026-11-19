declare const cinnamon: { settings: { get(key: string): unknown } };
type BallState = [rot: number, frame: number];

const ns = (window as any).__pkb;
const { el, place, assets, decodeBase64 } = ns;
const FRAME_MS = 1000 / 59.7275;
const BALL_IDS = ['poke', 'great', 'safari', 'ultra', 'master', 'net', 'dive', 'nest', 'repeat', 'timer', 'luxury', 'premier'];
// gBallOpenFadeColors (battle_anim_throw.c), RGB555
const FADE: Record<string, [number, number, number]> = {
  poke: [31, 22, 30], great: [16, 23, 30], safari: [23, 30, 20], ultra: [31, 31, 15], master: [23, 20, 28], net: [21, 31, 25],
  dive: [12, 25, 30], nest: [30, 27, 10], repeat: [31, 24, 16], timer: [29, 30, 30], luxury: [31, 17, 10], premier: [31, 9, 10],
};
let sheets: Record<string, Promise<ImageData[] | null>> | null = null;

function sendOutEnabled(): boolean {
  return cinnamon.settings.get('sendOutV2') !== false;
}

// the ball's own 16x48 sheet once decoded; null when it cannot load, never another ball's sheet in its place
function ballFrames(ball: string): Promise<ImageData[] | null> {
  if (!sheets) {
    sheets = {};
    let pngs: Record<string, string> = {};
    try {
      const probe = el('div', 'pkb-data');
      probe.hidden = true;
      document.body.append(probe);
      const raw = getComputedStyle(probe).getPropertyValue('--pkb-balls').trim().replace(/^["']|["']$/g, '');
      probe.remove();
      if (raw) pngs = JSON.parse(new TextDecoder().decode(decodeBase64(raw)));
    } catch {}
    for (const id of BALL_IDS) {
      if (!pngs[id]) continue;
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

// double-size affine sprite drawn with the GBA's nearest texel; 256 units per turn
function drawBall(canvas: HTMLCanvasElement, frames: ImageData[], [rot, frame]: BallState): void {
  const src = frames[frame] ?? frames[0];
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(32, 32);
  const theta = (rot * 2 * Math.PI) / 256;
  const pa = Math.round(Math.cos(theta) * 256);
  const pb = Math.round(Math.sin(theta) * 256);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const tx = ((pa * (x - 16) + pb * (y - 16)) >> 8) + 8;
      const ty = ((-pb * (x - 16) + pa * (y - 16)) >> 8) + 8;
      if (tx < 0 || ty < 0 || tx > 15 || ty > 15) continue;
      out.data.set(src.data.subarray((ty * 16 + tx) * 4, (ty * 16 + tx) * 4 + 4), (y * 32 + x) * 4);
    }
  ctx.putImageData(out, 0, 0);
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

const s16 = (v: number) => (v << 16) >> 16;
const sine = (i: number): number => assets.data?.sine?.[i] ?? Math.trunc(Math.sin((i * Math.PI) / 128) * 256);
// trig.c Sin and Cos: amplitude times the Q8.8 table, arithmetic shift
const Sin = (i: number, amp: number) => s16((amp * sine(i & 0xffff)) >> 8);
const Cos = (i: number, amp: number) => s16((amp * sine((i & 0xffff) + 64)) >> 8);

// SpriteCB_PlayerMonSendOut_1 and _2 over InitAnimArcTranslation: a 25-step arc 30 px high whose middle
// (arc phase 35 to 79) runs at a third of the speed while the ball spins 25 units a frame until it lands
function throwPath(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; rot: number }[] {
  const delta = (d: number) => {
    const v = (Math.trunc((Math.abs(d) << 8) / 25) & 0xffff) as number;
    return s16(d < 0 ? v | 1 : v & ~1);
  };
  const data = [25, delta(x1 - x0), delta(y1 - y0), 0, 0, -30, Math.trunc(0x8000 / 25), 0];
  let x2 = 0;
  let y2 = 0;
  let affineParam = 0;
  let rot = -1;
  const linear = (): boolean => {
    if (!data[0]) return true;
    const x = (data[3] + data[1]) & 0xffff;
    const y = (data[4] + data[2]) & 0xffff;
    x2 = data[1] & 1 ? -(x >> 8) : x >> 8;
    y2 = data[2] & 1 ? -(y >> 8) : y >> 8;
    data[3] = s16(x);
    data[4] = s16(y);
    data[0]--;
    return false;
  };
  const third = (i: number, scale: (v: number) => number) => (data[i] = s16((scale(data[i]) & ~1) | (data[i] & 1)));
  const out: { x: number; y: number; rot: number }[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const hi = (data[7] >> 8) & 0xff;
    if (hi >= 35 && hi < 80) {
      if ((affineParam & 0xff00) === 0) {
        third(1, (v) => Math.trunc(v / 3));
        third(2, (v) => Math.trunc(v / 3));
        rot = 0;
      }
      const left = data[0];
      linear();
      data[7] = s16(data[7] + Math.trunc(data[6] / 3));
      y2 = s16(y2 + Sin((data[7] >> 8) & 0xff, data[5]));
      affineParam = (affineParam + 0x100) & 0xffff;
      data[0] = (affineParam >> 8) % 3 !== 0 ? left : left - 1;
      if (((data[7] >> 8) & 0xff) >= 80) {
        third(1, (v) => v * 3);
        third(2, (v) => v * 3);
      }
    } else {
      if (linear()) break;
      data[7] = s16(data[7] + data[6]);
      y2 = s16(y2 + Sin((data[7] >> 8) & 0xff, data[5]));
    }
    if (rot >= 0) rot += 25;
    out.push({ x: x0 + x2, y: y0 + y2, rot: Math.max(0, rot) });
  }
  return out;
}

// sAnims_BallParticles as [tile, frames, hFlip] steps; a trailing true loops
const PARTICLE_ANIMS: [number, number, boolean][][] = [
  [[0, 1, false], [1, 1, false], [2, 1, false], [0, 1, true], [2, 1, false], [1, 1, false]],
  [[3, 1, false]],
  [[4, 1, false]],
  [[5, 1, false]],
  [[6, 4, false], [7, 4, false]],
  [[7, 4, false]],
];
const PARTICLE_ANIM_LOOPS = [true, false, false, false, true, false];
const PARTICLE_ANIM_NUM: Record<string, number> = { poke: 0, great: 0, safari: 0, ultra: 5, master: 1, net: 2, dive: 2, nest: 3, repeat: 5, timer: 5, luxury: 4, premier: 4 };
type Particle = { d: number[]; step: (p: Particle) => boolean; x2: number; y2: number; anim: number; age: number };
type ParticleFrame = [x: number, y: number, tile: number, flip: boolean][];

// the ball's AnimateBallOpenParticles task and sprite callbacks (battle_anim_throw.c), stepped like RunTasks then
// AnimateSprites; one list of particles per game frame
function particlePath(ball: string): ParticleFrame[] {
  const anim = PARTICLE_ANIM_NUM[ball] ?? 0;
  const live: Particle[] = [];
  const fan = (p: Particle) => {
    p.x2 = Sin(p.d[0], p.d[1]);
    p.y2 = Cos(p.d[0], p.d[2]);
    p.d[0] = (p.d[0] + p.d[4]) & 0xff;
    p.d[1] += p.d[5];
    p.d[2] += p.d[6];
    return ++p.d[3] === 51;
  };
  const spin = (angleStep: number, inner: (p: Particle) => number) => (p: Particle) => {
    p.x2 = Sin(p.d[0], p.d[1]);
    p.y2 = Cos(p.d[0], inner(p));
    p.d[0] = (p.d[0] + angleStep) & 0xff;
    p.d[1]++;
    p.d[2]++;
    return ++p.d[3] === 51;
  };
  const poke = (p: Particle) => {
    if (p.d[7] === 0) {
      p.d[7] = 1;
      return false;
    }
    p.x2 = Sin(p.d[0], p.d[1]);
    p.y2 = Cos(p.d[0], p.d[1]);
    p.d[1] += 2;
    return p.d[1] === 50;
  };
  const add = (step: (p: Particle) => boolean, d: number[]) => live.push({ d: [...d, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8), step, x2: 0, y2: 0, anim, age: 0 });
  const burst = (n: number, angle: number, d4: number, d5: number, d6: number) => {
    for (let i = 0; i < n; i++) add(fan, [i * angle, 0, 0, 0, d4, d5, d6]);
  };
  let task = 0;
  let wait = 0;
  let done = false;
  const out: ParticleFrame[] = [];
  for (let frame = 0; frame < 120 && (!done || live.length); frame++) {
    if (!done) {
      if (ball === 'poke') {
        add(poke, [(task >= 8 ? task - 8 : task) * 32]);
        if (task === 15) done = true;
        task++;
      } else if (ball === 'great' || ball === 'luxury') {
        if (wait) wait--;
        else {
          burst(8, 32, 8, 2, 2);
          wait = 8;
          if (++task === 2) done = true;
        }
      } else {
        if (ball === 'safari' || ball === 'net') burst(8, 32, 4, 1, 1);
        else if (ball === 'ultra' || ball === 'nest') burst(10, 25, 5, 1, 1);
        else if (ball === 'dive') burst(8, 32, 10, 1, 2);
        else if (ball === 'timer') burst(8, 32, 10, 2, 1);
        else if (ball === 'master') {
          burst(8, 32, 8, 2, 1);
          burst(8, 32, 8, 1, 2);
        } else if (ball === 'repeat') for (let i = 0; i < 12; i++) add(spin(6, (p) => Sin(p.d[0], p.d[2])), [i * 21]);
        else if (ball === 'premier') for (let i = 0; i < 8; i++) add(spin(10, (p) => Sin(p.d[0] & 0x3f, p.d[2])), [i * 32]);
        done = true;
      }
    }
    const shown: ParticleFrame = [];
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      if (p.step(p)) {
        live.splice(i, 1);
        continue;
      }
      shown.unshift([p.x2, p.y2, ...particleTile(p.anim, p.age++)]);
    }
    out.push(shown);
  }
  return out;
}

function particleTile(anim: number, age: number): [number, boolean] {
  const steps = PARTICLE_ANIMS[anim];
  const total = steps.reduce((sum, s) => sum + s[1], 0);
  let t = PARTICLE_ANIM_LOOPS[anim] ? age % total : Math.min(age, total - 1);
  for (const [tile, frames, flip] of steps) {
    if (t < frames) return [tile, flip];
    t -= frames;
  }
  return [steps[0][0], steps[0][2]];
}

let particleSheet: HTMLImageElement | null = null;
function particleImage(): HTMLImageElement | null {
  if (!particleSheet) {
    try {
      const probe = el('div', 'pkb-data');
      probe.hidden = true;
      document.body.append(probe);
      const raw = getComputedStyle(probe).getPropertyValue('--pkb-balls').trim().replace(/^["']|["']$/g, '');
      probe.remove();
      const png = raw ? JSON.parse(new TextDecoder().decode(decodeBase64(raw))).particles : null;
      if (!png) return null;
      particleSheet = new Image();
      particleSheet.src = `data:image/png;base64,${png}`;
    } catch {
      return null;
    }
  }
  return particleSheet.complete && particleSheet.naturalWidth ? particleSheet : null;
}

// 8x8 particles around the origin on a 160 px canvas
function drawParticles(canvas: HTMLCanvasElement, sheet: HTMLImageElement, frame: ParticleFrame): void {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 160, 160);
  for (const [x, y, tile, flip] of frame) {
    ctx.save();
    ctx.translate(80 + x - 4 + (flip ? 8 : 0), 80 + y - 4);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(sheet, 0, tile * 8, 8, 8, 0, 0, 8, 8);
    ctx.restore();
  }
}

// battle-monanim.css: pokemon_animation.c's ANIM_* callbacks recorded frame by frame, and which one each species uses
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

// the foe's front animation after its sMonAnimationDelayTable delay, or the player's back animation from the
// species' back set; Showdown sends no nature, so the back set uses the neutral (Serious) variant
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

// one recorded frame on a 128 px canvas (the affine double-size box): ObjAffineSet's matrix maps screen to
// texture, so the canvas draws with its inverse; BlendPalette tints the opaque pixels
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
  return BALL_IDS.includes(ball) ? ball : 'poke';
}

// pokeball.c send-out: the player throws on an arc (SpriteCB_PlayerMonSendOut_*), the foe's ball sits under its mon
// for 16 frames (SpriteCB_OpponentMonSendOut); then SpriteCB_ReleaseMonFromBall opens the ball, the mon emerges
// from the ball colour, cries when the emerge ends, and the health box slides in at 5 px a frame
async function sendOutV2(battle: any, key: 'me' | 'foe', mon: any): Promise<boolean> {
  const view = battle.mons[key];
  const ball = ballFor(battle, key, mon);
  const frames = await ballFrames(ball);
  const url = view.img.getAttribute('src');
  if (url) await view.img.decode().catch(() => {});
  if (!frames || !url || !view.img.naturalWidth) return false;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const clock = new FrameClock();
  const monX = key === 'me' ? 40 : 144;
  const monTop = Number(/\* ([\d.-]+)\)$/.exec(view.root.style.top)?.[1] ?? 0) || (key === 'me' ? 56 : 16);
  const cx = monX + 32;
  // GetBattlerSpriteCoord(BATTLER_COORD_Y_PIC_OFFSET) + 24; the player's picture sits 8 px below the game's centre here
  const cy = monTop + 32 + 24 - (key === 'me' ? 8 : 0);
  const ballCanvas = place(el('canvas', 'pkb-sendout-ball') as HTMLCanvasElement, 0, 0, 32, 32);
  ballCanvas.width = 32;
  ballCanvas.height = 32;
  battle.root.append(ballCanvas);
  const at = (x: number, y: number) => place(ballCanvas, Math.round(x) - 16, Math.round(y) - 16, 32, 32);
  view.ball.style.display = 'none';
  view.img.hidden = true;
  let release = 16;
  let ballX = cx;
  let ballY = cy;
  if (key === 'me' && !still) {
    const path = throwPath(24, 68, cx, cy);
    for (let f = 0; f < path.length; f++) {
      at(path[f].x, path[f].y);
      drawBall(ballCanvas, frames, [-path[f].rot, 0]);
      await hold(`${key}-throw-${f}`);
      await clock.until(f + 1);
    }
    ballX = path[path.length - 1]?.x ?? cx;
    ballY = path[path.length - 1]?.y ?? cy;
    release = path.length + 1;
  } else {
    at(cx, cy);
    drawBall(ballCanvas, frames, [0, 0]);
  }
  await clock.until(release);
  at(ballX, ballY);
  battle.sound.ballOpen();
  const sheet = still ? null : particleImage();
  const burst = sheet ? particlePath(ball) : [];
  const sparks = place(el('canvas', 'pkb-sendout-sparks') as HTMLCanvasElement, Math.round(ballX) - 80, Math.round(ballY) - 5 - 80, 160, 160);
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
  const [fr, fg, fb] = FADE[ball];
  const fadeColor = fr | (fg << 5) | (fb << 10);
  // release frame f: the ball opens (sBallAnimSeq1, 5 + 5 frames) and hides; the mon emerges (BATTLER_AFFINE_EMERGE,
  // 12 frames) rising from 14 px low; its ball colour holds while the background flashes white, then fades over 17
  // frames; at affineAnimEnded (13) the 2-frame anim starts, the cry and the entrance animation follow, and the
  // health box slides in at 5 px a frame once ballAnimActive clears
  const animStart = 14 + (anim?.delay ?? 0);
  const end = still ? 0 : Math.max(37, 26, animStart + (anim?.frames.length ?? 0));
  for (let f = 0; f <= end && !battle.dead; f++) {
    if (sheet && burst[f]) drawParticles(sparks, sheet, burst[f]);
    else if (f >= burst.length) sparks.hidden = true;
    if (f < 10 && !still) drawBall(ballCanvas, frames, [0, f < 5 ? 1 : 2]);
    else ballCanvas.hidden = true;
    const scale = still ? 256 : 0x28 + 0x12 * Math.min(f, 12);
    const frame = [0, still || f < 1 || f > 12 ? 0 : (0x1000 - 288 * f) >> 8, 0, 65536 / scale, 65536 / scale, 0, 0, !still && f < 1 ? 1 : 0];
    const fade = still ? 0 : f < 10 ? 16 : Math.max(0, 26 - f);
    if (fade) [frame[5], frame[6]] = [fade, fadeColor];
    const step = anim && f >= animStart ? anim.frames[f - animStart] : null;
    if (step) {
      frame.splice(0, 5, step[0], step[1], step[2], step[3], step[4]);
      frame[7] = step[7];
      if (step[5]) [frame[5], frame[6]] = [step[5], step[6]];
    }
    drawMonFrame(monCanvas, view.img, frame);
    if (f === 13 && key === 'foe' && !still) frontAnim(battle, view, mon);
    if (f === 14 && species) battle.sound.cry(species, key, battle.sound.cryMode(mon));
    if (f >= 14 || still) {
      box.hidden = false;
      const slide = still ? 0 : Math.max(0, 115 - 5 * (f - 14));
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
  // the particles fly on while the battle carries on, as they do in the game
  void (async () => {
    for (let f = end + 1; f < burst.length && !battle.dead; f++) {
      if (sheet) drawParticles(sparks, sheet, burst[f]);
      await hold(`${key}-sparks-${f}`);
      await clock.until(release + f + 1);
    }
    sparks.remove();
  })();
  return true;
}

// the entrance animation's two frames on the species' sAnim timings (front_pic_anims.h, game frames)
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
  particleImage();
}
Object.assign(ns, { sendOutEnabled, sendOutV2, ballFor, throwPath, particlePath });
