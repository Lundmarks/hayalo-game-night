// Destructible terrain. The map is rebuilt from a seed plus the list of
// craters, so the server never has to send pixels. Generation only uses
// + - * / and Math.round/floor, which give identical results in every JS
// engine (unlike Math.sin), so server and clients always agree.

export const W = 1280;
export const H = 640;
export const WATER_Y = 605;

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Terrain {
  readonly mask = new Uint8Array(W * H);

  solid(x: number, y: number) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return this.mask[y * W + x] === 1;
  }

  private circle(cx: number, cy: number, r: number, v: 0 | 1) {
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      const dy = y - cy;
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.mask[y * W + x] = v;
      }
    }
  }

  carve(cx: number, cy: number, r: number) {
    this.circle(cx, cy, r, 0);
  }

  /** Top-most solid pixel in a column, or H if none. */
  surfaceY(x: number) {
    x = Math.floor(x);
    for (let y = 0; y < H; y++) if (this.mask[y * W + x]) return y;
    return H;
  }

  static generate(seed: number, craters: [number, number, number][] = []) {
    const t = new Terrain();
    const rand = rng(seed);

    // Rolling hills: three octaves of smoothed value noise.
    const octaves = [
      { period: 320, amp: 130 },
      { period: 120, amp: 48 },
      { period: 40, amp: 10 },
    ].map((o) => ({ ...o, pts: Array.from({ length: Math.ceil(W / o.period) + 2 }, () => rand() * 2 - 1) }));

    const base = H * 0.56;
    for (let x = 0; x < W; x++) {
      let h = base;
      for (const o of octaves) {
        const p = x / o.period;
        const i = Math.floor(p);
        const f = p - i;
        const s = f * f * (3 - 2 * f);
        h += o.amp * (o.pts[i] * (1 - s) + o.pts[i + 1] * s);
      }
      // Sink the edges into the sea so the map reads as an island.
      const edge = Math.min(x, W - 1 - x) / 140;
      if (edge < 1) h += (1 - edge) * (1 - edge) * 260;
      const top = Math.max(150, Math.min(H, Math.round(h)));
      for (let y = top; y < H; y++) t.mask[y * W + x] = 1;
    }

    // Caves under the surface.
    const caves = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < caves; i++) {
      const x = Math.round(150 + rand() * (W - 300));
      const y = Math.round(t.surfaceY(x) + 50 + rand() * 120);
      t.carve(x, y, Math.round(18 + rand() * 26));
    }

    // Floating ledges.
    const ledges = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < ledges; i++) {
      const cx = Math.round(180 + rand() * (W - 360));
      const cy = Math.round(130 + rand() * 120);
      const rx = Math.round(45 + rand() * 45);
      const ry = Math.round(10 + rand() * 8);
      for (let y = cy - ry; y <= cy + ry; y++)
        for (let x = cx - rx; x <= cx + rx; x++) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          if (dx * dx + dy * dy <= 1 && x >= 0 && x < W) t.mask[y * W + x] = 1;
        }
    }

    for (const [x, y, r] of craters) t.carve(x, y, r);
    return t;
  }
}
