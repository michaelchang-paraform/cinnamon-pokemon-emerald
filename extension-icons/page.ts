type Entry = { a: string; s?: string; m?: string; l?: string };
type Table = { m: Record<string, Entry>; d: Record<string, [number, number]> };
type Plan = { el: HTMLElement; name: string | null; rel: boolean; dx: string; dy: string };

// the app draws icons as private-use glyphs of its icon font inside this element
const ICON = '[data-cds="Icon"]';
const REFRESH_MS = 250;
// menus and panes animate in: plan new icons again once they have stopped moving
const SETTLE_MS = 400;

let table: Table = { m: {}, d: {} };
let tableRaw = '';
let disposed = false;
let mapTimer = 0;
let mapAttempts = 0;
let frame = 0;
let refreshTimer = 0;
let watchedScale: Element | null = null;
const pending = new Set<Element>();

// connector and app logos: brand images that stay as they are, apart from an optional bitcrush filter
const LOGO = [
  'table[aria-label="Connectors"] [role="rowheader"] :is(img, svg)',
  'aside[aria-label="Session details"] section[data-cds="Collapsible"] img',
].join(',');
const LOGO_MAX_PX = 48;
const CRUSH_ID = 'pi-crush';
// cell in device pixels (font: device pixels in one font pixel) and colour levels per channel.
// a 16 px logo is about 12, 9, 7 and 6 cells across at these levels when a font pixel is 3 device pixels
const CRUSH: Record<string, { cell: (font: number) => number; levels: number }> = {
  light: { cell: (font) => font, levels: 5 },
  medium: { cell: (font) => font + 1, levels: 4 },
  heavy: { cell: (font) => font + 2, levels: 3 },
  max: { cell: (font) => font * 2, levels: 2 },
};
const CRUSH_DEFAULT = 'medium';
const logoPending = new Set<Element>();
let crushKey = '';
let crushHost: SVGSVGElement | null = null;

const crushLevel = (): string => {
  const saved = cinnamon.settings.get('logos');
  return saved === undefined || saved === null ? CRUSH_DEFAULT : String(saved);
};

// pixelate: keep one device pixel per cell (flood, tile, composite in), then grow it to fill the cell.
// posterize: discrete steps per colour channel, alpha left alone so soft edges do not fringe.
function crushMarkup(cells: number, levels: number, dpr: number): string {
  const d = 1 / dpr;
  const px = (n: number) => (n * d).toFixed(5);
  const sample = Math.floor((cells - 1) / 2);
  const odd = cells % 2 === 1;
  const grow = odd ? (cells - 1) / 2 : cells / 2 - 1;
  const steps = Array.from({ length: levels }, (_, i) => (i / (levels - 1)).toFixed(4)).join(' ');
  const parts = [
    `<feFlood x="${px(sample)}" y="${px(sample)}" width="${px(1)}" height="${px(1)}"/>`,
    `<feComposite width="${px(cells)}" height="${px(cells)}"/>`,
    '<feTile result="grid"/>',
    '<feComposite in="SourceGraphic" in2="grid" operator="in" result="dots"/>',
  ];
  if (grow > 0) parts.push(`<feMorphology in="dots" operator="dilate" radius="${px(grow)}" result="dots"/>`);
  // a dilate only makes odd sizes: an even cell needs the block shifted by one device pixel and merged
  if (!odd) {
    parts.push(
      `<feOffset in="dots" dx="${px(1)}" dy="0" result="east"/>`,
      `<feOffset in="dots" dx="0" dy="${px(1)}" result="south"/>`,
      `<feOffset in="dots" dx="${px(1)}" dy="${px(1)}" result="both"/>`,
      '<feMerge result="dots"><feMergeNode in="dots"/><feMergeNode in="east"/><feMergeNode in="south"/><feMergeNode in="both"/></feMerge>',
    );
  }
  parts.push(`<feComponentTransfer in="dots"><feFuncR type="discrete" tableValues="${steps}"/><feFuncG type="discrete" tableValues="${steps}"/><feFuncB type="discrete" tableValues="${steps}"/></feComponentTransfer>`);
  return `<filter id="${CRUSH_ID}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
}

function paintLogo(el: Element, on: boolean): void {
  const style = (el as HTMLElement | SVGElement).style;
  if (on) {
    el.setAttribute('data-pi-logo', '');
    style.setProperty('filter', `url(#${CRUSH_ID})`);
  } else if (el.hasAttribute('data-pi-logo')) {
    el.removeAttribute('data-pi-logo');
    style.removeProperty('filter');
  }
}

// rebuilds the filter when the level or the scale changes, and repaints the logos already tagged
function syncCrush(): void {
  const level = CRUSH[crushLevel()];
  const dpr = window.devicePixelRatio || 1;
  const themed = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pe-px'));
  const font = Math.max(1, Math.round((themed > 0 ? themed : fallbackCell(dpr)) * dpr));
  const key = level ? `${level.cell(font)}|${level.levels}|${dpr}` : 'off';
  if (key === crushKey) return;
  crushKey = key;
  if (!level) {
    crushHost?.remove();
    crushHost = null;
    for (const el of document.querySelectorAll('[data-pi-logo]')) paintLogo(el, false);
    return;
  }
  if (!crushHost) {
    crushHost = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    crushHost.setAttribute('aria-hidden', 'true');
    crushHost.setAttribute('data-pi-filters', '');
    crushHost.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    document.body.append(crushHost);
  }
  crushHost.innerHTML = crushMarkup(level.cell(font), level.levels, dpr);
  for (const el of document.querySelectorAll(LOGO)) logoPending.add(el);
}
const settling = new Set<Element>();
let settleTimer = 0;

const fallbackStyle = document.createElement('style');
fallbackStyle.setAttribute('data-pi-scale', '');
document.head.append(fallbackStyle);

const motifs = () => cinnamon.settings.get('motifs') !== false;

// without the theme there is no --pe-px: use round(dpr * 1.2) device pixels per cell
const fallbackCell = (dpr: number) => Math.max(1, Math.round(dpr * 1.2)) / dpr;

function applyFallback(): void {
  const next = `:root{--pi-px-fallback:${fallbackCell(window.devicePixelRatio || 1).toFixed(6)}px}`;
  if (fallbackStyle.textContent !== next) fallbackStyle.textContent = next;
}

// reads only: which art fits this icon, and the nudge that lands it on whole device pixels
function plan(el: HTMLElement, dpr: number): Plan {
  const none: Plan = { el, name: null, rel: false, dx: '', dy: '' };
  const text = el.textContent ?? '';
  const entry = [...text].length === 1 ? table.m[text.codePointAt(0)!.toString(16)] : undefined;
  if (!entry) return none;
  const styles = getComputedStyle(el);
  // our art sits on ::before, so a mask on the element itself is the theme's own pixel icon
  const mask = styles.maskImage || styles.getPropertyValue('-webkit-mask-image');
  if (mask && mask !== 'none') return none;
  // --pe-px is read here, not on :root: the theme re-declares it inside prose, user bubbles and the composer
  const themed = parseFloat(styles.getPropertyValue('--pe-px'));
  const cell = themed > 0 ? themed : fallbackCell(dpr);
  // layout size, not the rect: a menu that scales in would make the box look too small for its art
  const box = el.offsetWidth > 0 && el.offsetHeight > 0 ? Math.min(el.offsetWidth, el.offsetHeight) : parseFloat(styles.fontSize);
  const rect = el.getBoundingClientRect();
  const fits = (name: string | undefined | false): name is string => {
    const size = name ? table.d[name] : undefined;
    return !!size && Math.max(size[0], size[1]) * cell <= box + 0.01;
  };
  // art wider than the icon box would overflow it: fall back to smaller art, then to the app's glyph
  const motif = motifs() && entry.m && (!entry.l || el.closest(`[aria-label="${entry.l}"]`)) ? entry.m : undefined;
  const name = [motif, entry.a, entry.s].find(fits);
  if (!name) return none;
  const rel = el.hasAttribute('data-pi-rel') || styles.position === 'static';
  // a transformed icon (mirrored for right-to-left) has no stable pixel origin to snap to
  if (!rect.width || styles.transform !== 'none') return { el, name, rel, dx: '0px', dy: '0px' };
  const [cols, rows] = table.d[name];
  const left = rect.left + rect.width / 2 - (cols * cell) / 2;
  const top = rect.top + rect.height / 2 - (rows * cell) / 2;
  return {
    el,
    name,
    rel,
    dx: `${(Math.round(left * dpr) / dpr - left).toFixed(4)}px`,
    dy: `${(Math.round(top * dpr) / dpr - top).toFixed(4)}px`,
  };
}

function clear(el: HTMLElement): void {
  if (el.hasAttribute('data-pi-rel')) el.removeAttribute('data-pi-rel');
  if (!el.hasAttribute('data-pi')) return;
  el.removeAttribute('data-pi');
  el.style.removeProperty('--pi-dx');
  el.style.removeProperty('--pi-dy');
}

function write({ el, name, rel, dx, dy }: Plan): void {
  if (!name) return clear(el);
  if (el.getAttribute('data-pi') !== name) el.setAttribute('data-pi', name);
  if (rel !== el.hasAttribute('data-pi-rel')) el.toggleAttribute('data-pi-rel', rel);
  if (el.style.getPropertyValue('--pi-dx') !== dx) el.style.setProperty('--pi-dx', dx);
  if (el.style.getPropertyValue('--pi-dy') !== dy) el.style.setProperty('--pi-dy', dy);
}

// every read first, then every write, so one batch costs one layout
function flush(): void {
  frame = 0;
  if (disposed) return;
  const dpr = window.devicePixelRatio || 1;
  const batch = [...pending].filter((el) => el.isConnected) as HTMLElement[];
  pending.clear();
  const plans: Plan[] = [];
  for (const el of batch) {
    try {
      plans.push(plan(el, dpr));
    } catch {}
  }
  // logos: small images only, so a large picture in the same container is never filtered
  const crushing = crushKey !== 'off' && crushKey !== '';
  const logos = [...logoPending].filter((el) => el.isConnected).map((el) => {
    const rect = el.getBoundingClientRect();
    return { el, on: crushing && rect.width > 0 && rect.width <= LOGO_MAX_PX && rect.height <= LOGO_MAX_PX };
  });
  logoPending.clear();
  for (const item of plans) {
    try {
      write(item);
    } catch {}
  }
  for (const logo of logos) {
    try {
      paintLogo(logo.el, logo.on);
    } catch {}
  }
  settle(batch);
}

function settle(batch: Element[]): void {
  const fresh = batch.filter((el) => !settling.has(el));
  if (!fresh.length) {
    for (const el of batch) settling.delete(el);
    return;
  }
  for (const el of fresh) settling.add(el);
  if (settleTimer) return;
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    for (const el of settling) pending.add(el);
    if (pending.size && !frame) frame = requestAnimationFrame(flush);
  }, SETTLE_MS);
}

function queue(root: Node | null): void {
  if (!(root instanceof Element) && !(root instanceof Document)) return;
  if (root instanceof Element && root.matches(ICON)) pending.add(root);
  for (const el of root.querySelectorAll(ICON)) pending.add(el);
  if (root instanceof Element && root.matches(LOGO)) logoPending.add(root);
  for (const el of root.querySelectorAll(LOGO)) logoPending.add(el);
  if ((pending.size || logoPending.size) && !frame) frame = requestAnimationFrame(flush);
}

const observer = new MutationObserver((records) => {
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    // a replaced or edited text node changes the glyph of the icon that holds it
    queue(target?.closest(ICON) ?? null);
    for (const node of record.addedNodes) queue(node);
  }
});

// the theme rewrites this style element when its pixel multiple changes; it can load after this file
const scaleObserver = new MutationObserver(() => scheduleRefresh());
function watchScale(): void {
  const themeScale = document.querySelector('style[data-pe-scale]');
  if (!themeScale || themeScale === watchedScale) return;
  scaleObserver.disconnect();
  scaleObserver.observe(themeScale, { childList: true, characterData: true, subtree: true });
  watchedScale = themeScale;
}

function refresh(): void {
  if (disposed) return;
  applyFallback();
  watchScale();
  try {
    readTable();
    syncCrush();
  } catch {}
  queue(document);
}

function scheduleRefresh(): void {
  if (refreshTimer || disposed) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    refresh();
  }, REFRESH_MS);
}

// the stylesheet can be swapped after this file runs, so the table is re-read whenever its text changes
function readTable(): boolean {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--pi-map').trim();
  if (!raw) return false;
  if (raw === tableRaw) return true;
  table = JSON.parse(raw.replace(/^['"]|['"]$/g, ''));
  tableRaw = raw;
  return true;
}

function loadMap(): void {
  try {
    if (!readTable()) {
      if (!disposed && mapAttempts++ < 60) mapTimer = window.setTimeout(loadMap, 250);
      return;
    }
    refresh();
  } catch {}
}

// catches a body resize only: a sidebar toggle, a pane opening or a growing reply inside a
// viewport-sized shell does not fire it, so those nudges stay stale until the next refresh
const resizeObserver = new ResizeObserver(scheduleRefresh);
resizeObserver.observe(document.body);
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
// the theme's scale style can be added to the head after this file runs
const headObserver = new MutationObserver(scheduleRefresh);
headObserver.observe(document.head, { childList: true });
window.addEventListener('resize', scheduleRefresh);
// a scrolled list can come to rest on a fraction of a device pixel
document.addEventListener('scroll', scheduleRefresh, { capture: true, passive: true });
// settings.onChange has no unsubscribe, so refresh ignores calls after dispose
cinnamon.settings.onChange(refresh);
applyFallback();
loadMap();

cinnamon.onDispose(() => {
  disposed = true;
  observer.disconnect();
  scaleObserver.disconnect();
  resizeObserver.disconnect();
  headObserver.disconnect();
  pending.clear();
  window.removeEventListener('resize', scheduleRefresh);
  document.removeEventListener('scroll', scheduleRefresh, { capture: true });
  clearTimeout(settleTimer);
  settling.clear();
  clearTimeout(mapTimer);
  clearTimeout(refreshTimer);
  cancelAnimationFrame(frame);
  fallbackStyle.remove();
  crushHost?.remove();
  logoPending.clear();
  for (const el of document.querySelectorAll('[data-pi-logo]')) paintLogo(el, false);
  for (const el of document.querySelectorAll<HTMLElement>('[data-pi]')) clear(el);
});
