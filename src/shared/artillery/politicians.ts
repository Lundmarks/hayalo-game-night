// Worm names and the little bits of personality that go with them.
// Shared so the server can pick names and clients can show party pins and quips.

/** Admired statespeople from around the world and through history. */
export const ADMIRED = [
  'Lincoln', 'Churchill', 'Mandela', 'Gandhi', 'JFK', 'FDR', 'Obama', 'Merkel', 'Washington', 'Thatcher', 'Reagan',
  'de Gaulle', 'Zelensky', 'Ardern', 'Teddy', 'Bismarck', 'Kekkonen', 'Havel', 'Lula', 'Macron', 'Trudeau',
  'Gorbachev', 'Adenauer', 'Brandt', 'Nehru', 'Bolívar', 'Jefferson', 'Atatürk', 'Meir', 'Attlee', 'Sankara',
  'Lumumba', 'Carter', 'Kohl', 'Mitterrand', 'Sirleaf', 'Lee Kuan Yew',
];

/** Tyrants, crooks and other villains. All historical or long-notorious. */
export const INFAMOUS = [
  'Stalin', 'Mussolini', 'Pol Pot', 'Idi Amin', 'Kim Jong-un', 'Putin', 'Mao', 'Caligula', 'Nero', 'Gaddafi',
  'Saddam', 'Ceaușescu', 'Franco', 'Pinochet', 'Mugabe', 'Lukashenko', 'Nixon', 'Robespierre', 'Napoleon', 'Assad',
  'Honecker', 'Milošević', 'Mobutu', 'Bokassa', 'Hoxha', 'Marcos', 'Suharto', 'Somoza', 'Trujillo', 'Duvalier',
  'Beria', 'Kim Il-sung', 'Mengistu', 'Videla',
];

export type PartyId = 'S' | 'M' | 'SD' | 'C' | 'V' | 'KD' | 'L' | 'MP';

/** The eight parties in the Riksdag, with a pin colour and text colour for each. */
export const PARTIES: Record<PartyId, { name: string; color: string; text: string }> = {
  S: { name: 'Socialdemokraterna', color: '#e8112d', text: '#fff' },
  M: { name: 'Moderaterna', color: '#52bdec', text: '#fff' },
  SD: { name: 'Sverigedemokraterna', color: '#ffd500', text: '#1a3f8a' },
  C: { name: 'Centerpartiet', color: '#009933', text: '#fff' },
  V: { name: 'Vänsterpartiet', color: '#af0000', text: '#fff' },
  KD: { name: 'Kristdemokraterna', color: '#1a3f8a', text: '#fff' },
  L: { name: 'Liberalerna', color: '#006ab3', text: '#fff' },
  MP: { name: 'Miljöpartiet', color: '#83cf39', text: '#1d4d10' },
};

/** Swedish politicians, past and present, from every party in the Riksdag. */
export const SWEDISH: Record<string, PartyId> = {
  'M. Andersson': 'S', 'Löfven': 'S', 'Persson': 'S', 'Palme': 'S', 'Erlander': 'S', 'Per Albin': 'S', 'Sahlin': 'S',
  'Kristersson': 'M', 'Reinfeldt': 'M', 'Bildt': 'M', 'Kinberg Batra': 'M',
  'Åkesson': 'SD', 'Jomshof': 'SD',
  'Lööf': 'C', 'Fälldin': 'C', 'Demirok': 'C',
  'Dadgostar': 'V', 'Sjöstedt': 'V', 'Schyman': 'V', 'Ohly': 'V',
  'Busch': 'KD', 'Hägglund': 'KD', 'Alf Svensson': 'KD',
  'Pehrson': 'L', 'Björklund': 'L', 'Mohamsson': 'L',
  'Fridolin': 'MP', 'Lövin': 'MP', 'Helldén': 'MP', 'Stenevi': 'MP',
};

export const partyOf = (name: string) => (name in SWEDISH ? PARTIES[SWEDISH[name]] : null);

const shuffled = <T>(a: T[]) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Names for `teams` teams of `perTeam` worms, in worm-id order (team by team).
 * Each team rotates through admired, infamous and Swedish, starting at a
 * different one, so every team gets a mix.
 */
export function politicianNames(teams: number, perTeam: number) {
  const pools = [shuffled(ADMIRED), shuffled(INFAMOUS), shuffled(Object.keys(SWEDISH))];
  const used = [0, 0, 0];
  const out: string[] = [];
  for (let t = 0; t < teams; t++)
    for (let k = 0; k < perTeam; k++) {
      const p = (t + k) % 3;
      out.push(pools[p][used[p]++ % pools[p].length]);
    }
  return out;
}

// ---- speech bubbles ----

export const QUIPS = {
  turn: [
    'No comment!', 'Read my lips!', 'Trust me!', 'Vote for me!', 'I have a plan!', 'Four more years!', 'Let me be clear…',
    "It's the economy!", 'My fellow worms…', 'Promises kept!', 'Mandate!', 'Hold my ballot!', 'Order, order!',
  ],
  hurt: [
    'Fake news!', 'Scandal!', 'I demand a recount!', 'Point of order!', 'Unparliamentary!', 'My lawyer will hear of this!',
    'My approval rating!', 'Smear campaign!', 'No comment!', 'I was misquoted!', 'Leak!',
  ],
  fire: ['Bipartisan this!', 'Veto!', 'Executive order!', 'Motion carried!', 'Filibuster!'],
  pickupHealth: ['Free healthcare!', 'Feeling re-elected!', 'Bailout!'],
  pickupWeapon: ['Campaign funds!', 'Lobbyist gift!', 'Budget surplus!', 'Defense spending!'],
  // Swedish politicians get Swedish lines.
  svTurn: ['Nu jävlar!', 'Lagom är bäst!', 'Fika först!', 'Vi tar ansvar!', 'Det här ska utredas!', 'Jag vill vara tydlig…', 'Folkhemmet!'],
  svHurt: ['Misstroendevotum!', 'Ajaj!', 'Skandal!', 'Det här är inte okej!', 'Jag kräver en granskning!', 'Aj, KU-anmälan!'],
};
