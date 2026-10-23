import type { WebSocket } from 'ws';
import type { Player, RoomView, ServerMsg } from '../shared/protocol.ts';
import { GAME_MODULES, QUIET, type GameContext, type GameModule } from './games/index.ts';

// One room per Discord Activity instance (everyone who launched the Activity
// in the same channel shares an instanceId).
export class Room {
  private conns = new Map<WebSocket, Player>();
  private hostId: string | null = null;
  private game: { module: GameModule; state: unknown; ctx: GameContext; timers: Set<NodeJS.Timeout> } | null = null;

  constructor(readonly id: string) {}

  get empty() {
    return this.conns.size === 0;
  }

  add(ws: WebSocket, player: Player) {
    this.conns.set(ws, player);
    this.hostId ??= player.id;
    this.broadcast();
  }

  remove(ws: WebSocket) {
    const player = this.conns.get(ws);
    if (!player) return;
    this.conns.delete(ws);

    // Someone may have the Activity open twice; only count them as gone when
    // their last connection closes.
    const stillHere = [...this.conns.values()].some((p) => p.id === player.id);
    if (!stillHere) {
      if (this.game) this.game.module.playerLeft?.(this.game.state, player.id, this.game.ctx);
      if (this.hostId === player.id) {
        this.hostId = this.conns.values().next().value?.id ?? null;
      }
    }
    this.broadcast();
  }

  pickGame(ws: WebSocket, gameId: string) {
    const player = this.conns.get(ws);
    if (!player) return;
    if (player.id !== this.hostId) return this.send(ws, { t: 'error', message: 'Only the host can pick a game' });
    const module = GAME_MODULES[gameId];
    if (!module) return this.send(ws, { t: 'error', message: 'That game is not ready yet' });
    this.closeGame();
    const timers = new Set<NodeJS.Timeout>();
    const game = { module, state: null as unknown, timers, ctx: null as unknown as GameContext };
    game.ctx = {
      broadcast: () => this.game === game && this.broadcast(),
      emit: (event) => this.game === game && this.emit(event),
      players: () => this.view().players,
      hostId: () => this.hostId,
      setTimer: (ms, fn) => {
        const t = setTimeout(() => {
          timers.delete(t);
          if (this.game === game) fn();
        }, ms);
        timers.add(t);
      },
    };
    this.game = game;
    game.state = module.create(game.ctx);
    this.broadcast();
  }

  leaveGame(ws: WebSocket) {
    const player = this.conns.get(ws);
    if (!player) return;
    if (player.id !== this.hostId) return this.send(ws, { t: 'error', message: 'Only the host can go back to the launcher' });
    this.closeGame();
    this.broadcast();
  }

  private closeGame() {
    if (!this.game) return;
    for (const t of this.game.timers) clearTimeout(t);
    this.game = null;
  }

  /** Room is being thrown away. */
  dispose() {
    this.closeGame();
  }

  gameAction(ws: WebSocket, action: unknown) {
    const player = this.conns.get(ws);
    if (!player || !this.game) return;
    const result = this.game.module.action(this.game.state, player.id, action, this.game.ctx);
    if (result === QUIET) return;
    if (result) return this.send(ws, { t: 'error', message: result });
    this.broadcast();
  }

  private view(): RoomView {
    const players = new Map<string, Player>();
    for (const p of this.conns.values()) players.set(p.id, p);
    return {
      players: [...players.values()],
      hostId: this.hostId,
      game: this.game && { id: this.game.module.id, state: this.game.state },
      now: Date.now(),
    };
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private emit(event: unknown) {
    const msg = JSON.stringify({ t: 'gameEvent', event } satisfies ServerMsg);
    for (const ws of this.conns.keys()) if (ws.readyState === ws.OPEN) ws.send(msg);
  }

  private broadcast() {
    const msg = JSON.stringify({ t: 'room', room: this.view() } satisfies ServerMsg);
    for (const ws of this.conns.keys()) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

const rooms = new Map<string, Room>();

export function getRoom(id: string) {
  let room = rooms.get(id);
  if (!room) rooms.set(id, (room = new Room(id)));
  return room;
}

export function dropIfEmpty(room: Room) {
  if (room.empty) {
    room.dispose();
    rooms.delete(room.id);
  }
}
