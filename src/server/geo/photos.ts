// Photos for "Hay, Where?", from Wikimedia Commons, plus the map tiles.
//
// Players never see the photo's real URL or filename (both usually name the
// place). The server downloads each photo and serves it under a random token.
// Map tiles go through the server too, because Discord's iframe blocks
// requests to outside sites.

import { randomBytes } from 'node:crypto';
import express from 'express';
import type { GeoAnswer } from '../../shared/geo.ts';

const UA = 'HayaloGameNight/0.1 (https://github.com/Lundmarks/hayalo-game-night)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

// "Quality images" with a camera location, minus the kinds of photo that are
// close to impossible to place (bugs, food, museum pieces, people…).
const SEARCH = [
  'incategory:Quality_images',
  'hastemplate:Location',
  'filetype:bitmap',
  ...['insect', 'insects', 'butterfly', 'spider', 'macro', 'museum', 'interior', 'flower', 'flowers', 'bird', 'birds',
    'specimen', 'herbarium', 'food', 'dish', 'portrait', 'coin', 'coat of arms', 'CoA', 'motor show', 'concert',
    'cosplay', 'mushroom', 'fungus', 'detail'].map((w) => (w.includes(' ') ? `-"${w}"` : `-${w}`)),
].join(' ');

export type RoundPhoto = { token: string; w: number; h: number; answer: GeoAnswer; id: number };

type Candidate = { id: number; thumb: string; w: number; h: number; answer: GeoAnswer };

const pool: Candidate[] = [];
let filling: Promise<void> | null = null;

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

async function fetchBatch() {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: '40',
    gsrsort: 'random',
    gsrsearch: SEARCH,
    prop: 'coordinates|imageinfo',
    coprop: 'type',
    coprimary: 'all',
    iiprop: 'url|extmetadata|size',
    iiurlwidth: '1600',
    iiextmetadatafilter: 'Artist|LicenseShortName|ObjectName',
  });
  const r = await fetch(`${COMMONS_API}?${params}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Commons search failed (${r.status})`);
  const data = (await r.json()) as { query?: { pages?: any[] } };
  for (const p of data.query?.pages ?? []) {
    const coord = (p.coordinates ?? []).find((c: any) => c.type === 'camera') ?? p.coordinates?.[0];
    const info = p.imageinfo?.[0];
    if (!coord || !info?.thumburl || !info.thumbwidth || !info.thumbheight) continue;
    // Wide photos are mostly scenes; tall ones are mostly towers, people and objects.
    if (info.thumbwidth < info.thumbheight * 1.2) continue;
    const meta = info.extmetadata ?? {};
    const title = stripHtml(meta.ObjectName?.value ?? String(p.title).replace(/^File:/, '').replace(/\.[a-z]+$/i, ''));
    pool.push({
      id: p.pageid,
      thumb: info.thumburl,
      w: info.thumbwidth,
      h: info.thumbheight,
      answer: {
        lat: coord.lat,
        lon: coord.lon,
        title,
        author: stripHtml(meta.Artist?.value ?? 'Unknown').slice(0, 120),
        license: stripHtml(meta.LicenseShortName?.value ?? ''),
        pageUrl: info.descriptionurl,
      },
    });
  }
}

function refill() {
  filling ??= fetchBatch().finally(() => (filling = null));
  return filling;
}

// ---- photo bytes, served by token ----

type Served = { bytes: Buffer; type: string; expires: number };
const served = new Map<string, Served>();
const SERVE_MS = 2 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of served) if (v.expires < now) served.delete(k);
}

async function download(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Photo download failed (${r.status})`);
  return { bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'image/jpeg' };
}

/**
 * A fresh random photo, already downloaded so every player can load it at once.
 * `avoid` holds Commons page ids used earlier in the game.
 */
export async function nextPhoto(avoid: Set<number> = new Set()): Promise<RoundPhoto> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (pool.length < 4) await refill();
      else if (pool.length < 12) refill().catch(() => {});
      const c = pool.shift();
      if (!c || avoid.has(c.id)) continue;
      const img = await download(c.thumb);
      sweep();
      const token = randomBytes(12).toString('hex');
      served.set(token, { ...img, expires: Date.now() + SERVE_MS });
      return { token, w: c.w, h: c.h, answer: c.answer, id: c.id };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Couldn't get a photo from Wikimedia Commons${lastError ? `: ${(lastError as Error).message}` : ''}`);
}

// ---- map tiles (OpenStreetMap), cached in memory ----

const TILE_LIMIT = 3000;
const tiles = new Map<string, Promise<{ bytes: Buffer; type: string }>>();

function tile(z: number, x: number, y: number) {
  const key = `${z}/${x}/${y}`;
  let t = tiles.get(key);
  if (t) {
    // Move to the back so the oldest unused tiles go first.
    tiles.delete(key);
    tiles.set(key, t);
    return t;
  }
  t = download(`https://tile.openstreetmap.org/${key}.png`);
  t.catch(() => tiles.delete(key));
  tiles.set(key, t);
  if (tiles.size > TILE_LIMIT) tiles.delete(tiles.keys().next().value!);
  return t;
}

export const geoRouter = express.Router();

geoRouter.get('/img/:token', (req, res) => {
  const s = served.get(req.params.token);
  if (!s) return res.status(404).end();
  res.set({ 'Content-Type': s.type, 'Cache-Control': 'private, max-age=7200' }).send(s.bytes);
});

geoRouter.get('/tile/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 18 || x < 0 || y < 0 || x >= n || y >= n) return res.status(400).end();
  try {
    const t = await tile(z, x, y);
    res.set({ 'Content-Type': t.type, 'Cache-Control': 'public, max-age=86400' }).send(t.bytes);
  } catch {
    res.status(502).end();
  }
});
