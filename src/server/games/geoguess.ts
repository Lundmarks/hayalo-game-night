import {
  distanceKm, distancePoints, REVEAL_SECONDS, RUSH_SECONDS, speedBonus,
  type GeoAnswer, type GeoResult, type GeoState, type LatLon,
} from '../../shared/geo.ts';
import { nextPhoto, type RoundPhoto } from '../geo/photos.ts';
import type { GameContext, GameModule } from './module.ts';

export type PhotoSource = (avoid: Set<number>) => Promise<RoundPhoto>;

// Kept off the broadcast state so nobody can read the answer or other pins early.
type Private = {
  answer: GeoAnswer | null;
  guesses: Map<string, LatLon & { at: number }>;
  used: Set<number>; // Commons page ids shown this session
  next: Promise<RoundPhoto> | null; // fetched during the reveal so the next round starts instantly
  seq: number; // bumps on every round load, so stale timers and fetches know to give up
  loadingRound: number;
};

const num = (n: unknown, min: number, max: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null);
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export function createGeoGame(source: PhotoSource): GameModule<GeoState> {
  const priv = new WeakMap<GeoState, Private>();
  const P = (s: GeoState) => priv.get(s)!;

  const online = (ctx: GameContext) => ctx.players();

  /** Start fetching the next photo now, so it's ready when it's needed. */
  function prefetch(s: GeoState) {
    const p = P(s);
    p.next = source(p.used);
    p.next.catch(() => {}); // a failure shows up when a round tries to use it
  }

  function startRound(s: GeoState, ctx: GameContext, roundNo: number) {
    const p = P(s);
    const seq = ++p.seq;
    p.loadingRound = roundNo;
    p.answer = null;
    p.guesses.clear();
    Object.assign(s, { phase: 'loading', photo: null, answer: null, results: [], guessed: [], rushAt: null, nextAt: null, error: null });

    const pending = p.next ?? source(p.used);
    p.next = null;
    pending.then(
      (photo) => {
        if (p.seq !== seq) return;
        p.used.add(photo.id);
        p.answer = photo.answer;
        const now = Date.now();
        Object.assign(s, {
          phase: 'guessing',
          round: roundNo,
          photo: { token: photo.token, w: photo.w, h: photo.h },
          startedAt: now,
          endsAt: now + s.roundSeconds * 1000,
        });
        armTimer(s, ctx, seq);
        ctx.broadcast();
      },
      (e) => {
        if (p.seq !== seq) return;
        s.error = (e as Error).message ?? 'Could not load a photo';
        ctx.broadcast();
      },
    );
  }

  function armTimer(s: GeoState, ctx: GameContext, seq: number) {
    ctx.setTimer(Math.max(0, s.endsAt - Date.now()), () => {
      if (P(s).seq !== seq || s.phase !== 'guessing') return;
      if (Date.now() < s.endsAt - 20) return armTimer(s, ctx, seq);
      reveal(s, ctx);
      ctx.broadcast();
    });
  }

  function reveal(s: GeoState, ctx: GameContext) {
    const p = P(s);
    const answer = p.answer!;
    const names = new Map(online(ctx).map((pl) => [pl.id, pl.name]));
    const ids = new Set([...names.keys(), ...p.guesses.keys()]);

    const results: GeoResult[] = [...ids].map((id) => {
      const name = names.get(id) ?? s.scores[id]?.name ?? 'Player';
      const g = p.guesses.get(id);
      if (!g) return { playerId: id, name, guess: null, km: null, points: 0, bonus: 0, seconds: null };
      const km = distanceKm(g, answer);
      const points = distancePoints(km);
      const seconds = (g.at - s.startedAt) / 1000;
      return { playerId: id, name, guess: { lat: g.lat, lon: g.lon }, km, points, bonus: speedBonus(points, seconds, s.roundSeconds), seconds };
    });
    results.sort((a, b) => b.points + b.bonus - (a.points + a.bonus) || (a.seconds ?? 1e9) - (b.seconds ?? 1e9));

    for (const r of results) {
      const sc = (s.scores[r.playerId] ??= { name: r.name, total: 0 });
      sc.name = r.name;
      sc.total += r.points + r.bonus;
    }
    Object.assign(s, { phase: 'reveal', answer, results, nextAt: Date.now() + REVEAL_SECONDS * 1000 });

    if (s.round < s.rounds) prefetch(s);
    const seq = p.seq;
    ctx.setTimer(REVEAL_SECONDS * 1000, () => {
      if (P(s).seq !== seq || s.phase !== 'reveal') return;
      advance(s, ctx);
      ctx.broadcast();
    });
  }

  function advance(s: GeoState, ctx: GameContext) {
    if (s.round >= s.rounds) {
      P(s).seq++;
      Object.assign(s, { phase: 'over', nextAt: null });
    } else startRound(s, ctx, s.round + 1);
  }

  function everyoneGuessed(s: GeoState, ctx: GameContext) {
    const ids = online(ctx).map((p) => p.id);
    return ids.length > 0 && ids.every((id) => s.guessed.includes(id));
  }

  return {
    id: 'geoguess',

    create() {
      const s: GeoState = {
        phase: 'lobby',
        rounds: 5,
        roundSeconds: 60,
        round: 0,
        photo: null,
        startedAt: 0,
        endsAt: 0,
        rushAt: null,
        guessed: [],
        answer: null,
        results: [],
        scores: {},
        nextAt: null,
        error: null,
      };
      priv.set(s, { answer: null, guesses: new Map(), used: new Set(), next: null, seq: 0, loadingRound: 0 });
      prefetch(s); // the first search is slow; get it going while people read the rules
      return s;
    },

    action(s, pid, raw, ctx) {
      const a = (raw ?? {}) as Record<string, unknown>;
      const isHost = ctx.hostId() === pid;
      const p = P(s);

      switch (a.a) {
        case 'settings': {
          if (!isHost || s.phase !== 'lobby') return 'Only the host can change settings';
          const rounds = num(a.rounds, 1, 20);
          const secs = num(a.roundSeconds, 20, 180);
          if (rounds !== null) s.rounds = Math.round(rounds);
          if (secs !== null) s.roundSeconds = Math.round(secs);
          return;
        }

        case 'start':
          if (!isHost) return 'Only the host can start';
          if (s.phase === 'loading' && s.error) {
            startRound(s, ctx, p.loadingRound); // retry after a failed load
            return;
          }
          if (s.phase !== 'lobby') return;
          s.scores = {};
          s.round = 0;
          startRound(s, ctx, 1);
          return;

        case 'guess': {
          if (s.phase !== 'guessing') return 'Not guessing right now';
          if (s.guessed.includes(pid)) return 'You already locked in';
          const lat = num(a.lat, -90, 90);
          const lon = typeof a.lon === 'number' && Number.isFinite(a.lon) ? wrapLon(a.lon) : null;
          if (lat === null || lon === null) return 'Bad guess';
          const now = Date.now();
          p.guesses.set(pid, { lat, lon, at: now });
          s.guessed.push(pid);

          if (everyoneGuessed(s, ctx)) {
            reveal(s, ctx);
            return;
          }
          // First pin in: everyone else has to hurry.
          if (s.rushAt === null && s.endsAt - now > RUSH_SECONDS * 1000) {
            s.rushAt = now;
            s.endsAt = now + RUSH_SECONDS * 1000;
            armTimer(s, ctx, p.seq);
          }
          return;
        }

        case 'skip':
          if (!isHost) return 'Only the host can skip';
          if (s.phase !== 'guessing') return;
          startRound(s, ctx, s.round);
          return;

        case 'next':
          if (!isHost) return 'Only the host can move on';
          if (s.phase !== 'reveal') return;
          advance(s, ctx);
          return;

        case 'restart':
          if (!isHost) return 'Only the host can do that';
          p.seq++;
          prefetch(s);
          Object.assign(s, { phase: 'lobby', round: 0, photo: null, answer: null, results: [], guessed: [], rushAt: null, nextAt: null, error: null, scores: {} });
          return;

        default:
          return 'Unknown action';
      }
    },

    playerLeft(s, _pid, ctx) {
      if (s.phase === 'guessing' && s.guessed.length > 0 && everyoneGuessed(s, ctx)) reveal(s, ctx);
    },
  };
}

export const geoGuess = createGeoGame(nextPhoto);
