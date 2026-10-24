export type WeaponId =
  | 'bazooka' | 'grenade' | 'shotgun' | 'bat' | 'cluster' | 'banana' | 'airstrike' | 'haybomb' | 'teleport'
  | 'doctor' | 'dynamite' | 'mine' | 'sheep' | 'rose' | 'folkhem' | 'surstromming' | 'duck' | 'everyone';

export type WeaponDef = {
  id: WeaponId;
  name: string;
  /** How the end screen says it: "scored an own goal with a grenade". */
  phrase: string;
  ammo: number; // -1 = unlimited
  /** angle: aim with angle + power. target: tap the map. none: just fire. */
  aim: 'angle' | 'target' | 'none';
  hint: string;
  /** Seconds to run after firing, if not the usual RETREAT_SECONDS. */
  retreat?: number;
};

export const WEAPONS: WeaponDef[] = [
  { id: 'bazooka', name: 'Bazooka', phrase: 'a bazooka', ammo: -1, aim: 'angle', hint: 'Explodes on impact. Pushed by wind.' },
  { id: 'grenade', name: 'Grenade', phrase: 'a grenade', ammo: -1, aim: 'angle', hint: 'Bounces, explodes after 3 seconds. Ignores wind.' },
  { id: 'shotgun', name: 'Shotgun', phrase: 'a shotgun', ammo: -1, aim: 'angle', hint: 'Instant straight shot. Small but precise.' },
  { id: 'bat', name: 'Baseball Bat', phrase: 'a baseball bat', ammo: 2, aim: 'angle', hint: 'Whack a worm next to you clean across the map. Aim sets the direction.' },
  { id: 'cluster', name: 'Cluster Bomb', phrase: 'a cluster bomb', ammo: 2, aim: 'angle', hint: 'Bursts into five bomblets on impact.' },
  { id: 'banana', name: 'Banana Bomb', phrase: 'a banana bomb', ammo: 1, aim: 'angle', hint: 'Bounces, then splits into five bouncing mini bananas.' },
  { id: 'airstrike', name: 'Air Strike', phrase: 'an air strike', ammo: 1, aim: 'target', hint: 'Tap the map. Five missiles rain down there.' },
  { id: 'haybomb', name: 'Holy Hay Bomb', phrase: 'the Holy Hay Bomb', ammo: 1, aim: 'angle', hint: 'Huge blast after 4 seconds. Bounces. Hayalo!' },
  { id: 'teleport', name: 'Teleport', phrase: 'a teleport', ammo: 2, aim: 'target', hint: 'Tap an open spot to move there. Uses your turn.' },
  { id: 'doctor', name: 'Dr. Carl Johan', phrase: "Dr. Carl Johan's syringe", ammo: 2, aim: 'angle', hint: "The doctor's syringe: heals your worms where it lands, side effects for everyone else." },
  { id: 'dynamite', name: 'Dynamite', phrase: 'a stick of dynamite', ammo: 1, aim: 'angle', retreat: 5, hint: 'Drop it at your feet and run: a huge blast after 5 seconds. You get 5s to run.' },
  { id: 'mine', name: 'Mine', phrase: 'a mine', ammo: 2, aim: 'angle', retreat: 5, hint: 'Drops a mine in front of you. It arms after 2 seconds and goes off when someone gets close.' },
  { id: 'sheep', name: "Fälldin's Sheep", phrase: "Fälldin's sheep", ammo: 1, aim: 'angle', hint: 'A sheep from the Fälldin farm walks the way you face, hops over walls and explodes.' },
  { id: 'rose', name: "Palme's Rose", phrase: "Palme's rose", ammo: 1, aim: 'angle', hint: 'A red rose that bursts into six petal bombs. Petals drift with the wind.' },
  { id: 'folkhem', name: "Per Albin's Folkhem", phrase: 'a falling folkhem', ammo: 1, aim: 'target', hint: 'Tap the map. A little red house drops from the sky there.' },
  { id: 'surstromming', name: 'Surströmming', phrase: 'a can of surströmming', ammo: 2, aim: 'angle', hint: 'Opens on impact. The stink hurts every worm nearby, no crater.' },
  { id: 'duck', name: 'Rubber Duck', phrase: 'a rubber duck', ammo: 2, aim: 'angle', hint: 'Super bouncy. Squeaks for 5 seconds, then explodes.' },
  { id: 'everyone', name: 'Hayalo @everyone', phrase: "Hayalo's @everyone ping", ammo: 1, aim: 'none', hint: 'The Hayalo bot pings @everyone: lightning hits every enemy worm.' },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w])) as Record<WeaponId, WeaponDef>;

export type Crater = [x: number, y: number, r: number];

export type Worm = {
  id: number;
  team: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  facing: 1 | -1;
};

/** Something lying on the map: a crate to pick up, or a mine. */
export type Crate = {
  id: number;
  x: number;
  y: number; // centre
  kind: 'health' | 'weapon' | 'mine';
  weapon?: WeaponId;
};

/** Weapons a weapon crate can hold (the limited ones). */
export const CRATE_WEAPONS: WeaponId[] = [
  'cluster', 'cluster', 'airstrike', 'haybomb', 'teleport', 'bat', 'banana', 'doctor', 'dynamite', 'mine', 'sheep', 'rose', 'folkhem', 'surstromming', 'duck', 'everyone',
];
export const CRATE_HEALTH = 25;
export const MAX_HP = 150;
/** Seconds you can keep moving after firing. */
export const RETREAT_SECONDS = 3;

export type DeathHow = 'blast' | 'drown' | 'flood' | 'fall';

/** Running tally for the end-of-match screen. */
export type MatchStats = {
  damage: number[]; // per team, dealt to other teams
  kills: number[]; // per team, other teams' worms finished off
  wormDamage: Record<number, number>; // per worm id, dealt to other teams
  best: { wormId: number; weapon: WeaponId; damage: number; kills: number } | null;
  deaths: { wormId: number; by: number | null; how: DeathHow; weapon?: WeaponId }[];
};

export const emptyStats = (teams: number): MatchStats => ({
  damage: Array(teams).fill(0),
  kills: Array(teams).fill(0),
  wormDamage: {},
  best: null,
  deaths: [],
});

export type Team = {
  playerId: string;
  name: string;
  color: string;
  ammo: Record<WeaponId, number>;
  lastWorm: number; // id of the worm that played this team's last turn, -1 at start
  out: 'left' | 'surrendered' | null; // knocked out of the match without losing its worms in battle
};

export type Turn = {
  no: number;
  team: number;
  wormId: number;
  endsAt: number; // server clock, ms
  angle: number; // radians, screen coordinates (y points down)
  power: number; // 0..1
  weapon: WeaponId;
};

export type ArtState = {
  phase: 'lobby' | 'aiming' | 'resolving' | 'over';
  seed: number;
  craters: Crater[];
  teams: Team[];
  worms: Worm[];
  turn: Turn | null;
  wind: number; // -1..1
  winner: number | null; // team index
  wormsPerTeam: number;
  turnSeconds: number;
  solo: boolean;
  /** Water level (y). Starts at WATER_Y and rises in sudden death. */
  water: number;
  crates: Crate[];
  /** Lobby settings: crate drops on/off, sudden death after N rounds (0 = never). */
  cratesOn: boolean;
  suddenDeath: number;
  /** Lobby setting: how many mines are scattered over the map at the start. */
  mineCount: number;
  /** Turn number after which the water starts rising (0 = never), fixed at match start. */
  sdTurn: number;
  stats: MatchStats;
};

export type ProjKind =
  | 'rocket' | 'grenade' | 'cluster' | 'bomblet' | 'missile' | 'haybomb'
  | 'banana' | 'minibanana' | 'syringe' | 'sheep' | 'rose' | 'petal' | 'house' | 'can' | 'duck' | 'dynamite';

export type Track = {
  key: string;
  kind: 'worm' | 'crate' | ProjKind;
  wormId?: number;
  crateId?: number;
  para?: boolean; // a crate floating down on its parachute
  start: number; // frame
  end: number; // frame
  pts: number[]; // x,y pairs every SAMPLE frames from start
};

export type SimEvent = {
  f: number;
  type:
    | 'fire' | 'explode' | 'bounce' | 'splash' | 'damage' | 'die' | 'shot' | 'airstrike' | 'teleport' | 'land' | 'jump'
    | 'flood' // water rises from `amount` to `y`
    | 'crate' // kind: 'drop' | 'place' | 'land' | 'destroy' | 'sink'; mines also 'arm' and 'detonate'
    | 'pickup' // wormId picked up crateId (kind: 'health' | weapon id)
    | 'heal' // wormId got `amount` HP back
    | 'melee' // a bat swing from x,y towards x2,y2
    | 'cloud' // kind 'stink' | 'medic', radius r
    | 'zap' // lightning strikes x,y
    | 'ping'; // the @everyone ping goes out
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  r?: number;
  kind?: string;
  wormId?: number;
  amount?: number;
  crater?: number;
  crateId?: number;
};

export type Timeline = {
  frames: number;
  tracks: Track[];
  events: SimEvent[];
  before: { id: number; x: number; y: number; hp: number; alive: boolean }[];
  /** Every crate that exists at some point, as it was when it appeared (`from` frame). */
  crates: (Crate & { from: number })[];
};

export type ArtEvent =
  // `replace`: the same shot re-simulated with the shooter's retreat moves; keep
  // playing from the current frame. `retreat`: who may still move, and until when.
  | { type: 'timeline'; tl: Timeline; replace?: boolean; retreat?: { wormId: number; until: number } }
  | { type: 'walk'; wormId: number; x: number; y: number; facing: 1 | -1 }
  | { type: 'pickup'; wormId: number; crate: Crate; x: number; y: number }
  | { type: 'aim'; angle: number; power: number; weapon: WeaponId };

export type ArtAction =
  | { a: 'join' }
  | { a: 'leave' }
  | { a: 'settings'; wormsPerTeam?: number; turnSeconds?: number; crates?: boolean; suddenDeath?: number; mines?: number }
  | { a: 'start' }
  | { a: 'walk'; dir: 1 | -1 }
  | { a: 'jump' }
  | { a: 'aim'; angle: number; power: number; weapon: WeaponId }
  | { a: 'fire'; weapon: WeaponId; angle: number; power: number; tx?: number; ty?: number }
  | { a: 'surrender' }
  | { a: 'restart' };

export const TEAM_COLORS = ['#ff6b8b', '#5ad1ff', '#7cf29a', '#ffb547', '#c08bff', '#ff8a3d'];
