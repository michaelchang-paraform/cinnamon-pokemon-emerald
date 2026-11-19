import { ITEMS } from './items.ts';

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
    // a 24 px item icon at whole device pixels inside the 12 font px heading box
    '--pe-item-px': px(Math.max(1, Math.floor(k / 2))),
    // group heading icons draw one font pixel step up (k + 1); a 24 px item takes the largest whole multiple in that 12 px box
    '--pe-head-item-px': px(Math.max(1, Math.floor((k + 1) / 2))),
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
    const left = rect.left - w - CURSOR_ART.gap * artPx;
    // no column to its left: skip rather than draw over the control
    if (left < 0) continue;
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
const ICON_NAMES = new Map(ITEMS.map(([id, name]) => [id, name]));
const BALL_IDS = new Set(ITEMS.filter(([, , pocket]) => pocket === 'balls').map(([id]) => id));
const POCKETS = [['balls', 'Poke Balls'], ['items', 'Items'], ['key', 'Key Items'], ['berries', 'Berries']] as const;
const isIcon = (value: unknown): value is string => typeof value === 'string' && ICON_NAMES.has(value);
// headings draw balls from their cropped 12 px sprite and items from their 24 px one at whole device pixels, both in the 12 px box
const headingArt = (id: string) => (BALL_IDS.has(id) ? `var(--pe-ball-${id})` : `var(--pe-item-${id})`);
function markItem(node: Element, id: string): void {
  const item = !BALL_IDS.has(id);
  if (node.hasAttribute('data-pe-item') !== item) node.toggleAttribute('data-pe-item', item);
}
let sizeRow: HTMLElement | null = null;
let ballRow: HTMLElement | null = null;

function groupBall(): string {
  const saved = cinnamon.settings.get('groupBall');
  return isIcon(saved) ? saved : 'poke';
}

const rowLeaves = (row: Element) => [...(row.querySelector('[data-settings-text]') ?? row).querySelectorAll('*')]
  .filter((node) => node.childElementCount === 0 && node.textContent?.trim() && !node.closest('[data-settings-control]'));

function syncSizeRow(): void {
  const current = textSize();
  sizeRow?.querySelectorAll<HTMLElement>('[data-pe-size]').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.peSize === current)));
  const pick = ballRow?.querySelector<HTMLElement>('.pe-icon-pick');
  if (pick) paintPick(pick, groupBall());
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

function option(key: string, value: string, label: string): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pe-size-option';
  button.setAttribute('role', 'radio');
  button.dataset.peSize = value;
  button.textContent = label;
  button.addEventListener('click', guard(() => cinnamon.settings.set(key, value)));
  return button;
}

// the Settings button that opens the icon picker for the default icon
function paintPick(button: HTMLElement, id: string): void {
  const name = ICON_NAMES.get(id) ?? '';
  const label = `Default group icon: ${name}`;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  const art = button.firstElementChild as HTMLElement | null;
  if (art && art.style.getPropertyValue('--pe-ball') !== headingArt(id)) art.style.setProperty('--pe-ball', headingArt(id));
  if (art) markItem(art, id);
  const text = button.lastElementChild as HTMLElement | null;
  if (text && text.textContent !== name) text.textContent = name;
}

function pickButton(): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pe-size-option pe-icon-pick';
  button.dataset.peKey = '';
  button.setAttribute('aria-haspopup', 'dialog');
  button.append(document.createElement('span'), document.createElement('span'));
  paintPick(button, groupBall());
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
    Object.entries(TEXT_SIZES).map(([value, label]) => option('textSize', value, label)));
  ballRow = pickerRow(anchor, 'Default group icon', 'The icon before a sidebar group title: a Poke Ball or any item you can find in Emerald. Click the icon on a group to pick one for that group.', [pickButton()]);
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
// the arrow marks text items and rows; an icon-only control has no text for it to point at
const ICON_PARTS = '[data-cds="Icon"], svg, img, canvas, .sr-only, [aria-hidden="true"]';
function hasText(el: Element): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(ICON_PARTS)) continue;
    if (/[^\s\ue000-\uf8ff]/.test(node.textContent ?? '')) return true;
  }
  return false;
}
const targetOf = (node: EventTarget | null) => {
  const target = node instanceof Element ? node.closest(TARGET) : null;
  if (!target) return null;
  if (target.matches('[data-group-toggle], .pe-ball-btn')) return target.closest('h3') ?? target;
  return target.hasAttribute('data-cds-icon-only') || !hasText(target) ? null : target;
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
  return isIcon(own) ? own : groupBall();
}

function ensureGroupBalls(): void {
  for (const h3 of document.querySelectorAll<HTMLElement>(GROUP_HEADING)) {
    if (!h3.querySelector('[data-group-toggle]')) continue;
    let button = h3.querySelector<HTMLButtonElement>(':scope > .pe-ball-btn');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'pe-ball-btn';
      button.setAttribute('aria-haspopup', 'dialog');
      h3.prepend(button);
    }
    const key = groupKey(h3);
    const ball = ballFor(key);
    const label = `Change ${groupTitle(h3)} icon: ${ICON_NAMES.get(ball) ?? ''}`;
    if (button.dataset.peKey !== key) button.dataset.peKey = key;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    const art = headingArt(ball);
    if (button.style.getPropertyValue('--pe-ball') !== art) button.style.setProperty('--pe-ball', art);
    markItem(button, ball);
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

const fold = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const visibleOptions = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('.pe-icon-option:not([hidden])')];

function showName(menu: HTMLElement, id: string | undefined): void {
  const line = menu.querySelector('.pe-icon-name');
  if (line) line.textContent = (id && ICON_NAMES.get(id)) || '';
}

function focusOption(menu: HTMLElement, option: HTMLElement | undefined): void {
  if (!option) return;
  for (const other of menu.querySelectorAll<HTMLElement>('.pe-icon-option[tabindex="0"]')) other.tabIndex = -1;
  option.tabIndex = 0;
  option.focus({ preventScroll: true });
  const list = menu.querySelector<HTMLElement>('.pe-icon-list');
  if (!list) return;
  const top = option.offsetTop;
  const head = option.closest('.pe-icon-group')?.querySelector<HTMLElement>('.pe-icon-head')?.offsetHeight ?? 0;
  if (top - head < list.scrollTop) list.scrollTop = Math.max(0, top - head);
  else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
}

function filterIcons(menu: HTMLElement, query: string): void {
  const words = fold(query).split(/\s+/).filter(Boolean);
  for (const option of menu.querySelectorAll<HTMLElement>('.pe-icon-option')) {
    const name = fold(ICON_NAMES.get(option.dataset.peIcon ?? '') ?? '');
    option.hidden = !words.every((word) => name.includes(word));
  }
  for (const group of menu.querySelectorAll<HTMLElement>('.pe-icon-group')) group.hidden = !group.querySelector('.pe-icon-option:not([hidden])');
  const empty = menu.querySelector<HTMLElement>('.pe-icon-empty');
  if (empty) empty.hidden = visibleOptions(menu).length > 0;
}

function chooseIcon(menu: HTMLElement, id: string | undefined): void {
  if (!isIcon(id)) return;
  const key = menu.dataset.peKey ?? '';
  if (menu.dataset.peDefault === 'true') cinnamon.settings.set('groupBall', id);
  else cinnamon.settings.set('groupBalls', { ...groupBalls(), [key]: id });
  closeBallMenu(true);
}

function openBallMenu(anchor: HTMLElement): void {
  closeBallMenu(false);
  const isDefault = anchor.classList.contains('pe-icon-pick');
  const key = anchor.dataset.peKey ?? '';
  const current = isDefault ? groupBall() : ballFor(key);
  const menu = document.createElement('div');
  menu.className = 'pe-ball-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', isDefault ? 'Default group icon' : (anchor.getAttribute('aria-label') ?? 'Change icon').replace(/:.*$/, ''));
  menu.dataset.peKey = key;
  menu.dataset.peDefault = String(isDefault);
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'pe-icon-search';
  search.placeholder = 'Search items';
  search.setAttribute('aria-label', 'Search items');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'pe-icon-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Icons');
  for (const [pocket, title] of POCKETS) {
    const group = document.createElement('div');
    group.className = 'pe-icon-group';
    group.setAttribute('role', 'group');
    const head = document.createElement('div');
    head.className = 'pe-icon-head';
    head.id = `pe-icon-head-${pocket}`;
    head.textContent = title;
    group.setAttribute('aria-labelledby', head.id);
    const grid = document.createElement('div');
    grid.className = 'pe-icon-grid';
    for (const [id, name, where] of ITEMS) {
      if (where !== pocket) continue;
      const option = document.createElement('div');
      option.className = 'pe-icon-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-label', name);
      option.setAttribute('aria-selected', String(id === current));
      option.tabIndex = -1;
      option.dataset.peIcon = id;
      const art = document.createElement('span');
      art.style.setProperty('--pe-icon', `var(--pe-item-${id})`);
      option.append(art);
      grid.append(option);
    }
    group.append(head, grid);
    list.append(group);
  }
  const empty = document.createElement('div');
  empty.className = 'pe-icon-empty';
  empty.textContent = 'No items match';
  empty.hidden = true;
  list.append(empty);
  const name = document.createElement('div');
  name.className = 'pe-icon-name';
  name.setAttribute('aria-hidden', 'true');
  menu.append(search, list, name);
  showName(menu, current);

  search.addEventListener('input', guard(() => filterIcons(menu, search.value)));
  menu.addEventListener('click', guard((event: Event) => {
    event.stopPropagation();
    chooseIcon(menu, (event.target as Element).closest<HTMLElement>('.pe-icon-option')?.dataset.peIcon);
  }));
  menu.addEventListener('pointerover', guard((event: Event) => {
    const option = (event.target as Element).closest<HTMLElement>('.pe-icon-option');
    if (option) showName(menu, option.dataset.peIcon);
  }));
  menu.addEventListener('focusin', guard((event: Event) => {
    const option = (event.target as Element).closest<HTMLElement>('.pe-icon-option');
    if (option) showName(menu, option.dataset.peIcon);
  }));

  // inside a modal dialog the popover joins it, so the dialog keeps focus and clicks
  const host = anchor.closest('[role="dialog"]') ?? document.body;
  host.append(menu);
  ballMenu = menu;
  ballAnchor = anchor;
  placeMenu(menu, anchor);
  const chosen = menu.querySelector<HTMLElement>('.pe-icon-option[aria-selected="true"]') ?? visibleOptions(menu)[0];
  focusOption(menu, chosen);
  schedule();
}

// below the anchor when it fits, else above, else the taller side; the list scrolls inside the window
function placeMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const gap = 4;
  const r = anchor.getBoundingClientRect();
  const topBar = document.querySelector('.df-titlebar')?.getBoundingClientRect().bottom ?? 0;
  const roof = topBar + gap;
  const floor = window.innerHeight - gap;
  menu.style.maxHeight = `${Math.max(120, floor - roof)}px`;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const below = floor - (r.bottom + gap);
  const above = r.top - gap - roof;
  let top: number;
  if (h <= below) top = r.bottom + gap;
  else if (h <= above) top = r.top - gap - h;
  else if (below >= above) {
    menu.style.maxHeight = `${Math.max(120, below)}px`;
    top = r.bottom + gap;
  } else {
    menu.style.maxHeight = `${Math.max(120, above)}px`;
    top = r.top - gap - Math.min(h, Math.max(120, above));
  }
  const left = Math.min(window.innerWidth - w - gap, Math.max(gap, r.left));
  menu.style.left = `${snap(left)}px`;
  menu.style.top = `${snap(Math.max(roof, top))}px`;
  // a transformed host moves position: fixed, so correct by what landed
  const got = menu.getBoundingClientRect();
  if (Math.abs(got.left - left) > 0.5 || Math.abs(got.top - Math.max(roof, top)) > 0.5) {
    menu.style.left = `${snap(left + left - got.left)}px`;
    menu.style.top = `${snap(Math.max(roof, top) * 2 - got.top)}px`;
  }
}

// the ball takes its own pointer and click, so the group neither toggles nor starts a drag
const BALL_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick'];
for (const type of BALL_EVENTS) {
  listen(document, type, (event) => {
    if ((event.target as Element | null)?.closest?.('.pe-ball-btn')) event.stopPropagation();
  }, true);
}
listen(document, 'click', (event) => {
  const button = (event.target as Element | null)?.closest?.('.pe-ball-btn, .pe-icon-pick') as HTMLElement | null;
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (ballMenu && ballAnchor === button) closeBallMenu(true);
  else openBallMenu(button);
}, true);
// nearest visible option in the row above or below, by position, so groups of any width line up
function stepRow(menu: HTMLElement, from: HTMLElement, down: boolean): HTMLElement | undefined {
  const at = from.getBoundingClientRect();
  const rows = visibleOptions(menu).filter((option) => {
    const box = option.getBoundingClientRect();
    return down ? box.top > at.top + at.height / 2 : box.bottom < at.bottom - at.height / 2;
  });
  if (!rows.length) return undefined;
  const edge = down ? Math.min(...rows.map((o) => o.getBoundingClientRect().top)) : Math.max(...rows.map((o) => o.getBoundingClientRect().top));
  const row = rows.filter((o) => Math.abs(o.getBoundingClientRect().top - edge) < 1);
  const x = at.left + at.width / 2;
  return row.sort((a, b) => Math.abs(a.getBoundingClientRect().left + at.width / 2 - x) - Math.abs(b.getBoundingClientRect().left + at.width / 2 - x))[0];
}

function ballMenuKey(event: KeyboardEvent, menu: HTMLElement): void {
  const search = menu.querySelector<HTMLInputElement>('.pe-icon-search');
  const options = visibleOptions(menu);
  const active = document.activeElement as HTMLElement | null;
  const onOption = !!active?.classList.contains('pe-icon-option');
  const at = onOption ? options.indexOf(active!) : -1;
  const key = event.key;
  if (key === 'Escape') {
    if (search?.value) {
      search.value = '';
      filterIcons(menu, '');
      search.focus();
    } else closeBallMenu(true);
  } else if (key === 'Tab') {
    if (onOption) search?.focus();
    else focusOption(menu, menu.querySelector<HTMLElement>('.pe-icon-option[tabindex="0"]:not([hidden])') ?? options[0]);
  } else if (!onOption) {
    if (key === 'ArrowDown') focusOption(menu, menu.querySelector<HTMLElement>('.pe-icon-option[tabindex="0"]:not([hidden])') ?? options[0]);
    else if (key === 'Enter') chooseIcon(menu, options[0]?.dataset.peIcon);
    else return;
  } else if (key === 'ArrowRight' || key === 'ArrowLeft') focusOption(menu, options[at + (key === 'ArrowRight' ? 1 : -1)]);
  else if (key === 'ArrowDown' || key === 'ArrowUp') {
    const next = stepRow(menu, active!, key === 'ArrowDown');
    if (next) focusOption(menu, next);
    else if (key === 'ArrowUp') search?.focus();
  } else if (key === 'Home' || key === 'End') focusOption(menu, key === 'Home' ? options[0] : options[options.length - 1]);
  else if (key === 'Enter' || key === ' ') chooseIcon(menu, active!.dataset.peIcon);
  else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    search?.focus();
    return;
  } else return;
  event.preventDefault();
}
// keys on the ball or in its menu stop at the window, before any app handler can toggle or move the group
for (const type of ['keydown', 'keyup', 'keypress']) {
  listen(window, type, (event) => {
    const target = event.target as Element | null;
    const menu = target?.closest?.('.pe-ball-menu') as HTMLElement | null;
    if (!menu && !target?.closest?.('.pe-ball-btn')) return;
    event.stopPropagation();
    if (menu && type === 'keydown') ballMenuKey(event as KeyboardEvent, menu);
  }, true);
}
listen(document, 'pointerdown', (event) => {
  const target = event.target as Element | null;
  if (ballMenu && !ballMenu.contains(target) && !target?.closest?.('.pe-ball-btn, .pe-icon-pick')) closeBallMenu(false);
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
