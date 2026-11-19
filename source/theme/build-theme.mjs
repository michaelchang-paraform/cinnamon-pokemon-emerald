import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, gridPng, dataUrl } from '../lib/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'themes', 'pokemon-emerald.json');

const url = (png) => `url("${dataUrl(png)}")`;

// 9-slice frame with square layers and a two-pixel stepped corner; layers[0] is the outer ring, fill is the centre
function framePng({ layers, fill, size = 24, cut = 2 }) {
  return encodePng(size, size, (x, y) => {
    const ix = Math.min(x, size - 1 - x);
    const iy = Math.min(y, size - 1 - y);
    const diagonal = ix + iy - cut;
    if (diagonal < 0) return null;
    return layers[Math.min(ix, iy, diagonal)] ?? fill;
  });
}
const checker = (a, b) => gridPng(Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x >> 2) + (y >> 2)) % 2 ? 'b' : 'a')), { a, b });

const FRAMES = {
  light: {
    box: { layers: ['#283850', '#a8d8f0', '#4888b0', '#4888b0', '#283850'], fill: '#f8f8f8' },
    focus: { layers: ['#283850', '#f8e8a0', '#e0a830', '#e0a830', '#283850'], fill: '#f8f8f8' },
    menu: { layers: ['#383040', '#f8b8b0', '#e04038', '#e04038', '#383040'], fill: '#f8f8f8' },
    sel: { layers: ['#383040', '#e04038', '#e04038', '#383040'], fill: '#f8f8f8', size: 12 },
  },
  dark: {
    box: { layers: ['#0c1018', '#f8b868', '#d87838', '#d87838', '#0c1018'], fill: '#283c58' },
    focus: { layers: ['#0c1018', '#f8f0a0', '#f8c838', '#f8c838', '#0c1018'], fill: '#283c58' },
    menu: { layers: ['#0c1018', '#a8e0f0', '#4888a8', '#4888a8', '#0c1018'], fill: '#26323e' },
    sel: { layers: ['#0c1018', '#f86858', '#f86858', '#0c1018'], fill: '#2c4860', size: 12 },
  },
};

const PALETTE = {
  light: {
    background: '#eef6f0', 'background-deep': '#e2eee6', frame: '#d8ece2', sidebar: '#cfe8de', 'text-sidebar': '#283840',
    raised: '#f8f8f8', panel: '#f2f6f2', popover: '#f8f8f8', 'code-background': '#f6f2e2',
    text: '#30383f', 'text-secondary': '#485058', 'text-muted': '#545e66', placeholder: '#7c8890',
    border: '#88a8b0', 'border-faint': '#c4dad2', hover: '#dcefe6', selected: '#c4e4d6', 'selected-hover': '#b4dcca',
    button: '#1a7448', 'button-hover': '#1f8456', 'button-text': '#f8f8f8', 'button-secondary': '#dcefe6', 'button-secondary-hover': '#c4e4d6',
    accent: '#c02c24', 'accent-hover': '#d83830', danger: '#d03028', 'text-danger': '#b02018', success: '#2a9a58', 'text-success': '#1c7a44',
  },
  dark: {
    background: '#182028', 'background-deep': '#10161c', frame: '#141c24', sidebar: '#1c2a34', 'text-sidebar': '#e8f0f0',
    raised: '#223040', panel: '#1e2a36', popover: '#283850', 'code-background': '#121a22',
    text: '#f8f8f8', 'text-secondary': '#c8d4dc', 'text-muted': '#9aaab8', placeholder: '#7a8a9a',
    border: '#3c5468', 'border-faint': '#2a3a48', hover: '#24384a', selected: '#2c4860', 'selected-hover': '#345470',
    button: '#38b870', 'button-hover': '#58d088', 'button-text': '#0c1810', 'button-secondary': '#24384a', 'button-secondary-hover': '#2c4860',
    accent: '#f86858', 'accent-hover': '#f8a050', danger: '#f86858', 'text-danger': '#f89088', success: '#70f8a8', 'text-success': '#88f0b0',
  },
};

const VARS = {
  light: {
    '--cds-bg-user-message': '#f8f8f8', '--cds-text-warning': '#a88400',
    '--pe-ink-shadow': '#d0dad2', '--pe-strong': '#2858b0', '--pe-em': '#c03828',
    '--pe-heading': '#1c6a46', '--pe-heading-shadow': '#b8dcc6', '--pe-accent-dot': '#e04038', '--pe-link': '#2858b0', '--pe-rule': '#88a8b0',
    '--pe-selection': '#f8e070', '--pe-selection-ink': '#30383f', '--pe-code-edge': '#b8c4b8', '--pe-code-chip': '#e2ece4',
    '--pe-menu-hover': '#d8ecf4', '--pe-row-selected': '#f8f8f8', '--pe-row-selected-ink': '#30383f', '--pe-red': '#b02820',
    '--pe-scroll-thumb': '#4888b0', '--pe-scroll-thumb-hover': '#58a8c0', '--pe-scroll-edge': '#283850', '--pe-scroll-light': '#a8d8f0', '--pe-scroll-shade': '#305878', '--pe-scroll-track': '#88a8b0',
    '--pe-hp-green': '#58d080', '--pe-hp-yellow': '#f8c838', '--pe-hp-red': '#f85838',
  },
  dark: {
    '--cds-bg-user-message': '#283c58', '--cds-text-warning': '#f8d838',
    '--pe-ink-shadow': '#46526a', '--pe-strong': '#f8d070', '--pe-em': '#f89888',
    '--pe-heading': '#70e0a0', '--pe-heading-shadow': '#28503c', '--pe-accent-dot': '#f86858', '--pe-link': '#78c8f0', '--pe-rule': '#4c6478',
    '--pe-selection': '#4878a8', '--pe-selection-ink': '#f8f8f8', '--pe-code-edge': '#3c5468', '--pe-code-chip': '#24384a',
    '--pe-menu-hover': '#3c5470', '--pe-row-selected': '#2c4860', '--pe-row-selected-ink': '#f8f8f8', '--pe-red': '#f86858',
    '--pe-scroll-thumb': '#d87838', '--pe-scroll-thumb-hover': '#f89848', '--pe-scroll-edge': '#0c1018', '--pe-scroll-light': '#f8b868', '--pe-scroll-shade': '#a05028', '--pe-scroll-track': '#3c5468',
    '--pe-hp-green': '#70f8a8', '--pe-hp-yellow': '#f8e038', '--pe-hp-red': '#f85838',
  },
};

const TILES = { light: ['#cfe8de', '#c7e2d7'], dark: ['#1c2a34', '#203040'] };

const mode = (name) => ({ ...PALETTE[name], vars: VARS[name] });
const images = (name) => [
  `--pe-frame-box:${url(framePng(FRAMES[name].box))}`,
  `--pe-frame-menu:${url(framePng(FRAMES[name].menu))}`,
  `--pe-frame-focus:${url(framePng(FRAMES[name].focus))}`,
  `--pe-frame-sel:${url(framePng(FRAMES[name].sel))}`,
  `--pe-tile:${url(checker(...TILES[name]))}`,
].join(';');

const css = [
  `:root:not([data-mode="dark"]){${images('light')}}`,
  `:root[data-mode="dark"]{${images('dark')}}`,
  readFileSync(join(HERE, 'theme.css'), 'utf8').replace(/\n\s*/g, '').replace(/;}/g, '}'),
].join('');
if (css.includes(String.fromCharCode(92))) throw new Error('theme css must not contain backslashes');
const theme = {
  name: 'Pokemon Emerald',
  description: 'Gen 3 pixel look: Emerald text boxes, PC box sidebar, battle menu cursor. Needs the pokemon-emerald extension for fonts.',
  light: mode('light'),
  dark: mode('dark'),
  css,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(theme, null, 2)}\n`);
console.log(`wrote ${OUT} (${css.length} chars of css)`);
