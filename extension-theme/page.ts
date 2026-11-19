type FontSource = { family: string; property: string; file: string };
type FontFaceSpec = { family: string; property: string; descriptors: FontFaceDescriptors };

const FONT_SOURCES: FontSource[] = [
  { family: 'Pokemon Emerald', property: '--pe-font-emerald', file: 'PokemonEmeraldPro.woff2' },
  { family: 'PE Departure Mono', property: '--pe-font-mono', file: 'DepartureMono-Keys.woff2' },
  { family: 'PE Symbols', property: '--pe-font-symbols', file: 'DepartureSymbols.woff2' },
];
const HANGUL_SOURCE = { property: '--pe-font-galmuri', file: 'Galmuri9-Hangul.woff2', css: 'fonts-hangul.css' };
const HANGUL_RANGE = 'U+1100-11FF, U+2190-21FF, U+2300-23FF, U+3000-303F, U+3130-318F, U+AC00-D7A3';
// Emerald em = 16 font px: ascent 13 + descent 4 gives a 17 px line with the 9 px caps 4 px from each edge, so caps sit centred on whole pixels
// Galmuri9 em = 10 font px, Departure Mono em = 11: size-adjust lands Hangul and symbols on the same pixel grid
const FONT_FACES: FontFaceSpec[] = [
  { family: 'Pokemon Emerald', property: '--pe-font-emerald', descriptors: { display: 'block', ascentOverride: '81.25%', descentOverride: '25%', lineGapOverride: '0%' } },
  { family: 'PE Departure Mono', property: '--pe-font-mono', descriptors: { display: 'block' } },
  { family: 'PE Galmuri', property: HANGUL_SOURCE.property, descriptors: { display: 'block', unicodeRange: HANGUL_RANGE, sizeAdjust: '62.5%', ascentOverride: '130%', descentOverride: '40%', lineGapOverride: '0%' } },
  { family: 'PE Galmuri Mono', property: HANGUL_SOURCE.property, descriptors: { display: 'block', unicodeRange: HANGUL_RANGE, sizeAdjust: '90.9091%' } },
  // Departure Mono for text that takes the app's mono font at the body size: 11/16 puts its pixels on the Emerald grid
  { family: 'PE Departure Mono Fit', property: '--pe-font-mono', descriptors: { display: 'block', sizeAdjust: '68.75%', ascentOverride: '118.1818%', descentOverride: '36.3636%', lineGapOverride: '0%' } },
  { family: 'PE Symbols', property: '--pe-font-symbols', descriptors: { display: 'block', unicodeRange: 'U+2190-21FF, U+2300-23FF', sizeAdjust: '68.75%', ascentOverride: '118.1818%', descentOverride: '36.3636%', lineGapOverride: '0%' } },
];
const PARTNERS = ['mudkip', 'treecko', 'torchic'];
const TARGET = [
  'button',
  'a[href]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  'summary',
].join(',');
const HOME = '[data-testid="sidebar"] [aria-current="page"]';
const SEND = '[data-testid="code-prompt-send"], [data-testid="code-prompt-send-cell"] button, button[aria-label="Send" i]';
const CURSOR_ART = { w: 6, h: 10, gap: 1 };

const disposers: Array<() => void> = [];
const guard = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
  try {
    fn(...args);
  } catch {}
};
const listen = (target: EventTarget, type: string, fn: (event: Event) => void, options?: AddEventListenerOptions | boolean) => {
  const handler = guard(fn);
  target.addEventListener(type, handler, options);
  disposers.push(() => target.removeEventListener(type, handler, options));
};

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const cssString = (styles: CSSStyleDeclaration, property: string) => styles.getPropertyValue(property).trim().replace(/^["']|["']$/g, '');

const faces: FontFace[] = [];
let fontTimer = 0;
let fontAttempts = 0;
let disposed = false;

async function loadFonts(): Promise<void> {
  try {
    const styles = getComputedStyle(document.documentElement);
    const data = new Map(FONT_FACES.map((spec) => [spec.property, cssString(styles, spec.property)]));
    if ([...data.values()].some((text) => !text)) {
      if (!disposed && fontAttempts++ < 60) fontTimer = window.setTimeout(() => void loadFonts(), 250);
      return;
    }
    const bytes = new Map([...data].map(([property, text]) => [property, decodeBase64(text)]));
    for (const spec of FONT_FACES) {
      const face = new FontFace(spec.family, bytes.get(spec.property)!, spec.descriptors);
      await face.load();
      if (disposed) return;
      document.fonts.add(face);
      faces.push(face);
    }
  } catch {}
}

const scaleStyle = document.createElement('style');
scaleStyle.setAttribute('data-pe-scale', '');
document.head.append(scaleStyle);

let artPx = 1.5;
let dot = 0.5;

const TEXT_SIZES = { classic: 'Classic', 'large-chat': 'Large chat', large: 'Large' } as const;
type TextSize = keyof typeof TEXT_SIZES;
const CHAT = ':is([data-cds="Prose"], [class~="group/bubble"]:has([data-testid="user-message"]), [data-cds-part="composer-card"])';
const CHAT_UNITS = {
  '--pe-p': 'var(--pe-px)',
  '--pe-b': 'var(--pe-bpx)',
  '--pe-ps': 'var(--pe-px-small)',
  '--pe-ctl': 'calc(var(--pe-px) * 21)',
  '--pe-frame-w': 'calc(var(--pe-bpx) * 8)',
};

function textSize(): TextSize {
  const saved = cinnamon.settings.get('textSize');
  return typeof saved === 'string' && saved in TEXT_SIZES ? (saved as TextSize) : 'classic';
}

function scaleVars(k: number): Record<string, string> {
  const small = Math.max(1, k - 1);
  const px = (n: number) => `${(n * dot).toFixed(6)}px`;
  return {
    // border widths floor to device px, so this one rounds up to Chrome's 1/64 CSS px layout unit
    '--pe-bpx': `${(Math.ceil(k * dot * 64) / 64).toFixed(6)}px`,
    '--pe-px': px(k),
    '--pe-px-small': px(small),
    '--pe-px-h1': px(k + 1),
    '--pe-fs-body': px(16 * k),
    '--pe-fs-small': px(16 * small),
    '--pe-fs-h1': px(16 * (k + 1)),
    '--pe-fs-hero': px(16 * (k + 1)),
    '--pe-fs-mono': px(11 * k),
    '--pe-fs-mono-small': px(11 * small),
    '--pe-lh-body': px(21 * k),
    '--pe-lh-line': px(17 * k),
    '--pe-lh-small': px(17 * small),
    '--pe-lh-mono': px(16 * k),
    '--pe-lh-mono-small': px(16 * small),
    '--pe-lh-h1': px(21 * (k + 1)),
    // spacing and control sizes as plain lengths: the app reads some of them in script
    '--spacing': px(3 * k),
    '--cds-gap-xs': px(6 * k),
    '--cds-gap-sm': px(9 * k),
    '--cds-gap-md': px(12 * k),
    '--cds-gap-lg': px(21 * k),
    '--cds-pad-xs': px(4 * k),
    '--cds-h-control': px(21 * k),
  };
}

// Electron zooms by 1.2 ** zoomLevel and Cmd+= / Cmd+- move zoomLevel by 0.5
const ZOOM_STEP = Math.log(1.2) / 2;

// zoom is outer (screen points) over inner (CSS px) width; the display's own scale is what is left of dpr
function zoomSteps(dpr: number): { display: number; steps: number } {
  const zoom = window.outerWidth > 0 && window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
  const display = Math.max(1, Math.round((dpr / zoom) * 2) / 2);
  return { display, steps: Math.round(Math.log(dpr / display) / ZOOM_STEP) };
}

// device pixels per font pixel, so glyphs land on whole device pixels; one more or one less per zoom step
function bodyMultiple(dpr: number): number {
  const saved = Number(cinnamon.settings.get('scale'));
  if (Number.isInteger(saved) && saved > 0 && saved <= 12) return saved;
  const { display, steps } = zoomSteps(dpr);
  return Math.max(1, Math.round(display * 1.2) + steps);
}

function applyScale(): void {
  const dpr = window.devicePixelRatio || 1;
  const size = textSize();
  const k = bodyMultiple(dpr) + (size === 'large' ? 1 : 0);
  dot = 1 / dpr;
  artPx = k * dot;
  const decl = (vars: Record<string, string>) => Object.entries(vars).map(([name, value]) => `${name}:${value} !important`).join(';');
  let next = `:root:root{${decl(scaleVars(k))}}`;
  // the reading surfaces step up one font pixel; theme units derived on :root are re-derived inside them
  if (size === 'large-chat') next += `:root ${CHAT}{${decl({ ...scaleVars(k + 1), ...CHAT_UNITS })}}`;
  if (scaleStyle.textContent !== next) scaleStyle.textContent = next;
}

const cursor = document.createElement('div');
cursor.className = 'pe-cursor';
cursor.setAttribute('aria-hidden', 'true');
cursor.hidden = true;

const partner = document.createElement('div');
partner.className = 'pe-partner';
partner.setAttribute('aria-hidden', 'true');
partner.hidden = true;

document.body.append(cursor, partner);

let hovered: Element | null = null;
let focused: Element | null = null;

const snap = (value: number) => Math.round(value / dot) * dot;

function visible(el: Element): DOMRect | null {
  if (!el.isConnected || el.closest('.pe-cursor, .pe-partner')) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
  const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 24), rect.top + rect.height / 2);
  if (!hit || (!el.contains(hit) && !hit.contains(el))) return null;
  return rect;
}

function placeCursor(): void {
  const candidates = [hovered, focused, document.querySelector(HOME)];
  for (const el of candidates) {
    if (!el) continue;
    const rect = visible(el);
    if (!rect) continue;
    const w = CURSOR_ART.w * artPx;
    const h = CURSOR_ART.h * artPx;
    let left = rect.left - w - CURSOR_ART.gap * artPx;
    if (left < 0) left = rect.left - w >= -w / 3 ? Math.max(0, rect.left - w) : rect.left + CURSOR_ART.gap * artPx;
    cursor.style.transform = `translate(${snap(left)}px, ${snap(rect.top + (rect.height - h) / 2)}px)`;
    cursor.toggleAttribute('data-home', el !== hovered && el !== focused);
    cursor.hidden = false;
    return;
  }
  cursor.hidden = true;
}

function partnerName(): string | null {
  const saved = cinnamon.settings.get('partner');
  if (saved === 'none' || saved === false) return null;
  return typeof saved === 'string' && PARTNERS.includes(saved) ? saved : 'mudkip';
}

function placePartner(): void {
  const name = partnerName();
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  const rect = sidebar?.getBoundingClientRect();
  if (!name || !sidebar || !rect || rect.width < 200 || rect.height < 300) {
    partner.hidden = true;
    return;
  }
  const spriteClass = `pe-sprite-${name}`;
  if (!partner.classList.contains(spriteClass)) {
    for (const other of PARTNERS) partner.classList.remove(`pe-sprite-${other}`);
    partner.classList.add(spriteClass);
  }
  const tray = sidebar.querySelector('.df-bottom-tray')?.getBoundingClientRect();
  const bottom = tray && tray.height > 0 ? tray.top : rect.bottom - 8;
  const styles = getComputedStyle(partner);
  const w = Number(styles.getPropertyValue('--pe-w')) * artPx || 40 * artPx;
  const h = Number(styles.getPropertyValue('--pe-h')) * artPx || 40 * artPx;
  partner.style.transform = `translate(${snap(rect.right - w - 6 * artPx)}px, ${snap(bottom - h)}px)`;
  partner.hidden = false;
}

let hopTimer = 0;
function hop(): void {
  partner.removeAttribute('data-hop');
  void partner.offsetWidth;
  partner.setAttribute('data-hop', '');
  clearTimeout(hopTimer);
  hopTimer = window.setTimeout(() => partner.removeAttribute('data-hop'), 700);
}

const SETTINGS_ANCHOR = '[data-settings-row][data-cm-ext-row], [data-settings-row][data-pkb-row], [data-settings-row][data-pkp-settings]';
const BALLS = ['poke', 'great', 'ultra', 'master', 'safari', 'net', 'dive', 'nest', 'repeat', 'timer', 'luxury', 'premier'] as const;
const BALL_LABELS: Record<string, string> = { poke: 'Pok\u00e9 Ball', great: 'Great Ball', ultra: 'Ultra Ball', master: 'Master Ball', safari: 'Safari Ball', net: 'Net Ball', dive: 'Dive Ball', nest: 'Nest Ball', repeat: 'Repeat Ball', timer: 'Timer Ball', luxury: 'Luxury Ball', premier: 'Premier Ball' };
let sizeRow: HTMLElement | null = null;
let ballRow: HTMLElement | null = null;

function groupBall(): string {
  const saved = cinnamon.settings.get('groupBall');
  return typeof saved === 'string' && (BALLS as readonly string[]).includes(saved) ? saved : 'poke';
}

const rowLeaves = (row: Element) => [...(row.querySelector('[data-settings-text]') ?? row).querySelectorAll('*')]
  .filter((node) => node.childElementCount === 0 && node.textContent?.trim() && !node.closest('[data-settings-control]'));

function syncSizeRow(): void {
  const current = textSize();
  sizeRow?.querySelectorAll<HTMLElement>('[data-pe-size]').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.peSize === current)));
  const ball = groupBall();
  ballRow?.querySelectorAll<HTMLElement>('[data-pe-ball]').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.peBall === ball)));
}

// a settings row cloned from the Pokemon row before it, so it matches, holding a radio group of options
function pickerRow(anchor: Element, title: string, description: string, options: HTMLElement[]): HTMLElement {
  const row = anchor.cloneNode(true) as HTMLElement;
  for (const node of [row, ...row.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) if (/^(id|for|name|aria-|data-cm-|data-cinnamon-|data-pkb-|data-pkp-|data-fy-|data-pe-)/.test(attr.name)) node.removeAttribute(attr.name);
  }
  const [heading, text, ...rest] = rowLeaves(row);
  rest.forEach((leaf) => leaf.remove());
  if (heading) heading.textContent = title;
  if (text) text.textContent = description;
  let control = row.querySelector<HTMLElement>('[data-settings-control]');
  if (!control) {
    control = document.createElement('div');
    control.setAttribute('data-settings-control', '');
    row.append(control);
  }
  const group = document.createElement('div');
  group.className = 'pe-size';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', title);
  group.append(...options);
  control.replaceChildren(group);
  row.setAttribute('data-pe-settings', '');
  return row;
}

function option(key: string, value: string, label: string, ball: boolean): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ball ? 'pe-size-option pe-ball-option' : 'pe-size-option';
  button.setAttribute('role', 'radio');
  if (ball) {
    button.dataset.peBall = value;
    button.setAttribute('aria-label', label);
    const art = document.createElement('span');
    art.style.setProperty('--pe-ball', `var(--pe-ball-${value})`);
    button.append(art);
  } else {
    button.dataset.peSize = value;
    button.textContent = label;
  }
  button.addEventListener('click', guard(() => cinnamon.settings.set(key, value)));
  return button;
}

// Settings, then Appearance: "Text size" and "Group ball" rows after the other Pokemon rows
function ensureSizeRow(): void {
  const anchor = [...document.querySelectorAll(SETTINGS_ANCHOR)].filter((row) => row !== sizeRow && row !== ballRow).pop() ?? null;
  if (!anchor) {
    sizeRow?.remove();
    ballRow?.remove();
    sizeRow = ballRow = null;
    return;
  }
  if (sizeRow?.isConnected && sizeRow.previousElementSibling === anchor && ballRow?.isConnected && ballRow.previousElementSibling === sizeRow) return syncSizeRow();
  sizeRow?.remove();
  ballRow?.remove();
  sizeRow = pickerRow(anchor, 'Text size', 'Pixel font size for the Pokemon Emerald theme. Large chat makes messages and the input box one step bigger.',
    Object.entries(TEXT_SIZES).map(([value, label]) => option('textSize', value, label, false)));
  ballRow = pickerRow(anchor, 'Default group ball', 'The ball before a sidebar group title. Click a ball on a group to pick one for that group.', BALLS.map((ball) => option('groupBall', ball, BALL_LABELS[ball], true)));
  anchor.after(sizeRow);
  sizeRow.after(ballRow);
  syncSizeRow();
}

let frame = 0;
function schedule(): void {
  if (frame || disposed) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    try {
      placeCursor();
      placePartner();
      ensureSizeRow();
      ensureGroupBalls();
    } catch {}
  });
}

// a sidebar group toggle or its ball points at the heading, so the cursor clears the ball
const targetOf = (node: EventTarget | null) => {
  const target = node instanceof Element ? node.closest(TARGET) : null;
  return target?.matches('[data-group-toggle], .pe-ball-btn') ? target.closest('h3') ?? target : target;
};

// a ball button on each sidebar group heading; groups are keyed by the app's data-group-section, else their title
const GROUP_HEADING = '[data-testid="sidebar"] h3:not(.sr-only)';
const groupTitle = (h3: Element) => (h3.querySelector('[data-group-name]')?.textContent ?? h3.textContent ?? '').trim();
const groupKey = (h3: Element) => h3.closest('[data-group-section]')?.getAttribute('data-group-section') ?? `title:${groupTitle(h3)}`;

function groupBalls(): Record<string, string> {
  const saved = cinnamon.settings.get('groupBalls');
  return saved && typeof saved === 'object' ? (saved as Record<string, string>) : {};
}

function ballFor(key: string): string {
  const own = groupBalls()[key];
  return typeof own === 'string' && (BALLS as readonly string[]).includes(own) ? own : groupBall();
}

function ensureGroupBalls(): void {
  for (const h3 of document.querySelectorAll<HTMLElement>(GROUP_HEADING)) {
    if (!h3.querySelector('[data-group-toggle]')) continue;
    let button = h3.querySelector<HTMLButtonElement>(':scope > .pe-ball-btn');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'pe-ball-btn';
      button.setAttribute('aria-haspopup', 'menu');
      h3.prepend(button);
    }
    const key = groupKey(h3);
    const ball = ballFor(key);
    const label = `Change ${groupTitle(h3)} ball`;
    if (button.dataset.peKey !== key) button.dataset.peKey = key;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    const art = `var(--pe-ball-${ball})`;
    if (button.style.getPropertyValue('--pe-ball') !== art) button.style.setProperty('--pe-ball', art);
    button.setAttribute('aria-expanded', String(ballMenu?.dataset.peKey === key));
  }
}

let ballMenu: HTMLElement | null = null;
let ballAnchor: HTMLElement | null = null;

function closeBallMenu(focusBack: boolean): void {
  if (!ballMenu) return;
  ballMenu.remove();
  ballMenu = null;
  if (focusBack) ballAnchor?.focus();
  ballAnchor = null;
  schedule();
}

function openBallMenu(anchor: HTMLButtonElement): void {
  closeBallMenu(false);
  const key = anchor.dataset.peKey ?? '';
  const current = ballFor(key);
  const menu = document.createElement('div');
  menu.className = 'pe-ball-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', anchor.getAttribute('aria-label') ?? 'Change ball');
  menu.dataset.peKey = key;
  const items = BALLS.map((ball) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pe-ball-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(ball === current));
    item.setAttribute('aria-label', BALL_LABELS[ball]);
    item.tabIndex = -1;
    item.dataset.peBall = ball;
    const art = document.createElement('span');
    art.style.setProperty('--pe-ball', `var(--pe-ball-${ball})`);
    item.append(art);
    menu.append(item);
    return item;
  });
  menu.addEventListener('click', guard((event: Event) => {
    event.stopPropagation();
    const item = (event.target as Element).closest<HTMLElement>('.pe-ball-item');
    if (!item?.dataset.peBall) return;
    cinnamon.settings.set('groupBalls', { ...groupBalls(), [key]: item.dataset.peBall });
    closeBallMenu(true);
  }));
  menu.addEventListener('keydown', guard((event: Event) => {
    const key_ = (event as KeyboardEvent).key;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 };
    if (key_ in step) items[(Math.max(0, at) + step[key_] + items.length) % items.length].focus();
    else if (key_ === 'Escape' || key_ === 'Tab') closeBallMenu(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }));
  document.body.append(menu);
  ballMenu = menu;
  ballAnchor = anchor;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const topBar = document.querySelector('.df-titlebar')?.getBoundingClientRect().bottom ?? 0;
  const below = r.bottom + 4;
  const top = below + h <= window.innerHeight - 4 ? below : Math.max(topBar + 4, r.top - 4 - h);
  const left = Math.min(window.innerWidth - w - 4, Math.max(4, r.left));
  menu.style.left = `${snap(left)}px`;
  menu.style.top = `${snap(Math.max(topBar + 4, top))}px`;
  (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
  schedule();
}

// the ball takes its own pointer and click, so the group neither toggles nor starts a drag
const BALL_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick'];
for (const type of BALL_EVENTS) {
  listen(document, type, (event) => {
    if ((event.target as Element | null)?.closest?.('.pe-ball-btn')) event.stopPropagation();
  }, true);
}
listen(document, 'click', (event) => {
  const button = (event.target as Element | null)?.closest?.('.pe-ball-btn') as HTMLButtonElement | null;
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (ballMenu && ballAnchor === button) closeBallMenu(true);
  else openBallMenu(button);
}, true);
listen(document, 'pointerdown', (event) => {
  const target = event.target as Element | null;
  if (ballMenu && !ballMenu.contains(target) && !target?.closest?.('.pe-ball-btn')) closeBallMenu(false);
}, true);
listen(window, 'blur', () => closeBallMenu(false));

listen(document, 'pointerover', (event) => {
  hovered = targetOf(event.target);
  schedule();
}, true);
listen(document.documentElement, 'pointerleave', () => {
  hovered = null;
  schedule();
});
listen(document, 'focusin', (event) => {
  const el = targetOf(event.target);
  focused = el && el.matches(':focus-visible') ? el : null;
  schedule();
}, true);
listen(document, 'focusout', () => {
  focused = null;
  schedule();
}, true);
listen(document, 'scroll', schedule, true);
listen(window, 'resize', () => {
  applyScale();
  schedule();
});
listen(document, 'keydown', (event) => {
  const key = event as KeyboardEvent;
  if (key.key !== 'Enter' || key.shiftKey || key.isComposing) return;
  if ((key.target as Element | null)?.closest?.('[data-testid="code-prompt-input"]')) hop();
}, true);
listen(document, 'click', (event) => {
  if ((event.target as Element | null)?.closest?.(SEND)) hop();
}, true);

const ticker = window.setInterval(schedule, 400);
cinnamon.settings.onChange(guard(() => {
  if (disposed) return;
  applyScale();
  syncSizeRow();
  schedule();
}));

applyScale();
void loadFonts();
schedule();

cinnamon.onDispose(() => {
  disposed = true;
  for (const dispose of disposers) dispose();
  clearInterval(ticker);
  clearTimeout(fontTimer);
  clearTimeout(hopTimer);
  cancelAnimationFrame(frame);
  for (const face of faces) document.fonts.delete(face);
  scaleStyle.remove();
  sizeRow?.remove();
  ballRow?.remove();
  closeBallMenu(false);
  document.querySelectorAll('.pe-ball-btn').forEach((button) => button.remove());
  cursor.remove();
  partner.remove();
});
