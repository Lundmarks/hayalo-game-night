import { fire, grounded, Sim, walk, WORM_R, FPS } from '../../shared/artillery/sim.ts';
import { Terrain, W, WATER_Y } from '../../shared/artillery/terrain.ts';
import { TEAM_COLORS, WEAPONS, WEAPON_BY_ID, type ArtEvent, type ArtState, type Timeline, type WeaponId } from '../../shared/artillery/types.ts';
import { QUIET, type GameContext, type GameModule } from './index.ts';

const MAX_TEAMS = 6;
const WALK_BUDGET = 170;
const JUMP_COST = 25;
const WORM_NAMES = [
  'Bale', 'Straw', 'Pitchfork', 'Haystack', 'Clover', 'Barley', 'Oats', 'Thistle', 'Rye', 'Sprout', 'Scarecrow', 'Tractor',
  'Muddy', 'Wheat', 'Harvest', 'Acorn', 'Turnip', 'Biscuit', 'Pickle', 'Nugget', 'Waffle', 'Noodle', 'Pebble', 'Rusty',
];

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
    t.nextWorm = 0;
  });

  // Spread worms across the island, teams mixed together.
  const total = s.teams.length * s.wormsPerTeam;
  const slots = shuffle(Array.from({ length: total }, (_, i) => i));
  const names = shuffle([...WORM_NAMES]);
  s.worms = [];
  let id = 0;
  for (let ti = 0; ti < s.teams.length; ti++) {
    for (let k = 0; k < s.wormsPerTeam; k++) {
      const slot = slots[id];
      const lane = (W - 260) / total;
      let x = 130;
      let y = 0;
      for (let attempt = 0; attempt < 40; attempt++) {
        x = Math.round(130 + lane * slot + Math.random() * lane);
        y = terrain.surfaceY(x) - WORM_R - 1;
        if (y < WATER_Y - 40) break;
      }
      s.worms.push({ id, team: ti, name: names[id % names.length], x, y, hp: 100, alive: true, facing: x < W / 2 ? 1 : -1 });
      id++;
    }
  }
  s.turn = null;
  nextTurn(s, ctx, Math.floor(Math.random() * s.teams.length) - 1);
}

function nextTurn(s: ArtState, ctx: GameContext, from = s.turn?.team ?? -1) {
  const alive = s.teams.map((_, i) => i).filter((i) => s.worms.some((w) => w.team === i && w.alive));
  if (s.solo ? alive.length === 0 : alive.length <= 1) {
    s.phase = 'over';
    s.winner = s.solo ? null : alive[0] ?? null;
    s.turn = null;
    return;
  }

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

  const t = s.teams[team];
  const worms = s.worms.filter((w) => w.team === team && w.alive);
  const worm = worms[t.nextWorm++ % worms.length];
  s.wind = Math.round((Math.random() * 2 - 1) * 10) / 10;
  s.phase = 'aiming';
  const no = (s.turn?.no ?? 0) + 1;
  s.turn = {
    no,
    team,
    wormId: worm.id,
    endsAt: Date.now() + s.turnSeconds * 1000,
    walkLeft: WALK_BUDGET,
    angle: worm.facing === 1 ? -0.8 : -Math.PI + 0.8,
    power: 0.6,
    weapon: 'bazooka',
  };

  ctx.setTimer(s.turnSeconds * 1000, () => {
    if (s.turn?.no === no && s.phase === 'aiming') {
      nextTurn(s, ctx);
      ctx.broadcast();
    }
  });
}

/** Play a simulation to everyone, then move on when the animation is done. */
function runSim(s: ArtState, ctx: GameContext, sim: Sim, endsTurn: boolean) {
  const tl: Timeline = sim.run();
  ctx.emit({ type: 'timeline', tl } satisfies ArtEvent);
  const ms = (tl.frames / FPS) * 1000 + 600;
  P(s).busyUntil = Date.now() + ms;

  const worm = currentWorm(s);
  if (endsTurn || !worm?.alive) {
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
          nextWorm: 0,
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
        s.worms = [];
        s.turn = null;
        s.craters = [];
        s.seed = 0;
        p.terrain = null;
        return;

      case 'walk': {
        if (!isMyTurn(s, pid) || now < p.busyUntil) return QUIET;
        if (now - p.lastWalk < 30) return QUIET;
        p.lastWalk = now;
        const dir = a.dir === -1 ? -1 : 1;
        const worm = currentWorm(s)!;
        const turn = s.turn!;
        worm.facing = dir;
        if (turn.walkLeft > 0) {
          const { moved, fell } = walk(p.terrain!, worm, dir, Math.min(3, turn.walkLeft));
          turn.walkLeft -= moved;
          if (fell) {
            runSim(s, ctx, new Sim(p.terrain!, s.worms, s.craters, s.wind), false);
            return;
          }
        }
        ctx.emit({ type: 'walk', wormId: worm.id, x: worm.x, y: worm.y, facing: worm.facing, walkLeft: turn.walkLeft } satisfies ArtEvent);
        return QUIET;
      }

      case 'jump': {
        if (!isMyTurn(s, pid) || now < p.busyUntil) return QUIET;
        const worm = currentWorm(s)!;
        const turn = s.turn!;
        if (!grounded(p.terrain!, worm)) return QUIET;
        if (turn.walkLeft < JUMP_COST) return 'Out of moves for this turn';
        turn.walkLeft -= JUMP_COST;
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
    } else if (s.phase === 'aiming' && s.turn && s.teams[s.turn.team]?.playerId === pid) {
      nextTurn(s, ctx);
    }
  },
};
