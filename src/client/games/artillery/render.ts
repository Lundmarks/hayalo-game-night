import { WORM_R } from '../../../shared/artillery/sim.ts';
import { H, Terrain, W, WATER_Y } from '../../../shared/artillery/terrain.ts';
import type { ProjKind } from '../../../shared/artillery/types.ts';

const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Paint the terrain mask into a textured canvas: grass on top, layered dirt below. */
export function buildTerrainCanvas(t: Terrain) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  for (let x = 0; x < W; x++) {
    let depth = 0;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (!t.mask[i]) {
        depth = 0;
        continue;
      }
      depth++;
      const n = hash(x, y);
      let r: number, g: number, b: number;
      if (depth <= 4) {
        [r, g, b] = n > 0.5 ? [112, 196, 64] : [96, 178, 52];
      } else if (depth <= 8) {
        [r, g, b] = [70, 138, 40];
      } else {
        const band = (Math.floor((y + hash(x >> 4, 0) * 10) / 22) % 2) * 10;
        const dark = Math.min(45, depth * 0.18);
        r = 150 - dark - band + n * 22;
        g = 104 - dark - band + n * 16;
        b = 58 - dark * 0.6 - band + n * 10;
        if (n > 0.985) [r, g, b] = [196, 170, 110]; // pebbles
      }
      const o = i * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function carveCanvas(c: HTMLCanvasElement, x: number, y: number, r: number) {
  const ctx = c.getContext('2d')!;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // Scorch the edge of what's left.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.strokeStyle = 'rgba(35, 18, 8, 0.6)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Distant hills and clouds, drawn once. */
export function buildBackdrop() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const hills = (base: number, amp: number, color: string, seed: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const y = base + Math.sin(x / 140 + seed) * amp + Math.sin(x / 53 + seed * 2) * amp * 0.35;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.fill();
  };
  hills(330, 40, 'rgba(120, 100, 190, 0.35)', 1);
  hills(390, 30, 'rgba(90, 70, 160, 0.45)', 4);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 7; i++) {
    const x = hash(i, 1) * W;
    const y = 40 + hash(i, 2) * 160;
    for (let k = 0; k < 5; k++) {
      ctx.beginPath();
      ctx.ellipse(x + k * 22, y + Math.sin(k) * 6, 30, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

export function drawSky(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#1d1640');
  g.addColorStop(0.55, '#4a3a8a');
  g.addColorStop(1, '#e58a6a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export function drawWater(ctx: CanvasRenderingContext2D, time: number, bottom: number) {
  const g = ctx.createLinearGradient(0, WATER_Y, 0, bottom);
  g.addColorStop(0, 'rgba(60, 140, 220, 0.85)');
  g.addColorStop(1, 'rgba(20, 50, 120, 0.95)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-200, bottom);
  for (let x = -200; x <= W + 200; x += 10) ctx.lineTo(x, WATER_Y + Math.sin(x / 40 + time * 2) * 3 + Math.sin(x / 17 - time * 3) * 1.5);
  ctx.lineTo(W + 200, bottom);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 235, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = -200; x <= W + 200; x += 10) {
    const y = WATER_Y + Math.sin(x / 40 + time * 2) * 3 + Math.sin(x / 17 - time * 3) * 1.5;
    if (x === -200) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function drawWorm(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, facing: 1 | -1, time: number, active: boolean) {
  const bob = active ? Math.sin(time * 6) * 0.8 : 0;
  ctx.save();
  ctx.translate(x, y + bob);
  // body
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 1, WORM_R, WORM_R + 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // belly shine
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.ellipse(-facing * 2, -2, 3, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // eyes
  for (const ex of [1.5, 5]) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(facing * ex, -3, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(facing * (ex + 0.9), -3, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawGrave(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y + 2);
  ctx.fillStyle = '#9a9aae';
  ctx.strokeStyle = '#4a4a5a';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-6, 7);
  ctx.lineTo(-6, -4);
  ctx.arc(0, -4, 6, Math.PI, 0);
  ctx.lineTo(6, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#5a5a6a';
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(0, 3);
  ctx.moveTo(-3, -3);
  ctx.lineTo(3, -3);
  ctx.stroke();
  ctx.restore();
}

export function drawProjectile(ctx: CanvasRenderingContext2D, kind: ProjKind, x: number, y: number, angle: number, time: number) {
  ctx.save();
  ctx.translate(x, y);
  switch (kind) {
    case 'rocket':
    case 'missile':
      ctx.rotate(angle);
      ctx.fillStyle = '#d8d8e0';
      ctx.fillRect(-7, -2.5, 11, 5);
      ctx.fillStyle = '#e04848';
      ctx.beginPath();
      ctx.moveTo(4, -2.5);
      ctx.lineTo(8, 0);
      ctx.lineTo(4, 2.5);
      ctx.fill();
      ctx.fillStyle = '#ffb547';
      ctx.beginPath();
      ctx.moveTo(-7, -2);
      ctx.lineTo(-11 - Math.random() * 4, 0);
      ctx.lineTo(-7, 2);
      ctx.fill();
      break;
    case 'grenade':
      ctx.rotate(time * 8);
      ctx.fillStyle = '#3d6b2a';
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ccc';
      ctx.fillRect(-1, -6.5, 2, 3);
      break;
    case 'cluster':
      ctx.fillStyle = '#c03a3a';
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd0d0';
      ctx.beginPath();
      ctx.arc(-1.5, -1.5, 1.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'bomblet':
      ctx.fillStyle = '#ff8a3d';
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'haybomb': {
      ctx.rotate(time * 5);
      ctx.fillStyle = '#e8c04a';
      ctx.strokeStyle = '#9a7a1a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(-6, i * 3);
        ctx.lineTo(6, i * 3);
      }
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 240, 160, ${0.3 + Math.sin(time * 10) * 0.2})`;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

// ---- particles ----

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: 'spark' | 'debris' | 'smoke' | 'flash' | 'drop' | 'line' | 'star';
  x2?: number;
  y2?: number;
  gravity?: number;
};

export class Particles {
  list: Particle[] = [];

  explosion(x: number, y: number, r: number) {
    this.list.push({ x, y, vx: 0, vy: 0, life: 0, max: 0.18, size: r * 1.5, color: '#fff3c0', kind: 'flash' });
    const n = Math.round(10 + r * 0.7);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * r * 9;
      this.list.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 0, max: 0.3 + Math.random() * 0.4,
        size: 1.5 + Math.random() * 2.5, color: Math.random() > 0.5 ? '#ffd166' : '#ff7b39', kind: 'spark', gravity: 200,
      });
    }
    for (let i = 0; i < n * 0.8; i++) {
      const a = -Math.PI * Math.random();
      const s = 60 + Math.random() * r * 7;
      this.list.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.6 + Math.random() * 0.8,
        size: 1.5 + Math.random() * 2.5, color: Math.random() > 0.4 ? '#7a5230' : '#4f8f2f', kind: 'debris', gravity: 600,
      });
    }
    for (let i = 0; i < 6 + r / 6; i++) {
      this.list.push({
        x: x + (Math.random() - 0.5) * r, y: y + (Math.random() - 0.5) * r, vx: (Math.random() - 0.5) * 30, vy: -20 - Math.random() * 30,
        life: 0, max: 1 + Math.random(), size: r * 0.4 + Math.random() * r * 0.4, color: '60,50,70', kind: 'smoke',
      });
    }
  }

  splash(x: number, y: number) {
    for (let i = 0; i < 18; i++) {
      this.list.push({
        x: x + (Math.random() - 0.5) * 10, y, vx: (Math.random() - 0.5) * 140, vy: -120 - Math.random() * 220,
        life: 0, max: 0.8, size: 2 + Math.random() * 2, color: '#9fd8ff', kind: 'drop', gravity: 700,
      });
    }
  }

  trail(x: number, y: number) {
    this.list.push({ x, y, vx: (Math.random() - 0.5) * 10, vy: -10, life: 0, max: 0.7, size: 3 + Math.random() * 3, color: '200,200,210', kind: 'smoke' });
  }

  tracer(x: number, y: number, x2: number, y2: number) {
    this.list.push({ x, y, x2, y2, vx: 0, vy: 0, life: 0, max: 0.2, size: 2, color: '#fff6c0', kind: 'line' });
  }

  sparkle(x: number, y: number) {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 30 + Math.random() * 80;
      this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.6 + Math.random() * 0.4, size: 2, color: '#c9f3ff', kind: 'star' });
    }
  }

  update(dt: number) {
    for (const p of this.list) {
      p.life += dt;
      p.vy += (p.gravity ?? 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'smoke') p.size += dt * 8;
    }
    this.list = this.list.filter((p) => p.life < p.max && p.y < H + 100);
  }

  draw(ctx: CanvasRenderingContext2D) {
    for (const p of this.list) {
      const k = 1 - p.life / p.max;
      switch (p.kind) {
        case 'flash':
          ctx.fillStyle = `rgba(255, 240, 190, ${k * 0.9})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1.2 - k * 0.4), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'smoke':
          ctx.fillStyle = `rgba(${p.color}, ${k * 0.35})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'line':
          ctx.strokeStyle = `rgba(255, 246, 192, ${k})`;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x2!, p.y2!);
          ctx.stroke();
          break;
        default:
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          ctx.globalAlpha = 1;
      }
    }
  }
}
