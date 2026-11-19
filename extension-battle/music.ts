declare const cinnamon: { settings: { get(key: string): unknown; set(key: string, value: unknown): void }; onDispose(fn: () => void): void };
type Track = { id: string; label: string; victoryId: string };

const ns = (window as any).__pkb;
const DEFAULT_TRACK: Track = { id: 'MUS_VS_TRAINER', label: 'TRAINER', victoryId: 'MUS_VICTORY_TRAINER' };
const audio = () => (window as any).__peAudio;

function trackList(): Track[] {
  try {
    const raw = audio()?.musicList?.();
    if (Array.isArray(raw) && raw.length)
      return raw
        .filter((t: any) => t && typeof t.id === 'string')
        .map((t: any) => ({ id: t.id, label: String(t.title ?? t.label ?? t.name ?? t.id).toUpperCase().replace(/^MUS_/, '').replace(/_/g, ' '), victoryId: String(t.victoryId ?? DEFAULT_TRACK.victoryId) }));
  } catch {}
  return [DEFAULT_TRACK];
}

// the battle window's music is derived, never remembered: desired(app) reads the open state, the screen and the
// battle outcome, and sync() moves the audio extension to it, so every open, restore and screen change rebuilds it
class BattleMusic {
  private previewId: string | null | undefined = undefined;
  private last: string | null = null;

  pick(): Track | null {
    const id = String(cinnamon.settings.get('musicPick') ?? '');
    return id ? trackList().find((t) => t.id === id) ?? null : null;
  }

  setPick(track: Track | null): void {
    cinnamon.settings.set('musicPick', track ? track.id : null);
  }

  prepare(): void {
    try {
      void Promise.resolve(audio()?.prepareMusic?.((this.pick() ?? DEFAULT_TRACK).id, { window: 'battle' })).catch(() => {});
    } catch {}
  }

  desired(app: any): string | null {
    if (!app.open || (app.floating && app.floatState().min)) return null;
    const pick = this.pick();
    const theme = pick ?? DEFAULT_TRACK;
    const outcome = app.musicOutcome as 'battle' | 'victory' | 'silent' | undefined;
    if (app.screen === 'battle' && app.battle) return outcome === 'victory' ? theme.victoryId : outcome === 'silent' ? null : theme.id;
    if (app.screen === 'result') return outcome === 'victory' ? theme.victoryId : outcome === 'battle' ? theme.id : null;
    if (app.screen === 'lobby') {
      if (app.panel === 'music' && this.previewId !== undefined) return this.previewId;
      return pick?.id ?? null;
    }
    return null;
  }

  private gesture = false;
  private ended: string | null = null;

  // the track the audio extension holds for this window, so a reload or an expiry on its side never leaves us stale
  private holding(): string | null {
    try {
      const state = audio()?.musicState?.();
      if (state) return state.musicWindow === 'battle' ? (state.music ?? null) : null;
    } catch {}
    return this.last;
  }

  // a locked start waits 2 s for a gesture, then expires; the true return asks for a resync on that late gesture
  heard(detail: any): boolean {
    if (detail?.window !== 'battle') return false;
    this.gesture = detail.state === 'waiting-gesture';
    if (detail.state === 'ended') this.ended = detail.id ?? null;
    return detail.state === 'expired';
  }

  sync(app: any, fadeMs = 500): void {
    if (!app.open || app.screen !== 'lobby' || app.panel !== 'music') this.previewId = undefined;
    const want = this.desired(app);
    const have = this.holding();
    this.last = want;
    if (want !== this.ended) this.ended = null;
    if (want === have || (want && want === this.ended)) return;
    try {
      if (want) audio()?.music?.(want, { window: 'battle' });
      else audio()?.stopMusic?.({ window: 'battle', fadeMs: app.open ? fadeMs : 0, free: !app.open });
    } catch {}
  }

  preview(app: any, track: Track | null): void {
    this.previewId = track ? track.id : null;
    this.sync(app, 300);
  }

  endPreview(app: any): void {
    this.previewId = undefined;
    this.sync(app);
  }

  waiting(): boolean {
    return this.gesture && this.last !== null;
  }
}

function musicPanel(app: any): { title: string; items: any[]; hints: string[] } {
  const tracks = trackList();
  return {
    title: 'MUSIC',
    items: [null, ...tracks].map((track: Track | null) => ({
      label: track ? track.label : 'AUTO',
      pick: () => {
        app.music.setPick(track);
        app.panel = 'options';
        app.panelIndex = 1;
        app.music.endPreview(app);
        app.render();
      },
      preview: track,
    })),
    hints: [null, ...tracks].map((track) => (track ? `Plays in your battles and in the lobby.` : 'The game picks the battle music.')),
  };
}

function optionsPanel(app: any): { title: string; items: any[]; hints: string[] } {
  const auto = cinnamon.settings.get('openAtStart') !== false;
  return {
    title: 'OPTIONS',
    items: [
      {
        label: `AUTO OPEN: ${auto ? 'ON' : 'OFF'}`,
        pick: () => {
          cinnamon.settings.set('openAtStart', auto ? false : null);
          app.render();
        },
      },
      {
        label: `MUSIC: ${app.music.pick()?.label ?? 'AUTO'}`,
        pick: () => {
          app.panel = 'music';
          const pick = app.music.pick();
          app.panelIndex = pick ? trackList().findIndex((t) => t.id === pick.id) + 1 : 0;
          app.render();
        },
      },
    ],
    hints: ['Open this window when Claude starts.', 'Pick the battle and lobby music.'],
  };
}

cinnamon.onDispose(() => {
  try {
    audio()?.stopMusic?.({ window: 'battle', fadeMs: 0, free: true });
  } catch {}
});
Object.assign(ns, { BattleMusic, musicPanel, optionsPanel, trackList });
