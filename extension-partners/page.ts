// Starts the partners once the sprite CSS has loaded, and tears everything down for hot reload.
declare const cinnamon: {
  settings: { get(key: string): unknown; onChange(fn: (all: Record<string, unknown>) => void): void };
  onDispose(fn: () => void): void;
};
const N = (window as any).__pkp;

let partners: any = null;
let trainerArt: any = null;
let settingsRow: any = null;
let ticker = 0;
let attempts = 0;

function boot(): void {
  if (N.rt.disposed) return;
  if (!N.assets.load()) {
    if (attempts++ < 80) N.later(boot, 250);
    return;
  }
  N.applyScale();
  trainerArt = new N.TrainerArt();
  trainerArt.update();
  settingsRow = new N.SettingsRow();
  N.listen(document, 'click', (event: MouseEvent) => {
    const sprite = (event.target as Element | null)?.closest?.('.pkp-tr') as HTMLElement | null;
    if (!sprite) return;
    event.preventDefault();
    event.stopPropagation();
    settingsRow.openModal(sprite);
  }, true);
  N.listen(document, 'keydown', (event: KeyboardEvent) => {
    const sprite = (event.target as Element | null)?.closest?.('.pkp-tr') as HTMLElement | null;
    if (!sprite || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    settingsRow.openModal(sprite);
  }, true);
  N.listen(window, 'pe-open-trainer-customize', () => settingsRow.openModal(null));
  // the trainer walks in place while hovered or focused; a hidden page pauses it
  const walk = (on: boolean) => (event: Event) => {
    const sprite = (event.target as Element | null)?.closest?.('.pkp-tr') as HTMLElement | null;
    if (!sprite) return;
    const related = (event as PointerEvent).relatedTarget as Node | null;
    if (!on && related && sprite.contains(related)) return;
    sprite.toggleAttribute('data-walk', on || sprite === document.activeElement);
  };
  N.listen(document, 'pointerover', walk(true), true);
  N.listen(document, 'pointerout', walk(false), true);
  N.listen(document, 'focusin', walk(true), true);
  N.listen(document, 'focusout', (event: FocusEvent) => {
    const sprite = (event.target as Element | null)?.closest?.('.pkp-tr') as HTMLElement | null;
    if (sprite && !sprite.matches(':hover')) sprite.removeAttribute('data-walk');
  }, true);
  const hidden = () => document.documentElement.toggleAttribute('data-pkp-hidden', document.hidden);
  N.listen(document, 'visibilitychange', hidden);
  hidden();
  N.cleanups.push(() => document.documentElement.removeAttribute('data-pkp-hidden'));
  partners = new N.Partners();
  partners.start();
  ticker = window.setInterval(N.guard(() => {
    N.applyScale();
    partners.tick();
    settingsRow.tick();
  }), 1000);
}

N.listen(window, 'resize', () => {
  N.applyScale();
  partners?.transcript.schedule();
  partners?.sidebar.schedule();
});
cinnamon.settings.onChange(N.guard(() => {
  trainerArt?.update();
  partners?.transcript.schedule();
}));

// for QA: __pkp.debug.evolve() plays the next evolution of the open thread without saving it; shiny() and open()
// force a shiny partner and open the summary or naming screen for the open thread (session only)
N.debug = {
  state: () => ({ thread: N.currentThread(), entries: N.store.snapshot(), busy: partners?.transcript.busy, errors: N.errors, scale: N.scale }),
  evolve: () => {
    const key = N.currentThread();
    if (!key || !partners) return null;
    const entry = N.store.get(key);
    const from = N.store.species(key);
    const stage = N.stageFor(N.store.level(key));
    let to = from;
    for (let s = stage + 1; s <= N.EVOLVE_AT.length && to === from; s++) to = N.speciesAt(key, entry[0], s);
    if (to === from) return null;
    partners.evolution.play(from, to, N.store.nickname(key), N.mon(key)?.shiny);
    return [N.assets.name(from), N.assets.name(to)];
  },
  // plays the level-up moment into the open thread's current level, without saving any EXP
  levelUp: () => {
    const key = N.currentThread();
    const m = key ? N.mon(key) : null;
    if (!m || m.level <= 1) return null;
    N.levelUp(key, m.expThis - Math.max(1, Math.floor((m.expThis - (m.level - 1) ** 3) / 4)), () => {});
    return m.level;
  },
  // plays the shiny sparkle on the open summary's picture, else on the open thread's sidebar sprite
  sparkle: () => {
    if (N.summary.node) return N.summary.sparkle();
    const key = N.currentThread();
    const icon = key && document.querySelector(`[data-row-key="${CSS.escape(key)}"] .pkp-ri`);
    if (!icon) return null;
    const r = icon.getBoundingClientRect();
    return N.sparkle({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, N.scale.big);
  },
  // the reply-finished cry for the open thread as a background finish; shiny forces the sparkle, then restores
  cry: async (shiny = false) => {
    const key = N.currentThread();
    if (!key || !partners) return null;
    const had = N.shinyOverride.has(key);
    if (shiny) N.shinyOverride.add(key);
    const from = N.cryLog.length;
    partners.reply(key, false, 'Done');
    await new Promise((done) => N.later(done, 2500));
    if (!had) N.shinyOverride.delete(key);
    return N.cryLog.slice(from);
  },
  shiny: (on = true) => {
    const key = N.currentThread();
    if (!key) return false;
    if (on) N.shinyOverride.add(key);
    else N.shinyOverride.delete(key);
    return N.mon(key)?.shiny;
  },
  open: (page = 0, select = -1) => {
    const key = N.currentThread();
    if (!key) return null;
    N.summary.open(key, page);
    if (select >= 0) {
      N.summary.selecting = select;
      N.summary.render();
    }
    return N.mon(key);
  },
  name: () => N.naming.open(N.currentThread()),
  // visibility check, run with the guard after every sync: the partner shows beside the assistant reply, beside
  // the working status while busy, in the sidebar and in the header, and the trainer beside user messages
  visible: () => {
    const shown = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return !(el as HTMLElement).hidden && r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    };
    const out: string[] = [];
    const rows = [...document.querySelectorAll('[data-testid="transcript-row"]')];
    // exactly one partner per assistant turn (rows between two user messages), on the live status row while running
    const turns: Element[][] = [[]];
    const typed = (row: Element) => row.getAttribute('data-perf-row') === 'human' && !!row.querySelector('[data-testid="user-message"]');
    for (const row of rows) {
      if (typed(row)) turns.push([]);
      else turns[turns.length - 1].push(row);
    }
    turns.forEach((turn, t) => {
      if (!turn.some((r) => r.getAttribute('data-perf-row') === 'assistant')) return;
      const count = turn.reduce((n, r) => n + [...r.querySelectorAll(':scope > .pkp-av')].filter(shown).length, 0);
      const extra = turn.reduce((n, r) => n + r.querySelectorAll('.pkp-av').length, 0);
      out.push(count === 1 && extra === 1 ? `ok turn ${t}: one partner (${turn.length} rows)` : `FAIL turn ${t}: ${count} visible partners, ${extra} in the DOM`);
    });
    const live = [...document.querySelectorAll('[data-cds="TurnStatus"]:not([data-state="done"])')].map((x) => x.closest('[data-testid="transcript-row"]')).find((r) => r?.getAttribute('data-perf-row') === 'assistant');
    if (partners?.transcript.busy && live) out.push(shown(live.querySelector(':scope > .pkp-av')) ? 'ok partner on the live status row' : 'FAIL partner not on the live status row');
    else out.push('note: no turn running now');
    if (document.querySelectorAll('.pkp-av').length > turns.length) out.push('FAIL more partner sprites than turns');
    out.push([...document.querySelectorAll('.pkp-ri')].some(shown) ? 'ok sidebar row sprite' : 'FAIL sidebar row sprite');
    // sidebar: title starts one gap past the icon on every row type, within half a font px either way
    const gaps = [...document.querySelectorAll<HTMLElement>('.pkp-ri')].filter(shown).map((icon) => {
      const label = icon.parentElement?.querySelector('[data-row-label]');
      return label ? (label.getBoundingClientRect().left - icon.getBoundingClientRect().right) / N.scale.big : NaN;
    }).filter((g) => !Number.isNaN(g));
    const bad = gaps.filter((g) => g < 7.5 || g > 8.5);
    out.push(bad.length ? `FAIL sidebar sprite to title gap ${bad.map((g) => g.toFixed(2)).join(', ')} font px` : `ok sidebar sprite to title gap 8 font px on ${gaps.length} rows`);
    out.push(shown(document.querySelector('.pkp-ht')) ? 'ok header sprite' : 'FAIL header sprite');
    const users = rows.filter(typed);
    const injected = rows.filter((r) => r.getAttribute('data-perf-row') === 'human' && !typed(r));
    out.push(injected.some((r) => r.querySelector('.pkp-tr')) ? 'FAIL trainer on an injected row' : `ok no trainer on ${injected.length} injected rows`);
    // every sprite inside its own row; trainer labels inside the row too; partner to content gap at least 3 font px
    const u = N.scale.big;
    for (const sprite of document.querySelectorAll<HTMLElement>('.pkp-av, .pkp-tr')) {
      if (!shown(sprite)) continue;
      const row = sprite.parentElement!.getBoundingClientRect();
      const r = sprite.getBoundingClientRect();
      if (r.top < row.top - 0.5 || r.bottom > row.bottom + 0.5) out.push(`FAIL ${sprite.className} box leaves its row`);
      if (sprite.matches('.pkp-tr') && !sprite.hasAttribute('data-no-label')) {
        const labelBottom = r.bottom + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pe-lh-small')) || 14) + u;
        if (labelBottom > row.bottom + 0.5) out.push('FAIL trainer label leaves its row');
      }
      if (sprite.matches('.pkp-av')) {
        const holder = sprite.parentElement!;
        const inner = holder.querySelector('[data-transcript-row]');
        const pad = inner ? parseFloat(getComputedStyle(inner).paddingInlineStart) || 0 : 0;
        const content = inner ? inner.getBoundingClientRect().left + pad : null;
        const spx = sprite.hasAttribute('data-small') ? N.scale.small : u;
        if (content !== null && content - (r.right + 3 * spx) < 3 * spx - 0.6) out.push(`FAIL partner closer than 3 font px to its row content`);
      }
    }
    if (users.length) out.push(users.every((r) => r.querySelectorAll('.pkp-tr').length === 1 && shown(r.querySelector(':scope > .pkp-tr'))) ? `ok exactly one trainer on each of ${users.length} user messages` : 'FAIL trainer count on user messages');
    out.push(document.querySelectorAll('.pkp-ht').length === 1 ? 'ok one header sprite' : 'FAIL header sprite count');
    return out;
  },
  // overlap guard: every summary page and move selection, every naming page, row and button, at the smallest,
  // default and largest popup scale; returns each intersection (cursor, text, control, window edge) it finds
  guard: async () => {
    const key = N.currentThread();
    if (!key) return ['no open thread'];
    const out: string[] = [];
    const s = N.summary;
    const wasOpen = !!s.node;
    s.open(key, 0);
    const states: Array<[number, number]> = [[0, -1], [1, -1], [2, -1], [2, 0], [2, 1], [2, 2], [2, 3]];
    const scales: Array<number | null> = [1, null, 9];
    for (const n of scales) {
      s.nOverride = n;
      s.layout();
      const tag = n === null ? `default ${s.node.dataset.scale}` : `n=${n}`;
      const bar = s.node.querySelector('.pkp-popup-title');
      const parts = [...bar.querySelectorAll('.pkp-popup-label, .pkp-sound-mute, .pkp-popup-close')].map((el: Element) => [el.className, el.getBoundingClientRect()] as const);
      parts.forEach(([a, ra], i) => parts.slice(i + 1).forEach(([b, rb]) => {
        if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) out.push(`${tag} title bar: ${a} touches ${b}`);
      }));
      for (const [page, sel] of states) {
        const count = N.mon(key).moves.length;
        if (sel >= count) continue;
        s.page = page;
        s.selecting = sel;
        await s.render();
        out.push(...N.auditBoxes(`${tag} summary page ${page}${sel >= 0 ? ` move ${sel + 1}` : ''}`, s.screen.boxes));
      }
      N.naming.open(key);
      for (let page = 0; page < 3; page++) {
        N.naming.page = page;
        for (let y = 0; y < 4; y++) {
          const cols = page === 2 ? 6 : 8;
          for (let x = 0; x < cols; x++) {
            Object.assign(N.naming, { onButtons: false, x, y });
            await N.naming.render();
            out.push(...N.auditBoxes(`${tag} naming page ${page} key ${y},${x}`, N.naming.screen.boxes));
          }
        }
        for (let y = 0; y < 3; y++) {
          Object.assign(N.naming, { onButtons: true, y });
          await N.naming.render();
          out.push(...N.auditBoxes(`${tag} naming page ${page} button ${y}`, N.naming.screen.boxes));
        }
      }
      N.naming.close(false);
    }
    s.nOverride = null;
    s.page = 0;
    s.selecting = -1;
    s.layout();
    if (wasOpen) await s.render();
    else s.close();
    // message avatars and the trainer's name label stay inside the transcript column and its scroll container
    const scroller = document.querySelector('[data-testid="epitaxy-virtual-transcript"]')?.getBoundingClientRect();
    const inside = (r: { left: number; right: number; top: number; bottom: number }, c: DOMRect) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
    document.querySelectorAll<HTMLElement>('.pkp-tr').forEach((tr) => {
      const sprite = tr.getBoundingClientRect();
      const column = tr.parentElement?.querySelector('[data-cds="UserMessage"]')?.getBoundingClientRect();
      const labelW = Number(tr.dataset.labelW) || 0;
      const mid = sprite.left + sprite.width / 2;
      const label = { left: mid - labelW / 2, right: mid + labelW / 2, top: sprite.bottom, bottom: sprite.bottom };
      if (column && (!inside(sprite, column) || !inside(label, column))) out.push(`trainer "${tr.dataset.name}" leaves its message column`);
      if (scroller && (!inside(sprite, scroller) || !inside(label, scroller))) out.push(`trainer "${tr.dataset.name}" leaves the transcript`);
    });
    document.querySelectorAll<HTMLElement>('.pkp-av').forEach((av) => {
      if (av.hidden) return;
      const r = av.getBoundingClientRect();
      const row = av.parentElement?.getBoundingClientRect();
      if (row && !inside(r, row)) out.push('partner avatar leaves its transcript row');
      if (scroller && !inside(r, scroller)) out.push('partner avatar leaves the transcript');
    });
    // the customize dialog: header, pinned side column and the scrolling grid never overlap, at the grid's top,
    // middle and bottom; every visible trainer's art stays clear of its label
    const ownDialog = !document.querySelector('.pkp-trainer-modal');
    if (ownDialog) settingsRow?.openModal(null);
    const box = document.querySelector('.pkp-trainer-box');
    const grid = box?.querySelector<HTMLElement>('.pkp-set-scroll');
    if (box && grid) {
      const touch = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const winR = { left: 0, top: 0, right: innerWidth, bottom: innerHeight } as DOMRect;
      for (const [name, at] of [['top', 0], ['middle', 0.5], ['bottom', 1]] as const) {
        grid.scrollTop = (grid.scrollHeight - grid.clientHeight) * at;
        await new Promise((r) => requestAnimationFrame(r));
        const head = box.querySelector('.pkp-trainer-head')!.getBoundingClientRect();
        const side = box.querySelector('.pkp-set-side')!.getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        if (touch(head, g) || touch(head, side) || touch(side, g)) out.push(`dialog ${name}: header, side and grid overlap`);
        if (!inside(b, winR) || b.top < 0 || b.bottom > innerHeight) out.push(`dialog ${name}: leaves the app window`);
        const title = box.querySelector('.pkp-trainer-title')!.getBoundingClientRect();
        const done = box.querySelector('.pkp-trainer-head .pkp-set-open')!.getBoundingClientRect();
        if (touch(title, done)) out.push(`dialog ${name}: title touches Done`);
        box.querySelectorAll('.pkp-set-base').forEach((btn) => {
          const art = btn.querySelector('canvas')!.getBoundingClientRect();
          const label = btn.querySelector('span')!.getBoundingClientRect();
          if (art.bottom > label.top + 0.5) out.push(`dialog ${name}: ${btn.getAttribute('aria-label')} art touches label`);
        });
      }
      grid.scrollTop = 0;
    }
    if (ownDialog) settingsRow?.closeModal();
    const picker = [...document.querySelectorAll('.pkp-set-base')];
    picker.forEach((btn) => {
      const art = btn.querySelector('canvas')?.getBoundingClientRect();
      const label = btn.querySelector('span')?.getBoundingClientRect();
      if (art && label && art.bottom > label.top + 0.5) out.push(`picker ${btn.getAttribute('aria-label')}: art touches label`);
    });
    // hover card: the tail tip within 1 device px of the hovered sprite's centre, beside the sprite, inside the window
    const dpr = window.devicePixelRatio || 1;
    const kinds: Array<[string, (el: Element) => boolean]> = [
      ['card sprite', (el) => el.matches('.pkp-ri') && !!el.closest('[data-cm-card]')],
      ['line sprite', (el) => el.matches('.pkp-ri') && !el.closest('[data-cm-card]')],
      ['transcript sprite', (el) => el.matches('.pkp-av')],
    ];
    for (const [name, pick] of kinds) {
      const sprite = [...document.querySelectorAll('.pkp-ri, .pkp-av')].find((el) => {
        const r = el.getBoundingClientRect();
        return pick(el) && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight;
      });
      if (!sprite) continue;
      N.tooltip.show(sprite);
      const card = document.querySelector('.pkp-tip')?.getBoundingClientRect();
      const r = sprite.getBoundingClientRect();
      N.tooltip.hide(true);
      if (!card) { out.push(`hover card ${name}: no card`); continue; }
      const centre = r.top + r.height / 2;
      const off = Math.abs((card.bottom <= centre + 1 / dpr ? card.bottom : card.top) - centre) * dpr;
      const beside = card.left >= r.right || card.right <= r.left;
      const inside = card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight;
      if (off > 1 || !beside || !inside) out.push(`hover card ${name}: tail ${off.toFixed(2)} device px from sprite centre${beside ? '' : ', overlaps sprite'}${inside ? '' : ', outside window'}`);
    }
    // EXP: the bar's fill is 0..1 and the hover card, the summary EXP page and the stored EXP agree
    const m = N.mon(key);
    if (m) {
      const px = N.expPixels(m);
      const top = m.level >= N.MAX_LEVEL;
      if (px < 0 || px > 64 || m.exp < m.expThis || (!top && m.exp >= m.expNext)) out.push(`exp out of range: ${m.exp} at L${m.level} (${m.expThis}..${m.expNext}), ${px} px`);
      if (m.exp !== N.store.exp(key) || m.level !== N.levelForExp(m.exp)) out.push(`exp ${m.exp} L${m.level} disagrees with the store ${N.store.exp(key)}`);
      const shown = s.expShown;
      if (shown && (shown.exp !== m.exp || shown.next !== Math.max(0, m.expNext - m.exp) || shown.px !== px)) out.push(`summary EXP page shows ${JSON.stringify(shown)}, expected ${m.exp}/${m.expNext - m.exp}/${px}`);
      const sprite = [...document.querySelectorAll('.pkp-av, .pkp-ri')].find((el) => el.getBoundingClientRect().width > 0 && N.store && (el.closest('[data-row-key]')?.getAttribute('data-row-key') ?? key) === key);
      if (sprite) {
        N.tooltip.show(sprite);
        const fill = Number(document.querySelector<HTMLElement>('.pkp-tip .pkp-hb-exp')?.style.getPropertyValue('--fill'));
        N.tooltip.hide(true);
        if (!(fill >= 0 && fill <= 1) || Math.abs(fill - px / 64) > 1e-9) out.push(`hover card EXP fill ${fill}, expected ${px / 64}`);
      }
    }
    // hover walk: the trainer animates the walk strip in the same box, and stops on leave
    const trainer = document.querySelector<HTMLElement>('.pkp-tr');
    if (trainer) {
      const before = trainer.getBoundingClientRect();
      const had = trainer.hasAttribute('data-walk');
      trainer.setAttribute('data-walk', '');
      const cs = getComputedStyle(trainer);
      const after = trainer.getBoundingClientRect();
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced && (cs.animationName !== 'pkp-walk' || !cs.backgroundImage.startsWith('url("blob:'))) out.push(`trainer hover: animation ${cs.animationName}, image ${cs.backgroundImage.slice(0, 30)}`);
      if (before.width !== after.width || before.height !== after.height || before.left !== after.left || before.top !== after.top) out.push('trainer hover moves or resizes the sprite');
      if (!had) trainer.removeAttribute('data-walk');
      if (!had && getComputedStyle(trainer).animationName !== 'none') out.push('trainer keeps walking after leave');
    }
    const thumb = document.querySelector('.pkp-ht');
    if (thumb) {
      thumb.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      if (document.querySelector('.pkp-tip')) out.push('hover card opened on the header sprite');
      document.body.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      if (!thumb.getAttribute('aria-label')) out.push('header sprite has no accessible name');
    }
    return out.length ? out : ['clean'];
  },
  tip: (selector = '.pkp-av', ms = 8000) => {
    const target = [...document.querySelectorAll(selector)].find((el) => {
      const r = el.getBoundingClientRect();
      return r.top > 100 && r.bottom < innerHeight - 140 && r.width > 0;
    });
    if (!target) return null;
    N.tooltip.show(target);
    N.tooltip.pinnedUntil = Date.now() + ms;
    N.later(() => N.tooltip.hide(true), ms);
    return document.querySelector('.pkp-tip')?.getBoundingClientRect().toJSON();
  },
  close: () => N.summary.close(),
};

boot();

cinnamon.onDispose(() => {
  N.rt.disposed = true;
  clearInterval(ticker);
  for (const cleanup of N.cleanups) cleanup();
  for (const id of N.timers) clearTimeout(id);
  N.timers.clear();
  N.store.flush();
  partners?.dispose();
  settingsRow?.dispose();
  trainerArt?.dispose();
  N.assets.dispose();
  N.scaleStyle.remove();
  delete (window as any).__pkp;
});
