import type { EntityView, SessionView } from '@brownie/plugin-api';
import { EntityKind, isPetYard, type AntiLagPolicy } from './policy.js';

/**
 * Everything anti-lag remembers about one live connection.
 *
 * Three sets keyed by object id, all of them bounded by what is visible in the
 * current map and all of them dropped when it changes. **An object id is only
 * unique within a map**, so carrying one across a map change is not a stale
 * entry that costs memory — it is an entry that suppresses an unrelated object
 * which happens to reuse the id.
 *
 * Which is why the map is re-checked on the way in rather than on `MAPINFO`
 * alone: the plugin's handlers do not run while it is switched off, so a map
 * change during that time would otherwise never be noticed. {@link sync} is one
 * string comparison against a string the world state replaces per map, and it
 * is the first thing every handler does.
 */
export class SessionEntities {
  readonly #session: SessionView;
  readonly #isPetType: (objectType: number) => boolean;

  /** Ids stripped from the client's world — their tick statuses go too. */
  readonly #hidden = new Set<number>();
  /** Ids a size stat was injected for, so it is sent once and not every tick. */
  readonly #injected = new Set<number>();
  /** objectId → kind, for this map and this settings generation. */
  readonly #kinds = new Map<number, EntityKind>();

  #mapName = '';
  #generation = -1;
  #petYard = false;

  constructor(session: SessionView, isPetType: (objectType: number) => boolean) {
    this.#session = session;
    this.#isPetType = isPetType;
  }

  /**
   * Whether an id names something the world holds.
   *
   * A bound property rather than a method reference built per call: the layout
   * probes take it for every candidate of every effect packet while they are
   * learning, and a closure per packet is exactly the cost this feature exists
   * to remove.
   */
  readonly isLive = (objectId: number): boolean =>
    objectId > 0 &&
    (objectId === this.#session.self.objectId ||
      this.#session.world.entity(objectId) !== undefined);

  /** Nothing is hidden or resized in the Pet Yard, where pets are the point. */
  get inPetYard(): boolean {
    return this.#petYard;
  }

  /** Drops what belongs to a previous map, or to superseded settings. */
  sync(generation: number): void {
    const mapName = this.#session.world.mapName;
    if (mapName !== this.#mapName) {
      this.#mapName = mapName;
      this.#petYard = isPetYard(mapName);
      this.reset();
    }
    if (generation !== this.#generation) {
      this.#generation = generation;
      // Caches only. Objects already removed are gone from the client and stay
      // gone until the next map — nothing here can bring them back.
      this.#kinds.clear();
      this.#injected.clear();
    }
  }

  reset(): void {
    this.#hidden.clear();
    this.#injected.clear();
    this.#kinds.clear();
  }

  /** Forgets one object, so a later object reusing its id is judged afresh. */
  forget(objectId: number): void {
    this.#hidden.delete(objectId);
    this.#injected.delete(objectId);
    this.#kinds.delete(objectId);
  }

  get hasHidden(): boolean {
    return this.#hidden.size > 0;
  }

  isHidden(objectId: number): boolean {
    return this.#hidden.has(objectId);
  }

  hide(objectId: number): void {
    this.#hidden.add(objectId);
  }

  /** Forgets a removal, for an object the client is being told about again. */
  reveal(objectId: number): void {
    this.#hidden.delete(objectId);
  }

  /** True the first time an object needs a size stat the server never sent. */
  claimInjection(objectId: number): boolean {
    if (this.#injected.has(objectId)) return false;
    this.#injected.add(objectId);
    return true;
  }

  /**
   * Classifies an object, caching the answer for the map.
   *
   * @returns `undefined` while the answer is not yet knowable — before the
   *   server has said which object is ours, or for an id the world does not
   *   hold. Nothing is cached in that case, so the next packet decides instead
   *   of a guess being locked in for the rest of the map.
   */
  kindOf(policy: AntiLagPolicy, objectId: number): EntityKind | undefined {
    if (objectId <= 0) return undefined;

    const cached = this.#kinds.get(objectId);
    if (cached !== undefined) return cached;

    // Before CREATESUCCESS we cannot tell ourselves apart from anyone else.
    const selfId = this.#session.self.objectId;
    if (selfId <= 0) return undefined;
    if (objectId === selfId) {
      this.#kinds.set(objectId, EntityKind.Self);
      return EntityKind.Self;
    }

    // The state stage runs ahead of every plugin, so an object announced by the
    // packet being handled is already in the world.
    const entity = this.#session.world.entity(objectId);
    if (entity === undefined) return undefined;

    const kind = this.#classify(policy, entity, selfId);
    this.#kinds.set(objectId, kind);
    return kind;
  }

  #classify(policy: AntiLagPolicy, entity: EntityView, selfObjectId: number): EntityKind {
    if (entity.isPlayer) {
      if (!policy.exemptGuildmates) return EntityKind.Player;
      const theirs = entity.guildName;
      if (theirs === '') return EntityKind.Player;
      // Both names are the same stat from the same server, so exact equality is
      // the comparison — no case folding, and nothing allocated.
      const mine = this.#session.world.entity(selfObjectId)?.guildName ?? '';
      return theirs === mine ? EntityKind.Guildmate : EntityKind.Player;
    }
    return this.#isPetType(entity.objectType) ? EntityKind.Pet : EntityKind.Other;
  }
}
