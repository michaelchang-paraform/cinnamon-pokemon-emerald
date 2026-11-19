'use strict';

// Plays one real CPU battle against Claude (costs money). Usage: node test/claude-live.js [model]
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 41957;
const model = process.argv[2] || 'haiku';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(process.execPath, ['--max-old-space-size=512', path.join(__dirname, '..', 'src/server.js'), '--no-lan', '--service-type', 'pkmn-emrld-test',
    '--port', String(PORT), '--claude-battle-budget', '0.05'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const stop = () => child.exitCode === null && child.kill('SIGINT');
  process.on('exit', stop);
  for (let i = 0; i < 50; i += 1) {
    const ok = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/health', agent: false }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false)));
    if (ok) break;
    await sleep(200);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on('open', r));
  let seed = 4242;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const end = await new Promise((resolve) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data);
      if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'start_cpu', opponent: 'claude', model }));
      if (m.type === 'opponent_fallback') console.log('fallback', m.reason);
      if (m.type === 'request' && !m.request.wait) {
        const r = m.request;
        const bench = r.side.pokemon.map((p, i) => ({ p, slot: i + 1 })).filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
        let choice = 'default';
        if (r.forceSwitch) choice = bench.length ? `switch ${bench[0].slot}` : 'default';
        else {
          const usable = r.active[0].moves.map((mv, i) => ({ mv, slot: i + 1 })).filter(({ mv }) => !mv.disabled && mv.pp > 0);
          if (usable.length) choice = `move ${usable[Math.floor(rng() * usable.length)].slot}`;
        }
        ws.send(JSON.stringify({ type: 'choose', battleId: m.battleId, choice, rqid: m.rqid }));
      }
      if (m.type === 'battle_end') resolve(m);
    });
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, name: 'Tester' }));
  });
  console.log('RESULT', JSON.stringify({ result: end.result, reason: end.reason, turns: end.turns, stats: end.opponentStats }));
  ws.close();
  stop();
  await sleep(1500);
  process.exit(0);
})();
