/**
 * How high each permanent stat can go on one character class.
 *
 * The game writes the ceiling as an attribute on the stat's own element —
 * `<Attack max="60">23</Attack>`, where the text is what a level-one character
 * starts with and the attribute is what eight-of-eight looks like. Only the
 * ceiling is kept: the starting value is derivable from the wire at any moment
 * and nothing here asks about it.
 *
 * This is what makes "would this potion be wasted?" answerable. Without it the
 * only alternative is to drink and find out, which on a capped character is a
 * potion thrown away every time a bag drops one.
 */

import { attribute, elementText, parseGameNumber, scanElementsIn } from './xml.js';

/** The ceiling for each of the six permanent stats on one class. */
export interface PermanentStatMaxima {
  readonly attack: number;
  readonly defense: number;
  readonly speed: number;
  readonly dexterity: number;
  /**
   * The ceiling the game writes as `<HpRegen>`.
   *
   * Vitality *is* health regeneration as far as the data file is concerned —
   * the file never uses the word — and the same holds for wisdom below. Reading
   * the element that shares the stat's name would find nothing and quietly
   * report no ceiling at all, which reads as "never capped".
   */
  readonly vitality: number;
  /** The ceiling the game writes as `<MpRegen>`. See {@link vitality}. */
  readonly wisdom: number;
}

/** `<Class>Player</Class>` — what marks an object as a playable class. */
const PLAYER_CLASS = 'Player';

/**
 * Reads a class's stat ceilings, or `undefined` if the object is not a class.
 *
 * A class missing one of the six is skipped entirely rather than reported with
 * a zero in its place: zero would read as "capped at nothing", and everything
 * asking would decide every potion is wasted.
 */
export function readPermanentStatMaxima(
  element: string,
  objectClass: string | undefined,
): PermanentStatMaxima | undefined {
  if (objectClass !== PLAYER_CLASS) return undefined;

  const attack = readCap(element, 'Attack');
  const defense = readCap(element, 'Defense');
  const speed = readCap(element, 'Speed');
  const dexterity = readCap(element, 'Dexterity');
  const vitality = readCap(element, 'HpRegen');
  const wisdom = readCap(element, 'MpRegen');
  if (
    attack === undefined ||
    defense === undefined ||
    speed === undefined ||
    dexterity === undefined ||
    vitality === undefined ||
    wisdom === undefined
  ) {
    return undefined;
  }
  return { attack, defense, speed, dexterity, vitality, wisdom };
}

/** The `max` attribute of `<Tag max="60">23</Tag>`. */
function readCap(element: string, tag: string): number | undefined {
  // The element, not the object: `max` appears on eight of them, so reading the
  // attribute off the whole object would answer with whichever came first.
  const [stat] = scanElementsIn(element, tag);
  if (stat === undefined) return undefined;
  // A stat written without a ceiling is one that cannot be raised past where it
  // starts, which its own text says.
  return parseGameNumber(attribute(stat, 'max')) ?? parseGameNumber(elementText(stat));
}
