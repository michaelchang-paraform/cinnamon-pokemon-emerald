'use strict';

const { EventEmitter } = require('events');
const { BattleStream, getPlayerStreams } = require('pokemon-showdown');
const { makeId, isChoice, log } = require('./util');

const SIDES = ['p1', 'p2'];

/**
 * One Showdown battle run in-process. Each side has a seat:
 *   { kind: 'human', name, send(msg) }   gets protocol envelopes (battle / request / choice_error / timer)
 *   { kind: 'ai', name, feed(line) }     gets raw Showdown lines, answers through session.choose(side, choice, { trusted: true })
 * Emits 'end' with { winnerSide, reason, turns }.
 */
class BattleSession extends EventEmitter {
  constructor({ format, seats, timerSeconds = 0 }) {
    super();
    this.id = makeId(6);
    this.format = format;
    this.seats = seats;
    this.timerSeconds = timerSeconds;
    this.turn = 0;
    this.ended = false;
    this.endInfo = null;
    this.state = {};
    for (const side of SIDES) {
      this.state[side] = { log: [], request: null, seq: 0, awaiting: false, deadline: 0, timer: null, warned: false, timeouts: 0 };
    }
    this.stream = new BattleStream();
    this.players = getPlayerStreams(this.stream);
  }

  start() {
    for (const side of SIDES) void this.pump(side);
    void this.drainOmniscient();
    this.stream.write(`>start ${JSON.stringify({ formatid: this.format })}`);
    for (const side of SIDES) {
      this.stream.write(`>player ${side} ${JSON.stringify({ name: this.seats[side].name })}`);
    }
  }

  async drainOmniscient() {
    try {
      for await (const chunk of this.players.omniscient) void chunk;
    } catch {
      // stream closed
    }
  }

  async pump(side) {
    try {
      for await (const chunk of this.players[side]) this.receive(side, chunk);
    } catch (err) {
      log('[battle] stream error', side, err && err.message);
      this.finish({ winnerSide: null, reason: 'error' });
    }
  }

  receive(side, chunk) {
    const seat = this.seats[side];
    const lines = chunk.split('\n');
    const visible = [];
    for (const line of lines) {
      if (seat.kind === 'ai') seat.feed(line);
      if (line.startsWith('|request|')) {
        this.onRequest(side, line.slice(9));
        continue;
      }
      if (line.startsWith('|error|')) {
        this.onChoiceError(side, line.slice(7));
        continue;
      }
      if (line.startsWith('|turn|')) this.turn = Math.max(this.turn, Number(line.slice(6)) || 0);
      visible.push(line);
    }
    const trimmed = visible.filter((line) => line !== '');
    if (trimmed.length) {
      this.state[side].log.push(...trimmed);
      if (seat.kind === 'human') seat.send({ type: 'battle', battleId: this.id, lines: trimmed });
    }
    for (const line of trimmed) {
      if (line.startsWith('|win|')) {
        const winnerName = line.slice(5);
        const winnerSide = SIDES.find((s) => this.seats[s].name === winnerName) || null;
        this.finish({ winnerSide, reason: this.pendingReason || 'normal' });
      } else if (line === '|tie') {
        this.finish({ winnerSide: null, reason: this.pendingReason || 'normal' });
      }
    }
  }

  onRequest(side, json) {
    let request;
    try {
      request = JSON.parse(json);
    } catch {
      return;
    }
    const st = this.state[side];
    st.request = request;
    st.seq += 1;
    st.awaiting = !request.wait;
    if (this.seats[side].kind === 'human') {
      this.seats[side].send({ type: 'request', battleId: this.id, rqid: st.seq, request });
      if (st.awaiting) this.armTimer(side);
    }
  }

  onChoiceError(side, message) {
    const st = this.state[side];
    if (this.seats[side].kind === 'human') {
      this.seats[side].send({ type: 'choice_error', battleId: this.id, message });
      if (st.request && !st.request.wait) {
        st.awaiting = true;
        this.armTimer(side, true);
      }
    }
  }

  /** Returns null on success or an error string. */
  choose(side, choice, { rqid, trusted = false } = {}) {
    if (this.ended) return 'battle_over';
    const st = this.state[side];
    if (!trusted) {
      if (!isChoice(choice)) return 'invalid_choice';
      if (!st.request || !st.awaiting) return 'not_your_turn';
      if (rqid !== undefined && rqid !== null && rqid !== st.seq) return 'stale_request';
    }
    st.awaiting = false;
    st.timeouts = 0;
    this.clearTimer(side);
    const write = () => {
      if (!this.ended) this.stream.write(`>${side} ${choice}`);
    };
    if (trusted) setImmediate(write);
    else write();
    return null;
  }

  forfeit(side, reason = 'forfeit') {
    if (this.ended) return;
    this.pendingReason = reason;
    this.stream.write(`>forcelose ${side}`);
    setTimeout(() => {
      if (!this.ended) this.finish({ winnerSide: other(side), reason });
    }, 200);
  }

  /** Ends without a sim verdict, for a vanished peer. */
  abort({ winnerSide, reason }) {
    this.finish({ winnerSide, reason });
  }

  armTimer(side, keepDeadline = false) {
    if (!this.timerSeconds || this.ended) return;
    const st = this.state[side];
    this.clearTimer(side);
    if (!keepDeadline || !st.deadline) st.deadline = Date.now() + this.timerSeconds * 1000;
    st.warned = false;
    const tick = () => {
      if (this.ended || !st.awaiting) return;
      const left = Math.ceil((st.deadline - Date.now()) / 1000);
      if (left <= 0) {
        this.forfeit(side, 'timeout');
        return;
      }
      if (!st.warned && left <= 30) {
        st.warned = true;
        this.broadcastTimer(side, left);
      }
      st.timer = setTimeout(tick, Math.min(1000, left * 1000));
    };
    this.broadcastTimer(side, Math.ceil((st.deadline - Date.now()) / 1000));
    st.timer = setTimeout(tick, 1000);
  }

  broadcastTimer(side, secondsLeft) {
    for (const s of SIDES) {
      const seat = this.seats[s];
      if (seat.kind === 'human') seat.send({ type: 'timer', battleId: this.id, side, secondsLeft, forYou: s === side });
    }
  }

  clearTimer(side) {
    const st = this.state[side];
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
  }

  finish({ winnerSide, reason }) {
    if (this.ended) return;
    this.ended = true;
    for (const side of SIDES) {
      this.clearTimer(side);
      this.state[side].deadline = 0;
    }
    this.endInfo = { winnerSide, reason, turns: this.turn };
    // the other side's final chunk is still queued; let it out before end
    setImmediate(() => {
      this.emit('end', this.endInfo);
      try {
        void this.stream.writeEnd();
      } catch {
        // already closed
      }
    });
  }

  /** Running choice clocks: [{ side, secondsLeft }]. */
  timers() {
    if (this.ended || !this.timerSeconds) return [];
    return SIDES.filter((s) => this.state[s].awaiting && this.state[s].deadline).map((s) => ({ side: s, secondsLeft: Math.max(0, Math.ceil((this.state[s].deadline - Date.now()) / 1000)) }));
  }

  snapshot(side) {
    const st = this.state[side];
    return { log: st.log.slice(), request: st.awaiting ? st.request : null, rqid: st.seq, timers: this.timers() };
  }
}

function other(side) {
  return side === 'p1' ? 'p2' : 'p1';
}

module.exports = { BattleSession, other };
