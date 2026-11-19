// The m4a DirectSound side: WaveData samples (8-bit PCM or 64-sample DPCM blocks), MidiKeyToFreq, the per-frame
// envelope and the 13,379 Hz mixer with linear interpolation, as SoundMainRAM in src/m4a_1.s runs them. Also builds
// the two-part cry song that SetPokemonCryTone (src/m4a.c) starts from gPokemonCrySongTemplate.
const dsLib = ((window as any).__peaLib ??= {});

// SOUND_MODE_FREQ_13379: 224 samples a frame, timer 0 period 1254 cycles, divFreq (16777216 / 13379 + 1) >> 1
const DS_SAMPLES = 224;
const DIV_FREQ = 627;
// m4aSoundMode master volume 12
const MASTER_VOL = 12;
const WAVE_LOOP = 0x4000;

class Wave {
  readonly compressed: boolean;
  readonly loop: boolean;
  readonly freq: number;
  readonly loopStart: number;
  readonly size: number;
  private readonly data: Uint8Array;
  private block = -1;
  private readonly buf = new Int8Array(64);

  // `bin` is wav2agb's binary output: u16 type, u16 status, u32 freq, u32 loopStart, u32 size, then the samples
  constructor(bin: Uint8Array, readonly delta: number[]) {
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    this.compressed = view.getUint16(0, true) !== 0;
    this.loop = (view.getUint16(2, true) & WAVE_LOOP) !== 0;
    this.freq = view.getUint32(4, true);
    this.loopStart = view.getUint32(8, true);
    this.size = view.getUint32(12, true);
    this.data = bin.subarray(16);
  }

  // SoundMainRAM_Unk2: decode the 64-sample block holding `pos` into the one-block buffer
  at(pos: number): number {
    if (pos < 0 || pos >= this.size) return 0;
    if (!this.compressed) return (this.data[pos] << 24) >> 24;
    const block = pos >> 6;
    if (block !== this.block) {
      this.block = block;
      const d = this.data;
      let at = block * 33;
      let v = d[at++] ?? 0;
      this.buf[0] = v;
      let byte = d[at++] ?? 0;
      v += this.delta[byte & 15];
      this.buf[1] = v;
      for (let i = 2; i < 64; i += 2) {
        byte = d[at++] ?? 0;
        v += this.delta[byte >> 4];
        this.buf[i] = v;
        v += this.delta[byte & 15];
        this.buf[i + 1] = v;
      }
    }
    return this.buf[pos & 63];
  }
}

const mulHigh = (a: number, b: number) => Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n);

// m4a.c MidiKeyToFreq
function midiKeyToFreq(tables: { scale: number[]; freq: number[] }, wave: Wave, key: number, fine: number): number {
  let fineShifted = (fine << 24) >>> 0;
  if (key > 178) {
    key = 178;
    fineShifted = (255 << 24) >>> 0;
  }
  const at = (k: number) => Math.floor(tables.freq[tables.scale[k] & 0xf] / 2 ** (tables.scale[k] >> 4));
  const a = at(key);
  const b = at(key + 1);
  return mulHigh(wave.freq, (a + mulHigh((b - a) >>> 0, fineShifted)) >>> 0);
}

type DsChan = {
  sf: number;
  type: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  envVol: number;
  echoVol: number;
  echoLen: number;
  rightVolume: number;
  leftVolume: number;
  frequency: number;
  wave: Wave | null;
  count: number;
  pos: number;
  fw: number;
  loop: boolean;
};

// one frame of SoundMainRAM for every DirectSound channel: envelope, then 224 mixed samples into the two 8-bit
// buffers (byte lanes wrap, as the ARM loop's adds do); returns the mono sum per sample, -256..254
function dsFrame(chans: DsChan[], out: Float32Array): void {
  const right = new Int8Array(DS_SAMPLES);
  const left = new Int8Array(DS_SAMPLES);
  for (const c of chans) {
    if (!(c.sf & 0xc7) || !c.wave) continue;
    let r5: number;
    if (c.sf & 0x80) {
      if (c.sf & 0x40) {
        c.sf = 0;
        continue;
      }
      c.sf = 3;
      c.pos = c.count;
      c.count = c.wave.size - c.count;
      c.envVol = 0;
      c.fw = 0;
      c.loop = c.wave.loop;
      r5 = c.attack;
      if (r5 >= 0xff) {
        r5 = 0xff;
        c.sf--;
      }
    } else {
      r5 = c.envVol;
      let off = false;
      if (c.sf & 0x04) {
        c.echoLen = (c.echoLen - 1) & 0xff;
        if (c.echoLen === 0 || c.echoLen === 0xff) off = true;
      } else if (c.sf & 0x40) {
        r5 = (r5 * c.release) >> 8;
        if (r5 <= c.echoVol) {
          r5 = c.echoVol;
          if (r5 === 0) off = true;
          else c.sf |= 0x04;
        }
      } else if ((c.sf & 3) === 2) {
        r5 = (r5 * c.decay) >> 8;
        if (r5 <= c.sustain) {
          r5 = c.sustain;
          if (r5 === 0) {
            r5 = c.echoVol;
            if (r5 === 0) off = true;
            else c.sf |= 0x04;
          } else c.sf--;
        }
      } else if ((c.sf & 3) === 3) {
        r5 += c.attack;
        if (r5 >= 0xff) {
          r5 = 0xff;
          c.sf--;
        }
      }
      if (off) {
        c.sf = 0;
        continue;
      }
    }
    c.envVol = r5;
    const v = (r5 * (MASTER_VOL + 1)) >> 4;
    const volR = (c.rightVolume * v) >> 8;
    const volL = (c.leftVolume * v) >> 8;
    const wave = c.wave;
    const step = c.type & 0x08 ? 0x800000 : DIV_FREQ * c.frequency;
    let s0 = wave.at(c.pos);
    let s1 = wave.at(c.pos + 1);
    for (let i = 0; i < DS_SAMPLES; i++) {
      const s = s0 + Math.floor((c.fw * (s1 - s0)) / 0x800000);
      right[i] += (volR * s) >> 8;
      left[i] += (volL * s) >> 8;
      c.fw += step;
      const adv = Math.floor(c.fw / 0x800000);
      if (!adv) continue;
      c.fw -= adv * 0x800000;
      c.count -= adv;
      if (c.count <= 0) {
        if (!c.loop) {
          c.sf = 0;
          break;
        }
        while (c.count <= 0) c.count += wave.size - wave.loopStart;
        c.pos = wave.loopStart + (wave.size - wave.loopStart - c.count);
      } else c.pos += adv;
      s0 = wave.at(c.pos);
      s1 = wave.at(c.pos + 1);
    }
  }
  for (let i = 0; i < DS_SAMPLES; i++) out[i] = right[i] + left[i];
}

// gPokemonCrySongTemplate from offset 0x11 (part0) after SetPokemonCryVolume/Panpot/Pitch/Length/Progress/Release
type CryParams = { volume: number; pan: number; pitch: number; length: number; progress: number; release: number; priority: number; tone: number[] };
function crySong(p: CryParams, wave: Wave): { p: number; r: number; t: number[]; bytes: Uint8Array; v: Record<string, number[]>; w: Record<string, Wave> } {
  const b = (p.pitch + 0x80) & 0xffff;
  const key = (b >> 8) & 0x7f;
  const tune = (b >> 1) & 0x7f;
  const tune2 = (16 + tune) & 0x7f;
  const cont = 9;
  const len = p.length & 0xffff;
  const progress = p.progress >>> 0;
  const bytes = Uint8Array.from([
    0xc8, tune, 0xb2, cont, 0, 0, 0,
    0xc8, tune2,
    0xbd, 0, 0xbe, p.volume & 0x7f, 0xcd, 0x0d, progress & 0xff, (progress >> 8) & 0xff, (progress >> 16) & 0xff, progress >>> 24,
    0xcd, 0x07, p.release & 0xff, 0xbf, (p.pan + 0x40) & 0x7f, 0xcf, key, 127, 0xcd, 0x0c, len & 0xff, len >> 8, 0xce, 0xb1,
  ]);
  return { p: p.priority, r: 0, t: [0], bytes, v: { 0: p.tone }, w: { 0: wave } };
}

dsLib.ds = { Wave, midiKeyToFreq, dsFrame, crySong, DS_SAMPLES };
