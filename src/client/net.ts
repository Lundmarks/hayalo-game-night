import type { ClientMsg, Player, RoomView, ServerMsg } from '../shared/protocol.ts';
import type { Identity } from './discord.ts';

type Handlers = {
  onRoom(room: RoomView, you: Player): void;
  onEvent(event: unknown): void;
  onError(message: string): void;
  onStatus(status: 'connecting' | 'connected' | 'reconnecting'): void;
};

// WebSocket to the game server that reconnects on its own if it drops.
export class Connection {
  private ws: WebSocket | null = null;
  private you: Player | null = null;
  private retries = 0;
  private fatal = false;

  constructor(private identity: Identity, private h: Handlers) {
    this.open();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    this.h.onStatus(this.retries ? 'reconnecting' : 'connecting');

    ws.onopen = () => {
      this.retries = 0;
      this.send({ t: 'join', instanceId: this.identity.instanceId, auth: this.identity.auth });
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMsg;
      if (msg.t === 'welcome') {
        this.you = msg.you;
        this.h.onStatus('connected');
      } else if (msg.t === 'room' && this.you) {
        this.h.onRoom(msg.room, this.you);
      } else if (msg.t === 'gameEvent') {
        this.h.onEvent(msg.event);
      } else if (msg.t === 'error') {
        if (!this.you) this.fatal = true; // join was rejected; retrying won't help
        this.h.onError(msg.message);
      }
    };

    ws.onclose = () => {
      if (this.fatal) return;
      const delay = Math.min(1000 * 2 ** this.retries++, 10000);
      this.h.onStatus('reconnecting');
      setTimeout(() => this.open(), delay);
    };
  }
}
