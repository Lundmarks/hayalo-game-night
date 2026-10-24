// Physics for one shot (or a jump/fall, or the between-turns flood and crate
// drop). Runs on the server only; clients get the resulting Timeline and play
// it back. Randomness comes from a seed, so the same inputs always give the
// same timeline: the server re-runs a shot with the shooter's retreat moves
// added and clients swap to the new timeline without anything earlier changing.
import { rng, Terrain, W, H, WATER_Y } from './terrain.ts';
import { CRATE_HEALTH, MAX_HP, type Crate, type Crater, type ProjKind, type SimEvent, type Timeline, type Track, type WeaponId, type Worm } from './types.ts';

export const FPS = 60;
export const SAMPLE = 2; // record positions every 2 frames (30 per second)
const DT = 1 / FPS;

export const G = 480;
export const MAX_SPEED = 820;
export const WIND_ACC = 190;
export const WORM_R = 9;
export const MAX_CLIMB = 5;
const FALL_SAFE = 430;
export const CRATE_R = 8; // half the crate's size
const PARA_SPEED = 170; // crates float down this fast (px/s)
export const FLOOD_FRAMES = 90; // how long the water takes to rise each turn

export type SimInput = { f: number; wormId: number; kind: 'walk' | 'jump'; dir: 1 | -1 };
type SimOpts = { water?: number; seed?: number; crates?: Crate[] };

type ProjSpec = { radius: number; damage: number; fuse: number; bouncy: boolean; wind: boolean };
const PROJ: Record<ProjKind, ProjSpec> = {
  rocket: { radius: 30, damage: 45, fuse: 0, bouncy: false, wind: true },
  grenade: { radius: 34, damage: 50, fuse: 3 * FPS, bouncy: true, wind: false },
  cluster: { radius: 18, damage: 20, fuse: 0, bouncy: false, wind: true },
  bomblet: { radius: 16, damage: 18, fuse: 0, bouncy: false, wind: false },
  missile: { radius: 24, damage: 28, fuse: 0, bouncy: false, wind: false },
  haybomb: { radius: 64, damage: 75, fuse: 4 * FPS, bouncy: true, wind: false },
};

type Proj = { kind: ProjKind; x: number; y: number; vx: number; vy: number; age: number; owner: number; track: Track; dead: boolean };
type Mover = { worm: Worm; vx: number; vy: number; track: Track };
type CrateMover = { c: Crate; vy: number; para: boolean; track: Track };

const round1 = (n: number) => Math.round(n * 10) / 10;

export function footSolid(t: Terrain, x: number, y: number) {
  return t.solid(x, y + WORM_R) || t.solid(x - 3, y + WORM_R) || t.solid(x + 3, y + WORM_R);
}

export function grounded(t: Terrain, w: Worm) {
  return footSolid(t, w.x, w.y + 1);
}

/** Is there room for a worm centred here? */
export function clearSpot(t: Terrain, x: number, y: number, water = WATER_Y) {
  if (x < WORM_R || x > W - WORM_R || y < WORM_R || y > water - WORM_R) return false;
  for (let a = 0; a < 8; a++) {
    const dx = [1, 0.7, 0, -0.7, -1, -0.7, 0, 0.7][a];
    const dy = [0, 0.7, 1, 0.7, 0, -0.7, -1, -0.7][a];
    if (t.solid(x + dx * WORM_R, y + dy * WORM_R)) return false;
  }
  return !t.solid(x, y);
}

/** Walk up to `px` pixels. Climbs small slopes, stops at walls. */
export function walk(t: Terrain, w: Worm, dir: 1 | -1, px: number) {
  let moved = 0;
  for (let i = 0; i < px; i++) {
    const nx = w.x + dir;
    if (nx < WORM_R || nx > W - WORM_R) break;
    let ny = w.y;
    let up = 0;
    while (up <= MAX_CLIMB && t.solid(nx, ny + WORM_R - up)) up++;
    if (up > MAX_CLIMB) break;
    ny -= up;
    // Head and upper body must fit. Slopes are handled by the climb above, so
    // anything up to MAX_CLIMB px per px (about 75°) is walkable.
    if (t.solid(nx, ny - WORM_R) || t.solid(nx + dir * (WORM_R - 3), ny - WORM_R / 2)) break;
    let down = 0;
    while (down <= MAX_CLIMB && !footSolid(t, nx, ny + 1)) {
      ny++;
      down++;
    }
    w.x = nx;
    w.y = ny;
    moved++;
    if (!grounded(t, w)) return { moved, fell: true };
  }
  return { moved, fell: false };
}

// ---- kill cam ----
// The moment a worm is finished off plays in slow motion. Server and clients use
// the same function, so the server waits exactly as long as the clients play.

export const SLOWMO = 0.3;

/** Frames around the first fatal hit (or drowning) in a timeline, and where it is. */
export function killCam(tl: Timeline) {
  let key = Infinity;
  let x = 0;
  let y = 0;
  for (const d of tl.events) {
    if (d.type !== 'die') continue;
    let f = d.f;
    let px = d.x;
    let py = d.y;
    // The moment that counts is the last hit: worms out of HP only die at the
    // end of the timeline, and a drowning usually starts with a blast.
    for (const e of tl.events) if (e.type === 'damage' && e.wormId === d.wormId && e.f <= d.f) [f, px, py] = [e.f, e.x, e.y];
    if (f < key) [key, x, y] = [f, px, py];
  }
  return key === Infinity ? null : { start: Math.max(0, key - 15), end: key + 30, x, y };
}

/** Extra wall-clock time the slow motion adds to a timeline. */
export function killCamExtraMs(tl: Timeline) {
  const k = killCam(tl);
  return k ? ((k.end - k.start) / FPS) * 1000 * (1 / SLOWMO - 1) : 0;
}

/** Which frame to show `secs` seconds into playback (slower through the kill cam). */
export function frameAt(k: ReturnType<typeof killCam>, secs: number) {
  const f = secs * FPS;
  if (!k || f <= k.start) return f;
  const t0 = k.start / FPS;
  const slow = (k.end - k.start) / FPS / SLOWMO;
  if (secs < t0 + slow) return k.start + (secs - t0) * FPS * SLOWMO;
  return k.end + (secs - t0 - slow) * FPS;
}

/** The crate a worm at its current spot is touching, if any. */
export function crateTouching(crates: Crate[], w: Worm) {
  return crates.find((c) => Math.abs(w.x - c.x) < WORM_R + CRATE_R && Math.abs(w.y - c.y) < WORM_R + CRATE_R);
}

/** Give a worm what's in a crate. Weapons go to the team's ammo, which the caller handles. */
export function openCrate(c: Crate, w: Worm) {
  if (c.kind !== 'health') return 0;
  const amount = Math.max(0, Math.min(MAX_HP, w.hp + CRATE_HEALTH) - w.hp);
  w.hp += amount;
  return amount;
}

export class Sim {
  frame = 0;
  private events: SimEvent[] = [];
  private tracks: Track[] = [];
  private projs: Proj[] = [];
  private movers = new Map<number, Mover>();
  private spawns: { frame: number; fn: () => void }[] = [];
  private seq = 0;
  private before: Timeline['before'];
  private rand: () => number;
  /** Current water level; rises during a flood. */
  water: number;
  private flooding: { from: number; to: number; start: number } | null = null;
  private crates: Crate[];
  private cratesSeen: Timeline['crates'];
  private crateMovers = new Map<number, CrateMover>();
  /** Moves by the shooter during the retreat, each applied at its frame. */
  inputs: SimInput[] = [];
  /** Keep the timeline going at least this long (the retreat window). */
  minFrames = 0;

  constructor(
    private t: Terrain,
    private worms: Worm[],
    private craters: Crater[],
    private wind: number,
    opts: SimOpts = {},
  ) {
    this.before = worms.map((w) => ({ id: w.id, x: w.x, y: w.y, hp: w.hp, alive: w.alive }));
    this.water = opts.water ?? WATER_Y;
    this.rand = rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.crates = opts.crates ?? [];
    this.cratesSeen = this.crates.map((c) => ({ ...c, from: 0 }));
  }

  event(e: Omit<SimEvent, 'f'>) {
    this.events.push({ f: this.frame, ...e, x: round1(e.x), y: round1(e.y) });
  }

  private track(kind: Track['kind'], x: number, y: number, extra: Partial<Track> = {}): Track {
    const tr: Track = { key: `${kind}${this.seq++}`, kind, start: this.frame, end: -1, pts: [round1(x), round1(y)], ...extra };
    this.tracks.push(tr);
    return tr;
  }

  private endTrack(tr: Track, x: number, y: number) {
    if (tr.end >= 0) return;
    if ((this.frame - tr.start) % SAMPLE !== 0) tr.pts.push(round1(x), round1(y));
    tr.end = this.frame;
  }

  launch(kind: ProjKind, x: number, y: number, vx: number, vy: number, owner: number) {
    this.projs.push({ kind, x, y, vx, vy, age: 0, owner, track: this.track(kind, x, y), dead: false });
  }

  later(frames: number, fn: () => void) {
    this.spawns.push({ frame: this.frame + frames, fn });
  }

  knock(w: Worm, vx: number, vy: number) {
    const m = this.movers.get(w.id);
    if (m) {
      m.vx += vx;
      m.vy += vy;
    } else {
      this.movers.set(w.id, { worm: w, vx, vy, track: this.track('worm', w.x, w.y, { wormId: w.id }) });
    }
  }

  explode(x: number, y: number, r: number, damage: number, kind: string) {
    const cx = Math.round(x);
    const cy = Math.round(y);
    this.craters.push([cx, cy, r]);
    this.t.carve(cx, cy, r);
    this.event({ type: 'explode', x: cx, y: cy, r, kind, crater: this.craters.length - 1 });

    const reach = r + WORM_R * 1.5;
    for (const w of this.worms) {
      if (!w.alive) continue;
      const dx = w.x - x;
      const dy = w.y - y;
      const d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      const f = 1 - d / reach;
      const amount = Math.max(1, Math.round(damage * (0.3 + 0.7 * f)));
      w.hp = Math.max(0, w.hp - amount);
      this.event({ type: 'damage', x: w.x, y: w.y, wormId: w.id, amount });
      const nx = d > 0.5 ? dx / d : 0;
      const ny = d > 0.5 ? dy / d : -1;
      const kv = (200 + damage * 5) * f;
      this.knock(w, nx * kv, ny * kv - 160 * f);
    }

    // Crates in the blast break open. Weapon crates go off too.
    for (const c of [...this.crates]) {
      if (Math.hypot(c.x - x, c.y - y) >= r + CRATE_R) continue;
      this.removeCrate(c, c.y);
      this.event({ type: 'crate', kind: 'destroy', x: c.x, y: c.y, crateId: c.id });
      if (c.kind === 'weapon') this.later(4, () => this.explode(c.x, c.y, 22, 22, 'crate'));
    }
  }

  // ---- crates ----

  /** Parachute a crate in from above the map at c.x. */
  dropCrate(c: Crate) {
    c.y = -12;
    this.crates.push(c);
    this.cratesSeen.push({ ...c, from: this.frame });
    this.event({ type: 'crate', kind: 'drop', x: c.x, y: c.y, crateId: c.id });
    this.crateMovers.set(c.id, { c, vy: PARA_SPEED, para: true, track: this.track('crate', c.x, c.y, { crateId: c.id, para: true }) });
  }

  private removeCrate(c: Crate, y: number) {
    const m = this.crateMovers.get(c.id);
    if (m) this.endTrack(m.track, c.x, y);
    this.crateMovers.delete(c.id);
    this.crates.splice(this.crates.indexOf(c), 1);
  }

  private crateSupported(c: Crate) {
    const b = c.y + CRATE_R;
    // Narrower than the crate, so one hanging off a ledge by its corner tips off.
    return this.t.solid(c.x - 3, b) || this.t.solid(c.x, b) || this.t.solid(c.x + 3, b);
  }

  private stepCrates() {
    for (const c of [...this.crates]) {
      let m = this.crateMovers.get(c.id);
      if (!m) {
        // The ground under it was blown away: it falls (no parachute this time).
        if (this.crateSupported(c)) continue;
        m = { c, vy: 0, para: false, track: this.track('crate', c.x, c.y, { crateId: c.id }) };
        this.crateMovers.set(c.id, m);
      }
      if (!m.para) m.vy = Math.min(700, m.vy + G * DT);
      const steps = Math.max(1, Math.ceil((m.vy * DT) / 2));
      for (let s = 0; s < steps; s++) {
        c.y += (m.vy * DT) / steps;
        if (c.y > this.water) {
          this.removeCrate(c, this.water);
          this.event({ type: 'splash', x: c.x, y: this.water });
          this.event({ type: 'crate', kind: 'sink', x: c.x, y: this.water, crateId: c.id });
          break;
        }
        if (this.crateSupported(c)) {
          c.y = Math.round(c.y);
          while (this.t.solid(c.x, c.y + CRATE_R - 1) && c.y > 0) c.y--;
          this.endTrack(m.track, c.x, c.y);
          this.crateMovers.delete(c.id);
          this.event({ type: 'crate', kind: 'land', x: c.x, y: c.y, crateId: c.id, amount: Math.round(m.vy) });
          break;
        }
      }
    }
  }

  private pickups() {
    if (!this.crates.length) return;
    for (const w of this.worms) {
      if (!w.alive) continue;
      const c = crateTouching(this.crates, w);
      if (!c) continue;
      const amount = openCrate(c, w);
      this.removeCrate(c, c.y);
      this.event({ type: 'pickup', x: c.x, y: c.y, wormId: w.id, crateId: c.id, kind: c.kind === 'health' ? 'health' : c.weapon, amount });
    }
  }

  // ---- sudden death ----

  /** Raise the water to `to` over FLOOD_FRAMES, drowning anyone it reaches. */
  flood(to: number) {
    this.flooding = { from: this.water, to, start: this.frame };
    this.event({ type: 'flood', x: 0, y: to, amount: this.water });
    this.minFrames = Math.max(this.minFrames, this.frame + FLOOD_FRAMES + 10);
  }

  private stepFlood() {
    const fl = this.flooding;
    if (!fl) return;
    const k = Math.min(1, (this.frame - fl.start) / FLOOD_FRAMES);
    this.water = fl.from + (fl.to - fl.from) * k;
    for (const w of this.worms) {
      if (this.movers.has(w.id) || w.y < this.water) continue;
      if (!w.alive) {
        w.y = this.water + 20; // a grave the sea has covered
        continue;
      }
      w.alive = false;
      w.hp = 0;
      this.event({ type: 'splash', x: w.x, y: this.water });
      this.event({ type: 'die', x: w.x, y: this.water, wormId: w.id, kind: 'drown' });
    }
    for (const c of [...this.crates]) {
      if (this.crateMovers.has(c.id) || c.y < this.water) continue;
      this.removeCrate(c, c.y);
      this.event({ type: 'crate', kind: 'sink', x: c.x, y: c.y, crateId: c.id });
    }
    if (k >= 1) this.flooding = null;
  }

  // ---- retreat ----

  private applyInputs() {
    for (const i of this.inputs) {
      if (i.f !== this.frame) continue;
      const w = this.worms.find((x) => x.id === i.wormId);
      if (!w?.alive || this.movers.has(w.id) || !grounded(this.t, w)) continue;
      w.facing = i.dir;
      if (i.kind === 'jump') {
        this.jump(w);
        continue;
      }
      walk(this.t, w, i.dir, 3);
      // A one-sample track pins the worm's new spot from this frame on.
      this.track('worm', w.x, w.y, { wormId: w.id }).end = this.frame;
    }
  }

  shotgun(w: Worm, angle: number) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let x = w.x + dx * (WORM_R + 2);
    let y = w.y + dy * (WORM_R + 2);
    const sx = x;
    const sy = y;
    for (let i = 0; i < 450; i++) {
      x += dx * 2;
      y += dy * 2;
      if (x < 0 || x > W || y < 0 || y > H) break;
      const hit = this.worms.find((o) => o.alive && o !== w && Math.hypot(o.x - x, o.y - y) < WORM_R);
      if (hit || this.t.solid(x, y)) {
        this.event({ type: 'shot', x: sx, y: sy, x2: x, y2: y });
        this.explode(x, y, 11, 25, 'shotgun');
        return;
      }
    }
    this.event({ type: 'shot', x: sx, y: sy, x2: x, y2: y });
  }

  teleport(w: Worm, tx: number, ty: number) {
    this.event({ type: 'teleport', x: w.x, y: w.y, x2: tx, y2: ty, wormId: w.id });
    w.x = Math.round(tx);
    w.y = Math.round(ty);
  }

  airstrike(tx: number, facing: 1 | -1, owner: number) {
    this.event({ type: 'airstrike', x: tx, y: 0 });
    for (let i = 0; i < 5; i++) {
      const x = tx + (i - 2) * 30 - facing * 60;
      this.later(50 + i * 7, () => {
        this.launch('missile', x, -30, facing * 60, 260, owner);
      });
    }
  }

  jump(w: Worm) {
    this.event({ type: 'jump', x: w.x, y: w.y, wormId: w.id });
    this.knock(w, w.facing * 140, -280);
  }

  private normal(x: number, y: number) {
    let nx = 0;
    let ny = 0;
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++)
        if (this.t.solid(x + dx, y + dy)) {
          nx -= dx;
          ny -= dy;
        }
    const len = Math.hypot(nx, ny);
    return len > 0 ? [nx / len, ny / len] : [0, -1];
  }

  private detonate(p: Proj) {
    p.dead = true;
    this.endTrack(p.track, p.x, p.y);
    const spec = PROJ[p.kind];
    this.explode(p.x, p.y, spec.radius, spec.damage, p.kind);
    if (p.kind === 'cluster') {
      for (let i = 0; i < 5; i++) {
        this.launch('bomblet', p.x, p.y - 6, (i - 2) * 75 + (this.rand() - 0.5) * 40, -240 - this.rand() * 120, -1);
      }
    }
  }

  /**
   * Bounce off a surface with normal (nx, ny): the part of the velocity into
   * the surface flips and shrinks by `bounce`, the part along it keeps
   * `slide` (so grenades roll). Returns the speed into the surface (negative).
   */
  private reflect(p: Proj, nx: number, ny: number, bounce: number, slide: number) {
    const dot = p.vx * nx + p.vy * ny;
    if (dot >= 0) return dot;
    const tx = p.vx - dot * nx;
    const ty = p.vy - dot * ny;
    // Rolling contact happens every frame, so it only gets a little friction.
    if (-dot < 40) slide = 0.985;
    p.vx = tx * slide - dot * nx * bounce;
    p.vy = ty * slide - dot * ny * bounce;
    return dot;
  }

  private bounceOffWorm(p: Proj, w: Worm) {
    const r = WORM_R + 3;
    let nx = p.x - w.x;
    let ny = p.y - w.y;
    const d = Math.hypot(nx, ny);
    if (d < 0.01) [nx, ny] = [0, -1];
    else [nx, ny] = [nx / d, ny / d];
    p.x = w.x + nx * (r + 0.5);
    p.y = w.y + ny * (r + 0.5);
    const dot = this.reflect(p, nx, ny, 0.55, 0.85);
    // Something resting on a head slides off instead of balancing there.
    if (Math.abs(p.vx) < 15) p.vx += (nx >= 0 ? 1 : -1) * 25;
    if (-dot > 50) this.event({ type: 'bounce', x: p.x, y: p.y, kind: p.kind, wormId: w.id });
  }

  private stepProj(p: Proj) {
    const spec = PROJ[p.kind];
    p.age++;
    if (spec.wind) p.vx += this.wind * WIND_ACC * DT;
    p.vy += G * DT;
    const steps = Math.max(1, Math.ceil((Math.max(Math.abs(p.vx), Math.abs(p.vy)) * DT) / 2));

    for (let s = 0; s < steps; s++) {
      const px = p.x;
      const py = p.y;
      p.x += (p.vx * DT) / steps;
      p.y += (p.vy * DT) / steps;

      if (p.y > this.water) {
        p.dead = true;
        this.endTrack(p.track, p.x, this.water);
        this.event({ type: 'splash', x: p.x, y: this.water });
        return;
      }
      if (p.x < -100 || p.x > W + 100) {
        p.dead = true;
        this.endTrack(p.track, p.x, p.y);
        return;
      }
      const hit = this.worms.find((w) => w.alive && (w.id !== p.owner || p.age > 8) && Math.hypot(w.x - p.x, w.y - p.y) < WORM_R + 3);
      if (hit) {
        if (!spec.fuse) return this.detonate(p);
        // Fused bombs bounce off worms like they bounce off the ground.
        this.bounceOffWorm(p, hit);
        break;
      }
      if (this.t.solid(p.x, p.y)) {
        if (!spec.bouncy) return this.detonate(p);
        // Back out of the ground, but keep the sideways part of the move
        // (stepping over 1px bumps) so bombs roll instead of sticking.
        const dx = p.x - px;
        p.x = px;
        p.y = py;
        if (!this.t.solid(px + dx, py)) p.x = px + dx;
        else if (!this.t.solid(px + dx, py - 1)) [p.x, p.y] = [px + dx, py - 1];
        const [nx, ny] = this.normal(px, py);
        const dot = this.reflect(p, nx, ny, 0.45, 0.82);
        if (-dot > 70) this.event({ type: 'bounce', x: p.x, y: p.y, kind: p.kind });
        break;
      }
    }
    if (spec.fuse && p.age >= spec.fuse) this.detonate(p);
  }

  private land(m: Mover) {
    const w = m.worm;
    w.x = Math.round(w.x);
    w.y = Math.round(w.y);
    while (footSolid(this.t, w.x, w.y)) w.y--;
    if (!w.alive) {
      // A grave settling: no damage, no fuss.
      this.endTrack(m.track, w.x, w.y);
      this.movers.delete(w.id);
      return;
    }
    if (m.vy > FALL_SAFE) {
      const amount = Math.min(30, Math.round((m.vy - FALL_SAFE) / 12));
      if (amount > 0) {
        w.hp = Math.max(0, w.hp - amount);
        this.event({ type: 'damage', x: w.x, y: w.y, wormId: w.id, amount });
      }
    }
    this.event({ type: 'land', x: w.x, y: w.y, wormId: w.id, amount: Math.round(m.vy) });
    this.endTrack(m.track, w.x, w.y);
    this.movers.delete(w.id);
  }

  private stepMover(m: Mover) {
    const w = m.worm;
    m.vy += G * DT;
    const steps = Math.max(1, Math.ceil((Math.max(Math.abs(m.vx), Math.abs(m.vy)) * DT) / 1.5));
    for (let s = 0; s < steps; s++) {
      let nx = w.x + (m.vx * DT) / steps;
      let ny = w.y + (m.vy * DT) / steps;

      if (ny > this.water) {
        const wasAlive = w.alive;
        w.alive = false;
        w.hp = 0;
        this.endTrack(m.track, nx, this.water + 20);
        this.movers.delete(w.id);
        // Below the surface, so no grave is drawn for it.
        w.x = nx;
        w.y = this.water + 20;
        this.event({ type: 'splash', x: nx, y: this.water });
        if (wasAlive) this.event({ type: 'die', x: nx, y: this.water, wormId: w.id, kind: 'drown' });
        return;
      }
      if (m.vx !== 0 && this.t.solid(nx + Math.sign(m.vx) * WORM_R, ny)) {
        m.vx = -m.vx * 0.25;
        nx = w.x;
      }
      if (m.vy < 0 && this.t.solid(nx, ny - WORM_R)) {
        m.vy = 20;
        ny = w.y;
      }
      if (m.vy >= 0 && footSolid(this.t, nx, ny)) {
        w.x = nx;
        w.y = ny;
        return this.land(m);
      }
      w.x = nx;
      w.y = ny;
    }
  }

  private settle() {
    for (const w of this.worms) {
      // Living worms and graves (dead worms still above water) fall when nothing holds them up.
      if ((w.alive || w.y < this.water) && !this.movers.has(w.id) && !grounded(this.t, w)) this.knock(w, 0, 0);
    }
  }

  private sample() {
    for (const p of this.projs) if (!p.dead && (this.frame - p.track.start) % SAMPLE === 0) p.track.pts.push(round1(p.x), round1(p.y));
    for (const m of this.movers.values())
      if ((this.frame - m.track.start) % SAMPLE === 0) m.track.pts.push(round1(m.worm.x), round1(m.worm.y));
    for (const m of this.crateMovers.values())
      if ((this.frame - m.track.start) % SAMPLE === 0) m.track.pts.push(round1(m.c.x), round1(m.c.y));
  }

  run(maxFrames = FPS * 30): Timeline {
    this.settle();
    while (this.frame < maxFrames) {
      const due = this.spawns.filter((s) => s.frame <= this.frame);
      this.spawns = this.spawns.filter((s) => s.frame > this.frame);
      due.forEach((s) => s.fn());
      this.applyInputs();

      for (const p of this.projs) if (!p.dead) this.stepProj(p);
      this.projs = this.projs.filter((p) => !p.dead);
      for (const m of [...this.movers.values()]) this.stepMover(m);
      this.stepCrates();
      this.stepFlood();
      this.settle();
      this.pickups();

      this.frame++;
      this.sample();
      const busy = this.projs.length || this.movers.size || this.spawns.length || this.crateMovers.size || this.flooding;
      if (!busy && this.frame >= this.minFrames) break;
    }

    // Anything still flying when time ran out just stops where it is.
    for (const p of this.projs) this.endTrack(p.track, p.x, p.y);
    for (const m of this.movers.values()) this.endTrack(m.track, m.worm.x, m.worm.y);
    for (const m of this.crateMovers.values()) this.endTrack(m.track, m.c.x, m.c.y);

    let tail = 15;
    for (const w of this.worms) {
      if (w.alive && w.hp <= 0) {
        w.alive = false;
        this.frame += 20;
        this.event({ type: 'die', x: w.x, y: w.y, wormId: w.id, kind: 'hp' });
        tail = 50;
      }
    }
    return { frames: this.frame + tail, tracks: this.tracks, events: this.events, before: this.before, crates: this.cratesSeen };
  }
}

/** Fire a weapon from a worm. Returns false if the shot is not allowed. */
export function fire(sim: Sim, t: Terrain, w: Worm, weapon: WeaponId, angle: number, power: number, tx?: number, ty?: number) {
  if (weapon === 'teleport' && tx !== undefined && ty !== undefined && !clearSpot(t, tx, ty, sim.water)) return false;
  const speed = 120 + power * (MAX_SPEED - 120);
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  const mx = w.x + Math.cos(angle) * (WORM_R + 4);
  const my = w.y + Math.sin(angle) * (WORM_R + 4);
  const kindFor: Partial<Record<WeaponId, ProjKind>> = { bazooka: 'rocket', grenade: 'grenade', cluster: 'cluster', haybomb: 'haybomb' };

  const kind = kindFor[weapon];
  if (kind) {
    sim.launch(kind, mx, my, vx, vy, w.id);
    sim.event({ type: 'fire', x: mx, y: my, kind });
    return true;
  }
  if (weapon === 'shotgun') {
    sim.event({ type: 'fire', x: mx, y: my, kind: 'shotgun' });
    sim.shotgun(w, angle);
    return true;
  }
  if (weapon === 'airstrike' && tx !== undefined) {
    sim.airstrike(Math.max(0, Math.min(W, tx)), w.facing, w.id);
    return true;
  }
  if (weapon === 'teleport' && tx !== undefined && ty !== undefined) {
    sim.teleport(w, tx, ty);
    return true;
  }
  return false;
}
