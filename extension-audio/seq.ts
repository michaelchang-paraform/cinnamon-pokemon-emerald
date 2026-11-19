// The song half of the pokemon-audio engine: the m4a sequencer (tracks, commands, notes, voice claims, level and
// pitch), one Player per song driving the PSG driver and the DirectSound mixer, the Renderer that turns a Player into
// browser-rate samples, and the clip helpers (loopCut, highPass, cryClip). Publishes window.__peaLib.seq.
(() => {
  const peaLib = (window as any).__peaLib;
  const { TICK_HZ, FRAME_TICKS, Apu, PsgDriver, psgPitch } = peaLib.apu;
  const { DsMixer, DsVoice, sampleRateFor, crySong, VOICE_BITS } = peaLib.ds;
  const { NEW, KEY_OFF, PHASE, ACTIVE } = VOICE_BITS;

  const s8 = (x: number) => ((x & 0xff) ^ 0x80) - 0x80;
  const word = (b: ArrayLike<number>, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

  // any claimed voice, sampled (DsVoice) or Game Boy (PsgSlot)
  type Voice = {
    psg?: boolean;
    state: number;
    owner: number;
    priority: number;
    gate: number;
    noteKey: number;
    key: number;
    velocity: number;
    panOffset: number;
    rightLevel: number;
    leftLevel: number;
    rate: number;
    sample?: unknown;
    pitchMark?: boolean;
    levelMark?: boolean;
  };
  type ToneRecord = { b: number[]; s?: string; w?: string; g?: number; k?: string };

  class SongTrack {
    alive = false;
    pendingReset = false;
    levelDirty = false;
    pitchDirty = false;
    wait = 0;
    depth = 0;
    readonly returns = [0, 0, 0];
    repeatCount = 0;
    gate = 0;
    key = 0;
    velocity = 0;
    running = 0;
    keyOffset = 0;
    fraction = 0;
    transpose = 0;
    tune = 0;
    bend = 0;
    bendRange = 0;
    rightOut = 0;
    leftOut = 0;
    volume = 0;
    outsideVolume = 0;
    pan = 0;
    modValue = 0;
    modDepth = 0;
    modType = 0;
    lfoSpeed = 0;
    lfoPhase = 0;
    lfoDelay = 0;
    lfoHold = 0;
    priority = 0;
    echoVolume = 0;
    echoLength = 0;
    voice: number[] = new Array(12).fill(0);
    record: ToneRecord | null = null;
    instrument = 0;
    extendedTimer = 0;
    startOffset = 0;
    pos = 0;
    held: Voice[] = [];
    constructor(readonly index: number) {}
  }

  const asRecord = (x: unknown): ToneRecord | null => {
    if (x == null) return null;
    if (Array.isArray(x) || ArrayBuffer.isView(x)) return { b: Array.from(x as ArrayLike<number>) };
    return x as ToneRecord;
  };

  // one song on its own sequencer, PSG driver, sampled voices and mixer
  class Player {
    readonly apu: any;
    readonly driver: any;
    readonly psg: Voice[];
    readonly ds: Voice[];
    readonly dsOut = new Int16Array(224);
    readonly tracks: SongTrack[];
    readonly loops: number[] = [];
    readonly notes: number[][] = [];
    frames = 0;
    endFrame = -1;
    fineFrame = -1;
    playing = true;
    private readonly bytes: Uint8Array;
    private readonly mixer: any;
    private readonly engine: any;
    private readonly pitchOffset: number;
    private baseTempo: number;
    private tempoScale = 256;
    private tempo: number;
    private tempoAcc = 0;
    private clock = 0;

    constructor(
      private readonly song: any,
      private readonly tables: any,
    ) {
      this.engine = tables.engine;
      this.bytes = song.bytes ?? Uint8Array.from(atob(song.b), (c) => c.charCodeAt(0));
      this.pitchOffset = song.pitX ?? 0;
      this.baseTempo = this.tempo = this.engine.startTempo;
      this.apu = new Apu();
      this.driver = new PsgDriver(this.apu, tables);
      this.psg = this.driver.slots;
      this.ds = Array.from({ length: this.engine.mixer.channels }, () => new DsVoice());
      this.mixer = new DsMixer(song.r & 0x80 ? song.r & 0x7f : 0, tables);
      this.tracks = (song.t as number[]).map((start, i) => {
        const t = new SongTrack(i);
        t.alive = t.pendingReset = true;
        t.pos = start;
        return t;
      });
    }

    get sounding(): boolean {
      return this.playing || this.driver.sounding || this.ds.some((v) => (v.state & ACTIVE) !== 0) || this.apu.active;
    }

    frame(): void {
      if (this.playing) this.sequence();
      this.driver.frame();
      this.mixer.frame(this.ds, this.dsOut);
      this.frames++;
    }

    private sequence(): void {
      const unit = this.engine.tempoUnit;
      this.tempoAcc = (this.tempoAcc + this.tempo) & 0xffff;
      while (this.tempoAcc >= unit) {
        const anyAlive = this.tick();
        this.clock++;
        this.tempoAcc = (this.tempoAcc - unit) & 0xffff;
        if (!anyAlive) {
          this.playing = false;
          this.endFrame = this.frames;
          return;
        }
      }
      for (const t of this.tracks) if (t.alive && (t.levelDirty || t.pitchDirty)) this.settle(t);
    }

    private tick(): boolean {
      let anyAlive = false;
      for (const t of this.tracks) {
        if (!t.alive) continue;
        anyAlive = true;
        for (const v of [...t.held]) {
          if (v.state & ACTIVE && v.gate !== 0) {
            v.gate = (v.gate - 1) & 0xff;
            if (v.gate === 0) v.state |= KEY_OFF;
          }
          if (!(v.state & ACTIVE)) this.detach(t, v);
        }
        if (t.pendingReset) this.reset(t);
        if (!this.read(t)) continue;
        t.wait--;
        this.lfo(t);
      }
      return anyAlive;
    }

    private reset(t: SongTrack): void {
      const fresh = new SongTrack(t.index);
      const { pos, returns } = t;
      Object.assign(t, fresh, { pos, returns });
      const defaults = this.engine.trackDefaults;
      t.alive = true;
      t.bendRange = defaults.bendRange;
      t.lfoSpeed = defaults.lfoSpeed;
      t.voice[0] = defaults.type;
      const known = new Set(['bendRange', 'lfoSpeed', 'type']);
      t.outsideVolume = Object.entries<number>(defaults).find(([name]) => !known.has(name))?.[1] ?? 64;
      if (this.pitchOffset) t.pitchDirty = true;
    }

    // reads commands until the track sets a wait; false when the track ended
    private read(t: SongTrack): boolean {
      const b = this.bytes;
      const ops = this.engine.ops;
      while (t.wait === 0) {
        const at = t.pos;
        let c = b[t.pos] ?? 0;
        if (c < 0x80) c = t.running;
        else {
          t.pos++;
          if (c >= ops.runningFrom) t.running = c;
        }
        if (c >= ops.waitFirst && c <= ops.waitLast) t.wait = this.tables.clock[c - ops.waitFirst];
        else if (c >= ops.noteFirst) this.note(t, c);
        else if (!this.command(t, c, at)) return false;
      }
      return true;
    }

    private command(t: SongTrack, c: number, at: number): boolean {
      const b = this.bytes;
      const center = this.engine.ops.center;
      const operand = () => b[t.pos++];
      switch (this.engine.commands[c]) {
        case 'jump': {
          const target = word(b, t.pos);
          if (t.index === 0 && target < t.pos) this.loops.push(this.frames);
          t.pos = target;
          return true;
        }
        case 'call':
          if (t.depth >= this.engine.patternDepth) return this.finish(t);
          t.returns[t.depth++] = t.pos + 4;
          t.pos = word(b, t.pos);
          return true;
        case 'return':
          if (t.depth > 0) t.pos = t.returns[--t.depth];
          return true;
        case 'repeat': {
          const count = operand();
          if (count === 0) t.pos = word(b, t.pos);
          else if (++t.repeatCount < count) t.pos = word(b, t.pos);
          else {
            t.repeatCount = 0;
            t.pos += 4;
          }
          return true;
        }
        case 'memory':
          t.pos += 3;
          return true;
        case 'priority':
          t.priority = operand();
          return true;
        case 'tempo':
          this.baseTempo = 2 * operand();
          this.tempo = (this.baseTempo * this.tempoScale) >> 8;
          return true;
        case 'transpose':
          t.transpose = s8(operand());
          t.pitchDirty = true;
          return true;
        case 'instrument':
          this.instrument(t, operand());
          return true;
        case 'volume':
          t.volume = operand();
          t.levelDirty = true;
          return true;
        case 'pan':
          t.pan = s8(operand() - center);
          t.levelDirty = true;
          return true;
        case 'bend':
          t.bend = s8(operand() - center);
          t.pitchDirty = true;
          return true;
        case 'bendRange':
          t.bendRange = operand();
          t.pitchDirty = true;
          return true;
        case 'lfoSpeed':
          t.lfoSpeed = operand();
          if (t.lfoSpeed === 0) this.calm(t);
          return true;
        case 'lfoDelay':
          t.lfoDelay = operand();
          return true;
        case 'modDepth':
          t.modDepth = operand();
          if (t.modDepth === 0) this.calm(t);
          return true;
        case 'modType': {
          const kind = operand();
          if (kind !== t.modType) {
            t.modType = kind;
            t.levelDirty = t.pitchDirty = true;
          }
          return true;
        }
        case 'tune':
          t.tune = s8(operand() - center);
          t.pitchDirty = true;
          return true;
        case 'register':
          t.pos += 2;
          return true;
        case 'extended':
          return this.extended(t, at);
        case 'release':
          this.releaseKey(t);
          return true;
        default:
          return this.finish(t);
      }
    }

    private extended(t: SongTrack, at: number): boolean {
      const b = this.bytes;
      const sub = b[t.pos++];
      const operand = () => b[t.pos++];
      switch (this.engine.extended[sub]) {
        case 'waveAddress':
          t.pos += 4;
          return true;
        case 'type':
          t.voice[0] = operand();
          return true;
        case 'attack':
          t.voice[8] = operand();
          return true;
        case 'decay':
          t.voice[9] = operand();
          return true;
        case 'sustain':
          t.voice[10] = operand();
          return true;
        case 'releaseRate':
          t.voice[11] = operand();
          return true;
        case 'echoVolume':
          t.echoVolume = operand();
          return true;
        case 'echoLength':
          t.echoLength = operand();
          return true;
        case 'length':
          t.voice[2] = operand();
          return true;
        case 'sweep':
          t.voice[3] = operand();
          return true;
        case 'wait': {
          const ticks = b[t.pos] | (b[t.pos + 1] << 8);
          if (t.extendedTimer < ticks) {
            t.extendedTimer++;
            t.pos = at;
            t.wait = 1;
          } else {
            t.extendedTimer = 0;
            t.pos += 2;
          }
          return true;
        }
        case 'progress':
          t.startOffset = word(b, t.pos);
          t.pos += 4;
          return true;
        default:
          return this.finish(t);
      }
    }

    private instrument(t: SongTrack, n: number): void {
      const raw = this.song.v?.[n];
      const record = typeof raw === 'number' || typeof raw === 'string' ? asRecord(this.song.tones?.[raw]) : asRecord(raw);
      t.instrument = n;
      t.record = record;
      t.voice = record ? record.b.slice(0, 12) : [0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      while (t.voice.length < 12) t.voice.push(0);
    }

    // ends a track: its voices go to their release with no owner
    private finish(t: SongTrack): false {
      for (const v of t.held) {
        if (v.state & ACTIVE) v.state |= KEY_OFF;
        v.owner = -1;
      }
      t.held = [];
      t.alive = false;
      this.fineFrame = this.frames;
      return false;
    }

    private calm(t: SongTrack): void {
      t.modValue = 0;
      t.lfoPhase = 0;
      if (t.modType === 0) t.pitchDirty = true;
      else t.levelDirty = true;
    }

    private lfo(t: SongTrack): void {
      if (t.lfoSpeed === 0 || t.modDepth === 0) return;
      if (t.lfoHold !== 0) {
        t.lfoHold--;
        return;
      }
      t.lfoPhase = (t.lfoPhase + t.lfoSpeed) & 0xff;
      const p = t.lfoPhase;
      const wave = p >= 64 && p <= 191 ? 128 - p : s8(p);
      const m = (t.modDepth * wave) >> 6;
      if ((m & 0xff) === (t.modValue & 0xff)) return;
      t.modValue = s8(m);
      if (t.modType === 0) t.pitchDirty = true;
      else t.levelDirty = true;
    }

    // the oldest voice of this track still in a level stage or new, on the key
    private releaseKey(t: SongTrack): void {
      const b = this.bytes;
      if (b[t.pos] < 0x80) t.key = b[t.pos++];
      const hit = t.held.find((v) => !(v.state & KEY_OFF) && v.state & (NEW | PHASE) && v.noteKey === t.key);
      if (hit) hit.state |= KEY_OFF;
    }

    private trackLevels(t: SongTrack): void {
      let x = (t.volume * t.outsideVolume) >> 5;
      if (t.modType === 1) x = (x * (t.modValue + 128)) >> 7;
      let y = 2 * t.pan;
      if (t.modType === 2) y += t.modValue;
      y = Math.max(-128, Math.min(127, y));
      t.rightOut = (((y + 128) * x) >> 8) & 0xff;
      t.leftOut = (((127 - y) * x) >> 8) & 0xff;
    }

    private trackPitch(t: SongTrack): void {
      let p = (t.tune + t.bend * t.bendRange) * 4 + t.transpose * 256 + this.pitchOffset;
      if (t.modType === 0) p += 16 * t.modValue;
      t.keyOffset = p >> 8;
      t.fraction = p & 255;
    }

    private voiceLevels(v: Voice, t: SongTrack): void {
      v.rightLevel = Math.min(255, (v.velocity * (128 + v.panOffset) * t.rightOut) >> 14);
      v.leftLevel = Math.min(255, (v.velocity * (127 - v.panOffset) * t.leftOut) >> 14);
    }

    private retune(v: Voice, t: SongTrack, channel: number): number {
      const key = Math.max(0, v.key + t.keyOffset);
      return channel ? psgPitch(this.tables, channel, key, t.fraction) : sampleRateFor(this.tables, v.sample, key, t.fraction);
    }

    // end-of-frame pass (8.4)
    private settle(t: SongTrack): void {
      if (t.levelDirty) this.trackLevels(t);
      if (t.pitchDirty) this.trackPitch(t);
      for (const v of [...t.held]) {
        if (!(v.state & ACTIVE)) {
          this.detach(t, v);
          continue;
        }
        const channel = v.psg ? (v as any).channel : 0;
        if (t.levelDirty) {
          this.voiceLevels(v, t);
          if (v.psg) v.levelMark = true;
        }
        if (t.pitchDirty) {
          v.rate = this.retune(v, t, channel);
          if (v.psg) v.pitchMark = true;
        }
      }
      t.levelDirty = t.pitchDirty = false;
    }

    private detach(t: SongTrack, v: Voice): void {
      const i = t.held.indexOf(v);
      if (i >= 0) t.held.splice(i, 1);
    }

    private tone(index: number): ToneRecord | null {
      return asRecord(this.song.tones?.[index]);
    }

    private note(t: SongTrack, c: number): void {
      const b = this.bytes;
      t.gate = this.tables.clock[c - this.engine.ops.noteFirst];
      if (b[t.pos] < 0x80) {
        t.key = b[t.pos++];
        if (b[t.pos] < 0x80) {
          t.velocity = b[t.pos++];
          if (b[t.pos] < 0x80) t.gate = (t.gate + b[t.pos++]) & 0xff;
        }
      }
      this.sound(t);
    }

    private sound(t: SongTrack): void {
      let entry = t.voice;
      let record = t.record;
      let key = t.key;
      let panOffset = 0;
      if (entry[0] & 0xc0) {
        if (!record || record.g == null) return;
        const index = entry[0] & 0x40 ? record.g + (this.song.splits?.[record.k!]?.[t.key] ?? 0) : record.g + t.key;
        const sub = this.tone(index);
        if (!sub) return;
        if (!(entry[0] & 0x40)) {
          key = sub.b[1];
          if (sub.b[3] & 0x80) panOffset = s8((sub.b[3] - 0xc0) * 2);
        }
        record = sub;
        entry = sub.b;
        if (entry[0] & 0xc0) return;
      }
      const priority = Math.min(255, this.song.p + t.priority);
      const channel = entry[0] & 7;
      let sample: unknown = null;
      let v: Voice | null;
      if (channel === 0) {
        sample = record?.s ? this.song.samples?.[record.s] : this.song.w?.[t.instrument];
        if (!sample) return;
        v = this.claimSampled(priority, t.index);
      } else {
        v = this.psg[channel - 1];
        const free = !(v.state & ACTIVE) || v.state & KEY_OFF || v.priority < priority || (v.priority === priority && v.owner >= t.index);
        if (!free) v = null;
      }
      if (!v) return;

      if (v.owner >= 0 && this.tracks[v.owner]) this.detach(this.tracks[v.owner], v);
      t.held.push(v);
      t.lfoHold = t.lfoDelay;
      if (t.lfoDelay) this.calm(t);
      if (t.levelDirty) this.trackLevels(t);
      if (t.pitchDirty) this.trackPitch(t);
      t.levelDirty = t.pitchDirty = false;

      const slot = v as any;
      slot.state = NEW;
      slot.owner = t.index;
      slot.gate = t.gate;
      slot.noteKey = t.key;
      slot.velocity = t.velocity;
      slot.priority = priority;
      slot.key = key;
      slot.panOffset = panOffset;
      slot.type = entry[0];
      slot.attack = entry[8];
      slot.decay = entry[9];
      slot.sustain = entry[10];
      slot.release = entry[11];
      slot.echoVolume = t.echoVolume;
      slot.echoLength = t.echoLength;
      this.voiceLevels(v, t);
      if (channel === 0) {
        slot.sample = sample;
        slot.start = t.startOffset;
      } else {
        slot.length = entry[2];
        const sweep = entry[3];
        slot.sweep = !(sweep & 0x80) && sweep & 0x70 ? sweep : 8;
        slot.reference = word(entry, 4);
        slot.image = channel === 3 ? (this.song.waves?.[record?.w ?? ''] ?? null) : null;
      }
      v.rate = this.retune(v, t, channel);
      this.notes.push([this.frames, channel, v.rate]);
    }

    // the sampled-voice claim of 9.1: a silent voice, else the top-ranked released one, else the top-ranked voice
    // if it ranks at or above the note
    private claimSampled(priority: number, track: number): Voice | null {
      const voices = this.ds;
      const silent = voices.find((v) => !(v.state & ACTIVE));
      if (silent) return silent;
      const above = (x: Voice, xi: number, y: Voice, yi: number) =>
        x.priority !== y.priority ? x.priority < y.priority : x.owner !== y.owner ? x.owner > y.owner : xi > yi;
      const best = (pool: number[]) => pool.reduce((top, i) => (top < 0 || above(voices[i], i, voices[top], top) ? i : top), -1);
      const all = voices.map((_, i) => i);
      const released = best(all.filter((i) => voices[i].state & KEY_OFF));
      if (released >= 0) return voices[released];
      const top = voices[best(all)];
      return top.priority < priority || (top.priority === priority && top.owner >= track) ? top : null;
    }
  }

  type RenderResult = {
    samples: Float32Array;
    frames: number;
    endFrame: number;
    fineFrame: number;
    notes: number[][];
    loops: number[];
    frameStarts: number[];
  };

  class Renderer {
    readonly player: Player;
    done = false;
    private readonly frameStarts: number[] = [];
    private out = new Float32Array(1 << 16);
    private written = 0;
    private readonly cursor = { index: 0, acc: 0, sum: 0, count: 0 };
    private readonly scratch: Float32Array;
    private readonly maxFrames: number;
    private readonly stride: number;
    private readonly loopsWanted: number;
    private readonly dsUnit: number;

    constructor(
      song: any,
      tables: any,
      private readonly rate: number,
      private readonly scale: number,
      opts: { maxFrames?: number; stride?: number; loops?: number } = {},
    ) {
      this.player = new Player(song, tables);
      this.maxFrames = opts.maxFrames || 480;
      this.stride = opts.stride || 1;
      this.loopsWanted = opts.loops || 0;
      this.dsUnit = 1 / 256 / scale;
      this.scratch = new Float32Array(Math.ceil((FRAME_TICKS * rate) / TICK_HZ) + 8);
    }

    step(frames: number): boolean {
      const p = this.player;
      for (let n = 0; n < frames && !this.done; n++) {
        if (!p.sounding || p.frames >= this.maxFrames || (this.loopsWanted && p.loops.length >= this.loopsWanted)) {
          this.done = true;
          break;
        }
        this.frameStarts.push(this.written);
        p.frame();
        this.cursor.index = 0;
        p.apu.run(FRAME_TICKS, this.scratch, this.cursor, this.rate, this.scale, p.dsOut, this.dsUnit, this.stride);
        this.keep(this.cursor.index);
      }
      return this.done;
    }

    private keep(count: number): void {
      if (this.written + count > this.out.length) {
        const bigger = new Float32Array(Math.max(this.out.length * 2, this.written + count));
        bigger.set(this.out.subarray(0, this.written));
        this.out = bigger;
      }
      this.out.set(this.scratch.subarray(0, count), this.written);
      this.written += count;
    }

    result(trim: boolean): RenderResult {
      let n = this.written;
      if (trim) while (n > 0 && Math.abs(this.out[n - 1]) < 1e-6) n--;
      const p = this.player;
      return {
        samples: this.out.slice(0, n),
        frames: p.frames,
        endFrame: p.endFrame,
        fineFrame: p.fineFrame,
        notes: p.notes,
        loops: p.loops,
        frameStarts: this.frameStarts,
      };
    }
  }

  function renderSong(song: any, tables: any, rate: number, scale: number): RenderResult {
    const r = new Renderer(song, tables, rate, scale);
    while (!r.step(1000));
    return r.result(true);
  }

  // intro plus one loop body, with both seams faded into the audio just before the first loop frame (A.8)
  function loopCut(r: RenderResult, fade: number): { samples: Float32Array; loopStart: number; loopEnd: number } | null {
    if (r.loops.length < 2) return null;
    const [first, second] = r.loops;
    const intro = first - (second - first);
    if (intro < 0) return null;
    const s0 = r.frameStarts[intro];
    const s1 = r.frameStarts[first];
    const s2 = r.frameStarts[second];
    const src = r.samples;
    const out = new Float32Array(s0 + (s2 - s1));
    out.set(src.subarray(0, s0));
    out.set(src.subarray(s1, s2), s0);
    const blend = (end: number, span: number) => {
      for (let i = 0; i < span; i++) {
        const w = (i + 1) / span;
        out[end - span + i] = out[end - span + i] * (1 - w) + src[s1 - span + i] * w;
      }
    };
    blend(s0, Math.min(fade, s0, s1));
    blend(out.length, Math.min(fade, out.length, s1));
    return { samples: out, loopStart: s0, loopEnd: out.length };
  }

  function highPass(samples: Float32Array, rate: number, cornerHz: number): void {
    const a = Math.exp((-2 * Math.PI * cornerHz) / rate);
    let lastIn = 0;
    let lastOut = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      lastOut = a * (lastOut + x - lastIn);
      lastIn = x;
      samples[i] = lastOut;
    }
  }

  const TWO_PART: Record<string, [string, string]> = { echo: ['echo_start', 'echo_end'], growl: ['growl_1', 'growl_2'], roar: ['roar_1', 'roar_2'] };

  function cryClip(wave: any, cries: any, tables: any, mode: string, rate: number, scale: number): Float32Array {
    const part = (name: string) => renderSong(crySong(cries.params, cries.songs[name] ?? cries.songs.normal, wave, tables), tables, rate, scale);
    const pair = TWO_PART[mode];
    if (!pair) return part(mode).samples;
    const one = part(pair[0]);
    const two = part(pair[1]).samples;
    const tasks = tables.engine.cryTasks;
    const at = (frame: number) => Math.round((frame * FRAME_TICKS * rate) / TICK_HZ);
    let start1 = 0;
    let start2: number;
    let kept = one.samples.length;
    if (mode === 'echo') {
      start1 = tasks.echoStart;
      const cut = Math.max(tasks.echoCheckFrom, start1 + one.fineFrame + 1);
      start2 = cut + 1;
      kept = Math.min(kept, at(cut) - at(start1));
    } else {
      start2 = Math.max(tasks.doubleWait, one.fineFrame + 1);
    }
    const out = new Float32Array(Math.max(at(start1) + kept, at(start2) + two.length));
    out.set(one.samples.subarray(0, kept), at(start1));
    const base = at(start2);
    for (let i = 0; i < two.length; i++) out[base + i] = out[base + i] + two[i];
    return out;
  }

  peaLib.seq = { Player, Renderer, renderSong, loopCut, highPass, cryClip };
})();
