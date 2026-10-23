// "Hay, Where?": everyone sees the same photo and drops a pin where they think
// it was taken. Closer is better; a quick guess earns a bonus, but only if it
// is also close, so a fast random click doesn't pay.

export type LatLon = { lat: number; lon: number };

export type GeoAnswer = LatLon & {
  title: string;
  author: string;
  license: string;
  pageUrl: string; // the photo's Commons page, for credit
};

export type GeoResult = {
  playerId: string;
  name: string;
  guess: LatLon | null;
  km: number | null;
  points: number; // for distance
  bonus: number; // for speed
  seconds: number | null; // how long they took
};

export type GeoState = {
  phase: 'lobby' | 'loading' | 'guessing' | 'reveal' | 'over';
  rounds: number;
  roundSeconds: number;
  round: number; // 1-based, 0 before the first
  /** The current photo. `token` is opaque so the filename can't give the answer away. */
  photo: { token: string; w: number; h: number } | null;
  startedAt: number; // server clock, ms
  endsAt: number;
  rushAt: number | null; // when the first guess came in and the clock was cut short
  guessed: string[]; // who has locked in (their pins stay secret until the reveal)
  answer: GeoAnswer | null; // only filled in at the reveal
  results: GeoResult[]; // this round, best first, only at the reveal
  scores: Record<string, { name: string; total: number }>;
  nextAt: number | null; // auto-advance after the reveal
  error: string | null;
};

export type GeoAction =
  | { a: 'settings'; rounds?: number; roundSeconds?: number }
  | { a: 'start' }
  | { a: 'guess'; lat: number; lon: number }
  | { a: 'skip' } // host: this photo is unguessable, get another
  | { a: 'next' } // host: go on from the reveal
  | { a: 'restart' }; // host: back to the lobby

export const MAX_POINTS = 5000;
export const MAX_BONUS = 1000;
/** Once someone locks in, everyone else has this long to finish. */
export const RUSH_SECONDS = 15;
export const REVEAL_SECONDS = 20;

/** Great-circle distance in km. */
export function distanceKm(a: LatLon, b: LatLon) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 5000 on the spot, ~3000 at 500 km, ~1800 at 1000 km, ~250 at 3000 km. */
export function distancePoints(km: number) {
  return Math.round(MAX_POINTS * Math.exp(-km / 1000));
}

/** Up to 1000 for an instant guess, scaled by how good the guess was. */
export function speedBonus(points: number, secondsTaken: number, roundSeconds: number) {
  const timeLeft = Math.max(0, 1 - secondsTaken / roundSeconds);
  return Math.round(MAX_BONUS * timeLeft * (points / MAX_POINTS));
}

export function formatKm(km: number) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}
