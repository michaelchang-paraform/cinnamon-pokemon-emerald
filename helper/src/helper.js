'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const { BattleSession, BALLS } = require('./battle');
const { SmartAI } = require('./ai');
const { ClaudeAI, MODELS, probeClaude } = require('./claude/seat');
const { DailySpend } = require('./claude/spend');
const { Lan, LAN_PROTOCOL, isPeerMessage } = require('./lan');
const { Dex } = require('pokemon-showdown');
const { makeId, sanitizeName, sanitizeLook, TRAINER_CLASS_COUNT, isId, isChoice, isFormat: isFormatId, isPlainObject, parseJson, RateLimiter, NAME_MAX, log } = require('./util');

const PAGE_PROTOCOL = 1;
const VERSION = require('../package.json').version;
const MAX_PAGES = 8;
const MAX_PAGE_PAYLOAD = 64 * 1024;
const CHALLENGE_TTL_MS = 60000;
const HELLO_TIMEOUT_MS = 5000;
const BATTLE_START_TIMEOUT_MS = 10000;
const PAGE_ABANDON_MS = 60000;
const MAX_INCOMING = 3;
const CPU_NAMES = ['Wally', 'May', 'Brendan', 'Steven', 'Wallace', 'Flannery', 'Norman', 'Winona', 'Tate', 'Liza', 'Juan', 'Roxanne', 'Brawly', 'Wattson'];
const RELAYED_TYPES = new Set(['battle', 'request', 'choice_error', 'timer']);
const UNSAFE_LINE = /^\|(raw|html|uhtml|uhtmlchange|c|chat|j|l|n|inactive|inactiveoff)\|/;
const MAX_LINE = 1000;
const MAX_LINES = 400;
const MAX_GUEST_LOG_BYTES = 2 * 1024 * 1024;
const MAX_GUEST_LOG_LINES = 20000;
const MAX_REQUEST_BYTES = 32 * 1024;
const INBOUND_IDLE_MS = 10000;

class Helper {
  constructor(config) {
    this.config = config;
    this.trainer = { id: makeId(8), name: sanitizeName(config.name), cls: 0, palette: null };
    this.looking = false;
    this.pages = new Set();
    this.battle = null;
    this.outgoing = new Map();
    this.incoming = new Map();
    this.abandonTimer = null;
    this.lan = null;
    this.cooldowns = new Map();
  }

  status() {
    if (this.battle) return 'battling';
    if (this.pages.size === 0) return 'away';
    return this.looking ? 'looking' : 'idle';
  }

  async start() {
    this.dailySpend = new DailySpend({ stateDir: this.config.stateDir, limitUsd: this.config.claudeDailyBudgetUsd });
    this.claude = await probeClaude(this.config.claudeBin);
    await this.startPageApi();
    if (this.config.lan) {
      this.lan = new Lan({
        host: this.config.lanHost,
        port: this.config.lanPort,
        discovery: this.config.discovery,
        staticPeers: this.config.peers,
        serviceType: this.config.serviceType,
        getInfo: () => ({ id: this.trainer.id, name: this.trainer.name, cls: this.trainer.cls, palette: this.trainer.palette, status: this.status() }),
      });
      this.lan.on('change', () => this.broadcastLobby());
      this.lan.on('inbound', (link) => this.onInboundLink(link));
      await this.lan.start();
    }
    log(`[helper] page api ws://127.0.0.1:${this.config.port}/ws` + (this.lan ? `, lan ${this.config.lanHost}:${this.config.lanPort}` : ', lan off'));
  }

  async stop() {
    if (this.battle && this.battle.ai) this.battle.ai.dispose();
    if (this.battle && this.battle.kind === 'local') this.battle.session.finish({ winnerSide: null, reason: 'shutdown' });
    for (const c of this.outgoing.values()) c.link.close('shutdown');
    for (const c of this.incoming.values()) c.link.close('shutdown');
    if (this.battle && this.battle.link) this.battle.link.close('shutdown');
    if (this.lan) await this.lan.stop();
    for (const p of this.pages) p.ws.terminate();
    await new Promise((resolve) => this.pageServer.close(() => resolve()));
  }

  // page api

  startPageApi() {
    const server = http.createServer((req, res) => {
      const origin = req.headers.origin;
      const headers = { 'Cache-Control': 'no-store' };
      if (origin && this.originAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Private-Network'] = 'true';
        headers.Vary = 'Origin';
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'content-type' });
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app: 'pokemon-emerald-helper', version: VERSION, protocol: PAGE_PROTOCOL, status: this.status() }));
        return;
      }
      res.writeHead(404, headers);
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAGE_PAYLOAD });
    server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin;
      if (req.url !== '/ws' || (origin && !this.originAllowed(origin)) || this.pages.size >= MAX_PAGES) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onPage(ws, origin));
    });
    this.pageServer = server;
    this.pageWss = wss;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  originAllowed(origin) {
    return this.config.allowedOrigins.includes(origin);
  }

  onPage(ws, origin) {
    log(`[page] connected, origin ${origin || 'none'}`);
    const page = { ws, origin: origin || null, limiter: new RateLimiter({ perSecond: 200, burst: 400 }), greeted: false };
    this.pages.add(page);
    ws.on('message', (data, isBinary) => {
      if (isBinary || !page.limiter.take()) return this.toPage(page, { type: 'error', code: 'rate_limited', message: 'Too many messages' });
      const msg = parseJson(data.toString('utf8'));
      if (!msg || typeof msg.type !== 'string') return this.toPage(page, { type: 'error', code: 'bad_message', message: 'Expected a JSON object with a type' });
      try {
        this.onPageMessage(page, msg);
      } catch (err) {
        log('[page] handler error', err);
        this.toPage(page, { type: 'error', code: 'internal', message: 'Internal error', re: msg.type });
      }
    });
    ws.on('close', () => {
      this.pages.delete(page);
      this.onPagesChanged();
    });
    ws.on('error', () => {});
    this.onPagesChanged();
  }

  onPagesChanged() {
    if (this.pages.size === 0 && this.battle && !this.abandonTimer) {
      this.abandonTimer = setTimeout(() => {
        this.abandonTimer = null;
        if (this.pages.size === 0) this.forfeitMine('abandoned');
      }, PAGE_ABANDON_MS);
    }
    if (this.pages.size > 0 && this.abandonTimer) {
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
  }

  toPage(page, msg) {
    if (page.ws.readyState === WebSocket.OPEN) page.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const page of this.pages) if (page.ws.readyState === WebSocket.OPEN) page.ws.send(text);
  }

  fail(page, re, code, message) {
    this.toPage(page, { type: 'error', code, message, re });
  }

  onPageMessage(page, msg) {
    const handlers = {
      hello: () => this.pageHello(page, msg),
      ping: () => this.toPage(page, { type: 'pong', nonce: typeof msg.nonce === 'string' ? msg.nonce.slice(0, 64) : undefined }),
      set_name: () => this.setName(page, msg.name),
      set_trainer: () => this.setTrainer(page, msg.trainer),
      seek: () => this.setLooking(page, msg.looking),
      lobby_refresh: () => this.refreshLobby(page),
      add_peer: () => this.addPeer(page, msg),
      challenge: () => this.challenge(page, msg),
      cancel_challenge: () => this.cancelChallenge(page, msg),
      respond_challenge: () => this.respondChallenge(page, msg),
      start_cpu: () => this.startCpu(page, msg),
      choose: () => this.pageChoose(page, msg),
      forfeit: () => this.pageForfeit(page, msg),
    };
    const handler = handlers[msg.type];
    if (!handler) return this.fail(page, msg.type, 'unknown_type', `Unknown message type ${String(msg.type).slice(0, 32)}`);
    if (msg.type !== 'hello' && msg.type !== 'ping' && !page.greeted) return this.fail(page, msg.type, 'hello_first', 'Send hello first');
    handler();
  }

  pageHello(page, msg) {
    if (msg.protocol !== undefined && msg.protocol !== PAGE_PROTOCOL) {
      return this.fail(page, 'hello', 'protocol_mismatch', `Helper speaks protocol ${PAGE_PROTOCOL}`);
    }
    page.greeted = true;
    if (typeof msg.name === 'string') this.trainer.name = sanitizeName(msg.name, this.trainer.name);
    if (msg.trainer !== undefined) this.applyLook(msg.trainer);
    this.toPage(page, {
      type: 'welcome',
      protocol: PAGE_PROTOCOL,
      version: VERSION,
      trainer: { ...this.trainer },
      status: this.status(),
      looking: this.looking,
      defaultFormat: this.config.format,
      claude: { ...this.claude, models: MODELS, defaultModel: this.config.claudeModel },
      launchAgent: process.env.XPC_SERVICE_NAME === 'com.pokemon-emerald.helper',
      lan: { enabled: !!this.lan, port: this.lan ? this.config.lanPort : null, discovery: this.lan ? this.lan.discovery : 'off' },
    });
    this.toPage(page, this.lobbyMessage());
    for (const c of this.incoming.values()) this.toPage(page, this.challengeReceivedMessage(c));
    for (const c of this.outgoing.values()) this.toPage(page, { type: 'challenge_sent', challengeId: c.challengeId, peer: { id: c.peerId, name: c.peerName }, format: c.format });
    if (this.battle) this.resumeBattle(page);
  }

  setName(page, raw) {
    if (typeof raw !== 'string') return this.fail(page, 'set_name', 'bad_name', 'name must be a string');
    this.trainer.name = sanitizeName(raw, this.trainer.name);
    this.broadcast({ type: 'trainer', trainer: { ...this.trainer } });
  }

  applyLook(raw) {
    if (!isPlainObject(raw)) return false;
    const look = sanitizeLook(raw);
    this.trainer.cls = look.cls;
    this.trainer.palette = look.palette;
    if (typeof raw.name === 'string') this.trainer.name = sanitizeName(raw.name, this.trainer.name);
    return true;
  }

  setTrainer(page, raw) {
    if (!this.applyLook(raw)) return this.fail(page, 'set_trainer', 'bad_value', 'trainer must be an object { cls, name?, palette? }');
    this.broadcast({ type: 'trainer', trainer: { ...this.trainer } });
  }

  helloMessage() {
    const { id, name, cls, palette } = this.trainer;
    return { t: 'hello', v: LAN_PROTOCOL, id, name, trainer: { cls, name, palette } };
  }

  setLooking(page, looking) {
    if (typeof looking !== 'boolean') return this.fail(page, 'seek', 'bad_value', 'looking must be a boolean');
    this.looking = looking;
    this.broadcast({ type: 'status', status: this.status(), looking: this.looking });
  }

  lobbyMessage() {
    return { type: 'lobby', you: { ...this.trainer, status: this.status() }, peers: this.lan ? this.lan.peerList() : [] };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyMessage());
  }

  refreshLobby(page) {
    if (this.lan) this.lan.refreshDiscovery();
    this.toPage(page, this.lobbyMessage());
  }

  addPeer(page, msg) {
    if (!this.lan) return this.fail(page, 'add_peer', 'lan_disabled', 'LAN is off');
    const port = msg.port === undefined ? this.config.lanPort : msg.port;
    if (!this.lan.addCandidate(msg.host, port, 'manual')) return this.fail(page, 'add_peer', 'bad_address', 'host must be an IP or hostname, port 1-65535');
    this.toPage(page, { type: 'peer_added', address: `${msg.host}:${port}` });
  }

  // challenges, host side

  async challenge(page, msg) {
    if (!this.lan) return this.fail(page, 'challenge', 'lan_disabled', 'LAN is off');
    if (this.battle) return this.fail(page, 'challenge', 'busy', 'Already in a battle');
    if (this.outgoing.size > 0) return this.fail(page, 'challenge', 'busy', 'A challenge is already pending');
    if (!isId(msg.peerId) || !this.lan.peers.has(msg.peerId)) return this.fail(page, 'challenge', 'unknown_peer', 'No such trainer on the network');
    const format = msg.format === undefined ? this.config.format : msg.format;
    if (!isFormat(format)) return this.fail(page, 'challenge', 'bad_format', 'Bad format id');
    const peer = this.lan.peers.get(msg.peerId);
    if (peer.status === 'battling' || peer.status === 'away') return this.fail(page, 'challenge', 'peer_busy', `${peer.name} is ${peer.status}`);
    const challengeId = makeId(8);
    const pending = { challengeId, peerId: peer.id, peerName: peer.name, peerLook: { cls: peer.cls, palette: peer.palette }, format, link: null, timer: null };
    this.outgoing.set(challengeId, pending);
    this.broadcast({ type: 'challenge_sent', challengeId, peer: { id: peer.id, name: peer.name }, format });
    let link;
    try {
      link = await this.lan.connect(peer.id);
    } catch (err) {
      this.outgoing.delete(challengeId);
      this.broadcast({ type: 'challenge_update', challengeId, state: 'failed', reason: 'unreachable' });
      return;
    }
    if (!this.outgoing.has(challengeId)) {
      link.close('cancelled');
      return;
    }
    pending.link = link;
    link.send(this.helloMessage());
    link.send({ t: 'challenge', challengeId, format });
    pending.timer = setTimeout(() => {
      if (!this.outgoing.has(challengeId)) return;
      link.send({ t: 'challenge_cancel', challengeId });
      this.endOutgoing(challengeId, 'expired');
    }, CHALLENGE_TTL_MS);
    link.on('message', (m) => this.onHostLinkMessage(challengeId, link, m));
    link.on('close', () => {
      if (this.outgoing.has(challengeId)) this.endOutgoing(challengeId, 'failed', 'peer_disconnected');
      else if (this.battle && this.battle.link === link && !this.battle.session.ended) {
        this.battle.session.abort({ winnerSide: this.battle.mySide, reason: 'disconnected' });
      }
    });
  }

  endOutgoing(challengeId, state, reason) {
    const c = this.outgoing.get(challengeId);
    if (!c) return;
    this.outgoing.delete(challengeId);
    clearTimeout(c.timer);
    if (state !== 'accepted' && c.link) c.link.close(state);
    this.broadcast({ type: 'challenge_update', challengeId, state, reason });
  }

  cancelChallenge(page, msg) {
    const c = this.outgoing.get(msg.challengeId);
    if (!c) return this.fail(page, 'cancel_challenge', 'unknown_challenge', 'No such outgoing challenge');
    if (c.link) c.link.send({ t: 'challenge_cancel', challengeId: c.challengeId });
    this.endOutgoing(c.challengeId, 'cancelled');
  }

  onHostLinkMessage(challengeId, link, m) {
    if (!isPeerMessage(m)) return link.close('malformed');
    if (m.t === 'hello') {
      if (m.v !== LAN_PROTOCOL || !isId(m.id)) return link.close('bad_hello');
      link.peerName = sanitizeName(m.name, link.peerName || 'Trainer');
      link.peerLook = sanitizeLook(m.trainer);
      return;
    }
    if (m.t === 'challenge_reply') {
      if (m.challengeId !== challengeId || !this.outgoing.has(challengeId) || typeof m.accept !== 'boolean') return;
      if (!m.accept) return this.endOutgoing(challengeId, 'declined', typeof m.reason === 'string' ? m.reason.slice(0, 32) : undefined);
      if (this.battle) {
        link.send({ t: 'battle_abort', reason: 'busy' });
        return this.endOutgoing(challengeId, 'failed', 'busy');
      }
      const c = this.outgoing.get(challengeId);
      this.endOutgoing(challengeId, 'accepted');
      this.declineAllIncoming('busy');
      return this.startLanHostBattle(c, link);
    }
    const b = this.battle;
    if (!b || b.link !== link || b.session.ended) return;
    if (m.battleId !== b.session.id) return;
    if (m.t === 'choose') {
      if (!isChoice(m.choice)) return link.send({ t: 'battle_msg', msg: { type: 'choice_error', battleId: b.session.id, message: '[Invalid choice] rejected by host' } });
      const rqid = Number.isInteger(m.rqid) ? m.rqid : undefined;
      const err = b.session.choose(b.peerSide, m.choice, { rqid });
      if (err) link.send({ t: 'battle_msg', msg: { type: 'choice_error', battleId: b.session.id, message: err } });
    } else if (m.t === 'forfeit') {
      b.session.forfeit(b.peerSide, 'forfeit');
    }
  }

  startLanHostBattle(c, link) {
    const myName = this.trainer.name;
    const peerName = uniqueName(link.peerName || c.peerName, myName);
    const seats = {
      p1: { kind: 'human', name: myName, send: (msg) => this.broadcast(msg) },
      p2: { kind: 'human', name: peerName, send: (msg) => link.send({ t: 'battle_msg', msg }) },
    };
    const session = new BattleSession({ format: c.format, seats, timerSeconds: this.config.lanTimerSeconds });
    this.battle = { kind: 'local', mode: 'lan', session, mySide: 'p1', peerSide: 'p2', link, opponent: { id: c.peerId, name: peerName, ...(link.peerLook || c.peerLook || sanitizeLook(null)) } };
    link.send({ t: 'battle_start', battleId: session.id, format: c.format, side: 'p2', names: { p1: myName, p2: peerName }, trainers: { p1: { cls: this.trainer.cls, palette: this.trainer.palette } }, timerSeconds: session.timerSeconds || null });
    this.broadcast(this.battleStartMessage(false));
    session.on('end', (info) => this.onLocalBattleEnd(info));
    session.start();
    this.onPagesChanged();
    this.broadcast({ type: 'status', status: this.status(), looking: this.looking });
    log(`[battle] lan host ${session.id} vs ${peerName}`);
  }

  // challenges, guest side

  onInboundLink(link) {
    const helloTimer = setTimeout(() => {
      if (!link.peerId) link.close('no_hello');
    }, HELLO_TIMEOUT_MS);
    link.on('message', (m) => {
      if (!isPeerMessage(m)) return link.close('malformed');
      if (!link.peerId) {
        if (m.t !== 'hello' || m.v !== LAN_PROTOCOL || !isId(m.id) || m.id === this.trainer.id) return link.close('bad_hello');
        clearTimeout(helloTimer);
        link.peerId = m.id;
        link.peerName = sanitizeName(m.name);
        link.peerLook = sanitizeLook(m.trainer);
        link.send(this.helloMessage());
        this.armInboundIdle(link);
        return;
      }
      this.onGuestLinkMessage(link, m);
    });
    link.on('close', () => {
      clearTimeout(helloTimer);
      clearTimeout(link.idleTimer);
      for (const c of this.incoming.values()) {
        if (c.link === link) this.endIncoming(c.challengeId, 'cancelled', 'peer_disconnected', false);
      }
      const b = this.battle;
      if (b && b.kind === 'remote' && b.link === link && !b.ended) {
        this.endRemoteBattle({ result: 'win', reason: 'opponent_disconnected', turns: b.turns });
      }
    });
  }

  /** Inbound links live only while they carry a challenge or a battle. */
  armInboundIdle(link) {
    clearTimeout(link.idleTimer);
    link.idleTimer = setTimeout(() => {
      const busy = [...this.incoming.values()].some((c) => c.link === link) || (this.battle && this.battle.link === link);
      if (!busy) link.close('idle');
    }, INBOUND_IDLE_MS);
  }

  onCooldown(link) {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    return this.cooldowns.has(`id:${link.peerId}`) || this.cooldowns.has(`ip:${link.remoteAddress}`);
  }

  startCooldown(link) {
    if (this.cooldowns.size > 256) this.cooldowns.clear();
    const until = Date.now() + this.config.challengeCooldownSeconds * 1000;
    this.cooldowns.set(`id:${link.peerId}`, until);
    this.cooldowns.set(`ip:${link.remoteAddress}`, until);
  }

  onGuestLinkMessage(link, m) {
    if (m.t === 'challenge') {
      if (!isId(m.challengeId) || !isFormat(m.format)) return link.close('bad_challenge');
      const fromSamePeer = [...this.incoming.values()].some((c) => c.from.id === link.peerId);
      const cooling = this.onCooldown(link);
      if (this.battle || this.pages.size === 0 || fromSamePeer || cooling || this.incoming.size >= MAX_INCOMING) {
        const reason = this.battle ? 'busy' : this.pages.size === 0 ? 'away' : cooling ? 'cooldown' : 'busy';
        link.send({ t: 'challenge_reply', challengeId: m.challengeId, accept: false, reason });
        if (!fromSamePeer) setTimeout(() => link.close(reason), 200);
        return;
      }
      clearTimeout(link.idleTimer);
      const c = { challengeId: m.challengeId, from: { id: link.peerId, name: link.peerName, trainer: { ...link.peerLook, name: link.peerName } }, format: m.format, link, timer: null };
      c.timer = setTimeout(() => {
        this.startCooldown(link);
        link.send({ t: 'challenge_reply', challengeId: c.challengeId, accept: false, reason: 'expired' });
        this.endIncoming(c.challengeId, 'expired', undefined, true);
      }, CHALLENGE_TTL_MS);
      this.incoming.set(c.challengeId, c);
      this.broadcast(this.challengeReceivedMessage(c));
      return;
    }
    if (m.t === 'challenge_cancel') {
      const c = this.incoming.get(m.challengeId);
      if (c && c.link === link) {
        this.startCooldown(link);
        this.endIncoming(c.challengeId, 'cancelled', undefined, true);
      }
      return;
    }
    const b = this.battle;
    if (!b || b.kind !== 'remote' || b.link !== link || b.ended) return;
    if (m.t === 'battle_abort') return this.endRemoteBattle({ result: 'aborted', reason: 'host_busy', turns: 0 });
    if (m.t === 'battle_start') {
      if (b.battleId || !isId(m.battleId) || m.side !== 'p2' || !isFormat(m.format) || !isPlainObject(m.names)) return link.close('bad_battle_start');
      clearTimeout(b.startTimer);
      b.battleId = m.battleId;
      b.format = m.format;
      const hostLook = isPlainObject(m.trainers) && m.trainers.p1 ? sanitizeLook(m.trainers.p1) : link.peerLook || sanitizeLook(null);
      b.opponent = { id: link.peerId, name: sanitizeName(m.names.p1, link.peerName), ...hostLook };
      b.myName = sanitizeName(m.names.p2, this.trainer.name);
      b.timerSeconds = Number.isInteger(m.timerSeconds) && m.timerSeconds > 0 && m.timerSeconds <= 3600 ? m.timerSeconds : null;
      this.broadcast(this.battleStartMessage(false));
      this.broadcast({ type: 'status', status: this.status(), looking: this.looking });
      return;
    }
    if (m.battleId !== undefined && m.battleId !== b.battleId) return;
    if (m.t === 'battle_msg') {
      const inner = this.sanitizeRelayed(m.msg, b);
      if (!inner) return;
      if (inner.type === 'battle') {
        b.logBytes += inner.lines.reduce((n, l) => n + l.length + 1, 0);
        if (b.logBytes > MAX_GUEST_LOG_BYTES || b.log.length + inner.lines.length > MAX_GUEST_LOG_LINES) return link.close('log_too_large');
        b.log.push(...inner.lines);
        if (inner.balls) Object.assign(b.balls, inner.balls);
        for (const line of inner.lines) if (line.startsWith('|turn|')) b.turns = Math.max(b.turns, Number(line.slice(6)) || 0);
      }
      if (inner.type === 'request') {
        b.request = inner.request.wait ? null : inner.request;
        b.lastRequest = b.request;
        b.rqid = inner.rqid;
      }
      if (inner.type === 'choice_error') b.request = b.lastRequest;
      if (inner.type === 'timer') b.timers[inner.side] = { secondsLeft: inner.secondsLeft, at: Date.now() };
      if (inner.type === 'battle' && inner.lines.some((l) => l.startsWith('|turn|'))) b.timers = {};
      this.broadcast(inner);
      return;
    }
    if (m.t === 'battle_end') {
      const winnerSide = m.winnerSide === 'p1' || m.winnerSide === 'p2' ? m.winnerSide : null;
      const reason = typeof m.reason === 'string' ? m.reason.slice(0, 32) : 'normal';
      const turns = Number.isInteger(m.turns) ? m.turns : b.turns;
      this.endRemoteBattle({ ...perspective({ winnerSide, reason, mySide: 'p2' }), turns });
    }
  }

  sanitizeRelayed(msg, b) {
    if (!isPlainObject(msg) || !RELAYED_TYPES.has(msg.type) || msg.battleId !== b.battleId) return null;
    if (msg.type === 'battle') {
      if (!Array.isArray(msg.lines) || msg.lines.length > MAX_LINES) return null;
      const lines = msg.lines.filter((l) => typeof l === 'string' && l.length <= MAX_LINE && !UNSAFE_LINE.test(l));
      const balls = sanitizeBalls(msg.balls);
      return { type: 'battle', battleId: b.battleId, lines, ...(balls ? { balls } : {}) };
    }
    if (msg.type === 'request') {
      const r = msg.request;
      if (!isPlainObject(r) || !isPlainObject(r.side) || r.side.id !== 'p2') return null;
      if (JSON.stringify(r).length > MAX_REQUEST_BYTES) {
        b.link.close('request_too_large');
        return null;
      }
      return { type: 'request', battleId: b.battleId, rqid: Number.isInteger(msg.rqid) ? msg.rqid : undefined, request: r };
    }
    if (msg.type === 'choice_error') {
      return { type: 'choice_error', battleId: b.battleId, message: typeof msg.message === 'string' ? msg.message.slice(0, 300) : 'error' };
    }
    if (msg.type === 'timer') {
      if (!Number.isInteger(msg.secondsLeft) || (msg.side !== 'p1' && msg.side !== 'p2')) return null;
      return { type: 'timer', battleId: b.battleId, side: msg.side, secondsLeft: msg.secondsLeft, forYou: msg.side === 'p2' };
    }
    return null;
  }

  respondChallenge(page, msg) {
    const c = this.incoming.get(msg.challengeId);
    if (!c) return this.fail(page, 'respond_challenge', 'unknown_challenge', 'No such incoming challenge');
    if (typeof msg.accept !== 'boolean') return this.fail(page, 'respond_challenge', 'bad_value', 'accept must be a boolean');
    if (!msg.accept) {
      this.startCooldown(c.link);
      c.link.send({ t: 'challenge_reply', challengeId: c.challengeId, accept: false, reason: 'declined' });
      return this.endIncoming(c.challengeId, 'declined', undefined, true);
    }
    if (this.battle) return this.fail(page, 'respond_challenge', 'busy', 'Already in a battle');
    for (const o of [...this.outgoing.values()]) {
      if (o.link) o.link.send({ t: 'challenge_cancel', challengeId: o.challengeId });
      this.endOutgoing(o.challengeId, 'cancelled', 'accepted_other');
    }
    c.link.send({ t: 'challenge_reply', challengeId: c.challengeId, accept: true });
    this.endIncoming(c.challengeId, 'accepted', undefined, false);
    this.declineAllIncoming('busy');
    const b = { kind: 'remote', mode: 'lan', link: c.link, battleId: null, format: c.format, mySide: 'p2', opponent: { id: c.from.id, name: c.from.name, cls: c.from.trainer.cls, palette: c.from.trainer.palette }, myName: this.trainer.name, log: [], balls: {}, logBytes: 0, request: null, timers: {}, timerSeconds: null, turns: 0, ended: false };
    b.startTimer = setTimeout(() => {
      if (!b.battleId && this.battle === b) this.endRemoteBattle({ result: 'aborted', reason: 'start_timeout', turns: 0 });
    }, BATTLE_START_TIMEOUT_MS);
    this.battle = b;
    this.onPagesChanged();
  }

  endIncoming(challengeId, state, reason, closeLink) {
    const c = this.incoming.get(challengeId);
    if (!c) return;
    this.incoming.delete(challengeId);
    clearTimeout(c.timer);
    if (closeLink) setTimeout(() => c.link.close(state), 200);
    this.broadcast({ type: 'challenge_update', challengeId, state, reason });
  }

  declineAllIncoming(reason) {
    for (const c of [...this.incoming.values()]) {
      c.link.send({ t: 'challenge_reply', challengeId: c.challengeId, accept: false, reason });
      this.endIncoming(c.challengeId, 'cancelled', reason, true);
    }
  }

  challengeReceivedMessage(c) {
    return { type: 'challenge_received', challengeId: c.challengeId, from: { ...c.from }, format: c.format, expiresInSeconds: Math.round(CHALLENGE_TTL_MS / 1000) };
  }

  endRemoteBattle({ result, reason, turns }) {
    const b = this.battle;
    if (!b || b.kind !== 'remote' || b.ended) return;
    b.ended = true;
    clearTimeout(b.startTimer);
    this.battle = null;
    if (b.battleId) this.broadcast({ type: 'battle_end', battleId: b.battleId, result, reason, turns });
    else this.broadcast({ type: 'challenge_update', challengeId: null, state: 'failed', reason });
    setTimeout(() => b.link.close('battle_over'), 500);
    this.broadcast({ type: 'status', status: this.status(), looking: this.looking });
  }

  // cpu battles

  startCpu(page, msg) {
    if (this.battle) return this.fail(page, 'start_cpu', 'busy', 'Already in a battle');
    const format = msg.format === undefined ? this.config.format : msg.format;
    if (!isFormat(format)) return this.fail(page, 'start_cpu', 'bad_format', 'Bad format id');
    const difficulty = msg.difficulty === 'random' ? 'random' : 'smart';
    const opponentKind = msg.opponent === undefined || msg.opponent === 'cpu' || msg.opponent === 'script' ? 'cpu' : msg.opponent;
    if (opponentKind !== 'claude' && opponentKind !== 'cpu') return this.fail(page, 'start_cpu', 'bad_value', 'opponent must be "cpu" or "claude"');
    const model = msg.model === undefined ? this.config.claudeModel : msg.model;
    if (opponentKind === 'claude') {
      if (!page.origin || !this.originAllowed(page.origin)) return this.fail(page, 'start_cpu', 'claude_origin', 'Claude battles start only from the Claude app page');
      if (!MODELS.includes(model)) return this.fail(page, 'start_cpu', 'bad_value', `model must be one of ${MODELS.join(', ')}`);
      if (!this.claude.available) return this.fail(page, 'start_cpu', 'claude_unavailable', 'Claude Code was not found when the helper started');
    }
    const myName = this.trainer.name;
    const cpuName = uniqueName(opponentKind === 'claude' ? 'CLAUDE' : `CPU ${CPU_NAMES[Math.floor(Math.random() * CPU_NAMES.length)]}`, myName);
    let session;
    const write = (choice) => session.choose('p2', choice, { trusted: true });
    const ai = opponentKind === 'claude'
      ? new ClaudeAI({
          side: 'p2',
          format,
          write,
          model,
          bin: this.config.claudeBin,
          timeoutMs: this.config.claudeTimeoutSeconds * 1000,
          runBudgetUsd: 0.05,
          battleBudgetUsd: this.config.claudeBattleBudgetUsd,
          dailySpend: this.dailySpend,
          onThinking: (thinking) => this.broadcast({ type: 'opponent_thinking', battleId: session.id, thinking }),
          onFallback: (reason) => this.broadcast({ type: 'opponent_fallback', battleId: session.id, reason }),
          onDecision: (d) => log(`[claude] ${d.ok ? d.action : `fallback (${d.reason})`} in ${d.ms}ms`),
        })
      : new SmartAI({ side: 'p2', format, difficulty, write });
    const seats = {
      p1: { kind: 'human', name: myName, send: (m) => this.broadcast(m) },
      p2: { kind: 'ai', name: cpuName, feed: (line) => ai.receiveLine(line) },
    };
    try {
      session = new BattleSession({ format, seats, timerSeconds: this.config.cpuTimerSeconds });
    } catch (err) {
      return this.fail(page, 'start_cpu', 'bad_format', err.message);
    }
    this.battle = { kind: 'local', mode: 'cpu', session, mySide: 'p1', peerSide: 'p2', link: null, ai, opponent: { id: null, name: cpuName, cpu: true, kind: opponentKind, model: opponentKind === 'claude' ? model : null, difficulty, cls: Math.floor(Math.random() * TRAINER_CLASS_COUNT), palette: null } };
    this.declineAllIncoming('busy');
    this.broadcast(this.battleStartMessage(false));
    session.on('end', (info) => this.onLocalBattleEnd(info));
    session.start();
    this.onPagesChanged();
    this.broadcast({ type: 'status', status: this.status(), looking: this.looking });
    log(`[battle] cpu ${session.id} vs ${cpuName} (${difficulty})`);
  }

  onLocalBattleEnd(info) {
    const b = this.battle;
    if (!b || b.kind !== 'local') return;
    this.battle = null;
    let opponentStats;
    if (b.ai instanceof ClaudeAI) {
      b.ai.dispose();
      opponentStats = b.ai.summary();
      log('[claude] battle summary', JSON.stringify(opponentStats));
    }
    const mine = perspective({ winnerSide: info.winnerSide, reason: info.reason, mySide: b.mySide });
    this.broadcast({ type: 'battle_end', battleId: b.session.id, ...mine, turns: info.turns, opponentStats });
    if (b.link) {
      b.link.send({ t: 'battle_end', battleId: b.session.id, winnerSide: info.winnerSide, reason: info.reason, turns: info.turns });
      setTimeout(() => b.link.close('battle_over'), 1000);
    }
    this.broadcast({ type: 'status', status: this.status(), looking: this.looking });
    log(`[battle] ${b.session.id} ended: ${mine.result} (${mine.reason}) after ${info.turns} turns`);
  }

  // shared battle plumbing

  battleStartMessage(resumed) {
    const b = this.battle;
    if (b.kind === 'local') {
      return {
        type: 'battle_start',
        battleId: b.session.id,
        mode: b.mode,
        format: b.session.format,
        side: b.mySide,
        you: { name: b.session.seats[b.mySide].name, cls: this.trainer.cls, palette: this.trainer.palette },
        opponent: { ...b.opponent },
        timerSeconds: b.session.timerSeconds || null,
        resumed,
      };
    }
    return { type: 'battle_start', battleId: b.battleId, mode: 'lan', format: b.format, side: 'p2', you: { name: b.myName, cls: this.trainer.cls, palette: this.trainer.palette }, opponent: { ...b.opponent }, timerSeconds: b.timerSeconds, resumed };
  }

  resumeBattle(page) {
    const b = this.battle;
    if (b.kind === 'remote' && !b.battleId) return;
    this.toPage(page, this.battleStartMessage(true));
    const snap = b.kind === 'local' ? b.session.snapshot(b.mySide) : { log: b.log, balls: Object.keys(b.balls).length ? { ...b.balls } : null, request: b.request, rqid: b.rqid, timers: this.guestTimers(b) };
    const battleId = b.kind === 'local' ? b.session.id : b.battleId;
    if (snap.log.length) this.toPage(page, { type: 'battle', battleId, lines: snap.log, ...(snap.balls ? { balls: snap.balls } : {}) });
    if (snap.request) this.toPage(page, { type: 'request', battleId, rqid: snap.rqid, request: snap.request });
    for (const t of snap.timers) this.toPage(page, { type: 'timer', battleId, side: t.side, secondsLeft: t.secondsLeft, forYou: t.side === b.mySide });
  }

  guestTimers(b) {
    return Object.entries(b.timers).map(([side, t]) => ({ side, secondsLeft: Math.max(0, t.secondsLeft - Math.floor((Date.now() - t.at) / 1000)) }));
  }

  currentBattleId() {
    const b = this.battle;
    if (!b) return null;
    return b.kind === 'local' ? b.session.id : b.battleId;
  }

  pageChoose(page, msg) {
    const b = this.battle;
    if (!b || msg.battleId !== this.currentBattleId()) return this.fail(page, 'choose', 'no_battle', 'No such active battle');
    if (!isChoice(msg.choice)) return this.fail(page, 'choose', 'invalid_choice', 'choice must be "move 1-4", "switch 1-6", "team 123456" or "default"');
    const rqid = Number.isInteger(msg.rqid) ? msg.rqid : undefined;
    if (b.kind === 'local') {
      const err = b.session.choose(b.mySide, msg.choice, { rqid });
      if (err) this.fail(page, 'choose', err, err.replace(/_/g, ' '));
      return;
    }
    if (!b.request) return this.fail(page, 'choose', 'not_your_turn', 'not your turn');
    b.request = null;
    delete b.timers.p2;
    b.link.send({ t: 'choose', battleId: b.battleId, choice: msg.choice, rqid });
  }

  pageForfeit(page, msg) {
    if (!this.battle || msg.battleId !== this.currentBattleId()) return this.fail(page, 'forfeit', 'no_battle', 'No such active battle');
    this.forfeitMine('forfeit');
  }

  forfeitMine(reason) {
    const b = this.battle;
    if (!b) return;
    if (b.kind === 'local') return b.session.forfeit(b.mySide, reason);
    if (!b.battleId) return this.endRemoteBattle({ result: 'aborted', reason, turns: 0 });
    b.link.send({ t: 'forfeit', battleId: b.battleId });
    setTimeout(() => {
      if (this.battle === b) this.endRemoteBattle({ result: 'loss', reason, turns: b.turns });
    }, 3000);
  }
}

function perspective({ winnerSide, reason, mySide }) {
  if (!winnerSide) return { result: reason === 'normal' ? 'tie' : 'aborted', reason };
  const won = winnerSide === mySide;
  const opponentCaused = ['forfeit', 'timeout', 'disconnected', 'abandoned'].includes(reason);
  return { result: won ? 'win' : 'loss', reason: won && opponentCaused ? `opponent_${reason}` : reason };
}

function isFormat(id) {
  if (!isFormatId(id)) return false;
  const format = Dex.formats.get(id);
  return format.exists && format.effectType === 'Format' && !!format.team;
}

function sanitizeBalls(raw) {
  if (!isPlainObject(raw)) return null;
  const out = {};
  for (const [ident, ball] of Object.entries(raw).slice(0, 12)) {
    if (/^p[12]: [^|]{1,40}$/.test(ident) && BALLS.includes(ball)) out[ident] = ball;
  }
  return Object.keys(out).length ? out : null;
}

function uniqueName(name, taken) {
  if (name !== taken) return name;
  return `${name.slice(0, NAME_MAX - 2)} 2`;
}

module.exports = { Helper, PAGE_PROTOCOL };
