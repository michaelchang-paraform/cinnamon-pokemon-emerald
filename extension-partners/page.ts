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
    const stage = N.stageFor(entry[1]);
    let to = from;
    for (let s = stage + 1; s <= N.EVOLVE_AT.length && to === from; s++) to = N.speciesAt(key, entry[0], s);
    if (to === from) return null;
    partners.evolution.play(from, to, N.store.nickname(key), N.mon(key)?.shiny);
    return [N.assets.name(from), N.assets.name(to)];
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
    const picker = [...document.querySelectorAll('.pkp-set-base')];
    if (!picker.length) out.push('note: trainer picker not open, not measured');
    picker.forEach((btn) => {
      const art = btn.querySelector('canvas')?.getBoundingClientRect();
      const label = btn.querySelector('span')?.getBoundingClientRect();
      if (art && label && art.bottom > label.top + 0.5) out.push(`picker ${btn.getAttribute('aria-label')}: art touches label`);
    });
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
  N.closeAudio();
  delete (window as any).__pkp;
});
