// writes extension-icons/icons.css: one mask PNG per pixel icon plus the codepoint map the page file reads
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridPng, dataUrl } from '../lib/png.mjs';
import { readIndexedPng } from '../partners/png-read.mjs';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ART, MATCH, ASSETS, STATUS } from './glyphs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'extension-icons', 'icons.css');
const GRAPHICS = process.env.POKEEMERALD_GRAPHICS || join(HERE, '..', 'battle', 'download', 'pokeemerald', 'graphics');
// masks ship 8x so a renderer that smooths them still lands on cell edges
const UPSCALE = 8;

function assetRows([file, x0, y0, w, h]) {
  const png = readIndexedPng(readFileSync(join(GRAPHICS, file)));
  const background = png.index[0];
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (png.index[(y0 + y) * png.width + x0 + x] === background ? '.' : '#')).join(''));
}

// optional glyphs.local.mjs (gitignored): its ART adds arts, its MATCH is merged into each codepoint's entry
const LOCAL_FILE = join(HERE, 'glyphs.local.mjs');
const LOCAL = existsSync(LOCAL_FILE) ? await import(pathToFileURL(LOCAL_FILE).href) : {};
const arts = { ...ART, ...(LOCAL.ART || {}) };
const match = Object.fromEntries(Object.entries(MATCH).map(([codepoint, spec]) => [codepoint, { ...spec, ...((LOCAL.MATCH || {})[codepoint] || {}) }]));
for (const [name, spec] of Object.entries(ASSETS)) arts[name] = assetRows(spec);

function maskPng(rows) {
  const big = rows.flatMap((row) => Array(UPSCALE).fill([...row].flatMap((cell) => Array(UPSCALE).fill(cell === '#' ? 'x' : '.'))));
  return gridPng(big, { x: '#ffffff' });
}

const used = new Set();
const map = {};
for (const [codepoint, spec] of Object.entries(match)) {
  const entry = { a: spec.asset || spec.art };
  if (spec.small) entry.s = spec.small;
  if (spec.motif) entry.m = spec.motif;
  if (spec.motifLabel) entry.l = spec.motifLabel;
  for (const name of [entry.a, entry.s, entry.m].filter(Boolean)) {
    if (!arts[name]) throw new Error(`no art named ${name} for ${codepoint}`);
    used.add(name);
  }
  map[codepoint] = entry;
}

for (const name of Object.values(STATUS)) {
  if (!arts[name]) throw new Error(`no art named ${name}`);
  used.add(name);
}

const sizes = Object.fromEntries([...used].sort().map((name) => [name, [arts[name][0].length, arts[name].length]]));
const lines = [`:root{--pi-map:'${JSON.stringify({ m: map, d: sizes })}'}`];
for (const name of [...used].sort()) {
  const rows = arts[name];
  if (rows.some((row) => row.length !== rows[0].length)) throw new Error(`ragged art ${name}`);
  lines.push(`:root{--pi-art-${name}:url("${dataUrl(maskPng(rows))}")}`);
  lines.push(`[data-pi="${name}"]{--pi-w:${rows[0].length};--pi-h:${rows.length};--pi-img:var(--pi-art-${name})}`);
}
lines.push(
  // the font glyph stays in the DOM and keeps its box; only its ink is hidden
  '[data-pi]{-webkit-text-fill-color:transparent !important}',
  '[data-pi][data-pi-rel]{position:relative !important}',
  '[data-pi]::before{content:"";position:absolute;left:50%;top:50%;width:calc(var(--pi-w) * var(--pe-px, var(--pi-px-fallback, 1.5px)));height:calc(var(--pi-h) * var(--pe-px, var(--pi-px-fallback, 1.5px)));transform:translate(calc(-50% + var(--pi-dx, 0px)), calc(-50% + var(--pi-dy, 0px)));background-color:currentColor;-webkit-mask:var(--pi-img) center / 100% 100% no-repeat;mask:var(--pi-img) center / 100% 100% no-repeat;image-rendering:pixelated;pointer-events:none}',
);
// label menu of the built-in sidebar-cards extension: the icon is absolute, so the row height and text baseline stay as they are
const CELL = 'var(--pe-px, var(--pi-px-fallback, 1.5px))';
const ROWS = `.cm-menu > .cm-menu-item:is(${Object.keys(STATUS).map((label) => `[data-label="${label}"]`).join(',')})`;
lines.push(
  `${ROWS}{position:relative;padding-left:calc(${CELL} * 16) !important}`,
  `${ROWS}::before{content:"";position:absolute;left:calc(${CELL} * 4);top:calc(50% - ${CELL} * 4.5);width:calc(${CELL} * 9);height:calc(${CELL} * 9);background-color:currentColor;-webkit-mask:var(--pi-status) center / 100% 100% no-repeat;mask:var(--pi-status) center / 100% 100% no-repeat;image-rendering:pixelated;pointer-events:none}`,
);
for (const [label, name] of Object.entries(STATUS)) {
  if (arts[name].length !== 9 || arts[name][0].length !== 9) throw new Error(`status art ${name} must be 9 by 9`);
  lines.push(`.cm-menu > .cm-menu-item[data-label="${label}"]{--pi-status:var(--pi-art-${name})}`);
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`${OUT}: ${used.size} icons, ${Object.keys(map).length} codepoints`);
