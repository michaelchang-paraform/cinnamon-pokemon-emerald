import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridPng, dataUrl, encodePng } from '../lib/png.mjs';
import { readIndexedPng } from '../partners/png-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'extension-theme', 'sprites.css');
const PARTNERS = ['mudkip', 'treecko', 'torchic'];

const size = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
const url = (png) => `url("${dataUrl(png)}")`;

function cursor(main, shadow) {
  const widths = [1, 2, 3, 4, 5, 4, 3, 2, 1];
  const inside = (x, y) => y >= 0 && y < widths.length && x >= 0 && x < widths[y];
  const rows = Array.from({ length: 10 }, (_, y) => Array.from({ length: 6 }, (_, x) => (inside(x, y) ? 'a' : inside(x - 1, y - 1) ? 'b' : '.')));
  return gridPng(rows, { a: main, b: shadow });
}

// one-colour pixel glyphs used as CSS masks over currentColor
const mask = (rows) => gridPng(rows.map((row) => [...row]), { x: '#ffffff' });

const vars = [
  `--pe-cursor-light: ${url(cursor('#404048', '#c8c8c0'))};`,
  `--pe-cursor-dark: ${url(cursor('#f8f8f8', '#485068'))};`,
  `--pe-mask-chevron: ${url(mask(['x...x', '.x.x.', '..x..']))};`,
  `--pe-mask-chevron-right: ${url(mask(['x..', '.x.', '..x', '.x.', 'x..']))};`,
  `--pe-mask-plus: ${url(mask(['...x...', '...x...', '...x...', 'xxxxxxx', '...x...', '...x...', '...x...']))};`,
  `--pe-mask-plus-small: ${url(mask(['..x..', '..x..', 'xxxxx', '..x..', '..x..']))};`,
  `--pe-mask-arrow-down: ${url(mask(['...x...', '...x...', '...x...', '...x...', 'x..x..x', '.x.x.x.', '..xxx..', '...x...']))};`,
  `--pe-mask-cloud: ${url(mask(['...xxx...', '..x...xx.', '.x......x', 'x.......x', 'x.......x', '.xxxxxxx.']))};`,
];
const rules = [];
for (const name of PARTNERS) {
  const png = readFileSync(join(HERE, `${name}.png`));
  const [w, h] = size(png);
  vars.push(`--pe-sprite-${name}: ${url(png)};`);
  rules.push(`.pe-sprite-${name} { --pe-w: ${w}; --pe-h: ${h}; background-image: var(--pe-sprite-${name}); }`);
}
// the twelve Emerald balls (pret graphics/balls, ITEM_MASTER_BALL to ITEM_PREMIER_BALL): the closed frame,
// palette index 0 transparent, cropped to the ball itself
export const BALLS = ['poke', 'great', 'ultra', 'master', 'safari', 'net', 'dive', 'nest', 'repeat', 'timer', 'luxury', 'premier'];
for (const ball of BALLS) {
  const img = readIndexedPng(readFileSync(join(HERE, 'download', 'pret', 'balls', `${ball}.png`)));
  const at = (x, y) => img.index[y * img.width + x];
  let x0 = 16, y0 = 16, x1 = -1, y1 = -1;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (at(x, y)) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const png = encodePng(x1 - x0 + 1, y1 - y0 + 1, (x, y) => (at(x0 + x, y0 + y) ? `#${img.palette[at(x0 + x, y0 + y)]}` : null));
  vars.push(`--pe-ball-${ball}: ${url(png)};`);
}

writeFileSync(OUT, `:root { ${vars.join(' ')} }\n${rules.join('\n')}\n`);
console.log(rules.join('\n'));
