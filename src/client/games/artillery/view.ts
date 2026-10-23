import { SAMPLE, FPS, WORM_R } from '../../../shared/artillery/sim.ts';
import { H, Terrain, W, WATER_Y } from '../../../shared/artillery/terrain.ts';
import { WEAPONS, WEAPON_BY_ID, type ArtEvent, type ArtState, type Crater, type ProjKind, type SimEvent, type Timeline, type Track, type WeaponId } from '../../../shared/artillery/types.ts';
import type { Player, RoomView } from '../../../shared/protocol.ts';
import { audio, type Sound } from '../../audio.ts';
import { esc, toast, type ViewFactory } from '../../ui.ts';
import { buildBackdrop, buildTerrainCanvas, carveCanvas, drawGrave, drawProjectile, drawSky, drawWater, drawWorm, Particles } from './render.ts';

type Playback = {
  tl: Timeline;
  t0: number;
  ev: number;
  hp: Map<number, number>;
  alive: Map<number, boolean>;
  wormTracks: Map<number, Track[]>;
  fx: Set<string>; // one-off effects already played (fuse ticks, whistles…)
};

type Floater = { x: number; y: number; text: string; color: string; life: number };

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
      </div>
      <div class="art-stage"><canvas></canvas><div class="art-overlay" hidden></div></div>
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

  let room: RoomView | null = null;
  let me: Player | null = null;
  let s: ArtState | null = null;
  let pending: ArtState | null = null;
  let clockOffset = 0;

  let terrain: Terrain | null = null;
  let terrainCanvas: HTMLCanvasElement | null = null;
  let seed = 0;
  let applied = 0;
  const backdrop = buildBackdrop();

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
    if (terrainCanvas) carveCanvas(terrainCanvas, c[0], c[1], c[2]);
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

    const turnChanged = s.turn && s.turn.no !== prev?.turn?.no;
    if (turnChanged && s.phase === 'aiming') {
      if (myTurn()) {
        sfx('yourTurn');
        aim = { angle: s.turn!.angle, power: s.turn!.power };
        weapon = 'bazooka';
        target = null;
      } else {
        sfx('turn');
      }
      lastTick = -1;
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
    const wormTracks = new Map<number, Track[]>();
    for (const tr of tl.tracks) {
      if (tr.kind !== 'worm') continue;
      const list = wormTracks.get(tr.wormId!) ?? [];
      list.push(tr);
      wormTracks.set(tr.wormId!, list);
    }
    pb = {
      tl,
      t0: performance.now(),
      ev: 0,
      hp: new Map(tl.before.map((w) => [w.id, w.hp])),
      alive: new Map(tl.before.map((w) => [w.id, w.alive])),
      wormTracks,
      fx: new Set(),
    };
    pointerAiming = false;
    renderHud();
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

  function handleEvent(e: SimEvent) {
    const p = pb!;
    switch (e.type) {
      case 'fire':
        sfx(e.kind === 'grenade' || e.kind === 'haybomb' ? 'throw' : e.kind === 'shotgun' ? 'click' : 'launch', e.x);
        break;
      case 'explode':
        if (e.crater === applied) applyCrater([e.x, e.y, e.r!]);
        parts.explosion(e.x, e.y, e.r!);
        shake = Math.min(18, shake + e.r! / 4);
        sfx(e.r! >= 60 ? 'bigExplosion' : e.r! >= 24 ? 'explosion' : 'smallExplosion', e.x);
        break;
      case 'bounce':
        sfx('bounce', e.x, 0.8);
        break;
      case 'splash':
        parts.splash(e.x, e.y);
        sfx('splash', e.x);
        break;
      case 'damage': {
        p.hp.set(e.wormId!, Math.max(0, (p.hp.get(e.wormId!) ?? 0) - e.amount!));
        const w = wormById(e.wormId!);
        const [x, y] = wormPos(e.wormId!, (performance.now() - p.t0) / 1000 * FPS);
        floaters.push({ x, y: y - 20, text: `-${e.amount}`, color: w ? s!.teams[w.team].color : '#fff', life: 0 });
        sfx('hurt', x, 0.9);
        break;
      }
      case 'die':
        p.alive.set(e.wormId!, false);
        if (e.kind !== 'drown') parts.explosion(e.x, e.y, 10);
        sfx('die', e.x);
        break;
      case 'shot':
        parts.tracer(e.x, e.y, e.x2!, e.y2!);
        sfx('shotgun', e.x);
        break;
      case 'airstrike':
        sfx('plane', e.x);
        break;
      case 'teleport':
        parts.sparkle(e.x, e.y);
        parts.sparkle(e.x2!, e.y2!);
        sfx('teleport', e.x2);
        break;
      case 'jump':
        sfx('jump', e.x);
        break;
      case 'land':
        if ((e.amount ?? 0) > 200) sfx('land', e.x, Math.min(1, (e.amount ?? 0) / 500));
        break;
    }
  }

  function stepPlayback(f: number) {
    const p = pb!;
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
    if (f >= p.tl.frames) finishPlayback();
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

    const active = canAct();
    barEl.classList.toggle('inactive', !active);
    const wp = WEAPON_BY_ID[weapon];
    hintEl.textContent = active
      ? `${wp.icon} ${wp.name}: ${wp.hint}  ·  ${wp.aim === 'target' ? 'Tap the map to target' : 'Drag to aim (distance = power)'} · Space fire · ←/→ walk · J jump · W/S angle · Q/E power`
      : s.phase === 'aiming' && team && !myTurn()
        ? `Watching ${team.name}…`
        : '';
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
                </div>
                <button class="btn start" data-art="start" ${s.teams.length ? '' : 'disabled'}>${s.teams.length === 1 ? 'Start solo practice' : 'Start match'}</button>`
              : `<p class="muted">Worms each: ${s.wormsPerTeam} · Turn time: ${s.turnSeconds}s<br>Waiting for the host to start…</p>`
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
      target = { x: Math.round(pt.x), y: Math.round(pt.y) };
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
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-art],[data-weapon],[data-fire],[data-jump]');
    if (!el) return;
    if (el.dataset.weapon) return selectWeapon(el.dataset.weapon as WeaponId);
    if (el.dataset.fire !== undefined) return fire();
    if (el.dataset.jump !== undefined) return canAct() && send({ a: 'jump' });
    const cmd = el.dataset.art!;
    sfx('click');
    if (cmd.startsWith('wpt:')) send({ a: 'settings', wormsPerTeam: Number(cmd.slice(4)) });
    else if (cmd.startsWith('secs:')) send({ a: 'settings', turnSeconds: Number(cmd.slice(5)) });
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
    else if (k === 'j' && canAct()) send({ a: 'jump' });
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
    if (!canAct()) return;
    const kdir = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0);
    const dir = (walkBtn || kdir) as 0 | 1 | -1;
    if (dir && now - lastWalk > 50) {
      lastWalk = now;
      send({ a: 'walk', dir });
      // Turning around mirrors the aim.
      if (facingOf(aim.angle) !== dir) aim.angle = normAngle(Math.PI - aim.angle);
      if (s!.turn!.walkLeft > 0 && ++walkCount % 3 === 0) sfx('step', wormPos(s!.turn!.wormId, 0)[0]);
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
    drawSky(ctx, cw, ch);

    shake *= Math.pow(0.02, dt);
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
    ctx.drawImage(backdrop, 0, 0);
    if (terrainCanvas) ctx.drawImage(terrainCanvas, 0, 0);

    const labels: { x: number; y: number; name: string; hp: number; color: string }[] = [];
    if (s && s.phase !== 'lobby') {
      // Worms (and graves)
      for (const w of s.worms) {
        const alive = pb ? pb.alive.get(w.id) ?? w.alive : w.alive;
        let [x, y] = wormPos(w.id, f);
        if (!pb && alive) {
          const d = disp.get(w.id);
          if (d) {
            d.x += (w.x - d.x) * Math.min(1, dt * 18);
            d.y += (w.y - d.y) * Math.min(1, dt * 18);
            [x, y] = [d.x, d.y];
          }
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
        drawWorm(ctx, x, y, team.color, facing, time, active);
        const hp = pb ? pb.hp.get(w.id) ?? w.hp : w.hp;
        labels.push({ x, y, name: w.name, hp, color: team.color });

        if (active && !pb) {
          // Bouncing marker
          const by = y - 34 + Math.sin(time * 5) * 3;
          ctx.fillStyle = team.color;
          ctx.beginPath();
          ctx.moveTo(x - 5, by - 6);
          ctx.lineTo(x + 5, by - 6);
          ctx.lineTo(x, by);
          ctx.fill();
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
    }

    parts.draw(ctx);
    drawWater(ctx, time, (ch - oy) / scale + 10);

    // Screen-space text so it stays crisp at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.font = '600 11px system-ui, sans-serif';
    for (const l of labels) {
      const lx = ox + l.x * scale;
      const ly = oy + (l.y - WORM_R) * scale - 8;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = l.color;
      ctx.strokeText(`${l.hp}`, lx, ly);
      ctx.fillText(`${l.hp}`, lx, ly);
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeText(l.name, lx, ly - 12);
      ctx.fillText(l.name, lx, ly - 12);
      ctx.font = '600 11px system-ui, sans-serif';
    }
    ctx.font = '800 15px system-ui, sans-serif';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const fl = floaters[i];
      fl.life += dt;
      if (fl.life > 1.3) {
        floaters.splice(i, 1);
        continue;
      }
      const a = Math.min(1, (1.3 - fl.life) * 2);
      ctx.globalAlpha = a;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = fl.color;
      const fx = ox + fl.x * scale;
      const fy = oy + fl.y * scale - fl.life * 30;
      ctx.strokeText(fl.text, fx, fy);
      ctx.fillText(fl.text, fx, fy);
      ctx.globalAlpha = 1;
    }

    updateTimer();
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
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
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
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(power * 100)}%`, x + dx * (len + 16), y + dy * (len + 16) + 4);
    }
    ctx.restore();
  }

  function updateTimer() {
    if (!s || s.phase !== 'aiming' || !s.turn || pb) {
      if (timerEl.textContent) timerEl.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((s.turn.endsAt - (Date.now() + clockOffset)) / 1000));
    const text = String(left);
    if (timerEl.textContent !== text) {
      timerEl.textContent = text;
      timerEl.classList.toggle('urgent', left <= 5);
      if (left <= 5 && left > 0 && left !== lastTick && myTurn()) {
        lastTick = left;
        audio.play('tick', { pitch: left <= 2 ? 1.3 : 1 });
      }
    }
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
      if (e.type === 'timeline') startPlayback(e.tl);
      else if (e.type === 'walk') {
        const w = wormById(e.wormId);
        if (w && !pb) {
          w.x = e.x;
          w.y = e.y;
          w.facing = e.facing;
          if (s?.turn) s.turn.walkLeft = e.walkLeft;
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
