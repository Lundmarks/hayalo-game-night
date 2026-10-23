import type { Mark, TTTState } from '../../shared/games.ts';
import type { GameModule } from './module.ts';

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const isMark = (m: unknown): m is Mark => m === 'X' || m === 'O';

function resetBoard(s: TTTState) {
  s.board = Array(9).fill('');
  s.turn = 'X';
  s.winner = null;
  s.winLine = null;
}

function inProgress(s: TTTState) {
  return s.winner === null && s.board.some((c) => c !== '');
}

function freeSeat(s: TTTState, playerId: string) {
  let freed = false;
  for (const m of ['X', 'O'] as const) {
    if (s.seats[m] === playerId) {
      s.seats[m] = null;
      freed = true;
    }
  }
  // Abandoning a game in progress wipes the board.
  if (freed && inProgress(s)) resetBoard(s);
}

export const ticTacToe: GameModule<TTTState> = {
  id: 'tictactoe',

  create: () => ({
    board: Array(9).fill(''),
    seats: { X: null, O: null },
    turn: 'X',
    winner: null,
    winLine: null,
    wins: {},
    draws: 0,
  }),

  action(s, playerId, raw) {
    const a = raw as { a?: unknown; mark?: unknown; cell?: unknown };

    switch (a?.a) {
      case 'sit': {
        if (!isMark(a.mark)) return 'Bad seat';
        if (s.seats.X === playerId || s.seats.O === playerId) return 'You are already seated';
        if (s.seats[a.mark]) return 'That seat is taken';
        s.seats[a.mark] = playerId;
        return;
      }

      case 'stand':
        freeSeat(s, playerId);
        return;

      case 'move': {
        const cell = a.cell;
        if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell > 8) return 'Bad cell';
        if (!s.seats.X || !s.seats.O) return 'Waiting for two players';
        if (s.winner) return 'Game is over';
        if (s.seats[s.turn] !== playerId) return 'Not your turn';
        if (s.board[cell]) return 'Cell already taken';

        s.board[cell] = s.turn;
        const line = LINES.find((l) => l.every((i) => s.board[i] === s.turn));
        if (line) {
          s.winner = s.turn;
          s.winLine = line;
          const winnerId = s.seats[s.turn]!;
          s.wins[winnerId] = (s.wins[winnerId] ?? 0) + 1;
        } else if (s.board.every((c) => c)) {
          s.winner = 'draw';
          s.draws++;
        } else {
          s.turn = s.turn === 'X' ? 'O' : 'X';
        }
        return;
      }

      case 'rematch': {
        if (!s.winner) return 'Game is not over yet';
        if (s.seats.X !== playerId && s.seats.O !== playerId) return 'Only players can start a rematch';
        // Swap sides so the other player gets to go first.
        s.seats = { X: s.seats.O, O: s.seats.X };
        resetBoard(s);
        return;
      }

      default:
        return 'Unknown action';
    }
  },

  playerLeft: freeSeat,
};
