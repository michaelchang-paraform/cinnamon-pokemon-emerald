import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(FONTS_DIR, '..', '..', 'extension-theme');

const page = readFileSync(join(EXT_DIR, 'page.ts'), 'utf8');
const sources = [...page.matchAll(/\{ family: '([^']+)', property: '([^']+)', file: '([^']+)'/g)].map(([, family, property, file]) => ({ family, property, file }));
if (!sources.length) throw new Error('no FONT_SOURCES entries found in page.ts');

const props = sources.map(({ property, file }) => `${property}: "${readFileSync(join(FONTS_DIR, file)).toString('base64')}";`);
writeFileSync(join(EXT_DIR, 'fonts.css'), `:root { ${props.join(' ')} }\n`);
console.log(sources.map(({ family, file }) => `${family} <- ${file}`).join('\n'));

const hangul = page.match(/HANGUL_SOURCE = \{ property: '([^']+)', file: '([^']+)', css: '([^']+)' \}/);
if (!hangul) throw new Error('no HANGUL_SOURCE found in page.ts');
const [, property, file, css] = hangul;
writeFileSync(join(EXT_DIR, css), `:root { ${property}: "${readFileSync(join(FONTS_DIR, file)).toString('base64')}"; }\n`);
console.log(`${property} <- ${file} (${css})`);
