'use strict';

const net = require('net');
const { Helper } = require('./helper');
const { log } = require('./util');

const DEFAULTS = {
  port: 41851,
  lanPort: 41852,
  lanHost: '0.0.0.0',
  format: 'gen3randombattle',
  name: 'Trainer',
  lan: true,
  discovery: 'auto',
  lanTimerSeconds: 150,
  cpuTimerSeconds: 0,
  challengeCooldownSeconds: 15,
  serviceType: 'pkmn-emerald',
  allowedOrigins: ['https://claude.ai'],
  peers: [],
};

function parseArgs(argv, env) {
  const config = { ...DEFAULTS };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be an integer 0-65535`);
    return n;
  };
  if (env.PKMN_PORT) config.port = num(env.PKMN_PORT, 'PKMN_PORT');
  if (env.PKMN_LAN_PORT) config.lanPort = num(env.PKMN_LAN_PORT, 'PKMN_LAN_PORT');
  if (env.PKMN_NAME) config.name = env.PKMN_NAME;
  if (env.PKMN_FORMAT) config.format = env.PKMN_FORMAT;
  if (env.PKMN_ALLOWED_ORIGINS) config.allowedOrigins = env.PKMN_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.PKMN_DISCOVERY) config.discovery = oneOf(env.PKMN_DISCOVERY, ['auto', 'dnssd', 'mdns', 'off'], 'PKMN_DISCOVERY');
  if (env.PKMN_SERVICE_TYPE) config.serviceType = serviceType(env.PKMN_SERVICE_TYPE);
  if (env.PKMN_PEERS) config.peers = parsePeers(env.PKMN_PEERS, config.lanPort);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--port') config.port = num(next(), arg);
    else if (arg === '--lan-port') config.lanPort = num(next(), arg);
    else if (arg === '--lan-host') config.lanHost = next();
    else if (arg === '--name') config.name = next();
    else if (arg === '--format') config.format = next();
    else if (arg === '--no-lan') config.lan = false;
    else if (arg === '--no-mdns') config.discovery = 'off';
    else if (arg === '--discovery') config.discovery = oneOf(next(), ['auto', 'dnssd', 'mdns', 'off'], arg);
    else if (arg === '--peer') config.peers.push(...parsePeers(next(), config.lanPort));
    else if (arg === '--lan-timer') config.lanTimerSeconds = num(next(), arg);
    else if (arg === '--cpu-timer') config.cpuTimerSeconds = num(next(), arg);
    else if (arg === '--service-type') config.serviceType = serviceType(next());
    else if (arg === '--challenge-cooldown') config.challengeCooldownSeconds = num(next(), arg);
    else if (arg === '--allow-origin') config.allowedOrigins.push(next());
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: start.sh [--port 41851] [--lan-port 41852] [--lan-host 0.0.0.0] [--name NAME] [--format gen3randombattle]\n'
        + '                [--no-lan] [--discovery auto|dnssd|mdns|off] [--no-mdns] [--peer host:port] [--lan-timer 150] [--cpu-timer 0] [--challenge-cooldown 15] [--service-type pkmn-emerald] [--allow-origin URL]');
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return config;
}

function serviceType(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,14}$/.test(value)) throw new Error('--service-type must be 1-15 lowercase letters, digits or hyphens');
  return value;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value;
}

function parsePeers(text, defaultPort) {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((hp) => {
    const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(hp);
    if (bracketed) return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
    if (net.isIPv6(hp)) return { host: hp, port: defaultPort };
    const [host, port] = hp.split(':');
    return { host, port: port ? Number(port) : defaultPort };
  });
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const helper = new Helper(config);
  try {
    await helper.start();
  } catch (err) {
    console.error(`failed to start: ${err.message}`);
    process.exit(1);
  }
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`[helper] ${signal}, shutting down`);
    setTimeout(() => process.exit(0), 3000).unref();
    await helper.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log('[helper] uncaught', err));
  process.on('unhandledRejection', (err) => log('[helper] unhandled rejection', err));
}

if (require.main === module) void main();

module.exports = { parseArgs, DEFAULTS };
