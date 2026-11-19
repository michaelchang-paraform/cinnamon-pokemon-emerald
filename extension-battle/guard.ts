declare const cinnamon: { onDispose(fn: () => void): void };
type Rect = { x: number; y: number; w: number; h: number };
type Run = { kind: 'text' | 'cursor'; label: string; ink: Rect; clip: Rect | null; node: Element };
type Frame = { rect: Rect; node: Element };
type Finding = { state: string; issue: string; a: string; b: string };

const ns = (window as any).__pkb;
const SLACK = 0.25;

const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap - SLACK && b.x < a.x + a.w + gap - SLACK && a.y < b.y + b.h + gap - SLACK && b.y < a.y + a.h + gap - SLACK;
const inside = (a: Rect, b: Rect) => a.x >= b.x - SLACK && a.y >= b.y - SLACK && a.x + a.w <= b.x + b.w + SLACK && a.y + a.h <= b.y + b.h + SLACK;
const fmt = (r: Rect) => `${+r.x.toFixed(1)},${+r.y.toFixed(1)} ${+r.w.toFixed(1)}x${+r.h.toFixed(1)}`;

function alphaBounds(data: Uint8ClampedArray, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function pixels(node: HTMLCanvasElement | HTMLImageElement): { data: Uint8ClampedArray; w: number; h: number } | null {
  const w = node instanceof HTMLCanvasElement ? node.width : node.naturalWidth;
  const h = node instanceof HTMLCanvasElement ? node.height : node.naturalHeight;
  if (!w || !h) return null;
  const canvas = node instanceof HTMLCanvasElement ? node : document.createElement('canvas');
  if (!(node instanceof HTMLCanvasElement)) {
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(node, 0, 0);
  }
  return { data: canvas.getContext('2d')!.getImageData(0, 0, w, h).data, w, h };
}

function visible(node: Element): boolean {
  if (!node.getClientRects().length) return false;
  for (let n: Element | null = node; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.visibility !== 'visible' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
  }
  return true;
}

function collect(screen: HTMLElement, unit?: number): { runs: Run[]; frames: Frame[] } {
  const sr = screen.getBoundingClientRect();
  const u = unit ?? sr.width / 240;
  const toGame = (r: DOMRect | Rect): Rect => {
    const x = 'left' in r ? r.left : r.x;
    const y = 'top' in r ? r.top : r.y;
    const w = 'width' in r ? r.width : r.w;
    const h = 'height' in r ? r.height : r.h;
    return { x: (x - sr.left) / u, y: (y - sr.top) / u, w: w / u, h: h / u };
  };
  const clipOf = (node: Element): Rect | null => {
    let clip: Rect | null = null;
    for (let n = node.parentElement; n && n !== screen; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflow === 'visible' && cs.clipPath === 'none') continue;
      const r = toGame(n.getBoundingClientRect());
      clip = clip ? { x: Math.max(clip.x, r.x), y: Math.max(clip.y, r.y), w: Math.min(clip.x + clip.w, r.x + r.w) - Math.max(clip.x, r.x), h: Math.min(clip.y + clip.h, r.y + r.h) - Math.max(clip.y, r.y) } : r;
    }
    return clip;
  };
  const curUrl = ns.assets.url('curAction');
  const runs: Run[] = [];
  const nodes = [...screen.querySelectorAll<HTMLCanvasElement | HTMLImageElement>('canvas.pkb-t, img')];
  for (const node of nodes) {
    const isCursor = node instanceof HTMLImageElement && node.src === curUrl;
    if (node instanceof HTMLImageElement && !isCursor) continue;
    if (!visible(node)) continue;
    const px = pixels(node);
    if (!px) continue;
    const ink = alphaBounds(px.data, px.w, px.h);
    if (!ink) continue;
    const box = toGame(node.getBoundingClientRect());
    const sx = box.w / px.w;
    const sy = box.h / px.h;
    runs.push({
      kind: isCursor ? 'cursor' : 'text',
      label: isCursor ? 'cursor' : node.getAttribute('aria-label') || node.dataset.text || `text@${fmt(box)}`,
      ink: { x: box.x + ink.x * sx, y: box.y + ink.y * sy, w: ink.w * sx, h: ink.h * sy },
      clip: clipOf(node),
      node,
    });
  }
  const frames = [...screen.querySelectorAll('.pkb-std')].filter(visible).map((node) => ({ rect: toGame(node.getBoundingClientRect()), node }));
  return { runs, frames };
}

const meet = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > SLACK && h > SLACK ? { x, y, w, h } : null;
};

function check(state: string, screen: HTMLElement, out: Finding[], unit?: number): number {
  const collected = collect(screen, unit);
  const frames = collected.frames;
  const runs: Run[] = [];
  for (const run of collected.runs) {
    if (run.kind === 'text' && run.clip && !inside(run.ink, run.clip)) {
      if (meet(run.ink, run.clip)) out.push({ state, issue: 'text clipped', a: `${run.label} ink ${fmt(run.ink)}`, b: `box ${fmt(run.clip)}` });
      continue;
    }
    const shown = run.clip ? meet(run.ink, run.clip) : run.ink;
    if (shown) runs.push({ ...run, ink: shown });
  }
  const texts = runs.filter((r) => r.kind === 'text');
  const above = (f: Frame, node: Element) => !!(node.compareDocumentPosition(f.node) & Node.DOCUMENT_POSITION_FOLLOWING) && !f.node.contains(node);
  const hidden = (node: Element, r: Rect) => frames.some((f) => above(f, node) && inside(r, f.rect));
  for (const cur of runs.filter((r) => r.kind === 'cursor'))
    for (const t of texts) {
      if (!overlaps(cur.ink, t.ink, 1)) continue;
      const x = Math.max(cur.ink.x - 1, t.ink.x);
      const y = Math.max(cur.ink.y - 1, t.ink.y);
      const meet = { x, y, w: Math.min(cur.ink.x + cur.ink.w + 1, t.ink.x + t.ink.w) - x, h: Math.min(cur.ink.y + cur.ink.h + 1, t.ink.y + t.ink.h) - y };
      if (!hidden(t.node, meet)) out.push({ state, issue: 'cursor/text', a: fmt(cur.ink), b: `${t.label} ink ${fmt(t.ink)}` });
    }
  for (const t of texts) {
    for (const fr of frames) {
      if (above(fr, t.node)) continue;
      const f = fr.rect;
      const inner = { x: f.x + 8, y: f.y + 8, w: f.w - 16, h: f.h - 16 };
      if (overlaps(t.ink, f) && !inside(t.ink, inner)) out.push({ state, issue: 'text/border', a: `${t.label} ink ${fmt(t.ink)}`, b: `frame ${fmt(f)}` });
    }
  }
  frames.forEach((a, i) =>
    frames.slice(i + 1).forEach((b) => {
      if (overlaps(a.rect, b.rect)) out.push({ state, issue: 'frame/frame', a: `frame ${fmt(a.rect)}`, b: `frame ${fmt(b.rect)}` });
    }),
  );
  const prompts = [...screen.querySelectorAll('[data-pkb-prompt]')].filter(visible).map((n) => n.getBoundingClientRect());
  if (prompts.length) out.push({ state, issue: 'prompt present, add prompt/text check', a: String(prompts.length), b: '' });
  return runs.length;
}

const WIDE = 'MMMMMMMMMMMMMMMMMM';
const LONG_MOVES = ['Dynamic Punch', 'Extreme Speed', 'Smelling Salts', 'Dragon Breath'];
const LONG_MONS = ['Charmeleon', 'Butterfree', 'Masquerain', 'Crawdaunt', 'Ludicolo', 'Sharpedo'];

async function walk(app: any, stopAt = ''): Promise<{ states: number; runs: number; findings: Finding[]; stopped: boolean }> {
  const findings: Finding[] = [];
  let states = 0;
  let runs = 0;
  const frame = () => new Promise((r) => setTimeout(r, 0));
  const visit = async (name: string): Promise<boolean> => {
    await frame();
    states++;
    (window as any).__names?.push(name);
    runs += check(name, app.screenEl, findings);
    return name === stopAt;
  };
  const walkMenus = async (name: string): Promise<boolean> => {
    for (const [m, menu] of app.menus.entries()) {
      for (let i = 0; i < menu.items.length; i++) {
        app.menus.forEach((other: any) => {
          other.focused = other === menu;
          other.paint();
        });
        menu.index = i;
        menu.paint();
        if (await visit(`${name}/menu${m}/row${i}`)) return true;
      }
    }
    return false;
  };
  const battle = app.battle;
  if (battle?.current?.request?.active?.[0]) {
    const req = battle.current.request;
    req.active[0].moves = LONG_MOVES.map((move, i) => ({ move, id: move.toLowerCase().replace(/\W/g, ''), pp: 5 + i, maxpp: 40, disabled: false }));
    (battle.team ?? []).forEach((entry: any, i: number) => {
      if (LONG_MONS[i]) entry.ident = `p1: ${LONG_MONS[i]}`;
    });
    battle.openActions();
    for (let i = 0; i < 4; i++) {
      battle.actionIndex = i;
      battle.renderActions();
      if (await visit(`battle/actions/row${i}`)) return { states, runs, findings, stopped: true };
    }
    battle.openFight();
    for (let i = 0; i < 4; i++) {
      battle.moveIndex = i;
      battle.renderFight();
      if (await visit(`battle/fight/row${i}`)) return { states, runs, findings, stopped: true };
    }
    battle.openConfirm();
    for (let i = 0; i < 2; i++) {
      battle.confirmIndex = i;
      battle.renderConfirm();
      if (await visit(`battle/confirm/row${i}`)) return { states, runs, findings, stopped: true };
    }
    battle.openParty(false);
    const slots = Math.min(6, battle.team?.length ?? 0);
    for (let i = 0; i <= slots; i++) {
      battle.partyIndex = i;
      battle.renderParty();
      if (await visit(`battle/party/row${i}`)) return { states, runs, findings, stopped: true };
    }
    battle.openActions();
    return { states, runs, findings, stopped: false };
  }
  const looks = [{ cls: 'may', palette: [null, '#e05050', null] }, undefined, { cls: 5 }, { cls: 'nope' }, { cls: 'twins', palette: ['#40a0f0'] }];
  const peers = [1, 2, 3, 4, 5].map((n) => ({ id: `g${n}`, name: WIDE.slice(n - 1), status: n % 2 ? 'looking' : 'idle', address: '192.168.100.100:41852', source: 'mdns', trainer: looks[n - 1] }));
  const scenes: [string, () => void][] = [
    ['offline', () => { app.link.conn = 'offline'; app.prompt = null; app.screen = 'offline'; }],
    ['lobby', () => { app.link.conn = 'online'; app.welcomed = true; app.trainer = { id: 'me', name: WIDE }; app.peers = peers; app.screen = 'lobby'; app.lobbyFocus = 'menu'; }],
    ['lobby-peers', () => { app.lobbyFocus = 'peers'; }],
    ['incoming', () => { app.lobbyFocus = 'menu'; app.prompt = { kind: 'incoming', challenge: { challengeId: 'g', from: { id: 'g1', name: WIDE }, expiresAt: Date.now() + 60000 } }; }],
    ['outgoing', () => { app.outgoing = { challengeId: 'g', peer: { id: 'g1', name: WIDE } }; app.prompt = { kind: 'outgoing' }; }],
    ['result', () => { app.prompt = null; app.outgoing = null; app.result = { result: 'loss', reason: 'You forfeited.', turns: 188, mode: 'lan', opponent: WIDE, peerId: 'g1', difficulty: 'normal' }; app.screen = 'result'; }],
  ];
  for (const [name, setup] of scenes) {
    setup();
    app.render();
    if (await walkMenus(name)) return { states, runs, findings, stopped: true };
  }
  return { states, runs, findings, stopped: false };
}

ns.guard = { walk, check: (state: string) => { const out: Finding[] = []; check(state, ns.app.screenEl, out); return out; } };
cinnamon.onDispose(() => delete ns.guard);
