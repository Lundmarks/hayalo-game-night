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

## Scope

- **Desktop only for now.** Phones and tablets are not a target, so don't spend
  time on mobile layouts or touch controls, and don't let them hold back desktop
  features. The existing phone CSS and touch buttons can stay; just don't extend them.

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
- **Hay, Where? hides the answer.** The answer and everyone's pins live in the
  module's private WeakMap until the reveal; the shared state only has an opaque
  photo token and who has locked in. Keep it that way when adding features. The
  photo source is injected (`createGeoGame(source)`) so tests use fake photos.
- Client views implement `GameView` (`update`, `event`, `destroy`) and are
  registered in `VIEWS` in `src/client/main.ts`. Clicks use `data-act` (JSON game
  action) or `data-cmd`.

## Artillery file map

- `src/shared/artillery/terrain.ts`: seeded map generator (themes, shapes,
  materials, caves), `rng`, crater carving.
- `src/shared/artillery/sim.ts`: physics, weapons, crates, flood, retreat inputs,
  kill-cam timing (`killCam`, `frameAt`, `SLOWMO`). Builds the `Timeline`.
- `src/shared/artillery/types.ts`: `ArtState`, timeline/event types, `MatchStats`.
- `src/server/games/artillery.ts`: lobby, turn flow (`simulateShot` →
  `publishShot` → `afterAnimation` → `betweenTurns` → `nextTurn`), retreat
  re-simulation, spawns, stats.
- `src/client/games/artillery/view.ts`: timeline playback, camera/zoom, input,
  panels, end screen. `render.ts`: all canvas drawing and `weaponIcon()`.
- Server waits `frames/FPS + killCamExtraMs + PAUSE_MS` before the next turn;
  change the kill cam in `sim.ts` so both sides keep agreeing.

## Checking visuals

There's no browser test harness in the repo. Headless Chromium from Playwright's
cache, driven over CDP with the `ws` package, works for screenshots (keep runs
sequential: they share a debug port). Emoji don't render there, which is why
icons are drawn in code.

## Deploying (plan, not set up yet)

Goal: an always-on server with a fixed HTTPS address, so the Discord URL mapping
is set once (no quick tunnel). The app already supports it: `npm run build` +
`npm start` serves the client and the API from one port (`PORT`, default 3001).
Production only allows real Discord logins (no mock guests), so keep testing
locally with `npm run dev`.

### Chosen: Option A, the home server (this machine)

This repo lives on the user's always-on home server (LAN IP 192.168.50.50), which
already runs the Hayalo Behave bot (`~/projects/behave-bot`, Docker container
`behave-bot-1`), the Tornknackarna scout bot and Syncthing in Docker, plus
Pi-hole. The game runs next to them:

```
Discord --https--> <name>.duckdns.org --router 443->8443--> Caddy --> game container :3001
```

1. **Container:** a Dockerfile + `docker-compose.yml` for the game (like
   behave-bot: `restart: unless-stopped`, `env_file: .env`). `.env` must exist
   before the image is built: the client ID is baked into the client bundle.
   Expose 3001 only on localhost.
2. **Address:** a second DuckDNS name (e.g. `hayalo-gn.duckdns.org`). Add it to
   the `domains=` list in `~/duckdns/duck.sh` (comma-separated); the existing cron
   job (every 5 min) keeps it updated. Never print the token in that file.
3. **HTTPS:** Caddy. **Pi-hole already uses ports 80 and 443 on this machine**, so
   Caddy listens on 8080/8443 (`http_port 8080`, `https_port 8443` in the global
   options) with `<name>.duckdns.org { reverse_proxy localhost:3001 }`. Don't
   touch Pi-hole.
4. **Router** (http://192.168.50.1, done by the user): forward external TCP 80 →
   192.168.50.50:8080 and external TCP 443 → 192.168.50.50:8443, next to the
   existing rule style (the old Minecraft rule was 25565 → 25565).
5. **Discord:** Developer Portal → Activities → URL Mappings → target
   `<name>.duckdns.org`, once.

Updating: `git pull && docker compose up -d --build`. A restart ends matches in
progress, so update between game nights. Don't change Pi-hole, the router, or
the other containers without asking.

Downsides accepted: runs only while this machine is on (it already runs the bots
24/7), uses home upload bandwidth (light), home IP reachable on 80/443.

### Fallback: Option B, Oracle Cloud free VM

If the home server stops being suitable: Oracle "Always Free" Ubuntu VM (Ampere
shape), DuckDNS name to its IP, open TCP 80/443 in both the Oracle security list
and the VM firewall (`iptables` + `netfilter-persistent save`), install Node 22+,
git, Caddy, clone + `.env` + `npm ci` + `npm run build`, a systemd service for
`npm start`, Caddyfile `<name>.duckdns.org { reverse_proxy localhost:3001 }`.
Render.com's free tier is simpler but sleeps after 15 min idle.

Before sharing the address widely: rate-limit the map tile proxy (`/api/geo/tile`).

## Current status (2026-10-24)

Working:
- Launcher with host-picks-game, host handover when the host leaves, reconnecting
  WebSocket, Discord OAuth login, browser mock mode.
- Hay-Tac-Toe: seats, spectators, win/draw tracking, rematch swaps sides.
- Hayalo Artillery: lobby (1–6 teams, 1–4 worms each, 30/45/60s turns), solo
  practice, procedurally generated island with caves and ledges, destructible
  terrain, wind, walking/jumping, fall damage, drowning, 16 weapons (see the
  weapons round below), camera that
  follows the action on narrow screens, keyboard + touch controls, synthesized
  audio with panning. Surrender (tap twice), forfeit after 60s disconnected,
  turn clock paused during jump/fall animations, per-team worm rotation by id.
- Artillery look and feel (2026-10-24): 5 themes x 6 map shapes picked from the
  seed, destructible scenery (material layer `Terrain.mat`, caves listed in
  `Terrain.caves` for the back wall), cartoon renderer (inked outlines, worm faces
  and politician hats, comic BOOM text, plane for air strikes, birds/snow), more
  synthesized sounds (voice "ow", boing, bonk, slide whistle, sad trombone).
  Worm names are politicians (`ADMIRED`/`INFAMOUS`/`SWEDISH` in
  `src/shared/artillery/politicians.ts`).
  Fixed: fused bombs passed through worms; bombs stuck instead of rolling; a hidden
  170px walk budget plus a too-strict slope check made walking stop.
- Artillery round 2 (2026-10-24): 3s retreat after firing (server keeps the shot's
  snapshot + seed and re-simulates with `Sim.inputs`; clients get
  `{type:'timeline', replace:true}`), sudden death (rising `s.water`, host picks
  4/8/12 rounds or off), parachute crates (`s.crates`, health or limited weapon,
  explode/sink/fall), team health panel, on-screen keybinds, speech-bubble quips,
  Swedish politicians with party tags. Between-turn events run in `betweenTurns()`.
- Artillery polish (2026-10-24): kill-cam slow motion (shared `killCam`/`frameAt`,
  server waits `killCamExtraMs`), turn intro card + zoom, faint trail of your last
  shot, graves that fall and show names, drawn weapon icons, end screen with
  awards from `s.stats` (`recordStats()` on the server).
- Artillery weapons round (2026-10-25): 16 weapons (`WEAPONS` has `phrase` for the
  end screen and `aim: 'angle' | 'target' | 'none'`). New sim pieces: `stepSheep`,
  `cloud()` (stink/medic, no crater, `heal` event), `bat()` (`melee` event),
  `everyone()` (`ping`/`zap` events). Grenade and fall damage buffed. Hurting
  yourself mid-turn ends the turn (`runMoveSim`); `crateSpot` keeps drops 45px
  from worms. Backdrop/water/clouds extend to the visible range on wide screens
  (`drawBackdrop`, `visX0/visX1`). Hay bomb sounds: `truddelutt`, `holy`, `hayalo`.
  Tests for these are in `tests/weapons.test.ts`.
- Mines and dynamite (2026-10-25): mines are `Crate`s with `kind: 'mine'`
  (`stepMines`, `placeMine`, `detonateMine` in sim; `placeMines` + lobby
  `mineCount` on the server; walking near one runs a move sim). Crate/mine ids come
  from `nextCrateId()` so re-simulated shots get the same ids. `WeaponDef.retreat`
  gives dynamite and mine 5s to run (`Shot.retreatFrames`). Tests turn mines off
  (`mines: 0`) unless they test them.
- Hay, Where? (geoguess): Wikimedia Commons photos, Leaflet + OSM map, rounds
  3/5/10, 30/60/90s, 15s rush after the first lock-in, speed bonus, reveal map
  with all pins, auto-advance, host skip/next/end, click-to-zoom photo, phone layout
  with a map toggle. Not yet checked by eye in a browser or in Discord.

Not set up: production hosting.

## Next steps

Known gaps (artillery):
1. Late joiners can only spectate an artillery match in progress.
2. Retreat moves show up after a round trip to the server, so they feel slightly
   laggy on slow connections (no client-side prediction).

Hay, Where? ideas:
- Region packs (only Europe / only Asia / a country) via Commons search terms.
- A pixel/blur mode or a "no zooming" mode for harder rounds.
- Show the round-by-round history on the final screen.
- Photo tokens expire after 2h, so a lobby left open that long fails the first
  photo (the host can skip). Refresh the prefetch if it's old.
- The tile proxy is open to anyone who finds it; rate-limit it before going public.

Features worth adding:
- Trajectory preview for the first few turns or as a practice-mode option.
- Session scoreboard for artillery (like tic-tac-toe's win counts).
- Craters that cut into a cave get the cave back wall when a client rebuilds the
  map (late join), but open sky for clients that saw the blast. Cosmetic only.
- More games in the launcher (the `GAMES` list supports `available: false`
  "Coming soon" cards).

Project hygiene:
- More tests: sim outcomes, tic-tac-toe rules.
- Deploy somewhere with HTTPS for a stable URL instead of the quick tunnel.
