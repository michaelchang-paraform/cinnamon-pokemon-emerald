// Sidebar icons, the chat header thumbnail, message avatars, stream detection and the evolution moment.
const P = (window as any).__pkp;
const { rt, guard, later, cancel, listen, el, assets, store } = P;

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

function iconStyle(node: HTMLElement, num: number): void {
  const url = assets.url('i', num);
  const value = url ? `url("${url}")` : '';
  if (node.dataset.num !== String(num)) {
    node.dataset.num = String(num);
    node.style.setProperty('--pkp-img', value);
  }
}

// the line box of the first visible text inside an element, for centring a sprite on it
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

  constructor(private readonly onReply: (key: string) => void) {}

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
    const rows = [...document.querySelectorAll<HTMLElement>(`${ROWS} [data-row]:not([data-cm-card])`)].filter((r) => r.offsetHeight > 0);
    const ref = rows[0] ?? document.querySelector<HTMLElement>(`${ROWS} [data-row]`);
    const button = ref?.querySelector<HTMLElement>('[data-row-main-button]');
    if (!ref || !button) return null;
    return button.getBoundingClientRect().left - ref.getBoundingClientRect().left + (parseFloat(getComputedStyle(button).paddingInlineStart) || 0);
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
      if (x !== null) {
        const dpr = window.devicePixelRatio || 1;
        const rowLeft = row.getBoundingClientRect().left;
        const left = `${(Math.round((rowLeft + x) * dpr) / dpr - rowLeft).toFixed(4)}px`;
        if (icon.style.left !== left) icon.style.left = left;
      }
      // centred on the title line, wherever the theme and sidebar-cards put it in the card
      const label = row.querySelector<HTMLElement>('[data-row-label]');
      if (label && row.offsetHeight) {
        const top = `${(label.offsetTop + label.offsetHeight / 2).toFixed(1)}px`;
        if (icon.style.top !== top) icon.style.top = top;
      }
      iconStyle(icon, store.species(key));
    }
  }

  // background threads: the row's status going from Running to anything else is one reply
  private trackStatus(key: string, rowKey: Element, open: string | null): void {
    const label = rowKey.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? '';
    const before = this.status.get(key);
    this.status.set(key, label);
    if (before === 'Running' && label && label !== 'Running' && key !== open) this.onReply(key);
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

  constructor(private readonly onReply: (key: string) => void) {}

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
    let lastRun: HTMLElement | null = null;
    for (const row of rows) {
      const kind = row.getAttribute('data-perf-row');
      const prev = row.previousElementSibling?.matches(T_ROW) ? row.previousElementSibling.getAttribute('data-perf-row') : null;
      const wantsAv = kind === 'assistant' && prev !== 'assistant';
      const wantsTr = kind === 'human' && !!row.querySelector('[data-cds="UserMessage"]');
      this.place(row, 'pkp-av', wantsAv ? num : null);
      this.place(row, 'pkp-tr', wantsTr ? 1 : null);
      if (wantsAv) lastRun = row;
    }
    const lastHuman = rows.filter((r) => r.getAttribute('data-perf-row') === 'human').pop();
    for (const av of this.root.querySelectorAll<HTMLElement>('.pkp-av')) {
      const row = av.parentElement!;
      const talking = this.busy && row === lastRun && (!lastHuman || !!(lastHuman.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING));
      av.toggleAttribute('data-talking', talking);
    }
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
    const target = cls === 'pkp-av' ? row.querySelector('[data-transcript-row]') ?? row.firstElementChild : row.querySelector('[data-cds="UserMessage"]');
    if (!target) return;
    const box = target.getBoundingClientRect();
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
    const w = (cls === 'pkp-av' ? 24 : 16) * unit;
    const gutter = cls === 'pkp-av' ? box.left - rowRect.left : rowRect.right - box.right;
    const fits = gutter >= w + 2;
    node.toggleAttribute('data-small', !fits);
    const width = fits ? w : (cls === 'pkp-av' ? 24 : 16) * P.scale.small;
    node.hidden = gutter < width + 1;
    const gap = Math.max(1, Math.min(4, (gutter - width) / 2));
    const left = cls === 'pkp-av' ? box.left - rowRect.left - width - gap : box.right - rowRect.left + gap;
    // a partner sits centred on the first line of text it belongs to; the trainer lines up with its message frame
    const line = cls === 'pkp-av' ? firstLine(target) : null;
    const height = (cls === 'pkp-av' ? 24 : 32) * (fits ? unit : P.scale.small);
    const top = line ? line.top + line.height / 2 - height / 2 : box.top;
    const dot = 1 / (window.devicePixelRatio || 1);
    node.style.left = `${left.toFixed(2)}px`;
    node.style.top = `${(Math.round((top - rowRect.top) / dot) * dot).toFixed(4)}px`;
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
    node.removeAttribute('data-small');
    node.hidden = false;
    node.dataset.labelW = String(labelW);
    const dot = 1 / (window.devicePixelRatio || 1);
    const snap = (v: number) => (Math.round(v / dot) * dot).toFixed(4);
    node.style.left = `${snap(box.right - rowRect.left - col / 2 - spriteW / 2)}px`;
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
      thumb.setAttribute('aria-hidden', 'true');
      h2.before(thumb);
    }
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
      P.jingle();
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

class Partners {
  sidebar = new Sidebar((key) => this.reply(key, false));
  transcript = new Transcript((key) => this.reply(key, true));
  evolution = new Evolution();
  private path = location.pathname;

  reply(key: string, open: boolean): void {
    const { before, after } = store.addReply(key);
    if (before === after) return;
    this.sidebar.refresh();
    this.transcript.refresh();
    if (open && key === P.currentThread()) this.evolution.play(before, after, store.nickname(key), P.mon?.(key)?.shiny);
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
