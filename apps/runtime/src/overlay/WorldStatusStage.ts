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
import type { WorldState } from '../state/WorldState.js';
import {
  PacketOrigin,
  type PacketContext,
  type PipelineStage,
} from '../pipeline/PacketPipeline.js';

/** What the overlay is told about. Kinds it does not know are ignored. */
export const WORLD_RECORD_KIND = 'world';

/** Four times a second: faster than reading, slower than the game ticks. */
export const MIN_INTERVAL_MS = 250;

export interface WorldStatusOptions {
  readonly publish: (record: string) => void;
  readonly now?: () => number;
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

  constructor(world: WorldState, options: WorldStatusOptions) {
    this.#world = world;
    this.#publish = options.publish;
    this.#now = options.now ?? (() => Date.now());
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

    const record = [
      WORLD_RECORD_KIND,
      Math.round(self.hp),
      Math.round(self.maxHp),
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
    ].join('|');

    if (record === this.#lastRecord) return;
    this.#lastRecord = record;
    this.#publish(record);
  }
}
