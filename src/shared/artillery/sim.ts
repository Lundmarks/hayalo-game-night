// Physics for one shot (or a jump/fall). Runs on the server only; clients get
// the resulting Timeline and play it back.
import { Terrain, W, H, WATER_Y } from './terrain.ts';
import type { Crater, ProjKind, SimEvent, Timeline, Track, WeaponId, Worm } from './types.ts';

export const FPS = 60;
export const SAMPLE = 2; // record positions every 2 frames (30 per second)
const DT = 1 / FPS;

export const G = 480;
export const MAX_SPEED = 820;
export const WIND_ACC = 190;
export const WORM_R = 9;
export const MAX_CLIMB = 5;
const FALL_SAFE = 430;

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

const round1 = (n: number) => Math.round(n * 10) / 10;

export function footSolid(t: Terrain, x: number, y: number) {
  return t.solid(x, y + WORM_R) || t.solid(x - 3, y + WORM_R) || t.solid(x + 3, y + WORM_R);
}

export function grounded(t: Terrain, w: Worm) {
  return footSolid(t, w.x, w.y + 1);
}

/** Is there room for a worm centred here? */
export function clearSpot(t: Terrain, x: number, y: number) {
  if (x < WORM_R || x > W - WORM_R || y < WORM_R || y > WATER_Y - WORM_R) return false;
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
    if (t.solid(nx, ny - WORM_R) || t.solid(nx + dir * WORM_R, ny - 2)) break;
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

export class Sim {
  frame = 0;
  private events: SimEvent[] = [];
  private tracks: Track[] = [];
  private projs: Proj[] = [];
  private movers = new Map<number, Mover>();
  private spawns: { frame: number; fn: () => void }[] = [];
  private seq = 0;
  private before: Timeline['before'];

  constructor(
    private t: Terrain,
    private worms: Worm[],
    private craters: Crater[],
    private wind: number,
  ) {
    this.before = worms.map((w) => ({ id: w.id, x: w.x, y: w.y, hp: w.hp, alive: w.alive }));
  }

  event(e: Omit<SimEvent, 'f'>) {
    this.events.push({ f: this.frame, ...e, x: round1(e.x), y: round1(e.y) });
  }

  private track(kind: Track['kind'], x: number, y: number, wormId?: number): Track {
    const tr: Track = { key: `${kind}${this.seq++}`, kind, wormId, start: this.frame, end: -1, pts: [round1(x), round1(y)] };
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
      this.movers.set(w.id, { worm: w, vx, vy, track: this.track('worm', w.x, w.y, w.id) });
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
        this.launch('bomblet', p.x, p.y - 6, (i - 2) * 75 + (Math.random() - 0.5) * 40, -240 - Math.random() * 120, -1);
      }
    }
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

      if (p.y > WATER_Y) {
        p.dead = true;
        this.endTrack(p.track, p.x, WATER_Y);
        this.event({ type: 'splash', x: p.x, y: WATER_Y });
        return;
      }
      if (p.x < -100 || p.x > W + 100) {
        p.dead = true;
        this.endTrack(p.track, p.x, p.y);
        return;
      }
      if (!spec.fuse) {
        const hit = this.worms.find((w) => w.alive && (w.id !== p.owner || p.age > 8) && Math.hypot(w.x - p.x, w.y - p.y) < WORM_R + 3);
        if (hit) return this.detonate(p);
      }
      if (this.t.solid(p.x, p.y)) {
        if (!spec.bouncy) return this.detonate(p);
        p.x = px;
        p.y = py;
        const [nx, ny] = this.normal(px, py);
        const dot = p.vx * nx + p.vy * ny;
        if (dot < 0) {
          p.vx = (p.vx - 2 * dot * nx) * 0.5;
          p.vy = (p.vy - 2 * dot * ny) * 0.5;
        }
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

      if (ny > WATER_Y) {
        w.alive = false;
        w.hp = 0;
        this.endTrack(m.track, nx, WATER_Y);
        this.movers.delete(w.id);
        this.event({ type: 'splash', x: nx, y: WATER_Y });
        this.event({ type: 'die', x: nx, y: WATER_Y, wormId: w.id, kind: 'drown' });
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
      if (w.alive && !this.movers.has(w.id) && !grounded(this.t, w)) this.knock(w, 0, 0);
    }
  }

  private sample() {
    for (const p of this.projs) if (!p.dead && (this.frame - p.track.start) % SAMPLE === 0) p.track.pts.push(round1(p.x), round1(p.y));
    for (const m of this.movers.values())
      if ((this.frame - m.track.start) % SAMPLE === 0) m.track.pts.push(round1(m.worm.x), round1(m.worm.y));
  }

  run(maxFrames = FPS * 30): Timeline {
    this.settle();
    while (this.frame < maxFrames) {
      const due = this.spawns.filter((s) => s.frame <= this.frame);
      this.spawns = this.spawns.filter((s) => s.frame > this.frame);
      due.forEach((s) => s.fn());

      for (const p of this.projs) if (!p.dead) this.stepProj(p);
      this.projs = this.projs.filter((p) => !p.dead);
      for (const m of [...this.movers.values()]) this.stepMover(m);
      this.settle();

      this.frame++;
      this.sample();
      if (!this.projs.length && !this.movers.size && !this.spawns.length) break;
    }

    // Anything still flying when time ran out just stops where it is.
    for (const p of this.projs) this.endTrack(p.track, p.x, p.y);
    for (const m of this.movers.values()) this.endTrack(m.track, m.worm.x, m.worm.y);

    let tail = 15;
    for (const w of this.worms) {
      if (w.alive && w.hp <= 0) {
        w.alive = false;
        this.frame += 20;
        this.event({ type: 'die', x: w.x, y: w.y, wormId: w.id, kind: 'hp' });
        tail = 50;
      }
    }
    return { frames: this.frame + tail, tracks: this.tracks, events: this.events, before: this.before };
  }
}

/** Fire a weapon from a worm. Returns false if the shot is not allowed. */
export function fire(sim: Sim, t: Terrain, w: Worm, weapon: WeaponId, angle: number, power: number, tx?: number, ty?: number) {
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
    if (!clearSpot(t, tx, ty)) return false;
    sim.teleport(w, tx, ty);
    return true;
  }
  return false;
}
