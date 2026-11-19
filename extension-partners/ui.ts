// Sidebar icons, the chat header thumbnail, message avatars, stream detection and the evolution moment.
declare const cinnamon: { settings: { get(key: string): unknown } };
const P = (window as any).__pkp;
const { rt, guard, later, cancel, listen, el, assets, store } = P;
type ExpItem = { id: string; row: number; tokens: number; tools: number };
type ExpGain = { from: number; to: number; level: number; before: number; after: number };

const SIDEBAR = '[data-testid="sidebar"]';
const ROWS = `${SIDEBAR} [data-row-key]`;
const TRANSCRIPT = '[data-testid="epitaxy-virtual-transcript"]';
const T_ROW = '[data-testid="transcript-row"]';
const OURS = '.pkp-ri, .pkp-ht, .pkp-av, .pkp-tr, .pkp-evo, .cm-top, .cm-bottom, .cm-menu';
const BUSY_SETTLE_MS = 1500;
const PASS_MS = 150;

const isOurs = (node: Node | null) => {
  const elem = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  return !!elem?.closest?.(OURS);
};
const foreign = (records: MutationRecord[]) =>
  records.some((r) => r.type === 'attributes' ? !isOurs(r.target) : !isOurs(r.target) && ![...r.addedNodes, ...r.removedNodes].every(isOurs));

// a partner that rolled shiny sparkles once, the first time one of its sprites is fully on screen
function revealShiny(key: string, sprite: HTMLElement): void {
  if (store.shinyState(key) !== 1) return;
  const r = sprite.getBoundingClientRect();
  if (!r.width || r.top < 0 || r.bottom > window.innerHeight || document.hidden) return;
  store.markShinySeen(key);
  void P.sparkle({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, P.scale.big);
}

function iconStyle(node: HTMLElement, num: number): void {
  const url = assets.url('i', num);
  const value = url ? `url("${url}")` : '';
  if (node.dataset.num !== String(num)) {
    node.dataset.num = String(num);
    node.style.setProperty('--pkp-img', value);
  }
}

// the line box of the first visible text inside an element, for centring a sprite on it
// a message you typed carries the app's user-message body; injected rows (subagent and cross-session messages,
// notices) are human rows without it, so they get no trainer and do not end a turn
const typedMessage = (row: Element) => row.getAttribute('data-perf-row') === 'human' && !!row.querySelector('[data-testid="user-message"]');
// sprite to content gap, in font pixels, beyond the talking arrow's 3 px overhang
// a done tool group's summary ("Read 2 files, ran a command"): each clause is its number, or one
const toolCount = (group: HTMLElement) =>
  (group.innerText.split('\n')[0] || '')
    .split(/,\s*/)
    .filter((part) => part.trim())
    .reduce((n, part) => n + Number(/(?:^|\s)(\d+)(?:\s|$)/.exec(part)?.[1] ?? 1), 0);
const AV_GAP = 3;
const AV_ARROW = 3;
const SB_GAP = 8;

function firstLine(root: Element): DOMRect | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only, [class*="pkp-"]')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (rect && rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}

class Sidebar {
  private observer: MutationObserver | null = null;
  private root: Element | null = null;
  private status = new Map<string, string>();

  constructor(private readonly onReply: (key: string, label: string) => void) {}

  watch(): void {
    const root = document.querySelector(SIDEBAR);
    if (!root || root === this.root) return;
    this.observer?.disconnect();
    this.root = root;
    this.observer = new MutationObserver((records) => {
      if (foreign(records)) this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    this.schedule();
  }

  private queued = 0;
  schedule(): void {
    if (this.queued || rt.disposed) return;
    this.queued = later(() => {
      this.queued = 0;
      this.decorate();
    }, 60);
  }

  // one left edge for every row type: the single-line row's label start, measured live, snapped to device pixels;
  // cards pad differently, so taking each row's own padding made top-level cards look indented
  private iconX(): number | null {
    // a tab of only cards has no visible single-line row: the hidden tab's rows still carry the computed padding
    const rows = [...document.querySelectorAll<HTMLElement>(`${ROWS} [data-row]:not([data-cm-card])`)].filter((r) => r.querySelector('[data-row-main-button]'));
    const ref = rows.find((r) => r.offsetHeight > 0) ?? rows[0];
    const button = ref?.querySelector<HTMLElement>('[data-row-main-button]');
    if (!ref || !button) return null;
    const offset = ref.offsetHeight > 0 ? button.getBoundingClientRect().left - ref.getBoundingClientRect().left : 0;
    return offset + (parseFloat(getComputedStyle(button).paddingInlineStart) || 0);
  }

  decorate(): void {
    const open = P.currentThread();
    const x = this.iconX();
    for (const rowKey of document.querySelectorAll(ROWS)) {
      const key = P.threadKeyFromRow(rowKey);
      const row = rowKey.querySelector<HTMLElement>(':scope > div > [data-row], :scope [data-row]');
      if (!key || !row) continue;
      this.trackStatus(key, rowKey, open);
      let icon = row.querySelector<HTMLElement>(':scope > .pkp-ri');
      if (!icon) {
        icon = el('span', 'pkp-ri');
        icon.setAttribute('aria-hidden', 'true');
        row.append(icon);
        row.setAttribute('data-pkp-row', '');
      }
      const label = row.querySelector<HTMLElement>('[data-row-label]');
      if (x !== null) {
        const dpr = window.devicePixelRatio || 1;
        const rowLeft = row.getBoundingClientRect().left;
        const iconLeft = Math.round((rowLeft + x) * dpr) / dpr - rowLeft;
        const left = `${iconLeft.toFixed(4)}px`;
        if (icon.style.left !== left) icon.style.left = left;
        // chat rows keep the app's status slot ahead of the title, cards do not: shift each title to one gap past the icon
        if (label && label.offsetWidth) {
          const u = P.scale.big;
          const natural = label.getBoundingClientRect().left - rowLeft - (parseFloat(getComputedStyle(label).marginInlineStart) || 0);
          const target = Math.round((rowLeft + iconLeft + (24 + SB_GAP) * u) * dpr) / dpr - rowLeft;
          const shift = `${(target - natural).toFixed(4)}px`;
          if (row.style.getPropertyValue('--pkp-label-shift') !== shift) row.style.setProperty('--pkp-label-shift', shift);
        }
      }
      // centred on the title line, wherever the theme and sidebar-cards put it in the card
      if (label && row.offsetHeight) {
        const top = `${(label.offsetTop + label.offsetHeight / 2).toFixed(1)}px`;
        if (icon.style.top !== top) icon.style.top = top;
      }
      iconStyle(icon, store.species(key));
      revealShiny(key, icon);
    }
  }

  // background threads: the row's status going from Running to anything else is one reply
  private trackStatus(key: string, rowKey: Element, open: string | null): void {
    const label = rowKey.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? '';
    const before = this.status.get(key);
    this.status.set(key, label);
    if (before === 'Running' && label && label !== 'Running' && key !== open) this.onReply(key, label);
  }

  refresh(): void {
    document.querySelectorAll<HTMLElement>('.pkp-ri').forEach((icon) => {
      const key = P.threadKeyFromRow(icon.closest('[data-row-key]'));
      if (key) iconStyle(icon, store.species(key));
    });
  }

  dispose(): void {
    this.observer?.disconnect();
    if (this.queued) cancel(this.queued);
    document.querySelectorAll('.pkp-ri').forEach((n) => n.remove());
    document.querySelectorAll('[data-pkp-row]').forEach((n) => n.removeAttribute('data-pkp-row'));
  }
}

class Transcript {
  private observer: MutationObserver | null = null;
  private root: Element | null = null;
  private passTimer = 0;
  private settleTimer = 0;
  busy = false;
  private busyKey: string | null = null;

  constructor(
    private readonly onReply: (key: string) => void,
    private readonly onExp: (key: string, gain: ExpGain) => void,
  ) {}

  watch(): void {
    const root = document.querySelector(TRANSCRIPT);
    if (root === this.root && root?.isConnected) return;
    this.observer?.disconnect();
    this.root = root;
    if (!root) return;
    this.observer = new MutationObserver((records) => {
      if (foreign(records)) this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'data-is-streaming', 'data-perf-row-streaming'] });
    this.schedule();
  }

  schedule(): void {
    if (this.passTimer || rt.disposed) return;
    this.passTimer = later(() => {
      this.passTimer = 0;
      this.pass();
    }, PASS_MS);
  }

  private isBusy(): boolean {
    const root = this.root;
    if (!root) return false;
    return !!root.querySelector('[role="feed"][aria-busy="true"], [data-is-streaming="true"], [data-perf-row-streaming="true"]');
  }

  pass(): void {
    const key = P.currentThread();
    this.updateBusy(key);
    this.header(key);
    if (!this.root || !key) return;
    const num = store.species(key);
    const rows = [...this.root.querySelectorAll<HTMLElement>(T_ROW)];
    this.reserveColumn(rows);
    // exactly one partner per assistant turn (the rows between two of your messages): on the live status row while
    // the turn runs, else on the turn's first assistant row; it moves between them, it is never copied
    const turns: HTMLElement[][] = [[]];
    for (const row of rows) {
      if (typedMessage(row)) turns.push([]);
      else turns[turns.length - 1].push(row);
    }
    const anchors = new Set<HTMLElement>();
    let live: HTMLElement | null = null;
    turns.forEach((turn, t) => {
      const last = t === turns.length - 1;
      // the app draws the running status twice: in the reply row and again in a trailing marker row; the reply
      // row's copy is the anchor, the marker only before any reply row exists
      const replies = turn.filter((r) => r.getAttribute('data-perf-row') === 'assistant');
      const liveStatus = '[data-cds="TurnStatus"]:not([data-state="done"])';
      const running = last && this.busy ? replies.find((r) => r.querySelector(liveStatus)) : undefined;
      const anchor = running ?? replies[0] ?? (last && this.busy ? turn.find((r) => r.getAttribute('data-perf-row') === 'marker') : undefined);
      if (!anchor) return;
      anchors.add(anchor);
      if (last && this.busy) live = anchor;
    });
    for (const row of rows) {
      const kind = row.getAttribute('data-perf-row');
      this.place(row, 'pkp-av', anchors.has(row) ? num : null);
      this.place(row, 'pkp-tr', typedMessage(row) ? 1 : null);
    }
    // a sprite left on any other node (a row the virtualizer reused) goes too
    for (const av of this.root.querySelectorAll<HTMLElement>('.pkp-av')) {
      if (!anchors.has(av.parentElement as HTMLElement)) av.remove();
      else av.toggleAttribute('data-talking', av.parentElement === live);
    }
    const shown = this.root.querySelector<HTMLElement>('.pkp-av');
    if (shown) revealShiny(key, shown);
    this.scanExp(key, rows, this.busy ? turns.slice(0, -1) : turns);
  }

  // EXP from finished turns only: each message's own text (tokens at 4 characters) and each tool group, by stable id
  private scanExp(key: string, rows: HTMLElement[], finished: HTMLElement[][]): void {
    const index = (row: Element) => Number(row.getAttribute('data-index') ?? -1);
    if (store.expWatermark(key) === null) {
      store.setExpWatermark(key, Math.max(-1, ...rows.map(index)));
      return;
    }
    const items: ExpItem[] = [];
    const texts = new Map<string, ExpItem>();
    for (const row of finished.flat()) {
      if (row.getAttribute('data-perf-row-streaming') === 'true') continue;
      const at = index(row);
      // a message can span several elements and rows: its characters add up under its data-turn-key
      for (const msg of row.querySelectorAll<HTMLElement>('[data-cds="AssistantMessage"]:not([data-is-streaming="true"])')) {
        const turn = msg.getAttribute('data-turn-key');
        if (!turn) continue;
        const status = [...msg.querySelectorAll<HTMLElement>('[data-cds="TurnStatus"]')].reduce((n, x) => n + x.innerText.length, 0);
        const chars = Math.max(0, msg.innerText.length - status);
        const item = texts.get(turn) ?? { id: `t:${turn}`, row: at, tokens: 0, tools: 0 };
        item.tokens += chars / P.CHARS_PER_TOKEN;
        item.row = Math.max(item.row, at);
        texts.set(turn, item);
      }
      for (const group of row.querySelectorAll<HTMLElement>('[data-cds="TurnStatus"][data-state="done"][data-item-key]')) {
        items.push({ id: `k:${group.getAttribute('data-item-key')}`, row: at, tokens: 0, tools: toolCount(group) });
      }
    }
    items.push(...texts.values());
    const gain = items.length ? store.addExp(key, items) : null;
    if (gain) this.onExp(key, gain);
  }

  // a narrow gutter (side pane open, small window) used to hide the partner; then the assistant rows give up a
  // column of the sprite's width at their start instead, as the user rows do for the trainer
  // the assistant content column's left edge inside a row, so status and marker rows line up with replies
  private colLeft: number | null = null;
  private colX: number | null = null;

  private reserveColumn(rows: HTMLElement[]): void {
    const root = this.root as HTMLElement | null;
    if (!root) return;
    const first = rows.find((r) => r.getAttribute('data-perf-row') === 'assistant');
    const inner = first?.querySelector('[data-transcript-row]');
    if (!first || !inner) return;
    const col = Math.ceil((24 + AV_ARROW + AV_GAP) * P.scale.big);
    const reserved = root.hasAttribute('data-pkp-av-col');
    this.colX = inner.getBoundingClientRect().left;
    this.colLeft = this.colX - first.getBoundingClientRect().left;
    // the reply column's own padding does not move its left edge, so this is the gutter in both modes
    const gutter = this.colLeft;
    const need = gutter < (24 + AV_ARROW + AV_GAP) * P.scale.big;
    if (need !== reserved) root.toggleAttribute('data-pkp-av-col', need);
    if (need && root.style.getPropertyValue('--pkp-av-col') !== `${col}px`) root.style.setProperty('--pkp-av-col', `${col}px`);
  }

  private place(row: HTMLElement, cls: string, num: number | null): void {
    let node = row.querySelector<HTMLElement>(`:scope > .${cls}`);
    if (num === null) {
      node?.remove();
      if (cls === 'pkp-tr' && row.hasAttribute('data-pkp-tr-row')) {
        row.removeAttribute('data-pkp-tr-row');
        row.style.removeProperty('--pkp-tr-col');
      }
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const inner = cls === 'pkp-av' ? row.querySelector('[data-transcript-row]') : null;
    const target = cls === 'pkp-av' ? inner ?? row.firstElementChild : row.querySelector('[data-cds="UserMessage"]');
    const reserved = cls === 'pkp-av' && !!this.root?.hasAttribute('data-pkp-av-col');
    if (!target) return;
    let box = target.getBoundingClientRect();
    // every partner lines up on one x: the reply column's edge from the first reply row, so status, marker and
    // reply rows never jump between each other
    if (cls === 'pkp-av' && this.colX !== null) box = new DOMRect(this.colX, box.top, box.width, box.height);
    if (!node) {
      node = el('span', cls);
      if (cls === 'pkp-av') {
        node.setAttribute('aria-hidden', 'true');
        node.append(el('span', 'pkp-arrow'));
      } else {
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-label', 'Customize trainer');
      }
      row.append(node);
    }
    if (cls === 'pkp-tr') return this.placeTrainer(row, node, box, rowRect);
    const unit = P.scale.big;
    // the sprite's right edge (talking arrow included) sits AV_GAP font pixels before the reply column, on every
    // row of the turn, so a running turn hands over to the finished one without a jump
    const contentLeft = reserved ? box.left - rowRect.left + Number(this.root?.style.getPropertyValue('--pkp-av-col').replace('px', '') || 0) : box.left - rowRect.left;
    // a row lower than the sprite gets the smaller pixel so the sprite stays inside its own row
    const fits = rowRect.height >= 24 * unit;
    node.toggleAttribute('data-small', !fits);
    const px = fits ? unit : P.scale.small;
    const width = 24 * px;
    const left = contentLeft - (AV_ARROW + AV_GAP) * px - width;
    node.hidden = left < 0;
    // centred on the live status while the turn runs, else on the first line of the reply; clamped to the row
    const status = row.querySelector('[data-cds="TurnStatus"]:not([data-state="done"])');
    const line = status && this.busy ? status.getBoundingClientRect() : firstLine(target);
    const height = 24 * px;
    const mid = line ? line.top + line.height / 2 - rowRect.top : rowRect.height / 2;
    const top = Math.min(Math.max(0, mid - height / 2), Math.max(0, rowRect.height - height));
    const dot = 1 / (window.devicePixelRatio || 1);
    const snap = (v: number) => (Math.round((rowRect.left + v) / dot) * dot - rowRect.left).toFixed(4);
    node.style.left = `${snap(left)}px`;
    node.style.top = `${(Math.round(top / dot) * dot).toFixed(4)}px`;
    if (cls === 'pkp-av') iconStyle(node, num);
    else node.dataset.name = P.trainerSetting().name;
  }

  // the trainer gets its own column inside the message row: the bubble gives up the width of the wider of the
  // sprite and its name label, so neither ever reaches past the transcript column
  private placeTrainer(row: HTMLElement, node: HTMLElement, box: DOMRect, rowRect: DOMRect): void {
    const name = P.trainerSetting().name;
    node.dataset.name = name;
    const styles = getComputedStyle(document.documentElement);
    const unit = P.scale.big;
    const fs = parseFloat(styles.getPropertyValue('--pe-fs-small')) || 11;
    const measure = (P.measureCtx ??= document.createElement('canvas').getContext('2d')) as CanvasRenderingContext2D;
    measure.font = `${fs}px "Pokemon Emerald", sans-serif`;
    const labelW = Math.ceil(measure.measureText(name).width + 4 * unit);
    const spriteW = 16 * unit;
    const col = Math.ceil(Math.max(spriteW, labelW) + 2 * unit);
    if (row.style.getPropertyValue('--pkp-tr-col') !== `${col}px`) row.style.setProperty('--pkp-tr-col', `${col}px`);
    row.setAttribute('data-pkp-tr-row', '');
    // sprite and name label stay inside their own row: a short row takes the smaller pixel, and the label is
    // dropped when the row has no room under the sprite
    const room = rowRect.bottom - box.top;
    const small = room < 32 * unit;
    node.toggleAttribute('data-small', small);
    const labelH = (parseFloat(styles.getPropertyValue('--pe-lh-small')) || 14) + unit;
    node.toggleAttribute('data-no-label', room < 32 * (small ? P.scale.small : unit) + labelH);
    node.hidden = false;
    node.dataset.labelW = String(labelW);
    const dot = 1 / (window.devicePixelRatio || 1);
    const snap = (v: number) => (Math.round(v / dot) * dot).toFixed(4);
    node.style.left = `${snap(box.right - rowRect.left - col / 2 - (small ? 16 * P.scale.small : spriteW) / 2)}px`;
    node.style.top = `${snap(box.top - rowRect.top)}px`;
  }

  private header(key: string | null): void {
    const title = document.querySelector('[data-pane-title]');
    const h2 = title?.closest('h2');
    let thumb = document.querySelector<HTMLElement>('.pkp-ht');
    if (!h2 || !key || !h2.parentElement) {
      thumb?.remove();
      return;
    }
    if (!thumb || thumb.nextElementSibling !== h2) {
      thumb?.remove();
      thumb = el('span', 'pkp-ht');
      thumb.setAttribute('role', 'img');
      h2.before(thumb);
    }
    const mon = P.mon?.(key);
    const name = mon ? `${mon.nickname}, level ${mon.level}` : 'Partner';
    if (thumb.getAttribute('aria-label') !== name) thumb.setAttribute('aria-label', name);
    thumb.toggleAttribute('data-talking', this.busy);
    iconStyle(thumb, store.species(key));
  }

  // a reply counts once the thread has stayed idle for BUSY_SETTLE_MS, so tool-call gaps inside one turn don't
  private updateBusy(key: string | null): void {
    const busy = this.isBusy();
    if (busy) {
      if (this.settleTimer) cancel(this.settleTimer);
      this.settleTimer = 0;
      if (!this.busy) this.busyKey = key;
      this.busy = true;
      return;
    }
    if (!this.busy || this.settleTimer) return;
    const startedOn = this.busyKey;
    this.settleTimer = later(() => {
      this.settleTimer = 0;
      if (this.isBusy()) return;
      this.busy = false;
      this.busyKey = null;
      if (startedOn && startedOn === P.currentThread()) this.onReply(startedOn);
      this.pass();
    }, BUSY_SETTLE_MS);
  }

  reset(): void {
    if (this.settleTimer) cancel(this.settleTimer);
    this.settleTimer = 0;
    this.busy = false;
    this.busyKey = null;
  }

  refresh(): void {
    document.querySelectorAll<HTMLElement>('.pkp-av').forEach((n) => delete n.dataset.num);
    this.schedule();
  }

  dispose(): void {
    this.observer?.disconnect();
    if (this.passTimer) cancel(this.passTimer);
    if (this.settleTimer) cancel(this.settleTimer);
    document.querySelectorAll('.pkp-av, .pkp-tr, .pkp-ht').forEach((n) => n.remove());
    document.querySelectorAll<HTMLElement>('[data-pkp-av-col]').forEach((n) => {
      n.removeAttribute('data-pkp-av-col');
      n.style.removeProperty('--pkp-av-col');
    });
    document.querySelectorAll<HTMLElement>('[data-pkp-tr-row]').forEach((n) => {
      n.removeAttribute('data-pkp-tr-row');
      n.style.removeProperty('--pkp-tr-col');
    });
  }
}

// the Gen 3 evolution scene, drawn over the transcript
class Evolution {
  private node: HTMLElement | null = null;
  private steps: number[] = [];

  play(from: number, to: number, nickname?: string | null, shiny = false): void {
    this.close();
    const area = document.querySelector(TRANSCRIPT)?.getBoundingClientRect();
    if (!area || area.width < 200) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const node = (this.node = el('div', 'pkp-evo'));
    node.setAttribute('role', 'status');
    node.style.left = `${area.left + area.width / 2}px`;
    node.style.top = `${area.top + area.height / 2}px`;
    const stage = el('div', 'pkp-evo-stage');
    const old = el('img', 'pkp-evo-mon');
    old.src = assets.front(from, shiny) ?? '';
    old.alt = '';
    const neu = el('img', 'pkp-evo-mon');
    neu.src = assets.front(to, shiny) ?? '';
    neu.alt = '';
    neu.hidden = true;
    const flash = el('div', 'pkp-evo-flash');
    stage.append(old, neu, flash);
    const text = el('div', 'pkp-evo-text');
    node.append(stage, text);
    document.body.append(node);
    node.addEventListener('click', () => this.close());

    const say = (line: string) => {
      text.textContent = '';
      [...line].forEach((ch, i) => this.at(() => (text.textContent += ch), i * 22));
    };
    const fromName = nickname || assets.name(from);
    const toName = assets.name(to);
    say(`What? ${fromName} is evolving!`);
    let t = 1300;
    if (!reduced) {
      // old and new swap as white silhouettes, faster each time, like the GBA scene
      let gap = 260;
      let showNew = false;
      this.at(() => stage.setAttribute('data-silhouette', ''), t - 200);
      while (gap > 40) {
        const now = showNew;
        this.at(() => {
          old.hidden = now;
          neu.hidden = !now;
        }, t);
        t += gap;
        gap = Math.round(gap * 0.82);
        showNew = !showNew;
      }
      this.at(() => flash.setAttribute('data-on', ''), t);
      t += 260;
    }
    this.at(() => {
      stage.removeAttribute('data-silhouette');
      old.hidden = true;
      neu.hidden = false;
      // EvolutionScene's MUS_EVOLVED fanfare, through the audio extension's one music channel
      P.fanfare('MUS_EVOLVED');
    }, t);
    this.at(() => flash.removeAttribute('data-on'), t + 120);
    this.at(() => say(`Congratulations! Your ${fromName} evolved into ${toName}!`), t + 200);
    this.at(() => node.setAttribute('data-leaving', ''), t + 4200);
    this.at(() => this.close(), t + 4600);
  }

  private at(fn: () => void, ms: number): void {
    this.steps.push(later(fn, ms));
  }

  close(): void {
    for (const id of this.steps) cancel(id);
    this.steps = [];
    this.node?.remove();
    this.node = null;
  }
}

// one cry at a time: a finish within CRY_GAP_MS of the last one (or while one plays) is dropped
const CRY_GAP_MS = 1500;
let cryBusyUntil = 0;
P.cryLog = [] as Array<Record<string, unknown>>;
const audioUnlocked = () => {
  const audio = (window as any).__peAudio;
  if (!audio) return false;
  if (typeof audio.unlocked === 'function') return !!audio.unlocked();
  if (typeof audio.unlocked === 'boolean') return audio.unlocked;
  return String(audio.contextState?.() ?? '').startsWith('running');
};
function cryFor(key: string, sprite: HTMLElement | null): void {
  const log = (entry: Record<string, unknown>) => {
    P.cryLog.push({ at: Date.now(), key, ...entry });
    if (P.cryLog.length > 40) P.cryLog.shift();
  };
  if (Number(cinnamon.settings.get('replyCry') ?? 1) === 0) return log({ skipped: 'setting off' });
  if (!P.watching()) return log({ skipped: 'not watching' });
  if (P.sound.gain('chat') <= 0) return log({ skipped: 'chat muted' });
  // the audio extension's own unlock state: while its AudioContext is locked nothing plays and nothing sparkles
  if (!audioUnlocked()) return log({ skipped: 'audio locked' });
  if (Date.now() < cryBusyUntil) return log({ skipped: 'busy' });
  const mon = P.mon?.(key);
  if (!mon) return log({ skipped: 'no partner' });
  cryBusyUntil = Date.now() + CRY_GAP_MS + 4000;
  const cry = () => {
    const played = !!(window as any).__peAudio?.cry?.(mon.species, { window: 'chat' });
    log({ cry: mon.species, played });
    cryBusyUntil = Date.now() + CRY_GAP_MS;
  };
  const r = sprite?.getBoundingClientRect();
  if (mon.shiny && r && r.width) {
    log({ sparkle: 'start' });
    void P.sparkle({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, P.scale.big, 'chat').then(() => {
      log({ sparkle: 'end' });
      cry();
    });
  } else cry();
}

class Partners {
  sidebar = new Sidebar((key, label) => this.reply(key, false, label));
  transcript = new Transcript((key) => this.reply(key, true), (key, gain) => this.gained(key, gain));
  evolution = new Evolution();
  private path = location.pathname;

  // a finished reply in the chat on screen plays its partner's cry (a shiny sparkles first, with SE_SHINY),
  // once by its last status id; background threads stay silent
  reply(key: string, open: boolean, _label = ''): void {
    if (open && key === P.currentThread()) {
      const statuses = [...document.querySelectorAll<HTMLElement>(`${TRANSCRIPT} [data-cds="TurnStatus"][data-item-key]`)];
      const last = statuses[statuses.length - 1];
      const turn = last?.getAttribute('data-item-key');
      // a stopped or interrupted turn ends on a status that is not done: no cry
      if (!last || !turn || last.getAttribute('data-state') !== 'done') return P.cryLog.push({ at: Date.now(), key, skipped: 'not done' });
      if (!store.firstCry(`${key}|${turn}`)) return P.cryLog.push({ at: Date.now(), key, skipped: 'already played' });
      const sprite = [...document.querySelectorAll<HTMLElement>('.pkp-av')].pop() ?? null;
      return cryFor(key, sprite);
    }
  }

  gained(key: string, gain: ExpGain): void {
    if (P.levelForExp(gain.to) === gain.level) return;
    this.sidebar.refresh();
    this.transcript.refresh();
    if (key !== P.currentThread()) return;
    const evolve = () => {
      if (gain.before !== gain.after) this.evolution.play(gain.before, gain.after, store.nickname(key), P.mon?.(key)?.shiny);
    };
    if (P.levelUp) P.levelUp(key, gain.from, evolve, Number(cinnamon.settings.get('workSounds') ?? 1) !== 0 && P.watching());
    else evolve();
  }

  tick(): void {
    if (location.pathname !== this.path) {
      this.path = location.pathname;
      this.transcript.reset();
      document.querySelectorAll('.pkp-av').forEach((n) => n.remove());
      const key = P.currentThread();
      if (key) store.get(key, true);
      this.transcript.schedule();
    }
    this.sidebar.watch();
    this.transcript.watch();
  }

  start(): void {
    const key = P.currentThread();
    if (key) store.get(key, true);
    this.tick();
    this.sidebar.decorate();
    this.transcript.schedule();
  }

  dispose(): void {
    this.sidebar.dispose();
    this.transcript.dispose();
    this.evolution.close();
  }
}

P.Partners = Partners;
P.Evolution = Evolution;
