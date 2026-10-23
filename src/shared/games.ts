// Games shown in the launcher. Add an entry here, then a server module in
// src/server/games and a client view in src/client/games.

export type GameInfo = {
  id: string;
  name: string;
  emoji: string;
  players: string;
  description: string;
  available: boolean;
};

export const GAMES: GameInfo[] = [
  {
    id: 'tictactoe',
    name: 'Hay-Tac-Toe',
    emoji: '❌⭕',
    players: '2 players + spectators',
    description: 'Classic three in a row. Winner keeps bragging rights, loser starts next round.',
    available: true,
  },
  {
    id: 'artillery',
    name: 'Hayalo Artillery',
    emoji: '💥',
    players: '1–6 players',
    description: 'Worms-style turn-based war on a destructible island. Bazookas, grenades, air strikes and the Holy Hay Bomb.',
    available: true,
  },
];

// ---- Tic-tac-toe ----

export type Mark = 'X' | 'O';

export type TTTState = {
  board: ('' | Mark)[];
  seats: Record<Mark, string | null>; // player ids
  turn: Mark;
  winner: Mark | 'draw' | null;
  winLine: number[] | null;
  wins: Record<string, number>; // player id -> wins this session
  draws: number;
};

export type TTTAction =
  | { a: 'sit'; mark: Mark }
  | { a: 'stand' }
  | { a: 'move'; cell: number }
  | { a: 'rematch' };
