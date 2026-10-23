import type { Player } from '../../shared/protocol.ts';
import { artillery } from './artillery.ts';
import { ticTacToe } from './tictactoe.ts';

// What a game can ask of its room.
export interface GameContext {
  /** Send the full state to everyone (use after changes made in a timer). */
  broadcast(): void;
  /** Send a one-off event to everyone, without the full state. */
  emit(event: unknown): void;
  players(): Player[];
  hostId(): string | null;
  /** Like setTimeout, but cancelled automatically when the game closes. */
  setTimer(ms: number, fn: () => void): void;
}

// Server-side rules for one game. State is mutated in place.
export interface GameModule<S = any> {
  id: string;
  create(ctx: GameContext): S;
  /**
   * Apply a player's action. Return an error message to reject it, 'quiet' to
   * skip the full-state broadcast (when the game sent its own event), or
   * nothing to broadcast the new state.
   */
  action(state: S, playerId: string, action: unknown, ctx: GameContext): string | void;
  /** Called when a player's last connection to the room closes. */
  playerLeft?(state: S, playerId: string, ctx: GameContext): void;
}

export const QUIET = 'quiet';

export const GAME_MODULES: Record<string, GameModule> = {
  [ticTacToe.id]: ticTacToe,
  [artillery.id]: artillery,
};
