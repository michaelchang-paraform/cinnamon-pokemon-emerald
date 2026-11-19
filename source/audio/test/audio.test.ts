import { beforeAll, describe, expect, test } from 'bun:test';

const EXT = new URL('../../../extension-audio/', import.meta.url).pathname;
let lib: any;
let data: any;

beforeAll(async () => {
  (globalThis as any).window = globalThis;
  for (const file of ['state.ts', 'apu.ts', 'ds.ts', 'seq.ts', 'channel.ts']) await import(EXT + file);
  lib = (globalThis as any).__peaLib;
  const css = await Bun.file(EXT + 'audio-sfx.css').text();
  data = JSON.parse(atob(css.match(/--pe-audio-sfx: "([^"]+)"/)![1]));
  for (let i = 1; i <= data.sfx.files; i++) {
    const text = await Bun.file(`${EXT}audio-sfx-samples-${i}.css`).text();
    for (const m of text.matchAll(/--pe-sfx-(\w+): "([^"]+)"/g)) sfxBins[m[1]] = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  }
  for (let i = 1; i <= data.cries.files; i++) {
    const text = await Bun.file(`${EXT}audio-cries-${i}.css`).text();
    for (const m of text.matchAll(/--pe-cry-(\d+): "([^"]+)"/g)) cryBins[Number(m[1])] = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  }
});
const cryBins: Record<number, Uint8Array> = {};
const sfxBins: Record<string, Uint8Array> = {};

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
  test('a chat window entry survives cleaning and gates its own gain', () => {
    const s = lib.state.cleanSound({ windows: { chat: { muted: true } } });
    expect(s.windows.chat).toEqual({ muted: true });
    expect(lib.state.gainFor(s, 'chat')).toBe(0);
    expect(lib.state.gainFor(lib.state.cleanSound({ windows: { chat: { muted: false } } }), 'chat')).toBe(0.35);
  });
  test('readSound survives a throwing store', () => {
    const s = lib.state.readSound({ getItem: () => { throw new Error('blocked'); } });
    expect(s.windows.summary.muted).toBe(false);
  });
});

describe('sequencer', () => {
  const sfxSong = (id: string, pitX = 0) => {
    const song = data.songs[id];
    const samples = Object.fromEntries((song.sn ?? []).map((n: string) => [n, new lib.ds.Wave(sfxBins[n], data.tables.delta)]));
    return { ...song, tones: data.sfx.tones, splits: data.sfx.splits, waves: data.sfx.waves, samples, pitX };
  };
  const run = (id: string, pitX = 0) => lib.seq.renderSong(sfxSong(id, pitX), data.tables, 48000, 0.5 / 15);
  const LOOPING = ['SE_LOW_HEALTH', 'SE_M_GUST'];
  test('every battle effect renders and ends, or loops on its first track (SE_LOW_HEALTH, SE_M_GUST)', () => {
    for (const id of Object.keys(data.songs)) {
      const r = new lib.seq.Renderer(sfxSong(id), data.tables, 48000, 0.5 / 15, { loops: 2 });
      while (!r.step(1000));
      const res = r.result(true);
      expect(res.notes.length).toBeGreaterThan(0);
      if (LOOPING.includes(id)) {
        expect(res.loops.length).toBe(2);
        const cut = lib.seq.loopCut(res, 960);
        expect(Math.abs(cut.samples[cut.loopEnd - 1] - cut.samples[cut.loopStart])).toBeLessThan(0.2);
      } else {
        expect(res.fineFrame).toBeGreaterThan(-1);
        expect(res.samples.length).toBeLessThan(48000 * 6);
      }
    }
  });
  test('pitch: +12 semitones raises a CGB note one octave (register 2048 - f halves)', () => {
    const base = run('SE_SELECT').notes[0][2] & 0x7ff;
    const up = run('SE_SELECT', 12 * 256).notes[0][2] & 0x7ff;
    expect(Math.abs((2048 - base) / (2048 - up) - 2)).toBeLessThan(0.1);
  });
  test('the move and status cues come from the animation scripts', () => {
    expect(data.sfx.uses.SE_M_TOXIC.status).toContain('poison');
    expect(data.sfx.uses.SE_M_SNORE.status).toContain('sleep');
    expect(data.sfx.uses.SE_BALL_OPEN.battle).toBe(true);
    const moves = new Set(Object.values<any>(data.sfx.uses).flatMap((u) => u.moves));
    expect(moves.size).toBeGreaterThan(100);
  });
  test('SE_SHINY and SE_EXP_MAX play the harp sample on DirectSound', () => {
    for (const id of ['SE_SHINY', 'SE_EXP_MAX']) expect(run(id).notes.some((n: number[]) => n[1] === 0)).toBe(true);
  });
  test('SE_EXP is one tied square note, bent up again and again, that ends with EOT', () => {
    const r = run('SE_EXP');
    expect(r.notes.length).toBe(1);
    expect(r.notes[0][1]).toBe(1);
    expect(r.fineFrame).toBeGreaterThan(60);
  });

  test('the slice-1 effects are all present', () => {
    for (const id of ['SE_BALL', 'SE_EXP', 'SE_EXP_MAX', 'SE_FAILURE', 'SE_SELECT', 'SE_SHINY', 'SE_WIN_OPEN']) expect(data.songs[id]).toBeDefined();
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
    for (const id of Object.keys(data.songs).filter((i) => !LOOPING.includes(i))) {
      const a = run(id).samples;
      const b = run(id).samples;
      expect(a.length).toBeGreaterThan(1000);
      expect(a.length).toBeLessThan(48000 * 6);
      expect(a.every((v: number) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    }
  });
});

describe('cries', () => {
  const render = (dex: number) => {
    const wave = new lib.ds.Wave(cryBins[dex], data.tables.delta);
    return { wave, r: lib.seq.renderSong(lib.ds.crySong(data.cries.params, data.cries.songs.normal, wave, data.tables), data.tables, 48000, 0.5 / 15) };
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
  test('weak and faint cries: pitch settings 15000 and 14440 lower the key by 1.8125 and 3.1875 semitones', () => {
    const modes = data.cries.modes;
    expect(modes.weak).toEqual({ pitch: 15000 });
    expect(modes.faint).toEqual({ release: 200, pitch: 14440 });
    const wave = new lib.ds.Wave(cryBins[254], data.tables.delta);
    const rate = (mode: string) => lib.seq.renderSong(lib.ds.crySong(data.cries.params, data.cries.songs[mode], wave, data.tables), data.tables, 48000, 0.5 / 15).notes[0][2];
    expect(Math.abs(1200 * Math.log2(rate('weak') / 10512) + 181.25)).toBeLessThan(2);
    expect(Math.abs(1200 * Math.log2(rate('faint') / 10512) + 318.75)).toBeLessThan(2);
  });
  test('battle cry modes: chorus adds a detuned second track, growl and echo start with the sample reversed', () => {
    const wave = new lib.ds.Wave(cryBins[254], data.tables.delta);
    const part = (mode: string) => lib.seq.renderSong(lib.ds.crySong(data.cries.params, data.cries.songs[mode], wave, data.tables), data.tables, 48000, 0.5 / 15);
    expect(part('high_pitch').notes.length).toBe(2);
    expect(part('echo_start').notes.length).toBe(2);
    expect(part('growl_1').notes.length).toBe(1);
    expect(data.cries.modes.growl_1.reverse).toBe(true);
    expect(data.cries.modes.echo_start.reverse).toBe(true);
    // reversed: the first output samples come from the sample's end
    const fwd = part('roar_1').samples;
    const rev = part('growl_1').samples;
    expect(Buffer.from(fwd.buffer).equals(Buffer.from(rev.buffer))).toBe(false);
  });
  test('growl and roar start their second cry the frame after the first song ends; echo cuts the first', () => {
    const wave = new lib.ds.Wave(cryBins[25], data.tables.delta);
    const fine = (mode: string) => lib.seq.renderSong(lib.ds.crySong(data.cries.params, data.cries.songs[mode], wave, data.tables), data.tables, 48000, 0.5 / 15).fineFrame;
    expect(fine('growl_1')).toBe(15);
    expect(fine('roar_1')).toBe(10);
    const growl = lib.seq.cryClip(wave, data.cries, data.tables, 'growl', 48000, 0.5 / 15);
    const second = Math.round((16 * 17556 * 48000) / (1 << 20));
    expect(Math.abs(growl[second - 1])).toBeLessThan(1);
    expect(growl.length).toBeGreaterThan(second);
    const echo = lib.seq.cryClip(wave, data.cries, data.tables, 'echo', 48000, 0.5 / 15);
    expect(echo.length).toBeGreaterThan(Math.round((29 * 17556 * 48000) / (1 << 20)));
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

describe('music', () => {
  let head: any;
  const samples: Record<string, unknown> = {};
  beforeAll(async () => {
    const props: Record<string, string> = {};
    for (let i = 1; i <= data.music.files; i++) {
      const text = await Bun.file(`${EXT}audio-music-${i}.css`).text();
      for (const m of text.matchAll(/(--pe-music[\w-]*): "([^"]+)"/g)) props[m[1]] = m[2];
    }
    head = JSON.parse(atob(props['--pe-music']));
    for (const name of data.music.samples) samples[name] = new lib.ds.Wave(Uint8Array.from(atob(props[`--pe-music-${name}`]), (c) => c.charCodeAt(0)), data.tables.delta);
  });
  const song = (id: string) => ({ ...head.songs[id], tones: head.tones, splits: head.splits, waves: head.waves, samples });

  test('every note voice resolves: no tone left out of the data', () => {
    for (const id of ['MUS_VS_TRAINER', 'MUS_VICTORY_TRAINER', 'MUS_LEVEL_UP']) {
      for (const index of Object.values<number>(head.songs[id].v)) expect(head.tones[index]).toBeDefined();
    }
  });
  test('MUS_LEVEL_UP plays DirectSound and CGB notes and ends', () => {
    const r = lib.seq.renderSong(song('MUS_LEVEL_UP'), data.tables, 32768, 0.5 / 15);
    const chans = new Set(r.notes.map((n: number[]) => n[1]));
    expect(chans.has(0)).toBe(true);
    expect(r.notes.length).toBeGreaterThan(20);
    expect(r.samples.length / 32768).toBeLessThan(2);
  });
  test('MUS_VS_TRAINER loops on the first track every 4,655 frames after a 727-frame intro, and the cut is seamless', () => {
    const r = new lib.seq.Renderer(song('MUS_VS_TRAINER'), data.tables, 32768, 0.5 / 15, { stride: 4, loops: 2, maxFrames: 60 * 400 });
    while (!r.step(1000));
    const res = r.result(false);
    expect(res.loops).toEqual([5382, 10037]);
    const cut = lib.seq.loopCut(res, Math.round(32768 * 0.02));
    expect(cut.loopStart).toBe(res.frameStarts[727]);
    expect(Math.abs(cut.samples[cut.loopEnd - 1] - cut.samples[cut.loopStart])).toBeLessThan(0.05);
    expect(Math.abs(cut.samples[cut.loopStart] - cut.samples[cut.loopStart - 1])).toBeLessThan(0.05);
  });
});

describe('music list', () => {
  test('every picker track and its victory track is in the data', async () => {
    const src = await Bun.file(`${EXT}music.ts`).text();
    const ids = [...src.matchAll(/id: '(MUS_\w+)'.*?victoryId: '(MUS_\w+)'/g)].flatMap((m) => [m[1], m[2]]);
    expect(ids.length).toBe(24);
    for (const id of ids) expect(data.music.ids).toContain(id);
  });
});

describe('music channel', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function rig(opts: { muted?: Record<string, boolean>; unlocked?: boolean } = {}) {
    const t = { now: 0, unlocked: opts.unlocked ?? true, muted: { ...(opts.muted ?? {}) } as Record<string, boolean>, pos: 0 };
    const log: string[] = [];
    let ended: (() => void) | null = null;
    const ch = new lib.channel.MusicChannel({
      gain: (w: string) => (t.muted[w] ? 0 : 0.35),
      unlocked: () => t.unlocked,
      now: () => t.now,
      position: () => t.pos,
      prepare: () => Promise.resolve(),
      start: (id: string, w: string, offset: number, end: () => void) => {
        log.push(`start ${id} ${w} @${offset}`);
        ended = end;
      },
      stop: (fadeMs: number) => log.push(fadeMs ? `stop fade ${fadeMs}` : 'stop'),
      cutFading: () => log.push('cut fading'),
      emit: (w: string, id: string, state: string) => log.push(`${state} ${id}`),
      isFanfare: (id: string) => id in data.tables.engine.fanfares,
    });
    return { t, log, ch, end: () => ended?.() };
  }

  test('a start while locked waits for a gesture within 2 s', async () => {
    const r = rig({ unlocked: false });
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    expect(r.log).toContain('waiting-gesture MUS_VS_TRAINER');
    r.t.now = 1500;
    r.t.unlocked = true;
    r.ch.unlockedNow();
    await flush();
    expect(r.log).toContain('start MUS_VS_TRAINER battle @0');
  });
  test('a queued start older than 2 s expires instead of playing late', async () => {
    const r = rig({ unlocked: false });
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.t.now = 2500;
    r.t.unlocked = true;
    r.ch.unlockedNow();
    await flush();
    expect(r.log).toContain('expired MUS_VS_TRAINER');
    expect(r.log.some((l: string) => l.startsWith('start'))).toBe(false);
  });
  test('a fanfare never queues', async () => {
    const r = rig({ unlocked: false });
    expect(r.ch.playFanfare('MUS_LEVEL_UP', 'summary')).toBe(false);
    r.t.unlocked = true;
    r.ch.unlockedNow();
    await flush();
    expect(r.log).toEqual(['skipped MUS_LEVEL_UP']);
  });
  test('one channel: a fanfare in another window pauses the battle music, then it resumes where it was', async () => {
    const r = rig();
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.t.pos = 12.5;
    r.ch.music('MUS_LEVEL_UP', 'summary');
    await flush();
    expect(r.log.slice(-3)).toEqual(['stop', 'start MUS_LEVEL_UP summary @0', 'playing MUS_LEVEL_UP']);
    r.end();
    await flush();
    expect(r.log).toContain('start MUS_VS_TRAINER battle @12.5');
    expect(r.ch.sounding).toBe('bgm');
  });
  test('two music tracks never sound at once: a new music() replaces the old one', async () => {
    const r = rig();
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.ch.music('MUS_VS_WILD', 'summary');
    await flush();
    const starts = r.log.filter((l: string) => l.startsWith('start') || l === 'stop');
    expect(starts).toEqual(['start MUS_VS_TRAINER battle @0', 'stop', 'start MUS_VS_WILD summary @0']);
  });
  test('muting the music window stops it and keeps its place; unmuting resumes there', async () => {
    const r = rig();
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.t.pos = 30;
    r.t.muted.battle = true;
    r.ch.stateChanged();
    expect(r.log.slice(-2)).toEqual(['stop', 'muted MUS_VS_TRAINER']);
    r.t.muted.battle = false;
    r.ch.stateChanged();
    await flush();
    expect(r.log).toContain('start MUS_VS_TRAINER battle @30');
  });
  test('a start during a fade-out cuts the fading track first, so two tracks never sound at once', async () => {
    const r = rig();
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.ch.stopFor('battle', 1000);
    r.ch.music('MUS_VS_WILD', 'battle');
    await flush();
    const order = r.log.filter((l: string) => /^(start |stop$|stop fade|cut)/.test(l));
    expect(order).toEqual(['start MUS_VS_TRAINER battle @0', 'stop fade 1000', 'cut fading', 'start MUS_VS_WILD battle @0']);
  });
  test('a fanfare during a fade-out also cuts the fading track first', async () => {
    const r = rig();
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.ch.stopFor('battle', 500);
    r.ch.playFanfare('MUS_LEVEL_UP', 'summary');
    await flush();
    const order = r.log.filter((l: string) => /^(start |stop$|stop fade|cut)/.test(l));
    expect(order.slice(-2)).toEqual(['cut fading', 'start MUS_LEVEL_UP summary @0']);
  });
  test('a muted music window reports muted once, not on every gesture', async () => {
    const r = rig({ muted: { battle: true } });
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    r.ch.unlockedNow();
    r.ch.unlockedNow();
    await flush();
    expect(r.log.filter((l: string) => l === 'muted MUS_VS_TRAINER').length).toBe(1);
  });
  test('a fanfare for a muted window is dropped and the music keeps playing', async () => {
    const r = rig({ muted: { summary: true } });
    r.ch.music('MUS_VS_TRAINER', 'battle');
    await flush();
    expect(r.ch.playFanfare('MUS_EVOLVED', 'summary')).toBe(false);
    expect(r.log).not.toContain('stop');
    expect(r.ch.sounding).toBe('bgm');
  });
});

describe('audio context', () => {
  test('only the capture-phase gesture listener creates the AudioContext', async () => {
    const src = await Bun.file(`${EXT}page.ts`).text();
    expect(src.match(/new AudioContext\(/g)?.length).toBe(1);
    const unlock = src.slice(src.indexOf('function unlock()'), src.indexOf('function context()'));
    expect(unlock).toContain('new AudioContext(');
    expect(unlock).toMatch(/\['pointerdown', 'keydown', 'touchstart'\]/);
    expect(unlock).toContain('addEventListener(type, unlock, true)');
  });
});
