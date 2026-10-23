import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Terrain } from '../src/shared/artillery/terrain.ts';
import type { ArtState } from '../src/shared/artillery/types.ts';
import type { Player } from '../src/shared/protocol.ts';
import { artillery } from '../src/server/games/artillery.ts';
import type { GameContext } from '../src/server/games/index.ts';

// A fake room with a hand-cranked clock, so timers run only when we say so.
let now = 1_000_000;
const realNow = Date.now;
beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
});

function room(ids: string[]) {
  let players: Player[] = ids.map((id) => ({ id, name: id, avatarUrl: null }));
  let timers: { at: number; fn: () => void }[] = [];
  const ctx: GameContext = {
    broadcast() {},
    emit() {},
    players: () => players,
    hostId: () => players[0]?.id ?? null,
    setTimer: (ms, fn) => void timers.push({ at: now + ms, fn }),
  };
  const s = artillery.create(ctx) as ArtState;
  const act = (pid: string, a: object) => artillery.action(s, pid, a, ctx);
  /** Move the clock forward, firing timers in order (including ones they schedule). */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  const leave = (pid: string) => {
    players = players.filter((p) => p.id !== pid);
    artillery.playerLeft!(s, pid, ctx);
  };
  const rejoin = (pid: string) => players.push({ id: pid, name: pid, avatarUrl: null });
  return { s, ctx, act, advance, leave, rejoin };
}

function startMatch(ids: string[], wormsPerTeam = 2) {
  const r = room(ids);
  for (const id of ids) r.act(id, { a: 'join' });
  r.act(ids[0], { a: 'settings', wormsPerTeam });
  r.act(ids[0], { a: 'start' });
  assert.equal(r.s.phase, 'aiming');
  return r;
}

test('terrain is identical for the same seed and craters', () => {
  const craters: [number, number, number][] = [[400, 300, 30], [700, 350, 64]];
  const a = Terrain.generate(12345, craters);
  const b = Terrain.generate(12345, craters);
  assert.deepEqual(a.mask, b.mask);
  assert.notDeepEqual(a.mask, Terrain.generate(54321, craters).mask);
});

test('surrender ends a two-player match with the other team winning', () => {
  const r = startMatch(['a', 'b']);
  assert.equal(r.act('a', { a: 'surrender' }), undefined);
  assert.equal(r.s.phase, 'over');
  assert.equal(r.s.winner, 1);
  assert.equal(r.s.teams[0].out, 'surrendered');
  assert.ok(r.s.worms.filter((w) => w.team === 0).every((w) => !w.alive));
});

test('surrendering in a three-player match keeps the others playing', () => {
  const r = startMatch(['a', 'b', 'c']);
  const surrenderer = r.s.teams[r.s.turn!.team].playerId;
  r.act(surrenderer, { a: 'surrender' });
  assert.equal(r.s.phase, 'aiming');
  assert.notEqual(r.s.teams[r.s.turn!.team].playerId, surrenderer);
});

test('a player who stays away past the grace period forfeits', () => {
  const r = startMatch(['a', 'b']);
  r.leave('b');
  r.advance(30_000);
  assert.notEqual(r.s.phase, 'over'); // still within the grace period
  r.advance(31_000);
  assert.equal(r.s.phase, 'over');
  assert.equal(r.s.winner, 0);
  assert.equal(r.s.teams[1].out, 'left');
});

test('a player who comes back in time keeps their team', () => {
  const r = startMatch(['a', 'b']);
  r.leave('b');
  r.advance(20_000);
  r.rejoin('b');
  r.advance(60_000);
  assert.equal(r.s.teams[1].out, null);
  assert.ok(r.s.worms.some((w) => w.team === 1 && w.alive));
});

test('each team cycles through its own worms, skipping dead ones', () => {
  const r = startMatch(['a', 'b'], 3);
  const turnsOf = (team: number, n: number) => {
    const seen: number[] = [];
    while (seen.length < n) {
      if (r.s.turn!.team === team) seen.push(r.s.turn!.wormId);
      r.advance(r.s.turnSeconds * 1000 + 1);
    }
    return seen;
  };
  const ids = r.s.worms.filter((w) => w.team === 0).map((w) => w.id);
  assert.deepEqual(turnsOf(0, 4), [...ids, ids[0]]);

  // Kill the middle worm: the rotation should go first, last, first, …
  r.s.worms.find((w) => w.id === ids[1])!.alive = false;
  const after = turnsOf(0, 4);
  assert.ok(!after.includes(ids[1]));
  for (let i = 1; i < after.length; i++) assert.notEqual(after[i], after[i - 1]);
});

test('turn time is extended while a jump animation plays', () => {
  const r = startMatch(['a', 'b']);
  const pid = r.s.teams[r.s.turn!.team].playerId;
  const no = r.s.turn!.no;
  const endsAt = r.s.turn!.endsAt;
  r.act(pid, { a: 'jump' });
  assert.ok(r.s.turn!.endsAt > endsAt);
  r.advance(endsAt - now + 10); // past the original deadline
  assert.equal(r.s.turn!.no, no);
  r.advance(r.s.turn!.endsAt - now + 10);
  assert.notEqual(r.s.turn!.no, no);
});

test('players who left are dropped when the host goes back to the lobby', () => {
  const r = startMatch(['a', 'b', 'c']);
  r.leave('c');
  r.act('a', { a: 'surrender' });
  r.act('b', { a: 'surrender' });
  assert.equal(r.s.phase, 'over');
  r.act('a', { a: 'restart' });
  assert.deepEqual(r.s.teams.map((t) => t.playerId), ['a', 'b']);
  assert.ok(r.s.teams.every((t) => t.out === null));
});
