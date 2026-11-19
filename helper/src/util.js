'use strict';

const crypto = require('crypto');

const NAME_MAX = 18;
const TRAINER_CLASS_COUNT = 30;
const PALETTE_MAX = 8;
const DEFAULT_SERVICE_TYPE = 'pkmn-emerald';
const ID_RE = /^[a-z0-9]{6,32}$/;
const CHOICE_RE = /^(move [1-4]|switch [1-6]|team [1-6]{1,6}|default)$/;
const FORMAT_RE = /^gen[1-9][a-z0-9]{1,40}$/;

function makeId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sanitizeName(raw, fallback = 'Trainer') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : fallback;
}

/** Trainer avatar: class index into the partners extension's 30 classes, optional group colors. Bad input gives the default. */
function sanitizeLook(raw) {
  const look = { cls: 0, palette: null };
  if (!isPlainObject(raw)) return look;
  if (Number.isInteger(raw.cls) && raw.cls >= 0 && raw.cls < TRAINER_CLASS_COUNT) look.cls = raw.cls;
  if (Array.isArray(raw.palette) && raw.palette.length <= PALETTE_MAX) {
    const palette = raw.palette.map((c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null));
    if (palette.some(Boolean)) look.palette = palette;
  }
  return look;
}

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function isChoice(value) {
  return typeof value === 'string' && CHOICE_RE.test(value);
}

function isFormat(value) {
  return typeof value === 'string' && FORMAT_RE.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

class RateLimiter {
  constructor({ perSecond, burst }) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function hostPort(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function log(...args) {
  if (process.env.PKMN_QUIET === '1') return;
  console.log(new Date().toISOString(), ...args);
}

module.exports = {
  NAME_MAX,
  TRAINER_CLASS_COUNT,
  DEFAULT_SERVICE_TYPE,
  sanitizeLook,
  makeId,
  sanitizeName,
  isId,
  isChoice,
  isFormat,
  isPlainObject,
  parseJson,
  RateLimiter,
  hostPort,
  log,
};
