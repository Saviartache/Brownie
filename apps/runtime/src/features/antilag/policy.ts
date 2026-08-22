/**
 * What anti-lag does to the stream, resolved from its settings once.
 *
 * **Settings are read when they change, never per packet.** `UPDATE` carries
 * every object entering view and `NEWTICK` carries a status for every object
 * already in it, so anything done per entity is done a few hundred times a
 * tick. The reference implementation built a configuration object inside each
 * of those handlers — nine setting lookups, a `toLowerCase()` on the map name
 * and an allocation, per packet — to answer questions whose answers only change
 * when somebody moves a slider.
 *
 * What arrives here is a plain snapshot; what leaves is a table the packet path
 * indexes by entity kind, plus the gates that let a handler decide it has
 * nothing to do before it touches the packet at all.
 */

/** What happens to other players. Values are persisted in config — don't rename. */
export const PlayerMode = {
  Off: 'off',
  /** Size 0: the object still exists client-side, but draws nothing. */
  Invisible: 'invisible',
  /** Never handed to the client: no sprite, no nameplate, no per-frame work. */
  Remove: 'remove',
} as const;

export type PlayerMode = (typeof PlayerMode)[keyof typeof PlayerMode];

/** What happens to pets. `ally_first` keeps your own — see {@link isOwnPet}. */
export const PetMode = {
  Off: 'off',
  AllyFirst: 'ally_first',
  All: 'all',
  Remove: 'remove',
} as const;

export type PetMode = (typeof PetMode)[keyof typeof PetMode];

/** What happens to effects a teammate causes. */
export const AllyEffectMode = {
  Off: 'off',
  /** Heals, auras and buff flashes — the ones a support group sprays. */
  Support: 'support',
  All: 'all',
} as const;

export type AllyEffectMode = (typeof AllyEffectMode)[keyof typeof AllyEffectMode];

/**
 * How anti-lag classifies an object.
 *
 * Numbers rather than strings: this is the key of a per-object cache read for
 * every status of every tick, and it indexes the tables below directly.
 */
export const EntityKind = {
  Other: 0,
  Self: 1,
  Player: 2,
  Guildmate: 3,
  Pet: 4,
} as const;

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

const KIND_COUNT = 5;

/** The size the client assumes when stat 2 is absent from a status. */
export const DEFAULT_SIZE = 100;
export const MIN_SIZE_PERCENT = 0;
export const MAX_SIZE_PERCENT = 200;

/** A percentage meaning "leave whatever the server sent alone". */
const UNCHANGED = 100;

/** The settings, read once per change and turned into a {@link AntiLagPolicy}. */
export interface AntiLagSettings {
  readonly playerMode: PlayerMode;
  readonly petMode: PetMode;
  readonly exemptGuildmates: boolean;
  readonly scaleSizes: boolean;
  readonly selfPercent: number;
  readonly otherPercent: number;
  readonly dropAllyShots: boolean;
  readonly allyEffects: AllyEffectMode;
  readonly hideAllyNotifications: boolean;
  /** 256 flags: effect types blocked for everyone, or `undefined` for none. */
  readonly blockedEffects: Uint8Array | undefined;
}

/** The resolved answer to every question a packet handler asks. */
export interface AntiLagPolicy {
  /** Wanted size, as a percentage of what the server sent, by entity kind. */
  readonly sizePercent: Int16Array;
  /** Pets are split: `ally_first` keeps your own at your own percentage. */
  readonly ownPetSizePercent: number;
  /** 1 where the kind is stripped from the stream rather than resized. */
  readonly removable: Uint8Array;
  readonly exemptGuildmates: boolean;
  readonly allyEffects: AllyEffectMode;
  readonly blockedEffects: Uint8Array | undefined;
  readonly hideAllyNotifications: boolean;

  // Gates. Each one is the cheapest reason for a handler to do nothing.
  readonly rewritesEntities: boolean;
  readonly dropsAllyShots: boolean;
  readonly filtersEffects: boolean;
  readonly filtersNotifications: boolean;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return UNCHANGED;
  return Math.min(MAX_SIZE_PERCENT, Math.max(MIN_SIZE_PERCENT, Math.trunc(value)));
}

export function resolvePolicy(settings: AntiLagSettings): AntiLagPolicy {
  const self = settings.scaleSizes ? clampPercent(settings.selfPercent) : UNCHANGED;
  const other = settings.scaleSizes ? clampPercent(settings.otherPercent) : UNCHANGED;

  const sizePercent = new Int16Array(KIND_COUNT).fill(UNCHANGED);
  sizePercent[EntityKind.Self] = self;
  sizePercent[EntityKind.Player] = settings.playerMode === PlayerMode.Off ? other : 0;
  sizePercent[EntityKind.Pet] = petPercent(settings.petMode, other);
  // Exempt guildmates keep the server's size — hiding and scaling alike.

  const removable = new Uint8Array(KIND_COUNT);
  removable[EntityKind.Player] = settings.playerMode === PlayerMode.Remove ? 1 : 0;
  removable[EntityKind.Pet] = settings.petMode === PetMode.Remove ? 1 : 0;

  const resizes = sizePercent.some((percent) => percent !== UNCHANGED);
  const removes = removable.some((flag) => flag === 1);

  return {
    sizePercent,
    ownPetSizePercent:
      settings.petMode === PetMode.AllyFirst ? self : petPercent(settings.petMode, other),
    removable,
    exemptGuildmates: settings.exemptGuildmates,
    allyEffects: settings.allyEffects,
    blockedEffects: settings.blockedEffects,
    hideAllyNotifications: settings.hideAllyNotifications,
    rewritesEntities: resizes || removes,
    // Invisible shooters firing visible bullets is never what anyone wanted,
    // and in "remove" mode the owner object does not exist client-side at all.
    dropsAllyShots: settings.dropAllyShots || sizePercent[EntityKind.Player] === 0,
    filtersEffects:
      settings.blockedEffects !== undefined || settings.allyEffects !== AllyEffectMode.Off,
    filtersNotifications: settings.hideAllyNotifications,
  };
}

/** The same settings with every entity lever off — see the Pet Yard. */
export function withoutEntityLevers(settings: AntiLagSettings): AntiLagSettings {
  return { ...settings, playerMode: PlayerMode.Off, petMode: PetMode.Off, scaleSizes: false };
}

export function sizePercentFor(policy: AntiLagPolicy, kind: EntityKind, ownPet: boolean): number {
  if (kind === EntityKind.Pet && ownPet) return policy.ownPetSizePercent;
  return policy.sizePercent[kind] ?? UNCHANGED;
}

/** True when the object is dropped from the stream entirely rather than resized. */
export function isRemovable(policy: AntiLagPolicy, kind: EntityKind): boolean {
  return policy.removable[kind] === 1;
}

/**
 * The size to send for `kind`, given what the server asked for.
 *
 * Returning `serverSize` unchanged means "leave this entity alone", which is
 * what the caller tests to decide whether the packet needs rewriting at all.
 */
export function targetSize(
  policy: AntiLagPolicy,
  kind: EntityKind,
  ownPet: boolean,
  serverSize: number,
): number {
  const percent = sizePercentFor(policy, kind, ownPet);
  if (percent === UNCHANGED) return serverSize;
  if (percent === 0) return 0;
  return Math.max(0, Math.floor((serverSize * percent) / 100));
}

/**
 * Whether an object is the player's own pet.
 *
 * The server gives a pet the id after its owner's. That is a heuristic, not a
 * guarantee, and it is the same one the reference implementation used — the
 * wire carries no ownership field for a pet on the ground.
 */
export function isOwnPet(objectId: number, selfObjectId: number): boolean {
  return selfObjectId > 0 && objectId === selfObjectId + 1;
}

/** The Pet Yard is where you go to look at pets, so nothing is hidden there. */
export function isPetYard(mapName: string): boolean {
  return mapName.toLowerCase().includes('pet yard');
}

function petPercent(mode: PetMode, otherPercent: number): number {
  switch (mode) {
    case PetMode.Off:
      return otherPercent;
    case PetMode.AllyFirst:
    case PetMode.All:
    case PetMode.Remove:
      return 0;
  }
}
