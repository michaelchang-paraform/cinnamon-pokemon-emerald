'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Claude spend per local day, kept in <stateDir>/claude-spend.json. */
class DailySpend {
  constructor({ stateDir = path.join(os.homedir(), '.pokemon-emerald'), limitUsd }) {
    this.file = path.join(stateDir, 'claude-spend.json');
    this.limitUsd = limitUsd;
    this.state = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.day === 'string' && Number.isFinite(raw.usd) && raw.usd >= 0) return { day: raw.day, usd: raw.usd };
    } catch {
      // missing or unreadable: start the day at zero
    }
    return { day: localDay(), usd: 0 };
  }

  today() {
    const day = localDay();
    if (this.state.day !== day) this.state = { day, usd: 0 };
    return this.state.usd;
  }

  reached() {
    return this.today() >= this.limitUsd;
  }

  add(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.today();
    this.state.usd = Math.round((this.state.usd + usd) * 1e6) / 1e6;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch {
      // keep counting in memory if the disk write fails
    }
  }
}

module.exports = { DailySpend, localDay };
