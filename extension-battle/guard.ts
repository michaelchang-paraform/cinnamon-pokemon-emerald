declare const cinnamon: { onDispose(fn: () => void): void; settings: { set(key: string, value: unknown): void } };
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

type Glyph = { run: number; ch: string; font: 'normal' | 'small' | 'narrow'; x: number; code: number; w: number; h: number };

// every glyph sits on a whole game pixel and copies exactly the tile columns the game copies (text.c DecompressGlyph_*)
function glyphFindings(log: Glyph[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const runs = new Map<number, Glyph[]>();
  for (const g of log) runs.set(g.run, [...(runs.get(g.run) ?? []), g]);
  for (const glyphs of runs.values()) {
    const text = glyphs.map((g) => g.ch).join('');
    for (const [i, g] of glyphs.entries()) {
      const want = { w: ns.assets.data?.fonts[g.font]?.w[g.code] ?? 6, h: g.font === 'small' ? 13 : 15 };
      const issue = !Number.isInteger(g.x) ? 'glyph off pixel grid' : g.w !== want.w || g.h !== want.h ? 'glyph span differs from game' : '';
      if (!issue) continue;
      const key = `${issue}|${g.font}|${g.ch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ state: 'glyphs', issue, a: `${g.font} '${g.ch}' at ${i} in "${text.slice(0, 30)}"`, b: `x ${g.x}, span ${g.w}x${g.h}, game ${want.w}x${want.h}` });
    }
  }
  return out;
}

// renders each string through the real text path and compares every glyph to the font bitmap, column for column
function pixelAudit(items: Array<[string, 'normal' | 'small' | 'narrow']>): { glyphs: number; mismatches: number; examples: string[] } {
  const assets = ns.assets;
  let glyphs = 0;
  let mismatches = 0;
  const examples: string[] = [];
  for (const [text, font] of items) {
    const canvas = assets.text(text, { font, color: 'std' });
    const got = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const mask = assets.fontMasks.get(font);
    const widths = assets.data.fonts[font].w;
    const rows = font === 'small' ? 13 : 15;
    let x = 0;
    for (const ch of text) {
      if (ch === ' ' || ch === '~') {
        x += ch === ' ' ? widths[0] ?? 3 : 6;
        continue;
      }
      const code = assets.code(ch);
      const adv = widths[code] ?? 6;
      glyphs++;
      let bad = false;
      for (let y = 0; y < Math.min(rows, canvas.height) && !bad; y++)
        for (let c = 0; c < adv && x + c < canvas.width; c++) {
          const want = mask.data[(((code >> 4) * 16 + y) * mask.width + (code % 16) * 16 + c) * 4 + 3] > 0;
          const have = got[(y * canvas.width + x + c) * 4 + 3] > 0;
          if (want !== have) {
            bad = true;
            break;
          }
        }
      if (bad) {
        mismatches++;
        if (examples.length < 12) examples.push(`${font} '${ch}' in "${text}"`);
      }
      x += adv;
    }
  }
  return { glyphs, mismatches, examples };
}

async function walk(app: any, stopAt = ''): Promise<{ states: number; runs: number; findings: Finding[]; stopped: boolean }> {
  const findings: Finding[] = [];
  const glyphLog: Glyph[] = [];
  ns.glyphLog = glyphLog;
  // a fixed-width paint cuts a long line at the canvas edge, where no ink check can see it; keep the full text
  const assets = ns.assets;
  const paint = assets.paint;
  const painted = new WeakMap<HTMLCanvasElement, { text: string; font: string; width: number }>();
  assets.paint = function (canvas: HTMLCanvasElement, text: string, opts: { font?: string; width?: number } = {}) {
    if (opts.width !== undefined) painted.set(canvas, { text, font: opts.font ?? 'normal', width: opts.width });
    else painted.delete(canvas);
    return paint.call(this, canvas, text, opts);
  };
  const overflow = (name: string) => {
    for (const canvas of app.screenEl.querySelectorAll('canvas') as NodeListOf<HTMLCanvasElement>) {
      const entry = painted.get(canvas);
      if (!entry || !canvas.getClientRects().length) continue;
      for (const line of entry.text.replaceAll(ns.WAIT, '...').split('\n')) {
        const w = assets.measure(line, entry.font);
        if (w > entry.width) findings.push({ state: name, issue: 'text overflows its box', a: `"${line.slice(0, 40)}" w ${w}`, b: `box ${entry.width}` });
      }
    }
  };
  ns.sendOutFastForward = true;
  const finish = <T,>(result: T): T => {
    ns.sendOutFastForward = false;
    assets.paint = paint;
    ns.glyphLog = undefined;
    findings.push(...glyphFindings(glyphLog));
    for (const id of ns.missingEffects?.() ?? []) findings.push({ state: 'audio', issue: 'sound effect missing from pokemon-audio', a: id, b: 'plays silence' });
    return result;
  };
  let states = 0;
  let runs = 0;
  const frame = () => new Promise((r) => setTimeout(r, 0));
  const errorsBefore = ns.debugLog.errors.length;
  const visit = async (name: string): Promise<boolean> => {
    await frame();
    // a typing message box or a send-out is measured once it settles, never part way
    for (let i = 0; i < 40 && app.battle?.running && !app.battle.dead; i++) {
      app.battle.skip = true;
      await new Promise((r) => setTimeout(r, 30));
    }
    if (app.battle?.running && !app.battle.dead) findings.push({ state: name, issue: 'UNSETTLED', a: 'battle still running after 1.2 s', b: 'not measured settled' });
    ns.forceDots?.(3);
    if (ns.debugLog.errors.length > errorsBefore) findings.push({ state: name, issue: 'render error', a: String(ns.debugLog.errors.at(-1)).slice(0, 120), b: '' });
    states++;
    (window as any).__names?.push(name);
    runs += check(name, app.screenEl, findings);
    overflow(name);
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
      if (await visit(`battle/actions/row${i}`)) return finish({ states, runs, findings, stopped: true });
    }
    battle.openFight();
    for (let i = 0; i < 4; i++) {
      battle.moveIndex = i;
      battle.renderFight();
      if (await visit(`battle/fight/row${i}`)) return finish({ states, runs, findings, stopped: true });
    }
    req.active[0].moves = ['Steel Wing', 'Hidden Power', 'Silver Wind', 'Swords Dance'].map((move, i) => ({ move, id: move.toLowerCase().replace(/\W/g, ''), pp: 40 - i, maxpp: 40, disabled: false }));
    battle.openFight();
    for (let i = 0; i < 4; i++) {
      battle.moveIndex = i;
      battle.renderFight();
      if (await visit(`battle/fight-steel/row${i}`)) return finish({ states, runs, findings, stopped: true });
    }
    const windows = [[16, 120, 64, 16], [88, 120, 64, 16], [16, 136, 64, 16], [88, 136, 64, 16], [168, 120, 32, 16], [200, 120, 32, 16], [168, 136, 64, 16]];
    const sr = app.screenEl.getBoundingClientRect();
    const u = sr.width / 240;
    const names: string[] = (window as any).__gameNames?.moves ?? [];
    const typeIds = new Map<number, string>();
    for (const [id, t] of Object.entries(ns.assets.data?.moves ?? {})) if (!typeIds.has(t as number)) typeIds.set(t as number, id);
    const ids = [...typeIds.values()];
    let outside = 0;
    for (let start = 0; start < Math.max(names.length, ids.length * 4); start += 4) {
      const set = [0, 1, 2, 3].map((i) => names[(start + i) % Math.max(1, names.length)] ?? 'TACKLE');
      req.active[0].moves = set.map((move, i) => ({ move, id: ids[(start / 4 + i) % ids.length], pp: 8, maxpp: 40, disabled: false }));
      battle.openFight();
      for (let i = 0; i < 4; i++) {
        battle.moveIndex = i;
        battle.renderFight();
        for (const canvas of battle.menuLayer.querySelectorAll('canvas.pkb-t')) {
          const r = canvas.getBoundingClientRect();
          const x = (r.left - sr.left) / u;
          const y = (r.top - sr.top) / u;
          const w = canvas.width;
          const home = windows.find(([wx, wy, ww, wh]) => x >= wx - 0.01 && y >= wy - 1.01 && x + w <= wx + ww + 0.01 && y < wy + wh);
          if (!home && outside++ < 6) findings.push({ state: 'battle/fight-all', issue: 'text outside game window', a: `"${canvas.dataset.text}" x ${x.toFixed(1)} w ${w}`, b: set.join(', ') });
        }
      }
    }
    states += 1;
    battle.openConfirm();
    for (let i = 0; i < 2; i++) {
      battle.confirmIndex = i;
      battle.renderConfirm();
      if (await visit(`battle/confirm/row${i}`)) return finish({ states, runs, findings, stopped: true });
    }
    battle.openParty(false);
    const slots = Math.min(6, battle.team?.length ?? 0);
    for (let i = 0; i <= slots; i++) {
      battle.partyIndex = i;
      battle.renderParty();
      if (await visit(`battle/party/row${i}`)) return finish({ states, runs, findings, stopped: true });
    }
    battle.closeMenus();
    battle.menuState = 'wait';
    battle.thinking(true);
    if (await visit('battle/thinking/row0')) return finish({ states, runs, findings, stopped: true });
    battle.fallback();
    if (await visit('battle/fallback/row0')) return finish({ states, runs, findings, stopped: true });
    battle.fallback('daily_budget');
    if (await visit('battle/fallback-budget/row0')) return finish({ states, runs, findings, stopped: true });
    battle.thinking(false);
    for (const key of ['foe', 'me']) {
      const active = battle.sides[key === 'me' ? battle.mySide : battle.foeSide].active;
      if (active && ns.sendOutEnabled?.()) await battle.sendOut(key, active);
      if (await visit(`battle/sendout-${key}/row0`)) return finish({ states, runs, findings, stopped: true });
    }
    const boxes = battle.boxes;
    for (const status of ['slp', 'psn', 'brn', 'par', 'frz', 'tox', '']) {
      for (const key of ['me', 'foe']) {
        const mon = battle.sides[key === 'me' ? battle.mySide : battle.foeSide].active;
        if (mon) mon.status = status;
        battle.renderBox(key);
      }
      // foe bar frame end sits at x 37-39 of the label slot, the player keeps its HP label there
      const cap = document.createElement('canvas');
      cap.width = 8;
      cap.height = 8;
      const end = ns.assets.image(status ? 'hbFrameEnd' : 'hpbar');
      if (end) cap.getContext('2d')!.drawImage(end, status ? 0 : 8, 0, 8, 8, 0, 0, 8, 8);
      const want = [...cap.getContext('2d')!.getImageData(6, 3, 1, 1).data].join();
      const got = [...boxes.foe.getContext('2d').getImageData(status ? 38 : 30, 19, 1, 1).data].join();
      if (end && want !== got) findings.push({ state: `battle/status-${status || 'none'}`, issue: 'hp bar cap missing', a: `foe pixel ${got}`, b: `want ${want}` });
      if (await visit(`battle/status-${status || 'none'}/row0`)) return finish({ states, runs, findings, stopped: true });
    }
    battle.openActions();
    return finish({ states, runs, findings, stopped: false });
  }
  const looks = [{ cls: 'may', palette: [null, '#e05050', null] }, undefined, { cls: 5 }, { cls: 'nope' }, { cls: 'twins', palette: ['#40a0f0'] }];
  const peers = [1, 2, 3, 4, 5].map((n) => ({ id: `g${n}`, name: WIDE.slice(n - 1), status: n % 2 ? 'looking' : 'idle', address: '192.168.100.100:41852', source: 'mdns', trainer: looks[n - 1] }));
  const scenes: [string, () => void][] = [
    ['offline', () => { app.link.conn = 'offline'; app.prompt = null; app.screen = 'offline'; }],
    ['lobby', () => { app.link.conn = 'online'; app.welcomed = true; app.trainer = { id: 'me', name: WIDE }; app.peers = peers; app.screen = 'lobby'; app.lobbyFocus = 'menu'; }],
    ['lobby-peers', () => { app.lobbyFocus = 'peers'; }],
    ['lobby-waiting', () => { app.lobbyFocus = 'menu'; app.peers = []; app.looking = true; app.notice = ''; }],
    ['lobby-claude-origin', () => { app.notice = ''; app.onMessage({ type: 'error', re: 'start_cpu', code: 'claude_origin', message: 'Claude battles start only from the Claude app page' }); }],
    ['lobby-searching', () => { app.setNotice(`Looking for trainers${ns.WAIT}`); app.peers = peers; }],
    ['lobby-foe', () => { app.notice = ''; app.panel = 'foe'; app.lobbyFocus = 'peers'; app.claude = { available: true, reason: '', models: ['haiku', 'sonnet', 'opus', 'fable'], defaultModel: 'haiku' }; }],
    ['lobby-foe-off', () => { app.claude = ns.parseClaude(null); }],
    ['lobby-options', () => { app.panel = 'options'; app.panelIndex = 0; app.lobbyFocus = 'peers'; }],
    ['lobby-music', () => { app.panel = 'music'; app.panelIndex = 0; }],
    ['lobby-bgm', () => { app.panel = null; app.lobbyFocus = 'menu'; const list = ns.trackList(); app.music.setPick(list[list.length - 1]); app.music.sync(app); }],
    ['incoming', () => { app.music.setPick(null); app.panel = null; app.lobbyFocus = 'menu'; app.prompt = { kind: 'incoming', challenge: { challengeId: 'g', from: { id: 'g1', name: WIDE }, expiresAt: Date.now() + 60000 } }; }],
    ['outgoing', () => { app.outgoing = { challengeId: 'g', peer: { id: 'g1', name: WIDE } }; app.prompt = { kind: 'outgoing' }; }],
    ['result', () => { app.prompt = null; app.outgoing = null; app.result = { result: 'loss', reason: 'You forfeited.', turns: 188, mode: 'lan', opponent: WIDE, peerId: 'g1', difficulty: 'normal' }; app.screen = 'result'; }],
    ['result-claude', () => { cinnamon.settings.set('showClaudeStats', true); app.result = { ...app.result, opponent: 'CLAUDE', kind: 'claude', model: 'sonnet', stats: ns.claudeStats({ costUsd: 0.123456, decisions: 188, handedOver: true }), look: ns.CLAUDE_LOOK }; }],
  ];
  for (const [name, setup] of scenes) {
    setup();
    app.render();
    if (await walkMenus(name)) return finish({ states, runs, findings, stopped: true });
  }
  return finish({ states, runs, findings, stopped: false });
}

ns.guard = { walk, pixelAudit, check: (state: string) => { const out: Finding[] = []; check(state, ns.app.screenEl, out); return out; } };
cinnamon.onDispose(() => delete ns.guard);
