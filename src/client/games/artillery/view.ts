import { clearSpot, FLOOD_FRAMES, frameAt, killCam, SAMPLE, FPS, WORM_R } from '../../../shared/artillery/sim.ts';
import { H, mapInfo, SHAPE_NAMES, Terrain, THEME_NAMES, W, WATER_Y, type ThemeId } from '../../../shared/artillery/terrain.ts';
import { partyOf, QUIPS, SWEDISH } from '../../../shared/artillery/politicians.ts';
import { CRATE_HEALTH, RETREAT_SECONDS, WEAPONS, WEAPON_BY_ID, type ArtEvent, type ArtState, type Crate, type Crater, type ProjKind, type SimEvent, type Timeline, type Track, type WeaponId } from '../../../shared/artillery/types.ts';
import type { Player, RoomView } from '../../../shared/protocol.ts';
import { audio, type Sound } from '../../audio.ts';
import { esc, toast, type ViewFactory } from '../../ui.ts';
import { buildBackdrop, buildTerrainCanvas, drawBackdrop, carveCanvas, drawBird, drawBubble, drawCloud, drawCrate, drawGrave, drawPlane, drawProjectile, drawSky, drawSun, drawWater, drawWorm, PALETTES, Particles, weaponIcon } from './render.ts';

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
  kc: ReturnType<typeof killCam>; // the slow-motion moment, if someone dies
  shooter: number | null; // worm that fired this shot (null for jumps, floods…)
};

// Things the player aims and throws (for the last-shot trail).
const PROJECTILES = new Set(['rocket', 'grenade', 'cluster', 'haybomb', 'banana', 'syringe', 'sheep', 'rose', 'can', 'duck']);
const FUSED = new Set(['grenade', 'haybomb', 'banana']);

// Little drawn icons for the end screen (emoji don't render everywhere).
const SVG = {
  trophy: `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M9 4h14v7a7 7 0 0 1-14 0z" fill="#ffd23f" stroke="#2b1d33" stroke-width="2"/><path d="M9 7H4c0 5 2 7 5 7M23 7h5c0 5-2 7-5 7" fill="none" stroke="#2b1d33" stroke-width="2"/><path d="M14 18h4v5h-4zM10 23h12v5H10z" fill="#ffd23f" stroke="#2b1d33" stroke-width="2"/></svg>`,
  star: `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><path d="M16 3l3.8 8 8.7 1-6.4 6 1.7 8.6L16 22.3 8.2 26.6 9.9 18 3.5 12l8.7-1z" fill="#ffe14d" stroke="#2b1d33" stroke-width="2" stroke-linejoin="round"/></svg>`,
  laugh: `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="#ffb547" stroke="#2b1d33" stroke-width="2"/><path d="M9 12l4 2-4 2M23 12l-4 2 4 2" fill="none" stroke="#2b1d33" stroke-width="2" stroke-linecap="round"/><path d="M9 19h14a7 7 0 0 1-14 0z" fill="#5a1020" stroke="#2b1d33" stroke-width="2"/><circle cx="7" cy="13" r="1.6" fill="#7fe3ff"/><circle cx="25" cy="13" r="1.6" fill="#7fe3ff"/></svg>`,
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
  [['1', '–', '0'], 'Weapon'],
  [['[', ']'], 'Next weapon'],
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
  let zoom = 1;
  let bars = 0; // cinematic letterbox during the kill cam
  let turnCard: { title: string; sub: string; color: string; t0: number } | null = null;
  let lastShot: number[] | null = null; // where my team's last shot flew, as x,y pairs
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
  // Visible world x range this frame (wide screens see past the map's edges).
  let visX0 = 0;
  let visX1 = W;
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
        lastShot = null;
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
      const tw = wormById(wid);
      const tt = s.teams[s.turn!.team];
      if (tw && tt) {
        // Wait for the map title card on the first turn.
        const t0 = banner ? banner.t0 + 3300 : performance.now();
        turnCard = myTurn()
          ? { title: `Your turn, ${tw.name}!`, sub: 'Go get them', color: tt.color, t0 }
          : { title: `${tw.name}'s turn`, sub: tt.name, color: tt.color, t0 };
      }
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
      kc: killCam(tl),
      shooter: null,
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
    p.kc = killCam(tl);
    p.ev = 0;
    while (p.ev < tl.events.length && tl.events[p.ev].f <= p.lastF) book(tl.events[p.ev++]);
  }

  function finishPlayback() {
    if (!pb) return;
    rememberShot(pb);
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
      case 'heal':
        p.hp.set(e.wormId!, (p.hp.get(e.wormId!) ?? 0) + e.amount!);
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
    floaters.push({ x: c.x, y: c.y - 16, text: health ? `+${CRATE_HEALTH}` : `+1 ${wp?.name ?? 'weapon'}`, color: health ? '#7cf29a' : '#ffe14d', life: 0, size: 16, rot: 0 });
    quip(wormId, health ? 'pickupHealth' : 'pickupWeapon');
  }

  /** Playback frame at time `now` (the kill cam plays slower). */
  const pbFrame = (now: number) => frameAt(pb!.kc, (now - pb!.t0) / 1000);
  const nowF = () => pbFrame(performance.now());

  /** Keep the path of my team's shot, to show faintly on our next turn. */
  function rememberShot(p: Playback) {
    const w = p.shooter === null ? undefined : wormById(p.shooter);
    if (!w || !s || s.teams[w.team]?.playerId !== me?.id) return;
    const tr = p.tl.tracks.find((t) => PROJECTILES.has(t.kind));
    const shot = p.tl.events.find((e) => e.type === 'shot');
    if (tr) lastShot = tr.pts;
    else if (shot) lastShot = [shot.x, shot.y, shot.x2!, shot.y2!];
  }

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
        if (e.kind === 'sheep') {
          sfx('baa', e.x);
          break;
        }
        if (e.kind === 'house') {
          sfx('whistle', e.x);
          break;
        }
        if (['grenade', 'haybomb', 'cluster', 'banana', 'duck', 'can', 'syringe', 'rose'].includes(e.kind!)) sfx('throw', e.x);
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
          comic(e.x, e.y - r * 0.6, 'HAYALO!', 34, '#fff59a');
          setTimeout(() => sfx('hayalo', e.x), 90);
        } else if (e.kind === 'house') {
          parts.confetti(e.x, e.y, ['#b5322b', '#ffffff', '#3d3540', '#9fd8ff'], 30);
          comic(e.x, e.y - r * 0.6, 'FOLKHEMMET!', 26, '#ff8a80');
          sfx('crash', e.x);
        } else if (e.kind === 'rose' || e.kind === 'petal') {
          parts.confetti(e.x, e.y, ['#e8213a', '#c4162a', '#ff5a6e', '#4fae3a'], e.kind === 'rose' ? 26 : 8);
          if (e.kind === 'rose') comic(e.x, e.y - r * 0.6, 'FÖR SOLIDARITET!', 18, '#ff6b8b');
        } else if (e.kind === 'duck') {
          comic(e.x, e.y - r * 0.6, 'QUACK-BOOM!', 22);
          sfx('quack', e.x);
        } else if (e.kind === 'banana' || e.kind === 'minibanana') {
          parts.confetti(e.x, e.y, ['#ffe14d', '#fff3a0', '#6b4a1c'], 10);
          comic(e.x, e.y - r * 0.6, pick(['BANANAS!', 'SPLAT!', 'POTASSIUM!']), e.kind === 'banana' ? 22 : 15);
        } else if (e.kind === 'zap') {
          // The lightning already said it all.
        } else if (r >= 16) {
          comic(e.x, e.y - r * 0.5, pick(r >= 60 ? BOOM_WORDS.big : r >= 28 ? BOOM_WORDS.mid : BOOM_WORDS.small), r >= 28 ? 24 : 17);
        }
        sfx(r >= 60 ? 'bigExplosion' : r >= 24 ? 'explosion' : 'smallExplosion', e.x);
        break;
      }
      case 'bounce':
        if (e.wormId !== undefined) {
          // Bonked a worm on the head (or hit it for six).
          const bat = e.kind === 'bat';
          parts.stars(e.x, e.y, bat ? 9 : 4);
          comic(e.x, e.y - 10, bat ? pick(['HOME RUN!', 'BONK!', 'OUT OF THE PARK!']) : 'BONK!', bat ? 22 : 14, bat ? '#ffe14d' : '#ffffff');
          sfx('bonk', e.x);
          if (bat) shake = Math.min(22, shake + 8);
          hurtAt.set(e.wormId, performance.now() - 300);
        } else {
          parts.dust(e.x, e.y, 3, 0.6);
          sfx(e.kind === 'duck' ? 'squeak' : e.kind === 'haybomb' || e.kind === 'banana' || e.kind === 'minibanana' ? 'boing' : 'bounce', e.x, 0.8);
        }
        break;
      case 'splash':
        parts.splash(e.x, e.y);
        sfx('splash', e.x);
        if (e.kind === 'sheep') sfx('baa', e.x, 0.7);
        break;
      case 'heal': {
        const [x, y] = wormPos(e.wormId!, nowF());
        floaters.push({ x, y: y - 20, text: `+${e.amount}`, color: '#7cf29a', life: 0, size: 18, rot: 0 });
        parts.sparkle(x, y);
        renderTeams();
        break;
      }
      case 'melee': {
        parts.swish(e.x, e.y, Math.atan2(e.y2! - e.y, e.x2! - e.x));
        sfx('bat', e.x);
        break;
      }
      case 'cloud':
        parts.cloud(e.x, e.y, e.r!, e.kind === 'medic' ? 'medic' : 'stink');
        if (e.kind === 'medic') {
          sfx('syringe', e.x);
          setTimeout(() => sfx('heal', e.x), 150);
          comic(e.x, e.y - 30, "DOCTOR'S ORDERS!", 18, '#ff8fb1');
        } else {
          sfx('stink', e.x);
          comic(e.x, e.y - 30, pick(['PEW!', 'STINKY!', 'FY FAN!']), 22, '#b8e070');
        }
        break;
      case 'zap':
        parts.bolt(e.x, e.y);
        flash = Math.max(flash, 0.3);
        shake = Math.min(22, shake + 6);
        sfx('zap', e.x);
        break;
      case 'ping':
        comic(e.x, e.y - 34, '@everyone', 26, '#8c96ff');
        sfx('ping', e.x);
        if (e.wormId !== undefined) say(e.wormId, 'Hayalo, ping them all!');
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
        sfx(e.kind === 'sheep' ? 'baa' : 'jump', e.x, e.kind === 'sheep' ? 0.6 : 1);
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
    if (p.kc && f >= p.kc.start && !p.fx.has('kc')) {
      p.fx.add('kc');
      sfx('slowmo', p.kc.x);
    }
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
      if (FUSED.has(tr.kind)) {
        const sec = Math.floor((f - tr.start) / FPS);
        const k = `${tr.key}:${sec}`;
        if (!p.fx.has(k)) {
          p.fx.add(k);
          sfx('fuse', x);
        }
        // The Holy Hay Bomb: a cheeky "truddelutt", then the choir swells into the blast.
        if (tr.kind === 'haybomb' && tr.end - f < 160 && !p.fx.has(tr.key + 'toot')) {
          p.fx.add(tr.key + 'toot');
          sfx('truddelutt', x);
        }
        if (tr.kind === 'haybomb' && tr.end - f < 112 && !p.fx.has(tr.key + 'holy')) {
          p.fx.add(tr.key + 'holy');
          sfx('holy', x);
        }
      }
      if (tr.kind === 'sheep') {
        const k = `${tr.key}:baa${Math.floor((f - tr.start) / (FPS * 1.6))}`;
        if (!p.fx.has(k)) {
          p.fx.add(k);
          if (f > tr.start + 20) sfx('baa', x, 0.45);
        }
      }
      if (tr.kind === 'duck') {
        const k = `${tr.key}:q${Math.floor((f - tr.start) / (FPS * 1.2))}`;
        if (!p.fx.has(k)) {
          p.fx.add(k);
          sfx('quack', x, 0.5);
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
      return `<button class="wpn ${wp.id === weapon ? 'sel' : ''}" data-weapon="${wp.id}" ${out ? 'disabled' : ''} title="${esc(`${wp.name}${i < 10 ? ` (${(i + 1) % 10})` : ''}: ${wp.hint}`)}">
        <img src="${weaponIcon(wp.id)}" alt="${esc(wp.name)}" draggable="false">${left >= 0 ? `<i>${left}</i>` : ''}</button>`;
    }).join('');

    weaponsEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
        ? `${wp.name}: ${wp.hint}  ·  ${wp.aim === 'target' ? 'Tap the map to target' : wp.aim === 'none' ? 'Just press FIRE' : 'Drag to aim (distance = power)'}`
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
      overlay.hidden = false;
      overlay.innerHTML = endScreen(isHost);
    } else {
      overlay.hidden = true;
      overlay.innerHTML = '';
    }
  }

  /** Winner, a scoreboard, and a few awards from the match stats. */
  function endScreen(isHost: boolean) {
    const st = s!.stats;
    const winner = s!.winner !== null ? s!.teams[s!.winner] : null;
    const worm = (id: number | null) => (id === null ? undefined : wormById(id));
    const wname = (id: number | null) => esc(worm(id)?.name ?? 'Someone');
    const tname = (id: number | null) => {
      const w = worm(id);
      return w ? esc(s!.teams[w.team]?.name ?? '') : '';
    };
    const aWeapon = (id?: WeaponId) => esc(WEAPON_BY_ID[id ?? 'bazooka']?.phrase ?? 'a bazooka');

    // Scoreboard: winner first, then by damage dealt.
    const order = s!.teams.map((_, i) => i).sort((a, b) => (b === s!.winner ? 1 : 0) - (a === s!.winner ? 1 : 0) || (st.damage[b] ?? 0) - (st.damage[a] ?? 0));
    const rows = order
      .map((i) => {
        const t = s!.teams[i];
        const left = s!.worms.filter((w) => w.team === i && w.alive).length;
        return `<tr class="${i === s!.winner ? 'win' : ''} ${t.playerId === me?.id ? 'me' : ''}">
          <td><span class="who"><i class="dot" style="background:${t.color}"></i>${esc(t.name)}</span></td>
          <td>${st.damage[i] ?? 0}</td><td>${st.kills[i] ?? 0}</td><td>${left}/${s!.wormsPerTeam}</td></tr>`;
      })
      .join('');

    const awards: { icon: string; title: string; text: string; sub: string }[] = [];
    const mvp = Object.entries(st.wormDamage).sort((a, b) => b[1] - a[1])[0];
    if (mvp && mvp[1] > 0) {
      const id = Number(mvp[0]);
      awards.push({ icon: SVG.star, title: 'MVP', text: wname(id), sub: `${mvp[1]} damage · ${tname(id)}` });
    }
    if (st.best) {
      const b = st.best;
      awards.push({
        icon: `<img src="${weaponIcon(b.weapon)}" alt="">`,
        title: 'Best shot',
        text: `${wname(b.wormId)}'s ${esc(WEAPON_BY_ID[b.weapon].name)}`,
        sub: `${b.damage} damage${b.kills ? ` · ${b.kills} knocked out` : ''}`,
      });
    }
    // The silliest way anyone went out.
    const rank = (d: (typeof st.deaths)[number]) => {
      const v = worm(d.wormId);
      const k = worm(d.by);
      if (d.by === d.wormId && d.how === 'blast') return 6;
      if (k && v && k.team === v.team && d.by !== d.wormId) return 5;
      if (d.by === d.wormId) return 4;
      if (d.how === 'flood') return 3;
      return d.how === 'drown' ? 2 : 1;
    };
    const funny = [...st.deaths].sort((a, b) => rank(b) - rank(a))[0];
    if (funny) {
      const v = wname(funny.wormId);
      const k = wname(funny.by);
      const self = funny.by === funny.wormId;
      const text =
        self && funny.how === 'blast' ? `${v} scored an own goal with ${aWeapon(funny.weapon)}`
        : rank(funny) === 5 ? `${k} took out teammate ${v}`
        : self && funny.how === 'drown' ? (funny.weapon ? `${v} blew themselves into the sea` : `${v} walked into the sea`)
        : self ? `${v} tripped off a cliff`
        : funny.how === 'flood' ? `${v} was swallowed by the rising sea`
        : funny.how === 'drown' ? `${k} sent ${v} for a swim`
        : `${k} blasted ${v} with ${aWeapon(funny.weapon)}`;
      awards.push({ icon: SVG.laugh, title: 'Funniest exit', text, sub: `${st.deaths.length} worm${st.deaths.length === 1 ? '' : 's'} down in total` });
    }

    return `
      <div class="panel end">
        <h2 class="end-title">${winner ? `${SVG.trophy}${esc(winner.name)} wins!` : s!.solo ? 'Practice over' : 'Everyone is down. Draw!'}</h2>
        ${awards.length ? `<div class="awards">${awards.map((a) => `<div class="award"><span class="aicon">${a.icon}</span><div><small>${a.title}</small><b>${a.text}</b><span>${a.sub}</span></div></div>`).join('')}</div>` : ''}
        <table class="art-scores"><thead><tr><th>Team</th><th>Damage</th><th>KOs</th><th>Left</th></tr></thead><tbody>${rows}</tbody></table>
        ${isHost ? `<button class="btn" data-art="restart">Back to lobby</button>` : '<p class="muted">Waiting for the host…</p>'}
      </div>`;
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

  /** Step to the next (or previous) weapon that still has ammo. */
  function cycleWeapon(step: 1 | -1) {
    if (!s) return;
    const mine = myTeamIdx();
    const n = WEAPONS.length;
    let i = WEAPONS.findIndex((w) => w.id === weapon);
    for (let k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (mine < 0 || s.teams[mine].ammo[WEAPONS[i].id] !== 0) return selectWeapon(WEAPONS[i].id);
    }
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
    else if (/^[0-9]$/.test(k)) selectWeapon(WEAPONS[(Number(k) + 9) % 10].id);
    else if (k === '[' || k === ']') cycleWeapon(k === ']' ? 1 : -1);
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
  function updateCamera(f: number, dt: number, now: number) {
    const { cw, ch } = view;
    const fit = Math.min(cw / W, ch / H);
    const base = fit * H < ch * 0.7 ? Math.min((ch * 0.7) / H, fit * 2.2) : fit;
    let focus = focusPoint(f);
    // Zoom in on the kill, and briefly on the worm whose turn just started.
    let zt = 1;
    const kc = pb?.kc;
    const killing = !!kc && f >= kc.start - 4 && f <= kc.end + 8;
    if (killing) {
      zt = 1.8;
      focus = [kc!.x, kc!.y];
    } else if (turnCard && !pb && now >= turnCard.t0 && now - turnCard.t0 < 1300) zt = 1.35;
    zoom += (zt - zoom) * Math.min(1, dt * (zt > zoom ? 6 : 2.5));
    bars += ((killing ? 1 : 0) - bars) * Math.min(1, dt * 8);
    // Keep the kill cam clean.
    keysEl.style.opacity = bars > 0.05 ? '0' : '';
    const scale = base * zoom;
    if (focus) {
      const k = Math.min(1, dt * (killing ? 9 : pb ? 6 : 3));
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
    visX0 = -ox / scale;
    visX1 = (cw - ox) / scale;
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

    const f = pb ? pbFrame(now) : 0;
    if (pb) stepPlayback(f);
    // Particles slow down with the kill cam too.
    const slow = pb?.kc && f >= pb.kc.start && f <= pb.kc.end ? 0.3 : 1;
    parts.update(dt * slow);
    updateCamera(f, dt, now);

    const { scale, ox, oy, cw, ch, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSky(ctx, cw, ch, pal);

    shake *= Math.pow(0.02, dt);
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
    drawSun(ctx, time, pal);
    drawSkyLife(dt, now, time);
    drawBackdrop(ctx, backdrop, visX0 - 20, visX1 + 20);
    if (terrainCanvas) ctx.drawImage(terrainCanvas, 0, 0);

    const labels: { id: number; x: number; y: number; name: string; hp: number; color: string }[] = [];
    const graves: { x: number; y: number; name: string }[] = [];
    if (s && s.phase !== 'lobby') {
      const focus = focusPoint(f);
      drawCrates(f, time);
      if (lastShot && canAct()) drawLastShot(lastShot, time);
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
          if (y < waterAt(f) - 4) {
            drawGrave(ctx, x, y);
            graves.push({ x, y, name: w.name });
          }
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
    drawWater(ctx, time, (ch - oy) / scale + 10, pal, level, visX0 - 20, visX1 + 20);
    if (pal.weather === 'snow') drawSnow(dt, time);

    // Screen-space text so it stays crisp at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    // Worms standing close together would have their labels on top of each
    // other, so stack the later ones upwards.
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(26,19,37,0.6)';
    ctx.fillStyle = 'rgba(235,235,245,0.8)';
    for (const g of graves) {
      // A living worm's label wins if they're standing on the grave.
      if (labels.some((l) => Math.abs(l.x - g.x) < 60 && Math.abs(l.y - g.y) < 40)) continue;
      const gx = ox + g.x * scale;
      const gy = oy + (g.y - 12) * scale - 4;
      ctx.strokeText(g.name, gx, gy);
      ctx.fillText(g.name, gx, gy);
    }
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
    if (bars > 0.01) {
      const bh = ch * 0.09 * bars;
      ctx.fillStyle = '#0b0714';
      ctx.fillRect(0, 0, cw, bh);
      ctx.fillRect(0, ch - bh, cw, bh);
      ctx.globalAlpha = bars;
      ctx.font = '900 13px "Comic Sans MS", "Chalkboard SE", "Comic Neue", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffe14d';
      ctx.fillText('SLOW-MO', 14, ch - bh / 2 + 5);
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;
    }
    if (banner) drawBanner(now, cw, ch);
    if (turnCard) drawTurnCard(now, cw);

    updateTimer();
  }

  /** Faint dotted path of my team's previous shot. */
  function drawLastShot(pts: number[], time: number) {
    ctx.save();
    const n = pts.length / 2;
    const step = n > 4 ? 3 : 1;
    for (let i = 0; i < n; i += step) {
      ctx.globalAlpha = 0.35 + 0.15 * Math.sin(time * 3 - i * 0.3);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(43,29,51,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pts[i * 2], pts[i * 2 + 1], 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const ex = pts[(n - 1) * 2];
    const ey = pts[(n - 1) * 2 + 1];
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ex - 5, ey - 5);
    ctx.lineTo(ex + 5, ey + 5);
    ctx.moveTo(ex + 5, ey - 5);
    ctx.lineTo(ex - 5, ey + 5);
    ctx.stroke();
    ctx.restore();
  }

  /** "Stalin's turn" card that slides in at the start of each turn. */
  function drawTurnCard(now: number, cw: number) {
    const c = turnCard!;
    const t = (now - c.t0) / 1000;
    if (t < 0) return;
    if (t > 1.9) {
      turnCard = null;
      return;
    }
    const slide = t < 0.25 ? 1 - t / 0.25 : 0;
    const ease = slide * slide;
    ctx.save();
    ctx.globalAlpha = Math.min(1, (1.9 - t) * 3);
    ctx.translate(cw / 2 - ease * (cw / 2 + 200), 54);
    ctx.font = '900 20px "Comic Sans MS", "Chalkboard SE", "Comic Neue", system-ui, sans-serif';
    const w = Math.max(ctx.measureText(c.title).width, 120) + 40;
    ctx.fillStyle = 'rgba(26, 19, 37, 0.88)';
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -24, w, 48, 14);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = c.color;
    ctx.fillText(c.title, 0, 2);
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(c.sub, 0, 17);
    ctx.restore();
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
      const lo = Math.min(0, visX0) - 120;
      const hi = Math.max(W, visX1) + 120;
      if (c.x > hi) c.x = lo;
      if (c.x < lo) c.x = hi;
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
      const lo = Math.min(0, visX0) - 10;
      const hi = Math.max(W, visX1) + 10;
      if (fl.x > hi) fl.x = lo;
      if (fl.x < lo) fl.x = hi;
      ctx.moveTo(fl.x + fl.s, fl.y);
      ctx.arc(fl.x, fl.y, fl.s, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function drawAim(x: number, y: number, color: string, time: number) {
    if (!s?.turn) return;
    const mine = myTurn();
    const wp = WEAPON_BY_ID[mine ? weapon : s.turn.weapon];
    if (wp.aim === 'none') return;
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
          pb!.shooter = e.retreat?.wormId ?? null;
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
