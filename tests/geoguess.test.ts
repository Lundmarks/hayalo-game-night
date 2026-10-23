import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoundPhoto } from '../src/server/geo/photos.ts';
import { createGeoGame } from '../src/server/games/geoguess.ts';
import { distanceKm, distancePoints, RUSH_SECONDS, REVEAL_SECONDS, speedBonus, type GeoState } from '../src/shared/geo.ts';
import { fakeRoom } from './fake-room.ts';

// Photos of Stockholm, with ids counting up. `fail` makes the next load throw.
function fakeSource() {
  let id = 0;
  const src = {
    fail: false,
    calls: 0,
    source: async (): Promise<RoundPhoto> => {
      src.calls++;
      if (src.fail) throw new Error('Commons is down');
      id++;
      return { id, token: `tok${id}`, w: 1600, h: 1000, answer: { lat: 59.3293, lon: 18.0686, title: `Stockholm ${id}`, author: 'Someone', license: 'CC BY-SA 4.0', pageUrl: 'https://example.org' } };
    },
  };
  return src;
}

const flush = () => new Promise((r) => setImmediate(r));

async function startGame(ids: string[], settings: object = {}) {
  const src = fakeSource();
  const r = fakeRoom(createGeoGame(src.source), ids);
  const s = r.s as GeoState;
  r.act(ids[0], { a: 'settings', ...settings });
  r.act(ids[0], { a: 'start' });
  assert.equal(s.phase, 'loading');
  await flush();
  assert.equal(s.phase, 'guessing');
  return { ...r, s, src };
}

const OSLO = { lat: 59.9139, lon: 10.7522 }; // ~415 km from Stockholm
const ROME = { lat: 41.9028, lon: 12.4964 }; // ~2000 km

test('scoring: closer scores more, and the speed bonus needs a good guess', () => {
  assert.equal(distancePoints(0), 5000);
  assert.ok(distancePoints(100) > distancePoints(500));
  assert.ok(Math.abs(distanceKm({ lat: 59.3293, lon: 18.0686 }, OSLO) - 416) < 5);
  assert.equal(speedBonus(5000, 0, 60), 1000);
  assert.equal(speedBonus(5000, 60, 60), 0);
  assert.ok(speedBonus(distancePoints(15000), 1, 60) < 5); // instant but hopeless: almost nothing
});

test('the answer and other players’ pins stay off the shared state until the reveal', async () => {
  const r = await startGame(['a', 'b']);
  assert.equal(r.s.photo?.token, 'tok1');
  r.act('a', { a: 'guess', ...OSLO });
  const json = JSON.stringify(r.s);
  assert.ok(!json.includes('59.32') && !json.includes('59.91') && !json.includes('Stockholm'));
  assert.deepEqual(r.s.guessed, ['a']);
});

test('the first guess cuts everyone else down to the rush time', async () => {
  const r = await startGame(['a', 'b'], { roundSeconds: 60 });
  r.advance(5000);
  r.act('a', { a: 'guess', ...OSLO });
  assert.equal(r.s.endsAt - Date.now(), RUSH_SECONDS * 1000);
  r.advance(RUSH_SECONDS * 1000 + 50);
  assert.equal(r.s.phase, 'reveal');
  const b = r.s.results.find((x) => x.playerId === 'b')!;
  assert.equal(b.guess, null);
  assert.equal(b.points, 0);
});

test('the round ends as soon as everyone has guessed, closest first', async () => {
  const r = await startGame(['a', 'b']);
  r.advance(3000);
  r.act('a', { a: 'guess', ...ROME });
  r.advance(3000);
  r.act('b', { a: 'guess', ...OSLO });
  assert.equal(r.s.phase, 'reveal');
  assert.equal(r.s.answer?.title, 'Stockholm 1');
  assert.deepEqual(r.s.results.map((x) => x.playerId), ['b', 'a']);
  const [b] = r.s.results;
  assert.equal(r.s.scores.b.total, b.points + b.bonus);
  assert.ok(b.bonus > 0);
});

test('a player can only lock in once', async () => {
  const r = await startGame(['a', 'b']);
  r.act('a', { a: 'guess', ...OSLO });
  assert.equal(r.act('a', { a: 'guess', ...ROME }), 'You already locked in');
});

test('the reveal moves on by itself, and the last round ends the game', async () => {
  const r = await startGame(['a'], { rounds: 2 });
  r.act('a', { a: 'guess', ...OSLO });
  assert.equal(r.s.phase, 'reveal');
  r.advance(REVEAL_SECONDS * 1000 + 10);
  await flush();
  assert.equal(r.s.phase, 'guessing');
  assert.equal(r.s.round, 2);
  assert.equal(r.s.photo?.token, 'tok2');
  r.act('a', { a: 'guess', ...OSLO });
  r.advance(REVEAL_SECONDS * 1000 + 10);
  assert.equal(r.s.phase, 'over');
  assert.ok(r.s.scores.a.total > 0);
});

test('skip swaps the photo without using up a round', async () => {
  const r = await startGame(['a', 'b']);
  assert.equal(r.act('b', { a: 'skip' }), 'Only the host can skip');
  r.act('a', { a: 'skip' });
  await flush();
  assert.equal(r.s.round, 1);
  assert.equal(r.s.photo?.token, 'tok2');
});

test('a failed photo load shows an error and the host can retry', async () => {
  const src = fakeSource();
  src.fail = true;
  const r = fakeRoom(createGeoGame(src.source), ['a']);
  const s = r.s as GeoState;
  r.act('a', { a: 'start' });
  await flush();
  assert.equal(s.phase, 'loading');
  assert.match(s.error ?? '', /Commons is down/);
  src.fail = false;
  r.act('a', { a: 'start' });
  await flush();
  assert.equal(s.phase, 'guessing');
  assert.equal(s.round, 1);
});

test('when the last player still guessing leaves, the round ends', async () => {
  const r = await startGame(['a', 'b']);
  r.act('a', { a: 'guess', ...OSLO });
  r.leave('b');
  assert.equal(r.s.phase, 'reveal');
});
