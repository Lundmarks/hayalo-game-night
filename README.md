# Hayalo Game Night

A Discord Activity: a game launcher that runs inside Discord voice channels.

Games:
- **Hay-Tac-Toe**: two players, everyone else spectates.
- **Hayalo Artillery**: Worms-style, 1–6 players, destructible terrain and seven weapons.
- **Hay, Where?**: everyone gets the same photo and drops a pin where they think it
  was taken. Closest wins, with a bonus for being quick.

## Setup

1. `npm install`
2. Discord Developer Portal → your app:
   - **OAuth2**: copy Client ID and Client Secret into `.env` (see `.env.example`).
     Add a redirect `https://127.0.0.1`.
   - **Activities → Settings**: enable Activities.
3. Run (two terminals):
   ```sh
   npm run dev:discord   # client on :5173, server on :3001
   npm run tunnel        # prints https://<random>.trycloudflare.com
   ```
4. **Activities → URL Mappings**: set prefix `/` → the tunnel host, without `https://`
   (e.g. `abc-def.trycloudflare.com`). The quick tunnel URL changes every time you
   restart it, so update the mapping when it does.
5. In Discord, join a voice channel → Activities (🚀) → Hayalo Game Night.
   While the app is unverified, only you and people added under **App Testers**
   (or in a server you own) can launch it.

## Testing without Discord

`npm run dev`, then open http://localhost:5173 in two tabs. Each tab is a
separate guest. Add `?room=name` to use a separate room.

## How it fits together

```
src/shared/   protocol + game list + game state types (used by both sides)
src/server/   Express (OAuth token exchange) + WebSocket rooms, one per Activity instance
  games/      server-side rules; the server is the source of truth
src/client/   Discord SDK login, launcher, game screens
  games/      one render function per game
```

The first person in a room is the host and picks the game. When the host leaves,
the next person becomes host.

## Hayalo Artillery

- The server simulates each shot (`src/shared/artillery/sim.ts`) and sends a short
  timeline of positions and events. Every client plays the same timeline, so
  everyone sees and hears the same thing, and nobody can fake a hit.
- The map is rebuilt from a seed plus a crater list (`terrain.ts`), so the network
  never carries pixels. The seed also picks a theme (meadow, hay farm, desert, snow,
  candy) and a shape (island, twin isles, archipelago, mountain, terraces, sky
  islands). Scenery (trees, hay bales, cacti, snowmen, lollipops, girder bridges)
  is part of the terrain, so it blocks shots and can be blown up.
- Worms are named after politicians: admired, infamous, and Swedish politicians
  from all eight Riksdag parties (with a party tag and pin). Lists and speech-bubble
  quips are in `src/shared/artillery/politicians.ts`; hats are in `render.ts`.
- Walking is limited only by the turn clock. Grenades and the Holy Hay Bomb roll
  along the ground and bounce off worms.
- Retreat: after firing you have 3 seconds to walk or jump. The server re-runs the
  shot with your moves added (the sim is seeded, so everything before the move is
  identical) and clients swap to the new timeline mid-playback.
- Between turns, crates may parachute in (health +25, or an extra limited weapon),
  and after the sudden-death round count the water rises each turn. Both are lobby
  settings. A corner panel shows each team's health, worms left and who is away.
- Controls: drag on the map to aim (distance = power), Space/FIRE to shoot,
  ←/→ or the buttons to walk, J to jump, W/S angle, Q/E power, 1–7 weapons.
  The same list is on screen (H toggles it).

## Hay, Where?

- Photos come from Wikimedia Commons ("Quality images" with a camera location,
  wide shots only, with close-ups, food, museum pieces and so on filtered out).
  No API key needed. `src/server/geo/photos.ts` holds the search.
- The server downloads each photo and serves it under a random token
  (`/api/geo/img/<token>`), because Commons filenames usually name the place.
  Map tiles (OpenStreetMap) go through `/api/geo/tile/...` for the same Discord
  iframe reason as everything else. Both are cached in memory.
- Pins stay on the server until the reveal, so nobody can peek at other guesses.
- Score: up to 5000 for distance (about 3000 at 500 km), plus up to 1000 for speed,
  scaled by how good the guess was. The first lock-in cuts everyone else to 15s.
- Commons is heavy on Europe, so expect more European photos than anywhere else.

## Sound

`src/client/audio.ts` generates every sound in code with the Web Audio API, so
nothing has to load. Sounds are panned left/right by where they happen on the map,
pitch-varied slightly so repeats don't sound robotic, and run through a limiter
so stacked explosions don't clip. Volume and mute are remembered per browser.
Game sounds are triggered by the shared timeline events, so they line up on every
client.

## Adding a game

1. Add an entry to `GAMES` in `src/shared/games.ts` (plus its state/action types).
2. Write a `GameModule` in `src/server/games/` and register it in `games/index.ts`.
3. Write a render function in `src/client/games/` and hook it up in `src/client/main.ts`.

## Production

`npm run build && npm start` serves the built client and the API from one port
(`PORT`, default 3001). Host it anywhere with HTTPS and point the URL mapping at it.
