export type WeaponId = 'bazooka' | 'grenade' | 'cluster' | 'shotgun' | 'airstrike' | 'haybomb' | 'teleport';

export type WeaponDef = {
  id: WeaponId;
  name: string;
  icon: string;
  ammo: number; // -1 = unlimited
  aim: 'angle' | 'target';
  hint: string;
};

export const WEAPONS: WeaponDef[] = [
  { id: 'bazooka', name: 'Bazooka', icon: '🚀', ammo: -1, aim: 'angle', hint: 'Explodes on impact. Pushed by wind.' },
  { id: 'grenade', name: 'Grenade', icon: '💣', ammo: -1, aim: 'angle', hint: 'Bounces, explodes after 3 seconds. Ignores wind.' },
  { id: 'shotgun', name: 'Shotgun', icon: '🔫', ammo: -1, aim: 'angle', hint: 'Instant straight shot. Small but precise.' },
  { id: 'cluster', name: 'Cluster Bomb', icon: '🎆', ammo: 2, aim: 'angle', hint: 'Bursts into five bomblets on impact.' },
  { id: 'airstrike', name: 'Air Strike', icon: '✈️', ammo: 1, aim: 'target', hint: 'Tap the map. Five missiles rain down there.' },
  { id: 'haybomb', name: 'Holy Hay Bomb', icon: '🌾', ammo: 1, aim: 'angle', hint: 'Huge blast after 4 seconds. Bounces.' },
  { id: 'teleport', name: 'Teleport', icon: '✨', ammo: 2, aim: 'target', hint: 'Tap an open spot to move there. Uses your turn.' },
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
};

export type ProjKind = 'rocket' | 'grenade' | 'cluster' | 'bomblet' | 'missile' | 'haybomb';

export type Track = {
  key: string;
  kind: 'worm' | ProjKind;
  wormId?: number;
  start: number; // frame
  end: number; // frame
  pts: number[]; // x,y pairs every SAMPLE frames from start
};

export type SimEvent = {
  f: number;
  type: 'fire' | 'explode' | 'bounce' | 'splash' | 'damage' | 'die' | 'shot' | 'airstrike' | 'teleport' | 'land' | 'jump';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  r?: number;
  kind?: string;
  wormId?: number;
  amount?: number;
  crater?: number;
};

export type Timeline = {
  frames: number;
  tracks: Track[];
  events: SimEvent[];
  before: { id: number; x: number; y: number; hp: number; alive: boolean }[];
};

export type ArtEvent =
  | { type: 'timeline'; tl: Timeline }
  | { type: 'walk'; wormId: number; x: number; y: number; facing: 1 | -1 }
  | { type: 'aim'; angle: number; power: number; weapon: WeaponId };

export type ArtAction =
  | { a: 'join' }
  | { a: 'leave' }
  | { a: 'settings'; wormsPerTeam?: number; turnSeconds?: number }
  | { a: 'start' }
  | { a: 'walk'; dir: 1 | -1 }
  | { a: 'jump' }
  | { a: 'aim'; angle: number; power: number; weapon: WeaponId }
  | { a: 'fire'; weapon: WeaponId; angle: number; power: number; tx?: number; ty?: number }
  | { a: 'surrender' }
  | { a: 'restart' };

export const TEAM_COLORS = ['#ff6b8b', '#5ad1ff', '#7cf29a', '#ffb547', '#c08bff', '#ff8a3d'];
