// The newer weapons (bat, doctor, sheep, @everyone, …), fall damage, and the
// rules around them: getting hurt ends your turn, crates don't land on worms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H, Terrain, W, WATER_Y } from '../src/shared/artillery/terrain.ts';
import { fire, Sim, WORM_R } from '../src/shared/artillery/sim.ts';
import { WEAPONS, type ArtEvent, type ArtState, type Timeline, type Worm } from '../src/shared/artillery/types.ts';
import { artillery } from '../src/server/games/artillery.ts';
import { fakeRoom } from './fake-room.ts';

/** Solid from `ground` down, with an optional wall `wallH` px tall at x = wallX. */
function flat(ground = 400, wallX = -1, wallH = 0) {
  const t = new Terrain();
  for (let x = 0; x < W; x++) {
    const top = Math.abs(x - wallX) < 6 ? ground - wallH : ground;
    for (let y = top; y < H; y++) t.mask[y * W + x] = 1;
  }
  return t;
}
const FLOOR = 400 - WORM_R - 1;
const worm = (id: number, team: number, x: number, hp = 100): Worm => ({ id, team, name: 'w', x, y: FLOOR, hp, alive: true, facing: 1 });
const dmg = (tl: Timeline, id: number) => tl.events.filter((e) => e.type === 'damage' && e.wormId === id).reduce((a, e) => a + e.amount!, 0);

test('every weapon has a name, a phrase and a hint', () => {
  for (const w of WEAPONS) assert.ok(w.name && w.phrase && w.hint, w.id);
  assert.equal(new Set(WEAPONS.map((w) => w.id)).size, WEAPONS.length);
});

test('the baseball bat whacks the worm next to you across the map', () => {
  const me = worm(0, 0, 300);
  const them = worm(1, 1, 316);
  const sim = new Sim(flat(), [me, them], [], 0);
  assert.ok(fire(sim, flat(), me, 'bat', -0.5, 1));
  const tl = sim.run();
  assert.ok(dmg(tl, 1) >= 30);
  assert.ok(them.x > 450, `only flew to x=${them.x}`);
  assert.equal(dmg(tl, 0), 0);
});

test('Dr. Carl Johan heals your own worms and gives everyone else side effects', () => {
  const t = flat();
  const me = worm(0, 0, 200);
  const friend = worm(1, 0, 600, 50);
  const foe = worm(2, 1, 630);
  const sim = new Sim(t, [me, friend, foe], [], 0);
  // Drop the syringe straight onto the pair.
  const p = sim.launch('syringe', 615, 350, 0, 0, 0);
  assert.ok(p);
  const tl = sim.run();
  assert.equal(friend.hp, 80);
  assert.ok(tl.events.some((e) => e.type === 'heal' && e.wormId === 1 && e.amount === 30));
  assert.ok(foe.hp < 100);
  assert.ok(!tl.events.some((e) => e.type === 'explode'), 'no crater');
});

test("Fälldin's sheep walks, hops a wall and blows up on a worm", () => {
  const t = flat(400, 400, 14);
  const me = worm(0, 0, 300);
  const foe = worm(1, 1, 520);
  const sim = new Sim(t, [me, foe], [], 0);
  fire(sim, t, me, 'sheep', 0, 0.5);
  const tl = sim.run();
  assert.ok(tl.events.some((e) => e.type === 'jump' && e.kind === 'sheep'), 'never hopped');
  const boom = tl.events.find((e) => e.type === 'explode' && e.kind === 'sheep');
  assert.ok(boom && boom.x > 480, `exploded at ${boom?.x}`);
  assert.ok(dmg(tl, 1) > 30);
});

test('Hayalo @everyone zaps every enemy worm and spares your team', () => {
  const t = flat();
  const worms = [worm(0, 0, 100), worm(1, 0, 300), worm(2, 1, 600), worm(3, 1, 900), worm(4, 2, 1100)];
  const sim = new Sim(t, worms, [], 0);
  fire(sim, t, worms[0], 'everyone', 0, 0);
  const tl = sim.run();
  assert.deepEqual(tl.events.filter((e) => e.type === 'zap').map((e) => e.wormId), [2, 3, 4]);
  assert.equal(dmg(tl, 0) + dmg(tl, 1), 0);
  // A jolt, not a blast: no extra fall damage on top.
  assert.equal(dmg(tl, 2), 20);
});

test('surströmming hurts everyone nearby without making a crater', () => {
  const t = flat();
  const a = worm(0, 0, 500);
  const b = worm(1, 1, 530);
  const far = worm(2, 1, 900);
  const sim = new Sim(t, [a, b, far], [], 0);
  sim.launch('can', 515, 360, 0, 0, 2);
  const tl = sim.run();
  assert.ok(dmg(tl, 0) > 0 && dmg(tl, 1) > 0);
  assert.equal(dmg(tl, 2), 0);
  assert.ok(!tl.events.some((e) => e.type === 'explode'));
});

test('banana bombs and roses split into smaller bombs', () => {
  for (const [weapon, child, n] of [['banana', 'minibanana', 5], ['rose', 'petal', 6]] as const) {
    const t = flat();
    const me = worm(0, 0, 300);
    const sim = new Sim(t, [me], [], 0);
    fire(sim, t, me, weapon, -1, 0.5);
    const tl = sim.run();
    assert.equal(tl.tracks.filter((tr) => tr.kind === child).length, n, weapon);
  }
});

test("Per Albin's folkhem drops from the sky onto the target", () => {
  const t = flat();
  const me = worm(0, 0, 200);
  const sim = new Sim(t, [me], [], 0);
  assert.ok(fire(sim, t, me, 'folkhem', 0, 0, 700, 300));
  const boom = sim.run().events.find((e) => e.type === 'explode' && e.kind === 'house');
  assert.ok(boom && Math.abs(boom.x - 700) < 2 && Math.abs(boom.y - 400) < 8);
});

test('a long fall hurts more than it used to', () => {
  const t = flat();
  const w = worm(0, 0, 500);
  w.y = 400 - 200; // 190 px up in the air
  const tl = new Sim(t, [w], [], 0).run();
  assert.ok(dmg(tl, 0) >= 15, `fall did ${dmg(tl, 0)}`);
});

// ---- server rules ----

function match(crates = false) {
  const r = fakeRoom(artillery, ['a', 'b']);
  const s = r.s as ArtState;
  r.act('a', { a: 'join' });
  r.act('b', { a: 'join' });
  r.act('a', { a: 'settings', wormsPerTeam: 3, crates, suddenDeath: 0 });
  r.act('a', { a: 'start' });
  return { ...r, s };
}
const timelines = (events: unknown[]) => (events as ArtEvent[]).filter((e): e is Extract<ArtEvent, { type: 'timeline' }> => e.type === 'timeline');

test('getting hurt by your own fall ends your turn', () => {
  const r = match();
  const s = r.s;
  const t = Terrain.generate(s.seed, s.craters);
  const w = s.worms.find((x) => x.id === s.turn!.wormId)!;
  // Lift the worm high above open ground and let it step off.
  let x = 100;
  while (x < W - 100 && !(t.surfaceY(x) > 320 && t.surfaceY(x) < WATER_Y - 20 && t.surfaceY(x + 4) > 320)) x++;
  w.x = x;
  w.y = t.surfaceY(x) - 300;
  const pid = s.teams[s.turn!.team].playerId;
  const turnNo = s.turn!.no;
  r.act(pid, { a: 'walk', dir: 1 });
  const tl = timelines(r.events).at(-1)!.tl;
  assert.ok(tl.events.some((e) => e.type === 'damage' && e.wormId === w.id), 'the fall did no damage');
  assert.equal(s.phase, 'resolving');
  r.advance(15_000);
  assert.ok(s.turn!.no > turnNo);
});

test('crates never drop onto a worm', () => {
  const r = match(true);
  for (let i = 0; i < 40; i++) r.advance(r.s.turnSeconds * 1000 + 1);
  let drops = 0;
  for (const { tl } of timelines(r.events)) {
    for (const e of tl.events) {
      if (e.type !== 'crate' || e.kind !== 'drop') continue;
      drops++;
      for (const w of tl.before) if (w.alive) assert.ok(Math.abs(w.x - e.x) >= 45, `crate at ${e.x}, worm at ${w.x}`);
    }
  }
  assert.ok(drops > 0);
});
