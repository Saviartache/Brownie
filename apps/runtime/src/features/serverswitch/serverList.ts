import { isIPv4 } from 'node:net';

export interface GameServer {
  /** As the player knows it, e.g. `USSouth3`. */
  readonly name: string;
  /** IPv4 address of the game server. */
  readonly host: string;
}

/**
 * Where the game's servers are.
 *
 * Addresses rather than host names, because an address is what the game dials
 * and what the module's connect hook sees; a name would have to be resolved
 * somewhere, and the thing that decides where a session goes should not depend
 * on what a resolver happened to answer.
 *
 * **They go stale.** The reference implementation refreshed this list from the
 * game's API with the access token out of `HELLO`; that is its own piece of
 * work and this table is what `/con` has until it exists. A server that has
 * moved shows up as a connection that fails, not as one that goes somewhere
 * else — the address is only ever the one named here or one the player typed.
 */
export const GAME_SERVERS: readonly GameServer[] = Object.freeze([
  { name: 'EUEast', host: '18.184.218.174' },
  { name: 'EUSouthWest', host: '35.180.67.120' },
  { name: 'EUNorth', host: '18.159.133.120' },
  { name: 'EUWest', host: '15.237.60.223' },
  { name: 'EUWest2', host: '52.16.86.215' },
  { name: 'USEast', host: '54.234.226.24' },
  { name: 'USEast2', host: '54.209.152.223' },
  { name: 'USWest', host: '54.86.47.176' },
  { name: 'USWest3', host: '18.144.30.153' },
  { name: 'USWest4', host: '54.235.235.140' },
  { name: 'USMidWest', host: '18.221.120.59' },
  { name: 'USMidWest2', host: '3.140.254.133' },
  { name: 'USSouth', host: '3.82.126.16' },
  { name: 'USSouth3', host: '52.207.206.31' },
  { name: 'USSouthWest', host: '54.153.13.68' },
  { name: 'USNorthWest', host: '34.238.176.119' },
  { name: 'Asia', host: '3.0.147.127' },
  { name: 'Australia', host: '3.107.164.237' },
]);

export type ServerMatch =
  | { readonly kind: 'found'; readonly server: GameServer }
  /** Several servers answer to what was typed; the player has to say which. */
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] }
  | { readonly kind: 'unknown' };

/**
 * The short form of a name: its capitals and digits, e.g. `USSouth3` → `USS3`.
 *
 * It is how the servers are spoken about in game, and typing four characters
 * instead of eight is most of what makes `/con` worth having.
 */
function abbreviate(name: string): string {
  return name.replace(/[^A-Z0-9]/g, '');
}

const BY_NAME = new Map<string, GameServer>();
const BY_HOST = new Map<string, GameServer>();
/**
 * Every server an abbreviation could mean, not the first one found.
 *
 * `Asia` and `Australia` both shorten to `A`. The reference implementation
 * indexed the first and shadowed the second, so `/con a` quietly went to Asia;
 * keeping both makes it a question instead of a wrong answer.
 */
const BY_ABBREVIATION = new Map<string, GameServer[]>();

for (const server of GAME_SERVERS) {
  BY_NAME.set(server.name.toLowerCase(), server);
  BY_HOST.set(server.host, server);
  const short = abbreviate(server.name).toLowerCase();
  if (short === '') continue;
  const sharing = BY_ABBREVIATION.get(short);
  if (sharing === undefined) BY_ABBREVIATION.set(short, [server]);
  else sharing.push(server);
}

/** The server at an address, or `undefined` when this table has never heard of it. */
export function serverAt(host: string): GameServer | undefined {
  return BY_HOST.get(host);
}

/**
 * Works out which server the player meant.
 *
 * In order: an address as typed, then the full name, then the abbreviation,
 * then a name that starts with what was typed. Exactness first, so a name that
 * is also the prefix of a longer one — `USWest` against `USWest3` — reaches the
 * server it names rather than a list of both.
 */
export function findServer(query: string): ServerMatch {
  const typed = query.trim();
  if (typed === '') return { kind: 'unknown' };

  // An address names itself. The player may know where they want to go without
  // this table knowing what it is called.
  if (isIPv4(typed)) {
    return { kind: 'found', server: BY_HOST.get(typed) ?? { name: typed, host: typed } };
  }

  const key = typed.toLowerCase();
  const named = BY_NAME.get(key);
  if (named !== undefined) return { kind: 'found', server: named };

  const short = BY_ABBREVIATION.get(key);
  if (short !== undefined) return narrow(short);

  return narrow(GAME_SERVERS.filter((server) => server.name.toLowerCase().startsWith(key)));
}

function narrow(candidates: readonly GameServer[]): ServerMatch {
  const first = candidates[0];
  if (first === undefined) return { kind: 'unknown' };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', names: candidates.map((server) => server.name) };
  }
  return { kind: 'found', server: first };
}
