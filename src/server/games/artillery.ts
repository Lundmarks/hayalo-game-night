import { crateTouching, fire, FPS, grounded, killCamExtraMs, openCrate, Sim, walk, WORM_R, type SimInput } from '../../shared/artillery/sim.ts';
import { MAT, Terrain, W, WATER_Y } from '../../shared/artillery/terrain.ts';
import { politicianNames } from '../../shared/artillery/politicians.ts';
import {
  CRATE_WEAPONS, emptyStats, RETREAT_SECONDS, TEAM_COLORS, WEAPONS, WEAPON_BY_ID,
  type ArtEvent, type ArtState, type Crate, type Timeline, type WeaponId, type Worm,
} from '../../shared/artillery/types.ts';
import { QUIET, type GameContext, type GameModule } from './module.ts';

const MAX_TEAMS = 6;
// How long a player can be disconnected mid-match before their team forfeits.
const GRACE_MS = 60_000;
const RETREAT_FRAMES = RETREAT_SECONDS * FPS;
const CRATE_CHANCE = 0.4; // chance of a crate drop between turns
const MAX_CRATES = 5;
const FLOOD_STEP = 22; // px the water rises each turn in sudden death
const MIN_WATER = 120; // the water never rises above this
const PAUSE_MS = 600; // breather after an animation before the next thing starts

/** A fired shot, kept so it can be re-simulated with the shooter's retreat moves. */
type Shot = {
  playerId: string;
  wormId: number;
  start: number; // server ms when the shot was fired
  until: number; // retreat moves are accepted until this time
  seed: number;
  weapon: WeaponId;
  angle: number;
  power: number;
  tx?: number;
  ty?: number;
  inputs: SimInput[];
  snap: { mask: Uint8Array; worms: Worm[]; craters: number; crates: Crate[] };
};

// Things the server needs but clients don't (kept out of the broadcast state).
type Private = {
  terrain: Terrain | null;
  lastWalk: number;
  busyUntil: number;
  shot: Shot | null;
  gen: number; // bumped whenever a pending "move on" timer is superseded
  crateSeq: number;
};
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

const newSim = (s: ArtState, extra: { seed?: number } = {}) => new Sim(P(s).terrain!, s.worms, s.craters, s.wind, { water: s.water, crates: s.crates, ...extra });

function startMatch(s: ArtState, ctx: GameContext) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const terrain = Terrain.generate(seed);
  const p = P(s);
  p.terrain = terrain;
  p.shot = null;
  s.seed = seed;
  s.craters = [];
  s.crates = [];
  s.water = WATER_Y;
  s.winner = null;
  s.solo = s.teams.length === 1;
  s.sdTurn = s.solo || !s.suddenDeath ? 0 : s.suddenDeath * s.teams.length;
  s.stats = emptyStats(s.teams.length);
  s.teams.forEach((t) => {
    t.ammo = fullAmmo();
    t.lastWorm = -1;
    t.out = null;
  });

  // Spread worms across the island, teams mixed together.
  const total = s.teams.length * s.wormsPerTeam;
  const slots = shuffle(Array.from({ length: total }, (_, i) => i));
  const names = politicianNames(s.teams.length, s.wormsPerTeam);
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
    // Lane is all sea (or crowded): anywhere on land will do, closer and closer to others.
    for (let attempt = 0; attempt < 900 && y === null; attempt++) {
      x = Math.round(40 + Math.random() * (W - 80));
      y = goodSpot(x, attempt < 400 ? 30 : attempt < 700 ? 20 : 0);
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
  P(s).shot = null;
  return true;
}

/** End the turn when time runs out. Animations push endsAt back, so re-check. */
function armTurnTimer(s: ArtState, ctx: GameContext) {
  const turn = s.turn!;
  ctx.setTimer(Math.max(0, turn.endsAt - Date.now()), () => {
    if (s.turn !== turn || s.phase !== 'aiming') return;
    if (Date.now() < turn.endsAt - 20) return armTurnTimer(s, ctx);
    betweenTurns(s, ctx);
    ctx.broadcast();
  });
}

/** Take a team out of the match (surrendered or gone too long). */
function knockOut(s: ArtState, ctx: GameContext, team: number, reason: 'left' | 'surrendered') {
  const t = s.teams[team];
  if (!t || t.out || (s.phase !== 'aiming' && s.phase !== 'resolving')) return;
  t.out = reason;
  const shot = P(s).shot;
  for (const w of [...s.worms, ...(shot?.snap.worms ?? [])]) {
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
  P(s).shot = null;
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

/** Weapon crates go to the picking worm's team. Health was already added in the sim. */
function applyPickups(s: ArtState, events: Timeline['events']) {
  for (const e of events) {
    if (e.type !== 'pickup' || e.kind === 'health' || !isWeapon(e.kind)) continue;
    const w = s.worms.find((x) => x.id === e.wormId);
    const team = w && s.teams[w.team];
    if (team && team.ammo[e.kind] >= 0) team.ammo[e.kind]++;
  }
}

/** Wait for an animation to finish playing, then call `then` (unless superseded). */
function afterAnimation(s: ArtState, ctx: GameContext, endsAt: number, then: () => void) {
  const p = P(s);
  const gen = ++p.gen;
  p.busyUntil = endsAt;
  ctx.setTimer(Math.max(0, endsAt - Date.now()), () => {
    if (p.gen !== gen || s.phase !== 'resolving') return;
    then();
    ctx.broadcast();
  });
}

// Includes the kill cam's slow motion, which clients play at the same pace.
const animMs = (tl: Timeline) => (tl.frames / FPS) * 1000 + killCamExtraMs(tl) + PAUSE_MS;

/**
 * Tally a finished timeline for the end screen. `by` is the worm whose shot or
 * move it was (null for the flood); `weapon` is set for shots.
 */
function recordStats(s: ArtState, tl: Timeline, by: number | null, weapon?: WeaponId) {
  const st = s.stats;
  const shooter = by === null ? null : s.worms.find((w) => w.id === by);
  const team = (id: number) => s.worms.find((w) => w.id === id)?.team ?? -1;
  let damage = 0;
  let kills = 0;
  for (const e of tl.events) {
    if (e.type === 'damage' && shooter && team(e.wormId!) !== shooter.team) damage += e.amount ?? 0;
    if (e.type === 'die') {
      const how = by === null ? 'flood' : e.kind === 'drown' ? 'drown' : weapon ? 'blast' : 'fall';
      st.deaths.push({ wormId: e.wormId!, by, how, weapon });
      if (shooter && team(e.wormId!) !== shooter.team) kills++;
    }
  }
  if (!shooter) return;
  st.damage[shooter.team] += damage;
  st.kills[shooter.team] += kills;
  st.wormDamage[shooter.id] = (st.wormDamage[shooter.id] ?? 0) + damage;
  if (weapon && damage > 0 && (!st.best || damage > st.best.damage)) st.best = { wormId: shooter.id, weapon, damage, kills };
}

/** A jump, or a fall after walking off an edge, in the middle of a turn. */
function runMoveSim(s: ArtState, ctx: GameContext, sim: Sim) {
  const tl = sim.run();
  applyPickups(s, tl.events);
  recordStats(s, tl, s.turn?.wormId ?? null);
  ctx.emit({ type: 'timeline', tl } satisfies ArtEvent);
  const ms = animMs(tl);
  if (currentWorm(s)?.alive && s.turn) {
    // Don't let the animation eat into the turn time.
    P(s).busyUntil = Date.now() + ms;
    s.turn.endsAt += ms;
  } else {
    s.phase = 'resolving';
    afterAnimation(s, ctx, Date.now() + ms, () => betweenTurns(s, ctx));
  }
}

// ---- firing and the retreat ----

/** Rewind to just before the shot and simulate it again with all retreat moves so far. */
function simulateShot(s: ArtState): Timeline | null {
  const p = P(s);
  const sh = p.shot!;
  p.terrain!.mask.set(sh.snap.mask);
  s.craters.length = sh.snap.craters;
  sh.snap.worms.forEach((w, i) => Object.assign(s.worms[i], w));
  s.crates = sh.snap.crates.map((c) => ({ ...c }));
  const worm = s.worms.find((w) => w.id === sh.wormId)!;
  const sim = newSim(s, { seed: sh.seed });
  if (!fire(sim, p.terrain!, worm, sh.weapon, sh.angle, sh.power, sh.tx, sh.ty)) return null;
  sim.inputs = sh.inputs;
  sim.minFrames = RETREAT_FRAMES;
  return sim.run();
}

function publishShot(s: ArtState, ctx: GameContext, tl: Timeline, replace: boolean) {
  const sh = P(s).shot!;
  ctx.emit({ type: 'timeline', tl, replace, retreat: { wormId: sh.wormId, until: sh.until } } satisfies ArtEvent);
  afterAnimation(s, ctx, sh.start + animMs(tl), () => {
    applyPickups(s, tl.events);
    recordStats(s, tl, sh.wormId, sh.weapon);
    P(s).shot = null;
    betweenTurns(s, ctx);
  });
}

/** A walk or jump by the shooter while their shot is still in the air. */
function retreatMove(s: ArtState, ctx: GameContext, pid: string, kind: SimInput['kind'], dir: 1 | -1) {
  const sh = P(s).shot;
  const now = Date.now();
  if (!sh || s.phase !== 'resolving' || sh.playerId !== pid || now >= sh.until) return false;
  const last = sh.inputs.at(-1)?.f ?? 0;
  // A couple of frames ahead of the server clock so clients haven't played past it yet.
  const f = Math.max(last + 1, Math.ceil(((now - sh.start) / 1000) * FPS) + 2);
  if (f >= RETREAT_FRAMES) return false;
  sh.inputs.push({ f, wormId: sh.wormId, kind, dir });
  publishShot(s, ctx, simulateShot(s)!, true);
  return true;
}

// ---- between turns: sudden death and crate drops ----

function crateSpot(s: ArtState) {
  const t = P(s).terrain!;
  for (let i = 0; i < 40; i++) {
    const x = Math.round(80 + Math.random() * (W - 160));
    const top = t.surfaceY(x);
    if (top > 40 && top < s.water - 30) return x;
  }
  return null;
}

function betweenTurns(s: ArtState, ctx: GameContext) {
  if (checkOver(s)) return;
  const p = P(s);
  const flood = s.sdTurn > 0 && (s.turn?.no ?? 0) >= s.sdTurn && s.water > MIN_WATER;
  const dropX = s.cratesOn && s.crates.length < MAX_CRATES && Math.random() < CRATE_CHANCE ? crateSpot(s) : null;
  if (!flood && dropX === null) return nextTurn(s, ctx);

  const sim = newSim(s);
  if (flood) sim.flood(Math.max(MIN_WATER, s.water - FLOOD_STEP));
  if (dropX !== null) {
    const weapon = Math.random() < 0.55 ? CRATE_WEAPONS[Math.floor(Math.random() * CRATE_WEAPONS.length)] : undefined;
    sim.dropCrate({ id: ++p.crateSeq, x: dropX, y: 0, kind: weapon ? 'weapon' : 'health', weapon });
  }
  const tl = sim.run();
  s.water = Math.round(sim.water);
  applyPickups(s, tl.events);
  recordStats(s, tl, null);
  ctx.emit({ type: 'timeline', tl } satisfies ArtEvent);
  s.phase = 'resolving';
  afterAnimation(s, ctx, Date.now() + animMs(tl), () => nextTurn(s, ctx));
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
      water: WATER_Y,
      crates: [],
      cratesOn: true,
      suddenDeath: 8,
      sdTurn: 0,
      stats: emptyStats(0),
    };
    priv.set(s, { terrain: null, lastWalk: 0, busyUntil: 0, shot: null, gen: 0, crateSeq: 0 });
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
        const sd = num(a.suddenDeath, 0, 30);
        if (wpt !== null) s.wormsPerTeam = Math.round(wpt);
        if (secs !== null) s.turnSeconds = Math.round(secs);
        if (sd !== null) s.suddenDeath = Math.round(sd);
        if (typeof a.crates === 'boolean') s.cratesOn = a.crates;
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
        s.crates = [];
        s.water = WATER_Y;
        s.seed = 0;
        p.terrain = null;
        p.shot = null;
        return;

      case 'surrender': {
        if (s.phase !== 'aiming' && s.phase !== 'resolving') return 'The match is not running';
        const team = s.teams.findIndex((t) => t.playerId === pid);
        if (team < 0) return 'You are not in this match';
        knockOut(s, ctx, team, 'surrendered');
        return;
      }

      case 'walk': {
        const dir = a.dir === -1 ? -1 : 1;
        if (now - p.lastWalk < 30) return QUIET;
        if (retreatMove(s, ctx, pid, 'walk', dir)) {
          p.lastWalk = now;
          return QUIET;
        }
        if (!isMyTurn(s, pid) || now < p.busyUntil) return QUIET;
        p.lastWalk = now;
        const worm = currentWorm(s)!;
        worm.facing = dir;
        // No walking budget: like the classic game, the turn clock is the limit.
        const { fell } = walk(p.terrain!, worm, dir, 3);
        if (fell) {
          runMoveSim(s, ctx, newSim(s));
          return;
        }
        const crate = crateTouching(s.crates, worm);
        if (crate) {
          openCrate(crate, worm);
          s.crates = s.crates.filter((c) => c !== crate);
          applyPickups(s, [{ f: 0, type: 'pickup', x: crate.x, y: crate.y, wormId: worm.id, kind: crate.weapon ?? 'health' }]);
          ctx.emit({ type: 'pickup', wormId: worm.id, crate, x: crate.x, y: crate.y } satisfies ArtEvent);
        }
        ctx.emit({ type: 'walk', wormId: worm.id, x: worm.x, y: worm.y, facing: worm.facing } satisfies ArtEvent);
        // A pickup changes HP, ammo and the crate list, so everyone needs the new state.
        return crate ? undefined : QUIET;
      }

      case 'jump': {
        const dir = currentWorm(s)?.facing ?? 1;
        if (retreatMove(s, ctx, pid, 'jump', a.dir === -1 || a.dir === 1 ? a.dir : dir)) return QUIET;
        if (!isMyTurn(s, pid) || now < p.busyUntil) return QUIET;
        const worm = currentWorm(s)!;
        if (!grounded(p.terrain!, worm)) return QUIET;
        const sim = newSim(s);
        sim.jump(worm);
        runMoveSim(s, ctx, sim);
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
        const ty = num(a.ty, 0, s.water) ?? undefined;
        if (WEAPON_BY_ID[a.weapon].aim === 'target' && tx === undefined) return 'Tap the map to pick a target';

        const worm = currentWorm(s)!;
        if (WEAPON_BY_ID[a.weapon].aim === 'angle') worm.facing = Math.cos(angle) >= 0 ? 1 : -1;
        p.shot = {
          playerId: pid,
          wormId: worm.id,
          start: now,
          until: now + RETREAT_SECONDS * 1000,
          seed: Math.floor(Math.random() * 2 ** 31),
          weapon: a.weapon,
          angle,
          power,
          tx,
          ty,
          inputs: [],
          snap: { mask: p.terrain!.mask.slice(), worms: s.worms.map((w) => ({ ...w })), craters: s.craters.length, crates: s.crates.map((c) => ({ ...c })) },
        };
        const tl = simulateShot(s);
        if (!tl) {
          p.shot = null;
          return "Can't teleport there";
        }
        if (team.ammo[a.weapon] > 0) team.ammo[a.weapon]--;
        Object.assign(s.turn!, { angle, power, weapon: a.weapon });
        s.phase = 'resolving';
        publishShot(s, ctx, tl, false);
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
