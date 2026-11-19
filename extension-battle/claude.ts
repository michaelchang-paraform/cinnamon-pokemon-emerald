declare const cinnamon: { settings: { get(key: string): unknown; set(key: string, value: unknown): void } };
type ClaudeInfo = { available: boolean; reason: string; models: string[]; defaultModel: string };

const ns = (window as any).__pkb;
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const CLAUDE_LOOK = { cls: 'psychic', name: 'CLAUDE', palette: [] };
const CLAUDE_FALLBACK = 'CLAUDE is out. The CPU takes over.';
const CLAUDE_REASONS: Record<string, string> = {
  old_helper: 'Restart the battle helper to battle CLAUDE.',
  not_found: 'Claude Code was not found on this Mac.',
  version_failed: "Claude Code didn't start. Check it in Terminal.",
};

function parseClaude(welcome: Record<string, any> | null): ClaudeInfo {
  const raw = welcome?.claude;
  if (!raw || typeof raw !== 'object') return { available: false, reason: CLAUDE_REASONS.old_helper, models: CLAUDE_MODELS, defaultModel: 'haiku' };
  const models = Array.isArray(raw.models) ? raw.models.filter((m: unknown) => typeof m === 'string' && CLAUDE_MODELS.includes(m)) : CLAUDE_MODELS;
  const reason = CLAUDE_REASONS[String(raw.reason)] ?? "CLAUDE isn't available right now.";
  return { available: raw.available === true, reason, models: models.length ? models : CLAUDE_MODELS, defaultModel: CLAUDE_MODELS.includes(raw.defaultModel) ? raw.defaultModel : 'haiku' };
}

function claudeModel(info?: ClaudeInfo): string {
  const models = info?.models ?? CLAUDE_MODELS;
  const saved = String(cinnamon.settings.get('claudeModel') ?? '');
  return models.includes(saved) ? saved : models.includes('haiku') ? 'haiku' : models[0];
}

function cycleModel(info: ClaudeInfo): void {
  const models = info.models;
  const next = models[(models.indexOf(claudeModel(info)) + 1) % models.length];
  cinnamon.settings.set('claudeModel', next === 'haiku' ? null : next);
}

function claudeStats(stats: Record<string, any> | undefined): string {
  if (!stats || typeof stats !== 'object') return '';
  const cost = Number(stats.costUsd);
  const decisions = Number(stats.decisions);
  return `${Number.isFinite(cost) ? `${cost.toFixed(3)} USD` : '? USD'}  ${Number.isFinite(decisions) ? decisions : 0} MOVES${stats.handedOver ? '  CPU TOOK OVER' : ''}`;
}

function opponentMenu(app: any, info: ClaudeInfo): { items: any[]; hints: string[] } {
  const model = claudeModel(info).toUpperCase();
  return {
    items: [
      { label: 'CPU', pick: () => app.startCpu('smart', 'cpu') },
      {
        label: 'CLAUDE',
        disabled: !info.available,
        pick: () => {
          if (info.available) return app.startCpu('smart', 'claude');
          app.setNotice(info.reason);
          app.render();
        },
      },
      {
        label: `MODEL: ${model}`,
        pick: () => {
          cycleModel(info);
          app.render();
        },
      },
    ],
    hints: ['Battle the scripted CPU trainer.', info.available ? `CLAUDE (${model}) picks the foe's moves.` : info.reason, 'Pick the Claude model. Bigger models cost more.'],
  };
}

Object.assign(ns, { CLAUDE_LOOK, CLAUDE_FALLBACK, parseClaude, claudeModel, claudeStats, opponentMenu });
