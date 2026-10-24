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

/** What a solid pixel is made of. Only used for drawing; all of it is destructible. */
export const MAT = {
  DIRT: 1,
  ROCK: 2,
  WOOD: 3,
  LEAF: 4,
  HAY: 5,
  GIRDER: 6,
  SNOW: 7,
  CACTUS: 8,
  CANDY: 9,
  STICK: 10,
} as const;

export const THEMES = ['meadow', 'farm', 'desert', 'snow', 'candy'] as const;
export const SHAPES = ['island', 'twin', 'archipelago', 'mountain', 'terraces', 'floating'] as const;
export type ThemeId = (typeof THEMES)[number];
export type ShapeId = (typeof SHAPES)[number];

export const THEME_NAMES: Record<ThemeId, string> = {
  meadow: 'Sunny Meadow',
  farm: 'Hay Farm',
  desert: 'Dusty Desert',
  snow: 'Frosty Peaks',
  candy: 'Candy Land',
};
export const SHAPE_NAMES: Record<ShapeId, string> = {
  island: 'Island',
  twin: 'Twin Isles',
  archipelago: 'Archipelago',
  mountain: 'Mountain',
  terraces: 'Terraces',
  floating: 'Sky Islands',
};

export function mapInfo(seed: number): { theme: ThemeId; shape: ShapeId } {
  const r = rng(seed ^ 0x5bd1e995);
  return { theme: THEMES[Math.floor(r() * THEMES.length)], shape: SHAPES[Math.floor(r() * SHAPES.length)] };
}

export class Terrain {
  readonly mask = new Uint8Array(W * H);
  /** Material per pixel, see MAT. Stale (non-zero) where the mask was carved away. */
  readonly mat = new Uint8Array(W * H);
  /** Circles carved out as caves and tunnels, so the renderer can give them a back wall. */
  readonly caves: [number, number, number][] = [];

  constructor(
    readonly theme: ThemeId = 'meadow',
    readonly shape: ShapeId = 'island',
  ) {}

  solid(x: number, y: number) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return this.mask[y * W + x] === 1;
  }

  private set(x: number, y: number, m: number) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = y * W + x;
    this.mask[i] = 1;
    this.mat[i] = m;
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

  // ---- stamps used for scenery ----
  private ellipse(cx: number, cy: number, rx: number, ry: number, m: number, onlyAbove = H) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      if (y > onlyAbove) break;
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, m);
      }
    }
  }

  private rect(x0: number, y0: number, x1: number, y1: number, m: number) {
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) this.set(x, y, m);
  }

  /** Upward-pointing triangle with its tip at (cx, top). */
  private tri(cx: number, top: number, halfBase: number, height: number, m: number) {
    for (let y = 0; y <= height; y++) {
      const hw = (halfBase * y) / height;
      for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) this.set(x, Math.round(top + y), m);
    }
  }

  private matAt(x: number, y: number) {
    return this.solid(x, y) ? this.mat[Math.floor(y) * W + Math.floor(x)] : 0;
  }

  static generate(seed: number, craters: [number, number, number][] = []) {
    const { theme, shape } = mapInfo(seed);
    const t = new Terrain(theme, shape);
    const rand = rng(seed);
    const between = (a: number, b: number) => a + rand() * (b - a);
    const int = (a: number, b: number) => Math.floor(between(a, b + 1));

    // ---- ground height: three octaves of smoothed value noise ----
    const ampScale = shape === 'floating' ? 0.45 : shape === 'terraces' ? 1.15 : 1;
    const octaves = [
      { period: 320, amp: 130 * ampScale },
      { period: 120, amp: 48 * ampScale },
      { period: 40, amp: 10 },
    ].map((o) => ({ ...o, pts: Array.from({ length: Math.ceil(W / o.period) + 2 }, () => rand() * 2 - 1) }));

    const base = H * ({ island: 0.56, twin: 0.55, archipelago: 0.6, mountain: 0.7, terraces: 0.56, floating: 0.86 } as const)[shape];

    // Gaps of open sea between islands.
    const gaps: { x: number; w: number }[] = [];
    if (shape === 'twin') gaps.push({ x: W / 2 + between(-80, 80), w: between(70, 100) });
    if (shape === 'archipelago') {
      const n = int(3, 4);
      for (let i = 1; i < n; i++) gaps.push({ x: (W * i) / n + between(-40, 40), w: between(42, 60) });
    }
    const peakX = W / 2 + between(-120, 120);

    const heights: number[] = [];
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
      const edge = Math.min(x, W - 1 - x) / 170;
      if (edge < 1) h += (1 - edge) * (1 - edge) * 360;
      for (const g of gaps) {
        const d = (x - g.x) / g.w;
        if (d > -1 && d < 1) h += (1 - d * d) * 420;
      }
      if (shape === 'mountain') {
        const d = Math.abs(x - peakX) / 380;
        if (d < 1) {
          const k = 1 - d;
          h -= k * k * (3 - 2 * k) * 250;
        }
      }
      if (shape === 'terraces') {
        const q = Math.round(h / 36) * 36;
        h = q + (h - q) * 0.2;
      }
      heights.push(h);
      const top = Math.max(110, Math.min(H, Math.round(h)));
      for (let y = top; y < H; y++) t.set(x, y, MAT.DIRT);
    }

    // ---- boulders buried in the ground ----
    for (let i = int(4, 8); i > 0; i--) {
      const x = Math.round(between(80, W - 80));
      const y = Math.round(heights[x] + between(25, 110));
      if (y < H - 20) t.ellipse(x, y, between(14, 30), between(10, 20), MAT.ROCK);
    }

    // ---- caves and winding tunnels ----
    const caves = (shape === 'mountain' ? 7 : 4) + int(0, 3);
    for (let i = 0; i < caves; i++) {
      const x = Math.round(between(150, W - 150));
      const y = Math.round(t.surfaceY(x) + 50 + rand() * 120);
      const r = Math.round(18 + rand() * 26);
      t.carve(x, y, r);
      t.caves.push([x, y, r]);
    }
    const tunnels = shape === 'floating' ? 0 : shape === 'mountain' ? int(2, 3) : int(0, 2);
    for (let i = 0; i < tunnels; i++) {
      let x = between(200, W - 200);
      let y = t.surfaceY(Math.round(x)) + between(50, 90);
      const dir = rand() < 0.5 ? -1 : 1;
      let dy = 0;
      for (let k = int(18, 34); k > 0; k--) {
        dy = Math.max(-3, Math.min(3, dy + between(-1.5, 1.5)));
        x += dir * 7;
        y = Math.min(WATER_Y - 40, y + dy);
        if (x < 60 || x > W - 60) break;
        const c: [number, number, number] = [Math.round(x), Math.round(y), Math.round(between(13, 17))];
        t.carve(...c);
        t.caves.push(c);
      }
    }

    // ---- floating islands: flat-ish tops, pointy bottoms ----
    const ledges = shape === 'floating' ? int(6, 8) : int(2, 3);
    for (let i = 0; i < ledges; i++) {
      const cx = Math.round(shape === 'floating' ? ((i + 0.5) * W) / ledges + between(-40, 40) : between(180, W - 180));
      const big = shape === 'floating';
      const rx = Math.round(big ? between(65, 110) : between(45, 90));
      const ry = Math.round(big ? between(14, 22) : between(10, 18));
      const ground = heights[Math.max(0, Math.min(W - 1, cx))];
      const cy = Math.round(Math.min(big ? between(150, 400) : between(130, 250), ground - ry * 3 - 50));
      if (cy < 100) continue;
      for (let y = cy - ry; y <= cy + ry * 2.4; y++)
        for (let x = cx - rx; x <= cx + rx; x++) {
          const dx = (x - cx) / rx;
          const dy = y < cy ? (y - cy) / ry : (y - cy) / (ry * 2.4);
          if (dx * dx + dy * dy <= 1) t.set(x, y, MAT.DIRT);
        }
    }

    // ---- girder bridges over the gaps ----
    for (const g of gaps) {
      if (rand() < 0.35) continue;
      const x0 = Math.round(g.x - g.w - 30);
      const x1 = Math.round(g.x + g.w + 30);
      const y = Math.round(Math.min(heights[Math.round(g.x - g.w)], heights[Math.round(g.x + g.w)]) - 2);
      if (y > WATER_Y - 60) continue;
      t.rect(x0, y, x1, y + 6, MAT.GIRDER);
    }

    // ---- scenery on the surface ----
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const kinds: Record<ThemeId, string[]> = {
      meadow: ['tree', 'tree', 'tree', 'bale', 'rock', 'bush'],
      farm: ['bale', 'bale', 'stack', 'tree', 'rock', 'bale'],
      desert: ['cactus', 'cactus', 'cactus', 'rock', 'pyramid', 'bones'],
      snow: ['pine', 'pine', 'pine', 'snowman', 'rock', 'pine'],
      candy: ['lolly', 'lolly', 'gumdrop', 'gumdrop', 'cane', 'lolly'],
    };
    let pyramids = 0;
    for (let n = int(8, 12); n > 0; n--) {
      const x = Math.round(between(70, W - 70));
      const y = t.surfaceY(x);
      if (y > WATER_Y - 25 || y < 140) continue;
      // Only on bare ground, and not on a steep slope.
      if (t.matAt(x, y) !== MAT.DIRT) continue;
      if (Math.abs(t.surfaceY(x - 8) - t.surfaceY(x + 8)) > 12) continue;
      const k = pick(kinds[theme]);
      const sy = y + 3; // sink scenery into the ground a little
      switch (k) {
        case 'tree': {
          const h = int(28, 46);
          t.rect(x - 3, sy - h, x + 3, sy, MAT.WOOD);
          const r = int(15, 21);
          t.ellipse(x, sy - h - r * 0.4, r, r * 0.85, MAT.LEAF);
          t.ellipse(x - r * 0.7, sy - h + 2, r * 0.6, r * 0.5, MAT.LEAF);
          t.ellipse(x + r * 0.7, sy - h + 2, r * 0.6, r * 0.5, MAT.LEAF);
          break;
        }
        case 'bush':
          t.ellipse(x, sy - 4, int(14, 20), int(9, 12), MAT.LEAF);
          break;
        case 'pine': {
          const h = int(46, 70);
          t.rect(x - 3, sy - 12, x + 3, sy, MAT.WOOD);
          t.tri(x, sy - h, h * 0.32, h * 0.55, MAT.LEAF);
          t.tri(x, sy - h * 0.62, h * 0.4, h * 0.52, MAT.LEAF);
          break;
        }
        case 'bale':
          t.rect(x - 16, sy - 20, x + 16, sy, MAT.HAY);
          break;
        case 'stack':
          t.rect(x - 32, sy - 20, x + 32, sy, MAT.HAY);
          t.rect(x - 16, sy - 41, x + 16, sy - 21, MAT.HAY);
          break;
        case 'rock':
          t.ellipse(x, sy - 2, int(13, 22), int(9, 15), MAT.ROCK);
          break;
        case 'cactus': {
          const h = int(30, 48);
          t.rect(x - 4, sy - h, x + 4, sy, MAT.CACTUS);
          t.ellipse(x, sy - h, 4, 4, MAT.CACTUS);
          const side = rand() < 0.5 ? -1 : 1;
          const ay = sy - h * 0.55;
          t.rect(Math.min(x, x + side * 12), ay, Math.max(x, x + side * 12), ay + 6, MAT.CACTUS);
          t.rect(x + side * 12 - 3, ay - 14, x + side * 12 + 3, ay + 6, MAT.CACTUS);
          t.ellipse(x + side * 12, ay - 14, 3, 3, MAT.CACTUS);
          break;
        }
        case 'pyramid': {
          if (pyramids++) break;
          const h = int(45, 60);
          t.tri(x, sy - h, h * 1.1, h, MAT.ROCK);
          break;
        }
        case 'bones':
          t.ellipse(x, sy - 5, 9, 7, MAT.STICK);
          t.rect(x - 16, sy - 3, x + 16, sy, MAT.STICK);
          break;
        case 'snowman':
          t.ellipse(x, sy - 10, 12, 11, MAT.SNOW);
          t.ellipse(x, sy - 27, 9, 8, MAT.SNOW);
          t.ellipse(x, sy - 39, 6, 6, MAT.SNOW);
          break;
        case 'lolly': {
          const h = int(30, 46);
          t.rect(x - 2, sy - h, x + 2, sy, MAT.STICK);
          const r = int(12, 17);
          t.ellipse(x, sy - h - r + 3, r, r, MAT.CANDY);
          break;
        }
        case 'cane': {
          const h = int(36, 50);
          t.rect(x - 3, sy - h, x + 3, sy, MAT.CANDY);
          t.ellipse(x - 8, sy - h, 11, 8, MAT.CANDY, sy - h);
          t.carve(x - 8, sy - h + 2, 4);
          break;
        }
        case 'gumdrop':
          t.ellipse(x, sy, int(13, 18), int(14, 19), MAT.ROCK, sy);
          break;
      }
    }

    for (const [x, y, r] of craters) t.carve(x, y, r);
    return t;
  }
}
