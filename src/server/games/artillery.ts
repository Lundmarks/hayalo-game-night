import { fire, grounded, Sim, walk, WORM_R, FPS } from '../../shared/artillery/sim.ts';
import { MAT, Terrain, W, WATER_Y } from '../../shared/artillery/terrain.ts';
import { TEAM_COLORS, WEAPONS, WEAPON_BY_ID, type ArtEvent, type ArtState, type Timeline, type WeaponId } from '../../shared/artillery/types.ts';
import { QUIET, type GameContext, type GameModule } from './module.ts';

const MAX_TEAMS = 6;
// How long a player can be disconnected mid-match before their team forfeits.
const GRACE_MS = 60_000;

// Worms are named after politicians: the admired and the infamous, mixed
// together so every team gets a bit of both.
export const HEROES = [
  'Lincoln', 'Churchill', 'Mandela', 'Gandhi', 'JFK', 'FDR', 'Obama', 'Merkel', 'Washington', 'Palme', 'Thatcher',
  'Reagan', 'de Gaulle', 'Zelensky', 'Ardern', 'Teddy', 'Bismarck', 'Kekkonen', 'Havel', 'Lula', 'Macron', 'Trudeau',
];
export const VILLAINS = [
  'Stalin', 'Mussolini', 'Pol Pot', 'Idi Amin', 'Kim Jong-un', 'Putin', 'Mao', 'Caligula', 'Nero', 'Gaddafi',
  'Saddam', 'Ceaușescu', 'Franco', 'Pinochet', 'Mugabe', 'Lukashenko', 'Nixon', 'Robespierre', 'Napoleon', 'Assad',
];

/** Alternate heroes and villains so each team gets some of both. */
export function politicianNames(n: number) {
  const h = shuffle([...HEROES]);
  const v = shuffle([...VILLAINS]);
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) out.push(i % 2 ? v[(i >> 1) % v.length] : h[(i >> 1) % h.length]);
  return out;
}

// Things the server needs but clients don't (kept out of the broadcast state).
type Private = { terrain: Terrain | null; lastWalk: number; busyUntil: number };
const priv = new WeakMap<ArtState, Private>();
const P = (s: ArtState) => priv.get(s)!;

const shuffle = <T>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const fullAmmo = () => Object.fromEntries(WEAPONS.map((w) => [w.id, w.ammo])) as Record<WeaponId, number>;
const isWeapon = (w: unknown): w is WeaponId => typeof w === 'string' && w in WEAPON_BY_ID;
const num = (n: unknown, min: number, max: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null);

function currentWorm(s: ArtState) {
  return s.turn ? s.worms.find((w) => w.id === s.turn!.wormId) : undefined;
}

function isMyTurn(s: ArtState, playerId: string) {
  return s.phase === 'aiming' && !!s.turn && s.teams[s.turn.team]?.playerId === playerId;
}

function startMatch(s: ArtState, ctx: GameContext) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const terrain = Terrain.generate(seed);
  P(s).terrain = terrain;
  s.seed = seed;
  s.craters = [];
  s.winner = null;
  s.solo = s.teams.length === 1;
  s.teams.forEach((t) => {
    t.ammo = fullAmmo();
    t.lastWorm = -1;
    t.out = null;
  });

  // Spread worms across the island, teams mixed together.
  const total = s.teams.length * s.wormsPerTeam;
  const slots = shuffle(Array.from({ length: total }, (_, i) => i));
  // Teams own consecutive ids, so alternating names give every team both kinds.
  const names = politicianNames(total);
  // Bare, fairly flat ground (not the side of a tree), away from other worms.
  const goodSpot = (x: number, spacing: number) => {
    const top = terrain.surfaceY(x);
    const y = top - WORM_R - 1;
    if (y >= WATER_Y - 40 || Math.abs(terrain.surfaceY(x - 6) - terrain.surfaceY(x + 6)) > 10) return null;
    if (spacing && terrain.mat[top * W + x] !== MAT.DIRT && terrain.mat[top * W + x] !== MAT.GIRDER) return null;
    return s.worms.some((o) => Math.abs(o.x - x) < spacing && Math.abs(o.y - y) < 30) ? null : y;
  };
  s.worms = [];
  const lane = (W - 260) / total;
  for (let id = 0; id < total; id++) {
    let x = 0;
    let y: number | null = null;
    for (let attempt = 0; attempt < 40 && y === null; attempt++) {
      x = Math.round(130 + lane * slots[id] + Math.random() * lane);
      y = goodSpot(x, 24);
    }
    // Lane is all sea (or crowded): anywhere on land will do, then even right next to someone.
    for (let attempt = 0; attempt < 600 && y === null; attempt++) {
      x = Math.round(40 + Math.random() * (W - 80));
      y = goodSpot(x, attempt < 300 ? 18 : 0);
    }
    if (y === null) y = terrain.surfaceY(x) - WORM_R - 1;
    const team = Math.floor(id / s.wormsPerTeam);
    s.worms.push({ id, team, name: names[id], x, y, hp: 100, alive: true, facing: x < W / 2 ? 1 : -1 });
  }
  s.turn = null;
  nextTurn(s, ctx, Math.floor(Math.random() * s.teams.length) - 1);
}

const aliveTeams = (s: ArtState) => s.teams.map((_, i) => i).filter((i) => s.worms.some((w) => w.team === i && w.alive));

/** End the match if one team (or, in solo, none) is left. */
function checkOver(s: ArtState) {
  const alive = aliveTeams(s);
  if (s.solo ? alive.length > 0 : alive.length > 1) return false;
  s.phase = 'over';
  s.winner = s.solo ? null : alive[0] ?? null;
  s.turn = null;
  return true;
}

/** End the turn when time runs out. Animations push endsAt back, so re-check. */
function armTurnTimer(s: ArtState, ctx: GameContext) {
  const turn = s.turn!;
  ctx.setTimer(Math.max(0, turn.endsAt - Date.now()), () => {
    if (s.turn !== turn || s.phase !== 'aiming') return;
    if (Date.now() < turn.endsAt - 20) return armTurnTimer(s, ctx);
    nextTurn(s, ctx);
    ctx.broadcast();
  });
}

/** Take a team out of the match (surrendered or gone too long). */
function knockOut(s: ArtState, ctx: GameContext, team: number, reason: 'left' | 'surrendered') {
  const t = s.teams[team];
  if (!t || t.out || (s.phase !== 'aiming' && s.phase !== 'resolving')) return;
  t.out = reason;
  for (const w of s.worms) {
    if (w.team !== team) continue;
    w.alive = false;
    w.hp = 0;
  }
  // While resolving, the pending timer moves the game on by itself.
  if (s.phase === 'aiming') {
    if (s.turn?.team === team) nextTurn(s, ctx);
    else checkOver(s);
  }
}

function nextTurn(s: ArtState, ctx: GameContext, from = s.turn?.team ?? -1) {
  if (checkOver(s)) return;
  const alive = aliveTeams(s);

  const online = new Set(ctx.players().map((p) => p.id));
  const n = s.teams.length;
  let team = -1;
  for (let k = 1; k <= n; k++) {
    const c = (((from + k) % n) + n) % n;
    if (alive.includes(c) && online.has(s.teams[c].playerId)) {
      team = c;
      break;
    }
  }
  if (team < 0) team = alive[0];

  // Each team cycles through its worms in id order, skipping dead ones.
  const t = s.teams[team];
  const worms = s.worms.filter((w) => w.team === team && w.alive);
  const worm = worms.find((w) => w.id > t.lastWorm) ?? worms[0];
  t.lastWorm = worm.id;
  s.wind = Math.round((Math.random() * 2 - 1) * 10) / 10;
  s.phase = 'aiming';
  const no = (s.turn?.no ?? 0) + 1;
  s.turn = {
    no,
    team,
    wormId: worm.id,
    endsAt: Date.now() + s.turnSeconds * 1000,
    angle: worm.facing === 1 ? -0.8 : -Math.PI + 0.8,
    power: 0.6,
    weapon: 'bazooka',
  };
  armTurnTimer(s, ctx);
}

/** Play a simulation to everyone, then move on when the animation is done. */
function runSim(s: ArtState, ctx: GameContext, sim: Sim, endsTurn: boolean) {
  const tl: Timeline = sim.run();
  ctx.emit({ type: 'timeline', tl } satisfies ArtEvent);
  const ms = (tl.frames / FPS) * 1000 + 600;
  P(s).busyUntil = Date.now() + ms;

  const worm = currentWorm(s);
  if (!endsTurn && worm?.alive && s.turn) {
    // A jump or fall mid-turn: don't let the animation eat into the turn time.
    s.turn.endsAt += ms;
  } else {
    s.phase = 'resolving';
    const no = s.turn?.no;
    ctx.setTimer(ms, () => {
      if (s.turn?.no !== no || s.phase !== 'resolving') return;
      nextTurn(s, ctx);
      ctx.broadcast();
    });
  }
}

export const artillery: GameModule<ArtState> = {
  id: 'artillery',

  create() {
    const s: ArtState = {
      phase: 'lobby',
      seed: 0,
      craters: [],
      teams: [],
      worms: [],
      turn: null,
      wind: 0,
      winner: null,
      wormsPerTeam: 2,
      turnSeconds: 45,
      solo: false,
    };
    priv.set(s, { terrain: null, lastWalk: 0, busyUntil: 0 });
    return s;
  },

  action(s, pid, raw, ctx) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const isHost = ctx.hostId() === pid;
    const p = P(s);
    const now = Date.now();

    switch (a.a) {
      case 'join': {
        if (s.phase !== 'lobby') return 'The match already started';
        if (s.teams.some((t) => t.playerId === pid)) return;
        if (s.teams.length >= MAX_TEAMS) return 'The match is full';
        const player = ctx.players().find((x) => x.id === pid);
        const used = new Set(s.teams.map((t) => t.color));
        s.teams.push({
          playerId: pid,
          name: player?.name ?? 'Player',
          color: TEAM_COLORS.find((c) => !used.has(c)) ?? TEAM_COLORS[0],
          ammo: fullAmmo(),
          lastWorm: -1,
          out: null,
        });
        return;
      }

      case 'leave':
        if (s.phase !== 'lobby') return 'You can only leave in the lobby';
        s.teams = s.teams.filter((t) => t.playerId !== pid);
        return;

      case 'settings': {
        if (!isHost || s.phase !== 'lobby') return 'Only the host can change settings';
        const wpt = num(a.wormsPerTeam, 1, 4);
        const secs = num(a.turnSeconds, 20, 90);
        if (wpt !== null) s.wormsPerTeam = Math.round(wpt);
        if (secs !== null) s.turnSeconds = Math.round(secs);
        return;
      }

      case 'start':
        if (!isHost) return 'Only the host can start';
        if (s.phase !== 'lobby') return;
        if (!s.teams.length) return 'Someone needs to join first';
        startMatch(s, ctx);
        return;

      case 'restart':
        if (!isHost) return 'Only the host can restart';
        if (s.phase !== 'over') return;
        s.phase = 'lobby';
        // Teams whose player has gone don't carry over to the next match.
        {
          const online = new Set(ctx.players().map((x) => x.id));
          s.teams = s.teams.filter((t) => online.has(t.playerId));
          s.teams.forEach((t) => (t.out = null));
        }
        s.worms = [];
        s.turn = null;
        s.craters = [];
        s.seed = 0;
        p.terrain = null;
        return;

      case 'surrender': {
        if (s.phase !== 'aiming' && s.phase !== 'resolving') return 'The match is not running';
        const team = s.teams.findIndex((t) => t.playerId === pid);
        if (team < 0) return 'You are not in this match';
        knockOut(s, ctx, team, 'surrendered');
        return;
      }

      case 'walk': {
        if (!isMyTurn(s, pid) || now < p.busyUntil) return QUIET;
        if (now - p.lastWalk < 30) return QUIET;
        p.lastWalk = now;
        const dir = a.dir === -1 ? -1 : 1;
        const worm = currentWorm(s)!;
        worm.facing = dir;
        // No walking budget: like the classic game, the turn clock is the limit.
        const { fell } = walk(p.terrain!, worm, dir, 3);
        if (fell) {
          runSim(s, ctx, new Sim(p.terrain!, s.worms, s.craters, s.wind), false);
          return;
        }
        ctx.emit({ type: 'walk', wormId: worm.id, x: worm.x, y: worm.y, facing: worm.facing } satisfies ArtEvent);
        return QUIET;
      }

      case 'jump': {
        if (!isMyTurn(s, pid) || now < p.busyUntil) return QUIET;
        const worm = currentWorm(s)!;
        if (!grounded(p.terrain!, worm)) return QUIET;
        const sim = new Sim(p.terrain!, s.worms, s.craters, s.wind);
        sim.jump(worm);
        runSim(s, ctx, sim, false);
        return;
      }

      case 'aim': {
        if (!isMyTurn(s, pid)) return QUIET;
        const angle = num(a.angle, -Math.PI * 2, Math.PI * 2);
        const power = num(a.power, 0, 1);
        if (angle === null || power === null || !isWeapon(a.weapon)) return QUIET;
        const turn = s.turn!;
        turn.angle = angle;
        turn.power = power;
        turn.weapon = a.weapon;
        const worm = currentWorm(s)!;
        worm.facing = Math.cos(angle) >= 0 ? 1 : -1;
        ctx.emit({ type: 'aim', angle, power, weapon: a.weapon } satisfies ArtEvent);
        return QUIET;
      }

      case 'fire': {
        if (!isMyTurn(s, pid)) return 'Not your turn';
        if (now < p.busyUntil) return 'Wait for the move to finish';
        if (!isWeapon(a.weapon)) return 'Unknown weapon';
        const team = s.teams[s.turn!.team];
        if (team.ammo[a.weapon] === 0) return 'Out of ammo';
        const angle = num(a.angle, -Math.PI * 2, Math.PI * 2) ?? s.turn!.angle;
        const power = num(a.power, 0, 1) ?? s.turn!.power;
        const tx = num(a.tx, 0, W) ?? undefined;
        const ty = num(a.ty, 0, WATER_Y) ?? undefined;
        if (WEAPON_BY_ID[a.weapon].aim === 'target' && tx === undefined) return 'Tap the map to pick a target';

        const worm = currentWorm(s)!;
        if (WEAPON_BY_ID[a.weapon].aim === 'angle') worm.facing = Math.cos(angle) >= 0 ? 1 : -1;
        const sim = new Sim(p.terrain!, s.worms, s.craters, s.wind);
        if (!fire(sim, p.terrain!, worm, a.weapon, angle, power, tx, ty)) return "Can't teleport there";
        if (team.ammo[a.weapon] > 0) team.ammo[a.weapon]--;
        Object.assign(s.turn!, { angle, power, weapon: a.weapon });
        runSim(s, ctx, sim, true);
        return;
      }

      default:
        return 'Unknown action';
    }
  },

  playerLeft(s, pid, ctx) {
    if (s.phase === 'lobby') {
      s.teams = s.teams.filter((t) => t.playerId !== pid);
      return;
    }
    if (s.phase !== 'aiming' && s.phase !== 'resolving') return;
    if (s.phase === 'aiming' && s.turn && s.teams[s.turn.team]?.playerId === pid) nextTurn(s, ctx);

    // Give them a minute to come back before their team forfeits.
    const seed = s.seed;
    ctx.setTimer(GRACE_MS, () => {
      if (s.seed !== seed || ctx.players().some((x) => x.id === pid)) return;
      const team = s.teams.findIndex((t) => t.playerId === pid);
      if (team < 0) return;
      knockOut(s, ctx, team, 'left');
      ctx.broadcast();
    });
  },
};
