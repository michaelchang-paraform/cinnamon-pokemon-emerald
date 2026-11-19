type Side = 'me' | 'foe';

const ns = (window as any).__pkb;
const { assets, toId } = ns;
const FRAME_MS = 1000 / 59.7275;
// effects the audio extension renders with a loop body; the game stops them when their animation ends
const LOOPING = ['SE_M_GUST', 'SE_M_GUST2'];
const STATUS_ANIM: Record<string, string> = { psn: 's:Poison', tox: 's:Poison', brn: 's:Burn', slp: 's:Sleep', par: 's:Paralysis', frz: 's:Freeze' };
// Showdown [from] effects that play one of the game's general or status animations on the affected mon
const FROM_ANIM: Record<string, string> = {
  psn: 's:Poison', tox: 's:Poison', brn: 's:Burn', curse: 's:Curse', nightmare: 's:Nightmare',
  leechseed: 'g:LeechSeedDrain', leftovers: 'g:HeldItemEffect', ingrain: 'g:IngrainHeal', wish: 'g:WishHeal',
  wrap: 'g:TurnTrap', bind: 'g:TurnTrap', firespin: 'g:TurnTrap', clamp: 'g:TurnTrap', whirlpool: 'g:TurnTrap', sandtomb: 'g:TurnTrap',
};
// -start and -activate effects: confusion and infatuation on infliction and each turn they act
const ACTIVATE_ANIM: Record<string, string> = { confusion: 's:Confusion', attract: 's:Infatuation', focusband: 'g:FocusBand' };
const WEATHER_ANIM: Record<string, string> = { RainDance: 'g:Rain', SunnyDay: 'g:Sun', Sandstorm: 'g:Sandstorm', Hail: 'g:Hail' };

const audio = () => (window as any).__peAudio;

// the battle window's sound effects: every id comes from the audio extension; one it lacks plays silence and is
// kept in `missing` for the guard
class BattleSound {
  readonly missing = new Set<string>();
  private readonly timers = new Set<number>();
  private known: Set<string> | null = null;
  private lowWanted = false;
  private lowOn = false;

  constructor(
    private readonly audible: () => boolean,
    private readonly dexOf: (key: Side) => number | null = () => null,
  ) {}

  has(id: string): boolean {
    if (!this.known) {
      try {
        const list = audio()?.sfxList?.();
        if (Array.isArray(list) && list.length) this.known = new Set(list.map((e: { id: string }) => e.id));
      } catch {}
    }
    return this.known?.has(id) ?? false;
  }

  play(id: string, pan = 0): void {
    if (!audio() || !this.audible()) return;
    if (!this.has(id)) {
      this.missing.add(id);
      return;
    }
    try {
      audio().play(id, pan ? { window: 'battle', pan } : { window: 'battle' });
    } catch {}
  }

  stop(id: string): void {
    try {
      audio()?.stop?.(id, { window: 'battle' });
    } catch {}
  }

  // BattleAnimAdjustPanning for a single battle; a status animation keeps every effect on the afflicted side
  pan(raw: number, attacker: Side, target: Side, status = false): number {
    let p = raw;
    if (status) p = attacker === 'me' ? -64 : 63;
    else if (attacker === 'me') {
      if (target === 'me') p = p === 63 || p === -64 ? -64 : -p;
    } else if (target === 'foe') {
      if (p === -64) p = 63;
    } else p = -p;
    return Math.max(-64, Math.min(63, p)) / 64;
  }

  // the effects of one anim script on its frame timings; resolves with the time the last one starts
  script(key: string, attacker: Side, target: Side, status = false): number {
    const timeline: number[] | undefined = assets.data?.se?.a?.[key];
    const names: string[] = assets.data?.se?.n ?? [];
    if (!timeline || !this.audible()) return 0;
    let last = 0;
    for (let i = 1; i < timeline.length; i += 3) {
      const id = names[timeline[i + 1]];
      const at = timeline[i] * FRAME_MS;
      const pan = this.pan(timeline[i + 2], attacker, target, status);
      last = Math.max(last, at);
      if (id.startsWith('CRY:')) {
        const [, mode, who] = id.split(':');
        const dex = this.dexOf(who === 'ANIM_TARGET' ? target : attacker);
        if (dex) this.after(at, () => this.cryAt(dex, pan, mode));
        continue;
      }
      this.after(at, () => this.play(id, pan));
      if (LOOPING.includes(id)) this.after(timeline[0] * FRAME_MS, () => this.stop(id));
    }
    return last;
  }

  move(name: string, user: Side, target: Side | null, charge = false): number {
    const id = toId(name);
    return this.script(charge ? `${id}@1` : id, user, target ?? user);
  }

  // Cmd_effectivenesssound and the faint cry's SE, panned to the battler's side by its controller
  hit(target: Side, effect: string | null): void {
    this.play(effect === 'super' ? 'SE_SUPER_EFFECTIVE' : effect === 'weak' ? 'SE_NOT_EFFECTIVE' : 'SE_EFFECTIVE', target === 'me' ? -1 : 63 / 64);
  }

  faint(key: Side): void {
    this.play('SE_FAINT', key === 'me' ? -1 : 63 / 64);
  }

  // AnimTask_StatsChange plays this itself, panned to the battler whose stats change
  stat(key: Side, up: boolean): void {
    this.play(up ? 'SE_M_STAT_INCREASE' : 'SE_M_STAT_DECREASE', this.pan(-64, key, key));
  }

  status(key: Side, status: string): void {
    const anim = STATUS_ANIM[status];
    if (anim) this.script(anim, key, key, true);
  }

  // the animation of an effect named by Showdown's [from] (residual) or by -start and -activate, on the affected mon
  effect(name: string | undefined, key: Side, residual: boolean): void {
    const id = toId(String(name ?? '').replace(/^(move|item|ability):\s*/i, ''));
    const anim = (residual ? FROM_ANIM : ACTIVATE_ANIM)[id];
    if (anim) this.script(anim, key, key === 'me' ? 'foe' : 'me', anim.startsWith('s:'));
  }

  weather(weather: string, key: Side): void {
    const anim = WEATHER_ANIM[weather];
    if (anim) this.script(anim, key, key);
  }

  // PlayCry_ByMode at the battler's side, the game's pan of 25 either way
  cry(dex: number, key: Side, mode: 'normal' | 'weak' | 'faint'): void {
    this.cryAt(dex, (key === 'me' ? -25 : 25) / 64, mode);
  }

  // a cry in one of PlayCry_ByMode's modes: normal, weak, faint, and from move scripts high_pitch, growl and roar
  // (two-part) and echo
  private cryAt(dex: number, pan: number, mode: string): void {
    if (!audio() || !this.audible()) return;
    try {
      audio().cry(dex, { window: 'battle', pan, mode });
    } catch {}
  }

  // ShouldPlayNormalMonCry: a status or an HP bar at yellow or below makes the release cry weak
  cryMode(mon: { hp: number; maxhp: number; status?: string }): 'normal' | 'weak' {
    const px = mon.hp <= 0 ? 0 : Math.max(1, Math.floor((mon.hp * 48) / Math.max(1, mon.maxhp)));
    return mon.status || (mon.hp !== mon.maxhp && px <= 24) ? 'weak' : 'normal';
  }

  // AnimateBallOpenParticles plays it unpanned, on a send-out and on a recall alike
  ballOpen(): void {
    this.play('SE_BALL_OPEN');
  }

  // HandleLowHpMusicChange: the player's mon in the red zone beeps until it leaves it
  lowHp(hp: number, max: number): void {
    const px = hp <= 0 ? 0 : Math.max(1, Math.floor((hp * 48) / Math.max(1, max)));
    this.lowWanted = hp > 0 && hp !== max && px <= 9;
    this.sync();
  }

  // the beep follows the window: closing or minimizing stops it, reopening starts it again
  sync(): void {
    const on = this.lowWanted && this.audible() && !!audio();
    if (on === this.lowOn) return;
    this.lowOn = on;
    if (on) this.play('SE_LOW_HEALTH');
    else this.stop('SE_LOW_HEALTH');
  }

  private after(ms: number, fn: () => void): void {
    if (ms < 1) return fn();
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  cancel(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const id of LOOPING) this.stop(id);
    this.lowWanted = false;
    this.sync();
  }
}

// every effect the battle window can ask for that the audio extension does not have
function missingEffects(): string[] {
  const sound = new BattleSound(() => true);
  const names: string[] = assets.data?.se?.n ?? [];
  const scripts: Record<string, number[]> = assets.data?.se?.a ?? {};
  const fixed = ['SE_EFFECTIVE', 'SE_SUPER_EFFECTIVE', 'SE_NOT_EFFECTIVE', 'SE_FAINT', 'SE_M_STAT_INCREASE', 'SE_M_STAT_DECREASE', 'SE_BALL_OPEN', 'SE_LOW_HEALTH'];
  const used = new Set(fixed);
  const reachable = [...Object.values(STATUS_ANIM), ...Object.values(FROM_ANIM), ...Object.values(ACTIVATE_ANIM), ...Object.values(WEATHER_ANIM)];
  const pool: string[] = [];
  try {
    for (const entry of audio()?.sfxList?.() ?? []) pool.push(...(entry.moves ?? []));
  } catch {}
  for (const key of [...reachable, ...pool.flatMap((m) => [toId(m), `${toId(m)}@1`])]) {
    const timeline = scripts[key];
    if (timeline) for (let i = 2; i < timeline.length; i += 3) used.add(names[timeline[i]]);
  }
  return [...used].filter((id) => id && !id.startsWith('CRY:') && !sound.has(id)).sort();
}

Object.assign(ns, { BattleSound, missingEffects });
