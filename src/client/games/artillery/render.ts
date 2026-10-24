import { WORM_R } from '../../../shared/artillery/sim.ts';
import { H, MAT, Terrain, W, WATER_Y, type ThemeId } from '../../../shared/artillery/terrain.ts';
import { partyOf } from '../../../shared/artillery/politicians.ts';
import type { ProjKind } from '../../../shared/artillery/types.ts';

const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

type RGB = [number, number, number];
const css = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const INK = '#2b1d33'; // cartoon outline colour

export type Palette = {
  sky: [string, string, string];
  hills: [string, string];
  hillStyle: 'round' | 'peaks' | 'dunes';
  water: [string, string];
  foam: string;
  top: RGB;
  topDark: RGB;
  dirt: RGB;
  spot: RGB;
  rock: RGB;
  leaf: RGB;
  outline: RGB;
  sun: string;
  blades: boolean;
  flowers: boolean;
  sprinkles: boolean;
  snowCaps: boolean;
  debris: string[];
  weather: 'birds' | 'snow';
};

export const PALETTES: Record<ThemeId, Palette> = {
  meadow: {
    sky: ['#4aa8ff', '#8fd3ff', '#e6f7ff'],
    hills: ['#8cc7a8', '#6fb38f'],
    hillStyle: 'round',
    water: ['#3b9cf0', '#1a4fa8'],
    foam: '#e8f6ff',
    top: [122, 214, 76],
    topDark: [72, 150, 44],
    dirt: [156, 102, 58],
    spot: [124, 78, 42],
    rock: [150, 152, 166],
    leaf: [86, 190, 70],
    outline: [52, 34, 30],
    sun: '#ffe066',
    blades: true,
    flowers: true,
    sprinkles: false,
    snowCaps: false,
    debris: ['#9c663a', '#7ad64c', '#7c4e2a'],
    weather: 'birds',
  },
  farm: {
    sky: ['#5ab0ff', '#ffd59e', '#ffb07a'],
    hills: ['#d9b26a', '#c49448'],
    hillStyle: 'round',
    water: ['#4aa0d8', '#235a96'],
    foam: '#fff3dc',
    top: [176, 214, 74],
    topDark: [120, 156, 40],
    dirt: [170, 112, 62],
    spot: [138, 86, 44],
    rock: [160, 150, 140],
    leaf: [110, 180, 60],
    outline: [60, 36, 24],
    sun: '#ffd23f',
    blades: true,
    flowers: true,
    sprinkles: false,
    snowCaps: false,
    debris: ['#aa703e', '#e8c04a', '#b0d64a'],
    weather: 'birds',
  },
  desert: {
    sky: ['#3fa2e8', '#9ed6f0', '#ffe7b0'],
    hills: ['#f0c68a', '#e0a868'],
    hillStyle: 'dunes',
    water: ['#36c2c9', '#13708a'],
    foam: '#e6fffb',
    top: [246, 214, 128],
    topDark: [214, 172, 92],
    dirt: [218, 158, 96],
    spot: [192, 128, 72],
    rock: [196, 128, 84],
    leaf: [90, 170, 80],
    outline: [90, 46, 24],
    sun: '#fff07a',
    blades: false,
    flowers: false,
    sprinkles: false,
    snowCaps: false,
    debris: ['#daa060', '#f6d680', '#c48050'],
    weather: 'birds',
  },
  snow: {
    sky: ['#6aaee8', '#b4dcff', '#f0f8ff'],
    hills: ['#c8dcf0', '#a8c4e4'],
    hillStyle: 'peaks',
    water: ['#5aa4d8', '#1f4f88'],
    foam: '#ffffff',
    top: [250, 252, 255],
    topDark: [196, 216, 240],
    dirt: [118, 128, 160],
    spot: [96, 104, 136],
    rock: [168, 184, 210],
    leaf: [40, 120, 80],
    outline: [36, 40, 70],
    sun: '#fff6b0',
    blades: false,
    flowers: false,
    sprinkles: false,
    snowCaps: true,
    debris: ['#ffffff', '#7680a0', '#d8e8ff'],
    weather: 'snow',
  },
  candy: {
    sky: ['#ff8fd0', '#ffc4e8', '#fff2fa'],
    hills: ['#f7b6e0', '#d9a0f0'],
    hillStyle: 'round',
    water: ['#ff7ac0', '#b03a8a'],
    foam: '#fff0fa',
    top: [255, 128, 196],
    topDark: [230, 84, 160],
    dirt: [128, 74, 46],
    spot: [102, 56, 34],
    rock: [130, 230, 190],
    leaf: [120, 220, 120],
    outline: [70, 30, 40],
    sun: '#fff59a',
    blades: false,
    flowers: false,
    sprinkles: true,
    snowCaps: false,
    debris: ['#804a2e', '#ff80c4', '#82e6be', '#fff07a'],
    weather: 'birds',
  },
};

const SPRINKLES: RGB[] = [[255, 90, 90], [90, 200, 255], [255, 230, 80], [130, 240, 130], [255, 255, 255], [190, 120, 255]];
const FLOWERS: RGB[] = [[255, 90, 120], [255, 230, 70], [255, 255, 255], [180, 120, 255], [255, 150, 60]];

/** Paint the terrain into a canvas: inked outline, grass on top, patterned materials below. */
export function buildTerrainCanvas(t: Terrain) {
  const pal = PALETTES[t.theme];
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const m = t.mask;
  // Off the sides and bottom counts as solid so the map border gets no outline.
  const solid = (x: number, y: number) => (y < 0 ? false : x < 0 || x >= W || y >= H ? true : m[y * W + x] === 1);
  const put = (i: number, c: RGB) => {
    const o = i * 4;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = 255;
  };

  // Pixels inside caves: no grass grows on cave floors, and they get a back wall.
  const cave = new Uint8Array(W * H);
  for (const [cx, cy, r] of t.caves)
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) cave[y * W + x] = 1;

  for (let x = 0; x < W; x++) {
    let depth = 0;
    let sky = true; // is the air above this run of ground open sky?
    // Wavy bottom edge on the grass, like dripping icing.
    const g0 = hash(Math.floor(x / 6), 9);
    const g1 = hash(Math.floor(x / 6) + 1, 9);
    const f = (x % 6) / 6;
    const grass = 6 + Math.round((g0 * (1 - f) + g1 * f) * 5);
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (!m[i]) {
        depth = 0;
        continue;
      }
      if (depth === 0) sky = y === 0 || !cave[i - W];
      depth++;
      const edge =
        !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1) || !solid(x - 2, y) || !solid(x + 2, y) || !solid(x, y - 2);
      if (edge) {
        put(i, pal.outline);
        continue;
      }
      const n = hash(x, y);
      const mat = t.mat[i];
      let col: RGB;
      if (pal.snowCaps && depth <= 5 && mat !== MAT.DIRT && mat !== MAT.GIRDER) {
        col = n > 0.5 ? [250, 252, 255] : [232, 242, 255];
        put(i, col);
        continue;
      }
      switch (mat) {
        case MAT.ROCK: {
          const facet = (hash(Math.floor(x / 6), Math.floor(y / 5)) - 0.5) * 26;
          col = [pal.rock[0] + facet, pal.rock[1] + facet, pal.rock[2] + facet];
          if (depth <= 4) col = [col[0] + 22, col[1] + 22, col[2] + 22];
          break;
        }
        case MAT.WOOD: {
          const grain = (x + Math.floor(hash(x, y >> 3) * 2)) % 4 === 0;
          col = grain ? [104, 64, 36] : [140, 90, 52];
          break;
        }
        case MAT.LEAF: {
          const cx = Math.floor(x / 7);
          const cy = Math.floor(y / 7);
          const h = hash(cx, cy);
          const dx = x - (cx * 7 + 3.5);
          const dy = y - (cy * 7 + 3.5);
          const spot = h > 0.6 && dx * dx + dy * dy < 4 + h * 4;
          const k = depth <= 4 ? 24 : spot ? 16 : 0;
          col = [pal.leaf[0] + k, pal.leaf[1] + k, pal.leaf[2] + k];
          if (depth > 14) col = [col[0] - 20, col[1] - 24, col[2] - 16];
          break;
        }
        case MAT.HAY: {
          const strand = hash(x >> 1, y) > 0.86;
          col = y % 7 === 0 ? [196, 148, 40] : strand ? [252, 220, 120] : [236, 194, 76];
          if (x % 18 === 0) col = [176, 120, 40]; // twine
          break;
        }
        case MAT.GIRDER:
          col = depth <= 2 ? [244, 120, 80] : (x % 14 === 7 && depth === 4) ? [110, 40, 24] : [212, 84, 48];
          break;
        case MAT.SNOW:
          col = n > 0.4 ? [252, 253, 255] : [228, 238, 252];
          break;
        case MAT.CACTUS:
          col = x % 4 === 0 ? [56, 136, 60] : depth <= 3 ? [120, 210, 110] : [82, 172, 80];
          if (n > 0.97) col = [250, 250, 220]; // spines
          break;
        case MAT.CANDY:
          col = ((x + y) >> 3) & 1 ? [238, 56, 92] : [255, 246, 246];
          break;
        case MAT.STICK:
          col = n > 0.5 ? [248, 244, 236] : [232, 226, 214];
          break;
        default: {
          // Dirt with grass on top.
          if (depth <= grass && sky) {
            col = depth <= 4 ? pal.top : [(pal.top[0] + pal.topDark[0]) / 2, (pal.top[1] + pal.topDark[1]) / 2, (pal.top[2] + pal.topDark[2]) / 2];
            break;
          }
          if (depth <= grass + 2 && sky) {
            col = pal.topDark;
            break;
          }
          const dark = Math.min(38, depth * 0.12);
          const band = (Math.floor((y + hash(x >> 4, 0) * 10) / 26) % 2) * 9;
          col = [pal.dirt[0] - dark - band, pal.dirt[1] - dark - band, pal.dirt[2] - dark * 0.6 - band];
          const cx = Math.floor(x / 9);
          const cy = Math.floor(y / 9);
          const h = hash(cx, cy);
          if (h > 0.72) {
            const dx = x - (cx * 9 + 4.5 + (hash(cx, cy + 99) - 0.5) * 3);
            const dy = y - (cy * 9 + 4.5);
            if (pal.sprinkles) {
              if (Math.abs(dx) < 2.5 && Math.abs(dy) < 1) col = SPRINKLES[Math.floor(h * 97) % SPRINKLES.length];
            } else if (dx * dx + dy * dy < 2 + (h - 0.72) * 18) {
              col = [pal.spot[0] - dark, pal.spot[1] - dark, pal.spot[2] - dark * 0.6];
            }
          }
          if (n > 0.992) col = [col[0] + 50, col[1] + 44, col[2] + 36]; // pebbles
        }
      }
      put(i, col);
    }
  }

  // Caves get a dark back wall so they read as hollows rather than holes.
  for (let i = 0; i < W * H; i++) {
    if (!cave[i] || m[i]) continue;
    const n = hash((i % W) >> 2, Math.floor(i / W) >> 2) * 10;
    put(i, [pal.dirt[0] * 0.5 + n, pal.dirt[1] * 0.48 + n, pal.dirt[2] * 0.52 + n]);
    px[i * 4 + 3] = 235;
  }

  // Grass blades and flowers poking up from the ground (drawing only, not solid).
  if (pal.blades) {
    for (let x = 1; x < W - 1; x++) {
      for (let y = 1; y < H; y++) {
        if (!m[y * W + x] || m[(y - 1) * W + x] || t.mat[y * W + x] !== MAT.DIRT) continue;
        const h = hash(x, y * 3);
        if (h < 0.4) {
          const len = 2 + Math.floor(hash(x, y) * 4);
          for (let k = 1; k <= len && y - k >= 0; k++) put((y - k) * W + x, k === len ? pal.top : pal.topDark);
        } else if (pal.flowers && h > 0.988 && y > 8) {
          for (let k = 1; k <= 5; k++) put((y - k) * W + x, [60, 140, 40]);
          const fc = FLOWERS[Math.floor(hash(y, x) * FLOWERS.length)];
          for (const [dx, dy] of [[0, -7], [-1, -6], [1, -6], [0, -5]]) if (x + dx > 0 && x + dx < W) put((y + dy) * W + x + dx, fc);
          put((y - 6) * W + x, [255, 220, 60]);
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function carveCanvas(c: HTMLCanvasElement, x: number, y: number, r: number, theme: ThemeId) {
  const ctx = c.getContext('2d')!;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // Ink the new edge and scorch around it.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.strokeStyle = 'rgba(30, 14, 6, 0.32)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = css(PALETTES[theme].outline);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Distant hills, drawn once per map. */
export function buildBackdrop(theme: ThemeId) {
  const pal = PALETTES[theme];
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const hills = (base: number, amp: number, color: string, seed: number) => {
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(40, 30, 60, 0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-10, H);
    for (let x = -10; x <= W + 10; x += 6) {
      let y: number;
      if (pal.hillStyle === 'peaks') {
        const p = (x / 150 + seed) % 2;
        y = base - (1 - Math.abs(p - 1)) * amp * 2.2 + Math.sin(x / 37 + seed) * 6;
      } else if (pal.hillStyle === 'dunes') {
        y = base + Math.sin(x / 210 + seed) * amp + Math.sin(x / 90 + seed * 3) * amp * 0.25;
      } else {
        y = base + Math.sin(x / 140 + seed) * amp + Math.sin(x / 53 + seed * 2) * amp * 0.35;
      }
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 10, H);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (pal.hillStyle === 'peaks') {
      // Snow caps on the peaks.
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let k = 0; k * 300 < W + 300; k++) {
        const px = (k * 2 - seed) * 150 + 150;
        const py = base - amp * 2.2;
        ctx.beginPath();
        ctx.moveTo(px - 30, py + 30);
        ctx.lineTo(px, py);
        ctx.lineTo(px + 30, py + 30);
        ctx.lineTo(px + 15, py + 24);
        ctx.lineTo(px, py + 32);
        ctx.lineTo(px - 15, py + 24);
        ctx.fill();
      }
    }
  };
  hills(320, 40, pal.hills[0], 1);
  hills(390, 30, pal.hills[1], 4);
  return c;
}

export function drawSky(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pal.sky[0]);
  g.addColorStop(0.6, pal.sky[1]);
  g.addColorStop(1, pal.sky[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** A smiling cartoon sun with slowly turning rays. */
export function drawSun(ctx: CanvasRenderingContext2D, time: number, pal: Palette) {
  const x = W * 0.84;
  const y = 92;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = pal.sun;
  ctx.globalAlpha = 0.5;
  ctx.rotate(time * 0.15);
  for (let i = 0; i < 12; i++) {
    ctx.rotate(Math.PI / 6);
    ctx.beginPath();
    ctx.moveTo(-6, -38);
    ctx.lineTo(0, -56 - Math.sin(time * 2 + i) * 4);
    ctx.lineTo(6, -38);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.rotate(-time * 0.15 - Math.PI * 2);
  ctx.beginPath();
  ctx.arc(0, 0, 32, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 120, 20, 0.6)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.ellipse(-10, -6, 3, 4.5, 0, 0, Math.PI * 2);
  ctx.ellipse(10, -6, 3, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 4, 12, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 120, 120, 0.5)';
  ctx.beginPath();
  ctx.arc(-18, 6, 5, 0, Math.PI * 2);
  ctx.arc(18, 6, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const puffs: [number, number, number][] = [[-26, 4, 14], [-10, -6, 18], [10, -9, 20], [28, 2, 15], [0, 6, 16]];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = 'rgba(70, 90, 140, 0.25)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (const [px, py, r] of puffs) ctx.moveTo(px + r, py), ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#e4ecf8';
  ctx.beginPath();
  for (const [px, py, r] of puffs) ctx.moveTo(px + r, py + 3), ctx.arc(px, py + 3, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  for (const [px, py, r] of puffs) ctx.moveTo(px + r - 1, py - 1), ctx.arc(px, py - 1, r - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, time: number) {
  const flap = Math.sin(time * 12 + x) * 4;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 7, y - flap);
  ctx.quadraticCurveTo(x - 3, y - 3, x, y);
  ctx.quadraticCurveTo(x + 3, y - 3, x + 7, y - flap);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

export function drawWater(ctx: CanvasRenderingContext2D, time: number, bottom: number, pal: Palette, level = WATER_Y) {
  const wave = (x: number, t: number) => level + Math.sin(x / 40 + t * 2) * 3 + Math.sin(x / 17 - t * 3) * 1.5;
  // A darker wave behind for depth.
  ctx.fillStyle = pal.water[1];
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(-200, bottom);
  for (let x = -200; x <= W + 200; x += 10) ctx.lineTo(x, wave(x + 30, time * 0.8 + 1) - 5);
  ctx.lineTo(W + 200, bottom);
  ctx.fill();
  ctx.globalAlpha = 1;

  const g = ctx.createLinearGradient(0, level, 0, Math.max(level + 40, bottom));
  g.addColorStop(0, pal.water[0]);
  g.addColorStop(1, pal.water[1]);
  ctx.fillStyle = g;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.moveTo(-200, bottom);
  for (let x = -200; x <= W + 200; x += 10) ctx.lineTo(x, wave(x, time));
  ctx.lineTo(W + 200, bottom);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.foam;
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = -200; x <= W + 200; x += 10) {
    const y = wave(x, time);
    if (x === -200) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Glints
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 14; i++) {
    const gx = ((hash(i, 5) * W + time * 12 * (i % 2 ? 1 : -1)) % (W + 100)) - 50;
    const gy = level + 10 + hash(i, 6) * 22;
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + 8 + hash(i, 7) * 10, gy);
  }
  ctx.stroke();
}

// ---- worms ----

type Look = 'tophat' | 'crown' | 'cap' | 'mustache' | 'shades' | 'bowtie' | 'laurel' | 'bicorne' | 'hairBlond' | 'hairWhite' | 'hairBlack' | 'beret';
const NAMED_LOOKS: Record<string, Look> = {
  Lincoln: 'tophat', Churchill: 'bowtie', Washington: 'hairWhite', Napoleon: 'bicorne', Caesar: 'laurel', Nero: 'laurel', Caligula: 'laurel',
  Stalin: 'mustache', Saddam: 'mustache', Bismarck: 'mustache', Teddy: 'mustache', Gaddafi: 'shades', Pinochet: 'shades', 'Kim Jong-un': 'hairBlack',
  Castro: 'cap', Franco: 'cap', 'Idi Amin': 'cap', Mussolini: 'cap', Thatcher: 'hairBlond', Reagan: 'hairBlack', Merkel: 'hairBlond',
  'de Gaulle': 'cap', Robespierre: 'hairWhite', Mao: 'cap', Palme: 'hairBlack', JFK: 'hairBlack', FDR: 'tophat', Lukashenko: 'mustache',
  Macron: 'hairBlack', Mandela: 'hairWhite', Gandhi: 'shades', Nixon: 'hairBlack', Havel: 'mustache', Kekkonen: 'shades', Zelensky: 'hairBlack',
};
const LOOKS: Look[] = ['tophat', 'crown', 'cap', 'mustache', 'shades', 'bowtie', 'beret'];
const lookFor = (name: string) => NAMED_LOOKS[name] ?? LOOKS[Math.floor(hash(name.length, name.charCodeAt(0) * 31 + name.charCodeAt(name.length - 1)) * LOOKS.length)];

export type WormDraw = {
  id: number;
  name: string;
  color: string;
  facing: 1 | -1;
  time: number;
  active: boolean;
  walking: boolean;
  hp: number;
  /** Where the eyes look, as an angle in screen space (null = straight ahead). */
  look: number | null;
  /** >0 stretches tall (flying), <0 squashes (landing). */
  stretch: number;
  /** Seconds since the worm was last hurt (for the wince face). */
  hurtAgo: number;
};

export function drawWorm(ctx: CanvasRenderingContext2D, x: number, y: number, o: WormDraw) {
  const seed = hash(o.id, 3);
  const bob = o.active ? Math.sin(o.time * 6) * 0.8 : Math.sin(o.time * 2 + seed * 6) * 0.3;
  const wig = o.walking ? Math.sin(o.time * 22) : 0;
  const st = Math.max(-0.35, Math.min(0.35, o.stretch));
  ctx.save();
  ctx.translate(x, y + bob + WORM_R);
  // Drawn a little bigger than the hit circle, anchored at the feet.
  ctx.scale(1.15 * o.facing * (1 - st * 0.6), 1.15 * (1 + st));
  ctx.translate(0, -WORM_R);

  // Body: tail segments behind, a big head-body in front. Ink pass first so the
  // outline wraps the whole silhouette.
  const parts: [number, number, number, number][] = [
    [-11.5, 6.5 - wig, 3.2, 2.6],
    [-6.5, 5 + wig * 0.6, 5.5, 4],
    [0.5, 0, 8, 9.4],
  ];
  ctx.fillStyle = INK;
  for (const [px, py, rx, ry] of parts) {
    ctx.beginPath();
    ctx.ellipse(px, py, rx + 1.6, ry + 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = o.color;
  for (const [px, py, rx, ry] of parts) {
    ctx.beginPath();
    ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shading and belly
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.beginPath();
  ctx.ellipse(-1.5, 4, 6, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  ctx.ellipse(3, 3.5, 4, 4.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(-2.5, -5.5, 2, 1.4, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // Cheek
  ctx.fillStyle = 'rgba(255, 110, 140, 0.55)';
  ctx.beginPath();
  ctx.arc(6.2, 1.8, 1.8, 0, Math.PI * 2);
  ctx.fill();

  const look = lookFor(o.name);
  const wince = o.hurtAgo < 0.6;
  const worried = o.hp < 35;

  // Eyes
  const blink = ((o.time + seed * 9) % 3.7) < 0.12;
  let lx = 0.6;
  let ly = 0;
  if (o.look !== null) {
    lx = Math.cos(o.look) * o.facing;
    ly = Math.sin(o.look);
  }
  const eyes: [number, number][] = [[1.6, -4], [5.6, -4.4]];
  if (look === 'shades') {
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.ellipse(1.6, -4, 2.9, 2.3, 0, 0, Math.PI * 2);
    ctx.ellipse(5.8, -4.3, 2.7, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(1.6, -5.4, 4.2, 0.9);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(0.4, -5.3, 1.2, 0.8);
  } else {
    for (const [ex, ey] of eyes) {
      if (blink || wince) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        if (wince) {
          // >< squint
          ctx.moveTo(ex - 1.8, ey - 1.6);
          ctx.lineTo(ex + 0.6, ey);
          ctx.lineTo(ex - 1.8, ey + 1.6);
        } else {
          ctx.moveTo(ex - 2, ey);
          ctx.lineTo(ex + 2, ey);
        }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.ellipse(ex, ey, 2.6, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(ex + lx * 1.1, ey + ly * 1.4, 1.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex + lx * 1.1 - 0.5, ey + ly * 1.4 - 0.6, 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    if (worried) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -8.4);
      ctx.lineTo(2.8, -7.4);
      ctx.moveTo(7.4, -8.4);
      ctx.lineTo(4.6, -7.6);
      ctx.stroke();
    }
  }

  // Mouth
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  if (wince) {
    ctx.fillStyle = '#5a1020';
    ctx.ellipse(4.6, 2.4, 1.6, 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (worried) {
    ctx.arc(4.4, 4.2, 1.8, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();
  } else if (o.active) {
    ctx.fillStyle = '#5a1020';
    ctx.arc(4.4, 1.2, 2.3, 0.05 * Math.PI, 0.95 * Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.arc(4.4, 1.2, 2, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }

  drawLook(ctx, look);

  // Swedish politicians wear their party's pin.
  const party = partyOf(o.name);
  if (party) {
    ctx.fillStyle = party.color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(-1.5, 5.2, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(-2.3, 4.4, 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Wooden crate (or white first-aid box), on a parachute while it floats down. */
export function drawCrate(ctx: CanvasRenderingContext2D, x: number, y: number, kind: 'health' | 'weapon', time: number, para: boolean) {
  ctx.save();
  ctx.translate(x, y);
  if (para) {
    // Sway under the canopy.
    const sway = Math.sin(time * 2.2) * 0.12;
    ctx.rotate(sway);
    ctx.strokeStyle = 'rgba(43,29,51,0.7)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-7, -7);
    ctx.lineTo(-15, -26);
    ctx.moveTo(7, -7);
    ctx.lineTo(15, -26);
    ctx.moveTo(0, -8);
    ctx.lineTo(0, -30);
    ctx.stroke();
    const stripes = ['#ff6b6b', '#ffffff', '#ff6b6b', '#ffffff'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = stripes[i];
      ctx.beginPath();
      ctx.moveTo(0, -27);
      ctx.arc(0, -27, 18, Math.PI + (i * Math.PI) / 4, Math.PI + ((i + 1) * Math.PI) / 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, -27, 18, Math.PI, 0);
    ctx.quadraticCurveTo(9, -24, 0, -27);
    ctx.quadraticCurveTo(-9, -24, -18, -27);
    ctx.stroke();
  }
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = INK;
  if (kind === 'health') {
    ctx.fillStyle = '#f8f8fb';
    ctx.beginPath();
    ctx.roundRect(-8, -8, 16, 16, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8364f';
    ctx.fillRect(-2, -5.5, 4, 11);
    ctx.fillRect(-5.5, -2, 11, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(-7, 4, 14, 3);
  } else {
    ctx.fillStyle = '#c68a4a';
    ctx.beginPath();
    ctx.roundRect(-8, -8, 16, 16, 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#7a4e24';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, -2.5);
    ctx.lineTo(8, -2.5);
    ctx.moveTo(-8, 2.5);
    ctx.lineTo(8, 2.5);
    ctx.moveTo(-6, -6);
    ctx.lineTo(6, 6);
    ctx.stroke();
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.font = '900 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText('?', 0, 0.5);
    ctx.fillText('?', 0, 0.5);
  }
  ctx.restore();
}

/** Comic speech bubble in screen space, its tail pointing down at (x, y). */
export function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, alpha: number, pop: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(pop, pop);
  ctx.font = '800 12px "Comic Sans MS", "Chalkboard SE", "Comic Neue", system-ui, sans-serif';
  const w = Math.min(200, ctx.measureText(text).width) + 16;
  const h = 22;
  const bx = -w / 2;
  const by = -h - 9;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, 10);
  ctx.moveTo(-5, by + h);
  ctx.lineTo(0, 0);
  ctx.lineTo(5, by + h);
  ctx.fill();
  ctx.stroke();
  // Cover the seam where the tail meets the bubble.
  ctx.fillRect(-4, by + h - 2, 8, 3);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, by + h / 2 + 0.5, 200);
  ctx.restore();
}

function drawLook(ctx: CanvasRenderingContext2D, look: Look) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = INK;
  const shape = (fill: string, path: () => void) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    path();
    ctx.fill();
    ctx.stroke();
  };
  switch (look) {
    case 'tophat':
      shape('#1d1d26', () => ctx.ellipse(1, -8.6, 7, 1.6, 0, 0, Math.PI * 2));
      shape('#1d1d26', () => ctx.rect(-3.2, -19, 8.4, 10));
      ctx.fillStyle = '#c0283c';
      ctx.fillRect(-3.2, -11.6, 8.4, 2);
      break;
    case 'crown':
      shape('#ffd23f', () => {
        ctx.moveTo(-4.5, -8);
        ctx.lineTo(-5, -15);
        ctx.lineTo(-2, -11.5);
        ctx.lineTo(1, -16.5);
        ctx.lineTo(3.8, -11.5);
        ctx.lineTo(6.6, -15);
        ctx.lineTo(6.2, -8);
        ctx.closePath();
      });
      ctx.fillStyle = '#e8364f';
      ctx.beginPath();
      ctx.arc(1, -10, 1.1, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'cap':
      shape('#3f5a34', () => ctx.ellipse(0.5, -9, 8.2, 4.2, 0, Math.PI, 0));
      shape('#1d1d26', () => ctx.ellipse(6, -8.8, 4.5, 1.3, 0, 0, Math.PI * 2));
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.arc(2.5, -11, 1.1, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'beret':
      shape('#22223a', () => ctx.ellipse(-0.5, -9.4, 8.4, 3, -0.15, 0, Math.PI * 2));
      ctx.fillStyle = '#22223a';
      ctx.fillRect(-1, -13.4, 1.6, 2);
      break;
    case 'bicorne':
      shape('#1d1d26', () => {
        ctx.moveTo(-10, -8);
        ctx.quadraticCurveTo(1, -21, 12, -8);
        ctx.quadraticCurveTo(1, -11, -10, -8);
      });
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(0, -13, 2, 2);
      break;
    case 'laurel':
      ctx.fillStyle = '#5fbf4a';
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (1.05 + i * 0.13);
        ctx.beginPath();
        ctx.ellipse(0.5 + Math.cos(a) * 8, -1 + Math.sin(a) * 8.6, 2.2, 1.1, a + Math.PI / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      break;
    case 'mustache':
      shape('#3a2418', () => {
        ctx.moveTo(4.6, -0.4);
        ctx.quadraticCurveTo(1, -1.6, 1, 1.4);
        ctx.quadraticCurveTo(3, 0.2, 4.6, 0.8);
        ctx.quadraticCurveTo(6.2, 0.2, 8.2, 1.4);
        ctx.quadraticCurveTo(8.2, -1.6, 4.6, -0.4);
      });
      break;
    case 'bowtie':
      shape('#e8364f', () => {
        ctx.moveTo(3, 7.4);
        ctx.lineTo(-0.5, 5.2);
        ctx.lineTo(-0.5, 9.6);
        ctx.closePath();
        ctx.moveTo(3, 7.4);
        ctx.lineTo(6.5, 5.2);
        ctx.lineTo(6.5, 9.6);
        ctx.closePath();
      });
      break;
    case 'hairBlond':
    case 'hairWhite':
    case 'hairBlack': {
      const c = look === 'hairBlond' ? '#ffd76a' : look === 'hairWhite' ? '#f2f2f2' : '#2a2030';
      shape(c, () => {
        ctx.moveTo(-7, -4);
        ctx.quadraticCurveTo(-8, -12, 1, -11.5);
        ctx.quadraticCurveTo(9, -12, 10.5, -6.5);
        ctx.quadraticCurveTo(5, -9, -1, -7.4);
        ctx.quadraticCurveTo(-4, -7, -7, -4);
      });
      break;
    }
    case 'shades':
      break;
  }
}

export function drawGrave(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y + 2);
  ctx.fillStyle = '#b4b4c8';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(-7, 7);
  ctx.lineTo(-7, -4);
  ctx.arc(0, -4, 7, Math.PI, 0);
  ctx.lineTo(7, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(-5, -4, 2, 9);
  ctx.fillStyle = INK;
  ctx.font = 'bold 5px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RIP', 0, 0);
  ctx.fillStyle = '#5fbf4a';
  ctx.fillRect(-9, 6, 18, 2);
  ctx.restore();
}

export function drawProjectile(ctx: CanvasRenderingContext2D, kind: ProjKind, x: number, y: number, angle: number, time: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  switch (kind) {
    case 'rocket':
    case 'missile': {
      ctx.rotate(angle);
      const body = kind === 'rocket' ? '#f4f4f8' : '#9aa4b8';
      // flame
      ctx.fillStyle = '#ffb547';
      ctx.beginPath();
      ctx.moveTo(-7, -2.5);
      ctx.lineTo(-13 - Math.random() * 6, 0);
      ctx.lineTo(-7, 2.5);
      ctx.fill();
      ctx.fillStyle = '#fff3a0';
      ctx.beginPath();
      ctx.moveTo(-7, -1.2);
      ctx.lineTo(-10 - Math.random() * 3, 0);
      ctx.lineTo(-7, 1.2);
      ctx.fill();
      // fins
      ctx.fillStyle = '#e04848';
      ctx.beginPath();
      ctx.moveTo(-7, -2.5);
      ctx.lineTo(-9, -6);
      ctx.lineTo(-3, -2.5);
      ctx.moveTo(-7, 2.5);
      ctx.lineTo(-9, 6);
      ctx.lineTo(-3, 2.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(-7, -3);
      ctx.lineTo(4, -3);
      ctx.quadraticCurveTo(10, 0, 4, 3);
      ctx.lineTo(-7, 3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e04848';
      ctx.fillRect(1, -3, 2, 6);
      break;
    }
    case 'grenade':
      ctx.rotate(time * 8);
      ctx.fillStyle = '#4f8f34';
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.arc(-1.6, -1.6, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c8c8d0';
      ctx.fillRect(-1.5, -7.5, 3, 3);
      ctx.strokeRect(-1.5, -7.5, 3, 3);
      ctx.beginPath();
      ctx.arc(3, -7, 2, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'cluster':
      ctx.fillStyle = '#d84a4a';
      ctx.beginPath();
      ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffd0d0';
      ctx.beginPath();
      ctx.arc(-1.8, -1.8, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'bomblet':
      ctx.fillStyle = '#ff8a3d';
      ctx.beginPath();
      ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 'haybomb': {
      ctx.fillStyle = `rgba(255, 240, 160, ${0.35 + Math.sin(time * 10) * 0.2})`;
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(time * 5);
      ctx.fillStyle = '#ecc44e';
      ctx.beginPath();
      ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#9a7a1a';
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(-6, i * 3);
        ctx.lineTo(6, i * 3);
      }
      ctx.stroke();
      ctx.rotate(-time * 5);
      // halo
      ctx.strokeStyle = '#fff07a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, -11, 6, 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

export function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, time: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir * 1.3, 1.3);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  // tail
  ctx.fillStyle = '#c03a3a';
  ctx.beginPath();
  ctx.moveTo(-22, -1);
  ctx.lineTo(-28, -12);
  ctx.lineTo(-20, -12);
  ctx.lineTo(-12, -2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // body
  ctx.fillStyle = '#e85454';
  ctx.beginPath();
  ctx.ellipse(-2, 0, 24, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // window
  ctx.fillStyle = '#9fe0ff';
  ctx.beginPath();
  ctx.ellipse(6, -4, 6, 4, 0, Math.PI, 0);
  ctx.fill();
  ctx.stroke();
  // wing
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.ellipse(-2, 2, 14, 3.2, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // propeller
  ctx.fillStyle = INK;
  ctx.fillRect(21, -1.5, 3, 3);
  ctx.fillStyle = 'rgba(40,40,60,0.45)';
  ctx.beginPath();
  ctx.ellipse(24, 0, 2, 9 * Math.abs(Math.sin(time * 40)) + 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---- particles ----

type Kind = 'spark' | 'debris' | 'puff' | 'flash' | 'burst' | 'ring' | 'drop' | 'line' | 'star' | 'confetti' | 'bubble' | 'ray' | 'ripple';
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: Kind;
  x2?: number;
  y2?: number;
  gravity?: number;
  rot?: number;
  spin?: number;
  delay?: number;
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Particles {
  list: Particle[] = [];
  debris = ['#9c663a', '#7ad64c'];
  water = WATER_Y;

  private add(p: Omit<Particle, 'life'> & { life?: number }) {
    this.list.push({ life: 0, ...p });
  }

  explosion(x: number, y: number, r: number) {
    this.add({ x, y, vx: 0, vy: 0, max: 0.14, size: r * 1.6, color: '#fff', kind: 'flash' });
    this.add({ x, y, vx: 0, vy: 0, max: 0.32, size: r * 1.25, color: '#ffe14d', kind: 'burst', rot: Math.random() * Math.PI });
    this.add({ x, y, vx: 0, vy: 0, max: 0.4, size: r * 2.2, color: '#fff', kind: 'ring' });
    // Billowing cartoon smoke puffs
    const puffs = Math.round(5 + r / 6);
    for (let i = 0; i < puffs; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r * 0.6;
      const tone = Math.round(rnd(200, 245));
      this.add({
        x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * rnd(20, 60), vy: Math.sin(a) * rnd(20, 50) - rnd(20, 45),
        max: rnd(0.8, 1.5), size: rnd(r * 0.3, r * 0.55), color: `${tone},${tone},${tone + 6}`, kind: 'puff', delay: rnd(0, 0.12),
      });
    }
    const n = Math.round(10 + r * 0.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(80, 80 + r * 9);
      this.add({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, max: rnd(0.3, 0.7),
        size: rnd(1.5, 3.5), color: Math.random() > 0.5 ? '#ffd166' : '#ff7b39', kind: 'spark', gravity: 200,
      });
    }
    for (let i = 0; i < n * 0.7; i++) {
      const a = -Math.PI * Math.random();
      const s = rnd(60, 60 + r * 7);
      this.add({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: rnd(0.7, 1.5),
        size: rnd(2, 5), color: this.debris[Math.floor(Math.random() * this.debris.length)], kind: 'debris', gravity: 650,
        rot: Math.random() * 6, spin: rnd(-12, 12),
      });
    }
  }

  holy(x: number, y: number) {
    for (let i = 0; i < 14; i++) {
      this.add({ x, y, vx: 0, vy: 0, max: 1.4, size: 260, color: '#fff3a0', kind: 'ray', rot: (i / 14) * Math.PI * 2, spin: 0.4 });
    }
    this.confetti(x, y, ['#ffe14d', '#fff', '#ffd0a0'], 30);
  }

  splash(x: number, y: number, big = false) {
    const n = big ? 30 : 18;
    for (let i = 0; i < n; i++) {
      this.add({
        x: x + rnd(-6, 6), y, vx: rnd(-80, 80) * (big ? 1.6 : 1), vy: -rnd(140, big ? 420 : 340),
        max: 1, size: rnd(2.5, 5), color: '#bfe6ff', kind: 'drop', gravity: 800,
      });
    }
    this.add({ x, y: y + 2, vx: 0, vy: 0, max: 0.9, size: big ? 50 : 32, color: '#ffffff', kind: 'ripple' });
    this.add({ x, y: y + 2, vx: 0, vy: 0, max: 1.2, size: big ? 80 : 50, color: '#ffffff', kind: 'ripple', delay: 0.15 });
  }

  bubbles(x: number, y: number) {
    for (let i = 0; i < 10; i++) {
      this.add({ x: x + rnd(-6, 6), y: y + rnd(4, 20), vx: rnd(-8, 8), vy: -rnd(15, 35), max: rnd(0.8, 1.6), size: rnd(1.5, 3.5), color: '#e8f8ff', kind: 'bubble', delay: i * 0.08 });
    }
  }

  dust(x: number, y: number, n = 6, strength = 1) {
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1;
      this.add({
        x: x + dir * rnd(0, 6), y: y + rnd(-2, 2), vx: dir * rnd(20, 70) * strength, vy: -rnd(5, 30) * strength,
        max: rnd(0.4, 0.7), size: rnd(3, 6) * Math.min(1.6, strength), color: '232,220,200', kind: 'puff',
      });
    }
  }

  muzzle(x: number, y: number, angle: number) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    this.add({ x, y, vx: 0, vy: 0, max: 0.1, size: 12, color: '#fff', kind: 'flash' });
    for (let i = 0; i < 4; i++) {
      this.add({ x, y, vx: dx * rnd(40, 90) + rnd(-15, 15), vy: dy * rnd(40, 90) + rnd(-15, 15), max: rnd(0.4, 0.6), size: rnd(3, 5), color: '240,240,240', kind: 'puff' });
    }
  }

  trail(x: number, y: number) {
    this.add({ x, y, vx: rnd(-5, 5), vy: -10, max: 0.6, size: rnd(2.5, 4.5), color: '245,245,250', kind: 'puff' });
  }

  tracer(x: number, y: number, x2: number, y2: number) {
    this.add({ x, y, x2, y2, vx: 0, vy: 0, max: 0.2, size: 2.5, color: '#fff6c0', kind: 'line' });
  }

  sparkle(x: number, y: number) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(30, 110);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: rnd(0.6, 1), size: rnd(3, 5), color: Math.random() > 0.5 ? '#c9f3ff' : '#fff59a', kind: 'star', spin: rnd(-6, 6), rot: 0 });
    }
  }

  stars(x: number, y: number, n = 5) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + rnd(-1, 1);
      const s = rnd(50, 120);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: 0.7, size: rnd(4, 6), color: '#ffe14d', kind: 'star', gravity: 200, spin: rnd(-8, 8), rot: 0 });
    }
  }

  confetti(x: number, y: number, colors: string[], n = 24) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + rnd(-1.2, 1.2);
      const s = rnd(120, 300);
      this.add({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: rnd(1.2, 2), size: rnd(3, 5),
        color: colors[i % colors.length], kind: 'confetti', gravity: 380, rot: Math.random() * 6, spin: rnd(-14, 14),
      });
    }
  }

  update(dt: number) {
    for (const p of this.list) {
      if (p.delay && p.delay > 0) {
        p.delay -= dt;
        continue;
      }
      p.life += dt;
      p.vy += (p.gravity ?? 0) * dt;
      if (p.kind === 'puff') {
        p.vx *= Math.pow(0.15, dt);
        p.vy *= Math.pow(0.15, dt);
      }
      if (p.kind === 'confetti') p.vx *= Math.pow(0.4, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.spin) p.rot = (p.rot ?? 0) + p.spin * dt;
      if (p.kind === 'drop' && p.y > this.water + 4 && p.vy > 0) p.life = p.max;
      if (p.kind === 'bubble' && p.y < this.water) p.life = p.max;
    }
    this.list = this.list.filter((p) => p.life < p.max && p.y < H + 100);
  }

  draw(ctx: CanvasRenderingContext2D) {
    for (const p of this.list) {
      if (p.delay && p.delay > 0) continue;
      const t = p.life / p.max;
      const k = 1 - t;
      switch (p.kind) {
        case 'flash':
          ctx.fillStyle = `rgba(255, 252, 230, ${k * 0.95})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.7 + t * 0.5), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'burst': {
          // Comic-book explosion star
          const s = p.size * (0.5 + Math.min(1, t * 3) * 0.6);
          const spikes = 11;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot ?? 0);
          ctx.globalAlpha = Math.min(1, k * 2);
          for (const [scale, fill] of [[1, '#ff7b1f'], [0.68, '#ffe14d'], [0.36, '#fffbe6']] as const) {
            ctx.fillStyle = fill;
            ctx.beginPath();
            for (let i = 0; i < spikes * 2; i++) {
              const a = (i / (spikes * 2)) * Math.PI * 2;
              const rr = s * scale * (i % 2 ? 0.55 : 1) * (1 + hash(i, 1) * 0.25);
              ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
            }
            ctx.closePath();
            ctx.fill();
            if (scale === 1) {
              ctx.strokeStyle = INK;
              ctx.lineWidth = 2;
              ctx.stroke();
            }
          }
          ctx.restore();
          ctx.globalAlpha = 1;
          break;
        }
        case 'ring':
          ctx.strokeStyle = `rgba(255,255,255,${k * 0.7})`;
          ctx.lineWidth = 4 * k + 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.3 + t * 0.7), 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'ripple':
          ctx.strokeStyle = `rgba(255,255,255,${k * 0.8})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, p.size * (0.2 + t * 0.8), p.size * (0.05 + t * 0.12), 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'puff': {
          const s = p.size * (t < 0.2 ? 0.5 + t * 2.5 : 1 - (t - 0.2) * 0.5);
          ctx.globalAlpha = Math.min(1, k * 1.6);
          ctx.fillStyle = 'rgba(60,50,70,0.35)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, s + 1.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgb(${p.color})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath();
          ctx.arc(p.x - s * 0.3, p.y - s * 0.3, s * 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case 'ray': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot ?? 0);
          ctx.fillStyle = `rgba(255, 243, 160, ${Math.sin(t * Math.PI) * 0.35})`;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(p.size, -16);
          ctx.lineTo(p.size, 16);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'line':
          ctx.strokeStyle = `rgba(255, 246, 192, ${k})`;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x2!, p.y2!);
          ctx.stroke();
          break;
        case 'star': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot ?? 0);
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
            const rr = i % 2 ? p.size * 0.42 : p.size;
            ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          ctx.globalAlpha = 1;
          break;
        }
        case 'bubble':
          ctx.strokeStyle = `rgba(232,248,255,${k})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'debris':
        case 'confetti': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot ?? 0);
          ctx.globalAlpha = Math.min(1, k * 2);
          ctx.fillStyle = p.color;
          const w = p.size;
          const h = p.kind === 'confetti' ? p.size * 0.5 * Math.abs(Math.cos((p.rot ?? 0) * 2)) + 0.6 : p.size;
          ctx.fillRect(-w / 2, -h / 2, w, h);
          if (p.kind === 'debris') {
            ctx.strokeStyle = INK;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(-w / 2, -h / 2, w, h);
          }
          ctx.restore();
          ctx.globalAlpha = 1;
          break;
        }
        default:
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
      }
    }
  }
}
