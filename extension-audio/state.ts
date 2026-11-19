// The shared sound state both Pokemon windows write: master volume and one mute toggle per window. Pure, so the
// bun test can load it without a page. Page files cannot import, so it publishes on window.__peaLib.
type SoundWindow = 'battle' | 'summary';
type SoundState = { master: { volume: number }; windows: Record<string, { muted: boolean }> };

const SOUND_KEY = 'pokemon-emerald-sound:v1';
const SOUND_EVENT = 'pe-sound-change';
const DEFAULT_VOLUME = 0.35;
const DEFAULT_MUTED: Record<SoundWindow, boolean> = { battle: true, summary: false };

function isObj(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// a missing or broken field takes its default; unknown windows and keys pass through untouched
function cleanSound(raw: unknown): SoundState {
  const src = isObj(raw) ? raw : {};
  const volume = src.master?.volume;
  const windows: Record<string, { muted: boolean }> = {};
  for (const [name, value] of Object.entries(isObj(src.windows) ? src.windows : {})) {
    if (isObj(value)) windows[name] = { ...value, muted: typeof value.muted === 'boolean' ? value.muted : !!DEFAULT_MUTED[name as SoundWindow] };
  }
  for (const name of Object.keys(DEFAULT_MUTED) as SoundWindow[]) windows[name] ??= { muted: DEFAULT_MUTED[name] };
  return {
    ...src,
    master: { ...(isObj(src.master) ? src.master : {}), volume: typeof volume === 'number' && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_VOLUME },
    windows,
  };
}

function readSound(storage: { getItem(key: string): string | null } | null): SoundState {
  try {
    return cleanSound(JSON.parse(storage?.getItem(SOUND_KEY) ?? 'null'));
  } catch {
    return cleanSound(null);
  }
}

// master volume while the window is unmuted, 0 while it is muted
function gainFor(state: SoundState, win: string): number {
  return state.windows[win]?.muted ? 0 : state.master.volume;
}

const lib = ((window as any).__peaLib ??= {});
lib.state = { SOUND_KEY, SOUND_EVENT, DEFAULT_VOLUME, cleanSound, readSound, gainFor };
