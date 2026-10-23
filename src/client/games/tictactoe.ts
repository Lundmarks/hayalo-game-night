import type { Mark, TTTAction, TTTState } from '../../shared/games.ts';
import type { Player, RoomView } from '../../shared/protocol.ts';
import { audio } from '../audio.ts';
import { avatar, esc, type ViewFactory } from '../ui.ts';

export function renderTicTacToe(s: TTTState, room: RoomView, me: Player): string {
  const byId = new Map(room.players.map((p) => [p.id, p]));
  const name = (id: string | null) => (id ? (id === me.id ? 'You' : byId.get(id)?.name ?? 'Someone') : '');
  const mySeat = (['X', 'O'] as const).find((m) => s.seats[m] === me.id);
  const ready = !!(s.seats.X && s.seats.O);
  const myTurn = ready && !s.winner && s.turn === mySeat;

  let status: string;
  if (s.winner === 'draw') status = "It's a draw!";
  else if (s.winner) status = `${esc(name(s.seats[s.winner]))} ${s.seats[s.winner] === me.id ? 'win' : 'wins'}! 🎉`;
  else if (!ready) status = mySeat ? 'Waiting for an opponent…' : 'Take a seat to play';
  else if (myTurn) status = 'Your turn';
  else status = `${esc(name(s.seats[s.turn]))}'s turn`;

  const seat = (m: Mark) => {
    const id = s.seats[m];
    const active = ready && !s.winner && s.turn === m;
    let body: string;
    if (!id) {
      body = mySeat
        ? `<span class="muted">Open seat</span>`
        : `<button class="btn small" data-act='${JSON.stringify({ a: 'sit', mark: m })}'>Sit as ${m}</button>`;
    } else {
      body = `${avatar(byId.get(id))}<span class="seat-name">${esc(name(id))}</span>`;
      if (id === me.id) body += `<button class="link" data-act='{"a":"stand"}'>leave</button>`;
    }
    return `<div class="seat ${active ? 'active' : ''}"><span class="mark mark-${m}">${m}</span>${body}</div>`;
  };

  const cells = s.board
    .map((c, i) => {
      const win = s.winLine?.includes(i) ? 'win' : '';
      const canPlay = myTurn && !c;
      return `<button class="cell ${win} ${c ? `mark-${c}` : ''}" ${canPlay ? `data-act='{"a":"move","cell":${i}}'` : 'disabled'}>${c}</button>`;
    })
    .join('');

  const scores = room.players
    .map((p) => ({ p, w: s.wins[p.id] ?? 0 }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .map(({ p, w }) => `<li>${avatar(p, 20)} ${esc(p.name)} <b>${w}</b></li>`)
    .join('');

  return `
    <div class="ttt">
      <div class="seats">${seat('X')}<span class="vs">vs</span>${seat('O')}</div>
      <p class="status ${myTurn ? 'your-turn' : ''}">${status}</p>
      <div class="board">${cells}</div>
      ${s.winner && mySeat ? `<button class="btn" data-act='{"a":"rematch"}'>Rematch (swap sides)</button>` : ''}
      ${scores || s.draws ? `<ul class="scores">${scores}${s.draws ? `<li class="muted">Draws <b>${s.draws}</b></li>` : ''}</ul>` : ''}
    </div>`;
}

export type { TTTAction };

export const createTicTacToeView: ViewFactory = (el) => {
  let prev: TTTState | null = null;
  return {
    update(room, me) {
      const s = room.game!.state as TTTState;
      if (prev) {
        const placed = s.board.filter(Boolean).length > prev.board.filter(Boolean).length;
        if (placed) audio.play('place', { pitch: s.board.filter(Boolean).length % 2 ? 1 : 1.25 });
        if (s.winner && !prev.winner) {
          const mine = s.winner !== 'draw' && s.seats[s.winner] === me.id;
          const seated = s.seats.X === me.id || s.seats.O === me.id;
          audio.play(s.winner === 'draw' || !seated ? 'turn' : mine ? 'win' : 'lose');
        }
      }
      prev = structuredClone(s);
      el.innerHTML = renderTicTacToe(s, room, me);
    },
  };
};
