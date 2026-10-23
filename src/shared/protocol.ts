// Messages passed between the browser and the server over the WebSocket.

export type Player = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export type JoinAuth =
  | { accessToken: string } // inside Discord
  | { mock: { id: string; name: string } }; // plain browser, dev only

export type ClientMsg =
  | { t: 'join'; instanceId: string; auth: JoinAuth }
  | { t: 'pickGame'; gameId: string }
  | { t: 'leaveGame' }
  | { t: 'game'; action: unknown };

export type RoomView = {
  players: Player[];
  hostId: string | null;
  game: { id: string; state: unknown } | null;
  now: number; // server clock, so clients can show timers correctly
};

export type ServerMsg =
  | { t: 'welcome'; you: Player }
  | { t: 'room'; room: RoomView }
  | { t: 'gameEvent'; event: unknown }
  | { t: 'error'; message: string };
