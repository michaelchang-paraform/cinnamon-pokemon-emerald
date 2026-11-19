// Music for window.__peAudio: music(id, { window }), fanfare(id, { window }), stopMusic({ window, fadeMs, free }),
// prepareMusic(id) and musicList(), with a window 'pe-music-state' event for every change. All windows share one
// channel (channel.ts). A song renders once, in 300-frame tasks, to the intro plus one loop body at 32,768 Hz, and
// is kept as an AudioBuffer until stopMusic({ free: true }).
declare const cinnamon: { onDispose(fn: () => void): void };

type MusicOptions = { window?: string };
type StopOptions = { window?: string; fadeMs?: number; free?: boolean };
type Prepared = { buffer: AudioBuffer; loopStart: number; loopEnd: number; loop: boolean };
type Playing = { id: string; source: AudioBufferSourceNode; gain: GainNode; startedAt: number; offset: number };

const musicLib = (window as any).__peaLib;
const core = musicLib.core;
const MUSIC_RATE = 32768;
const CHUNK_FRAMES = 300;
// music bus only: a gentle one-pole high-pass (-4.5 dB at 60 Hz, -2.2 dB at 100 Hz, -0.7 dB at 200 Hz)
const MUSIC_HIGH_PASS_HZ = 80;
// a fanfare cuts in over the battle music for its length in frames, then the music carries on
// fanfares and their lengths in frames, from the build's data
const fanfareFrames = (id: string): number | undefined => core.data()?.tables?.engine?.fanfares?.[id];
// for a picker: each battle track with the victory track the game plays after a win (battle_main.c
// HandleEndTurn_BattleWon by trainer class; battle_script_commands.c Cmd_getexp for wild battles)
const MUSIC_LIST = [
  { id: 'MUS_VS_WILD', title: 'VS. WILD POKéMON', victoryId: 'MUS_VICTORY_WILD' },
  { id: 'MUS_VS_TRAINER', title: 'VS. TRAINER', victoryId: 'MUS_VICTORY_TRAINER' },
  { id: 'MUS_VS_RIVAL', title: 'VS. RIVAL', victoryId: 'MUS_VICTORY_TRAINER' },
  { id: 'MUS_VS_GYM_LEADER', title: 'VS. GYM LEADER', victoryId: 'MUS_VICTORY_GYM_LEADER' },
  { id: 'MUS_VS_AQUA_MAGMA', title: 'VS. TEAM AQUA/MAGMA', victoryId: 'MUS_VICTORY_AQUA_MAGMA' },
  { id: 'MUS_VS_AQUA_MAGMA_LEADER', title: 'VS. AQUA/MAGMA LEADER', victoryId: 'MUS_VICTORY_AQUA_MAGMA' },
  { id: 'MUS_VS_ELITE_FOUR', title: 'VS. ELITE FOUR', victoryId: 'MUS_VICTORY_LEAGUE' },
  { id: 'MUS_VS_CHAMPION', title: 'VS. CHAMPION', victoryId: 'MUS_VICTORY_LEAGUE' },
  { id: 'MUS_VS_FRONTIER_BRAIN', title: 'VS. FRONTIER BRAIN', victoryId: 'MUS_VICTORY_GYM_LEADER' },
  { id: 'MUS_VS_REGI', title: 'VS. REGI TRIO', victoryId: 'MUS_VICTORY_WILD' },
  { id: 'MUS_VS_KYOGRE_GROUDON', title: 'VS. KYOGRE/GROUDON', victoryId: 'MUS_VICTORY_WILD' },
  { id: 'MUS_VS_RAYQUAZA', title: 'VS. RAYQUAZA', victoryId: 'MUS_VICTORY_WILD' },
];

let head: any = null;
const samples: Record<string, unknown> = {};
const prepared = new Map<string, Promise<Prepared>>();
const done = new Map<string, Prepared>();
// while a cry plays the music drops to the level the build read for cries (tables.engine.duck)
const cryDuck = (): number => core.data()?.tables?.engine?.duck ?? 1;

function emit(win: string, id: string | null, state: string, extra: Record<string, unknown> = {}): void {
  try {
    window.dispatchEvent(new CustomEvent('pe-music-state', { detail: { window: win, id, state, at: Date.now(), ...extra } }));
  } catch {}
}

function musicId(id: string): string {
  const upper = String(id).toUpperCase();
  return upper.startsWith('MUS_') ? upper : `MUS_${upper}`;
}

function loadHead(): any {
  if (head) return head;
  const data = core.data();
  if (!data?.music) throw new Error('audio data has no music');
  head = JSON.parse(atob(core.readProp('pe-audio-music', '--pe-music')));
  const bin = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  for (const name of data.music.samples) {
    const raw = core.readProp('pe-audio-music', `--pe-music-${name}`);
    if (raw) samples[name] = new musicLib.ds.Wave(bin(raw), data.tables.delta);
  }
  return head;
}

// renders off the click path: 300 frames per task, then keeps only the intro plus one loop (or the whole fanfare)
function prepareMusic(idIn: string): Promise<Prepared> {
  const id = musicId(idIn);
  let job = prepared.get(id);
  if (job) return job;
  job = core.ready.then(
    () =>
      new Promise<Prepared>((resolve, reject) => {
        try {
          const h = loadHead();
          const songData = h.songs[id];
          if (!songData) throw new Error(`no music ${id}`);
          const song = { ...songData, tones: h.tones, splits: h.splits, waves: h.waves, samples };
          const data = core.data();
          const loops = fanfareFrames(id) ? 0 : 2;
          const r = new musicLib.seq.Renderer(song, data.tables, MUSIC_RATE, 0.5 / 15, { stride: 4, loops, maxFrames: 60 * 400 });
          const next = () => {
            if (core.isDisposed()) return reject(new Error('disposed'));
            try {
              if (!r.step(CHUNK_FRAMES)) {
                window.setTimeout(next, 0);
                return;
              }
              const res = r.result(!loops);
              musicLib.seq.highPass(res.samples, MUSIC_RATE, MUSIC_HIGH_PASS_HZ);
              const cut = loops ? musicLib.seq.loopCut(res, Math.round(MUSIC_RATE * 0.02)) : null;
              let pcm: Float32Array = cut ? cut.samples : res.samples;
              const hold = Math.round(((fanfareFrames(id) ?? 0) / 59.7275) * MUSIC_RATE);
              if (pcm.length < hold) {
                const padded = new Float32Array(hold);
                padded.set(pcm);
                pcm = padded;
              }
              const buffer = new AudioBuffer({ length: Math.max(1, pcm.length), numberOfChannels: 1, sampleRate: MUSIC_RATE });
              buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
              const track = { buffer, loop: !!cut, loopStart: cut ? cut.loopStart / MUSIC_RATE : 0, loopEnd: cut ? cut.loopEnd / MUSIC_RATE : buffer.duration };
              done.set(id, track);
              resolve(track);
            } catch (error) {
              reject(error);
            }
          };
          next();
        } catch (error) {
          reject(error);
        }
      }),
  );
  job.catch(() => prepared.delete(id));
  prepared.set(id, job);
  return job;
}

// the one source sounding on the shared channel, and where it is now in seconds into its buffer
let current: Playing | null = null;
const fading = new Set<Playing>();
function position(): number {
  const p = current;
  const track = p ? done.get(p.id) : null;
  const ctx = core.current();
  if (!p || !track || !ctx) return 0;
  const t = p.offset + (ctx.currentTime - p.startedAt);
  if (!track.loop || t < track.loopEnd) return Math.min(t, track.buffer.duration);
  return track.loopStart + ((t - track.loopStart) % (track.loopEnd - track.loopStart));
}

const channel = new musicLib.channel.MusicChannel({
  gain: (win: string) => core.gain(win),
  unlocked: () => core.current()?.state === 'running',
  now: () => Date.now(),
  position,
  prepare: (id: string) => prepareMusic(id),
  start: (id: string, win: string, offset: number, ended: () => void) => {
    const ctx = core.context();
    const track = done.get(id);
    if (!ctx || !track) return;
    const gain = ctx.createGain();
    gain.connect(core.windowGain(win));
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = track.loop;
    source.loopStart = track.loopStart;
    source.loopEnd = track.loopEnd;
    source.connect(gain);
    const p: Playing = { id, source, gain, startedAt: ctx.currentTime, offset: Math.min(offset, track.buffer.duration) };
    source.onended = () => {
      gain.disconnect();
      if (current !== p) return;
      current = null;
      ended();
    };
    source.start(0, p.offset);
    current = p;
  },
  stop: (fadeMs: number) => {
    const p = current;
    const ctx = core.current();
    current = null;
    if (!p || !ctx) return;
    const now = ctx.currentTime;
    try {
      if (fadeMs > 0) {
        p.gain.gain.cancelScheduledValues(now);
        p.gain.gain.setValueAtTime(p.gain.gain.value, now);
        p.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
        p.source.stop(now + fadeMs / 1000 + 0.02);
        fading.add(p);
        p.source.addEventListener('ended', () => fading.delete(p));
      } else p.source.stop();
    } catch {}
  },
  cutFading: () => {
    for (const p of fading) {
      try {
        p.source.stop();
      } catch {}
    }
    fading.clear();
  },
  emit: (win: string, id: string | null, state: string) => emit(win, id, state),
  isFanfare: (id: string) => !!fanfareFrames(id),
});

function music(idIn: string, opts: MusicOptions = {}): void {
  channel.music(musicId(idIn), core.windowName(opts.window, 'battle'));
}

// MUS_LEVEL_UP or MUS_EVOLVED: pauses whatever music plays in any window, then lets it carry on; never queued
function fanfare(idIn: string, opts: MusicOptions = {}): boolean {
  const id = musicId(idIn);
  if (!fanfareFrames(id)) return false;
  return channel.playFanfare(id, core.windowName(opts.window, 'summary'));
}

function stopMusic(opts: StopOptions = {}): void {
  channel.stopFor(opts.window ? core.windowName(opts.window, 'battle') : null, opts.fadeMs ?? 0);
  if (opts.free) {
    prepared.clear();
    done.clear();
  }
}

// a cry lowers the one music channel, whichever window the cry is for
core.onCry((_win: string, seconds: number) => {
  const p = current;
  const ctx = core.current();
  if (!p || !ctx) return;
  const g = p.gain.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(cryDuck(), now + 0.01);
  g.setValueAtTime(cryDuck(), now + seconds);
  g.linearRampToValueAtTime(1, now + seconds + 0.01);
});

core.onState(() => channel.stateChanged());
core.onUnlock(() => channel.unlockedNow());

cinnamon.onDispose(() => {
  channel.stopFor(null, 0);
  prepared.clear();
  done.clear();
});

Object.assign(core.api, {
  music,
  fanfare,
  stopMusic,
  prepareMusic: (id: string) => prepareMusic(id).then(() => undefined),
  musicList: () => {
    const have = new Set<string>(core.data()?.music?.ids ?? []);
    return MUSIC_LIST.filter((m) => have.has(m.id) && have.has(m.victoryId)).map((m) => ({ ...m }));
  },
  musicState: () => ({ music: channel.bgm?.id ?? null, musicWindow: channel.bgm?.window ?? null, fanfare: channel.fanfare?.id ?? null, sounding: channel.sounding }),
});
