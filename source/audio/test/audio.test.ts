import { beforeAll, describe, expect, test } from 'bun:test';

const EXT = new URL('../../../extension-audio/', import.meta.url).pathname;
let lib: any;
let data: any;

beforeAll(async () => {
  (globalThis as any).window = globalThis;
  for (const file of ['state.ts', 'apu.ts', 'ds.ts', 'seq.ts']) await import(EXT + file);
  lib = (globalThis as any).__peaLib;
  const css = await Bun.file(EXT + 'audio-sfx.css').text();
  data = JSON.parse(atob(css.match(/--pe-audio-sfx: "([^"]+)"/)![1]));
  for (let i = 1; i <= data.cries.files; i++) {
    const text = await Bun.file(`${EXT}audio-cries-${i}.css`).text();
    for (const m of text.matchAll(/--pe-cry-(\d+): "([^"]+)"/g)) cryBins[Number(m[1])] = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  }
});
const cryBins: Record<number, Uint8Array> = {};

describe('sound state', () => {
  test('missing state takes the defaults', () => {
    const s = lib.state.cleanSound(null);
    expect(s.master.volume).toBe(0.35);
    expect(s.windows.battle.muted).toBe(true);
    expect(s.windows.summary.muted).toBe(false);
  });
  test('bad fields fall back, unknown keys survive', () => {
    const s = lib.state.cleanSound({ master: { volume: 'loud' }, windows: { battle: { muted: 'yes' }, summary: 3, other: { muted: true, x: 1 } }, extra: 1 });
    expect(s.master.volume).toBe(0.35);
    expect(s.windows.battle.muted).toBe(true);
    expect(s.windows.summary.muted).toBe(false);
    expect(s.windows.other).toEqual({ muted: true, x: 1 });
    expect(s.extra).toBe(1);
  });
  test('volume clamps to 0..1', () => {
    expect(lib.state.cleanSound({ master: { volume: 4 } }).master.volume).toBe(1);
    expect(lib.state.cleanSound({ master: { volume: -1 } }).master.volume).toBe(0);
  });
  test('gain is master volume, or 0 while that window is muted', () => {
    const s = lib.state.cleanSound({ master: { volume: 0.5 }, windows: { battle: { muted: true }, summary: { muted: false } } });
    expect(lib.state.gainFor(s, 'summary')).toBe(0.5);
    expect(lib.state.gainFor(s, 'battle')).toBe(0);
  });
  test('readSound survives a throwing store', () => {
    const s = lib.state.readSound({ getItem: () => { throw new Error('blocked'); } });
    expect(s.windows.summary.muted).toBe(false);
  });
});

describe('sequencer', () => {
  const run = (id: string) => lib.seq.renderSong(data.songs[id], data.tables, 48000, 0.5 / 15);

  test('the slice-1 effects are all present', () => {
    expect(Object.keys(data.songs).sort()).toEqual(['SE_BALL', 'SE_FAILURE', 'SE_SELECT', 'SE_WIN_OPEN']);
  });
  test('SE_SELECT: tempo 300 runs 2 ticks a frame, notes on ticks 0, 3, 6, 9, 12', () => {
    const r = run('SE_SELECT');
    expect(r.notes.map((n: number[]) => n[0])).toEqual([0, 2, 3, 5, 6]);
    // As5 bent +13/64 of 2 semitones: CGB table key 58 plus 104/256 toward key 59
    expect(r.notes[0]).toEqual([0, 1, 1978]);
    expect(r.endFrame).toBe(10);
  });
  test('SE_FAILURE: tempo 240 runs 1.6 ticks a frame', () => {
    expect(run('SE_FAILURE').notes.map((n: number[]) => n[0])).toEqual([0, 2, 4, 15]);
  });
  test('SE_WIN_OPEN: notes go to the noise channel through the noise table', () => {
    expect(run('SE_WIN_OPEN').notes).toEqual([[0, 4, 0x35], [3, 4, 0x01]]);
  });
  test('renders are finite, bounded, end, and repeat exactly', () => {
    for (const id of Object.keys(data.songs)) {
      const a = run(id).samples;
      const b = run(id).samples;
      expect(a.length).toBeGreaterThan(1000);
      expect(a.length).toBeLessThan(48000);
      expect(a.every((v: number) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    }
  });
});

describe('cries', () => {
  const render = (dex: number) => {
    const wave = new lib.ds.Wave(cryBins[dex], data.tables.delta);
    return { wave, r: lib.seq.renderSong(lib.ds.crySong(data.cries.params, wave), data.tables, 48000, 0.5 / 15) };
  };
  test('all 386 cries are packed, with name keys', () => {
    expect(Object.keys(cryBins).length).toBe(386);
    expect(data.cries.keys.sceptile).toBe(254);
    expect(data.cries.keys.nidoranf).toBe(29);
    expect(data.cries.params).toMatchObject({ volume: 120, priority: 10, pitch: 15360, length: 140, release: 0 });
  });
  test('DPCM blocks decode to the first raw byte, then deltas', () => {
    const { wave } = render(254);
    const raw = cryBins[254];
    expect(wave.compressed).toBe(true);
    expect(wave.freq / 1024).toBe(10512);
    expect(wave.at(0)).toBe((raw[16] << 24) >> 24);
  });
  test('Sceptile: key 60 plays the sample at its own rate, so the cry lasts as long as the sample', () => {
    const { wave, r } = render(254);
    expect(r.notes).toEqual([[0, 0, 10512]]);
    const seconds = r.samples.length / 48000;
    expect(Math.abs(seconds - wave.size / 10512)).toBeLessThan(0.05);
  });
  test('a long cry is cut by the 140-frame wait, then EOT with release 0', () => {
    const lengths = Object.keys(cryBins).map((dex) => {
      const wave = new lib.ds.Wave(cryBins[Number(dex)], data.tables.delta);
      return wave.size / (wave.freq / 1024);
    });
    const longest = Math.max(...lengths);
    const dex = Number(Object.keys(cryBins)[lengths.indexOf(longest)]);
    const { r } = render(dex);
    if (longest > 141 / 59.7275) expect(r.samples.length / 48000).toBeLessThan(143 / 59.7275);
    expect(r.samples.every((v: number) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
  });
});
