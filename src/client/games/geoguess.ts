import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatKm, RUSH_SECONDS, type GeoState, type LatLon } from '../../shared/geo.ts';
import type { Player, RoomView } from '../../shared/protocol.ts';
import { audio } from '../audio.ts';
import { openExternal } from '../discord.ts';
import { avatar, esc, type ViewFactory } from '../ui.ts';

const COLORS = ['#ff6b8b', '#5ad1ff', '#7cf29a', '#ffb547', '#c08bff', '#ff8a3d', '#4de3c1', '#ff9ee6'];
const colorFor = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

const pinIcon = (color: string, label = '') =>
  L.divIcon({
    className: 'geo-pin-wrap',
    html: `<div class="geo-pin" style="--c:${color}"></div>${label ? `<span class="geo-pin-label">${esc(label)}</span>` : ''}`,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
  });

const answerIcon = L.divIcon({ className: 'geo-pin-wrap', html: '<div class="geo-answer">📍</div>', iconSize: [32, 32], iconAnchor: [16, 30] });

const medal = (i: number) => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;

export const createGeoView: ViewFactory = (root, send) => {
  root.classList.add('full');
  root.innerHTML = `
    <div class="geo">
      <div class="geo-top">
        <div class="geo-round"></div>
        <div class="geo-timer"></div>
        <div class="geo-right"><span class="geo-guessed"></span><span class="geo-host"></span></div>
      </div>
      <div class="geo-stage">
        <div class="geo-photo"><img alt="Where was this photo taken?" draggable="false" /><div class="geo-loading">Loading photo…</div></div>
        <div class="geo-mapbox">
          <div class="geo-map"></div>
          <button class="btn geo-lock" data-geo="lock" disabled>Click the map to drop a pin</button>
        </div>
        <button class="btn geo-maptoggle" data-geo="map">🗺️ Map</button>
        <div class="geo-results" hidden></div>
        <div class="geo-overlay" hidden></div>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const geo = $('.geo');
  const img = $<HTMLImageElement>('.geo-photo img');
  const photoBox = $('.geo-photo');
  const loadingEl = $('.geo-loading');
  const roundEl = $('.geo-round');
  const timerEl = $('.geo-timer');
  const guessedEl = $('.geo-guessed');
  const hostEl = $('.geo-host');
  const lockBtn = $<HTMLButtonElement>('.geo-lock');
  const resultsEl = $('.geo-results');
  const overlay = $('.geo-overlay');
  const mapEl = $('.geo-map');

  let s: GeoState | null = null;
  let room: RoomView | null = null;
  let me: Player | null = null;
  let clockOffset = 0;
  let myGuess: LatLon | null = null;
  let lastTick = -1;

  // ---------- map ----------
  const map = L.map(mapEl, { worldCopyJump: true, minZoom: 1, maxZoom: 18, zoomSnap: 0.5 }).setView([25, 10], 1.5);
  L.tileLayer('/api/geo/tile/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const guessLayer = L.layerGroup().addTo(map);
  const revealLayer = L.layerGroup().addTo(map);
  let myMarker: L.Marker | null = null;

  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(mapEl);

  const locked = () => !!s && !!me && s.guessed.includes(me.id);

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (!s || s.phase !== 'guessing' || locked()) return;
    const ll = e.latlng.wrap();
    myGuess = { lat: ll.lat, lon: ll.lng };
    if (myMarker) myMarker.setLatLng(e.latlng);
    else myMarker = L.marker(e.latlng, { icon: pinIcon(colorFor(me!.id)) }).addTo(guessLayer);
    audio.play('place');
    renderLock();
  });

  function resetMap() {
    guessLayer.clearLayers();
    revealLayer.clearLayers();
    myMarker = null;
    myGuess = null;
    map.setView([25, 10], 1.5, { animate: false });
  }

  function showReveal(st: GeoState) {
    guessLayer.clearLayers();
    revealLayer.clearLayers();
    myMarker = null;
    const a = st.answer!;
    const pts: L.LatLngExpression[] = [[a.lat, a.lon]];
    for (const r of st.results) {
      if (!r.guess) continue;
      // Draw each pin on the copy of the world nearest the answer, so lines don't cross the whole map.
      let lon = r.guess.lon;
      while (lon - a.lon > 180) lon -= 360;
      while (a.lon - lon > 180) lon += 360;
      const ll: L.LatLngExpression = [r.guess.lat, lon];
      const color = colorFor(r.playerId);
      L.polyline([ll, [a.lat, a.lon]], { color, weight: 2, dashArray: '6 6', opacity: 0.9 }).addTo(revealLayer);
      L.marker(ll, { icon: pinIcon(color, r.playerId === me?.id ? 'You' : r.name) }).addTo(revealLayer);
      pts.push(ll);
    }
    L.marker([a.lat, a.lon], { icon: answerIcon, zIndexOffset: 1000 }).addTo(revealLayer);
    // Wait for the map to grow into its reveal size before fitting.
    setTimeout(() => {
      map.invalidateSize();
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 12 });
      else map.setView([a.lat, a.lon], 6);
    }, 350);
  }

  // ---------- photo zoom: click to zoom in where you clicked, move to look around ----------
  let zoomed = false;
  const setOrigin = (e: PointerEvent) => {
    const r = photoBox.getBoundingClientRect();
    img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  };
  photoBox.addEventListener('pointerdown', (e) => {
    if (s?.phase !== 'guessing') return;
    zoomed = !zoomed;
    setOrigin(e);
    photoBox.classList.toggle('zoomed', zoomed);
  });
  photoBox.addEventListener('pointermove', (e) => zoomed && setOrigin(e));

  img.addEventListener('load', () => (loadingEl.hidden = true));
  img.addEventListener('error', () => (loadingEl.textContent = "Couldn't load the photo"));

  // ---------- rendering ----------
  function renderLock() {
    if (!s) return;
    if (locked()) {
      const left = (room?.players.length ?? 0) - s.guessed.length;
      lockBtn.disabled = true;
      lockBtn.textContent = left > 0 ? `Locked in ✓ · waiting for ${left}` : 'Locked in ✓';
    } else {
      lockBtn.disabled = !myGuess;
      lockBtn.textContent = myGuess ? '📌 Lock in guess' : 'Click the map to drop a pin';
    }
  }

  function renderTop() {
    if (!s || !room || !me) return;
    const isHost = room.hostId === me.id;
    roundEl.textContent = s.round ? `Round ${s.round} / ${s.rounds}` : '🌍 Hay, Where?';
    const byId = new Map(room.players.map((p) => [p.id, p]));
    guessedEl.innerHTML =
      s.phase === 'guessing'
        ? `${s.guessed.map((id) => `<span class="player" title="${esc(byId.get(id)?.name ?? '')} locked in">${avatar(byId.get(id), 22)}</span>`).join('')} <span class="muted">${s.guessed.length}/${room.players.length} locked in</span>`
        : '';
    let host = '';
    if (isHost && s.phase === 'guessing') host = `<button class="btn ghost small" data-act='{"a":"skip"}' title="Swap this photo for another">Skip photo</button>`;
    if (isHost && s.phase === 'reveal') host = `<button class="btn small" data-act='{"a":"next"}'>${s.round >= s.rounds ? 'Final results' : 'Next round'} →</button>`;
    if (isHost && s.phase !== 'lobby' && s.phase !== 'over') host += `<button class="btn ghost small" data-act='{"a":"restart"}'>End game</button>`;
    hostEl.innerHTML = host;
  }

  function renderResults() {
    if (!s || s.phase !== 'reveal' || !s.answer) {
      resultsEl.hidden = true;
      return;
    }
    const a = s.answer;
    const rows = s.results
      .map((r, i) => {
        const total = s!.scores[r.playerId]?.total ?? 0;
        const who = r.playerId === me?.id ? 'You' : esc(r.name);
        const detail = r.km === null ? '<span class="muted">no guess</span>' : `${formatKm(r.km)} · ${r.seconds!.toFixed(1)}s`;
        return `<li class="${r.playerId === me?.id ? 'me' : ''}">
          <span class="rank">${medal(i)}</span>
          <i class="dot" style="background:${colorFor(r.playerId)}"></i>
          <span class="who"><b>${who}</b><small>${detail}</small></span>
          <span class="pts"><b>+${r.points + r.bonus}</b>${r.bonus ? `<small>⚡ ${r.bonus} speed</small>` : ''}</span>
          <span class="total" title="Total score">${total}</span>
        </li>`;
      })
      .join('');
    resultsEl.hidden = false;
    resultsEl.innerHTML = `
      <h3>${esc(a.title)}</h3>
      <button class="link geo-credit" data-geo="credit">📷 ${esc(a.author)}${a.license ? ` · ${esc(a.license)}` : ''} · Wikimedia Commons</button>
      <ol class="geo-rows">${rows}</ol>
      <p class="muted geo-next"></p>`;
  }

  function standings() {
    if (!s) return '';
    const list = Object.entries(s.scores).sort((a, b) => b[1].total - a[1].total);
    if (!list.length) return '<p class="muted">Nobody scored.</p>';
    return `<ol class="geo-final">${list
      .map(([id, sc], i) => `<li class="${id === me?.id ? 'me' : ''}"><span class="rank">${medal(i)}</span><i class="dot" style="background:${colorFor(id)}"></i><span class="who">${id === me?.id ? 'You' : esc(sc.name)}</span><b>${sc.total.toLocaleString('en-US')}</b></li>`)
      .join('')}</ol>`;
  }

  function renderOverlay() {
    if (!s || !room || !me) return;
    const isHost = room.hostId === me.id;
    const chips = (key: 'rounds' | 'roundSeconds', values: number[], unit = '') =>
      values.map((n) => `<button class="chip ${s![key] === n ? 'on' : ''}" data-act='${JSON.stringify({ a: 'settings', [key]: n })}'>${n}${unit}</button>`).join('');

    let html = '';
    if (s.phase === 'lobby') {
      html = `
        <h2>🌍 Hay, Where?</h2>
        <p class="muted">A photo from somewhere on Earth. Drop a pin where you think it was taken.
          The closer you are, the more points. Be quick: a fast, close guess earns a speed bonus,
          and once the first player locks in, everyone else has ${RUSH_SECONDS} seconds left.</p>
        ${
          isHost
            ? `<div class="settings">
                <label>Rounds ${chips('rounds', [3, 5, 10])}</label>
                <label>Time ${chips('roundSeconds', [30, 60, 90], 's')}</label>
              </div>
              <button class="btn start" data-act='{"a":"start"}'>Start (${room.players.length} player${room.players.length === 1 ? '' : 's'})</button>`
            : `<p class="muted">${s.rounds} rounds · ${s.roundSeconds}s each<br>Waiting for the host to start…</p>`
        }
        <p class="muted small-print">Photos from Wikimedia Commons. Map © OpenStreetMap contributors.</p>`;
    } else if (s.phase === 'loading') {
      html = s.error
        ? `<h2>Hmm, no photo</h2><p class="muted">${esc(s.error)}</p>${isHost ? `<button class="btn" data-act='{"a":"start"}'>Try again</button>` : '<p class="muted">Waiting for the host…</p>'}`
        : `<div class="geo-spinner">🌍</div><p>Finding somewhere on Earth…</p>`;
    } else if (s.phase === 'over') {
      const top = Object.entries(s.scores).sort((a, b) => b[1].total - a[1].total)[0];
      html = `
        <h2>${top ? `🏆 ${top[0] === me.id ? 'You win!' : `${esc(top[1].name)} wins!`}` : 'Game over'}</h2>
        ${standings()}
        ${isHost ? `<button class="btn" data-act='{"a":"restart"}'>Back to lobby</button>` : '<p class="muted">Waiting for the host…</p>'}`;
    }
    overlay.hidden = !html;
    overlay.innerHTML = html ? `<div class="panel">${html}</div>` : '';
  }

  function applyState(ns: GeoState) {
    const prev = s;
    s = ns;
    geo.className = `geo phase-${s.phase}`;

    const newPhoto = s.photo && s.photo.token !== prev?.photo?.token;
    if (newPhoto) {
      resetMap();
      zoomed = false;
      photoBox.classList.remove('zoomed');
      loadingEl.hidden = false;
      loadingEl.textContent = 'Loading photo…';
      img.src = `/api/geo/img/${s.photo!.token}`;
      lastTick = -1;
      audio.play('yourTurn');
    }
    if (!s.photo) img.removeAttribute('src');

    if (s.phase === 'guessing' && prev?.phase === 'guessing' && s.rushAt && !prev.rushAt && !locked()) audio.play('tick', { pitch: 1.5 });
    if (s.phase === 'reveal' && prev?.phase !== 'reveal') {
      showReveal(s);
      const mineFirst = s.results[0]?.playerId === me?.id && !!s.results[0]?.guess;
      audio.play(mineFirst ? 'win' : 'turn');
    }
    if (s.phase === 'over' && prev?.phase !== 'over') {
      const top = Object.entries(s.scores).sort((a, b) => b[1].total - a[1].total)[0];
      audio.play(top?.[0] === me?.id ? 'win' : 'lose');
    }
    if (s.phase === 'lobby' && prev?.phase !== 'lobby') resetMap();

    renderTop();
    renderLock();
    renderResults();
    renderOverlay();
    updateClock();
  }

  // ---------- clock ----------
  function updateClock() {
    if (!s) return;
    const now = Date.now() + clockOffset;
    if (s.phase === 'guessing') {
      const left = Math.max(0, Math.ceil((s.endsAt - now) / 1000));
      timerEl.textContent = `${s.rushAt ? '⚡ ' : ''}${left}`;
      timerEl.classList.toggle('urgent', left <= 5 || !!s.rushAt);
      if (left <= 5 && left > 0 && left !== lastTick && !locked()) {
        lastTick = left;
        audio.play('tick', { pitch: left <= 2 ? 1.3 : 1 });
      }
    } else {
      timerEl.textContent = '';
      timerEl.classList.remove('urgent');
    }
    const nextEl = resultsEl.querySelector('.geo-next');
    if (nextEl && s.phase === 'reveal' && s.nextAt) {
      const left = Math.max(0, Math.ceil((s.nextAt - now) / 1000));
      nextEl.textContent = `${s.round >= s.rounds ? 'Final results' : 'Next round'} in ${left}s`;
    }
  }
  const clock = window.setInterval(updateClock, 200);

  // ---------- input ----------
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-geo]');
    if (!el) return;
    const cmd = el.dataset.geo;
    if (cmd === 'lock' && myGuess && !locked()) {
      send({ a: 'guess', lat: myGuess.lat, lon: myGuess.lon });
      audio.play('select');
      geo.classList.remove('map-open');
    } else if (cmd === 'map') {
      geo.classList.toggle('map-open');
      setTimeout(() => map.invalidateSize(), 50);
    } else if (cmd === 'credit' && s?.answer) {
      openExternal(s.answer.pageUrl);
    }
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && myGuess && s?.phase === 'guessing' && !locked()) lockBtn.click();
  };
  window.addEventListener('keydown', onKey);

  return {
    update(r, m) {
      room = r;
      me = m;
      clockOffset = r.now - Date.now();
      applyState(r.game!.state as GeoState);
    },
    destroy() {
      clearInterval(clock);
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      map.remove();
    },
  };
};
