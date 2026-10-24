// A fake room for driving a GameModule in tests, with a hand-cranked clock so
// timers only run when the test advances time.
import { afterEach, beforeEach } from 'node:test';
import type { GameContext, GameModule } from '../src/server/games/module.ts';
import type { Player } from '../src/shared/protocol.ts';

export const clock = { now: 1_000_000 };
const realNow = Date.now;
beforeEach(() => {
  clock.now = 1_000_000;
  Date.now = () => clock.now;
});
afterEach(() => {
  Date.now = realNow;
});

export function fakeRoom<S>(module: GameModule<S>, ids: string[]) {
  let players: Player[] = ids.map((id) => ({ id, name: id, avatarUrl: null }));
  const timers: { at: number; fn: () => void }[] = [];
  let broadcasts = 0;
  const events: unknown[] = [];
  const ctx: GameContext = {
    broadcast: () => void broadcasts++,
    emit: (e) => void events.push(e),
    players: () => players,
    hostId: () => players[0]?.id ?? null,
    setTimer: (ms, fn) => void timers.push({ at: clock.now + ms, fn }),
  };
  const s = module.create(ctx);
  return {
    s,
    ctx,
    /** Every event the module emitted, oldest first. */
    events,
    get broadcasts() {
      return broadcasts;
    },
    act: (pid: string, a: object) => module.action(s, pid, a, ctx),
    /** Move the clock forward, firing timers in order (including ones they schedule). */
    advance(ms: number) {
      const end = clock.now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        clock.now = t.at;
        t.fn();
      }
      clock.now = end;
    },
    leave(pid: string) {
      players = players.filter((p) => p.id !== pid);
      module.playerLeft?.(s, pid, ctx);
    },
    rejoin: (pid: string) => void players.push({ id: pid, name: pid, avatarUrl: null }),
  };
}
