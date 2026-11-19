'use strict';

const fs = require('fs');
const dns = require('dns');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { log } = require('./util');

const DNS_SD = '/usr/bin/dns-sd';
const INSTANCE_RE = /^pkmn-[a-z0-9]{6,32}$/;
const RESOLVE_TIMEOUT_MS = 4000;
const MAX_CONCURRENT_RESOLVES = 4;
const MAX_KNOWN_NAMES = 64;
const RERESOLVE_MS = 60000;
const REGISTER_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
// dns-sd outlives a SIGKILLed node parent; the wrapper kills it once our stdin pipe closes
const WRAPPER = '"$@" & p=$!; trap \'kill $p 2>/dev/null; exit 0\' TERM INT HUP; read _; kill $p 2>/dev/null';

function dnsSdAvailable() {
  return process.platform === 'darwin' && fs.existsSync(DNS_SD);
}

/**
 * Bonjour through macOS mDNSResponder via the dns-sd tool.
 * node's own multicast sockets can be refused (EHOSTUNREACH) by macOS Local Network privacy; the system daemon is not.
 * Emits 'found' with { host, port } (IPv4 address) for each other instance, and 'lost' with the instance name on goodbye.
 */
class DnsSdDiscovery extends EventEmitter {
  constructor({ instance, type, port, txt }) {
    super();
    this.instance = instance;
    this.type = `_${type}._tcp`;
    this.port = port;
    this.txt = txt;
    this.procs = new Set();
    this.stopped = false;
    this.resolving = new Set();
    this.queue = [];
    this.resolvedAt = new Map();
    this.registerFailures = 0;
  }

  start() {
    this.startRegister();
    this.startBrowse();
  }

  startRegister() {
    if (this.stopped) return;
    const txtArgs = Object.entries(this.txt).map(([k, v]) => `${k}=${v}`);
    const startedAt = Date.now();
    this.register = this.run(['-R', this.instance, this.type, 'local', String(this.port), ...txtArgs]);
    this.register.on('exit', () => {
      if (this.stopped) return;
      if (Date.now() - startedAt > 60000) this.registerFailures = 0;
      const delay = REGISTER_BACKOFF_MS[Math.min(this.registerFailures, REGISTER_BACKOFF_MS.length - 1)];
      this.registerFailures += 1;
      log(`[dns-sd] registration exited, retry in ${delay}ms`);
      this.registerTimer = setTimeout(() => this.startRegister(), delay);
    });
  }

  run(args) {
    const proc = spawn('/bin/sh', ['-c', WRAPPER, 'pkmn-dns-sd', DNS_SD, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdout.setEncoding('utf8');
    proc.stdin.on('error', () => {});
    proc.halt = () => {
      try {
        proc.stdin.end();
      } catch {
        // already gone
      }
    };
    this.procs.add(proc);
    proc.on('error', (err) => log('[dns-sd] spawn error', err.message));
    proc.on('exit', () => this.procs.delete(proc));
    return proc;
  }

  onBrowseLine(line) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] !== 'Add' && cols[1] !== 'Rmv') return;
    const name = cols[cols.length - 1];
    if (!INSTANCE_RE.test(name) || name === this.instance) return;
    if (cols[1] === 'Rmv') {
      this.resolvedAt.delete(name);
      this.emit('lost', name);
      return;
    }
    if (this.resolving.has(name) || this.queue.includes(name)) return;
    const last = this.resolvedAt.get(name);
    if (last !== undefined && Date.now() - last < RERESOLVE_MS) return;
    if (last === undefined && this.resolvedAt.size >= MAX_KNOWN_NAMES) this.evictStale();
    if (last === undefined && this.resolvedAt.size >= MAX_KNOWN_NAMES) return;
    if (this.queue.length >= MAX_KNOWN_NAMES) return;
    this.queue.push(name);
    this.pump();
  }

  evictStale() {
    const cutoff = Date.now() - RERESOLVE_MS * 5;
    for (const [name, at] of this.resolvedAt) if (at < cutoff && !this.resolving.has(name)) this.resolvedAt.delete(name);
  }

  pump() {
    while (!this.stopped && this.resolving.size < MAX_CONCURRENT_RESOLVES && this.queue.length) {
      const name = this.queue.shift();
      this.resolvedAt.set(name, Date.now());
      this.resolving.add(name);
      this.resolve(name);
    }
  }

  refresh() {
    if (this.stopped) return;
    if (this.browse) this.browse.halt();
    this.browse = null;
    this.startBrowse();
  }

  startBrowse() {
    this.browse = this.run(['-B', this.type, 'local']);
    let buf = '';
    this.browse.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) buf = '';
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) this.onBrowseLine(line);
    });
  }

  resolve(name) {
    const proc = this.run(['-L', name, this.type, 'local']);
    let out = '';
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      proc.halt();
      this.resolving.delete(name);
      this.pump();
    };
    proc.on('exit', done);
    const timer = setTimeout(done, RESOLVE_TIMEOUT_MS);
    proc.stdout.on('data', (d) => {
      out += d;
      const match = /can be reached at ([A-Za-z0-9.-]{1,253})\.:(\d{1,5})/.exec(out);
      if (!match) return;
      done();
      const port = Number(match[2]);
      dns.lookup(match[1], { family: 4, all: true }, (err, addrs) => {
        if (err || this.stopped) return;
        for (const { address } of addrs.slice(0, 4)) this.emit('found', { host: address, port });
      });
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.registerTimer);
    this.queue = [];
    for (const p of this.procs) p.halt();
    this.procs.clear();
  }
}

module.exports = { DnsSdDiscovery, dnsSdAvailable };
