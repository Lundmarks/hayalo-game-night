# Hayalo Game Night: notes for Claude

A Discord Activity (embedded app in voice channels) that hosts small multiplayer
games. TypeScript end to end: Vite client, Express + `ws` server run with `tsx`.
README.md covers setup, Discord portal config, and architecture. Read it first.

## Commands

- `npm run dev`: server :3001 + client :5173. Open two tabs at http://localhost:5173
  to play against yourself (mock guests, `?room=name` for separate rooms).
- `npm run dev:discord` + `npm run tunnel`: test inside Discord (update URL mapping
  in the Developer Portal each time the tunnel URL changes).
- `npm run check`: typecheck (`tsc --noEmit`).
- `npm test`: Node's built-in test runner via `tsx` (`tests/*.test.ts`). The
  artillery tests drive the GameModule with a fake room and a hand-cranked
  `Date.now`, so timers (turn clock, forfeit grace) run on demand.
- Git remote is `git@github.com:Lundmarks/hayalo-game-night.git`. The user pushes
  themselves; commit locally, never push.
- `.env` holds the real Discord secret. Never print or commit it.

## Architecture rules

- **Server is authoritative.** Games are `GameModule`s in `src/server/games/`
  (state mutated in place, return an error string / `QUIET` / nothing). Clients only
  send intents and render. Room = one Discord `instanceId`; first player is host.
  The interfaces and `QUIET` live in `games/module.ts`; game files import from
  there, not `index.ts`, to avoid a circular import.
- **Full state vs. events.** `ctx.broadcast()` sends the whole room state;
  `ctx.emit()` sends a one-off event (artillery uses this for timelines, walking
  and live aim, returning `QUIET` to skip the broadcast).
- **Artillery determinism.** `Terrain.generate(seed, craters)` must give identical
  results on server and every client: only + - * /, Math.floor/round, and the
  seeded `rng`. No Math.sin/cos/random in terrain generation. `sim.ts` runs on the
  server only (so Math.random there is fine) and produces a `Timeline` that clients
  replay frame by frame (`view.ts`). Craters are applied in order by index.
- **Sound** is fully synthesized in `src/client/audio.ts` (no asset files). Game
  sounds are triggered from timeline events so every client hears the same thing.
- Client views implement `GameView` (`update`, `event`, `destroy`) and are
  registered in `VIEWS` in `src/client/main.ts`. Clicks use `data-act` (JSON game
  action) or `data-cmd`.

## Current status (2026-10-23)

Working:
- Launcher with host-picks-game, host handover when the host leaves, reconnecting
  WebSocket, Discord OAuth login, browser mock mode.
- Hay-Tac-Toe: seats, spectators, win/draw tracking, rematch swaps sides.
- Hayalo Artillery: lobby (1–6 teams, 1–4 worms each, 30/45/60s turns), solo
  practice, procedurally generated island with caves and ledges, destructible
  terrain, wind, walking/jumping, fall damage, drowning, 7 weapons (bazooka,
  grenade, shotgun, cluster, air strike, Holy Hay Bomb, teleport), camera that
  follows the action on narrow screens, keyboard + touch controls, synthesized
  audio with panning. Surrender (tap twice), forfeit after 60s disconnected,
  turn clock paused during jump/fall animations, per-team worm rotation by id.

Not set up: production hosting.

## Next steps

Known gaps (artillery):
1. No retreat time after firing (classic Worms gives ~3s to run).
2. Late joiners can only spectate an artillery match in progress.
3. No in-match team list showing who is out / offline.

Features worth adding:
- Sudden death (rising water after N turns) so matches end.
- Health/weapon crates dropped between turns.
- Trajectory preview for the first few turns or as a practice-mode option.
- Session scoreboard for artillery (like tic-tac-toe's win counts).
- More games in the launcher (the `GAMES` list supports `available: false`
  "Coming soon" cards).

Project hygiene:
- More tests: sim outcomes, tic-tac-toe rules.
- Deploy somewhere with HTTPS for a stable URL instead of the quick tunnel.
