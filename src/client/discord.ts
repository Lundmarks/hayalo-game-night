import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { JoinAuth } from '../shared/protocol.ts';

// Discord adds frame_id to the URL when it loads an Activity.
export const inDiscord = new URLSearchParams(location.search).has('frame_id');

export type Identity = { instanceId: string; auth: JoinAuth };

let sdk: DiscordSDK | null = null;

/** Open a link in the user's browser. Inside Discord, plain links are blocked. */
export function openExternal(url: string) {
  if (sdk) sdk.commands.openExternalLink({ url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}

export async function getIdentity(): Promise<Identity> {
  return inDiscord ? discordIdentity() : browserIdentity();
}

async function discordIdentity(): Promise<Identity> {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not set in .env');

  sdk = new DiscordSDK(clientId);
  await sdk.ready();

  // Ask the user to authorize the app (silent after the first time).
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('Could not log in with Discord (token exchange failed)');
  const { access_token } = (await res.json()) as { access_token: string };

  await sdk.commands.authenticate({ access_token });
  return { instanceId: sdk.instanceId, auth: { accessToken: access_token } };
}

// Outside Discord: a fake guest per browser tab, so you can open two tabs and
// play against yourself. Use ?room=name to pick a room.
function browserIdentity(): Identity {
  let id = '';
  let name = '';
  try {
    id = sessionStorage.getItem('hgn-id') ?? '';
    name = sessionStorage.getItem('hgn-name') ?? '';
  } catch {}
  if (!id) {
    id = crypto.randomUUID();
    name = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      sessionStorage.setItem('hgn-id', id);
      sessionStorage.setItem('hgn-name', name);
    } catch {}
  }
  const room = new URLSearchParams(location.search).get('room') ?? 'local';
  return { instanceId: `browser-${room}`, auth: { mock: { id, name } } };
}
