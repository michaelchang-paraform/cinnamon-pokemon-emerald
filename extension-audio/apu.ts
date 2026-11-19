// The GBA's four Game Boy sound channels (square 1 with sweep, square 2, wave, noise) as register-level state,
// clocked at 2^20 Hz: one tick is 4 CPU cycles of the 4,194,304 Hz Game Boy clock. The m4a driver in seq.ts writes
// these registers once per frame, exactly as CgbSound writes NRxx; between frames the hardware runs on its own.
// The wave channel stays silent: build-audio.mjs refuses wave voices until a slice needs them.
const TICK_HZ = 1 << 20;
// 280,896 CPU cycles at 16.78 MHz per frame, so 59.7275 frames a second
const FRAME_TICKS = 17556;
// frame sequencer: 512 Hz
const SEQ_TICKS = 2048;
const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const NOISE_DIV = [2, 4, 8, 12, 16, 20, 24, 28];

class Chan {
  on = false;
  dac = false;
  nr0 = 0;
  nr1 = 0;
  nr2 = 0;
  nr3 = 0;
  nr4 = 0;
  freq = 0;
  timer = 0;
  pos = 0;
  vol = 0;
  envDir = 0;
  envPeriod = 0;
  envTimer = 0;
  length = 0;
  lengthOn = false;
  shadow = 0;
  sweepTimer = 0;
  sweepOn = false;
  lfsr = 0x7fff;

  constructor(readonly n: number) {}

  write(reg: number, value: number): void {
    value &= 0xff;
    if (reg === 0) this.nr0 = value;
    else if (reg === 1) {
      this.nr1 = value;
      this.length = (this.n === 3 ? 256 : 64) - (this.n === 3 ? value : value & 63);
    } else if (reg === 2) {
      this.nr2 = value;
      this.dac = this.n === 3 ? (this.nr0 & 0x80) !== 0 : (value & 0xf8) !== 0;
      if (!this.dac) this.on = false;
    } else if (reg === 3) {
      this.nr3 = value;
      this.freq = (this.freq & 0x700) | value;
    } else {
      this.nr4 = value;
      this.freq = (this.freq & 0xff) | ((value & 7) << 8);
      this.lengthOn = (value & 0x40) !== 0;
      if (value & 0x80) this.trigger();
    }
    if (this.n === 3 && reg === 0) {
      this.dac = (value & 0x80) !== 0;
      if (!this.dac) this.on = false;
    }
  }

  private period(): number {
    if (this.n === 4) return NOISE_DIV[this.nr3 & 7] << (this.nr3 >> 4);
    return this.n === 3 ? (2048 - this.freq) / 2 : 2048 - this.freq;
  }

  private trigger(): void {
    this.on = this.dac;
    if (this.length === 0) this.length = this.n === 3 ? 256 : 64;
    this.timer = this.period();
    if (this.n === 3) this.pos = 0;
    this.vol = this.nr2 >> 4;
    this.envDir = this.nr2 & 8;
    this.envPeriod = this.nr2 & 7;
    this.envTimer = this.envPeriod;
    if (this.n === 4) this.lfsr = 0x7fff;
    if (this.n === 1) {
      const sp = (this.nr0 >> 4) & 7;
      this.shadow = this.freq;
      this.sweepTimer = sp || 8;
      this.sweepOn = sp !== 0 || (this.nr0 & 7) !== 0;
      if (this.nr0 & 7) this.sweepCalc();
    }
  }

  private sweepCalc(): number {
    const delta = this.shadow >> (this.nr0 & 7);
    const next = this.nr0 & 8 ? this.shadow - delta : this.shadow + delta;
    if (next > 2047) this.on = false;
    return next;
  }

  clockLength(): void {
    if (this.lengthOn && this.length > 0 && --this.length === 0) this.on = false;
  }

  clockSweep(): void {
    if (--this.sweepTimer > 0) return;
    const sp = (this.nr0 >> 4) & 7;
    this.sweepTimer = sp || 8;
    if (!this.sweepOn || sp === 0) return;
    const next = this.sweepCalc();
    if (next <= 2047 && (this.nr0 & 7) !== 0) {
      this.freq = this.shadow = next;
      this.nr3 = next & 0xff;
      this.sweepCalc();
    }
  }

  clockEnvelope(): void {
    if (this.n === 3 || this.envPeriod === 0) return;
    if (--this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir && this.vol < 15) this.vol++;
    else if (!this.envDir && this.vol > 0) this.vol--;
  }

  // one 2^20 Hz tick; returns the channel's level centred on zero, in units of one volume step
  step(): number {
    if (!this.on || this.n === 3) return 0;
    if (--this.timer <= 0) {
      this.timer += this.period();
      if (this.n === 4) {
        const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
        this.lfsr = (this.lfsr >> 1) | (bit << 14);
        if (this.nr3 & 8) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
      } else this.pos = (this.pos + 1) & (this.n === 3 ? 31 : 7);
    }
    if (this.n === 4) return this.lfsr & 1 ? -this.vol : this.vol;
    return (DUTY[this.nr1 >> 6] >> (7 - this.pos)) & 1 ? this.vol : -this.vol;
  }
}

class Apu {
  readonly ch = [new Chan(1), new Chan(2), new Chan(3), new Chan(4)];
  private seqTimer = SEQ_TICKS;
  private seqStep = 0;

  write(chan: number, reg: number, value: number): void {
    this.ch[chan - 1].write(reg, value);
  }

  off(chan: number): void {
    this.ch[chan - 1].on = false;
  }

  // runs `ticks` hardware ticks and box-averages them into `out` at `rate`; `acc` carries the resampling phase
  // `ds` holds the frame's DirectSound samples, each held for 1/224 of the frame as the FIFO plays them
  run(ticks: number, out: Float32Array, at: { index: number; acc: number; sum: number; count: number }, rate: number, scale: number, ds?: Float32Array, dsUnits = 0): void {
    const [c1, c2, c3, c4] = this.ch;
    const per = ds ? ds.length : 0;
    for (let t = 0; t < ticks; t++) {
      if (per) at.sum += ds![Math.floor((t * per) / ticks)] * dsUnits;
      if (--this.seqTimer === 0) {
        this.seqTimer = SEQ_TICKS;
        const s = this.seqStep;
        if ((s & 1) === 0) for (const c of this.ch) c.clockLength();
        if (s === 2 || s === 6) c1.clockSweep();
        if (s === 7) for (const c of this.ch) c.clockEnvelope();
        this.seqStep = (s + 1) & 7;
      }
      at.sum += c1.step() + c2.step() + c3.step() + c4.step();
      at.count++;
      at.acc += rate;
      if (at.acc >= TICK_HZ) {
        at.acc -= TICK_HZ;
        if (at.index < out.length) out[at.index] = (at.sum / at.count) * scale;
        at.index++;
        at.sum = at.count = 0;
      }
    }
  }

  // a channel the driver switched off is retriggered at volume 0 (CgbOscOff), so "on" alone never ends a render
  get active(): boolean {
    return this.ch.some((c) => c.on && (c.vol > 0 || (c.envDir !== 0 && c.envPeriod !== 0)));
  }
}

const apuLib = ((window as any).__peaLib ??= {});
apuLib.apu = { Apu, TICK_HZ, FRAME_TICKS };
