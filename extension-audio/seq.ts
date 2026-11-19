// The m4a (MP2K) sound driver for one song: MPlayMain's sequencer (src/m4a_1.s), ply_note, TrkVolPitSet and
// CgbSound (src/m4a.c), run once per GBA frame against the register model in apu.ts, plus the DirectSound channels
// in ds.ts. Each song renders alone into a Float32Array, so channel priority against other players does not apply.
const seqLib = ((window as any).__peaLib ??= {});
const { Apu, FRAME_TICKS } = seqLib.apu;
const { midiKeyToFreq, dsFrame, DS_SAMPLES } = seqLib.ds;

type Tables = { clock: number[]; cgbScale: number[]; cgbFreq: number[]; noise: number[]; cgb3Vol: number[]; scale: number[]; freq: number[]; delta: number[] };
type SongData = { p: number; r: number; t: number[]; b?: string; bytes?: Uint8Array; v: Record<string, number[]>; w?: Record<string, any> };
type Tone = { type: number; key: number; length: number; panSweep: number; wav: number; attack: number; decay: number; sustain: number; release: number };

const SF_START = 0x80;
const SF_STOP = 0x40;
const SF_IEC = 0x04;
const SF_ENV = 0x03;
const SF_ON = SF_START | SF_STOP | SF_IEC | SF_ENV;
const ENV_ATTACK = 3;
const ENV_DECAY = 2;
const ENV_SUSTAIN = 1;
const ENV_RELEASE = 0;
const MO_PIT = 2;
const MO_VOL = 1;
const FLG_VOLSET = 0x01;
const FLG_VOLCHG = 0x03;
const FLG_PITSET = 0x04;
const FLG_PITCHG = 0x0c;
const FLG_START = 0x40;
const FLG_EXIST = 0x80;
const TYPE_CGB = 0x07;
const TYPE_FIX = 0x08;
const ENV_INC = 0x08;
// a song that never ends (a loop) stops here; interface sounds and cries end in under 3 seconds
const MAX_FRAMES = 60 * 8;
// SoundInfo.maxChans: m4aSoundMode(5 << SOUND_MODE_MAXCHN_SHIFT)
const DS_CHANNELS = 5;

const s8 = (v: number) => ((v & 0xff) ^ 0x80) - 0x80;
const u8 = (v: number) => v & 0xff;

function toneFrom(bytes: number[]): Tone {
  return { type: bytes[0], key: bytes[1], length: bytes[2], panSweep: bytes[3], wav: bytes[4], attack: bytes[8], decay: bytes[9], sustain: bytes[10], release: bytes[11] };
}

class CgbChan {
  sf = 0;
  modify = 0;
  type = 0;
  key = 0;
  midiKey = 0;
  velocity = 0;
  gate = 0;
  priority = 0;
  rightVolume = 0;
  leftVolume = 0;
  attack = 0;
  decay = 0;
  sustain = 0;
  release = 0;
  envVol = 0;
  envGoal = 0;
  sustainGoal = 0;
  envCounter = 0;
  echoVol = 0;
  echoLen = 0;
  length = 0;
  sweep = 0;
  wav = 0;
  frequency = 0;
  n4 = 0;
  track: Track | null = null;
  // DirectSound only
  wave: any = null;
  count = 0;
  pos = 0;
  fw = 0;
  loop = false;
}

class Track {
  flags = 0;
  ptr = 0;
  wait = 0;
  running = 0;
  key = 0;
  velocity = 0;
  gate = 0;
  priority = 0;
  keyShift = 0;
  tune = 0;
  bend = 0;
  bendRange = 2;
  vol = 0;
  volX = 0x40;
  pan = 0;
  volMR = 0;
  volML = 0;
  keyM = 0;
  pitM = 0;
  mod = 0;
  modT = 0;
  modM = 0;
  lfoSpeed = 0x16;
  lfoSpeedC = 0;
  lfoDelay = 0;
  lfoDelayC = 0;
  repN = 0;
  level = 0;
  stack = [0, 0, 0];
  echoVol = 0;
  echoLen = 0;
  timer = 0;
  progress = 0;
  wave: any = null;
  tone: Tone = toneFrom([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  chans = new Set<CgbChan>();

  reset(): void {
    const ptr = this.ptr;
    Object.assign(this, new Track(), { ptr, flags: FLG_EXIST });
  }
}

class Player {
  readonly apu = new Apu();
  readonly cgb = [new CgbChan(), new CgbChan(), new CgbChan(), new CgbChan()];
  readonly ds = Array.from({ length: DS_CHANNELS }, () => new CgbChan());
  // the last frame's DirectSound mix, one value per 13,379 Hz sample
  readonly dsOut = new Float32Array(DS_SAMPLES);
  readonly tracks: Track[];
  readonly bytes: Uint8Array;
  readonly voices: Record<string, number[]>;
  tempoD = 150;
  tempoI = 150;
  tempoC = 0;
  playing = true;
  c15 = 0;
  frames = 0;
  endFrame = -1;
  // the frame whose tick ran FINE on the last track; endFrame is when MPlayMain then finds no track left
  fineFrame = -1;
  // [frame, chan, frequency register] for each note start, for tests and QA
  notes: [number, number, number][] = [];

  constructor(readonly song: SongData, readonly tables: Tables) {
    this.bytes = song.bytes ?? Uint8Array.from(atob(song.b ?? ''), (c) => c.charCodeAt(0));
    this.voices = song.v;
    this.tracks = song.t.map((ptr) => Object.assign(new Track(), { ptr, flags: FLG_EXIST | FLG_START }));
  }

  private byte(track: Track): number {
    return this.bytes[track.ptr++];
  }

  private word(at: number): number {
    const b = this.bytes;
    return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);
  }

  // MPlayMain: the tempo accumulator runs whole ticks while it holds 150, then applies pending volume and pitch
  frame(): void {
    if (this.playing) {
      this.tempoC += this.tempoI;
      while (this.tempoC >= 150) {
        let alive = false;
        for (const track of this.tracks) {
          if (!(track.flags & FLG_EXIST)) continue;
          alive = true;
          this.tick(track);
        }
        if (!alive) {
          this.playing = false;
          this.endFrame = this.frames;
          break;
        }
        this.tempoC -= 150;
      }
      if (this.playing) for (const track of this.tracks) if (track.flags & FLG_EXIST && track.flags & (FLG_VOLCHG | FLG_PITCHG)) this.applyTrack(track);
    }
    this.cgbSound();
    dsFrame(this.ds, this.dsOut);
    this.frames++;
  }

  private tick(track: Track): void {
    for (const chan of track.chans) {
      if (!(chan.sf & SF_ON)) {
        track.chans.delete(chan);
        continue;
      }
      if (chan.gate && --chan.gate === 0) chan.sf |= SF_STOP;
    }
    if (track.flags & FLG_START) track.reset();
    while (track.wait === 0 && track.flags & FLG_EXIST) {
      let cmd = this.bytes[track.ptr];
      if (cmd < 0x80) cmd = track.running;
      else {
        track.ptr++;
        if (cmd >= 0xbd) track.running = cmd;
      }
      if (cmd >= 0xcf) this.note(track, cmd - 0xcf);
      else if (cmd > 0xb0) this.command(track, cmd);
      else track.wait = this.tables.clock[cmd - 0x80];
    }
    if (!(track.flags & FLG_EXIST)) return;
    track.wait--;
    if (track.lfoSpeed && track.mod) {
      if (track.lfoDelayC) track.lfoDelayC--;
      else {
        track.lfoSpeedC = u8(track.lfoSpeedC + track.lfoSpeed);
        const c = track.lfoSpeedC;
        const tri = u8(c - 0x40) < 0x80 ? 0x80 - c : s8(c);
        const m = (track.mod * tri) >> 6;
        if (u8(track.modM ^ m)) {
          track.modM = s8(m);
          track.flags |= track.modT === 0 ? FLG_PITCHG : FLG_VOLCHG;
        }
      }
    }
  }

  private command(track: Track, cmd: number): void {
    const arg = () => this.byte(track);
    switch (cmd) {
      case 0xb2:
        track.ptr = this.word(track.ptr);
        break;
      case 0xb3:
        if (track.level >= 3) return this.fine(track);
        track.stack[track.level++] = track.ptr + 4;
        track.ptr = this.word(track.ptr);
        break;
      case 0xb4:
        if (track.level) track.ptr = track.stack[--track.level];
        break;
      case 0xb5: {
        const count = this.bytes[track.ptr];
        if (count === 0) track.ptr = this.word(track.ptr + 1);
        else if (++track.repN < count) track.ptr = this.word(track.ptr + 1);
        else {
          track.repN = 0;
          track.ptr += 5;
        }
        break;
      }
      case 0xb9:
        track.ptr += 3;
        break;
      case 0xba:
        track.priority = arg();
        break;
      case 0xbb:
        this.tempoD = arg() * 2;
        this.tempoI = this.tempoD;
        break;
      case 0xbc:
        track.keyShift = s8(arg());
        track.flags |= FLG_PITCHG;
        break;
      case 0xbd: {
        const index = arg();
        const tone = this.voices[index];
        if (!tone) throw new Error('voice missing from audio data');
        track.tone = toneFrom(tone);
        track.wave = this.song.w?.[index] ?? null;
        break;
      }
      case 0xbe:
        track.vol = arg();
        track.flags |= FLG_VOLCHG;
        break;
      case 0xbf:
        track.pan = s8(arg() - 0x40);
        track.flags |= FLG_VOLCHG;
        break;
      case 0xc0:
        track.bend = s8(arg() - 0x40);
        track.flags |= FLG_PITCHG;
        break;
      case 0xc1:
        track.bendRange = arg();
        track.flags |= FLG_PITCHG;
        break;
      case 0xc2:
        track.lfoSpeed = arg();
        if (!track.lfoSpeed) this.clearMod(track);
        break;
      case 0xc3:
        track.lfoDelay = arg();
        break;
      case 0xc4:
        track.mod = arg();
        if (!track.mod) this.clearMod(track);
        break;
      case 0xc5: {
        const t = arg();
        if (track.modT !== t) {
          track.modT = t;
          track.flags |= FLG_VOLCHG | FLG_PITCHG;
        }
        break;
      }
      case 0xc8:
        track.tune = s8(arg() - 0x40);
        track.flags |= FLG_PITCHG;
        break;
      case 0xcc:
        track.ptr += 2;
        break;
      case 0xcd:
        this.xcmd(track);
        break;
      case 0xce: {
        const key = this.bytes[track.ptr] < 0x80 ? (track.key = arg()) : track.key;
        for (const chan of track.chans) {
          if (chan.sf & (SF_START | SF_ENV) && !(chan.sf & SF_STOP) && chan.midiKey === key) {
            chan.sf |= SF_STOP;
            break;
          }
        }
        break;
      }
      default:
        this.fine(track);
    }
  }

  private xcmd(track: Track): void {
    const sub = this.byte(track);
    const arg = () => this.byte(track);
    if (sub === 0x0d) {
      track.progress = this.word(track.ptr) >>> 0;
      track.ptr += 4;
    } else if (sub === 0x01) track.ptr += 4;
    else if (sub === 0x02) track.tone.type = arg();
    else if (sub === 0x04) track.tone.attack = arg();
    else if (sub === 0x05) track.tone.decay = arg();
    else if (sub === 0x06) track.tone.sustain = arg();
    else if (sub === 0x07) track.tone.release = arg();
    else if (sub === 0x08) track.echoVol = arg();
    else if (sub === 0x09) track.echoLen = arg();
    else if (sub === 0x0a) track.tone.length = arg();
    else if (sub === 0x0b) track.tone.panSweep = arg();
    else if (sub === 0x0c) {
      // ply_xwait: re-run this XCMD once a tick until the timer reaches the operand
      const len = this.bytes[track.ptr] | (this.bytes[track.ptr + 1] << 8);
      if (track.timer < len) {
        track.timer++;
        track.ptr -= 2;
        track.wait = 1;
      } else {
        track.timer = 0;
        track.ptr += 2;
      }
    } else this.fine(track);
  }

  private clearMod(track: Track): void {
    track.modM = 0;
    track.lfoSpeedC = 0;
    track.flags |= track.modT === 0 ? FLG_PITCHG : FLG_VOLCHG;
  }

  // ply_fine: notes still sounding get STOP and release on their own; the track ends
  private fine(track: Track): void {
    for (const chan of track.chans) {
      if (chan.sf & SF_ON) chan.sf |= SF_STOP;
      chan.track = null;
    }
    track.chans.clear();
    track.flags = 0;
    this.fineFrame = this.frames;
  }

  private trkVolPitSet(track: Track): void {
    if (track.flags & FLG_VOLSET) {
      let x = (track.vol * track.volX) >>> 5;
      if (track.modT === 1) x = (x * (track.modM + 128)) >>> 7;
      let y = 2 * track.pan;
      if (track.modT === 2) y += track.modM;
      y = Math.max(-128, Math.min(127, y));
      track.volMR = ((y + 128) * x) >>> 8;
      track.volML = ((127 - y) * x) >>> 8;
    }
    if (track.flags & FLG_PITSET) {
      let x = (track.tune + track.bend * track.bendRange) * 4 + (track.keyShift << 8);
      if (track.modT === 0) x += 16 * track.modM;
      track.keyM = x >> 8;
      track.pitM = x & 0xff;
    }
    track.flags &= ~(FLG_PITSET | FLG_VOLSET);
  }

  private chnVolSet(chan: CgbChan, track: Track): void {
    chan.rightVolume = Math.min(255, (chan.velocity * 128 * track.volMR) >> 14);
    chan.leftVolume = Math.min(255, (chan.velocity * 127 * track.volML) >> 14);
  }

  private cgbFreq(chanNum: number, key: number, fine: number): number {
    const { noise, cgbScale, cgbFreq } = this.tables;
    if (chanNum === 4) return noise[key <= 20 ? 0 : Math.min(59, key - 21)];
    if (key <= 35) {
      fine = 0;
      key = 0;
    } else {
      key -= 36;
      if (key > 130) {
        key = 130;
        fine = 255;
      }
    }
    const at = (k: number) => cgbFreq[cgbScale[k] & 0xf] >> (cgbScale[k] >> 4);
    const a = at(key);
    const b = at(key + 1);
    return a + ((fine * (b - a)) >> 8) + 2048;
  }

  private note(track: Track, clockIndex: number): void {
    track.gate = this.tables.clock[clockIndex];
    if (this.bytes[track.ptr] < 0x80) {
      track.key = this.byte(track);
      if (this.bytes[track.ptr] < 0x80) {
        track.velocity = this.byte(track);
        if (this.bytes[track.ptr] < 0x80) track.gate += this.byte(track);
      }
    }
    const tone = track.tone;
    // drumset and keysplit voices need DirectSound data, which build-audio.mjs refuses for now
    if (tone.type & 0xc0) return;
    const num = tone.type & TYPE_CGB;
    if (!num) return this.dsNote(track, tone);
    const chan = this.cgb[num - 1];
    chan.track?.chans.delete(chan);
    track.chans.add(chan);
    chan.track = track;
    track.lfoDelayC = track.lfoDelay;
    if (track.lfoDelay) this.clearMod(track);
    this.trkVolPitSet(track);
    chan.gate = track.gate;
    chan.midiKey = track.key;
    chan.velocity = track.velocity;
    chan.priority = Math.min(255, (track.priority + this.song.p) | 0);
    chan.key = track.key;
    chan.type = tone.type;
    chan.wav = tone.wav;
    chan.attack = tone.attack;
    chan.decay = tone.decay;
    chan.sustain = tone.sustain;
    chan.release = tone.release;
    chan.echoVol = track.echoVol;
    chan.echoLen = track.echoLen;
    this.chnVolSet(chan, track);
    const key = Math.max(0, chan.key + track.keyM);
    chan.length = tone.length;
    chan.sweep = tone.panSweep & 0x80 || !(tone.panSweep & 0x70) ? 8 : tone.panSweep;
    chan.frequency = this.cgbFreq(num, key, track.pitM);
    chan.sf = SF_START;
    track.flags &= 0xf0;
    this.notes.push([this.frames, num, chan.frequency]);
  }

  // ply_note's DirectSound half: take a free channel, else one already stopping, else the first
  private dsNote(track: Track, tone: Tone): void {
    if (!track.wave || tone.type & 0x10) return;
    const chan = this.ds.find((c) => !(c.sf & SF_ON)) ?? this.ds.find((c) => c.sf & SF_STOP) ?? this.ds[0];
    chan.track?.chans.delete(chan);
    track.chans.add(chan);
    chan.track = track;
    track.lfoDelayC = track.lfoDelay;
    if (track.lfoDelay) this.clearMod(track);
    this.trkVolPitSet(track);
    chan.gate = track.gate;
    chan.midiKey = track.key;
    chan.velocity = track.velocity;
    chan.key = track.key;
    chan.type = tone.type;
    chan.wave = track.wave;
    chan.attack = tone.attack;
    chan.decay = tone.decay;
    chan.sustain = tone.sustain;
    chan.release = tone.release;
    chan.echoVol = track.echoVol;
    chan.echoLen = track.echoLen;
    chan.count = track.progress;
    this.chnVolSet(chan, track);
    chan.frequency = midiKeyToFreq(this.tables, chan.wave, Math.max(0, chan.key + track.keyM), track.pitM);
    chan.sf = SF_START;
    track.flags &= 0xf0;
    this.notes.push([this.frames, 0, chan.frequency]);
  }

  // the end of MPlayMain: pending volume and pitch changes reach every channel the track owns
  private applyTrack(track: Track): void {
    this.trkVolPitSet(track);
    for (const chan of track.chans) {
      if (!(chan.sf & SF_ON)) {
        track.chans.delete(chan);
        continue;
      }
      const cgb = (chan.type & TYPE_CGB) !== 0;
      if (track.flags & FLG_VOLCHG) {
        this.chnVolSet(chan, track);
        if (cgb) chan.modify |= MO_VOL;
      }
      if (track.flags & FLG_PITCHG) {
        const key = Math.max(0, chan.key + track.keyM);
        if (cgb) {
          chan.frequency = this.cgbFreq(chan.type & TYPE_CGB, key, track.pitM);
          chan.modify |= MO_PIT;
        } else chan.frequency = midiKeyToFreq(this.tables, chan.wave, key, track.pitM);
      }
    }
    track.flags &= 0xf0;
  }

  private modVol(chan: CgbChan): void {
    chan.envGoal = Math.min(15, (chan.leftVolume + chan.rightVolume) >> 4);
    chan.sustainGoal = (chan.envGoal * chan.sustain + 15) >> 4;
  }

  // CgbSound, label for label: the software envelope that mirrors the hardware's 64 Hz steps, then register writes
  private cgbSound(): void {
    this.c15 = this.c15 ? this.c15 - 1 : 14;
    for (let ch = 1; ch <= 4; ch++) {
      const c = this.cgb[ch - 1];
      if (!(c.sf & SF_ON)) continue;
      const hw = this.apu.ch[ch - 1];
      let prevC15 = this.c15;
      let envStep = hw.nr2;
      let at: string;
      if (c.sf & SF_START) {
        if (!(c.sf & SF_STOP)) {
          c.sf = ENV_ATTACK;
          c.modify = MO_PIT | MO_VOL;
          this.modVol(c);
          if (ch <= 2) {
            if (ch === 1) this.apu.write(1, 0, c.sweep);
            this.apu.write(ch, 1, (c.wav << 6) + c.length);
            envStep = c.attack + ENV_INC;
            c.n4 = c.length ? 0x40 : 0;
          } else if (ch === 3) {
            this.apu.write(3, 0, 0);
            this.apu.write(3, 1, c.length);
            c.n4 = c.length ? 0xc0 : 0x80;
          } else {
            this.apu.write(4, 1, c.length);
            this.apu.write(4, 3, c.wav << 3);
            envStep = c.attack + ENV_INC;
            c.n4 = c.length ? 0x40 : 0;
          }
          c.envCounter = c.attack;
          if (s8(c.attack)) {
            c.envVol = 0;
            at = 'step_complete';
          } else at = 'decay_start';
        } else at = 'osc_off';
      } else if (c.sf & SF_IEC) {
        c.echoLen = u8(c.echoLen - 1);
        at = s8(c.echoLen) <= 0 ? 'osc_off' : 'env_complete';
      } else if (c.sf & SF_STOP && c.sf & SF_ENV) {
        c.sf &= ~SF_ENV;
        c.envCounter = c.release;
        if (s8(c.release)) {
          c.modify |= MO_VOL;
          if (ch !== 3) envStep = c.release;
          at = 'step_complete';
        } else at = 'echo_start';
      } else at = 'step_repeat';

      for (;;) {
        if (at === 'step_repeat') {
          at = 'step_complete';
          if (c.envCounter === 0) {
            if (ch === 3) c.modify |= MO_VOL;
            this.modVol(c);
            const env = c.sf & SF_ENV;
            if (env === ENV_RELEASE) {
              c.envVol = u8(c.envVol - 1);
              if (s8(c.envVol) <= 0) at = 'echo_start';
              else c.envCounter = c.release;
            } else if (env === ENV_SUSTAIN) at = 'sustain';
            else if (env === ENV_DECAY) {
              c.envVol = u8(c.envVol - 1);
              if (s8(c.envVol) <= s8(c.sustainGoal)) at = 'sustain_start';
              else c.envCounter = c.decay;
            } else {
              c.envVol = u8(c.envVol + 1);
              if (c.envVol >= c.envGoal) at = 'decay_start';
              else c.envCounter = c.attack;
            }
          }
        } else if (at === 'echo_start') {
          c.envVol = (c.envGoal * c.echoVol + 0xff) >> 8;
          if (c.envVol) {
            c.sf |= SF_IEC;
            c.modify |= MO_VOL;
            if (ch !== 3) envStep = ENV_INC;
            at = 'env_complete';
          } else at = 'osc_off';
        } else if (at === 'sustain') {
          c.envVol = c.sustainGoal;
          c.envCounter = 7;
          at = 'step_complete';
        } else if (at === 'sustain_start') {
          if (c.sustain === 0) {
            c.sf &= ~SF_ENV;
            at = 'echo_start';
          } else {
            c.sf--;
            c.modify |= MO_VOL;
            if (ch !== 3) envStep = ENV_INC;
            at = 'sustain';
          }
        } else if (at === 'decay_start') {
          c.sf--;
          c.envCounter = c.decay;
          if (u8(c.envCounter)) {
            c.modify |= MO_VOL;
            c.envVol = c.envGoal;
            if (ch !== 3) envStep = c.decay;
            at = 'step_complete';
          } else at = 'sustain_start';
        } else if (at === 'step_complete') {
          c.envCounter = u8(c.envCounter - 1);
          if (prevC15 === 0) {
            prevC15--;
            at = 'step_repeat';
          } else at = 'env_complete';
        } else if (at === 'osc_off') {
          this.oscOff(ch);
          c.sf = 0;
          c.modify = 0;
          break;
        } else {
          this.writeRegisters(ch, c, envStep);
          c.modify = 0;
          break;
        }
      }
    }
  }

  private oscOff(ch: number): void {
    if (ch === 3) this.apu.write(3, 0, 0);
    else {
      this.apu.write(ch, 2, 8);
      this.apu.write(ch, 4, 0x80);
    }
  }

  private writeRegisters(ch: number, c: CgbChan, envStep: number): void {
    const hw = this.apu.ch[ch - 1];
    if (c.modify & MO_PIT) {
      // 65,536 Hz PWM (SOUNDBIAS_H 0x40, SoundInit): fixed-frequency voices round to even register values
      if (ch < 4 && c.type & TYPE_FIX) c.frequency = (c.frequency + 1) & 0x7fe;
      if (ch !== 4) this.apu.write(ch, 3, c.frequency);
      else this.apu.write(4, 3, (hw.nr3 & 0x08) | (c.frequency & 0xff));
      c.n4 = (c.n4 & 0xc0) + ((c.frequency >> 8) & 0xff);
      this.apu.write(ch, 4, c.n4);
    }
    if (c.modify & MO_VOL) {
      if (ch === 3) {
        this.apu.write(3, 2, this.tables.cgb3Vol[c.envVol]);
        if (c.n4 & 0x80) {
          this.apu.write(3, 0, 0x80);
          this.apu.write(3, 4, c.n4);
          c.n4 &= 0x7f;
        }
      } else {
        this.apu.write(ch, 2, (envStep & 0xf) + (c.envVol << 4));
        this.apu.write(ch, 4, c.n4 | 0x80);
      }
    }
  }

  get sounding(): boolean {
    return this.playing || this.cgb.some((c) => c.sf & SF_ON) || this.ds.some((c) => c.sf & SF_ON) || this.apu.active;
  }
}

// mono FIFO mixing at half volume: 2 * (A + B) of the 10-bit output; the CGB steps above are already 4x their
// share of that range, so DirectSound gets the same lift. Tune by ear
const DS_LEVEL = 1 / 128;

// renders a song at `rate` Hz, mono, until the sequence has ended and every channel is off
function renderSong(song: SongData, tables: Tables, rate: number, scale: number): { samples: Float32Array; frames: number; endFrame: number; fineFrame: number; notes: [number, number, number][] } {
  const player = new Player(song, tables);
  const ticksPerFrame = FRAME_TICKS;
  const out = new Float32Array(Math.ceil(((MAX_FRAMES + 2) * ticksPerFrame * rate) / (1 << 20)));
  const at = { index: 0, acc: 0, sum: 0, count: 0 };
  // the 8-bit DirectSound buffers sum to -256..254; DS_LEVEL maps that onto the output, in CGB volume steps
  const dsUnits = DS_LEVEL / scale;
  while (player.sounding && player.frames < MAX_FRAMES) {
    player.frame();
    player.apu.run(ticksPerFrame, out, at, rate, scale, player.dsOut, dsUnits);
  }
  // a cry's player keeps running (the 140-frame wait) after its sample ends: drop the silent tail
  let end = Math.min(at.index, out.length);
  while (end > 0 && Math.abs(out[end - 1]) < 1e-6) end--;
  return { samples: out.slice(0, end), frames: player.frames, endFrame: player.endFrame, fineFrame: player.fineFrame, notes: player.notes };
}

seqLib.seq = { Player, renderSong };
