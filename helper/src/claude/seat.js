'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { SmartAI } = require('../ai');
const { BattleView } = require('./prompt');
const { log } = require('../util');

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system.txt');
const OPPONENT_CWD = path.join(os.homedir(), '.pokemon-emerald', 'claude-opponent');
const MAX_FAILURES_IN_A_ROW = 3;
const MAX_STDOUT = 256 * 1024;

const ISOLATION_ENV = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

function ensureCwd() {
  fs.mkdirSync(OPPONENT_CWD, { recursive: true, mode: 0o700 });
  return OPPONENT_CWD;
}

function claudeArgs({ model, actionIds, runBudgetUsd }) {
  const schema = {
    type: 'object',
    properties: { action: { type: 'string', enum: actionIds } },
    required: ['action'],
    additionalProperties: false,
  };
  return [
    '-p',
    '--model', model,
    '--effort', 'low',
    '--safe-mode',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--disallowedTools', 'mcp__*',
    '--tools', '',
    '--disable-slash-commands',
    '--system-prompt-file', SYSTEM_PROMPT_FILE,
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--no-session-persistence',
    '--max-turns', '3',
    '--max-budget-usd', String(runBudgetUsd),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
  ];
}

/** Resolves { available, version, reason } from `claude --version`. */
function probeClaude(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) resolve({ available: false, version: null, reason: err.code === 'ENOENT' ? 'not_found' : 'version_failed' });
      else resolve({ available: true, version: String(stdout).trim().split(' ')[0], reason: null });
    });
  });
}

/**
 * CPU seat that asks an isolated `claude -p` for each p2 decision.
 * Sees only the p2 stream. Falls back to SmartAI on a bad reply (after one retry), timeout, error or budget.
 */
class ClaudeAI extends SmartAI {
  constructor({ side, format, write, model, bin, timeoutMs, runBudgetUsd, battleBudgetUsd, onThinking, onFallback, onDecision }) {
    super({ side, format, write, difficulty: 'smart' });
    this.view = new BattleView({ side, format });
    this.model = model;
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.runBudgetUsd = runBudgetUsd;
    this.battleBudgetUsd = battleBudgetUsd;
    this.onThinking = onThinking;
    this.onFallback = onFallback;
    this.onDecision = onDecision;
    this.children = new Set();
    this.token = 0;
    this.failures = 0;
    this.handedOver = false;
    this.disposed = false;
    this.stats = { decisions: 0, claudeDecisions: 0, fallbacks: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, latenciesMs: [] };
  }

  receiveLine(line) {
    this.view.feed(line);
    super.receiveLine(line);
  }

  receiveError(error) {
    log('[claude] simulator refused p2 choice', error.message);
    if (error.message.startsWith('[Invalid choice]')) this.choose('default');
  }

  receiveRequest(request) {
    if (request.wait || request.teamPreview || this.disposed) return super.receiveRequest(request);
    const token = ++this.token;
    this.stats.decisions += 1;
    if (this.handedOver) return super.receiveRequest(request);
    // the turn's log lines can arrive in the next chunk; let them reach the view first
    setImmediate(() => {
      if (token !== this.token || this.disposed) return;
      void this.decide(request, token);
    });
  }

  async decide(request, token) {
    const { text, actions } = this.view.build(request);
    const ids = actions.map((a) => a.id);
    if (!ids.length) return super.receiveRequest(request);
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    this.onThinking(true);
    let choice = null;
    let failure = null;
    for (let attempt = 0; attempt < 2 && !choice; attempt += 1) {
      const prompt = attempt === 0 ? text : `${text}\n\nYour last answer "${failure}" was not one of the legal actions. Answer with one of: ${ids.join(', ')}.`;
      const result = await this.run({ prompt, ids, deadline });
      if (token !== this.token || this.disposed) return;
      if (result.ok) choice = result.action;
      else failure = result.reason;
      if (result.timedOut) break;
    }
    this.onThinking(false);
    const ms = Date.now() - started;
    this.stats.latenciesMs.push(ms);
    if (choice) {
      this.failures = 0;
      this.stats.claudeDecisions += 1;
      this.onDecision({ ok: true, ms, action: choice });
      this.choose(choice);
      return;
    }
    this.failures += 1;
    this.stats.fallbacks += 1;
    this.onDecision({ ok: false, ms, reason: failure });
    if (this.failures >= MAX_FAILURES_IN_A_ROW) this.handOver('failures');
    super.receiveRequest(request);
  }

  handOver(reason) {
    if (this.handedOver) return;
    this.handedOver = true;
    this.onFallback(reason);
  }

  /** One claude -p run. Resolves { ok, action } or { ok: false, reason, timedOut }. */
  run({ prompt, ids, deadline }) {
    if (this.stats.costUsd >= this.battleBudgetUsd) {
      this.handOver('budget');
      return Promise.resolve({ ok: false, reason: 'budget' });
    }
    const left = deadline - Date.now();
    if (left <= 0) return Promise.resolve({ ok: false, reason: 'timeout', timedOut: true });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.bin, claudeArgs({ model: this.model, actionIds: ids, runBudgetUsd: this.runBudgetUsd }), {
          cwd: ensureCwd(),
          env: { ...process.env, ...ISOLATION_ENV },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch (err) {
        resolve({ ok: false, reason: `spawn: ${err.message}` });
        return;
      }
      this.children.add(child);
      let out = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        stopChild(child);
        finish({ ok: false, reason: 'timeout', timedOut: true });
      }, left);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        out += d;
        if (out.length > MAX_STDOUT) stopChild(child);
      });
      child.stdin.on('error', () => {});
      child.on('error', (err) => finish({ ok: false, reason: `spawn: ${err.message}` }));
      child.on('close', (code) => {
        this.children.delete(child);
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {
          json = null;
        }
        if (json) this.account(json);
        const action = json && json.structured_output && json.structured_output.action;
        if (code === 0 && typeof action === 'string' && ids.includes(action)) finish({ ok: true, action });
        else finish({ ok: false, reason: typeof action === 'string' ? action.slice(0, 40) : `exit ${code}${json && json.subtype ? ` ${json.subtype}` : ''}` });
      });
      child.stdin.end(prompt);
    });
  }

  account(json) {
    if (typeof json.total_cost_usd === 'number') this.stats.costUsd += json.total_cost_usd;
    const usage = json.usage || {};
    this.stats.inputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    this.stats.cacheTokens += usage.cache_read_input_tokens || 0;
    this.stats.outputTokens += usage.output_tokens || 0;
  }

  dispose() {
    this.disposed = true;
    this.token += 1;
    for (const child of this.children) stopChild(child);
    this.children.clear();
  }

  summary() {
    const lat = [...this.stats.latenciesMs].sort((a, b) => a - b);
    const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    return {
      model: this.model,
      decisions: this.stats.decisions,
      claudeDecisions: this.stats.claudeDecisions,
      fallbacks: this.stats.fallbacks,
      handedOver: this.handedOver,
      costUsd: Math.round(this.stats.costUsd * 1e6) / 1e6,
      inputTokens: this.stats.inputTokens,
      cacheReadTokens: this.stats.cacheTokens,
      outputTokens: this.stats.outputTokens,
      medianMs: median,
      maxMs: lat.length ? lat[lat.length - 1] : null,
      latenciesMs: [...this.stats.latenciesMs],
    };
  }
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGINT');
  } catch {
    return;
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2000).unref();
  }, 1000).unref();
}

module.exports = { ClaudeAI, MODELS, probeClaude, OPPONENT_CWD };
