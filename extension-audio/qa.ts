// QA only, inert until settings.qaRun changes: clicks the partners summary's own controls, then saves what
// __peAudio was asked to play (id, window, gain) to settings.qaResult, so a check outside the page can read it in
// config.json. It restores the summary's mute state and closes the summary again if it opened it.
declare const cinnamon: {
  settings: { get(key: string): unknown; set(key: string, value: unknown): void; onChange(fn: (s: Record<string, unknown>) => void): void };
  onDispose(fn: () => void): void;
};

let qaLast = cinnamon.settings.get('qaRun');
let qaDisposed = false;
cinnamon.onDispose(() => {
  qaDisposed = true;
});

const qaWait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
async function qaUntil<T>(fn: () => T | null | undefined, ms = 4000): Promise<T | null> {
  for (let t = 0; t < ms; t += 50) {
    const value = fn();
    if (value) return value;
    await qaWait(50);
  }
  return null;
}

async function qaRun(nonce: string): Promise<void> {
  const audio = (window as any).__peAudio;
  const lib = (window as any).__peaLib;
  const result: Record<string, unknown> = { nonce, at: new Date().toISOString(), steps: [] as unknown[] };
  const steps = result.steps as unknown[];
  try {
    if (!audio) throw new Error('__peAudio missing');
    await audio.ready;
    result.ids = audio.ids();
    const seen = new Set(audio.log);
    const step = async (name: string, act: () => void) => {
      act();
      await qaWait(700);
      const calls = audio.log.filter((r: unknown) => !seen.has(r)).map((r: any) => ({ id: r.id, species: r.species, window: r.window, gain: r.gain, played: r.played, ctx: r.ctx }));
      audio.log.forEach((r: unknown) => seen.add(r));
      steps.push({ name, calls, summaryGain: audio.gain('summary'), nodeGain: audio.nodeGain('summary'), context: audio.contextState() });
    };
    const popup = () => document.querySelector('.pkp-popup');
    const tab = (label: string) => popup()?.querySelector<HTMLElement>(`.pkp-gba-hit[aria-label="${label}"]`);
    const muted = () => !!lib.state.readSound(localStorage).windows.summary?.muted;
    const mute = () => popup()?.querySelector<HTMLElement>('.pkp-sound-mute')?.click();
    let opened = false;
    if (!popup()) {
      const icon = document.querySelector<HTMLElement>('.pkp-ri, .pkp-ht, .pkp-av');
      if (!icon) throw new Error('no partner icon on the page');
      await step('click a partner icon (opens the summary)', () => icon.click());
      opened = true;
    }
    if (!(await qaUntil(() => tab('POKéMON SKILLS')))) throw new Error('summary tabs did not render');
    const summary = (window as any).__pkp?.summary;
    const idle = () => qaUntil(() => !summary?.animating, 8000);
    const sprite = () => popup()?.querySelector<HTMLElement>('.pkp-gba-sprite');
    result.species = (window as any).__pkp?.mon?.(summary?.key)?.species ?? null;
    await idle();
    const startMuted = muted();
    result.startMuted = startMuted;
    if (startMuted) mute();
    await step('click the POKéMON SKILLS tab', () => tab('POKéMON SKILLS')?.click());
    await step('click the POKéMON SKILLS tab again (same page)', () => tab('POKéMON SKILLS')?.click());
    mute();
    await qaWait(200);
    result.mutedForStep = muted();
    await step('click the BATTLE MOVES tab while muted', () => tab('BATTLE MOVES')?.click());
    await step('click the POKéMON INFO tab while muted', () => tab('POKéMON INFO')?.click());
    if (await qaUntil(() => sprite())) {
      await idle();
      await step('click the sprite while muted', () => sprite()?.click());
      await idle();
    }
    if (muted() !== startMuted) mute();
    await qaWait(200);
    await step('click the POKéMON SKILLS tab after restoring mute', () => tab('POKéMON SKILLS')?.click());
    await step('click the POKéMON INFO tab', () => tab('POKéMON INFO')?.click());
    if (await qaUntil(() => sprite())) {
      await step('click the sprite', () => sprite()?.click());
      await step('click the sprite again during its animation', () => sprite()?.click());
      await idle();
    }
    result.endMuted = muted();
    if (opened) await step('click the close button', () => popup()?.querySelector<HTMLElement>('.pkp-popup-close')?.click());
  } catch (error) {
    result.error = String(error);
  }
  if (!qaDisposed) cinnamon.settings.set('qaResult', result);
}

// "music-..." nonces: render the battle tracks in the page (no sound), record the time, the kept length and the
// pe-music-state events of a start in a muted window, then free them
async function qaMusic(nonce: string): Promise<void> {
  const audio = (window as any).__peAudio;
  const result: Record<string, unknown> = { nonce, at: new Date().toISOString() };
  const events: unknown[] = [];
  const onEvent = (e: Event) => events.push((e as CustomEvent).detail);
  window.addEventListener('pe-music-state', onEvent);
  try {
    await audio.ready;
    for (const id of ['MUS_VS_TRAINER', 'MUS_VICTORY_TRAINER', 'MUS_LEVEL_UP']) {
      const t0 = performance.now();
      await audio.prepareMusic(id);
      result[id] = { renderMs: Math.round(performance.now() - t0) };
    }
    result.musicState = audio.musicState('battle');
    result.battleGain = audio.gain('battle');
  } catch (error) {
    result.error = String(error);
  }
  window.removeEventListener('pe-music-state', onEvent);
  result.events = events;
  audio?.stopMusic({ window: 'summary', free: true });
  if (!qaDisposed) cinnamon.settings.set('qaResult', result);
}

cinnamon.settings.onChange((settings) => {
  const nonce = settings.qaRun;
  if (!nonce || nonce === qaLast || qaDisposed) return;
  qaLast = nonce;
  if (String(nonce).startsWith('music')) void qaMusic(String(nonce));
  else void qaRun(String(nonce));
});
