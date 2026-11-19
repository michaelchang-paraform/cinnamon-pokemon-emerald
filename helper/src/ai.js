'use strict';

const { Dex } = require('pokemon-showdown');
const { RandomPlayerAI } = require('pokemon-showdown/dist/sim/tools/random-player-ai');
const { log } = require('./util');

const HEAL_MOVES = new Set(['recover', 'softboiled', 'milkdrink', 'slackoff', 'rest', 'moonlight', 'morningsun', 'synthesis', 'wish']);

class SmartAI extends RandomPlayerAI {
  constructor({ side, format, write, difficulty }) {
    super({ write }, { seed: undefined });
    this.side = side;
    this.dex = Dex.forFormat(format);
    this.difficulty = difficulty;
    this.foeSpecies = null;
    this.lastRequest = null;
  }

  receiveLine(line) {
    if (line.startsWith('|switch|') || line.startsWith('|drag|') || line.startsWith('|replace|')) {
      const [, , ident, details] = line.split('|');
      if (ident && !ident.startsWith(this.side)) this.foeSpecies = (details || '').split(',')[0];
    }
    if (line.startsWith('|request|')) {
      try {
        this.lastRequest = JSON.parse(line.slice(9));
      } catch {
        this.lastRequest = null;
      }
    }
    super.receiveLine(line);
  }

  receiveError(error) {
    log('[ai] choice error', error.message);
  }

  chooseMove(active, moves) {
    if (this.difficulty === 'random' || !this.foeSpecies) return super.chooseMove(active, moves);
    const foe = this.dex.species.get(this.foeSpecies);
    const me = this.ownActive();
    const myTypes = me ? this.dex.species.get(me.details.split(',')[0]).types : [];
    const hpFraction = me ? this.hpFraction(me.condition) : 1;
    let best = null;
    for (const option of moves) {
      const move = this.dex.moves.get(option.move.move);
      const score = this.scoreMove({ move, foe, myTypes, hpFraction }) * (0.85 + this.prng.random() * 0.3);
      if (!best || score > best.score) best = { score, choice: option.choice };
    }
    return best ? best.choice : super.chooseMove(active, moves);
  }

  scoreMove({ move, foe, myTypes, hpFraction }) {
    if (!move.exists) return 1;
    if (move.category === 'Status') {
      if (HEAL_MOVES.has(move.id)) return hpFraction < 0.45 ? 140 : 5;
      return 25;
    }
    if (!this.dex.getImmunity(move.type, foe.types)) return 0;
    const power = move.basePower || 60;
    const stab = myTypes.includes(move.type) ? 1.5 : 1;
    const effectiveness = 2 ** this.dex.getEffectiveness(move.type, foe.types);
    const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
    const recoilPenalty = move.selfdestruct ? 0.3 : 1;
    return power * stab * effectiveness * accuracy * recoilPenalty;
  }

  ownActive() {
    const pokemon = this.lastRequest && this.lastRequest.side && this.lastRequest.side.pokemon;
    return pokemon ? pokemon.find((p) => p.active) : null;
  }

  hpFraction(condition) {
    const match = /^(\d+)\/(\d+)/.exec(condition || '');
    return match ? Number(match[1]) / Number(match[2]) : 0;
  }
}

module.exports = { SmartAI };
