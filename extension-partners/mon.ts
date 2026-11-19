// A thread's partner as a Gen 3 Pokemon: personality, nature, IVs, gender, ability, shininess, OT ID, stats, EXP
// and level-up moves, all from the thread's seed. Formulas follow pokeemerald (CalculateMonStats, gExperienceTables).
declare const cinnamon: { settings: { get(key: string): unknown } };
const M = (window as any).__pkp;

type Mon = {
  key: string;
  species: number;
  name: string;
  nickname: string;
  level: number;
  personality: number;
  otId: number;
  shiny: boolean;
  nature: number;
  gender: 'M' | 'F' | null;
  ability: number;
  ivs: number[];
  stats: number[];
  exp: number;
  expThis: number;
  expNext: number;
  moves: number[];
  types: number[];
};

// EXP needed to reach level n for each growth rate, in the order build-ui.mjs writes them
function expAt(growth: number, n: number): number {
  if (n <= 1) return 0;
  const n3 = n ** 3;
  switch (growth) {
    case 1:
      if (n <= 50) return Math.floor((n3 * (100 - n)) / 50);
      if (n <= 68) return Math.floor((n3 * (150 - n)) / 100);
      if (n <= 98) return Math.floor((n3 * Math.floor((1911 - 10 * n) / 3)) / 500);
      return Math.floor((n3 * (160 - n)) / 100);
    case 2:
      if (n <= 15) return Math.floor((n3 * (Math.floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return Math.floor((n3 * (n + 14)) / 50);
      return Math.floor((n3 * (Math.floor(n / 2) + 32)) / 50);
    case 3:
      return Math.floor((6 * n3) / 5) - 15 * n * n + 100 * n - 140;
    case 4:
      return Math.floor((4 * n3) / 5);
    case 5:
      return Math.floor((5 * n3) / 4);
    default:
      return n3;
  }
}

// stat order [hp, atk, def, spa, spd, spe]; nature order [atk, def, spe, spa, spd]
const NATURE_SLOT = [-1, 0, 1, 3, 4, 2];
function natureMod(nature: number, stat: number): number {
  const [, plus, minus] = M.assets.dex.na[nature];
  const slot = NATURE_SLOT[stat];
  if (plus === minus) return 1;
  if (slot === plus) return 1.1;
  if (slot === minus) return 0.9;
  return 1;
}

const shinyOverride = new Set<string>();

function mon(key: string): Mon | null {
  const dex = M.assets.dex;
  if (!dex) return null;
  const entry = M.store.get(key);
  const species = M.store.species(key);
  const base = dex.st[species];
  if (!base) return null;
  const level = M.levelFor(entry[1]);
  const draw = M.rng(M.hash(`${key}#mon`));
  const u32 = () => Math.floor(draw() * 4294967296) >>> 0;
  const personality = u32();
  const otId = u32();
  const ivs = Array.from({ length: 6 }, () => Math.floor(draw() * 32));
  const shinyValue = (otId >>> 16) ^ (otId & 0xffff) ^ (personality >>> 16) ^ (personality & 0xffff);
  const shiny = shinyValue < 8 || shinyOverride.has(key);
  const nature = personality % 25;
  const threshold = base[10];
  const gender = threshold === 255 ? null : threshold === 0 ? 'M' : threshold === 254 ? 'F' : (personality & 0xff) < threshold ? 'F' : 'M';
  const ability = base[9] >= 0 && personality & 1 ? base[9] : base[8];
  const stats = [0, 1, 2, 3, 4, 5].map((i) => {
    const core = Math.floor(((2 * base[i] + ivs[i]) * level) / 100);
    if (i === 0) return species === 292 ? 1 : core + level + 10;
    return Math.floor((core + 5) * natureMod(nature, i));
  });
  const learned: number[] = [];
  const list: number[] = dex.ls[species] ?? [];
  for (let i = 0; i < list.length; i += 2) {
    if (list[i] > level) break;
    const move = list[i + 1];
    const at = learned.indexOf(move);
    if (at >= 0) learned.splice(at, 1);
    learned.push(move);
  }
  const name = M.assets.name(species);
  const expThis = expAt(base[11], level);
  return {
    key,
    species,
    name,
    nickname: M.store.nickname(key) ?? name,
    level,
    personality,
    otId,
    shiny,
    nature,
    gender,
    ability,
    ivs,
    stats,
    exp: expThis,
    expThis,
    expNext: level >= M.MAX_LEVEL ? expThis : expAt(base[11], level + 1),
    moves: learned.slice(-4),
    types: base[6] === base[7] ? [base[6]] : [base[6], base[7]],
  };
}

function trainerName(): string {
  return M.trainerSetting().name;
}

Object.assign(M, { mon, expAt, natureMod, shinyOverride, trainerName });
