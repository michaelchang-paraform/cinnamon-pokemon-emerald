'use strict';

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const children = [];
const TEST_SERVICE = 'pkmn-emrld-test';
const results = [];
const fakeServers = [];

function startHelper(name, args, extraEnv = {}) {
  const child = spawn(process.execPath, ['--max-old-space-size=512', path.join(ROOT, 'src/server.js'), '--service-type', TEST_SERVICE, ...args], {
    env: { ...process.env, ...extraEnv, PKMN_QUIET: process.env.PKMN_VERBOSE ? '0' : '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.PKMN_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name} err] ${d}`));
  children.push(child);
  return child;
}

function killAll() {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }).on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`helper on ${port} did not start`);
}

/** Page client: records every message, offers waitFor(predicate). */
class Client {
  constructor(port, { origin } = {}) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { headers: { Origin: origin } } : {});
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
      if (this.onMessage) this.onMessage(msg);
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (req, res) => reject(new Error(`http ${res.statusCode}`)));
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred, timeoutMs = 20000, label = 'message') {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs) };
      this.waiters.push(w);
    });
  }

  close() {
    this.ws.close();
  }
}

function pickChoice(request, rng) {
  if (request.wait) return null;
  const mons = request.side.pokemon;
  const benched = mons.map((p, i) => ({ p, slot: i + 1 })).filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
  if (request.forceSwitch) return benched.length ? `switch ${benched[0].slot}` : 'default';
  if (request.teamPreview) return 'default';
  const active = request.active && request.active[0];
  if (!active) return 'default';
  if (!active.trapped && benched.length && rng() < 0.1) return `switch ${benched[Math.floor(rng() * benched.length)].slot}`;
  const usable = active.moves.map((m, i) => ({ m, slot: i + 1 })).filter(({ m }) => !m.disabled && (m.pp === undefined || m.pp > 0));
  if (!usable.length) return 'default';
  return `move ${usable[Math.floor(rng() * usable.length)].slot}`;
}

function autoPlay(client, label) {
  let seed = label.length * 7919;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let lastRequest = null;
  client.onMessage = (msg) => {
    if (msg.type === 'request') {
      lastRequest = msg;
      const choice = pickChoice(msg.request, rng);
      if (choice) client.send({ type: 'choose', battleId: msg.battleId, choice, rqid: msg.rqid });
    } else if (msg.type === 'choice_error' && lastRequest) {
      client.send({ type: 'choose', battleId: lastRequest.battleId, choice: 'default' });
    }
  };
}

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function testCpu() {
  startHelper('cpu', ['--no-lan', '--port', '41951', '--name', 'Tester']);
  await waitForHealth(41951);

  const evil = new Client(41951, { origin: 'https://evil.example' });
  const evilResult = await evil.open().then(() => 'opened', (e) => e.message);
  check('page api rejects foreign Origin', evilResult === 'http 403', evilResult);

  const c = new Client(41951, { origin: 'https://claude.ai' });
  await c.open();
  c.send({ type: 'start_cpu' });
  await c.waitFor((m) => m.type === 'error' && m.code === 'hello_first', 5000, 'hello_first error');
  c.send({ type: 'hello', protocol: 1, name: 'Ash<script>\u0000' });
  const welcome = await c.waitFor((m) => m.type === 'welcome', 5000, 'welcome');
  check('trainer name sanitized', welcome.trainer.name === 'Ashscript', welcome.trainer.name);
  c.send({ type: 'choose', battleId: 'x', choice: 'move 1\n>eval process.exit()' });
  await c.waitFor((m) => m.type === 'error' && m.re === 'choose', 5000, 'choose error');
  check('rejects choose outside battle / injected choice', true);

  autoPlay(c, 'cpu-player');
  c.send({ type: 'start_cpu', difficulty: 'smart' });
  const start = await c.waitFor((m) => m.type === 'battle_start', 5000, 'battle_start');
  const end = await c.waitFor((m) => m.type === 'battle_end', 180000, 'cpu battle_end');
  check('cpu battle plays to completion', ['win', 'loss'].includes(end.result) && end.turns > 0, `${end.result} (${end.reason}) in ${end.turns} turns vs ${start.opponent.name}, format ${start.format}`);
  const cpuBalls = collectBalls(c.messages);
  check('cpu: every Pokemon has one stable ball, every switch carries it', cpuBalls.seen.size >= 7 && cpuBalls.conflicts.length === 0 && cpuBalls.bad === 0 && cpuBalls.missing === 0, `${cpuBalls.seen.size} Pokemon, ${cpuBalls.conflicts.length} conflicts, ${cpuBalls.missing} switches without a ball`);
  const requests = c.messages.filter((m) => m.type === 'request');
  check('cpu: page only gets its own side requests', requests.length > 0 && requests.every((r) => r.request.side.id === 'p1'), `${requests.length} requests`);

  c.onMessage = null;
  c.messages.length = 0;
  c.send({ type: 'start_cpu', difficulty: 'random' });
  const start2 = await c.waitFor((m) => m.type === 'battle_start', 5000, 'battle_start 2');
  await c.waitFor((m) => m.type === 'request', 5000, 'first request');
  c.close();
  const c2 = new Client(41951);
  await c2.open();
  c2.send({ type: 'hello', protocol: 1 });
  const resumed = await c2.waitFor((m) => m.type === 'battle_start' && m.resumed, 5000, 'resumed battle_start');
  const replay = await c2.waitFor((m) => m.type === 'battle' && m.lines.some((l) => l.startsWith('|switch|')), 5000, 'replayed log');
  await c2.waitFor((m) => m.type === 'request', 5000, 'replayed request');
  check('page reconnect resumes battle with log and request', resumed.battleId === start2.battleId && replay.lines.length > 0);
  check('replayed log carries the balls', !!replay.balls && Object.keys(replay.balls).length >= 2, JSON.stringify(replay.balls));
  c2.send({ type: 'choose', battleId: start2.battleId, choice: 'move 1', rqid: 99999 });
  const stale = await c2.waitFor((m) => m.type === 'error' && m.re === 'choose', 5000, 'stale error');
  check('stale rqid is rejected', stale.code === 'stale_request', stale.code);
  c2.send({ type: 'forfeit', battleId: start2.battleId });
  const fend = await c2.waitFor((m) => m.type === 'battle_end', 5000, 'forfeit end');
  check('forfeit ends cpu battle as loss', fend.result === 'loss' && fend.reason === 'forfeit', `${fend.result}/${fend.reason}`);
  c2.close();

  startHelper('cpu-timer', ['--no-lan', '--port', '41952', '--cpu-timer', '3']);
  await waitForHealth(41952);
  const t = new Client(41952);
  await t.open();
  t.send({ type: 'hello', protocol: 1 });
  t.send({ type: 'start_cpu' });
  const timerMsg = await t.waitFor((m) => m.type === 'timer' && m.forYou, 5000, 'timer message');
  const tend = await t.waitFor((m) => m.type === 'battle_end', 10000, 'timeout end');
  check('turn timer forfeits an idle player', tend.result === 'loss' && tend.reason === 'timeout', `timer ${timerMsg.secondsLeft}s, ${tend.result}/${tend.reason}`);
  t.close();
  return end.turns;
}

function exactHpLeaks(messages, foeSide) {
  const leaks = [];
  for (const m of messages) {
    if (m.type !== 'battle') continue;
    for (const line of m.lines) {
      const parts = line.split('|');
      const cmd = parts[1];
      let ident;
      let hp;
      if (['switch', 'drag', 'replace'].includes(cmd)) [ident, hp] = [parts[2], parts[4]];
      else if (['-damage', '-heal', '-sethp'].includes(cmd)) [ident, hp] = [parts[2], parts[3]];
      else continue;
      if (!ident || !ident.startsWith(foeSide) || !hp) continue;
      const match = /^\d+\/(\d+)/.exec(hp);
      if (match && match[1] !== '100') leaks.push(line);
    }
  }
  return leaks;
}

function fakePeer(port, handler) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const body = handler(hits);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  server.listen(port, '127.0.0.1');
  fakeServers.push(server);
  return { hits: () => hits };
}

async function latestLobby(client) {
  client.messages.length = 0;
  client.send({ type: 'lobby_refresh' });
  return client.waitFor((m) => m.type === 'lobby', 5000, 'lobby');
}

async function testHostilePeers(a, bobEntry) {
  const huge = JSON.stringify({ id: 'b16b16b16b16', name: 'Bigby', status: 'looking', v: 1, ns: TEST_SERVICE, pad: 'x'.repeat(10000) });
  const big = fakePeer(41982, (n) => (n <= 2 ? huge : JSON.stringify({ id: 'b16b16b16b16', name: 'Bigby', status: 'looking', v: 1, ns: TEST_SERVICE })));
  a.send({ type: 'add_peer', host: '127.0.0.1', port: 41982 });
  for (let i = 0; i < 4; i += 1) {
    await sleep(300);
    a.send({ type: 'lobby_refresh' });
  }
  const bigSeen = await a.waitFor((m) => m.type === 'lobby' && m.peers.some((p) => p.name === 'Bigby'), 15000, 'Bigby after oversized answers').then(() => true, () => false);
  check('oversized /info answer does not wedge probing', bigSeen, `${big.hits()} probes`);

  const ghost = fakePeer(41981, () => JSON.stringify({ id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), name: 'Ghost', status: 'idle', v: 1, ns: TEST_SERVICE }));
  a.send({ type: 'add_peer', host: '127.0.0.1', port: 41981 });
  for (let i = 0; i < 40; i += 1) {
    await sleep(60);
    a.send({ type: 'lobby_refresh' });
  }
  await sleep(500);
  const lobby = await latestLobby(a);
  const ghosts = lobby.peers.filter((p) => p.address === '127.0.0.1:41981').length;
  check('a host that changes id leaves one lobby entry, not one per id', ghosts <= 1 && lobby.peers.length <= 4, `${ghost.hits()} probes, ${ghosts} entries, ${lobby.peers.length} peers total`);

  fakePeer(41983, () => JSON.stringify({ id: bobEntry.id, name: 'Thief', status: 'looking', v: 1, ns: TEST_SERVICE }));
  a.send({ type: 'add_peer', host: '127.0.0.1', port: 41983 });
  for (let i = 0; i < 5; i += 1) {
    await sleep(200);
    a.send({ type: 'lobby_refresh' });
  }
  await sleep(500);
  const after = await latestLobby(a);
  const bob = after.peers.find((p) => p.id === bobEntry.id);
  fakePeer(41984, () => JSON.stringify({ id: 'c0ffee0c0ffe', name: 'Prod', status: 'looking', v: 1 }));
  a.send({ type: 'add_peer', host: '127.0.0.1', port: 41984 });
  for (let i = 0; i < 4; i += 1) {
    await sleep(200);
    a.send({ type: 'lobby_refresh' });
  }
  await sleep(500);
  const nsLobby = await latestLobby(a);
  check('a helper on another service type stays out of the lobby', !nsLobby.peers.some((p) => p.name === 'Prod'), nsLobby.peers.map((p) => p.name).join(', '));
  check('a device cannot steal a live peer id', bob && bob.name === 'Bob' && bob.address === bobEntry.address, bob ? `${bob.name} at ${bob.address}` : 'Bob missing');
}

async function testLan() {
  startHelper('A', ['--port', '41961', '--lan-port', '41962', '--name', 'Alice']);
  startHelper('B', ['--port', '41971', '--lan-port', '41972', '--name', 'Bob', '--challenge-cooldown', '3']);
  await Promise.all([waitForHealth(41961), waitForHealth(41971)]);

  const lanInfo = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 41972, path: '/info', agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', (e) => resolve({ error: e.message }));
  });
  check('lan /info answers', lanInfo.name === 'Bob' && lanInfo.v === 1, JSON.stringify(lanInfo));

  const junk = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:41972/battle');
    ws.on('open', () => ws.send('not json at all'));
    ws.on('close', (code) => resolve(`closed ${code}`));
    ws.on('error', (e) => resolve(`error ${e.message}`));
    setTimeout(() => resolve('still open'), 4000);
  });
  check('lan port drops malformed peer message', junk.startsWith('closed'), junk);

  const a = new Client(41961);
  const b = new Client(41971);
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', protocol: 1, name: 'Alice', trainer: { cls: 7, name: 'Alice', palette: ['#FF0000', null, 'nope'] } });
  b.send({ type: 'hello', protocol: 1, name: 'Bob', trainer: { cls: 99 } });
  const [wa, wb] = await Promise.all([a.waitFor((m) => m.type === 'welcome'), b.waitFor((m) => m.type === 'welcome')]);
  check('hello trainer look is validated', wa.trainer.cls === 7 && JSON.stringify(wa.trainer.palette) === '["#ff0000",null,null]' && wb.trainer.cls === 0 && wb.trainer.palette === null, JSON.stringify([wa.trainer, wb.trainer]));
  a.send({ type: 'seek', looking: true });
  b.send({ type: 'seek', looking: true });

  const t0 = Date.now();
  let bobEntry = null;
  try {
    const lobby = await a.waitFor((m) => m.type === 'lobby' && m.peers.some((p) => p.name === 'Bob' && p.status === 'looking'), 20000, 'Bob in lobby via mDNS');
    bobEntry = lobby.peers.find((p) => p.name === 'Bob');
    check('mDNS discovery finds the other helper', true, `${((Date.now() - t0) / 1000).toFixed(1)}s, ${bobEntry.address}, status ${bobEntry.status}`);
  } catch (err) {
    check('mDNS discovery finds the other helper', false, err.message + ' (falling back to add_peer)');
    a.send({ type: 'add_peer', host: '127.0.0.1', port: 41972 });
    const lobby = await a.waitFor((m) => m.type === 'lobby' && m.peers.some((p) => p.name === 'Bob'), 15000, 'Bob via manual add');
    bobEntry = lobby.peers.find((p) => p.name === 'Bob');
  }
  const aliceSeenByBob = await b.waitFor((m) => m.type === 'lobby' && m.peers.some((p) => p.name === 'Alice'), 20000, 'Alice in Bob lobby').then(() => true, () => false);
  check('discovery works both ways', aliceSeenByBob);
  const bobLobby = await latestLobby(b);
  const aliceInLobby = bobLobby.peers.find((p) => p.name === 'Alice');
  check('lobby carries the peer trainer look', aliceInLobby && aliceInLobby.trainer.cls === 7 && aliceInLobby.trainer.palette[0] === '#ff0000' && bobEntry.trainer.cls === 0, JSON.stringify(aliceInLobby && aliceInLobby.trainer));

  autoPlay(a, 'alice');
  autoPlay(b, 'bob-the-trainer');
  a.send({ type: 'challenge', peerId: bobEntry.id });
  const received = await b.waitFor((m) => m.type === 'challenge_received' && m.from.name === 'Alice', 10000, 'challenge_received');
  check('challenge reaches the other trainer', received.from.name === 'Alice' && received.format === 'gen3randombattle' && received.from.trainer.cls === 7);
  b.send({ type: 'respond_challenge', challengeId: received.challengeId, accept: true });
  const [sa, sb] = await Promise.all([a.waitFor((m) => m.type === 'battle_start', 10000, 'A start'), b.waitFor((m) => m.type === 'battle_start', 10000, 'B start')]);
  check('both sides get battle_start', sa.battleId === sb.battleId && sa.side === 'p1' && sb.side === 'p2', `A=${sa.side} B=${sb.side}`);
  check('battle_start carries both trainer looks', sb.opponent.cls === 7 && sb.you.cls === 0 && sa.opponent.cls === 0 && sa.you.cls === 7, `A sees ${sa.opponent.cls}, B sees ${sb.opponent.cls}`);
  const [ea, eb] = await Promise.all([a.waitFor((m) => m.type === 'battle_end', 300000, 'A end'), b.waitFor((m) => m.type === 'battle_end', 300000, 'B end')]);
  const opposite = (ea.result === 'win' && eb.result === 'loss') || (ea.result === 'loss' && eb.result === 'win') || (ea.result === 'tie' && eb.result === 'tie');
  check('pvp battle plays to completion with consistent results', opposite && ea.turns === eb.turns && ea.turns > 0, `Alice ${ea.result}, Bob ${eb.result}, ${ea.turns} turns`);

  const aReq = a.messages.filter((m) => m.type === 'request');
  const bReq = b.messages.filter((m) => m.type === 'request');
  check('A only ever receives p1 requests', aReq.length > 0 && aReq.every((r) => r.request.side.id === 'p1'), `${aReq.length} requests`);
  check('B only ever receives p2 requests', bReq.length > 0 && bReq.every((r) => r.request.side.id === 'p2'), `${bReq.length} requests`);
  const aText = JSON.stringify(a.messages);
  const bTeamSecrets = new Set();
  for (const r of bReq) for (const p of r.request.side.pokemon) bTeamSecrets.add(JSON.stringify(p.stats));
  const aOwn = new Set();
  for (const r of aReq) for (const p of r.request.side.pokemon) aOwn.add(JSON.stringify(p.stats));
  const leakedStats = [...bTeamSecrets].filter((s) => aText.includes(s) && !aOwn.has(s));
  const shared = [...bTeamSecrets].filter((s) => aOwn.has(s)).length;
  check('A never sees B stat blocks', leakedStats.length === 0, `${bTeamSecrets.size} B stat blocks checked${shared ? `, ${shared} identical to one of A's own mons (skipped)` : ''}`);
  const aBalls = collectBalls(a.messages);
  const bBalls = collectBalls(b.messages);
  const sharedBalls = [...aBalls.seen.keys()].filter((k) => bBalls.seen.has(k));
  const disagree = sharedBalls.filter((k) => aBalls.seen.get(k) !== bBalls.seen.get(k));
  check('lan: both screens show the same ball for every Pokemon', sharedBalls.length >= 7 && disagree.length === 0 && aBalls.conflicts.length + bBalls.conflicts.length === 0 && aBalls.missing + bBalls.missing === 0 && aBalls.bad + bBalls.bad === 0, `${sharedBalls.length} shared, ${disagree.length} disagree`);
  check('A never sees B exact HP', exactHpLeaks(a.messages, 'p2').length === 0);
  check('B never sees A exact HP', exactHpLeaks(b.messages, 'p1').length === 0);
  const lastLines = (c) => c.messages.filter((m) => m.type === 'battle').flatMap((m) => m.lines);
  check('both sides receive the final |win| line before battle_end', [a, b].every((c) => {
    const endIdx = c.messages.findIndex((m) => m.type === 'battle_end');
    return c.messages.slice(0, endIdx).some((m) => m.type === 'battle' && m.lines.some((l) => l.startsWith('|win|') || l === '|tie'));
  }), `A last: ${lastLines(a).slice(-1)[0]}, B last: ${lastLines(b).slice(-1)[0]}`);
  check('no raw |request| lines in the battle log', ![...a.messages, ...b.messages].some((m) => m.type === 'battle' && m.lines.some((l) => l.startsWith('|request|'))));

  a.onMessage = null;
  b.onMessage = null;
  a.messages.length = 0;
  b.messages.length = 0;
  await sleep(1500);
  await a.waitFor((m) => m.type === 'lobby' && m.peers.some((p) => p.name === 'Bob' && p.status !== 'battling'), 15000, 'Bob idle again').catch(() => null);
  a.send({ type: 'challenge', peerId: bobEntry.id });
  const r2 = await b.waitFor((m) => m.type === 'challenge_received' && m.from.name === 'Alice', 10000, 'challenge 2');
  b.send({ type: 'respond_challenge', challengeId: r2.challengeId, accept: false });
  const declined = await a.waitFor((m) => m.type === 'challenge_update' && m.challengeId !== null && m.state === 'declined', 10000, 'declined');
  check('decline flows back to challenger', !!declined);
  a.messages.length = 0;
  a.send({ type: 'challenge', peerId: bobEntry.id });
  const cool = await a.waitFor((m) => m.type === 'challenge_update' && m.challengeId !== null && m.state !== 'accepted', 10000, 'cooldown reply');
  check('repeat challenge right after a decline is throttled', cool.state === 'declined' && cool.reason === 'cooldown', `${cool.state}/${cool.reason}`);
  await sleep(3500);

  await testHostilePeers(a, bobEntry);

  const idle = await new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket('ws://127.0.0.1:41972/battle');
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, id: 'abcdef123456', name: 'Lurker' })));
    ws.on('close', () => resolve(`closed after ${((Date.now() - started) / 1000).toFixed(1)}s`));
    ws.on('error', () => {});
    setTimeout(() => resolve('still open'), 15000);
  });
  check('idle inbound link is closed', idle.startsWith('closed'), idle);

  a.messages.length = 0;
  b.messages.length = 0;
  a.send({ type: 'challenge', peerId: bobEntry.id });
  const r3 = await b.waitFor((m) => m.type === 'challenge_received' && m.from.name === 'Alice', 10000, 'challenge 3');
  b.send({ type: 'respond_challenge', challengeId: r3.challengeId, accept: true });
  await a.waitFor((m) => m.type === 'request', 10000, 'A first request (vanish test)');
  const bChild = children[children.length - 1];
  const killedAt = Date.now();
  bChild.kill('SIGKILL');
  const vanish = await a.waitFor((m) => m.type === 'battle_end', 30000, 'end after peer vanished');
  check('peer vanishing mid-battle ends the battle', vanish.result === 'win' && vanish.reason === 'opponent_disconnected', `${vanish.result}/${vanish.reason} after ${((Date.now() - killedAt) / 1000).toFixed(1)}s`);
  a.close();
  b.close();
  return ea.turns;
}

const { pickBall, BALLS } = require('../src/battle');

function testBallWeights() {
  const counts = Object.fromEntries(BALLS.map((b) => [b, 0]));
  for (let i = 0; i < 20000; i += 1) counts[pickBall()] += 1;
  const masterPct = (counts.master / 200).toFixed(2);
  check('ball weights: all 12 balls, Poke most common, Master about 1%', BALLS.length === 12 && BALLS.every((b) => counts[b] > 0) && counts.poke === Math.max(...Object.values(counts)) && counts.master > 100 && counts.master < 320, `master ${masterPct}%, poke ${(counts.poke / 200).toFixed(1)}%`);
}

/** Every ball the page saw: from its own requests and from switch envelopes. Conflicts are a different ball for one ident. */
function collectBalls(messages) {
  const seen = new Map();
  const conflicts = [];
  let bad = 0;
  let missing = 0;
  const note = (ident, ball) => {
    if (!BALLS.includes(ball)) bad += 1;
    if (seen.has(ident) && seen.get(ident) !== ball) conflicts.push(ident);
    seen.set(ident, ball);
  };
  for (const m of messages) {
    if (m.type === 'request' && m.request.side) for (const p of m.request.side.pokemon) note(p.ident, p.ball);
    if (m.type === 'battle') {
      for (const [ident, ball] of Object.entries(m.balls || {})) note(ident, ball);
      for (const line of m.lines) {
        const parts = line.split('|');
        if (!['switch', 'drag', 'replace'].includes(parts[1])) continue;
        const ident = parts[2].replace(/^(p[12])[a-z]?: /, '$1: ');
        if (!m.balls || !m.balls[ident]) missing += 1;
      }
    }
  }
  return { seen, conflicts, bad, missing };
}

function testDnsSdCaps() {
  const { DnsSdDiscovery } = require('../src/dnssd');
  const d = new DnsSdDiscovery({ instance: 'pkmn-self00', type: 'pkmn-emerald', port: 1, txt: {} });
  let spawned = 0;
  d.resolve = (name) => {
    spawned += 1;
    void name;
  };
  for (let i = 0; i < 1000; i += 1) d.onBrowseLine(` 1:00:00.000  Add  3  15 local.  _pkmn-emerald._tcp.  pkmn-${String(i).padStart(8, '0')}`);
  for (let i = 0; i < 1000; i += 1) d.onBrowseLine(' 1:00:00.000  Add  3  15 local.  _pkmn-emerald._tcp.  pkmn-00000001');
  check('dns-sd resolves are capped and deduplicated', spawned === 4 && d.queue.length <= 64, `${spawned} resolves started, ${d.queue.length} queued of 2000 Add lines`);
  d.stop();
}

const FAKE = path.join(__dirname, 'fake-claude.js');

function stateDirWith(spend) {
  const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'pkmn-state-'));
  if (spend !== undefined) require('fs').writeFileSync(path.join(dir, 'claude-spend.json'), JSON.stringify({ day: require('../src/claude/spend').localDay(), usd: spend }));
  return dir;
}

async function claudeStubBattle({ port, mode, extra = [], forfeitAfterFallback = false, stateDir = stateDirWith() }) {
  const dump = path.join(require('os').tmpdir(), `pkmn-fake-claude-${process.pid}-${mode}.txt`);
  try {
    require('fs').unlinkSync(dump);
  } catch {
    // none yet
  }
  startHelper(`claude-${mode}`, ['--no-lan', '--port', String(port), '--claude-bin', FAKE, ...extra], { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_DUMP: dump, PKMN_STATE_DIR: stateDir });
  await waitForHealth(port);
  const c = new Client(port, { origin: 'https://claude.ai' });
  await c.open();
  c.send({ type: 'hello', protocol: 1 });
  const welcome = await c.waitFor((m) => m.type === 'welcome', 5000, 'welcome');
  autoPlay(c, `stub-${mode}`);
  c.send({ type: 'start_cpu', opponent: 'claude', model: 'haiku' });
  const start = await c.waitFor((m) => m.type === 'battle_start', 5000, 'claude battle_start');
  if (forfeitAfterFallback) {
    const fb = await c.waitFor((m) => m.type === 'opponent_fallback', 60000, 'opponent_fallback');
    c.send({ type: 'forfeit', battleId: start.battleId });
    void fb;
  }
  const end = await c.waitFor((m) => m.type === 'battle_end', 240000, `${mode} battle_end`);
  c.close();
  let prompts = '';
  try {
    prompts = require('fs').readFileSync(dump, 'utf8');
    require('fs').unlinkSync(dump);
  } catch {
    // no prompt written
  }
  let spend = null;
  try {
    spend = JSON.parse(require('fs').readFileSync(path.join(stateDir, 'claude-spend.json'), 'utf8'));
  } catch {
    // no spend written
  }
  require('fs').rmSync(stateDir, { recursive: true, force: true });
  return { welcome, start, end, messages: c.messages, prompts, spend };
}

async function testClaudeStub() {
  const originCheck = (async () => {
    startHelper('claude-origin', ['--no-lan', '--port', '41958', '--claude-bin', FAKE], { PKMN_STATE_DIR: stateDirWith() });
    await waitForHealth(41958);
    const c = new Client(41958);
    await c.open();
    c.send({ type: 'hello', protocol: 1 });
    c.send({ type: 'start_cpu', opponent: 'claude' });
    const err = await c.waitFor((m) => m.type === 'error' && m.re === 'start_cpu', 5000, 'claude_origin error');
    c.send({ type: 'start_cpu' });
    const cpuStart = await c.waitFor((m) => m.type === 'battle_start', 5000, 'no-origin cpu start');
    c.send({ type: 'forfeit', battleId: cpuStart.battleId });
    await c.waitFor((m) => m.type === 'battle_end', 5000, 'no-origin cpu end');
    c.close();
    return { err, cpuStart };
  })();
  const [legal, retry, illegal, sleepy, daily, origin] = await Promise.all([
    claudeStubBattle({ port: 41953, mode: 'legal' }),
    claudeStubBattle({ port: 41954, mode: 'retry' }),
    claudeStubBattle({ port: 41955, mode: 'illegal' }),
    claudeStubBattle({ port: 41956, mode: 'sleep', extra: ['--claude-timeout', '5'], forfeitAfterFallback: true }),
    claudeStubBattle({ port: 41959, mode: 'legal', forfeitAfterFallback: true, stateDir: stateDirWith(1.0) }),
    originCheck,
  ]);
  check('Claude battles need the app page Origin', origin.err.code === 'claude_origin', origin.err.code);
  check('a connection with no Origin can still play the scripted CPU', origin.cpuStart.opponent.kind === 'cpu');
  const dailyFallback = daily.messages.find((m) => m.type === 'opponent_fallback');
  check('daily budget reached: scripted CPU takes over', dailyFallback && dailyFallback.reason === 'daily_budget' && daily.end.opponentStats.claudeDecisions === 0, JSON.stringify(dailyFallback));
  check('Claude spend is added to the daily state file', legal.spend && legal.spend.usd > 0.002 && legal.spend.day === require('../src/claude/spend').localDay(), JSON.stringify(legal.spend));
  check('welcome reports Claude availability', legal.welcome.claude.available && legal.welcome.claude.version === '9.9.9', JSON.stringify(legal.welcome.claude));
  check('claude battle_start names the opponent', legal.start.opponent.kind === 'claude' && legal.start.opponent.model === 'haiku' && legal.start.opponent.name === 'CLAUDE');
  const ls = legal.end.opponentStats;
  check('legal stub replies are played to the end', legal.end.turns > 0 && ls.claudeDecisions > 0 && ls.fallbacks === 0, JSON.stringify(ls));
  const thinking = legal.messages.filter((m) => m.type === 'opponent_thinking');
  check('opponent_thinking toggles on and off', thinking.some((m) => m.thinking) && thinking.some((m) => !m.thinking) && !thinking[thinking.length - 1].thinking, `${thinking.length} messages`);
  const rs = retry.end.opponentStats;
  check('an illegal reply gets one retry that can succeed', rs.claudeDecisions > 0 && rs.fallbacks === 0, JSON.stringify(rs));
  const is = illegal.end.opponentStats;
  const fallbackMsg = illegal.messages.find((m) => m.type === 'opponent_fallback');
  check('3 bad replies in a row hand the battle to the scripted CPU', illegal.end.turns > 0 && is.handedOver && is.fallbacks === 3 && fallbackMsg && fallbackMsg.reason === 'failures', JSON.stringify(is));
  const ss = sleepy.end.opponentStats;
  check('a slow Claude times out to the scripted move', ss.fallbacks === 3 && ss.maxMs < 7000 && ss.handedOver, JSON.stringify(ss));

  const p1Stats = new Set();
  const p2Stats = new Set();
  const block = (s) => `atk ${s.atk} def ${s.def} spa ${s.spa} spd ${s.spd} spe ${s.spe}`;
  for (const m of legal.messages) if (m.type === 'request') for (const p of m.request.side.pokemon) p1Stats.add(block(p.stats));
  for (const line of legal.prompts.split('\n')) {
    const match = /atk \d+ def \d+ spa \d+ spd \d+ spe \d+/.exec(line);
    if (match) p2Stats.add(match[0]);
  }
  const leaked = [...p1Stats].filter((b) => legal.prompts.includes(b) && !p2Stats.has(b));
  check('Claude prompts hold no p1 private data', legal.prompts.length > 0 && leaked.length === 0 && !legal.prompts.includes('|request|'), `${legal.prompts.split('=====').length - 1} prompts checked`);

  await sleep(3500);
  const left = require('child_process').execFileSync('ps', ['-axo', 'command']).toString().split('\n').filter((l) => l.includes('fake-claude.js') && !l.includes('src/server.js'));
  check('no claude child is left after the battles', left.length === 0, `${left.length} left`);
}

(async () => {
  const timer = setTimeout(() => {
    console.log('FAIL overall timeout');
    killAll();
    process.exit(1);
  }, 600000);
  try {
    testBallWeights();
    testDnsSdCaps();
    await testClaudeStub();
    if (process.env.PKMN_ONLY !== 'claude') {
      await testCpu();
      await testLan();
    }
  } catch (err) {
    check('test run', false, err.stack || err.message);
  } finally {
    clearTimeout(timer);
    killAll();
    for (const srv of fakeServers) srv.close();
    await sleep(300);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
