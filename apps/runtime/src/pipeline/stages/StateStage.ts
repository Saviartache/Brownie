import type { MutablePacket } from '@brownie/plugin-api';
import { isBlastEffect, THROW_EFFECT } from '../../state/blasts/BlastStore.js';
import type { WorldState } from '../../state/WorldState.js';
import { readStats } from '../../state/stats.js';
import { PacketOrigin, type PacketContext, type PipelineStage } from '../PacketPipeline.js';

/** One packet's effect on the world. */
type Applier = (packet: MutablePacket, world: WorldState) => void;

/**
 * The packets below that the *client* sends.
 *
 * A short list, and it is short for a reason: the server is the authority on
 * almost everything. What the client is the authority on is where it has walked
 * to since the last tick, and which bullets it has decided hit something —
 * because bullet collision is the client's own call and these three packets are
 * it reporting one it has already acted on.
 */
const CLIENT_PACKETS: ReadonlySet<string> = new Set([
  'MOVE',
  'PLAYERHIT',
  'OTHERHIT',
  'SQUAREHIT',
  // Not state, but the two other packets the client stamps with its own clock —
  // which is a thing only the client knows and only its own packets carry. See
  // `WorldState.clientTimeMs`.
  'PLAYERSHOOT',
  'PONG',
]);

/**
 * Forgets a shot the client says has landed.
 *
 * The three acknowledgements name it the same way — the shooter and the bullet
 * — and differ only in what it hit, which is what decides whether the shot is
 * over. See {@link ProjectileStore.retire}.
 */
function retireShot(packet: MutablePacket, world: WorldState, obstacle: boolean): void {
  const bulletId = packet.number('bulletId');
  const ownerId = packet.number('objectId');
  if (bulletId === undefined || ownerId === undefined) return;
  world.projectileStore.retire(ownerId, bulletId, obstacle);
}

/**
 * Keeps the world model current.
 *
 * This runs **first** in the pipeline, before core handlers and before any
 * plugin. That ordering is the reason the pipeline exists: in the reference
 * implementation each state object registered its own packet hook, so whether a
 * plugin saw the world before or after this update depended on the order the
 * composition root happened to construct things in — and it changed the answer
 * to "how much health do I have" for anything reading it from a `NEWTICK`
 * handler.
 *
 * A packet with no entry here passes through untouched. That is not a gap: most
 * of the protocol is chat, trades and inventory, none of which the world model
 * describes.
 */
export class StateStage implements PipelineStage {
  readonly name = 'state';

  readonly #world: WorldState;
  readonly #appliers: ReadonlyMap<string, Applier>;

  constructor(world: WorldState) {
    this.#world = world;
    this.#appliers = buildAppliers();
  }

  handle(packet: MutablePacket, context: PacketContext): void {
    // An opaque packet has no fields to read. Its bytes still forward; there is
    // simply nothing here to learn from it.
    if (packet.opaque) return;

    const applier = this.#appliers.get(packet.name);
    if (applier === undefined) return;

    // Both directions are handled, and each applier knows which it wants. The
    // client's are the few where the client is the authority: where the player
    // actually is between ticks, and which bullets it has decided are spent.
    const wanted = CLIENT_PACKETS.has(packet.name) ? PacketOrigin.Client : PacketOrigin.Server;
    if (context.origin !== wanted) return;

    applier(packet, this.#world);
  }

  /** Diagnostics: which packets this stage reacts to at all. */
  get trackedPackets(): readonly string[] {
    return [...this.#appliers.keys()].sort();
  }
}

function buildAppliers(): ReadonlyMap<string, Applier> {
  return new Map<string, Applier>([
    [
      'MAPINFO',
      (packet, world) => {
        world.enterMap({
          name: packet.string('name') ?? '',
          displayName: packet.string('displayName') ?? '',
          width: packet.number('width') ?? 0,
          height: packet.number('height') ?? 0,
        });
      },
    ],
    [
      // The server naming which object is ours. Everything that reads "my
      // health" is meaningless until this arrives.
      'CREATESUCCESS',
      (packet, world) => {
        const objectId = packet.number('objectId');
        if (objectId !== undefined) world.self.bind(objectId);
      },
    ],
    [
      'UPDATE',
      (packet, world) => {
        for (const tile of asArray(packet.get('tiles'))) {
          const record = asRecord(tile);
          const x = numberOf(record, 'x');
          const y = numberOf(record, 'y');
          const type = numberOf(record, 'type');
          if (x === undefined || y === undefined || type === undefined) continue;
          world.tileMap.set(x, y, type);
        }

        for (const entry of asArray(packet.get('newObjs'))) {
          const record = asRecord(entry);
          const objectType = numberOf(record, 'objectType');
          const status = asRecord(record['status']);
          const objectId = numberOf(status, 'objectId');
          if (objectType === undefined || objectId === undefined) continue;

          const position = asRecord(status['position']);
          const x = numberOf(position, 'x') ?? 0;
          const y = numberOf(position, 'y') ?? 0;
          const stats = readStats(status['data']);

          const entity = world.entityStore.upsert(objectId, objectType, x, y);
          entity.applyStats(stats);
          if (objectId === world.self.objectId) {
            // The only statement of which class we are: `CREATESUCCESS` names
            // the object, and this is the object.
            world.self.bindClass(objectType);
            world.self.moveTo(x, y);
            world.self.applyStats(stats);
          }
        }

        // `drops` is a list of object ids that left view or died. An id we do
        // not hold is not an error: it may have been dropped already, or never
        // have been in view.
        for (const dropped of asArray(packet.get('drops'))) {
          if (typeof dropped === 'number') world.entityStore.remove(dropped);
        }
      },
    ],
    [
      'NEWTICK',
      (packet, world) => {
        for (const entry of asArray(packet.get('statuses'))) {
          const status = asRecord(entry);
          const objectId = numberOf(status, 'objectId');
          if (objectId === undefined) continue;

          const position = asRecord(status['position']);
          const x = numberOf(position, 'x');
          const y = numberOf(position, 'y');
          const stats = readStats(status['data']);

          if (objectId === world.self.objectId) {
            if (x !== undefined && y !== undefined) world.self.moveTo(x, y);
            world.self.applyStats(stats);
          }

          // A tick can carry a status for an object we have never seen an
          // `UPDATE` for. Ignoring it rather than inventing an entity keeps the
          // store to objects whose type we actually know.
          const entity = world.entityStore.get(objectId);
          if (entity === undefined) continue;
          if (x !== undefined && y !== undefined) entity.moveTo(x, y);
          entity.applyStats(stats);
        }
      },
    ],
    [
      'GOTO',
      (packet, world) => {
        const objectId = packet.number('objectId');
        const position = asRecord(packet.get('position'));
        const x = numberOf(position, 'x');
        const y = numberOf(position, 'y');
        if (objectId === undefined || x === undefined || y === undefined) return;

        if (objectId === world.self.objectId) world.self.moveTo(x, y);
        world.entityStore.get(objectId)?.moveTo(x, y);
      },
    ],
    [
      // The server announcing a shot. It is mentioned once and never again, so
      // this is the only chance to record where it started and when.
      'ENEMYSHOOT',
      (packet, world) => {
        const ownerId = packet.number('ownerId');
        const bulletId = packet.number('bulletId');
        const bulletType = packet.number('bulletType');
        const angle = packet.number('angle');
        const position = asRecord(packet.get('position'));
        const x = numberOf(position, 'x');
        const y = numberOf(position, 'y');
        if (
          ownerId === undefined ||
          bulletId === undefined ||
          bulletType === undefined ||
          angle === undefined ||
          x === undefined ||
          y === undefined
        ) {
          return;
        }

        world.shots.announced += 1;

        // Which shot this is depends on what fired it: `bulletType` is an index
        // within the owner's own list, not a global id.
        const owner = world.entityStore.get(ownerId);
        if (owner === undefined) {
          world.shots.noOwner += 1;
          return;
        }
        const definition = world.objects.projectile(owner.objectType, bulletType);
        if (definition === undefined) {
          // Counted, not merely refused. With no game data, or a monster the
          // catalog does not describe, every shot lands here — and a dodge with
          // nothing in flight to avoid looks broken rather than starved.
          world.shots.noDefinition += 1;
          return;
        }
        const firedAtMs = world.gameTimeMs;

        // A volley arrives as one packet: consecutive bullet ids fanned out by
        // a fixed angle step. Recording only the first would leave the rest
        // invisible, which is precisely the case a dodge exists for.
        const shots = packet.number('numShots') ?? 1;
        const angleStep = packet.number('angleInc') ?? 0;
        const count = shots > 0 && shots < 128 ? shots : 1;
        for (let i = 0; i < count; i++) {
          if (
            world.projectileStore.add(definition, {
              ownerId,
              bulletId: bulletId + i,
              bulletType,
              x,
              y,
              angle: angle + angleStep * i,
              firedAtMs,
            })
          ) {
            world.shots.tracked += 1;
          }
        }
      },
    ],
    [
      // A shot that landed on us. **The client destroyed it before saying so**,
      // so this is not news about damage — it is news that a bullet the store
      // is still carrying no longer exists. Without it every shot lives out its
      // declared lifetime in the model and the dodge keeps avoiding bullets
      // that hit something a second ago.
      'PLAYERHIT',
      (packet, world) => {
        retireShot(packet, world, false);
      },
    ],
    [
      // The same, for one that landed on somebody else.
      'OTHERHIT',
      (packet, world) => {
        retireShot(packet, world, false);
      },
    ],
    [
      // And for one that hit the map. A different question, because a shot that
      // passes through people is not the same shot as one that passes through
      // walls.
      'SQUAREHIT',
      (packet, world) => {
        retireShot(packet, world, true);
      },
    ],
    [
      // The client's own movement. Between ticks this is the only statement of
      // where the player is, and it is the one auto-nexus and dodge read.
      'MOVE',
      (packet, world) => {
        const records = asArray(packet.get('records'));
        // A LocationRecord is flat — `{ time, x, y }`, not a nested Location.
        const last = records.at(-1);
        if (last === undefined) return;
        const record = asRecord(last);
        // Each record is stamped with the client's own clock, which is the one
        // the server checks a `time` field against.
        const time = numberOf(record, 'time');
        if (time !== undefined) world.calibrateClientClock(time);
        const x = numberOf(record, 'x');
        const y = numberOf(record, 'y');
        if (x !== undefined && y !== undefined) world.self.moveTo(x, y);
      },
    ],
    [
      // The client's answer to a ping, and the earliest thing it stamps — it
      // goes out before the character is even in the world.
      'PONG',
      (packet, world) => {
        const time = packet.number('time');
        if (time !== undefined) world.calibrateClientClock(time);
      },
    ],
    [
      // And its own shots, for a session that is standing still and shooting.
      'PLAYERSHOOT',
      (packet, world) => {
        const time = packet.number('time');
        if (time !== undefined) world.calibrateClientClock(time);
      },
    ],
    [
      // **The dodgeable half of an area effect.** A bomb leaving a monster's
      // hand, a nova winding up, a circle drawn on the ground — announced with
      // where it will land and how long it takes to get there, which is most of
      // a second of warning. Everything else this packet carries is decoration.
      'SHOWEFFECT',
      (packet, world) => {
        const effectType = packet.number('effectType');
        if (effectType === undefined || !isBlastEffect(effectType)) return;

        // A throw lands where it is aimed; everything else goes off where it
        // was announced. The reference implementation drew the same line.
        const source = pointOf(packet.get('position'));
        const target = pointOf(packet.get('targetPosition'));
        const at = effectType === THROW_EFFECT ? (target ?? source) : source;
        if (at === undefined) return;

        // The field is a float and the game is inconsistent about its unit, so
        // it is read the way the reference implementation read it: small
        // numbers are seconds, large ones are already milliseconds.
        const duration = packet.number('duration') ?? 0;
        const armsInMs = duration > 0 && duration <= 120 ? duration * 1000 : duration;
        world.blastStore.announce(world.gameTimeMs, at.x, at.y, armsInMs);
      },
    ],
    [
      // The detonation itself, which is far too late to walk out of — the
      // client answers it with an `AOEACK` saying where the player was. Kept
      // because it is the only thing that can confirm a telegraph was read
      // correctly, and because it carries the radius the telegraph never does.
      'AOE',
      (packet, world) => {
        const at = pointOf(packet.get('position'));
        if (at === undefined) return;
        world.blastStore.landed(world.gameTimeMs, at.x, at.y, packet.number('radius') ?? 0);
      },
    ],
  ]);
}

/** A `Location` from the wire, when it is one. */
function pointOf(value: unknown): { x: number; y: number } | undefined {
  const record = asRecord(value);
  const x = numberOf(record, 'x');
  const y = numberOf(record, 'y');
  return x === undefined || y === undefined ? undefined : { x, y };
}

// Packet fields are data we were handed, so every read is a check. These
// helpers exist so that is one line at each use rather than four.

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberOf(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}
