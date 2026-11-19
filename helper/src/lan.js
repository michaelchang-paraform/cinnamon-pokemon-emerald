'use strict';

const http = require('http');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const { WebSocket, WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');
const { DnsSdDiscovery, dnsSdAvailable } = require('./dnssd');
const { RateLimiter, parseJson, sanitizeName, sanitizeLook, isId, isPlainObject, hostPort, DEFAULT_SERVICE_TYPE, log } = require('./util');

const LAN_PROTOCOL = 1;
const MAX_PEER_PAYLOAD = 256 * 1024;
const MAX_INBOUND = 16;
const MAX_INBOUND_PER_IP = 4;
const HEARTBEAT_MS = 5000;
const HEARTBEAT_MISSES = 3;
const PROBE_MS = 4000;
const PROBE_TIMEOUT_MS = 2500;
const PEER_STALE_FAILURES = 3;
const MAX_PEERS = 64;
const MAX_CANDIDATES = 64;
const MAX_INFO_BYTES = 4096;
const STATUSES = new Set(['idle', 'looking', 'battling', 'away']);

/** A JSON message link to one peer helper, inbound or outbound. */
class PeerLink extends EventEmitter {
  constructor(ws, { remoteAddress }) {
    super();
    this.ws = ws;
    this.remoteAddress = remoteAddress;
    this.peerId = null;
    this.peerName = null;
    this.closed = false;
    this.limiter = new RateLimiter({ perSecond: 500, burst: 1000 });
    this.missed = 0;
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('pong', () => {
      this.missed = 0;
    });
    ws.on('close', () => this.onClose('closed'));
    ws.on('error', (err) => {
      log('[lan] link error', remoteAddress, err.message);
      this.onClose('error');
    });
    this.heartbeat = setInterval(() => {
      if (this.missed >= HEARTBEAT_MISSES) {
        this.close('heartbeat_timeout');
        return;
      }
      this.missed += 1;
      try {
        ws.ping();
      } catch {
        this.close('ping_failed');
      }
    }, HEARTBEAT_MS);
  }

  onMessage(data, isBinary) {
    if (isBinary || !this.limiter.take()) {
      this.close('rate_limited');
      return;
    }
    const msg = parseJson(data.toString('utf8'));
    if (!msg || typeof msg.t !== 'string') {
      this.close('malformed');
      return;
    }
    this.emit('message', msg);
  }

  send(msg) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(reason) {
    if (this.closed) return;
    try {
      this.ws.close(1000, String(reason).slice(0, 60));
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }, 1000).unref();
    this.onClose(reason);
  }

  onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    log(`[lan] link ${this.remoteAddress} closed: ${reason}`);
    this.emit('close', reason);
  }
}

/** LAN listener, mDNS presence, peer list. */
class Lan extends EventEmitter {
  constructor({ host, port, getInfo, discovery = 'auto', serviceType = DEFAULT_SERVICE_TYPE, staticPeers = [] }) {
    super();
    this.serviceType = serviceType;
    this.host = host;
    this.port = port;
    this.getInfo = getInfo;
    this.discovery = discovery === 'auto' ? (dnsSdAvailable() ? 'dnssd' : 'mdns') : discovery;
    this.peers = new Map();
    this.candidates = new Map();
    this.inboundCount = 0;
    this.inboundPerIp = new Map();
    for (const hp of staticPeers) this.addCandidate(hp.host, hp.port, 'manual');
  }

  async start() {
    this.http = http.createServer((req, res) => this.onHttp(req, res));
    this.http.headersTimeout = 5000;
    this.http.requestTimeout = 5000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PEER_PAYLOAD });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    if (this.discovery === 'dnssd') this.startDnsSd();
    else if (this.discovery === 'mdns') this.startMdns();
    this.probeTimer = setInterval(() => this.probeAll(), PROBE_MS);
    this.probeAll();
  }

  startDnsSd() {
    const info = this.getInfo();
    this.dnssd = new DnsSdDiscovery({ instance: `pkmn-${info.id}`, type: this.serviceType, port: this.port, txt: { id: info.id, v: LAN_PROTOCOL } });
    this.dnssd.on('found', ({ host, port }) => this.addCandidate(host, port, 'mdns'));
    this.dnssd.on('lost', (instance) => this.onLost(instance.slice(5)));
    this.dnssd.start();
    this.browseTimer = setInterval(() => this.dnssd.refresh(), 30000);
  }

  refreshDiscovery() {
    try {
      if (this.dnssd) this.dnssd.refresh();
      if (this.browser) this.browser.update();
    } catch {
      // ignore
    }
    this.probeAll();
  }

  startMdns() {
    try {
      this.bonjour = new Bonjour({}, (err) => log('[lan] mdns error', err && err.message));
      const info = this.getInfo();
      this.service = this.bonjour.publish({
        name: `pkmn-${info.id}`,
        type: this.serviceType,
        port: this.port,
        txt: { id: info.id, v: String(LAN_PROTOCOL) },
      });
      this.service.on('error', (err) => log('[lan] mdns publish error', err && err.message));
      this.browser = this.bonjour.find({ type: this.serviceType }, (svc) => this.onService(svc));
      this.browser.on('srv-update', (svc) => this.onService(svc));
      this.browseTimer = setInterval(() => {
        try {
          this.browser.update();
        } catch {
          // ignore
        }
      }, 10000);
    } catch (err) {
      log('[lan] mdns unavailable', err.message);
    }
  }

  onService(svc) {
    const txt = svc.txt || {};
    if (txt.id === this.getInfo().id) return;
    if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) return;
    const addresses = [];
    if (svc.referer && svc.referer.family === 'IPv4') addresses.push(svc.referer.address);
    for (const a of svc.addresses || []) if (/^\d+\.\d+\.\d+\.\d+$/.test(a) && !addresses.includes(a)) addresses.push(a);
    for (const address of addresses.slice(0, 4)) this.addCandidate(address, svc.port, 'mdns');
  }

  addCandidate(host, port, source) {
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(host)) return false;
    if (host.includes(':') && !net.isIPv6(host)) return false;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const key = hostPort(host, port);
    if (!this.candidates.has(key)) {
      if (this.candidates.size >= MAX_CANDIDATES) return false;
      this.candidates.set(key, { host, port, source, failures: 0, probing: false });
      this.probe(this.candidates.get(key));
    }
    return true;
  }

  isSelf(host, port) {
    if (port !== this.port) return false;
    if (host === '127.0.0.1' || host === 'localhost') return true;
    return Object.values(os.networkInterfaces())
      .flat()
      .some((ni) => ni && ni.address === host);
  }

  probeAll() {
    for (const c of this.candidates.values()) this.probe(c);
  }

  probe(c) {
    if (c.probing || this.isSelf(c.host, c.port)) return;
    c.probing = true;
    let info = null;
    const req = http.get({ host: c.host, port: c.port, path: '/info', timeout: PROBE_TIMEOUT_MS, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > MAX_INFO_BYTES) req.destroy(new Error('too_large'));
      });
      res.on('end', () => {
        if (res.statusCode === 200 && body.length <= MAX_INFO_BYTES) info = parseJson(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => {});
    req.on('close', () => {
      c.probing = false;
      if (info) this.probeOk(c, info);
      else this.probeFailed(c);
    });
  }

  probeOk(c, info) {
    const self = this.getInfo().id;
    if (info.id === self) {
      this.candidates.delete(hostPort(c.host, c.port));
      return;
    }
    if (!isId(info.id) || info.v !== LAN_PROTOCOL || (info.ns || DEFAULT_SERVICE_TYPE) !== this.serviceType) return this.probeFailed(c);
    c.peerId = info.id;
    c.failures = 0;
    c.lastOk = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (id !== info.id && peer.host === c.host && peer.port === c.port) {
        this.peers.delete(id);
        changed = true;
      }
    }
    const prev = this.peers.get(info.id);
    if (prev && (prev.host !== c.host || prev.port !== c.port)) {
      const old = this.candidates.get(hostPort(prev.host, prev.port));
      if (old && old.lastOk && Date.now() - old.lastOk < PROBE_MS * 2.5) {
        if (changed) this.emit('change');
        return;
      }
    }
    if (!prev && this.peers.size >= MAX_PEERS) {
      if (changed) this.emit('change');
      return;
    }
    const status = STATUSES.has(info.status) ? info.status : 'idle';
    const look = sanitizeLook(info.trainer);
    const peer = { id: info.id, name: sanitizeName(info.name), status, cls: look.cls, palette: look.palette, host: c.host, port: c.port, source: c.source, lastSeen: Date.now() };
    this.peers.set(info.id, peer);
    if (changed || !prev || prev.name !== peer.name || prev.status !== peer.status || prev.cls !== peer.cls || JSON.stringify(prev.palette) !== JSON.stringify(peer.palette) || prev.host !== peer.host || prev.port !== peer.port) this.emit('change');
  }

  /** Bonjour goodbye: drop the peer now instead of after failed polls. */
  onLost(id) {
    let changed = this.peers.delete(id);
    for (const [key, c] of this.candidates) {
      if (c.peerId === id && c.source === 'mdns') {
        this.candidates.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  probeFailed(c) {
    c.failures += 1;
    if (c.failures < PEER_STALE_FAILURES) return;
    for (const [id, peer] of this.peers) {
      if (peer.host === c.host && peer.port === c.port) {
        this.peers.delete(id);
        this.emit('change');
      }
    }
    if (c.source === 'mdns' && c.failures > 10) this.candidates.delete(hostPort(c.host, c.port));
  }

  peerList() {
    return [...this.peers.values()].map(({ id, name, status, cls, palette, host, port, source }) => ({ id, name, status, trainer: { cls, name, palette }, address: hostPort(host, port), source }));
  }

  onHttp(req, res) {
    if (req.method === 'GET' && req.url === '/info') {
      const info = this.getInfo();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ id: info.id, name: info.name, status: info.status, trainer: { cls: info.cls, name: info.name, palette: info.palette }, ns: this.serviceType, v: LAN_PROTOCOL }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  onUpgrade(req, socket, head) {
    const ip = req.socket.remoteAddress || 'unknown';
    const perIp = this.inboundPerIp.get(ip) || 0;
    if (req.url !== '/battle' || this.inboundCount >= MAX_INBOUND || perIp >= MAX_INBOUND_PER_IP || req.headers.origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.inboundCount += 1;
      this.inboundPerIp.set(ip, perIp + 1);
      const link = new PeerLink(ws, { remoteAddress: ip });
      link.on('close', () => {
        this.inboundCount -= 1;
        const n = (this.inboundPerIp.get(ip) || 1) - 1;
        if (n <= 0) this.inboundPerIp.delete(ip);
        else this.inboundPerIp.set(ip, n);
      });
      this.emit('inbound', link);
    });
  }

  /** Opens a link to a known peer. Resolves to a PeerLink or rejects. */
  connect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return Promise.reject(new Error('unknown_peer'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${hostPort(peer.host, peer.port)}/battle`, { maxPayload: MAX_PEER_PAYLOAD, handshakeTimeout: 4000 });
      const fail = (err) => reject(new Error(`connect_failed: ${err && err.message}`));
      ws.once('error', fail);
      ws.once('open', () => {
        ws.off('error', fail);
        const link = new PeerLink(ws, { remoteAddress: peer.host });
        link.peerId = peer.id;
        link.peerName = peer.name;
        resolve(link);
      });
    });
  }

  async stop() {
    clearInterval(this.probeTimer);
    clearInterval(this.browseTimer);
    if (this.dnssd) this.dnssd.stop();
    if (this.bonjour) {
      await new Promise((resolve) => {
        try {
          this.bonjour.unpublishAll(() => this.bonjour.destroy(() => resolve()));
        } catch {
          resolve();
        }
        setTimeout(resolve, 1500).unref();
      });
    }
    for (const ws of this.wss ? this.wss.clients : []) ws.terminate();
    if (this.http) await new Promise((resolve) => this.http.close(() => resolve()));
  }
}

function isPeerMessage(msg) {
  return isPlainObject(msg) && typeof msg.t === 'string' && msg.t.length <= 32;
}

module.exports = { Lan, PeerLink, LAN_PROTOCOL, isPeerMessage };
