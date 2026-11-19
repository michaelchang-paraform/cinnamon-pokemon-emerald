type Peer = { id: string; name: string; status: string; address: string; source: string; trainer?: unknown };
type ResultInfo = { result: string; reason: string; turns: number; mode: 'cpu' | 'lan'; opponent: string; peerId: string | null; difficulty: string };
const ns = (window as any).__pkb;
const { upper, POKEMON } = ns;

function parsePeerAddress(value: string): { host: string; port: number | undefined } | null {
  const text = value.trim();
  const bracketed = /^\[([0-9A-Fa-f:.]+(?:%[\w.-]+)?)\](?::(\d{1,5}))?$/.exec(text);
  const bareV6 = /^[0-9A-Fa-f]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?$/.test(text) ? [text, text] : null;
  const plain = /^([^\s:[\]]+)(?::(\d{1,5}))?$/.exec(text);
  const match = bracketed ?? bareV6 ?? plain;
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { host: match[1], port };
}

function peerHint(peer: Peer | undefined): string {
  if (!peer) return '';
  const name = upper(peer.name);
  const where = peer.address ? `\n${peer.address}` : '';
  if (peer.status === 'looking') return `${name} is looking for a battle!${where}`;
  if (peer.status === 'idle') return `${name} is around. Challenge?${where}`;
  if (peer.status === 'battling') return `${name} is in a battle.${where}`;
  return `${name} is away.${where}`;
}

function resultReason(r: ResultInfo): string {
  const foe = upper(r.opponent);
  const reasons: Record<string, string> = {
    normal: r.result === 'win' ? `${foe} is out of ${POKEMON}!` : r.result === 'loss' ? `You're out of ${POKEMON}!` : 'Both sides went down.',
    forfeit: 'You forfeited.',
    opponent_forfeit: `${foe} forfeited.`,
    timeout: 'You ran out of time.',
    opponent_timeout: `${foe} ran out of time.`,
    abandoned: 'No battle screen was open.',
    opponent_abandoned: `${foe} left the battle.`,
    opponent_disconnected: `${foe} disconnected.`,
    error: 'The simulator hit an error.',
    shutdown: 'The helper shut down.',
    host_busy: 'The host was busy.',
    start_timeout: "The battle didn't start.",
  };
  return reasons[r.reason] ?? r.reason;
}

Object.assign(ns, { parsePeerAddress, peerHint, resultReason });
