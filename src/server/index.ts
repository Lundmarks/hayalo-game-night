import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, JoinAuth, Player, ServerMsg } from '../shared/protocol.ts';
import { dropIfEmpty, getRoom, type Room } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PRODUCTION = process.env.NODE_ENV === 'production';
// Lets you test in a normal browser tab without Discord. Off in production.
const ALLOW_MOCK = !PRODUCTION && process.env.ALLOW_MOCK_USERS !== 'false';

if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_SECRET.startsWith('paste')) {
  console.warn('⚠️  VITE_DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET missing in .env. Discord login will fail (browser test mode still works).');
}

const app = express();
app.use(express.json());

const api = express.Router();

// Swap the one-time code from the Discord client for an access token.
api.post('/token', async (req, res) => {
  const code = req.body?.code;
  if (typeof code !== 'string') return res.status(400).json({ error: 'Missing code' });

  const r = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID ?? '',
      client_secret: CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = (await r.json()) as { access_token?: string; error?: string };
  if (!r.ok || !data.access_token) {
    console.error('Token exchange failed:', r.status, data);
    return res.status(502).json({ error: 'Token exchange failed' });
  }
  res.json({ access_token: data.access_token });
});

api.get('/health', (_req, res) => res.json({ ok: true }));

// Discord's proxy may forward requests with or without the /.proxy prefix.
app.use('/api', api);
app.use('/.proxy/api', api);

if (PRODUCTION) {
  app.use(express.static(fileURLToPath(new URL('../../dist', import.meta.url))));
}

async function resolvePlayer(auth: JoinAuth): Promise<Player> {
  if ('accessToken' in auth) {
    // Ask Discord who this token belongs to, so nobody can pretend to be someone else.
    const r = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!r.ok) throw new Error('Discord rejected the access token');
    const u = (await r.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
    const avatarUrl = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
    return { id: u.id, name: u.global_name || u.username, avatarUrl };
  }
  if ('mock' in auth && ALLOW_MOCK) {
    const name = String(auth.mock.name).slice(0, 32) || 'Guest';
    return { id: `mock-${String(auth.mock.id).slice(0, 40)}`, name, avatarUrl: null };
  }
  throw new Error('Not allowed to join');
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/api/ws' || path === '/.proxy/api/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let joining = false;
  const send = (msg: ServerMsg) => ws.send(JSON.stringify(msg));

  ws.on('message', async (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.t === 'join') {
      if (room || joining) return;
      joining = true;
      try {
        const player = await resolvePlayer(msg.auth);
        if (ws.readyState !== ws.OPEN) return;
        room = getRoom(String(msg.instanceId).slice(0, 100));
        send({ t: 'welcome', you: player });
        room.add(ws, player);
      } catch (e) {
        send({ t: 'error', message: (e as Error).message });
        ws.close();
      } finally {
        joining = false;
      }
      return;
    }

    if (!room) return;
    if (msg.t === 'pickGame') room.pickGame(ws, String(msg.gameId));
    else if (msg.t === 'leaveGame') room.leaveGame(ws);
    else if (msg.t === 'game') room.gameAction(ws, msg.action);
  });

  ws.on('close', () => {
    if (!room) return;
    room.remove(ws);
    dropIfEmpty(room);
  });
});

server.listen(PORT, () => {
  console.log(`🎲 Hayalo Game Night server on http://localhost:${PORT}`);
});
