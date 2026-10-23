import { artillery } from './artillery.ts';
import { geoGuess } from './geoguess.ts';
import type { GameModule } from './module.ts';
import { ticTacToe } from './tictactoe.ts';

export { QUIET, type GameContext, type GameModule } from './module.ts';

export const GAME_MODULES: Record<string, GameModule> = {
  [ticTacToe.id]: ticTacToe,
  [artillery.id]: artillery,
  [geoGuess.id]: geoGuess,
};
