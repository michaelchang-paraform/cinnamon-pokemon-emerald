// The DirectSound half of the pokemon-audio engine: sample binaries, the sampled-voice frequency, the m4a software
// mixer (envelopes, interpolation, the reverb ring) and the cry song template. Publishes window.__peaLib.ds.
(() => {
  const VOICE_BITS = { NEW: 0x80, KEY_OFF: 0x40, ECHO: 0x04, PHASE: 0x03, ACTIVE: 0xc7 };
  const { NEW, KEY_OFF, ECHO, PHASE, ACTIVE } = VOICE_BITS;
  const SUSTAIN = 1;
  const DECAY = 2;
  const ATTACK = 3;
  const ONE = 1 << 23;

  const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
  const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

  // high word of the 64-bit product of two u32 values
  function hi32(a: number, b: number): number {
    const x = a >>> 0;
    const y = b >>> 0;
    const xl = x & 0xffff;
    const xh = x >>> 16;
    const yl = y & 0xffff;
    const yh = y >>> 16;
    const mid = xh * yl;
    const mid2 = xl * yh;
    const carry = Math.floor(((xl * yl) / 65536 + (mid % 65536) + (mid2 % 65536)) / 65536);
    return (xh * yh + Math.floor(mid / 65536) + Math.floor(mid2 / 65536) + carry) >>> 0;
  }

  // a sample binary: 16-byte header, then s8 PCM or 33-byte compressed blocks of 64 samples
  class Wave {
    readonly compressed: boolean;
    readonly loop: boolean;
    readonly freq: number;
    readonly loopStart: number;
    readonly size: number;
    readonly steps: number[];
    private readonly bin: Uint8Array;
    private pcm: Int8Array | null = null;

    constructor(bin: Uint8Array, steps: number[]) {
      this.bin = bin;
      this.steps = steps;
      this.compressed = u16(bin, 0) !== 0;
      this.loop = (u16(bin, 2) & 0x4000) !== 0;
      this.freq = u32(bin, 4);
      this.loopStart = u32(bin, 8);
      this.size = u32(bin, 12);
    }

    // every readable sample, decoded; reads outside it are 0
    get data(): Int8Array {
      if (this.pcm) return this.pcm;
      const bin = this.bin;
      if (!this.compressed) return (this.pcm = new Int8Array(bin.buffer, bin.byteOffset + 16, Math.max(0, bin.length - 16)));
      const out = new Int8Array(this.size);
      const byte = (i: number) => (16 + i < bin.length ? bin[16 + i] : 0);
      for (let block = 0; block * 64 < this.size; block++) {
        const base = block * 33;
        const at = block * 64;
        const put = (i: number, v: number) => {
          if (at + i < out.length) out[at + i] = v;
        };
        let value = ((byte(base) & 0xff) ^ 0x80) - 0x80;
        put(0, value);
        value = (((value + this.steps[byte(base + 1) & 15]) & 0xff) ^ 0x80) - 0x80;
        put(1, value);
        for (let i = 2; i < 33; i++) {
          const b = byte(base + i);
          value = (((value + this.steps[b >> 4]) & 0xff) ^ 0x80) - 0x80;
          put(2 * i - 2, value);
          value = (((value + this.steps[b & 15]) & 0xff) ^ 0x80) - 0x80;
          put(2 * i - 1, value);
        }
      }
      return (this.pcm = out);
    }

    at(index: number): number {
      const d = this.data;
      return index >= 0 && index < d.length ? d[index] : 0;
    }
  }

  // the sampled-voice frequency for a key and pitch fraction (10.1); key 60 plays at the sample's own rate
  function sampleRateFor(tables: any, wave: Wave, key: number, fine: number): number {
    let k = key;
    let f = fine;
    const top = tables.engine.sampleKeyTop;
    if (k > top) {
      k = top;
      f = 255;
    }
    const at = (i: number) => {
      const s = tables.scale[i];
      return tables.freq[s & 15] >>> (s >> 4);
    };
    const v1 = at(k);
    const v2 = at(k + 1);
    return hi32(wave.freq, (v1 + hi32((v2 - v1) >>> 0, f * 0x1000000)) >>> 0);
  }

  class DsVoice {
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
    level = 0;
    rate = 0;
    sample: Wave | null = null;
    start = 0;
    index = 0;
    remaining = 0;
    phase = 0;
    loop = false;
  }

  // the m4a mixer: a ring of `ringFrames` slots per side, seeded from the reverb, then each voice's envelope step and
  // its interpolated, wrapping mix (10.4, 10.5); out[j] is the mono sum of both 8-bit buffers
  class DsMixer {
    private readonly right: Int8Array;
    private readonly left: Int8Array;
    private readonly perFrame: number;
    private readonly slots: number;
    private readonly master: number;
    private slot = 0;

    constructor(
      private readonly echo: number,
      tables: any,
    ) {
      const mixer = tables.engine.mixer;
      this.perFrame = mixer.samplesPerFrame;
      this.slots = mixer.ringFrames;
      this.master = mixer.masterVolume;
      this.right = new Int8Array(this.perFrame * this.slots);
      this.left = new Int8Array(this.perFrame * this.slots);
    }

    frame(voices: DsVoice[], out: { [j: number]: number }): void {
      const n = this.perFrame;
      const base = this.slot * n;
      const after = ((this.slot + 1) % this.slots) * n;
      const { right, left } = this;
      if (this.echo === 0) {
        right.fill(0, base, base + n);
        left.fill(0, base, base + n);
      } else {
        for (let j = 0; j < n; j++) {
          const a = right[base + j] + left[base + j] + right[after + j] + left[after + j];
          let r = (a * this.echo) >> 9;
          if (r < 0) r += 1;
          right[base + j] = r;
          left[base + j] = r;
        }
      }
      for (const v of voices) {
        if (!v.sample || !(v.state & ACTIVE)) continue;
        if (this.envelope(v)) this.mix(v, base);
      }
      for (let j = 0; j < n; j++) out[j] = right[base + j] + left[base + j];
      this.slot = (this.slot + 1) % this.slots;
    }

    private silence(v: DsVoice): false {
      v.state = 0;
      return false;
    }

    // e = echo volume and the echo tail, or silence without one
    private echoTail(v: DsVoice): boolean {
      if (v.echoVolume === 0) return this.silence(v);
      v.level = v.echoVolume;
      v.state = (v.state & ~PHASE) | ECHO;
      return true;
    }

    private envelope(v: DsVoice): boolean {
      const st = v.state;
      if (st & NEW) {
        if (st & KEY_OFF) return this.silence(v);
        const w = v.sample!;
        v.state = ATTACK;
        v.index = v.start;
        v.remaining = w.size - v.start;
        v.phase = 0;
        v.level = 0;
        v.loop = w.loop;
      } else if (st & ECHO) {
        const old = v.echoLength;
        v.echoLength = (old - 1) & 0xff;
        return old <= 1 ? this.silence(v) : true;
      } else if (st & KEY_OFF) {
        v.level = (v.level * v.release) >> 8;
        return v.level > v.echoVolume ? true : this.echoTail(v);
      }
      switch (v.state & PHASE) {
        case DECAY:
          v.level = (v.level * v.decay) >> 8;
          if (v.level > v.sustain) return true;
          v.level = v.sustain;
          if (v.sustain === 0) return this.echoTail(v);
          v.state = (v.state & ~PHASE) | SUSTAIN;
          return true;
        case ATTACK:
          v.level += v.attack;
          if (v.level >= 255) {
            v.level = 255;
            v.state = (v.state & ~PHASE) | DECAY;
          }
          return true;
        default:
          return true;
      }
    }

    private mix(v: DsVoice, base: number): void {
      const w = v.sample!;
      const data = w.data;
      const limit = data.length;
      const size = w.size;
      const reverse = (v.type & 0x10) !== 0;
      const g = ((this.master + 1) * v.level) >> 4;
      const gainRight = (v.rightLevel * g) >> 8;
      const gainLeft = (v.leftLevel * g) >> 8;
      const step = v.type & 0x08 ? ONE : Math.imul(627, v.rate) >>> 0;
      const loopLength = size - w.loopStart;
      const read = (i: number) => {
        const k = reverse ? size - 1 - i : i;
        return k >= 0 && k < limit ? data[k] : 0;
      };
      const { right, left } = this;
      let { index, remaining, phase } = v;
      for (let j = 0; j < this.perFrame; j++) {
        const a = read(index);
        const b = read(index + 1);
        const value = a + ((phase * (b - a)) >> 23);
        right[base + j] += (gainRight * value) >> 8;
        left[base + j] += (gainLeft * value) >> 8;
        phase += step;
        const moved = Math.floor(phase / ONE);
        phase -= moved * ONE;
        if (moved > 0) {
          remaining -= moved;
          index += moved;
        }
        if (remaining <= 0) {
          if (!v.loop || loopLength <= 0) {
            v.state = 0;
            break;
          }
          while (remaining <= 0) remaining += loopLength;
          index = size - remaining;
        }
      }
      v.index = index;
      v.remaining = remaining;
      v.phase = phase;
    }
  }

  // the cry song of 13.2 for one mode, with the values written at the template's named offsets (A.10)
  function crySong(params: any, song: any, wave: Wave, tables: any) {
    const cry = tables.engine.cry;
    const at = cry.at;
    const bytes = Uint8Array.from(cry.bytes as number[]);
    const put32 = (offset: number, value: number) => {
      for (let i = 0; i < 4; i++) bytes[offset + i] = (value >>> (8 * i)) & 0xff;
    };
    bytes[at.tune] = song.tune;
    put32(at.jump, at.jumpTo);
    bytes[at.tune2] = song.tune2;
    bytes[at.volume] = song.volume;
    put32(at.progress, params.progress || 0);
    bytes[at.release] = song.release;
    bytes[at.pan] = ((params.pan || 0) + cry.center) & 0x7f;
    bytes[at.key] = song.key;
    bytes[at.length] = song.length & 0xff;
    bytes[at.length + 1] = (song.length >> 8) & 0xff;
    return {
      p: params.priority,
      r: 0,
      t: song.twoTracks ? [...cry.tracks] : [cry.tracks[0]],
      bytes,
      v: { 0: song.reverse && params.toneReverse ? params.toneReverse : params.tone },
      w: { 0: wave },
    };
  }

  const lib = ((window as any).__peaLib ??= {});
  lib.ds = { Wave, sampleRateFor, DsMixer, DsVoice, crySong, VOICE_BITS };
})();
