import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H, mapInfo, SHAPES, Terrain, W, WATER_Y } from '../src/shared/artillery/terrain.ts';
import { Sim, walk, WORM_R } from '../src/shared/artillery/sim.ts';
import type { ArtState, Worm } from '../src/shared/artillery/types.ts';
import { artillery, HEROES, politicianNames, VILLAINS } from '../src/server/games/artillery.ts';
import { clock, fakeRoom } from './fake-room.ts';

const room = (ids: string[]) => {
  const r = fakeRoom(artillery, ids);
  return { ...r, s: r.s as ArtState };
};
// Shorthand so the tests read like the old helper.
const nowOf = () => clock.now;

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
  r.advance(endsAt - nowOf() + 10); // past the original deadline
  assert.equal(r.s.turn!.no, no);
  r.advance(r.s.turn!.endsAt - nowOf() + 10);
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

// ---- physics and map generation ----

/** A flat test map: solid from `ground` down, optional slope rising to the right from `slopeX`. */
function flatTerrain(ground = 400, slopeX = Infinity, rise = 0) {
  const t = new Terrain();
  for (let x = 0; x < W; x++) {
    const top = x < slopeX ? ground : Math.max(150, Math.round(ground - (x - slopeX) * rise));
    for (let y = top; y < H; y++) t.mask[y * W + x] = 1;
  }
  return t;
}

const worm = (id: number, x: number, y: number): Worm => ({ id, team: 0, name: 'w', x, y, hp: 100, alive: true, facing: 1 });

test('a rolling grenade bounces off a worm instead of passing through', () => {
  const roll = (withTarget: boolean) => {
    const thrower = worm(0, 300, 400 - WORM_R - 1);
    const worms = withTarget ? [thrower, worm(1, 420, 400 - WORM_R - 1)] : [thrower];
    const sim = new Sim(flatTerrain(), worms, [], 0);
    sim.launch('grenade', 320, 400 - 6, 260, 0, 0);
    const tl = sim.run();
    const g = tl.tracks.find((tr) => tr.kind === 'grenade')!;
    return { maxX: Math.max(...g.pts.filter((_, i) => i % 2 === 0)), tl };
  };
  // On open ground it rolls well past where the worm will stand...
  assert.ok(roll(false).maxX > 440);
  // ...but with the worm there it bounces back.
  const hit = roll(true);
  assert.ok(hit.maxX < 420, `grenade got to x=${hit.maxX}, past the worm at 420`);
  assert.ok(hit.tl.events.some((e) => e.type === 'bounce' && e.wormId === 1));
});

test('worms can walk up steep (but not vertical) slopes', () => {
  const steep = flatTerrain(400, 500, 1.3); // about 52 degrees
  const w = worm(0, 480, 400 - WORM_R - 1);
  for (let i = 0; i < 40; i++) walk(steep, w, 1, 3);
  assert.ok(w.x > 560, `stopped at x=${w.x}`);

  const wall = flatTerrain(400, 500, 8);
  const v = worm(0, 480, 400 - WORM_R - 1);
  for (let i = 0; i < 40; i++) walk(wall, v, 1, 3);
  assert.ok(v.x < 500, 'walked up a wall');
});

test('walking is not cut short by a per-turn budget', () => {
  const r = startMatch(['a', 'b']);
  const pid = r.s.teams[r.s.turn!.team].playerId;
  const w = r.s.worms.find((x) => x.id === r.s.turn!.wormId)!;
  let moved = 0;
  for (let i = 0; i < 200; i++) {
    const x = w.x;
    r.advance(40);
    r.act(pid, { a: 'walk', dir: i < 100 ? 1 : -1 });
    moved += Math.abs(w.x - x);
  }
  // 200 steps of 3px. Walls can stop us, but there's no fixed cap any more.
  assert.equal('walkLeft' in r.s.turn!, false);
  assert.ok(moved > 0);
});

test('every map shape and theme generates the same way twice', () => {
  const seen = new Set<string>();
  for (let seed = 1; seen.size < SHAPES.length * 2 && seed < 400; seed++) {
    const s = seed * 7919;
    const { shape, theme } = mapInfo(s);
    if (seen.has(shape) && seed > 40) continue;
    seen.add(shape);
    seen.add(theme);
    const a = Terrain.generate(s, [[300, 300, 40]]);
    const b = Terrain.generate(s, [[300, 300, 40]]);
    assert.equal(a.theme, theme);
    assert.deepEqual(a.mask, b.mask);
    assert.deepEqual(a.mat, b.mat);
  }
  for (const shape of SHAPES) assert.ok(seen.has(shape), `never generated ${shape}`);
});

test('worms always spawn on dry land, even on full six-team maps', () => {
  for (let run = 0; run < 15; run++) {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const r = startMatch(ids, 4);
    assert.equal(r.s.worms.length, 24);
    for (const w of r.s.worms) assert.ok(w.y < WATER_Y - 40, `worm at y=${w.y} on seed ${r.s.seed}`);
  }
});

test('worms are named after politicians, each team getting a mix', () => {
  const r = startMatch(['a', 'b', 'c'], 2);
  for (let team = 0; team < 3; team++) {
    const names = r.s.worms.filter((w) => w.team === team).map((w) => w.name);
    assert.equal(names.filter((n) => HEROES.includes(n)).length, 1);
    assert.equal(names.filter((n) => VILLAINS.includes(n)).length, 1);
  }
  assert.equal(new Set(politicianNames(30)).size, 30);
});
