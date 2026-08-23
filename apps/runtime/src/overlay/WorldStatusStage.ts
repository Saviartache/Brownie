/**
 * The world model, sent to the overlay to draw.
 *
 * Everything upstream of this already worked — packets decode, the state stage
 * keeps a world model current, the module draws an overlay — and none of it was
 * visible, because nothing carried the model across. This is that carry.
 *
 * **Numbers only, and integers at that.** Records are `|`-separated and
 * percent-encoded so that arbitrary text survives the trip; a record of nothing
 * but integers needs neither, which keeps the native side a split and a parse
 * rather than a decoder. Positions are sent as hundredths so they stay whole
 * without losing anything the eye can see.
 *
 * Published on the server's own tick rather than on a timer of ours, so what is
 * drawn is a state the server actually described — but no faster than
 * {@link MIN_INTERVAL_MS}, because a busy realm ticks faster than anyone can
 * read and every record is a write on the pipe.
 */

import type { MutablePacket } from '@brownie/plugin-api';
import { buildRecord } from '@brownie/ipc';
import type { WeaponShot } from '../gamedata/EquippedWeapon.js';
import type { WorldState } from '../state/WorldState.js';
import {
  PacketOrigin,
  type PacketContext,
  type PipelineStage,
} from '../pipeline/PacketPipeline.js';

/** What the overlay is told about. Kinds it does not know are ignored. */
export const WORLD_RECORD_KIND = 'world';

/**
 * The equipped weapon, as the overlay shows it.
 *
 * **A separate record because it carries a name.** The world record is integers
 * only, which is what lets the module read it with a split and a parse; the one
 * text field in this feature would have cost that whole property. It also
 * changes on a different clock — once when the player swaps an item, against
 * four times a second — so sending it alongside would be a name repeated a
 * quarter of a million times an hour.
 */
export const WEAPON_RECORD_KIND = 'weapon';

/** Four times a second: faster than reading, slower than the game ticks. */
export const MIN_INTERVAL_MS = 250;

export interface WorldStatusOptions {
  readonly publish: (record: string) => void;
  readonly now?: () => number;
  /**
   * What the game's data says about the item in the weapon slot.
   *
   * **Shown, never used.** The dodge planner takes a weapon's reach as the
   * distance it tries not to drift past, and that number is read out of a 35 MB
   * file nobody looks at — so it is worth being able to see, beside the name of
   * the weapon it was read for. Omitted when nothing is wired up, and the row
   * simply does not appear.
   */
  readonly weapon?: (objectType: number) => WeaponShot | undefined;
}

export class WorldStatusStage implements PipelineStage {
  readonly name = 'world-status';

  readonly #world: WorldState;
  readonly #publish: (record: string) => void;
  readonly #now: () => number;
  #lastAt = 0;
  /**
   * The last record sent, so an identical one is not sent again.
   *
   * The module's picture is a function of the records it has been given, so a
   * record that says what the last one said changes nothing — and it is not
   * free: it is a write on the pipe, a parse, and a rebuild and republication
   * of the model the overlay draws from. A character standing still in a quiet
   * map would pay that four times a second to say nothing.
   */
  #lastRecord = '';
  /** The same, for the weapon record, which changes far less often still. */
  #lastWeaponRecord = '';

  readonly #weapon: ((objectType: number) => WeaponShot | undefined) | undefined;

  constructor(world: WorldState, options: WorldStatusOptions) {
    this.#world = world;
    this.#publish = options.publish;
    this.#now = options.now ?? (() => Date.now());
    this.#weapon = options.weapon;
  }

  handle(packet: MutablePacket, context: PacketContext): void {
    if (context.origin !== PacketOrigin.Server || packet.name !== 'NEWTICK') return;

    const at = this.#now();
    if (at - this.#lastAt < MIN_INTERVAL_MS) return;
    this.#lastAt = at;

    const self = this.#world.self;
    // Expired shots dropped exactly as a read would drop them, so the count on
    // screen is the count a planner would see — and counted rather than listed,
    // because a list built to be measured and thrown away is a list of every
    // shot in the realm, four times a second.
    this.#world.projectileStore.prune(this.#world.gameTimeMs);
    const shots = this.#world.projectileStore.size;
    this.#world.blastStore.prune(this.#world.gameTimeMs);
    const blasts = this.#world.blastStore.size;

    const record = [
      WORLD_RECORD_KIND,
      Math.round(self.hp),
      // The base, not `maxHp`. The module reads the client's own stat block and
      // finds it by looking for the health the server stated — so what travels
      // has to be a number the client holds. `maxHp` is the base plus a bonus,
      // added up here and stored nowhere, and sending it left the search with
      // nothing to match: the stats went unread on any character wearing gear.
      Math.round(self.maxHpBase),
      Math.round(self.x * 100),
      Math.round(self.y * 100),
      this.#world.entityStore.size,
      shots,
      // Appended, and carried for one reason: the module reads defence out of
      // the game's own memory and has nothing to check that reading against.
      // Health proved where the stat block was moved to; this proves that the
      // field beside it is the one it is taken for.
      Math.round(self.defense),
      // Why announced shots did not become tracked ones. A dodge with nothing
      // in flight to avoid looks exactly like a broken dodge, and these three
      // numbers are the difference.
      this.#world.shots.announced,
      this.#world.shots.noOwner,
      this.#world.shots.noDefinition,
      // **The telegraph decode checking its own homework.** Where a thrown bomb
      // will land is read from a `SHOWEFFECT` body whose layout was recovered
      // from the game's own metadata rather than stated by it, so the only
      // honest confirmation is the detonation that follows: a prediction the
      // `AOE` lands on is one the decode got right. A patch that moves the
      // layout shows up here as confirmations stopping and unmatched climbing,
      // instead of as a dodge that quietly stopped avoiding bombs.
      blasts,
      this.#world.blastStore.confirmed,
      this.#world.blastStore.unmatched,
    ].join('|');

    this.#sayWeapon(self.weaponType);

    if (record === this.#lastRecord) return;
    this.#lastRecord = record;
    this.#publish(record);
  }

  /**
   * Describes the equipped weapon, when there is anything new to say.
   *
   * A weapon the catalog does not describe is still reported, with its type and
   * nothing else: "the data files do not have this item" and "the range is
   * wrong" look the same from the outside, and this is what tells them apart.
   */
  #sayWeapon(objectType: number): void {
    if (this.#weapon === undefined) return;

    const shot = objectType < 0 ? undefined : this.#weapon(objectType);
    const record = buildRecord(
      WEAPON_RECORD_KIND,
      shot?.name ?? '',
      objectType,
      // Tiles a second in hundredths, like every other distance on this wire.
      Math.round((shot?.speedTilesPerMs ?? 0) * 1000 * 100),
      Math.round(shot?.lifetimeMs ?? 0),
      Math.round((shot?.reachTiles ?? 0) * 100),
    );
    if (record === this.#lastWeaponRecord) return;
    this.#lastWeaponRecord = record;
    this.#publish(record);
  }
}
