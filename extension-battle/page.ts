declare const cinnamon: {
  settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    onChange(fn: (all: Record<string, unknown>) => void): void;
  };
  onDispose(fn: () => void): void;
};
type Screen = 'offline' | 'lobby' | 'battle' | 'result';
type Msg = Record<string, any>;
type MenuItem = { label: string; disabled?: boolean; pick: () => void; cls?: string; decorate?: (row: HTMLElement) => void };
type Action = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';

const ns = (window as any).__pkb;
const { Battle, NAME_MAX, POKEMON, rt, report, timers, cleanups, listen, el, place, clamp, upper, pixelArt,
  CLOSE_ART, SoundSettings, Link, savedName, cleanName, Menu, WEATHER_LABEL, assets, canvasEl, frameBox,
  SettingsRow, WAIT, writeBattleSound, peSound, playerLook, cleanLook, wireLook, parseClaude, claudeModel,
  claudeStats, CLAUDE_LOOK, parsePeerAddress } = ns;
const SPEAKER = ['...x....', '..xx..x.', 'xxxx.x.x', 'xxxx.x.x', 'xxxx.x.x', '..xx..x.', '...x....'];
const SPEAKER_OFF = ['...x....', '..xx....', 'xxxx.x.x', 'xxxx..x.', 'xxxx.x.x', '..xx....', '...x....'];
type FloatState = { x: number; y: number; w: number; h: number; dock: 'left' | 'right' | null; min: boolean };
type Metrics = { dpr: number; bu: number; bw: number; titleH: number; top: number; minW: number; minH: number; maxW: number; maxH: number; snap: (v: number) => number };

type Peer = { id: string; name: string; status: string; address: string; source: string; trainer?: unknown };
type Incoming = { challengeId: string; from: { id: string; name: string }; expiresAt: number };
type Outgoing = { challengeId: string; peer: { id: string; name: string } };
type Prompt = { kind: 'incoming'; challenge: Incoming } | { kind: 'outgoing' } | { kind: 'input'; field: 'name' | 'ip' } | null;
type ResultInfo = { result: string; reason: string; turns: number; mode: 'cpu' | 'lan'; opponent: string; peerId: string | null; difficulty: string; kind?: string; model?: string; stats?: string; look?: unknown };

class App {
  open = false;
  screen: Screen = 'offline';
  readonly assets = assets;
  readonly sfx = new SoundSettings();
  readonly link: Link;
  battle: Battle | null = null;
  result: ResultInfo | null = null;
  trainer = { id: '', name: '' };
  status = 'away';
  looking = false;
  lan = { enabled: false, discovery: 'off' };
  peers: Peer[] = [];
  incoming = new Map<string, Incoming>();
  outgoing: Outgoing | null = null;
  notice = '';
  noticeAt = 0;
  prompt: Prompt = null;
  lobbyFocus: 'menu' | 'peers' = 'menu';
  lobbyIndex = 0;
  peerIndex = 0;
  lastOpponent: { mode: 'cpu' | 'lan'; peerId: string | null; name: string; difficulty: string; kind: string; model: string; look: unknown } | null = null;
  claude = parseClaude(null);
  panel: 'foe' | 'options' | 'music' | null = null;
  panelIndex = 0;
  panelHints: string[] = [];
  readonly music = new ns.BattleMusic();
  musicOutcome: 'battle' | 'victory' | 'silent' = 'silent';
  welcomed = false;

  readonly root = el('div', 'pkb-overlay');
  private readonly frame = el('div', 'pkb-frame');
  private readonly titleEl = el('div', 'pkb-titlebar');
  private readonly grip = el('div', 'pkb-grip');
  private float: FloatState | null = null;
  private dragging = false;
  private readonly titleLabel = el('div', 'pkb-tlabel');
  private readonly muteBtn = el('button', 'pkb-tbtn');
  private readonly tbtns = el('div', 'pkb-tbtns');
  private lastEscCloses: boolean | null = null;
  private readonly dockStyle = el('style');
  readonly screenEl = el('div', 'pkb-screen');
  private readonly layer = el('div', 'pkb-layer');
  private readonly bar = el('div', 'pkb-bar-ui');
  private readonly barLeft = el('span');
  private readonly barRight = el('span', 'pkb-hints');
  private readonly closeBtn = el('button', 'pkb-close');
  readonly launcher = el('button', 'pkb-launch');
  private readonly badge = el('span', 'pkb-launch-badge');
  launcherArt!: { sync(): void; box: { w: number; h: number } };
  private prevFocus: Element | null = null;
  private menus: Menu[] = [];
  private input: HTMLInputElement | null = null;
  private clock = 0;

  constructor() {
    this.link = new Link(
      (msg) => this.onMessage(msg),
      () => this.onConn(),
      () => this.open || !!this.battle || this.looking || this.incoming.size > 0 || !!this.outgoing,
    );
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Pokemon battle');
    this.screenEl.append(this.layer);
    this.frame.tabIndex = -1;
    this.frame.append(this.titleEl, this.screenEl, this.grip);
    this.buildTitle();
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close battle screen');
    this.closeBtn.addEventListener('click', () => this.close());
    const right = el('div', 'pkb-bar-right');
    right.append(this.barRight, this.closeBtn);
    this.bar.append(this.barLeft, right);
    this.root.append(this.frame, this.bar);
    this.launcher.type = 'button';
    this.launcher.setAttribute('aria-label', 'Pokemon battle (Ctrl+Shift+B)');
    this.launcher.title = 'Pokemon battle  (Ctrl+Shift+B)';
    this.badge.hidden = true;
    this.launcher.append(this.badge);
    this.launcher.addEventListener('click', () => this.toggle());
    document.body.append(this.root, this.launcher);
    this.launcherArt = new ns.LauncherArt(this.launcher);
  }

  start(): void {
    this.assets.load(this.root);
    this.placeLauncher();
    this.link.start();
    this.clock = window.setInterval(() => this.tick(), 500);
  }

  dispose(): void {
    clearInterval(this.clock);
    this.battle?.dispose();
    this.link.dispose();
    this.assets.dispose();
    if (this.open) this.restoreFocus();
    this.root.remove();
    this.launcher.remove();
    this.dockStyle.remove();
  }

  private tick(): void {
    try {
      this.placeLauncher();
      if (!this.open) return;
      if ((this.screen === 'battle' && this.battle?.clock) || (!this.floating && this.lastEscCloses !== this.escCloses())) this.renderBar();
      if (this.floating && this.floatState().dock) this.layout();
      if (this.prompt?.kind === 'incoming') this.renderPromptText();
      for (const [id, c] of this.incoming) if (c.expiresAt < Date.now() - 5000) this.incoming.delete(id);
    } catch (err) {
      report(err);
    }
  }

  placeLauncher(): void {
    ns.placeLauncher(this);
  }

  updateBadge(): void {
    const alert = !this.open && (this.incoming.size > 0 || !!this.battle?.needsInput);
    this.badge.hidden = !alert;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(quiet = false): void {
    if (this.open || rt.disposed) return;
    this.open = true;
    markClosed(false);
    this.prevFocus = quiet ? null : document.activeElement;
    this.music.prepare();
    this.root.hidden = false;
    this.assets.load(this.root);
    this.layout();
    if (this.link.conn === 'offline') this.link.retryNow();
    this.render();
    this.music.sync(this);
    if (!quiet) this.focusTarget().focus({ preventScroll: true });
    this.updateBadge();
  }

  get floating(): boolean {
    return cinnamon.settings.get('window') === 'floating';
  }

  focusTarget(): HTMLElement {
    return this.floating ? this.frame : this.root;
  }

  owns(target: EventTarget | null): boolean {
    if (!this.open) return false;
    if (!this.floating) return true;
    return target instanceof Node && this.root.contains(target);
  }

  private buildTitle(): void {
    const minimize = el('button', 'pkb-tbtn');
    minimize.type = 'button';
    minimize.setAttribute('aria-label', 'Minimize battle window');
    minimize.append(pixelArt(['.....', '.....', '.....', 'xxxxx', 'xxxxx'], { x: 'currentColor' }));
    minimize.addEventListener('click', () => {
      const min = !this.floatState().min;
      this.setFloat({ min });
      this.music.sync(this, 300);
    });
    const close = el('button', 'pkb-tbtn');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close battle window');
    close.append(pixelArt(CLOSE_ART, { x: 'currentColor' }));
    close.addEventListener('click', () => this.close());
    this.titleLabel.append(assets.text(`${POKEMON} BATTLE`, { color: 'white' }));
    this.muteBtn.type = 'button';
    // a press on the waiting speaker is the gesture that starts the music, not a mute
    let startsMusic = false;
    this.muteBtn.addEventListener('pointerdown', () => (startsMusic = this.muteBtn.classList.contains('is-waiting')));
    this.muteBtn.addEventListener('click', () => {
      if (startsMusic) return void (startsMusic = false);
      const muted = !this.sfx.sound.windows.battle.muted;
      writeBattleSound({ muted });
      if (!muted) peSound('SE_SELECT');
    });
    this.sfx.onChange = () => {
      this.syncMute();
      this.music.sync(this);
      const row = document.querySelector<HTMLElement>('[data-pkb-row]');
      if (row) settingsRow.sync(row);
    };
    this.syncMute();
    this.tbtns.append(this.muteBtn, minimize, close);
    this.titleEl.append(this.titleLabel, this.tbtns);
    this.dockStyle.setAttribute('data-pkb-dock', '');
    this.titleEl.addEventListener('pointerdown', (event: PointerEvent) => this.drag(event, 'move'));
    this.grip.addEventListener('pointerdown', (event: PointerEvent) => this.drag(event, 'size'));
  }

  private syncMute(): void {
    const muted = this.sfx.sound.windows.battle.muted;
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute battle sound' : 'Mute battle sound');
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.muteBtn.replaceChildren(pixelArt(muted ? SPEAKER_OFF : SPEAKER, { x: 'currentColor' }));
    const waiting = !muted && this.music.waiting();
    this.muteBtn.classList.toggle('is-waiting', waiting);
    if (waiting) this.muteBtn.setAttribute('aria-label', 'Battle sound waits for a click to start');
  }

  floatState(): FloatState {
    if (this.float) return this.float;
    const raw = cinnamon.settings.get('float') as (Partial<FloatState> & { s?: number }) | null;
    const m = this.metrics();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const legacy = Number.isInteger(raw?.s) && Number(raw!.s) > 0 ? Number(raw!.s) : Math.max(1, Math.round(m.dpr * 1.5));
    this.float = {
      x: num(raw?.x) ?? 24,
      y: Math.max(m.top, num(raw?.y) ?? 56),
      w: num(raw?.w) ?? 2 * m.bw + (240 * legacy) / m.dpr,
      h: num(raw?.h) ?? m.titleH + 3 * m.bw + (160 * legacy) / m.dpr,
      dock: !raw ? 'right' : raw.dock === 'left' || raw.dock === 'right' ? raw.dock : null,
      min: !!raw?.min,
    };
    return this.float;
  }

  private metrics(): Metrics {
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const bu = Math.max(1, Math.round(dpr * 1.2)) / dpr;
    const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pe-b'));
    const bw = Math.max(1, Math.round((token > 0 ? token : 1.375) * dpr)) / dpr;
    const titleH = 20 * bu;
    const sMin = Math.max(1, Math.round(dpr));
    const minW = 2 * bw + (240 * sMin) / dpr;
    const minH = titleH + 3 * bw + (160 * sMin) / dpr;
    const top = this.topInset();
    return { dpr, bu, bw, titleH, top, minW, minH, maxW: Math.max(minW, innerWidth - 16), maxH: Math.max(minH, innerHeight - top - 8), snap };
  }

  private topInset(): number {
    let bottom = 0;
    for (const bar of document.querySelectorAll('.df-titlebar, [data-perf-region="header"]')) {
      const rect = bar.getBoundingClientRect();
      if (rect.height > 0 && rect.top <= 1 && rect.bottom < innerHeight / 3) bottom = Math.max(bottom, rect.bottom);
    }
    return Math.ceil(bottom);
  }

  private sidebarEdge(): number {
    const sidebar = document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect();
    return sidebar && sidebar.width > 40 ? sidebar.right : 0;
  }

  private reserve(side: 'left' | 'right' | null, width: number): void {
    const css = side ? `.dframe-pane-host { margin-${side}: ${Math.ceil(width)}px !important; }` : '';
    if (this.dockStyle.textContent !== css) this.dockStyle.textContent = css;
    if (css && !this.dockStyle.isConnected) document.head.append(this.dockStyle);
    if (!css) this.dockStyle.remove();
  }

  resetFloat(): void {
    if (this.dragging) return;
    this.float = null;
    if (this.open && this.floating) this.layout();
  }

  private setFloat(patch: Partial<FloatState>, save = true): void {
    this.float = { ...this.floatState(), ...patch };
    if (save) cinnamon.settings.set('float', this.float);
    this.layout();
  }

  private drag(event: PointerEvent, kind: 'move' | 'size'): void {
    if (!this.floating || event.button !== 0 || (event.target as Element).closest('.pkb-tbtn')) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, st: { ...this.floatState() }, rect: this.frame.getBoundingClientRect() };
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    this.dragging = true;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (kind === 'move') {
        this.setFloat({ x: start.rect.left + dx, y: start.rect.top + dy, dock: null }, false);
        return;
      }
      const m = this.metrics();
      const w = clamp(start.rect.width + (start.st.dock === 'right' ? -dx : dx), m.minW, m.maxW);
      const h = start.st.min ? start.st.h : clamp(start.rect.height + dy, m.minH, m.maxH);
      this.setFloat({ w, h }, false);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      this.dragging = false;
      const rect = this.frame.getBoundingClientRect();
      if (kind === 'size') {
        this.setFloat({});
        return;
      }
      const edge = this.sidebarEdge();
      const dock = rect.left < edge + 32 ? 'left' : rect.right > innerWidth - 32 ? 'right' : null;
      this.setFloat({ dock, x: rect.left, y: rect.top });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.input = null;
    if (this.prompt?.kind === 'input') this.prompt = null;
    this.root.hidden = true;
    markClosed(true);
    this.music.sync(this);
    this.reserve(null, 0);
    this.restoreFocus();
    this.updateBadge();
  }

  private restoreFocus(): void {
    const prev = this.prevFocus as HTMLElement | null;
    this.prevFocus = null;
    try {
      if (prev?.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    } catch {}
  }

  layout(): void {
    if (!this.open) return;
    const m = this.metrics();
    const { dpr, snap, bu, bw, titleH } = m;
    const barH = 21 * bu;
    const floating = this.floating;
    const st = this.floatState();
    this.root.classList.toggle('is-floating', floating);
    this.root.classList.toggle('is-min', floating && st.min);
    this.root.classList.toggle('is-dock-right', floating && st.dock === 'right');
    this.root.style.setProperty('--bu', `${bu}px`);
    this.root.style.setProperty('--pkb-bw', `${bw}px`);
    this.root.style.setProperty('--pkb-th', `${titleH}px`);
    if (assets.url('frame')) this.root.style.setProperty('--pkb-frame', `url("${assets.url('frame')}")`);
    this.screenEl.hidden = floating && st.min;
    this.bar.hidden = floating;
    const slot = floating ? this.tbtns : this.closeBtn.parentElement!;
    if (this.muteBtn.parentElement !== slot) slot.insertBefore(this.muteBtn, floating ? slot.firstChild : this.closeBtn);
    Object.assign(this.closeBtn.style, { width: `${barH}px`, height: `${barH}px` });
    if (!this.closeBtn.firstChild) this.closeBtn.append(pixelArt(CLOSE_ART, { x: '#f8f8f8' }));
    const closeArt = this.closeBtn.firstChild as SVGSVGElement;
    closeArt.style.setProperty('--u', `${Math.max(1, Math.floor((14 * dpr) / 5)) / dpr}px`);
    if (!floating) {
      const availW = innerWidth - 48;
      const availH = innerHeight - 36 - barH - 10;
      const u = Math.max(1, Math.floor(Math.min((availW * dpr) / 246, (availH * dpr) / 166))) / dpr;
      const left = snap((innerWidth - 246 * u) / 2);
      const top = snap(Math.max(8, (innerHeight - 166 * u - barH - 10) / 2));
      this.reserve(null, 0);
      this.root.style.setProperty('--u', `${u}px`);
      Object.assign(this.frame.style, { left: `${left}px`, top: `${top}px`, width: '', height: '' });
      Object.assign(this.screenEl.style, { left: '', top: '' });
      Object.assign(this.bar.style, { left: `${left}px`, top: `${snap(top + 166 * u + 10)}px`, width: `${246 * u}px`, height: `${barH}px` });
      return;
    }
    let w = clamp(st.w, m.minW, m.maxW);
    let h = clamp(st.h, m.minH, m.maxH);
    let left = st.dock === 'left' ? this.sidebarEdge() + 8 : st.dock === 'right' ? innerWidth - w - 8 : st.x;
    let top = Math.max(m.top, st.y);
    const composer = document.querySelector('[data-cds-part="composer-card"]')?.getBoundingClientRect();
    if (st.dock && !st.min && composer?.width && left < composer.right && left + w > composer.left && top + h > composer.top - 8) {
      const room = composer.top - 8 - m.top;
      if (room >= h) top = composer.top - 8 - h;
      else {
        top = m.top;
        h = Math.max(m.minH, composer.top - 8 - m.top);
      }
    }
    w = snap(w);
    h = snap(h);
    left = snap(clamp(left, 0, Math.max(0, innerWidth - w)));
    top = snap(clamp(top, m.top, Math.max(m.top, innerHeight - titleH - 2 * bw)));
    const bodyW = w - 2 * bw;
    const bodyH = h - titleH - 3 * bw;
    const u = Math.max(1, Math.floor(Math.min((bodyW * dpr) / 240, (bodyH * dpr) / 160))) / dpr;
    this.root.style.setProperty('--u', `${u}px`);
    this.reserve(st.dock && !st.min ? st.dock : null, w + 16);
    Object.assign(this.frame.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${st.min ? titleH + 2 * bw : h}px` });
    Object.assign(this.screenEl.style, { left: `${snap((bodyW - 240 * u) / 2)}px`, top: `${titleH + bw + snap((bodyH - 160 * u) / 2)}px` });
  }

  onConn(): void {
    if (this.link.conn !== 'online') {
      this.welcomed = false;
      if (this.link.conn === 'offline' && this.screen !== 'result') this.setScreen('offline');
    }
    this.render();
  }

  setScreen(screen: Screen): void {
    if (this.screen === screen) return;
    this.screen = screen;
    this.prompt = this.prompt?.kind === 'incoming' || this.prompt?.kind === 'outgoing' ? this.prompt : null;
  }

  setNotice(text: string): void {
    this.notice = text;
    this.noticeAt = Date.now();
  }

  onMessage(msg: Msg): void {
    switch (msg.type) {
      case 'welcome': {
        this.welcomed = true;
        this.trainer = { id: String(msg.trainer?.id ?? ''), name: String(msg.trainer?.name ?? '') };
        this.trainerLooks = msg.trainer && 'cls' in msg.trainer;
        this.claude = parseClaude(msg);
        this.status = String(msg.status ?? 'idle');
        this.looking = !!msg.looking;
        this.lan = { enabled: !!msg.lan?.enabled, discovery: String(msg.lan?.discovery ?? 'off') };
        this.syncName();
        this.outgoing = null;
        this.incoming.clear();
        if (this.prompt?.kind !== 'input') this.prompt = null;
        if (this.status !== 'battling' && this.battle && !this.battle.ended) {
          this.battle.dispose();
          this.battle = null;
          this.musicOutcome = 'silent';
        }
        if (this.screen === 'offline' || (this.screen === 'battle' && !this.battle)) this.setScreen('lobby');
        break;
      }
      case 'lobby':
        this.peers = Array.isArray(msg.peers) ? (msg.peers as Peer[]).filter((p) => p && typeof p.id === 'string') : [];
        if (msg.you) {
          this.trainer = { id: String(msg.you.id ?? this.trainer.id), name: String(msg.you.name ?? this.trainer.name) };
          this.status = String(msg.you.status ?? this.status);
        }
        break;
      case 'status':
        this.status = String(msg.status ?? this.status);
        this.looking = !!msg.looking;
        break;
      case 'trainer':
        this.trainer = { id: String(msg.trainer?.id ?? this.trainer.id), name: String(msg.trainer?.name ?? this.trainer.name) };
        break;
      case 'peer_added':
        this.setNotice(`Added ${String(msg.address)}.\nWaiting for it to answer${WAIT}`);
        break;
      case 'challenge_sent':
        this.outgoing = { challengeId: String(msg.challengeId), peer: { id: String(msg.peer?.id ?? ''), name: String(msg.peer?.name ?? 'Trainer') } };
        if (!this.prompt || this.prompt.kind !== 'incoming') this.prompt = { kind: 'outgoing' };
        break;
      case 'challenge_received': {
        const c: Incoming = { challengeId: String(msg.challengeId), from: { id: String(msg.from?.id ?? ''), name: String(msg.from?.name ?? 'Trainer') }, expiresAt: Date.now() + Number(msg.expiresInSeconds ?? 60) * 1000 };
        this.incoming.set(c.challengeId, c);
        this.nextPrompt();
        break;
      }
      case 'challenge_update':
        this.challengeUpdate(msg);
        break;
      case 'battle_start':
        this.battleStart(msg);
        break;
      case 'battle':
        if (this.battle?.id === msg.battleId && msg.balls && typeof msg.balls === 'object')
          for (const [ident, ball] of Object.entries(msg.balls)) this.battle.balls.set(ident, String(ball));
        if (this.battle?.id === msg.battleId && Array.isArray(msg.lines)) this.battle.push(msg.lines);
        break;
      case 'request':
        if (this.battle?.id === msg.battleId) this.battle.setRequest(msg);
        break;
      case 'choice_error':
        if (this.battle?.id === msg.battleId) this.battle.choiceError(String(msg.message ?? ''));
        break;
      case 'timer':
        if (this.battle?.id === msg.battleId) this.battle.setTimer(msg);
        break;
      case 'battle_end':
        if (this.battle?.id === msg.battleId) this.battle.end(msg);
        break;
      case 'opponent_thinking':
        if (this.battle?.id === msg.battleId) this.battle.thinking(!!msg.thinking);
        return;
      case 'opponent_fallback':
        if (this.battle?.id === msg.battleId) this.battle.fallback(String(msg.reason ?? ''));
        return;
      case 'error':
        this.onError(msg);
        break;
      default:
        return;
    }
    this.updateBadge();
    if (this.open && msg.type !== 'battle' && msg.type !== 'request' && msg.type !== 'timer' && msg.type !== 'choice_error' && msg.type !== 'battle_end') this.render();
  }

  private onError(msg: Msg): void {
    const re = String(msg.re ?? '');
    const code = String(msg.code ?? '');
    if (code === 'rate_limited' && re === 'choose' && this.battle?.resendChoice()) return;
    if (['choose', 'forfeit'].includes(re) && ['stale_request', 'not_your_turn', 'battle_over', 'no_battle'].includes(code)) return;
    if (code === 'unknown_challenge' && re === 'cancel_challenge') {
      this.outgoing = null;
      if (this.prompt?.kind === 'outgoing') this.prompt = null;
      this.nextPrompt();
    }
    if (code === 'unknown_challenge' && re === 'respond_challenge' && this.prompt?.kind === 'incoming') {
      this.incoming.delete(this.prompt.challenge.challengeId);
      this.prompt = null;
      this.nextPrompt();
    }
    const text = code === 'claude_origin' ? ns.CLAUDE_ORIGIN : String(msg.message ?? msg.code ?? 'Something went wrong.');
    this.setNotice(text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith('.') ? '' : '.'));
    peSound('SE_FAILURE');
  }

  private challengeUpdate(msg: Msg): void {
    const id = msg.challengeId === null ? null : String(msg.challengeId);
    const state = String(msg.state ?? '');
    const reason = String(msg.reason ?? '');
    const incoming = id ? this.incoming.get(id) : undefined;
    const outgoing = id && this.outgoing?.challengeId === id ? this.outgoing : null;
    if (incoming) this.incoming.delete(id!);
    if (outgoing) this.outgoing = null;
    const who = upper(outgoing?.peer.name ?? incoming?.from.name ?? 'The trainer');
    let text = '';
    if (state === 'accepted') text = outgoing ? `${who} accepted!\nGet ready${WAIT}` : `Challenge accepted!\nGet ready${WAIT}`;
    else if (state === 'declined') text = reason === 'busy' ? `${who} is busy right now.` : reason === 'away' ? `${who} isn't at the battle screen.` : reason === 'expired' ? `${who} didn't answer in time.` : `${who} declined the battle.`;
    else if (state === 'cancelled') text = outgoing ? (reason === 'accepted_other' ? '' : 'Challenge cancelled.') : incoming ? `${who} withdrew the challenge.` : '';
    else if (state === 'expired') text = 'The challenge expired.';
    else if (state === 'failed') text = id === null ? "The battle didn't start." : reason === 'unreachable' ? `Couldn't reach ${who}.` : `Lost the link to ${who}.`;
    if (text) this.setNotice(text);
    if (this.prompt?.kind === 'incoming' && this.prompt.challenge.challengeId === id) this.prompt = null;
    if (this.prompt?.kind === 'outgoing' && !this.outgoing) this.prompt = null;
    this.nextPrompt();
  }

  private nextPrompt(): void {
    if (this.prompt?.kind === 'input') return;
    if (this.prompt?.kind === 'incoming' && this.incoming.has(this.prompt.challenge.challengeId)) return;
    const first = [...this.incoming.values()][0];
    if (first && !this.battle) this.prompt = { kind: 'incoming', challenge: first };
    else if (this.outgoing) this.prompt = { kind: 'outgoing' };
    else if (this.prompt?.kind !== 'input') this.prompt = null;
  }

  private battleStart(msg: Msg): void {
    this.battle?.dispose();
    const battle = new Battle(this, msg);
    this.battle = battle;
    this.musicOutcome = 'battle';
    this.result = null;
    if (this.prompt?.kind !== 'input') this.prompt = null;
    this.outgoing = null;
    const kind = String(msg.opponent?.kind ?? 'cpu');
    const look = cleanLook(msg.opponent) ?? (kind === 'claude' ? CLAUDE_LOOK : null);
    this.lastOpponent = { mode: battle.mode, peerId: msg.opponent?.id ? String(msg.opponent.id) : null, name: String(msg.opponent?.name ?? 'Trainer'), difficulty: String(msg.opponent?.difficulty ?? 'smart'), kind, model: String(msg.opponent?.model ?? ''), look };
    this.setScreen('battle');
    this.screen = 'battle';
    this.render();
  }

  battleOver(battle: Battle, end: Msg): void {
    if (this.battle !== battle) return;
    if (!battle.sawWin) this.musicOutcome = 'silent';
    this.result = {
      result: String(end.result ?? 'aborted'),
      reason: String(end.reason ?? ''),
      turns: Number(end.turns ?? battle.turn) || 0,
      mode: battle.mode,
      opponent: battle.foeName,
      peerId: this.lastOpponent?.peerId ?? null,
      difficulty: this.lastOpponent?.difficulty ?? 'smart',
      kind: this.lastOpponent?.kind,
      model: this.lastOpponent?.kind === 'claude' ? this.lastOpponent.model : '',
      stats: this.lastOpponent?.kind === 'claude' ? claudeStats(end.opponentStats) : '',
      look: this.lastOpponent?.look,
    };
    battle.dispose();
    this.battle = null;
    this.setScreen('result');
    this.render();
    this.updateBadge();
  }

  renderBar(): void {
    if (!this.open) return;
    const conn = this.link.conn;
    const parts: string[] = [];
    if (this.screen === 'battle' && this.battle) {
      parts.push(`VS ${upper(this.battle.foeName)}`);
      if (this.battle.turn) parts.push(`TURN ${this.battle.turn}`);
      if (this.battle.weather !== 'none' && WEATHER_LABEL[this.battle.weather]) parts.push(WEATHER_LABEL[this.battle.weather]);
      const clock = this.battle.clock;
      if (clock) parts.push(`${clock.label} ${Math.floor(clock.left / 60)}:${String(clock.left % 60).padStart(2, '0')}`);
    } else {
      parts.push(conn === 'online' ? 'HELPER ONLINE' : conn === 'connecting' ? `CONNECTING${WAIT}` : 'HELPER OFFLINE');
      if (conn === 'online' && this.trainer.name) parts.push(`TRAINER ${upper(this.trainer.name)}`);
    }
    if (this.floating) {
      const inBattle = this.screen === 'battle' && !!this.battle;
      this.titleLabel.replaceChildren(assets.text(inBattle ? parts.join('  ') : `${POKEMON} BATTLE`, { font: inBattle ? 'small' : 'normal', color: 'white' }));
      return;
    }
    const dot = el('i', 'pkb-bar-dot');
    dot.dataset.on = conn;
    this.barLeft.replaceChildren(dot, assets.text(parts.join('   '), { font: 'small', color: 'white' }));
    const keycap = (label: string | SVGSVGElement) => {
      const cap = el('span', 'pkb-key');
      cap.append(typeof label === 'string' ? assets.text(label, { font: 'small', color: 'white' }) : label);
      return cap;
    };
    const hint = (label: string) => assets.text(label, { font: 'small', color: 'white' });
    const arrows = pixelArt(['..x..', '.xxx.', 'x.x.x', '..x..', 'x.x.x', '.xxx.', '..x..'], { x: '#ffffff' });
    this.lastEscCloses = this.escCloses();
    this.barRight.replaceChildren(keycap(arrows), hint('MOVE'), keycap('ENTER'), hint('OK'), keycap('ESC'), hint(this.lastEscCloses ? 'CLOSE' : 'BACK'));
  }

  render(): void {
    if (!this.open) return;
    this.music.sync(this, this.musicOutcome === 'silent' ? 1000 : 500);
    try {
      this.renderBar();
      this.menus = [];
      this.input = null;
      if (this.screen === 'battle' && this.battle) {
        this.layer.replaceChildren(this.battle.root);
        return;
      }
      if (this.screen === 'battle' && !this.battle) this.screen = this.link.conn === 'online' ? 'lobby' : 'offline';
      const view = el('div', 'pkb-layer pkb-bg');
      if (this.screen === 'offline') this.renderOffline(view);
      else if (this.screen === 'result') this.renderResult(view);
      else this.renderLobby(view);
      this.layer.replaceChildren(view);
      if (this.input) {
        const input = this.input;
        requestAnimationFrame(() => {
          if (input.isConnected) input.focus({ preventScroll: true });
        });
      } else if (this.open && !this.floating && !this.root.contains(document.activeElement)) {
        this.root.focus({ preventScroll: true });
      }
    } catch (err) {
      report(err);
    }
  }

  private txt(text: string, x: number, y: number, opts: Record<string, unknown> = {}): HTMLCanvasElement {
    return place(assets.text(text, { color: 'std', ...opts }), x, y);
  }

  private msgBox(view: HTMLElement, x: number, y: number, w: number, h: number, text: string): HTMLCanvasElement {
    const canvas = place(canvasEl(w, h, 'pkb-t'), x, y + 1);
    canvas.dataset.boxW = String(w);
    view.append(frameBox(x, y, w, h), canvas);
    this.paintMsg(canvas, text, w, h);
    return canvas;
  }

  private paintMsg(canvas: HTMLCanvasElement, text: string, w = Number(canvas.dataset.boxW) || 224, h = 32): void {
    assets.paint(canvas, assets.wrap(text, 'normal', w).slice(0, Math.max(1, Math.floor(h / 16))).join('\n'), { width: w, color: 'std' });
  }

  private menuBox(view: HTMLElement, x: number, y: number, w: number, h: number): HTMLElement {
    const box = place(el('div', 'pkb-menubox'), x, y, w, h);
    view.append(frameBox(x, y, w, h), box);
    return box;
  }

  private addMenu(box: HTMLElement, items: MenuItem[], opts: { cols?: number; light?: boolean; onMove?: (i: number) => void; index?: number; focused?: boolean } = {}): Menu {
    const menu = new Menu(box, items, { cols: opts.cols, light: opts.light, onMove: opts.onMove });
    menu.index = opts.index ?? 0;
    menu.focused = opts.focused ?? true;
    menu.render();
    this.menus.push(menu);
    return menu;
  }

  private renderOffline(view: HTMLElement): void {
    ns.renderOffline(this, view);
  }

  private renderResult(view: HTMLElement): void {
    ns.renderResult(this, view);
  }

  private toLobby(): void {
    this.result = null;
    this.setScreen(this.link.conn === 'online' ? 'lobby' : 'offline');
    this.render();
  }

  private rematch(): void {
    const r = this.result;
    if (!r) return this.toLobby();
    if (r.mode === 'cpu') {
      this.startCpu(r.difficulty, r.kind === 'claude' ? 'claude' : 'cpu');
      return;
    }
    const peer = this.peers.find((p) => p.id === r.peerId);
    if (!peer || (peer.status !== 'idle' && peer.status !== 'looking')) {
      this.setNotice(`${upper(r.opponent)} isn't available.`);
      this.toLobby();
      return;
    }
    this.link.send({ type: 'challenge', peerId: peer.id });
    this.setNotice(`Challenging ${upper(peer.name)}${WAIT}`);
    this.toLobby();
  }

  startCpu(difficulty = 'smart', opponent = 'cpu'): void {
    this.panel = null;
    const claude = opponent === 'claude' ? { opponent: 'claude', model: claudeModel(this.claude) } : {};
    if (!this.link.send({ type: 'start_cpu', difficulty: difficulty === 'random' ? 'random' : 'smart', ...claude })) {
      this.setNotice("Can't reach the helper.");
      this.render();
    }
  }

  private renderLobby(view: HTMLElement): void {
    ns.renderLobby(this, view);
  }

  playerName(): string {
    return cleanName(playerLook()?.name ?? '') || this.trainer.name || savedName() || 'TRAINER';
  }

  private trainerLooks = false;

  syncName(): void {
    const name = cleanName(playerLook()?.name ?? '') || savedName();
    const look = playerLook();
    if (look && this.trainerLooks) this.link.send({ type: 'set_trainer', trainer: { ...wireLook(look), name: name || look.name } });
    else if (name && name !== this.trainer.name) this.link.send({ type: 'set_name', name });
  }

  private syncLobbyFocus(): void {
    if (this.lobbyFocus === 'menu' && this.panel === 'music') this.music.endPreview(this);
    const [menu, peers] = this.menus;
    if (menu) {
      menu.focused = this.lobbyFocus === 'menu' && !this.prompt;
      menu.paint();
    }
    if (peers) {
      peers.focused = this.lobbyFocus === 'peers' && !this.prompt;
      peers.paint();
    }
  }

  private lanOff(): void {
    this.setNotice('LAN is off in the helper.');
    this.render();
  }

  private toggleSeek(): void {
    this.link.send({ type: 'seek', looking: !this.looking });
  }

  private refresh(): void {
    this.link.send({ type: 'lobby_refresh' });
    this.setNotice(`Looking for trainers${WAIT}`);
    this.render();
  }

  private challenge(peer: Peer): void {
    if (peer.status !== 'idle' && peer.status !== 'looking') {
      this.setNotice(`${upper(peer.name)} is ${peer.status === 'battling' ? 'in a battle' : 'away'}.`);
      this.render();
      return;
    }
    if (this.outgoing) {
      this.setNotice('You already sent a challenge.');
      this.render();
      return;
    }
    this.link.send({ type: 'challenge', peerId: peer.id });
  }

  private openInput(field: 'name' | 'ip'): void {
    this.prompt = { kind: 'input', field };
    this.render();
  }

  private promptMsg: HTMLCanvasElement | null = null;

  private renderPromptText(): void {
    const msg = this.promptMsg;
    if (!msg?.isConnected || this.prompt?.kind !== 'incoming') return;
    const c = this.prompt.challenge;
    const left = Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 1000));
    this.paintMsg(msg, `${assets.fit(upper(c.from.name), 152)}\nwants to battle! (${left}s)`);
  }

  private renderPrompt(view: HTMLElement, existing?: HTMLCanvasElement): void {
    const prompt = this.prompt;
    if (!prompt) return;
    const msg = existing ?? this.msgBox(view, 8, 120, prompt.kind === 'input' ? 224 : 152, 32, '');
    this.promptMsg = msg;
    if (prompt.kind === 'incoming') {
      const c = prompt.challenge;
      this.renderPromptText();
      this.addMenu(this.menuBox(view, 176, 120, 56, 32), [
        { label: 'YES', pick: () => this.answer(c, true) },
        { label: 'NO', pick: () => this.answer(c, false) },
      ]);
    } else if (prompt.kind === 'outgoing') {
      this.paintMsg(msg, `${assets.fit(upper(this.outgoing?.peer.name ?? 'the trainer'), 152)}\nWaiting for an answer${WAIT}`);
      this.addMenu(this.menuBox(view, 176, 120, 56, 32), [{ label: 'CANCEL', pick: () => this.cancelChallenge() }]);
    } else {
      const ip = prompt.field === 'ip';
      this.paintMsg(msg, ip ? "Trainer's IP (host or host:port):" : 'Your trainer name:', 224, 16);
      const input = place(el('input', 'pkb-input'), 8, 136, 224, 16);
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.maxLength = ip ? 64 : NAME_MAX;
      input.value = ip ? '' : this.trainer.name || savedName();
      input.placeholder = ip ? '192.168.1.23' : 'MAY';
      input.setAttribute('aria-label', ip ? 'Trainer IP address' : 'Trainer name');
      if (!ip) {
        input.addEventListener('input', () => {
          const cleaned = input.value.replace(/[^A-Za-z0-9 ._'-]/g, '');
          if (cleaned !== input.value) input.value = cleaned;
        });
      }
      view.append(input);
      this.input = input;
    }
  }

  private answer(c: Incoming, accept: boolean): void {
    this.link.send({ type: 'respond_challenge', challengeId: c.challengeId, accept });
    if (!accept) {
      this.incoming.delete(c.challengeId);
      this.prompt = null;
      this.nextPrompt();
    }
    this.render();
  }

  private cancelChallenge(): void {
    if (this.outgoing) this.link.send({ type: 'cancel_challenge', challengeId: this.outgoing.challengeId });
  }

  private submitInput(): void {
    const prompt = this.prompt;
    const input = this.input;
    if (prompt?.kind !== 'input' || !input) return;
    const value = input.value.trim();
    if (prompt.field === 'name') {
      const name = cleanName(value);
      if (name) {
        cinnamon.settings.set('name', name);
        this.link.send({ type: 'set_name', name });
        this.setNotice(`You're ${upper(name)} now.`);
      }
    } else if (value) {
      const { host, port } = parsePeerAddress(value) ?? { host: '', port: undefined };
      if (!host) {
        this.setNotice("That address doesn't look right.");
      } else {
        this.link.send(port ? { type: 'add_peer', host, port } : { type: 'add_peer', host });
        this.setNotice(`Adding ${host}${WAIT}`);
      }
    }
    this.prompt = null;
    this.nextPrompt();
    this.render();
  }

  private cancelInput(): void {
    this.prompt = null;
    this.nextPrompt();
    this.render();
  }

  handleKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLInputElement && this.root.contains(target)) {
      if (event.key === 'Enter') {
        event.preventDefault();
        peSound('SE_SELECT');
        this.submitInput();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        peSound('SE_SELECT');
        this.cancelInput();
      }
      event.stopPropagation();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target instanceof Node && (this.titleEl.contains(target) || this.bar.contains(target))) return;
    const map: Record<string, Action | 'esc'> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Enter: 'ok',
      ' ': 'ok',
      z: 'ok',
      Z: 'ok',
      x: 'back',
      X: 'back',
      Backspace: 'back',
      Escape: 'esc',
    };
    const action = map[event.key];
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.act(action);
  }

  private closePanel(): void {
    if (this.panel === 'music') {
      this.panel = 'options';
      this.panelIndex = 1;
      this.music.endPreview(this);
    } else {
      this.panel = null;
      this.lobbyFocus = 'menu';
    }
    this.render();
  }

  escCloses(): boolean {
    if (this.screen === 'battle' && this.battle) return !this.battle.inSubmenu;
    if (this.prompt) return false;
    return !(this.screen === 'lobby' && this.lobbyFocus === 'peers');
  }

  act(action: Action | 'esc'): void {
    if (this.screen === 'battle' && this.battle) {
      if (action === 'esc') {
        if (this.battle.inSubmenu) this.battle.input('back');
        else this.close();
        return;
      }
      this.battle.input(action);
      return;
    }
    const menus = this.menus;
    if (this.prompt) {
      const menu = menus[menus.length - 1];
      if (action === 'esc' || action === 'back') {
        if (this.prompt.kind === 'incoming') {
          peSound('SE_SELECT');
          this.answer(this.prompt.challenge, false);
        } else if (this.prompt.kind === 'outgoing') {
          peSound('SE_SELECT');
          this.cancelChallenge();
        } else this.cancelInput();
        return;
      }
      if (!menu || this.prompt.kind === 'input') return;
      if (action === 'ok') menu.pick();
      else menu.move(0, action === 'up' ? -1 : action === 'down' ? 1 : 0);
      return;
    }
    if (this.screen === 'lobby') {
      const [menu, peers] = menus;
      if (action === 'esc' && this.lobbyFocus !== 'peers') return this.close();
      if (action === 'back' || action === 'esc') {
        if (this.lobbyFocus === 'peers') {
          peSound('SE_SELECT');
          this.closePanel();
        }
        return;
      }
      if (action === 'right' && peers && this.lobbyFocus === 'menu') {
        this.lobbyFocus = 'peers';
        peSound('SE_SELECT');
        this.render();
        return;
      }
      if (action === 'left' && this.lobbyFocus === 'peers' && this.panel) {
        peSound('SE_SELECT');
        this.closePanel();
        return;
      }
      if (action === 'left' && this.lobbyFocus === 'peers') {
        this.lobbyFocus = 'menu';
        peSound('SE_SELECT');
        this.render();
        return;
      }
      const active = this.lobbyFocus === 'peers' && peers ? peers : menu;
      if (!active) return;
      if (action === 'ok') active.pick();
      else if (active.move(0, action === 'up' ? -1 : action === 'down' ? 1 : 0) && active === peers) this.render();
      return;
    }
    if (action === 'esc') return this.close();
    const menu = menus[0];
    if (!menu) return;
    if (action === 'ok') menu.pick();
    else if (action === 'back') {
      if (this.screen === 'result') this.toLobby();
    } else menu.move(0, action === 'up' ? -1 : action === 'down' ? 1 : 0);
  }
}

// sessionStorage lives as long as this window's page: it outlasts extension hot reloads and syncs, not an app restart
const CLOSED_KEY = 'pokemon-battle:closed';
function wasClosed(): boolean {
  try {
    return sessionStorage.getItem(CLOSED_KEY) === '1';
  } catch {
    return !!(window as any).__pkbClosed;
  }
}
function markClosed(closed: boolean): void {
  (window as any).__pkbClosed = closed;
  try {
    if (closed) sessionStorage.setItem(CLOSED_KEY, '1');
    else sessionStorage.removeItem(CLOSED_KEY);
  } catch {}
}

const app = new App();
ns.app = app;
const settingsRow = new SettingsRow(app);

function isShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.code === 'KeyB';
}

listen(
  window,
  'keydown',
  (event: KeyboardEvent) => {
    if (isShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      app.toggle();
      return;
    }
    if (!app.owns(event.target)) return;
    app.handleKey(event);
  },
  true,
);
listen(window, 'resize', () => {
  app.layout();
  app.placeLauncher();
});
let lastMode = app.floating;
cinnamon.settings.onChange(() => {
  try {
    app.resetFloat();
    app.launcherArt.sync();
    if (app.floating !== lastMode) {
      lastMode = app.floating;
      app.layout();
      app.render();
    }
    const row = document.querySelector<HTMLElement>('[data-pkb-row]');
    if (row) settingsRow.sync(row);
  } catch (err) {
    report(err);
  }
});

app.start();
settingsRow.start();
listen(window, 'pe-music-state', (event: CustomEvent) => {
  if (app.music.heard(event.detail)) app.music.sync(app);
  (app as any).syncMute();
});
listen(window, 'pe-player-change', () => {
  app.syncName();
  if (app.open && app.screen === 'lobby') app.render();
});
if (app.floating && cinnamon.settings.get('openAtStart') !== false && !wasClosed()) app.show(true);

cinnamon.onDispose(() => {
  rt.disposed = true;
  delete (window as any).__pkb;
  for (const cleanup of cleanups) cleanup();
  for (const id of timers) clearTimeout(id);
  timers.clear();
  settingsRow.dispose();
  app.dispose();
});
