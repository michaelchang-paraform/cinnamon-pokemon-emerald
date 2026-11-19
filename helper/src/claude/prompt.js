'use strict';

const { Dex } = require('pokemon-showdown');

const STATUS = { brn: 'burned', par: 'paralyzed', slp: 'asleep', frz: 'frozen', psn: 'poisoned', tox: 'badly poisoned' };

/**
 * Battle view for one side, built only from that side's player stream.
 * feed() every line, then build(request) for the prompt text and the legal action ids.
 */
class BattleView {
  constructor({ side, format }) {
    this.side = side;
    this.dex = Dex.forFormat(format);
    this.turn = 0;
    this.weather = null;
    this.foeActive = null;
    this.foeSeen = new Map();
    this.fields = { mine: new Set(), foe: new Set() };
    this.recent = [];
  }

  isMine(ident) {
    return typeof ident === 'string' && ident.startsWith(this.side);
  }

  foe(ident, details) {
    const nick = ident.split(': ')[1] || ident;
    let mon = this.foeSeen.get(nick);
    if (!mon) {
      mon = { nick, species: nick, level: null, hp: '100/100', status: null, moves: new Set(), item: null, ability: null, boosts: {} };
      this.foeSeen.set(nick, mon);
    }
    if (details) {
      const [species, ...rest] = details.split(', ');
      mon.species = species;
      const lv = rest.find((r) => /^L\d+$/.test(r));
      mon.level = lv ? Number(lv.slice(1)) : 100;
    }
    return mon;
  }

  feed(line) {
    if (!line.startsWith('|')) return;
    const parts = line.split('|');
    const cmd = parts[1];
    const ident = parts[2] || '';
    if (cmd === 'turn') {
      this.turn = Number(parts[2]) || this.turn;
      return;
    }
    if (cmd === 'request' || cmd === 't:' || cmd === '' || cmd === 'upkeep') return;
    if (['player', 'teamsize', 'gen', 'tier', 'rule', 'gametype', 'start', 'title', 'j', 'c', 'raw', 'html'].includes(cmd)) return;
    this.recent.push(this.describe(parts));
    if (this.recent.length > 40) this.recent.shift();
    if (['switch', 'drag', 'replace'].includes(cmd) && !this.isMine(ident)) {
      const mon = this.foe(ident, parts[3]);
      this.setHp(mon, parts[4]);
      mon.boosts = {};
      this.foeActive = mon;
    } else if (['-damage', '-heal', '-sethp'].includes(cmd) && !this.isMine(ident)) {
      this.setHp(this.foe(ident), parts[3]);
    } else if (cmd === '-status' && !this.isMine(ident)) {
      this.foe(ident).status = parts[3];
    } else if (cmd === '-curestatus' && !this.isMine(ident)) {
      this.foe(ident).status = null;
    } else if ((cmd === '-boost' || cmd === '-unboost') && !this.isMine(ident)) {
      const mon = this.foe(ident);
      const delta = (cmd === '-boost' ? 1 : -1) * (Number(parts[4]) || 0);
      mon.boosts[parts[3]] = (mon.boosts[parts[3]] || 0) + delta;
    } else if (cmd === 'move' && !this.isMine(ident)) {
      this.foe(ident).moves.add(parts[3]);
    } else if ((cmd === '-item' || cmd === '-enditem') && !this.isMine(ident)) {
      this.foe(ident).item = parts[3];
    } else if (cmd === '-ability' && !this.isMine(ident)) {
      this.foe(ident).ability = parts[3];
    } else if (cmd === 'faint' && !this.isMine(ident)) {
      this.foe(ident).hp = '0 fnt';
    } else if (cmd === '-weather') {
      this.weather = parts[2] === 'none' ? null : parts[2];
    } else if (cmd === '-sidestart' || cmd === '-sideend') {
      const set = (parts[2] || '').startsWith(this.side) ? this.fields.mine : this.fields.foe;
      const what = (parts[3] || '').replace(/^move: /, '');
      if (cmd === '-sidestart') set.add(what);
      else set.delete(what);
    }
  }

  setHp(mon, hp) {
    if (!hp) return;
    const [value, status] = hp.split(' ');
    mon.hp = value;
    mon.status = status === 'fnt' ? null : status || mon.status;
    if (status === 'fnt' || value === '0') mon.hp = '0 fnt';
  }

  describe(parts) {
    const who = (ident) => {
      if (!ident) return '';
      const nick = ident.split(': ')[1] || ident;
      return this.isMine(ident) ? `your ${nick}` : `foe ${nick}`;
    };
    const cmd = parts[1];
    if (cmd === 'move') return `${who(parts[2])} used ${parts[3]}`;
    if (cmd === 'switch' || cmd === 'drag') return `${who(parts[2])} came in`;
    if (cmd === '-damage') return `${who(parts[2])} took damage, HP ${parts[3]}${parts[4] ? ` ${parts[4]}` : ''}`;
    if (cmd === '-heal') return `${who(parts[2])} healed, HP ${parts[3]}`;
    if (cmd === 'faint') return `${who(parts[2])} fainted`;
    if (cmd === '-supereffective') return "it's super effective";
    if (cmd === '-resisted') return "it's not very effective";
    if (cmd === '-immune') return `${who(parts[2])} is immune`;
    if (cmd === '-crit') return 'critical hit';
    if (cmd === '-miss') return `${who(parts[2])} missed`;
    if (cmd === '-status') return `${who(parts[2])} is now ${STATUS[parts[3]] || parts[3]}`;
    if (cmd === 'cant') return `${who(parts[2])} can't move (${parts[3]})`;
    return parts.slice(1).filter(Boolean).join(' ');
  }

  moveText(id) {
    const move = this.dex.moves.get(id);
    if (!move.exists) return id;
    const power = move.basePower ? `power ${move.basePower}` : 'status';
    const acc = move.accuracy === true ? 'never misses' : `accuracy ${move.accuracy}`;
    return `${move.name} (${move.type}, ${power}, ${acc})`;
  }

  speciesText(name) {
    const species = this.dex.species.get(name);
    return species.exists ? `${species.name} (${species.types.join('/')})` : name;
  }

  /** Legal Showdown choice strings with labels for this request. */
  legalActions(request) {
    const actions = [];
    if (!request || request.wait || request.teamPreview) return actions;
    const mons = request.side.pokemon;
    const active = request.active && request.active[0];
    if (!request.forceSwitch && active) {
      active.moves.forEach((m, i) => {
        if (m.disabled || (m.pp !== undefined && m.pp <= 0 && m.id !== 'struggle')) return;
        actions.push({ id: `move ${i + 1}`, label: m.move });
      });
    }
    const trapped = active && !request.forceSwitch && (active.trapped || active.maybeTrapped);
    if (!trapped) {
      mons.forEach((p, i) => {
        if (p.active || p.condition.endsWith(' fnt')) return;
        actions.push({ id: `switch ${i + 1}`, label: `switch to ${p.details.split(',')[0]}` });
      });
    }
    return actions;
  }

  build(request) {
    const actions = this.legalActions(request);
    const lines = [];
    lines.push(`Turn ${this.turn}.${this.weather ? ` Weather: ${this.weather}.` : ''}`);
    if (this.fields.mine.size) lines.push(`Your side: ${[...this.fields.mine].join(', ')}.`);
    if (this.fields.foe.size) lines.push(`Foe side: ${[...this.fields.foe].join(', ')}.`);
    lines.push('', 'Your team (exact HP):');
    for (const p of request.side.pokemon) {
      const species = p.details.split(',')[0];
      const level = (p.details.match(/L(\d+)/) || [])[1] || '100';
      const [hp, status] = p.condition.split(' ');
      const tag = p.active ? 'ACTIVE ' : '';
      const cond = status === 'fnt' || hp === '0' ? 'fainted' : `HP ${hp}${status ? `, ${STATUS[status] || status}` : ''}`;
      const stats = p.stats ? `atk ${p.stats.atk} def ${p.stats.def} spa ${p.stats.spa} spd ${p.stats.spd} spe ${p.stats.spe}` : '';
      lines.push(`- ${tag}${this.speciesText(species)} L${level}, ${cond}, ${stats}, item ${p.item || 'none'}, ability ${p.baseAbility || p.ability || 'unknown'}`);
      lines.push(`  moves: ${p.moves.map((m) => this.moveText(m)).join('; ')}`);
    }
    const active = request.active && request.active[0];
    if (active) {
      const pp = active.moves.map((m) => `${m.move} ${m.pp}/${m.maxpp}${m.disabled ? ' disabled' : ''}`).join(', ');
      lines.push(`Active PP: ${pp}${active.trapped ? '. You are trapped.' : ''}`);
    }
    lines.push('', 'Foe (HP in percent):');
    if (this.foeActive) {
      const f = this.foeActive;
      const boosts = Object.entries(f.boosts).filter(([, v]) => v).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ');
      lines.push(`- ACTIVE ${this.speciesText(f.species)} L${f.level || '?'}, HP ${f.hp}${f.status ? `, ${STATUS[f.status] || f.status}` : ''}${boosts ? `, boosts ${boosts}` : ''}`);
    }
    for (const f of this.foeSeen.values()) {
      const known = [f.moves.size ? `moves seen: ${[...f.moves].join(', ')}` : '', f.item ? `item ${f.item}` : '', f.ability ? `ability ${f.ability}` : ''].filter(Boolean).join(', ');
      if (f === this.foeActive) {
        if (known) lines.push(`  ${known}`);
        continue;
      }
      lines.push(`- ${this.speciesText(f.species)} L${f.level || '?'}, HP ${f.hp}${known ? `, ${known}` : ''}`);
    }
    if (this.recent.length) lines.push('', 'Recent events:', ...this.recent.slice(-15).map((l) => `- ${l}`));
    lines.push('', request.forceSwitch ? 'Your active Pokemon must be replaced. Choose a switch.' : 'Choose your action.');
    lines.push('Legal actions:', ...actions.map((a) => `- ${a.id}: ${a.label}`));
    this.recent = [];
    return { text: lines.join('\n'), actions };
  }
}

module.exports = { BattleView };
