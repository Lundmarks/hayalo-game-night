import './style.css';
import { GAMES } from '../shared/games.ts';
import type { Player, RoomView } from '../shared/protocol.ts';
import { audio } from './audio.ts';
import { getIdentity, inDiscord } from './discord.ts';
import { createArtilleryView } from './games/artillery/view.ts';
import { createGeoView } from './games/geoguess.ts';
import { createTicTacToeView } from './games/tictactoe.ts';
import { Connection } from './net.ts';
import { avatar, esc, toast, type GameView, type ViewFactory } from './ui.ts';

const VIEWS: Record<string, ViewFactory> = {
  tictactoe: createTicTacToeView,
  artillery: createArtilleryView,
  geoguess: createGeoView,
};

const app = document.getElementById('app')!;
let conn: Connection | null = null;
let current: { id: string; view: GameView } | null = null;
let shell: { back: HTMLElement; title: HTMLElement; players: HTMLElement; body: HTMLElement } | null = null;

function message(title: string, text: string) {
  shell = null;
  current?.view.destroy?.();
  current = null;
  app.innerHTML = `<div class="center"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p></div>`;
}

// Header and body are built once; only their contents change after that.
function buildShell() {
  app.innerHTML = `
    <header>
      <span class="hdr-back"></span>
      <h1 class="hdr-title"></h1>
      <div class="players hdr-players"></div>
      <div class="sound">
        <button class="icon-btn" data-cmd="mute" title="Mute"></button>
        <input class="vol" type="range" min="0" max="1" step="0.05" aria-label="Volume" />
      </div>
    </header>
    <main></main>`;
  const q = (s: string) => app.querySelector<HTMLElement>(s)!;
  shell = { back: q('.hdr-back'), title: q('.hdr-title'), players: q('.hdr-players'), body: q('main') };

  const vol = q('.vol') as HTMLInputElement;
  const muteBtn = q('[data-cmd="mute"]');
  const sync = () => {
    vol.value = String(audio.muted ? 0 : audio.volume);
    muteBtn.textContent = audio.muted || audio.volume === 0 ? '🔇' : '🔊';
  };
  vol.addEventListener('input', () => audio.setVolume(Number(vol.value)));
  audio.onChange(sync);
  sync();
}

// The launcher is a view like any game.
const createLauncherView: ViewFactory = (el) => ({
  update(room, me) {
    const isHost = room.hostId === me.id;
    const host = room.players.find((p) => p.id === room.hostId);
    const cards = GAMES.map(
      (g) => `
      <button class="card ${g.available ? '' : 'locked'}" ${g.available && isHost ? `data-cmd="pick" data-game="${g.id}"` : 'disabled'}>
        <span class="card-emoji">${g.emoji}</span>
        <span class="card-name">${esc(g.name)}</span>
        <span class="card-players">${esc(g.players)}</span>
        <span class="card-desc">${esc(g.description)}</span>
        ${g.available ? '' : '<span class="badge">Coming soon</span>'}
      </button>`,
    ).join('');
    el.innerHTML = `
      <p class="subtitle">${isHost ? 'Pick a game for everyone' : `Waiting for ${esc(host?.name ?? 'the host')} to pick a game`}</p>
      <div class="cards">${cards}</div>`;
  },
});

function render(room: RoomView, me: Player) {
  if (!shell) buildShell();
  const s = shell!;
  const isHost = room.hostId === me.id;
  const game = room.game && GAMES.find((g) => g.id === room.game!.id);

  s.back.innerHTML = game && isHost ? `<button class="btn ghost small" data-cmd="leave">← Games</button>` : '';
  s.title.textContent = game ? `${game.emoji} ${game.name}` : 'Hayalo Game Night';
  s.players.innerHTML = room.players
    .map((p) => `<span class="player" title="${esc(p.name)}${p.id === room.hostId ? ' (host)' : ''}">${avatar(p, 28)}${p.id === room.hostId ? '<i class="crown">👑</i>' : ''}</span>`)
    .join('');

  const id = room.game?.id ?? 'launcher';
  if (current?.id !== id) {
    current?.view.destroy?.();
    s.body.innerHTML = '';
    s.body.className = '';
    const factory = id === 'launcher' ? createLauncherView : VIEWS[id];
    current = { id, view: factory(s.body, (action) => conn?.send({ t: 'game', action })) };
  }
  current.view.update(room, me);
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd],[data-act]');
  if (!el) return;
  if (el.dataset.cmd === 'mute') return audio.toggleMute();
  if (!conn) return;
  audio.play('click');
  if (el.dataset.act) conn.send({ t: 'game', action: JSON.parse(el.dataset.act) });
  else if (el.dataset.cmd === 'pick') conn.send({ t: 'pickGame', gameId: el.dataset.game! });
  else if (el.dataset.cmd === 'leave') conn.send({ t: 'leaveGame' });
});

async function boot() {
  message('Hayalo Game Night', inDiscord ? 'Logging in with Discord…' : 'Connecting…');
  try {
    const identity = await getIdentity();
    let connected = false;
    conn = new Connection(identity, {
      onRoom: (room, me) => {
        connected = true;
        document.body.classList.remove('offline');
        render(room, me);
      },
      onEvent: (event) => current?.view.event?.(event),
      onError: (msg) => (connected ? toast(msg) : message("Couldn't join", msg)),
      onStatus: (st) => document.body.classList.toggle('offline', st === 'reconnecting' && connected),
    });
  } catch (e) {
    console.error(e);
    message("Couldn't start", (e as Error).message ?? String(e));
  }
}

boot();
