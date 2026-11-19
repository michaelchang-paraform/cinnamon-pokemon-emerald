// The one music channel all Pokemon windows share, as pure logic so the bun test can drive it: one track sounds at a
// time. A fanfare pauses the music, plays once, and the music resumes where it was. A music start that
// finds the AudioContext locked waits for the next gesture for QUEUE_MS at most; a fanfare never waits.
type ChannelDeps = {
  gain(win: string): number;
  unlocked(): boolean;
  now(): number;
  // seconds into the sounding track
  position(): number;
  prepare(id: string): Promise<unknown>;
  // starts `id` at `offset` seconds; `ended` runs when it finishes on its own
  start(id: string, win: string, offset: number, ended: () => void): void;
  stop(fadeMs: number): void;
  // silences at once whatever is still fading out
  cutFading(): void;
  emit(win: string, id: string | null, state: string): void;
  // true for a fanfare (the build's list of fanfares with their lengths)
  isFanfare(id: string): boolean;
};
type Bgm = { id: string; window: string; offset: number; queuedAt: number | null; mutedSent?: boolean };

const QUEUE_MS = 2000;

class MusicChannel {
  bgm: Bgm | null = null;
  fanfare: { id: string; window: string } | null = null;
  sounding: 'bgm' | 'fanfare' | null = null;
  private token = 0;
  // a halt with a fade leaves the old track sounding until the fade ends; the next start cuts it first
  private fading = false;

  constructor(private readonly d: ChannelDeps) {}

  music(id: string, win: string): void {
    if (this.d.isFanfare(id)) {
      this.playFanfare(id, win);
      return;
    }
    if (this.bgm?.id === id && this.bgm.window === win && this.sounding === 'bgm') return;
    if (this.sounding === 'bgm') this.halt(0);
    this.bgm = { id, window: win, offset: 0, queuedAt: null };
    void this.tryStart();
  }

  // true when the fanfare starts; muted or locked, it is dropped rather than queued
  playFanfare(id: string, win: string): boolean {
    if (this.d.gain(win) <= 0) {
      this.d.emit(win, id, 'muted');
      return false;
    }
    if (!this.d.unlocked()) {
      this.d.emit(win, id, 'skipped');
      return false;
    }
    if (this.sounding === 'bgm' && this.bgm) this.bgm.offset = this.d.position();
    if (this.sounding) this.halt(0);
    this.fanfare = { id, window: win };
    const token = ++this.token;
    void this.d.prepare(id).then(
      () => {
        if (token !== this.token || this.fanfare?.id !== id) return;
        this.beforeStart();
        this.d.start(id, win, 0, () => {
          if (token !== this.token) return;
          this.fanfare = null;
          this.sounding = null;
          this.d.emit(win, id, 'ended');
          void this.tryStart();
        });
        this.sounding = 'fanfare';
        this.d.emit(win, id, 'playing');
      },
      () => {
        if (token !== this.token) return;
        this.fanfare = null;
        void this.tryStart();
      },
    );
    return true;
  }

  async tryStart(): Promise<void> {
    const bgm = this.bgm;
    if (!bgm || this.fanfare || this.sounding) return;
    if (this.d.gain(bgm.window) <= 0) {
      // a gesture retries the start; tell listeners about the mute once, not on every click
      if (!bgm.mutedSent) this.d.emit(bgm.window, bgm.id, 'muted');
      bgm.mutedSent = true;
      return;
    }
    bgm.mutedSent = false;
    if (!this.d.unlocked()) {
      if (bgm.queuedAt === null) {
        bgm.queuedAt = this.d.now();
        this.d.emit(bgm.window, bgm.id, 'waiting-gesture');
      }
      return;
    }
    const token = ++this.token;
    this.d.emit(bgm.window, bgm.id, 'loading');
    try {
      await this.d.prepare(bgm.id);
    } catch {
      return this.d.emit(bgm.window, bgm.id, 'error');
    }
    if (token !== this.token || this.bgm !== bgm || this.fanfare || this.sounding || this.d.gain(bgm.window) <= 0) return;
    bgm.queuedAt = null;
    this.beforeStart();
    this.d.start(bgm.id, bgm.window, bgm.offset, () => {
      if (token !== this.token) return;
      this.sounding = null;
      this.bgm = null;
      this.d.emit(bgm.window, bgm.id, 'ended');
    });
    this.sounding = 'bgm';
    this.d.emit(bgm.window, bgm.id, 'playing');
  }

  // the first gesture after a locked start: the start goes ahead if it is still fresh, else it is dropped
  unlockedNow(): void {
    const bgm = this.bgm;
    if (!bgm || this.sounding || this.fanfare) return;
    if (bgm.queuedAt !== null && this.d.now() - bgm.queuedAt > QUEUE_MS) {
      this.bgm = null;
      this.d.emit(bgm.window, bgm.id, 'expired');
      return;
    }
    void this.tryStart();
  }

  // a window's mute: the track sounding there stops at once (music keeps its place), and unmuting resumes it
  stateChanged(): void {
    if (this.sounding === 'fanfare' && this.fanfare && this.d.gain(this.fanfare.window) <= 0) {
      const f = this.fanfare;
      this.halt(0);
      this.fanfare = null;
      this.d.emit(f.window, f.id, 'muted');
    } else if (this.sounding === 'bgm' && this.bgm && this.d.gain(this.bgm.window) <= 0) {
      this.bgm.offset = this.d.position();
      this.halt(0);
      this.d.emit(this.bgm.window, this.bgm.id, 'muted');
      return;
    }
    if (!this.sounding) void this.tryStart();
  }

  // stops what plays for `win` (any window when omitted); music in another window resumes after a fanfare stops
  stopFor(win: string | null, fadeMs: number): void {
    if (this.fanfare && (win === null || this.fanfare.window === win)) {
      const f = this.fanfare;
      if (this.sounding === 'fanfare') this.halt(fadeMs);
      this.fanfare = null;
      this.d.emit(f.window, f.id, 'stopped');
    }
    if (this.bgm && (win === null || this.bgm.window === win)) {
      const b = this.bgm;
      if (this.sounding === 'bgm') this.halt(fadeMs);
      this.bgm = null;
      this.d.emit(b.window, b.id, 'stopped');
    }
    if (!this.sounding) void this.tryStart();
  }

  private halt(fadeMs: number): void {
    this.token++;
    this.d.stop(fadeMs);
    this.sounding = null;
    if (fadeMs > 0) this.fading = true;
  }

  private beforeStart(): void {
    if (!this.fading) return;
    this.fading = false;
    this.d.cutFading();
  }
}

const channelLib = ((window as any).__peaLib ??= {});
channelLib.channel = { MusicChannel, QUEUE_MS };
