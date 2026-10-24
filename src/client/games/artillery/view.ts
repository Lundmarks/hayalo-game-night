import { clearSpot, FLOOD_FRAMES, SAMPLE, FPS, WORM_R } from '../../../shared/artillery/sim.ts';
import { H, mapInfo, SHAPE_NAMES, Terrain, THEME_NAMES, W, WATER_Y, type ThemeId } from '../../../shared/artillery/terrain.ts';
import { partyOf, QUIPS, SWEDISH } from '../../../shared/artillery/politicians.ts';
import { CRATE_HEALTH, RETREAT_SECONDS, WEAPONS, WEAPON_BY_ID, type ArtEvent, type ArtState, type Crate, type Crater, type ProjKind, type SimEvent, type Timeline, type Track, type WeaponId } from '../../../shared/artillery/types.ts';
import type { Player, RoomView } from '../../../shared/protocol.ts';
import { audio, type Sound } from '../../audio.ts';
import { esc, toast, type ViewFactory } from '../../ui.ts';
import { buildBackdrop, buildTerrainCanvas, carveCanvas, drawBird, drawBubble, drawCloud, drawCrate, drawGrave, drawPlane, drawProjectile, drawSky, drawSun, drawWater, drawWorm, PALETTES, Particles } from './render.ts';

type Playback = {
  tl: Timeline;
  t0: number;
  ev: number;
  hp: Map<number, number>;
  alive: Map<number, boolean>;
  wormTracks: Map<number, Track[]>;
  crateTracks: Map<number, Track[]>;
  gone: Set<number>; // crates picked up, destroyed or sunk so far
  flood: { from: number; to: number; f0: number } | null;
  lastF: number; // last frame played, so a replacement timeline can pick up from there
  fx: Set<string>; // one-off effects already played (fuse ticks, whistles…)
};

const tracksBy = (tl: Timeline, kind: 'worm' | 'crate') => {
  const m = new Map<number, Track[]>();
  for (const tr of tl.tracks) {
    if (tr.kind !== kind) continue;
    const id = kind === 'worm' ? tr.wormId! : tr.crateId!;
    const list = m.get(id) ?? [];
    list.push(tr);
    m.set(id, list);
  }
  return m;
};
/** The newest track that has started by frame f. */
const latest = (trs: Track[] | undefined, f: number) => {
  let best: Track | null = null;
  for (const tr of trs ?? []) if (tr.start <= f) best = tr;
  return best;
};

const KEYS: [string[], string][] = [
  [['←', '→'], 'Walk (A/D)'],
  [['J'], 'Jump'],
  [['↑', '↓'], 'Aim (W/S)'],
  [['Q', 'E'], 'Power'],
  [['Space'], 'Fire'],
  [['1', '–', '7'], 'Weapon'],
  [['Drag'], 'Aim by mouse'],
  [['H'], 'Hide this'],
];

type Floater = { x: number; y: number; text: string; color: string; life: number; size: number; comic?: boolean; rot?: number; max?: number };

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const BOOM_WORDS = { small: ['POW!', 'BAM!', 'ZAP!', 'PAF!'], mid: ['BOOM!', 'KAPOW!', 'WHAM!', 'BLAM!'], big: ['KABOOM!!', 'KA-BLAM!!', 'MEGA BOOM!'] };
const OUT_LINES = ['was voted out!', 'got impeached!', 'resigned in disgrace!', 'lost re-election!', 'was deposed!', 'left office!', 'is out of politics!'];
const DROWN_LINES = ['sank in the polls!', 'went for a swim!', 'is sleeping with the fishes!', 'was washed out!'];

const normAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function posAt(tr: Track, f: number): [number, number] {
  const n = tr.pts.length / 2;
  const rel = (Math.min(Math.max(f, tr.start), tr.end) - tr.start) / SAMPLE;
  const i = Math.floor(rel);
  if (i >= n - 1) return [tr.pts[(n - 1) * 2], tr.pts[(n - 1) * 2 + 1]];
  const t = rel - i;
  return [tr.pts[i * 2] + (tr.pts[i * 2 + 2] - tr.pts[i * 2]) * t, tr.pts[i * 2 + 1] + (tr.pts[i * 2 + 3] - tr.pts[i * 2 + 1]) * t];
}

export const createArtilleryView: ViewFactory = (root, send) => {
  root.classList.add('full');
  root.innerHTML = `
    <div class="art">
      <div class="art-top">
        <div class="art-turn"></div>
        <div class="art-timer"></div>
        <div class="art-wind" title="Wind"><span class="wind-arrow"></span><div class="wind-bar"><div class="wind-fill"></div></div></div>
        <button class="btn ghost small art-surrender" data-surrender hidden title="Give up this match">🏳️ Surrender</button>
      </div>
      <div class="art-stage">
        <canvas></canvas>
        <div class="art-teams" hidden></div>
        <div class="art-keys">
          <button class="keys-toggle" data-keys title="Keyboard controls (H)">⌨️ Controls</button>
          <div class="keys-list">
            ${KEYS.map(([ks, what]) => `<div class="krow"><span class="kk">${ks.map((k) => (k === '–' ? '–' : `<kbd>${k}</kbd>`)).join('')}</span><span>${what}</span></div>`).join('')}
            <p class="kfoot">${RETREAT_SECONDS}s to run after firing!</p>
          </div>
        </div>
        <div class="art-overlay" hidden></div>
      </div>
      <div class="art-bar">
        <div class="weapons"></div>
        <div class="controls">
          <button class="ctl" data-walk="-1" aria-label="Walk left">◀</button>
          <button class="ctl" data-jump aria-label="Jump">⤴</button>
          <button class="ctl" data-walk="1" aria-label="Walk right">▶</button>
          <button class="fire" data-fire>FIRE</button>
        </div>
      </div>
      <div class="art-hint"></div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const canvas = $<HTMLCanvasElement>('canvas');
  const ctx = canvas.getContext('2d')!;
  const stage = $('.art-stage');
  const overlay = $('.art-overlay');
  const turnEl = $('.art-turn');
  const timerEl = $('.art-timer');
  const windFill = $('.wind-fill');
  const windArrow = $('.wind-arrow');
  const weaponsEl = $('.weapons');
  const barEl = $('.art-bar');
  const hintEl = $('.art-hint');
  const surrenderBtn = $('.art-surrender');
  const teamsEl = $('.art-teams');
  const keysEl = $('.art-keys');
  const KEYS_PREF = 'hgn-art-keys';
  const setKeysOpen = (open: boolean) => {
    keysEl.classList.toggle('open', open);
    try {
      localStorage.setItem(KEYS_PREF, open ? '1' : '0');
    } catch {}
  };
  {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEYS_PREF);
    } catch {}
    // Open by default with a mouse, closed on touch screens.
    keysEl.classList.toggle('open', saved ? saved === '1' : !matchMedia('(pointer: coarse)').matches);
  }
  let surrenderArmed = 0; // tap twice to surrender, so a stray tap doesn't end your match

  let room: RoomView | null = null;
  let me: Player | null = null;
  let s: ArtState | null = null;
  let pending: ArtState | null = null;
  let clockOffset = 0;

  let terrain: Terrain | null = null;
  let terrainCanvas: HTMLCanvasElement | null = null;
  let seed = 0;
  let applied = 0;
  let theme: ThemeId = 'meadow';
  let pal = PALETTES.meadow;
  let backdrop = buildBackdrop(theme);
  let banner: { text: string; sub: string; t0: number } | null = null;

  // Sky dressing: drifting clouds, birds, snow.
  const clouds = Array.from({ length: 7 }, (_, i) => ({ x: (i / 7) * (W + 200) - 100 + Math.random() * 80, y: 40 + Math.random() * 150, s: 0.7 + Math.random() * 0.6 }));
  let birds: { x: number; y: number; vx: number }[] = [];
  let nextBirds = performance.now() + 4000;
  let nextChirp = 0;
  const flakes = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: Math.random() * H, s: 1 + Math.random() * 2, p: Math.random() * 6 }));
  let plane: { tx: number; f: number; dir: 1 | -1 } | null = null;
  let flash = 0;
  const hurtAt = new Map<number, number>();
  const landAt = new Map<number, number>();
  const bubbles = new Map<number, { text: string; t0: number }>();
  let retreat: { wormId: number; until: number } | null = null;
  let retreatShown = false;
  let lastDir: 1 | -1 = 1;

  let pb: Playback | null = null;
  const parts = new Particles();
  const floaters: Floater[] = [];
  const disp = new Map<number, { x: number; y: number }>();
  let shake = 0;

  // Local aim for the player whose turn it is.
  let aim = { angle: -0.8, power: 0.6 };
  let weapon: WeaponId = 'bazooka';
  let target: { x: number; y: number } | null = null;
  let aimDirty = false;
  let lastAimSend = 0;
  let pointerAiming = false;
  let walkBtn: 0 | 1 | -1 = 0;
  let lastWalk = 0;
  let walkCount = 0;
  let lastTick = -1;
  const keys = new Set<string>();

  let view = { scale: 1, ox: 0, oy: 0, cw: 0, ch: 0, dpr: 1 };
  let camX = W / 2;
  let camY = H / 2;

  // ---------- helpers ----------
  const myTeamIdx = () => (s ? s.teams.findIndex((t) => t.playerId === me?.id) : -1);
  const myTurn = () => !!s && s.phase === 'aiming' && !!s.turn && s.teams[s.turn.team]?.playerId === me?.id;
  const canAct = () => myTurn() && !pb;
  const serverNow = () => Date.now() + clockOffset;
  /** Did I just fire, and can I still run? */
  const canRetreat = () => {
    if (!retreat || !pb || !s || serverNow() >= retreat.until) return false;
    const w = wormById(retreat.wormId);
    return !!w && s.teams[w.team]?.playerId === me?.id && pb.alive.get(w.id) !== false;
  };
  const panFor = (x: number) => ((x / W) * 2 - 1) * 0.75;
  const sfx = (name: Sound, x?: number, gain?: number) => audio.play(name, { pan: x === undefined ? 0 : panFor(x), gain });
  const wormById = (id: number) => s?.worms.find((w) => w.id === id);
  const facingOf = (angle: number): 1 | -1 => (Math.cos(angle) >= 0 ? 1 : -1);

  function wormPos(id: number, f: number): [number, number] {
    if (pb) {
      const trs = pb.wormTracks.get(id);
      if (trs) {
        let best: Track | null = null;
        for (const tr of trs) if (tr.start <= f) best = tr;
        if (best) return posAt(best, f);
      }
      const b = pb.tl.before.find((w) => w.id === id);
      if (b) return [b.x, b.y];
    }
    const d = disp.get(id);
    if (d) return [d.x, d.y];
    const w = wormById(id);
    return w ? [w.x, w.y] : [0, 0];
  }

  function applyCrater(c: Crater) {
    terrain?.carve(c[0], c[1], c[2]);
    if (terrainCanvas) carveCanvas(terrainCanvas, c[0], c[1], c[2], theme);
    applied++;
  }

  function syncTerrain() {
    if (!s || !s.seed) {
      terrain = null;
      terrainCanvas = null;
      seed = 0;
      applied = 0;
      return;
    }
    if (s.seed !== seed || s.craters.length < applied) {
      if (s.seed !== seed) {
        const info = mapInfo(s.seed);
        theme = info.theme;
        pal = PALETTES[theme];
        backdrop = buildBackdrop(theme);
        parts.debris = pal.debris;
        banner = { text: THEME_NAMES[info.theme], sub: SHAPE_NAMES[info.shape], t0: performance.now() };
      }
      terrain = Terrain.generate(s.seed, s.craters);
      terrainCanvas = buildTerrainCanvas(terrain);
      seed = s.seed;
      applied = s.craters.length;
      return;
    }
    while (applied < s.craters.length) applyCrater(s.craters[applied]);
  }

  function sendAim(force = false) {
    aimDirty = true;
    const now = performance.now();
    if (!force && now - lastAimSend < 100) return;
    lastAimSend = now;
    aimDirty = false;
    send({ a: 'aim', angle: aim.angle, power: aim.power, weapon });
  }

  // ---------- state ----------
  function applyState(ns: ArtState) {
    const prev = s;
    s = ns;
    syncTerrain();

    // Snap displayed positions to the server's.
    for (const w of s.worms) disp.set(w.id, { x: w.x, y: w.y });

    if (prev && prev.phase !== 'lobby') {
      s.teams.forEach((t, i) => {
        if (t.out && !prev.teams[i]?.out && t.playerId === prev.teams[i]?.playerId) {
          toast(`${t.playerId === me?.id ? 'You' : t.name} ${t.out === 'surrendered' ? 'surrendered' : 'left the match'}`);
        }
      });
    }

    const turnChanged = s.turn && s.turn.no !== prev?.turn?.no;
    if (turnChanged && s.phase === 'aiming') {
      if (myTurn()) {
        sfx('yourTurn');
        setTimeout(() => sfx('hup'), 250);
        aim = { angle: s.turn!.angle, power: s.turn!.power };
        weapon = 'bazooka';
        target = null;
      } else {
        sfx('turn');
      }
      lastTick = -1;
      const wid = s.turn!.wormId;
      setTimeout(() => s?.turn?.wormId === wid && quip(wid, 'turn'), 500);
    }
    if (s.phase === 'over' && prev && prev.phase !== 'over') {
      const mine = myTeamIdx();
      sfx(s.winner !== null && s.winner === mine ? 'win' : mine >= 0 ? 'lose' : 'turn');
    }
    audio.setWind(s.phase === 'aiming' || s.phase === 'resolving' ? s.wind : null);
    renderHud();
    renderOverlay();
  }

  // ---------- playback ----------
  function startPlayback(tl: Timeline) {
    // Finish any playback still running so craters stay in order.
    if (pb) finishPlayback();
    pb = {
      tl,
      t0: performance.now(),
      ev: 0,
      hp: new Map(tl.before.map((w) => [w.id, w.hp])),
      alive: new Map(tl.before.map((w) => [w.id, w.alive])),
      wormTracks: tracksBy(tl, 'worm'),
      crateTracks: tracksBy(tl, 'crate'),
      gone: new Set(),
      flood: null,
      lastF: 0,
      fx: new Set(),
    };
    pointerAiming = false;
    renderHud();
  }

  /**
   * The shooter moved during the retreat, so the server re-ran the shot. The new
   * timeline matches the old one up to the move, so keep the clock and just
   * redo the bookkeeping (HP, crates, craters) up to where we are.
   */
  function replacePlayback(tl: Timeline) {
    if (!pb) return startPlayback(tl);
    const p = pb;
    p.tl = tl;
    p.wormTracks = tracksBy(tl, 'worm');
    p.crateTracks = tracksBy(tl, 'crate');
    p.hp = new Map(tl.before.map((w) => [w.id, w.hp]));
    p.alive = new Map(tl.before.map((w) => [w.id, w.alive]));
    p.gone = new Set();
    p.flood = null;
    p.ev = 0;
    while (p.ev < tl.events.length && tl.events[p.ev].f <= p.lastF) book(tl.events[p.ev++]);
  }

  function finishPlayback() {
    if (!pb) return;
    // Make sure every crater from this timeline is applied.
    for (const e of pb.tl.events.slice(pb.ev)) if (e.type === 'explode' && e.crater === applied) applyCrater([e.x, e.y, e.r!]);
    pb = null;
    if (pending) {
      const p = pending;
      pending = null;
      applyState(p);
    } else renderHud();
  }

  /** State changes from an event, without the effects (so a replacement timeline can replay them). */
  function book(e: SimEvent) {
    const p = pb!;
    switch (e.type) {
      case 'explode':
        if (e.crater === applied) applyCrater([e.x, e.y, e.r!]);
        break;
      case 'damage':
        p.hp.set(e.wormId!, Math.max(0, (p.hp.get(e.wormId!) ?? 0) - e.amount!));
        break;
      case 'pickup':
        p.gone.add(e.crateId!);
        if (e.kind === 'health') p.hp.set(e.wormId!, (p.hp.get(e.wormId!) ?? 0) + (e.amount ?? 0));
        break;
      case 'crate':
        if (e.kind === 'destroy' || e.kind === 'sink') p.gone.add(e.crateId!);
        break;
      case 'die':
        p.alive.set(e.wormId!, false);
        break;
      case 'flood':
        p.flood = { from: e.amount!, to: e.y, f0: e.f };
        break;
    }
  }

  /** Current water level: animating during a flood, otherwise from the state. */
  function waterAt(f: number) {
    const fl = pb?.flood;
    if (fl) return fl.from + (fl.to - fl.from) * Math.min(1, Math.max(0, (f - fl.f0) / FLOOD_FRAMES));
    return s?.water ?? WATER_Y;
  }

  // ---------- speech bubbles ----------
  function say(wormId: number, text: string) {
    bubbles.set(wormId, { text, t0: performance.now() });
  }
  function quip(wormId: number, kind: 'turn' | 'hurt' | 'fire' | 'pickupHealth' | 'pickupWeapon') {
    const w = wormById(wormId);
    if (!w) return;
    const sv = w.name in SWEDISH;
    const list = sv && kind === 'turn' ? QUIPS.svTurn : sv && kind === 'hurt' ? QUIPS.svHurt : QUIPS[kind];
    say(wormId, pick(list));
  }

  function crateFx(c: { x: number; y: number }, wormId: number, kind: string | undefined) {
    const health = kind === 'health';
    parts.sparkle(c.x, c.y);
    sfx(health ? 'heal' : 'pickup', c.x);
    const wp = !health && kind && kind in WEAPON_BY_ID ? WEAPON_BY_ID[kind as WeaponId] : null;
    floaters.push({ x: c.x, y: c.y - 16, text: health ? `+${CRATE_HEALTH}` : `+1 ${wp?.icon ?? ''} ${wp?.name ?? 'weapon'}`, color: health ? '#7cf29a' : '#ffe14d', life: 0, size: 16, rot: 0 });
    quip(wormId, health ? 'pickupHealth' : 'pickupWeapon');
  }

  const nowF = () => ((performance.now() - pb!.t0) / 1000) * FPS;

  function comic(x: number, y: number, text: string, size: number, color = '#ffe14d') {
    floaters.push({ x, y, text, color, life: 0, size, comic: true, rot: (Math.random() - 0.5) * 0.4, max: 1.1 });
  }

  function handleEvent(e: SimEvent) {
    const p = pb!;
    book(e);
    switch (e.type) {
      case 'fire': {
        const shooter = s?.turn ? wormPos(s.turn.wormId, nowF()) : [e.x, e.y];
        parts.muzzle(e.x, e.y, Math.atan2(e.y - shooter[1], e.x - shooter[0]));
        if (e.kind === 'grenade' || e.kind === 'haybomb' || e.kind === 'cluster') sfx('throw', e.x);
        else if (e.kind === 'shotgun') sfx('click', e.x);
        else {
          sfx('launch', e.x);
          sfx('whoosh', e.x, 0.7);
        }
        break;
      }
      case 'explode': {
        const r = e.r!;
        parts.explosion(e.x, e.y, r);
        shake = Math.min(22, shake + r / 3);
        if (r >= 60) flash = 0.7;
        if (e.kind === 'haybomb') {
          parts.holy(e.x, e.y);
          comic(e.x, e.y - r * 0.6, 'HALLELUJAH!', 30, '#fff59a');
        } else if (r >= 16) {
          comic(e.x, e.y - r * 0.5, pick(r >= 60 ? BOOM_WORDS.big : r >= 28 ? BOOM_WORDS.mid : BOOM_WORDS.small), r >= 28 ? 24 : 17);
        }
        sfx(r >= 60 ? 'bigExplosion' : r >= 24 ? 'explosion' : 'smallExplosion', e.x);
        break;
      }
      case 'bounce':
        if (e.wormId !== undefined) {
          // Bonked a worm on the head.
          parts.stars(e.x, e.y, 4);
          comic(e.x, e.y - 10, 'BONK!', 14, '#ffffff');
          sfx('bonk', e.x);
          hurtAt.set(e.wormId, performance.now() - 300);
        } else {
          parts.dust(e.x, e.y, 3, 0.6);
          sfx(e.kind === 'haybomb' ? 'boing' : 'bounce', e.x, 0.8);
        }
        break;
      case 'splash':
        parts.splash(e.x, e.y);
        sfx('splash', e.x);
        break;
      case 'damage': {
        const w = wormById(e.wormId!);
        const [x, y] = wormPos(e.wormId!, nowF());
        floaters.push({ x, y: y - 20, text: `-${e.amount}`, color: w ? s!.teams[w.team].color : '#fff', life: 0, size: 18, rot: 0 });
        hurtAt.set(e.wormId!, performance.now());
        sfx('hurt', x, 0.9);
        if ((p.hp.get(e.wormId!) ?? 0) > 0 && Math.random() < 0.45) quip(e.wormId!, 'hurt');
        renderTeams();
        break;
      }
      case 'pickup':
        crateFx(e, e.wormId!, e.kind);
        renderTeams();
        break;
      case 'crate':
        if (e.kind === 'drop') sfx('parachute', e.x);
        else if (e.kind === 'land') {
          parts.dust(e.x, e.y + 8, 5, 0.8);
          sfx('crateLand', e.x);
        } else if (e.kind === 'destroy') {
          parts.confetti(e.x, e.y, ['#c68a4a', '#7a4e24', '#ffffff'], 12);
          sfx('pop', e.x);
        }
        break;
      case 'flood':
        if (e.amount === WATER_Y) {
          banner = { text: 'SUDDEN DEATH!', sub: 'The water is rising', t0: performance.now() };
          sfx('alarm');
        }
        sfx('flood', W / 2);
        break;
      case 'die': {
        bubbles.delete(e.wormId!);
        renderTeams();
        const w = wormById(e.wormId!);
        const name = w?.name ?? 'Someone';
        if (e.kind === 'drown') {
          parts.splash(e.x, e.y, true);
          parts.bubbles(e.x, e.y);
          sfx('slide', e.x);
          setTimeout(() => sfx('bubbles', e.x), 700);
          comic(e.x, e.y - 40, `${name} ${pick(DROWN_LINES)}`, 15, '#ffffff');
        } else {
          parts.explosion(e.x, e.y, 12);
          parts.confetti(e.x, e.y, w ? [s!.teams[w.team].color, '#fff', '#ffe14d'] : ['#fff']);
          sfx('die', e.x);
          comic(e.x, e.y - 30, `${name} ${pick(OUT_LINES)}`, 15, '#ffffff');
        }
        break;
      }
      case 'shot':
        parts.tracer(e.x, e.y, e.x2!, e.y2!);
        parts.muzzle(e.x, e.y, Math.atan2(e.y2! - e.y, e.x2! - e.x));
        sfx('shotgun', e.x);
        if (Math.random() < 0.6) setTimeout(() => sfx('ricochet', e.x2, 0.6), 120);
        break;
      case 'airstrike': {
        const w = s?.turn ? wormById(s.turn.wormId) : undefined;
        plane = { tx: e.x, f: e.f, dir: w?.facing ?? 1 };
        sfx('plane', e.x);
        break;
      }
      case 'teleport':
        parts.sparkle(e.x, e.y);
        parts.sparkle(e.x2!, e.y2!);
        sfx('teleport', e.x2);
        setTimeout(() => sfx('pop', e.x2), 250);
        break;
      case 'jump':
        parts.dust(e.x, e.y + WORM_R, 5, 0.8);
        sfx('jump', e.x);
        break;
      case 'land': {
        const v = e.amount ?? 0;
        if (v > 120) parts.dust(e.x, e.y + WORM_R, Math.round(4 + v / 80), Math.min(2, v / 300));
        if (v > 200) sfx('land', e.x, Math.min(1, v / 500));
        if (v > 120) landAt.set(e.wormId!, performance.now());
        break;
      }
    }
  }

  function stepPlayback(f: number) {
    const p = pb!;
    p.lastF = f;
    while (p.ev < p.tl.events.length && p.tl.events[p.ev].f <= f) handleEvent(p.tl.events[p.ev++]);

    for (const tr of p.tl.tracks) {
      if (tr.kind === 'worm' || f < tr.start || f > tr.end) continue;
      const [x, y] = posAt(tr, f);
      if (tr.kind === 'rocket' || tr.kind === 'missile' || tr.kind === 'cluster') {
        if (Math.random() < 0.7) parts.trail(x, y);
      }
      if (tr.kind === 'missile' && !p.fx.has(tr.key)) {
        p.fx.add(tr.key);
        sfx('whistle', x, 0.7);
      }
      if (tr.kind === 'grenade' || tr.kind === 'haybomb') {
        const sec = Math.floor((f - tr.start) / FPS);
        const k = `${tr.key}:${sec}`;
        if (!p.fx.has(k)) {
          p.fx.add(k);
          sfx('fuse', x);
        }
        if (tr.kind === 'haybomb' && tr.end - f < 75 && !p.fx.has(tr.key + 'holy')) {
          p.fx.add(tr.key + 'holy');
          sfx('holy', x);
        }
      }
    }
    if (f >= p.tl.frames) {
      plane = null;
      finishPlayback();
    }
  }

  // ---------- HUD ----------
  function renderHud() {
    if (!s) return;
    const turn = s.turn;
    const team = turn ? s.teams[turn.team] : null;
    const worm = turn ? wormById(turn.wormId) : null;
    if (s.phase === 'lobby') turnEl.innerHTML = 'Lobby';
    else if (s.phase === 'over') turnEl.innerHTML = 'Game over';
    else if (team && worm) {
      turnEl.innerHTML = `<i class="dot" style="background:${team.color}"></i>${myTurn() ? `<b>Your turn</b> · ${esc(worm.name)}` : `${esc(team.name)} · ${esc(worm.name)}`}`;
    }

    const showWind = s.phase === 'aiming' || s.phase === 'resolving';
    $('.art-wind').style.visibility = showWind ? 'visible' : 'hidden';
    const wpct = Math.abs(s.wind) * 50;
    windFill.style.width = `${wpct}%`;
    windFill.style.left = s.wind >= 0 ? '50%' : `${50 - wpct}%`;
    windArrow.textContent = s.wind === 0 ? '·' : (s.wind > 0 ? '→' : '←').repeat(Math.max(1, Math.round(Math.abs(s.wind) * 3)));

    const mine = myTeamIdx();
    const ammo = mine >= 0 ? s.teams[mine].ammo : null;
    weaponsEl.innerHTML = WEAPONS.map((wp, i) => {
      const left = ammo ? ammo[wp.id] : wp.ammo;
      const out = left === 0;
      return `<button class="wpn ${wp.id === weapon ? 'sel' : ''}" data-weapon="${wp.id}" ${out ? 'disabled' : ''} title="${esc(`${wp.name} (${i + 1}): ${wp.hint}`)}">
        <span>${wp.icon}</span>${left >= 0 ? `<i>${left}</i>` : ''}</button>`;
    }).join('');

    const inMatch = s.phase === 'aiming' || s.phase === 'resolving';
    const myTeam = mine >= 0 ? s.teams[mine] : null;
    const canSurrender = inMatch && !!myTeam && !myTeam.out && s.worms.some((w) => w.team === mine && w.alive);
    surrenderBtn.hidden = !canSurrender;
    if (!canSurrender) surrenderArmed = 0;
    surrenderBtn.textContent = surrenderArmed ? 'Tap again to give up' : '🏳️ Surrender';

    const active = canAct();
    const running = canRetreat();
    barEl.classList.toggle('inactive', !active && !running);
    barEl.classList.toggle('retreat', running);
    const wp = WEAPON_BY_ID[weapon];
    hintEl.textContent = running
      ? '🏃 Run for cover! Walk or jump before your shot lands.'
      : active
        ? `${wp.icon} ${wp.name}: ${wp.hint}  ·  ${wp.aim === 'target' ? 'Tap the map to target' : 'Drag to aim (distance = power)'}`
        : s.phase === 'aiming' && team && !myTurn()
          ? `Watching ${team.name}…`
          : '';
    keysEl.hidden = !inMatch;
    renderTeams();
  }

  /** The little scoreboard in the corner: each team's health, worms left, and who's away. */
  function renderTeams() {
    if (!s || !room || (s.phase !== 'aiming' && s.phase !== 'resolving')) {
      teamsEl.hidden = true;
      return;
    }
    teamsEl.hidden = false;
    const online = new Set(room.players.map((p) => p.id));
    const hpOf = (id: number, hp: number) => (pb ? pb.hp.get(id) ?? hp : hp);
    const aliveOf = (id: number, alive: boolean) => (pb ? pb.alive.get(id) ?? alive : alive);
    const maxHp = s.wormsPerTeam * 100;
    const rows = s.teams.map((t, i) => {
      const worms = s!.worms.filter((w) => w.team === i);
      const living = worms.filter((w) => aliveOf(w.id, w.alive));
      const hp = living.reduce((sum, w) => sum + hpOf(w.id, w.hp), 0);
      const status = t.out === 'surrendered' ? '🏳️' : t.out === 'left' ? '🚪' : !living.length ? '💀' : !online.has(t.playerId) ? '📴' : '';
      const cur = s!.turn?.team === i;
      const cls = [cur ? 'cur' : '', t.playerId === me?.id ? 'me' : '', !living.length ? 'dead' : ''].join(' ');
      return `<div class="trow ${cls}" title="${esc(t.name)}: ${hp} HP, ${living.length} of ${worms.length} worms left">
        <i class="dot" style="background:${t.color}"></i><span class="tname">${esc(t.name)}</span>
        <span class="hpbar"><b style="width:${Math.min(100, (hp / maxHp) * 100)}%;background:${t.color}"></b></span>
        <span class="tinfo">${status || `${living.length}×`}</span></div>`;
    });
    let sd = '';
    if (s.sdTurn && s.turn) {
      const left = s.sdTurn - s.turn.no + 1;
      sd = `<div class="sd ${left <= 1 ? 'hot' : ''}">🌊 ${left <= 0 ? 'Sudden death!' : left === 1 ? 'Flood after this turn' : `Flood in ${left} turns`}</div>`;
    }
    const html = sd + rows.join('');
    if (teamsEl.innerHTML !== html) teamsEl.innerHTML = html;
  }

  function renderOverlay() {
    if (!s || !room || !me) return;
    const isHost = room.hostId === me.id;
    if (s.phase === 'lobby') {
      const joined = myTeamIdx() >= 0;
      overlay.hidden = false;
      overlay.innerHTML = `
        <div class="panel">
          <h2>💥 Hayalo Artillery</h2>
          <p class="muted">Take turns blasting each other off a destructible island. Last team standing wins.</p>
          <ul class="teams">
            ${s.teams.map((t) => `<li><i class="dot" style="background:${t.color}"></i>${esc(t.name)}</li>`).join('') || '<li class="muted">No one has joined yet</li>'}
          </ul>
          <button class="btn" data-art="${joined ? 'leave' : 'join'}">${joined ? 'Leave' : 'Join the battle'}</button>
          ${
            isHost
              ? `<div class="settings">
                  <label>Worms each ${[1, 2, 3, 4].map((n) => `<button class="chip ${s!.wormsPerTeam === n ? 'on' : ''}" data-art="wpt:${n}">${n}</button>`).join('')}</label>
                  <label>Turn time ${[30, 45, 60].map((n) => `<button class="chip ${s!.turnSeconds === n ? 'on' : ''}" data-art="secs:${n}">${n}s</button>`).join('')}</label>
                  <label>Crates ${[true, false].map((on) => `<button class="chip ${s!.cratesOn === on ? 'on' : ''}" data-art="crates:${on ? 1 : 0}">${on ? 'On' : 'Off'}</button>`).join('')}</label>
                  <label title="After this many rounds the water starts rising every turn">Sudden death ${[0, 4, 8, 12].map((n) => `<button class="chip ${s!.suddenDeath === n ? 'on' : ''}" data-art="sd:${n}">${n ? `${n} rounds` : 'Off'}</button>`).join('')}</label>
                </div>
                <button class="btn start" data-art="start" ${s.teams.length ? '' : 'disabled'}>${s.teams.length === 1 ? 'Start solo practice' : 'Start match'}</button>`
              : `<p class="muted">Worms each: ${s.wormsPerTeam} · Turn time: ${s.turnSeconds}s · Crates: ${s.cratesOn ? 'on' : 'off'} · Sudden death: ${s.suddenDeath ? `after ${s.suddenDeath} rounds` : 'off'}<br>Waiting for the host to start…</p>`
          }
        </div>`;
    } else if (s.phase === 'over') {
      const winner = s.winner !== null ? s.teams[s.winner] : null;
      overlay.hidden = false;
      overlay.innerHTML = `
        <div class="panel">
          <h2>${winner ? `🏆 ${esc(winner.name)} wins!` : s.solo ? 'Practice over' : 'Everyone is down. Draw!'}</h2>
          ${isHost ? `<button class="btn" data-art="restart">Back to lobby</button>` : '<p class="muted">Waiting for the host…</p>'}
        </div>`;
    } else {
      overlay.hidden = true;
      overlay.innerHTML = '';
    }
  }

  // ---------- input ----------
  function toWorld(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale };
  }

  function aimAt(pt: { x: number; y: number }) {
    const [wx, wy] = wormPos(s!.turn!.wormId, 0);
    const dx = pt.x - wx;
    const dy = pt.y - wy;
    aim.angle = Math.atan2(dy, dx);
    aim.power = Math.max(0.05, Math.min(1, Math.hypot(dx, dy) / 250));
    sendAim();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canAct()) return;
    const pt = toWorld(e);
    if (WEAPON_BY_ID[weapon].aim === 'target') {
      const x = Math.round(pt.x);
      const y = Math.round(pt.y);
      if (weapon === 'teleport' && terrain && !clearSpot(terrain, x, y)) {
        toast("Can't teleport there. Pick an open spot");
        return;
      }
      target = { x, y };
      sfx('click');
      return;
    }
    pointerAiming = true;
    canvas.setPointerCapture(e.pointerId);
    aimAt(pt);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointerAiming && canAct()) aimAt(toWorld(e));
  });
  const endPointer = () => {
    if (pointerAiming) sendAim(true);
    pointerAiming = false;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function fire() {
    if (!canAct()) return;
    const wp = WEAPON_BY_ID[weapon];
    if (wp.aim === 'target' && !target) return toast('Tap the map to pick a target first');
    send({ a: 'fire', weapon, angle: aim.angle, power: aim.power, tx: target?.x, ty: target?.y });
  }

  function jump() {
    if (canAct()) send({ a: 'jump' });
    else if (canRetreat()) send({ a: 'jump', dir: lastDir });
  }

  function selectWeapon(id: WeaponId) {
    if (!s) return;
    const mine = myTeamIdx();
    if (mine >= 0 && s.teams[mine].ammo[id] === 0) return;
    weapon = id;
    target = null;
    sfx('select');
    if (myTurn()) sendAim(true);
    renderHud();
  }

  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-art],[data-weapon],[data-fire],[data-jump],[data-surrender],[data-keys]');
    if (!el) return;
    if (el.dataset.keys !== undefined) return setKeysOpen(!keysEl.classList.contains('open'));
    if (el.dataset.surrender !== undefined) {
      if (Date.now() - surrenderArmed < 3000) {
        surrenderArmed = 0;
        send({ a: 'surrender' });
      } else {
        surrenderArmed = Date.now();
        setTimeout(() => {
          if (surrenderArmed && Date.now() - surrenderArmed >= 3000) {
            surrenderArmed = 0;
            renderHud();
          }
        }, 3100);
      }
      return renderHud();
    }
    if (el.dataset.weapon) return selectWeapon(el.dataset.weapon as WeaponId);
    if (el.dataset.fire !== undefined) return fire();
    if (el.dataset.jump !== undefined) return jump();
    const cmd = el.dataset.art!;
    sfx('click');
    if (cmd.startsWith('wpt:')) send({ a: 'settings', wormsPerTeam: Number(cmd.slice(4)) });
    else if (cmd.startsWith('secs:')) send({ a: 'settings', turnSeconds: Number(cmd.slice(5)) });
    else if (cmd.startsWith('crates:')) send({ a: 'settings', crates: cmd.endsWith('1') });
    else if (cmd.startsWith('sd:')) send({ a: 'settings', suddenDeath: Number(cmd.slice(3)) });
    else send({ a: cmd });
  });

  // Hold-to-walk buttons.
  for (const b of root.querySelectorAll<HTMLElement>('[data-walk]')) {
    const dir = Number(b.dataset.walk) as 1 | -1;
    b.addEventListener('pointerdown', (e) => {
      walkBtn = dir;
      b.setPointerCapture(e.pointerId);
    });
    const stop = () => {
      if (walkBtn === dir) walkBtn = 0;
    };
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(k)) e.preventDefault();
    if (e.repeat) return;
    keys.add(k);
    if (k === ' ' || k === 'Enter') fire();
    else if (k === 'j') jump();
    else if (k === 'h' || k === '?') setKeysOpen(!keysEl.classList.contains('open'));
    else if (/^[1-7]$/.test(k)) selectWeapon(WEAPONS[Number(k) - 1].id);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys.delete(k);
    if (myTurn()) sendAim(true);
  };
  const onBlur = () => {
    keys.clear();
    walkBtn = 0;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function processInput(dt: number, now: number) {
    const running = canRetreat();
    if (!canAct() && !running) return;
    const kdir = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0);
    const dir = (walkBtn || kdir) as 0 | 1 | -1;
    if (running) {
      // Running from your own shot: walking only, no aiming.
      if (dir && now - lastWalk > 50) {
        lastWalk = now;
        lastDir = dir;
        send({ a: 'walk', dir });
        if (++walkCount % 3 === 0) sfx('step', wormPos(retreat!.wormId, nowF())[0]);
      }
      return;
    }
    if (dir && now - lastWalk > 50) {
      lastWalk = now;
      lastDir = dir;
      send({ a: 'walk', dir });
      // Turning around mirrors the aim.
      if (facingOf(aim.angle) !== dir) aim.angle = normAngle(Math.PI - aim.angle);
      if (++walkCount % 3 === 0) sfx('step', wormPos(s!.turn!.wormId, 0)[0]);
    }

    const up = keys.has('ArrowUp') || keys.has('w') ? 1 : 0;
    const down = keys.has('ArrowDown') || keys.has('s') ? 1 : 0;
    if (up !== down) {
      const facing = facingOf(aim.angle);
      let elev = facing === 1 ? -aim.angle : normAngle(aim.angle + Math.PI);
      elev = Math.max(-1.45, Math.min(1.5, elev + (up - down) * 1.3 * dt));
      aim.angle = facing === 1 ? -elev : normAngle(elev - Math.PI);
      sendAim();
    }
    const pUp = keys.has('e') || keys.has('+') ? 1 : 0;
    const pDown = keys.has('q') || keys.has('-') ? 1 : 0;
    if (pUp !== pDown) {
      aim.power = Math.max(0.05, Math.min(1, aim.power + (pUp - pDown) * 0.6 * dt));
      sendAim();
    }
    if (aimDirty) sendAim();
  }

  // ---------- render loop ----------
  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, r.width);
    const ch = Math.max(1, r.height);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    view = { ...view, cw, ch, dpr };
  }

  /** Where the camera should look: the projectile in flight, a moving worm, or the active worm. */
  function focusPoint(f: number): [number, number] | null {
    if (pb) {
      for (const tr of pb.tl.tracks) if (tr.kind !== 'worm' && f >= tr.start && f < tr.end) return posAt(tr, f);
      for (const tr of pb.tl.tracks) if (tr.kind === 'worm' && f >= tr.start && f < tr.end) return posAt(tr, f);
      // Shot has landed but the shooter is still running: watch them.
      if (retreat && serverNow() < retreat.until && pb.alive.get(retreat.wormId) !== false) return wormPos(retreat.wormId, f);
      const ex = [...pb.tl.events].reverse().find((e) => e.f <= f && e.type === 'explode');
      if (ex) return [ex.x, ex.y];
    }
    if (s?.turn && s.phase === 'aiming') return wormPos(s.turn.wormId, f);
    return null;
  }

  // Fit the whole island when it fills most of the screen. On tall, narrow
  // screens (phones) zoom in, up to 2.2x, and follow the action.
  function updateCamera(f: number, dt: number) {
    const { cw, ch } = view;
    const fit = Math.min(cw / W, ch / H);
    const scale = fit * H < ch * 0.7 ? Math.min((ch * 0.7) / H, fit * 2.2) : fit;
    const focus = focusPoint(f);
    if (focus) {
      const k = Math.min(1, dt * (pb ? 6 : 3));
      camX += (focus[0] - camX) * k;
      camY += (focus[1] - camY) * k;
    }
    let ox = cw / 2 - camX * scale;
    let oy = ch / 2 - camY * scale;
    const ww = W * scale;
    const wh = H * scale;
    ox = ww <= cw ? (cw - ww) / 2 : Math.min(0, Math.max(cw - ww, ox));
    oy = wh <= ch ? ch - wh : Math.min(0, Math.max(ch - wh, oy));
    view = { ...view, scale, ox, oy };
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  let raf = 0;
  let last = performance.now();
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = now / 1000;
    processInput(dt, now);

    const f = pb ? ((now - pb.t0) / 1000) * FPS : 0;
    if (pb) stepPlayback(f);
    parts.update(dt);
    updateCamera(f, dt);

    const { scale, ox, oy, cw, ch, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSky(ctx, cw, ch, pal);

    shake *= Math.pow(0.02, dt);
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
    drawSun(ctx, time, pal);
    drawSkyLife(dt, now, time);
    ctx.drawImage(backdrop, 0, 0);
    if (terrainCanvas) ctx.drawImage(terrainCanvas, 0, 0);

    const labels: { id: number; x: number; y: number; name: string; hp: number; color: string }[] = [];
    if (s && s.phase !== 'lobby') {
      const focus = focusPoint(f);
      drawCrates(f, time);
      // Worms (and graves)
      for (const w of s.worms) {
        const alive = pb ? pb.alive.get(w.id) ?? w.alive : w.alive;
        let [x, y] = wormPos(w.id, f);
        let walking = false;
        let stretch = 0;
        if (!pb && alive) {
          const d = disp.get(w.id);
          if (d) {
            walking = Math.abs(w.x - d.x) > 0.4;
            d.x += (w.x - d.x) * Math.min(1, dt * 18);
            d.y += (w.y - d.y) * Math.min(1, dt * 18);
            [x, y] = [d.x, d.y];
          }
        }
        if (pb) {
          const [, py] = wormPos(w.id, f - 2);
          stretch = Math.min(0.3, Math.abs(y - py) / 30);
        }
        const landed = landAt.get(w.id);
        if (landed !== undefined) {
          const t = (now - landed) / 1000;
          if (t < 0.25) stretch = -0.3 * Math.sin((t / 0.25) * Math.PI);
          else landAt.delete(w.id);
        }
        if (!alive) {
          if (y < WATER_Y - 4) drawGrave(ctx, x, y);
          continue;
        }
        const team = s.teams[w.team];
        const active = s.phase === 'aiming' && s.turn?.wormId === w.id;
        let facing = w.facing;
        if (active && myTurn()) facing = facingOf(aim.angle);
        else if (active && s.turn) facing = facingOf(s.turn.angle);
        // Eyes follow the aim, or whatever is flying around.
        let look: number | null = null;
        if (active && !pb && s.turn) look = myTurn() ? aim.angle : s.turn.angle;
        else if (focus && Math.hypot(focus[0] - x, focus[1] - y) > 4) look = Math.atan2(focus[1] - y, focus[0] - x);
        if (!active && look !== null && !pb) facing = Math.cos(look) >= 0 ? 1 : -1;
        const hp = pb ? pb.hp.get(w.id) ?? w.hp : w.hp;
        const hurt = hurtAt.get(w.id);
        drawWorm(ctx, x, y, {
          id: w.id, name: w.name, color: team.color, facing, time, active, walking, hp, look, stretch,
          hurtAgo: hurt === undefined ? 99 : (now - hurt) / 1000,
        });
        labels.push({ id: w.id, x, y, name: w.name, hp, color: team.color });

        if (active && !pb) {
          // Bouncing marker
          const by = y - 40 + Math.sin(time * 5) * 3;
          ctx.fillStyle = team.color;
          ctx.strokeStyle = '#2b1d33';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x - 6, by - 8);
          ctx.lineTo(x + 6, by - 8);
          ctx.lineTo(x, by);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          drawAim(x, y, team.color, time);
        }
      }

      // Projectiles
      if (pb) {
        for (const tr of pb.tl.tracks) {
          if (tr.kind === 'worm' || f < tr.start || f >= tr.end) continue;
          const [x, y] = posAt(tr, f);
          const [px, py] = posAt(tr, f - 1);
          drawProjectile(ctx, tr.kind as ProjKind, x, y, Math.atan2(y - py, x - px), time);
        }
      }
      if (plane && pb) {
        const px = plane.tx - plane.dir * 120 + plane.dir * (f - plane.f - 50) * 4.3;
        if (px > -150 && px < W + 150) drawPlane(ctx, px, 26 + Math.sin(time * 3) * 3, plane.dir, time);
      }
    }

    parts.draw(ctx);
    const level = waterAt(f);
    parts.water = level;
    drawWater(ctx, time, (ch - oy) / scale + 10, pal, level);
    if (pal.weather === 'snow') drawSnow(dt, time);

    // Screen-space text so it stays crisp at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    // Worms standing close together would have their labels on top of each
    // other, so stack the later ones upwards.
    const placed: { x: number; y: number }[] = [];
    labels.sort((a, b) => b.y - a.y);
    for (const l of labels) {
      const lx = ox + l.x * scale;
      let ly = oy + (l.y - WORM_R) * scale - 10;
      for (let k = 0; k < 4 && placed.some((p) => Math.abs(p.x - lx) < 58 && Math.abs(p.y - ly) < 26); k++) ly -= 26;
      placed.push({ x: lx, y: ly });
      ctx.font = '800 11px system-ui, sans-serif';
      const hpText = `${l.hp}`;
      const bw = ctx.measureText(hpText).width + 8;
      ctx.fillStyle = 'rgba(26, 19, 37, 0.85)';
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(lx - bw / 2, ly - 10, bw, 13, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = l.color;
      ctx.fillText(hpText, lx, ly + 0.5);
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(26,19,37,0.85)';
      ctx.fillStyle = '#fff';
      const party = partyOf(l.name);
      // Swedish politicians get a little party tag after their name.
      const tag = party ? SWEDISH[l.name] : '';
      const nameW = ctx.measureText(l.name).width;
      const tagW = tag ? ctx.measureText(tag).width + 6 : 0;
      const nx = lx - (tag ? (tagW + 3) / 2 : 0);
      ctx.strokeText(l.name, nx, ly - 14);
      ctx.fillText(l.name, nx, ly - 14);
      if (party) {
        const tx = nx + nameW / 2 + 3;
        ctx.fillStyle = party.color;
        ctx.strokeStyle = 'rgba(26,19,37,0.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(tx, ly - 23, tagW, 12, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = party.text;
        ctx.fillText(tag, tx + tagW / 2, ly - 14);
      }
      l.y = ly - 26; // bubbles go above the name (screen space from here on)
    }
    drawBubbles(labels, now);
    for (let i = floaters.length - 1; i >= 0; i--) {
      const fl = floaters[i];
      fl.life += dt;
      const max = fl.max ?? 1.3;
      if (fl.life > max) {
        floaters.splice(i, 1);
        continue;
      }
      // Pop in big, settle, then fade.
      const t = fl.life;
      const pop = t < 0.12 ? 0.4 + (t / 0.12) * 0.9 : t < 0.25 ? 1.3 - ((t - 0.12) / 0.13) * 0.3 : 1;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (max - t) * 3);
      ctx.translate(ox + fl.x * scale, oy + fl.y * scale - t * (fl.comic ? 18 : 34));
      ctx.rotate(fl.rot ?? 0);
      ctx.scale(pop, pop);
      ctx.font = fl.comic ? `900 ${fl.size}px "Comic Sans MS", "Chalkboard SE", "Comic Neue", system-ui, sans-serif` : `900 ${fl.size}px system-ui, sans-serif`;
      ctx.lineWidth = fl.comic ? 6 : 4;
      ctx.strokeStyle = fl.comic ? '#2b1d33' : 'rgba(0,0,0,0.85)';
      ctx.fillStyle = fl.color;
      ctx.strokeText(fl.text, 0, 0);
      ctx.fillText(fl.text, 0, 0);
      ctx.restore();
    }

    if (flash > 0.01) {
      ctx.fillStyle = `rgba(255, 252, 235, ${flash})`;
      ctx.fillRect(0, 0, cw, ch);
      flash *= Math.pow(0.004, dt);
    }
    if (banner) drawBanner(now, cw, ch);

    updateTimer();
  }

  function drawCrates(f: number, time: number) {
    const list: Crate[] = pb ? pb.tl.crates.filter((c) => f >= c.from && !pb!.gone.has(c.id)) : s!.crates;
    for (const c of list) {
      let x = c.x;
      let y = c.y;
      let para = false;
      const tr = pb ? latest(pb.crateTracks.get(c.id), f) : null;
      if (tr) {
        [x, y] = posAt(tr, f);
        para = !!tr.para && f < tr.end;
      }
      drawCrate(ctx, x, y, c.kind, time, para);
    }
  }

  function drawBubbles(labels: { id: number; x: number; y: number }[], now: number) {
    const { scale, ox } = view;
    for (const [id, b] of bubbles) {
      const t = (now - b.t0) / 1000;
      const l = labels.find((x) => x.id === id);
      if (t > 2.4 || !l) {
        if (t > 2.4) bubbles.delete(id);
        continue;
      }
      const pop = t < 0.12 ? 0.5 + (t / 0.12) * 0.6 : t < 0.22 ? 1.1 - ((t - 0.12) / 0.1) * 0.1 : 1;
      drawBubble(ctx, ox + l.x * scale, l.y, b.text, Math.min(1, (2.4 - t) * 4), pop);
    }
  }

  /** "Frosty Peaks · Twin Isles" title card at the start of a match. */
  function drawBanner(now: number, cw: number, ch: number) {
    const t = (now - banner!.t0) / 1000;
    if (t > 3.2 || !s || s.phase === 'lobby') {
      if (t > 3.2) banner = null;
      return;
    }
    const a = Math.min(1, t * 4, (3.2 - t) * 2);
    const drop = t < 0.3 ? (1 - t / 0.3) * -40 : 0;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cw / 2, Math.min(ch * 0.28, 120) + drop);
    ctx.rotate(-0.03);
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.font = '900 32px "Comic Sans MS", "Chalkboard SE", "Comic Neue", system-ui, sans-serif';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#2b1d33';
    ctx.fillStyle = '#ffe14d';
    ctx.strokeText(banner!.text, 0, 0);
    ctx.fillText(banner!.text, 0, 0);
    ctx.font = '800 16px system-ui, sans-serif';
    ctx.lineWidth = 5;
    ctx.fillStyle = '#fff';
    ctx.strokeText(banner!.sub, 0, 24);
    ctx.fillText(banner!.sub, 0, 24);
    ctx.restore();
  }

  function drawSkyLife(dt: number, now: number, time: number) {
    const wind = s && (s.phase === 'aiming' || s.phase === 'resolving') ? s.wind : 0.1;
    for (const c of clouds) {
      c.x += (wind * 30 + 3) * c.s * dt;
      if (c.x > W + 120) c.x = -120;
      if (c.x < -120) c.x = W + 120;
      drawCloud(ctx, c.x, c.y, c.s);
    }
    if (pal.weather !== 'birds') return;
    if (now > nextBirds) {
      nextBirds = now + 9000 + Math.random() * 14000;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const y = 60 + Math.random() * 120;
      const n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) birds.push({ x: dir > 0 ? -30 - i * 22 : W + 30 + i * 22, y: y + (i % 2) * 12 + Math.random() * 6, vx: dir * (60 + Math.random() * 15) });
    }
    birds = birds.filter((b) => b.x > -200 && b.x < W + 200);
    for (const b of birds) {
      b.x += b.vx * dt;
      drawBird(ctx, b.x, b.y + Math.sin(time * 2 + b.x / 50) * 4, time);
    }
    if (birds.length && now > nextChirp) {
      nextChirp = now + 700 + Math.random() * 1500;
      const b = birds[Math.floor(Math.random() * birds.length)];
      if (b.x > 0 && b.x < W) sfx('chirp', b.x, 0.5);
    }
  }

  function drawSnow(dt: number, time: number) {
    const wind = s && (s.phase === 'aiming' || s.phase === 'resolving') ? s.wind : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (const fl of flakes) {
      fl.y += (18 + fl.s * 12) * dt;
      fl.x += (wind * 70 + Math.sin(time + fl.p) * 10) * dt;
      if (fl.y > WATER_Y) fl.y = -5;
      if (fl.x > W + 10) fl.x = -10;
      if (fl.x < -10) fl.x = W + 10;
      ctx.moveTo(fl.x + fl.s, fl.y);
      ctx.arc(fl.x, fl.y, fl.s, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function drawAim(x: number, y: number, color: string, time: number) {
    if (!s?.turn) return;
    const mine = myTurn();
    const wp = WEAPON_BY_ID[mine ? weapon : s.turn.weapon];
    if (wp.aim === 'target') {
      if (mine && target) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        const r = 10 + Math.sin(time * 6) * 2;
        ctx.beginPath();
        ctx.arc(target.x, target.y, r, 0, Math.PI * 2);
        ctx.moveTo(target.x - r - 5, target.y);
        ctx.lineTo(target.x + r + 5, target.y);
        ctx.moveTo(target.x, target.y - r - 5);
        ctx.lineTo(target.x, target.y + r + 5);
        ctx.stroke();
      }
      return;
    }
    const angle = mine ? aim.angle : s.turn.angle;
    const power = mine ? aim.power : s.turn.power;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const len = 22 + power * 90;
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.lineDashOffset = -time * 20;
    ctx.strokeStyle = 'rgba(43,29,51,0.5)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + dx * 14, y + dy * 14);
    ctx.lineTo(x + dx * len, y + dy * len);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + dx * 14, y + dy * 14);
    ctx.lineTo(x + dx * len, y + dy * len);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + dx * len, y + dy * len, 6, 0, Math.PI * 2);
    ctx.stroke();
    if (mine) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(43,29,51,0.8)';
      ctx.lineWidth = 3;
      ctx.font = '800 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeText(`${Math.round(power * 100)}%`, x + dx * (len + 16), y + dy * (len + 16) + 4);
      ctx.fillText(`${Math.round(power * 100)}%`, x + dx * (len + 16), y + dy * (len + 16) + 4);
    }
    ctx.restore();
  }

  function updateTimer() {
    const runLeft = retreat ? (retreat.until - serverNow()) / 1000 : 0;
    if (retreat && runLeft <= 0) {
      retreat = null;
      renderHud();
    }
    // Show the bar as active the moment my retreat starts, and inactive when it ends.
    const running = canRetreat();
    if (running !== retreatShown) {
      retreatShown = running;
      renderHud();
    }
    let text = '';
    let mode = '';
    if (retreat && runLeft > 0) {
      text = `🏃 ${Math.ceil(runLeft)}`;
      mode = 'retreat';
    } else if (s && s.phase === 'aiming' && s.turn && !pb) {
      const left = Math.max(0, Math.ceil((s.turn.endsAt - serverNow()) / 1000));
      text = String(left);
      mode = left <= 5 ? 'urgent' : '';
      if (left <= 5 && left > 0 && left !== lastTick && myTurn()) {
        lastTick = left;
        audio.play('tick', { pitch: left <= 2 ? 1.3 : 1 });
      }
    }
    if (timerEl.textContent !== text) timerEl.textContent = text;
    timerEl.classList.toggle('urgent', mode === 'urgent');
    timerEl.classList.toggle('retreat', mode === 'retreat');
  }

  raf = requestAnimationFrame(frame);

  return {
    update(r, m) {
      room = r;
      me = m;
      clockOffset = r.now - Date.now();
      const ns = r.game!.state as ArtState;
      if (pb) {
        pending = ns;
        renderOverlay();
        return;
      }
      applyState(ns);
    },

    event(raw) {
      const e = raw as ArtEvent;
      if (e.type === 'timeline') {
        if (e.replace) replacePlayback(e.tl);
        else {
          startPlayback(e.tl);
          if (e.retreat) {
            // Fresh shot: the shooter might shout something, and gets a "run!" cue.
            if (Math.random() < 0.35) quip(e.retreat.wormId, 'fire');
            const w = wormById(e.retreat.wormId);
            if (w && s!.teams[w.team]?.playerId === me?.id) setTimeout(() => sfx('retreat'), 350);
          }
        }
        retreat = e.retreat ?? null;
        renderHud();
      } else if (e.type === 'pickup') {
        if (s && !pb) {
          s.crates = s.crates.filter((c) => c.id !== e.crate.id);
          crateFx(e, e.wormId, e.crate.kind === 'health' ? 'health' : e.crate.weapon);
        }
      }
      else if (e.type === 'walk') {
        const w = wormById(e.wormId);
        if (w && !pb) {
          w.x = e.x;
          w.y = e.y;
          w.facing = e.facing;
          if (!myTurn() && ++walkCount % 3 === 0) sfx('step', e.x, 0.6);
        }
      } else if (e.type === 'aim') {
        if (s?.turn && !myTurn()) Object.assign(s.turn, { angle: e.angle, power: e.power, weapon: e.weapon });
      }
    },

    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      audio.setWind(null);
    },
  };
};
