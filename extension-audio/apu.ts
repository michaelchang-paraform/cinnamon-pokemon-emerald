// Game Boy sound for the pokemon-audio engine. Part one is a model of the four GB channels as the GBA runs them,
// clocked at 2^20 Hz. Part two is the per-frame driver that turns each PSG voice into envelope stages and register
// values. Publishes window.__peaLib.apu; seq.ts is its only user.
(() => {
  const TICK_HZ = 1 << 20;
  const FRAME_TICKS = 17556;
  const SEQUENCER_TICKS = 2048;
  const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
  const NOISE_DIVISOR = [2, 4, 8, 12, 16, 20, 24, 28];

  // voice status bits, shared with ds.ts (window.__peaLib.ds.VOICE_BITS)
  const NEW = 0x80;
  const KEY_OFF = 0x40;
  const ECHO = 0x04;
  const PHASE = 0x03;
  const ACTIVE = NEW | KEY_OFF | ECHO | PHASE;
  const SUSTAIN = 1;
  const DECAY = 2;
  const ATTACK = 3;

  const s8 = (x: number) => ((x & 0xff) ^ 0x80) - 0x80;

  // where the next output sample goes and the box average in progress, kept across frames
  type Cursor = { index: number; acc: number; sum: number; count: number };

  class GbChannel {
    on = false;
    dac = false;
    // last written: sweep or wave enable, duty and length, envelope or wave volume, frequency low, control
    reg = [0, 0, 0, 0, 0];
    freq = 0;
    timer = 0;
    pos = 0;
    level = 0;
    up = false;
    envPeriod = 0;
    envTimer = 0;
    length = 0;
    lengthOn = false;
    shadow = 0;
    sweepTimer = 0;
    sweepOn = false;
    lfsr = 0x7fff;
    constructor(readonly n: number) {}

    period(): number {
      if (this.n === 3) return (2048 - this.freq) / 2;
      if (this.n === 4) return NOISE_DIVISOR[this.reg[3] & 7] << (this.reg[3] >> 4);
      return 2048 - this.freq;
    }
  }

  class Apu {
    readonly ch = [new GbChannel(1), new GbChannel(2), new GbChannel(3), new GbChannel(4)];
    readonly wave: number[] = new Array(32).fill(0);
    private seqCounter = SEQUENCER_TICKS;
    private seqStep = 0;

    write(n: number, index: number, value: number): void {
      const c = this.ch[n - 1];
      const v = value & 0xff;
      c.reg[index] = v;
      switch (index) {
        case 0:
          if (n === 3) {
            c.dac = (v & 0x80) !== 0;
            if (!c.dac) c.on = false;
          }
          break;
        case 1:
          c.length = n === 3 ? 256 - v : 64 - (v & 63);
          break;
        case 2:
          c.dac = n === 3 ? (c.reg[0] & 0x80) !== 0 : (v & 0xf8) !== 0;
          if (!c.dac) c.on = false;
          break;
        case 3:
          c.freq = (c.freq & 0x700) | v;
          break;
        case 4:
          c.freq = (c.freq & 0xff) | ((v & 7) << 8);
          c.lengthOn = (v & 0x40) !== 0;
          if (v & 0x80) this.trigger(c);
          break;
      }
    }

    off(n: number): void {
      this.ch[n - 1].on = false;
    }

    setWave(bytes: ArrayLike<number> | null): void {
      for (let i = 0; i < 16; i++) {
        const b = bytes ? bytes[i] & 0xff : 0;
        this.wave[2 * i] = b >> 4;
        this.wave[2 * i + 1] = b & 15;
      }
    }

    get active(): boolean {
      return this.ch.some((c) => c.on && (c.level > 0 || (c.up && c.envPeriod !== 0)));
    }

    private trigger(c: GbChannel): void {
      c.on = c.dac;
      if (c.length === 0) c.length = c.n === 3 ? 256 : 64;
      c.timer = c.period();
      if (c.n === 3) c.pos = 0;
      c.level = c.reg[2] >> 4;
      c.up = (c.reg[2] & 8) !== 0;
      c.envPeriod = c.reg[2] & 7;
      c.envTimer = c.envPeriod;
      if (c.n === 4) c.lfsr = 0x7fff;
      if (c.n === 1) {
        const sp = (c.reg[0] >> 4) & 7;
        const shift = c.reg[0] & 7;
        c.shadow = c.freq;
        c.sweepTimer = sp || 8;
        c.sweepOn = sp !== 0 || shift !== 0;
        if (shift) this.sweepNext(c);
      }
    }

    private sweepNext(c: GbChannel): number {
      const delta = c.shadow >> (c.reg[0] & 7);
      const next = c.reg[0] & 8 ? c.shadow - delta : c.shadow + delta;
      if (next > 2047) c.on = false;
      return next;
    }

    private clockSequencer(): void {
      const s = this.seqStep;
      if ((s & 1) === 0) {
        for (const c of this.ch) {
          if (c.lengthOn && c.length > 0 && --c.length === 0) c.on = false;
        }
      }
      if (s === 2 || s === 6) {
        const c = this.ch[0];
        if (--c.sweepTimer <= 0) {
          const sp = (c.reg[0] >> 4) & 7;
          c.sweepTimer = sp || 8;
          if (c.sweepOn && sp !== 0) {
            const next = this.sweepNext(c);
            if (next <= 2047 && (c.reg[0] & 7) !== 0) {
              c.freq = c.shadow = next;
              c.reg[3] = next & 0xff;
              this.sweepNext(c);
            }
          }
        }
      }
      if (s === 7) {
        for (const c of this.ch) {
          if (c.n === 3 || c.envPeriod === 0 || --c.envTimer > 0) continue;
          c.envTimer = c.envPeriod;
          if (c.up) {
            if (c.level < 15) c.level++;
          } else if (c.level > 0) c.level--;
        }
      }
      this.seqStep = (s + 1) & 7;
    }

    private stepSquare(c: GbChannel, stride: number): number {
      c.timer -= stride;
      while (c.timer <= 0) {
        c.timer += 2048 - c.freq;
        c.pos = (c.pos + 1) & 7;
      }
      return (DUTY[c.reg[1] >> 6] >> (7 - c.pos)) & 1 ? c.level : -c.level;
    }

    private stepWave(c: GbChannel, stride: number): number {
      c.timer -= stride;
      while (c.timer <= 0) {
        c.timer += (2048 - c.freq) / 2;
        c.pos = (c.pos + 1) & 31;
      }
      const vol = c.reg[2];
      const shift = [4, 0, 1, 2][(vol >> 5) & 3];
      const w = (v: number) => (vol & 0x80 ? (v * 3) >> 2 : v >> shift);
      return 2 * w(this.wave[c.pos]) - w(15);
    }

    private stepNoise(c: GbChannel, stride: number): number {
      c.timer -= stride;
      while (c.timer <= 0) {
        c.timer += c.period();
        const n = c.lfsr;
        const b = (n ^ (n >> 1)) & 1;
        let next = (n >> 1) | (b << 14);
        if (c.reg[3] & 8) next = (next & ~0x40) | (b << 6);
        c.lfsr = next;
      }
      return c.lfsr & 1 ? -c.level : c.level;
    }

    // runs the model for `ticks` ticks in steps of `stride`, adding the frame's DirectSound values `ds` (spread
    // evenly over the frame) and box-averaging into out at the browser rate
    run(ticks: number, out: Float32Array, at: Cursor, rate: number, scale: number, ds?: ArrayLike<number> | null, dsUnit = 0, stride = 1): void {
      const [c1, c2, c3, c4] = this.ch;
      const dsLen = ds ? ds.length : 0;
      const advance = rate * stride;
      let { index, acc, sum, count } = at;
      for (let t = 0; t < ticks; t += stride) {
        if (dsLen) sum = sum + ds![Math.floor((t * dsLen) / ticks)] * dsUnit;
        this.seqCounter -= stride;
        if (this.seqCounter <= 0) {
          this.seqCounter += SEQUENCER_TICKS;
          this.clockSequencer();
        }
        if (c1.on || c2.on || c3.on || c4.on) {
          const o1 = c1.on ? this.stepSquare(c1, stride) : 0;
          const o2 = c2.on ? this.stepSquare(c2, stride) : 0;
          const o3 = c3.on ? this.stepWave(c3, stride) : 0;
          const o4 = c4.on ? this.stepNoise(c4, stride) : 0;
          sum = sum + (o1 + o2 + o3 + o4);
        }
        count++;
        acc += advance;
        if (acc >= TICK_HZ) {
          acc -= TICK_HZ;
          out[index++] = (sum / count) * scale;
          sum = 0;
          count = 0;
        }
      }
      at.index = index;
      at.acc = acc;
      at.sum = sum;
      at.count = count;
    }
  }

  // envelope stages of a driven channel; each timed stage maps to the phase bits the sequencer reads
  const Stage = { Idle: 0, Rise: 1, Fall: 2, Hold: 3, Fade: 4, Tail: 5 };
  const PHASE_OF: Record<number, number> = { [Stage.Rise]: ATTACK, [Stage.Fall]: DECAY, [Stage.Hold]: SUSTAIN };
  const timed = (stage: number) => stage >= Stage.Rise && stage <= Stage.Fade;

  // what one Game Boy channel is playing: note fields come from the sequencer, envelope fields from the driver
  class PsgSlot {
    readonly psg = true;
    state = 0;
    owner = -1;
    priority = 0;
    gate = 0;
    noteKey = 0;
    key = 0;
    velocity = 0;
    panOffset = 0;
    type = 0;
    attack = 0;
    decay = 0;
    sustain = 0;
    release = 0;
    echoVolume = 0;
    echoLength = 0;
    rightLevel = 0;
    leftLevel = 0;
    // 11-bit register value for tones, noise register value for channel 4
    rate = 0;
    length = 0;
    sweep = 8;
    // duty (squares) or period flag (noise)
    reference = 0;
    image: ArrayLike<number> | null = null;
    stage: number = Stage.Idle;
    level = 0;
    ceiling = 0;
    floor = 0;
    countdown = 0;
    nibble = 0;
    control = 0;
    pitchMark = false;
    levelMark = false;
    constructor(readonly channel: number) {}
  }

  // the register value for a key and pitch fraction (11.6): noise table for channel 4, period offsets otherwise
  function psgPitch(tables: any, channel: number, key: number, fine: number): number {
    const p = tables.engine.psg;
    if (channel === 4) return tables.noise[key <= p.noiseBelow ? 0 : Math.min(p.noiseTop, key - p.noiseBase)];
    let k = key;
    let f = fine;
    if (k <= p.toneBelow) {
      k = 0;
      f = 0;
    } else {
      k -= p.toneBase;
      if (k > p.toneTop) {
        k = p.toneTop;
        f = 255;
      }
    }
    const offset = (i: number) => {
      const s = tables.cgbScale[i];
      return tables.cgbFreq[s & 15] >> (s >> 4);
    };
    const low = offset(k);
    const high = offset(k + 1);
    return low + ((f * (high - low)) >> 8) + p.registerOffset;
  }

  // steps the four slots once per frame and writes the result into the model; every write of a frame lands
  // before the model runs that frame, so only the final register values and the triggers matter
  class PsgDriver {
    readonly slots = [new PsgSlot(1), new PsgSlot(2), new PsgSlot(3), new PsgSlot(4)];
    private fifteen = 0;
    private loaded: unknown = undefined;
    private readonly limits: any;

    constructor(
      private readonly apu: Apu,
      private readonly tables: any,
    ) {
      this.limits = tables.engine.psg;
    }

    get sounding(): boolean {
      return this.slots.some((s) => (s.state & ACTIVE) !== 0);
    }

    frame(): void {
      this.fifteen = this.fifteen === 0 ? this.limits.doubleStepEvery : this.fifteen - 1;
      const twice = this.fifteen === 0;
      for (const slot of this.slots) this.drive(slot, twice);
    }

    private drive(s: PsgSlot, twice: boolean): void {
      if (!(s.state & ACTIVE)) {
        s.pitchMark = s.levelMark = false;
        return;
      }
      let fresh = false;
      if (s.state & NEW) {
        if (s.state & KEY_OFF) return this.shut(s);
        fresh = true;
        this.measure(s);
        s.pitchMark = s.levelMark = true;
        s.control = (s.length ? 0x40 : 0) | (s.channel === 3 ? 0x80 : 0);
        s.state = 0;
        this.enter(s, Stage.Rise);
      } else if (s.stage === Stage.Tail) {
        s.echoLength = (s.echoLength - 1) & 0xff;
        if (s8(s.echoLength) <= 0) s.stage = Stage.Idle;
      } else if (s.state & KEY_OFF && s.stage !== Stage.Fade) {
        this.enter(s, Stage.Fade);
      } else if (timed(s.stage)) {
        this.pass(s);
      }
      if (twice && timed(s.stage)) this.pass(s);
      if (fresh) this.noteRegisters(s);
      if (s.stage === Stage.Idle) return this.shut(s);
      if (s.pitchMark) this.pitchRegisters(s);
      if (s.levelMark) this.levelRegisters(s);
      s.pitchMark = s.levelMark = false;
    }

    // target and sustain levels from the voice levels, always the mono rule
    private measure(s: PsgSlot): void {
      s.ceiling = ((s.leftLevel + s.rightLevel) >> 4) & 0xff;
      s.floor = (s.ceiling * s.sustain + 15) >> 4;
    }

    // enters a stage, falling through every stage whose rate is 0
    private enter(s: PsgSlot, first: number): void {
      let stage = first;
      for (;;) {
        if (stage === Stage.Rise) {
          if (s8(s.attack) <= 0) {
            stage = Stage.Fall;
            continue;
          }
          s.level = 0;
          s.nibble = (s.attack + 8) & 15;
          s.countdown = s.attack;
        } else if (stage === Stage.Fall) {
          if ((s.decay & 0xff) === 0) {
            stage = Stage.Hold;
            continue;
          }
          s.level = s.ceiling;
          s.nibble = s.decay & 15;
          s.countdown = s.decay;
          s.levelMark = true;
        } else if (stage === Stage.Hold) {
          if (s.sustain === 0) {
            stage = Stage.Tail;
            continue;
          }
          s.level = s.floor;
          s.nibble = 8;
          s.countdown = this.limits.sustainHold;
          s.levelMark = true;
        } else if (stage === Stage.Fade) {
          if (s8(s.release) <= 0) {
            stage = Stage.Tail;
            continue;
          }
          s.nibble = s.release & 15;
          s.countdown = s.release;
          s.levelMark = true;
        } else {
          s.level = (s.ceiling * s.echoVolume + 255) >> 8;
          s.nibble = 8;
          s.levelMark = true;
          s.state = (s.state & KEY_OFF) | ECHO;
          s.stage = s.level === 0 ? Stage.Idle : Stage.Tail;
          return;
        }
        s.stage = stage;
        if (stage !== Stage.Fade) s.state = (s.state & KEY_OFF) | PHASE_OF[stage];
        return;
      }
    }

    // one pass of a timed stage: count down, and on 0 take a level step
    private pass(s: PsgSlot): void {
      if (--s.countdown > 0) return;
      this.measure(s);
      if (s.channel === 3) s.levelMark = true;
      switch (s.stage) {
        case Stage.Rise:
          s.level = (s.level + 1) & 0xff;
          if (s.level >= s.ceiling) this.enter(s, Stage.Fall);
          else s.countdown = s.attack;
          break;
        case Stage.Fall:
          s.level = (s.level - 1) & 0xff;
          if (s8(s.level) <= s8(s.floor)) this.enter(s, Stage.Hold);
          else s.countdown = s.decay;
          break;
        case Stage.Hold:
          s.level = s.floor;
          s.countdown = this.limits.sustainHold;
          break;
        default:
          s.level = (s.level - 1) & 0xff;
          if (s8(s.level) <= 0) this.enter(s, Stage.Tail);
          else s.countdown = s.release;
      }
    }

    private noteRegisters(s: PsgSlot): void {
      const n = s.channel;
      const apu = this.apu;
      if (n === 1) apu.write(1, 0, s.sweep);
      if (n <= 2) {
        apu.write(n, 1, s.reference * 64 + s.length);
      } else if (n === 3) {
        apu.write(3, 1, s.length);
        if (s.image !== this.loaded) {
          apu.setWave(s.image);
          this.loaded = s.image;
        }
        apu.write(3, 0, 0);
      } else {
        apu.write(4, 1, s.length);
        apu.write(4, 3, s.rate | (s.reference * 8));
      }
    }

    private pitchRegisters(s: PsgSlot): void {
      const n = s.channel;
      if (n === 4) {
        this.apu.write(4, 3, s.rate | (this.apu.ch[3].reg[3] & 8));
        this.apu.write(4, 4, s.control);
        return;
      }
      if (s.type & 0x08) s.rate = (s.rate + this.limits.fixAdd) & this.limits.fixMask;
      this.apu.write(n, 3, s.rate & 0xff);
      s.control = (s.control & ~7) | ((s.rate >> 8) & 7);
      this.apu.write(n, 4, s.control);
    }

    private levelRegisters(s: PsgSlot): void {
      const n = s.channel;
      if (n === 3) {
        const volume = this.tables.cgb3Vol[s.level] ?? 0;
        if (s.control & 0x80) {
          this.apu.write(3, 0, 0x80);
          this.apu.write(3, 2, volume);
          this.apu.write(3, 4, s.control);
          s.control &= 0x7f;
        } else {
          this.apu.write(3, 2, volume);
        }
        return;
      }
      this.apu.write(n, 2, s.nibble + 16 * s.level);
      this.apu.write(n, 4, s.control | 0x80);
    }

    // the off values: a square or noise channel keeps running at level 0, the wave channel loses its DAC
    private shut(s: PsgSlot): void {
      if (s.channel === 3) this.apu.write(3, 0, 0);
      else {
        this.apu.write(s.channel, 2, 8);
        this.apu.write(s.channel, 4, 0x80);
      }
      s.state = 0;
      s.stage = Stage.Idle;
      s.pitchMark = s.levelMark = false;
    }
  }

  const lib = ((window as any).__peaLib ??= {});
  lib.apu = { Apu, TICK_HZ, FRAME_TICKS, PsgDriver, PsgSlot, psgPitch };
})();
