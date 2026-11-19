declare const cinnamon: { onDispose(fn: () => void): void };
type TrainerLook = { cls: string; name: string; palette: Array<string | null> };
type TrainerGroup = [string, Array<[number[], number, number]>];
type TrainerSheet = { id: string; name: string; pal: string[]; frames: string[]; groups: TrainerGroup[] };

const ns = (window as any).__pkb;
const { el, decodeBase64 } = ns;
const DEFAULT_LOOK: TrainerLook = { cls: 'brendan', name: 'BRENDAN', palette: [] };
let sheets: TrainerSheet[] | null = null;

// partners ships the trainer sheets as --pkp-data on .pkp-data; read in place, never copied here
function trainerSheets(): TrainerSheet[] {
  if (sheets) return sheets;
  try {
    const probe = el('div', 'pkp-data');
    probe.hidden = true;
    document.body.append(probe);
    const raw = getComputedStyle(probe).getPropertyValue('--pkp-data').trim().replace(/^["']|["']$/g, '');
    probe.remove();
    if (!raw) return [];
    sheets = (JSON.parse(new TextDecoder().decode(decodeBase64(raw))).t ?? []) as TrainerSheet[];
  } catch {
    sheets = [];
  }
  return sheets;
}

function cleanLook(raw: unknown): TrainerLook | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const cls = typeof r.cls === 'number' ? trainerSheets()[r.cls]?.id ?? DEFAULT_LOOK.cls : r.cls;
  if (typeof cls !== 'string' || !cls) return null;
  const palette = Array.isArray(r.palette) ? r.palette.map((c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null)) : [];
  return { cls, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : '', palette };
}

function playerLook(): TrainerLook | null {
  return cleanLook((window as any).__pePlayer);
}

const hsl = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
};
const rgb = (h: number, s: number, l: number): number[] => {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
};

// same recolor rule as partners: the picked hue and saturation, each shade's lightness offset kept
function recolorMap(sheet: TrainerSheet, group: TrainerGroup, target: string): Map<number, number[]> {
  const indices = [...new Set(group[1].flatMap((part) => part[0]))].sort((a, b) => a - b);
  const shades = indices.map((i) => sheet.pal[i]).sort((a, b) => hsl(a)[2] - hsl(b)[2]);
  const ref = hsl(shades[Math.floor(shades.length / 2)])[2];
  const [th, ts, tl] = hsl(target);
  return new Map(indices.map((i) => [i, rgb(th, ts, Math.min(0.97, Math.max(0.03, tl + hsl(sheet.pal[i])[2] - ref)))]));
}

function trainerCanvas(look: TrainerLook, rows = 32): HTMLCanvasElement | null {
  const all = trainerSheets();
  const sheet = all.find((t) => t.id === look.cls) ?? all.find((t) => t.id === DEFAULT_LOOK.cls) ?? all[0];
  if (!sheet) return null;
  const canvas = el('canvas', 'pkb-trainer') as HTMLCanvasElement;
  canvas.width = 16;
  canvas.height = rows;
  canvas.style.width = 'calc(var(--u) * 16)';
  canvas.style.height = `calc(var(--u) * ${rows})`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.createImageData(16, rows);
  const swaps = sheet.groups.map((group, g) => (look.palette[g] ? { group, map: recolorMap(sheet, group, look.palette[g]!) } : null));
  const packed = decodeBase64(sheet.frames[0]);
  const at = (x: number, y: number) => (x & 1 ? packed[(y * 16 + x) >> 1] & 15 : packed[(y * 16 + x) >> 1] >> 4);
  let top = 0;
  while (rows < 32 && top < 32 - rows && ![...Array(16).keys()].some((x) => at(x, top))) top++;
  for (let row = 0; row < rows; row++)
    for (let x = 0; x < 16; x++) {
      const y = row + top;
      const index = at(x, y);
      if (!index) continue;
      let color = [...[16, 8, 0].map((s) => (parseInt(sheet.pal[index], 16) >> s) & 255)];
      for (const swap of swaps)
        if (swap?.group[1].some(([ids, y0, y1]) => y >= y0 && y <= y1 && ids.includes(index))) color = swap.map.get(index) ?? color;
      image.data.set([color[0], color[1], color[2], 255], (row * 16 + x) * 4);
    }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// helper wire shape: cls is the index into the partners trainer list
function wireLook(look: TrainerLook): { cls: number; name: string; palette: Array<string | null> } {
  return { cls: Math.max(0, trainerSheets().findIndex((t) => t.id === look.cls)), name: look.name, palette: look.palette.slice(0, 8) };
}

cinnamon.onDispose(() => (sheets = null));
Object.assign(ns, { DEFAULT_LOOK, playerLook, cleanLook, trainerCanvas, wireLook });
