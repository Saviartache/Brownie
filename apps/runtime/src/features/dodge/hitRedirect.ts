/**
 * The dodge of last resort: a hit that already landed, put on somebody else.
 *
 * `PLAYERHIT` is client→server — the client is the one that reports being hit,
 * naming the shot and its owner. Rewriting that report as `OTHERHIT` tells the
 * server the shot found a different player, and the damage follows the name.
 *
 * **Why not simply refuse the hit.** Dropping `PLAYERHIT` and sending nothing
 * leaves the shot unacknowledged, so the server keeps carrying it and hears
 * nothing about a bullet it saw arrive; `OTHERHIT` answers for the same shot,
 * which is the same conversation the client would have had if the shot had hit
 * the player standing next to us. Auto-nexus drops the acknowledgement outright
 * because it is *escaping in the same breath* — a hit going unanswered matters
 * much less when the character is leaving the map.
 *
 * Carried over from the reference implementation's `admin-autododge`, which is
 * where the packet pairing comes from. Nothing else in that file came with it:
 * its other switches drove a native dodge that does not exist here, or spoofed
 * an acknowledgement's position by a flat 500 tiles.
 *
 * **It is off by default and it is not free.** The damage lands on a real
 * player who did nothing to earn it. It also costs auto-nexus a little
 * accuracy: that feature reads the hit before this one and charges it against
 * its simulated health, so with both on the estimate runs low by the damage of
 * a redirected hit until the next tick's drift correction picks it back up.
 */

import { Verdict, type EntityView, type Position, type PluginContext } from '@brownie/plugin-api';

/** How far away a player can be and still be blamed for our hit. */
const DEFAULT_RADIUS_TILES = 4;
const MAX_RADIUS_TILES = 15;

/** Sixteen bits of bullet id, as the wire carries them. */
const BULLET_ID_MASK = 0xffff;

/**
 * The nearest other player within `radiusTiles`, or `undefined` when there is
 * nobody to blame.
 *
 * Compared as squared distances: this runs on a packet the player takes on the
 * chin in a bullet-hell, and a square root per candidate buys nothing when the
 * only question is which of them is closest.
 */
export function nearestOtherPlayer(
  from: Position,
  selfObjectId: number,
  players: Iterable<EntityView>,
  radiusTiles: number,
): number | undefined {
  let best = radiusTiles * radiusTiles;
  let bestId: number | undefined;

  for (const player of players) {
    if (player.objectId === selfObjectId) continue;
    const dx = player.x - from.x;
    const dy = player.y - from.y;
    const distance = dx * dx + dy * dy;
    if (distance > best) continue;
    best = distance;
    bestId = player.objectId;
  }

  return bestId;
}

/** Adds the redirect switch and its packet handler to a plugin's context. */
export function registerHitRedirect(context: PluginContext): void {
  const enabled = context.settings.boolean('redirectHits', {
    group: 'Hit redirect',
    label: 'Blame a nearby player for hits that land',
    default: false,
  });
  const radiusTiles = context.settings.range('redirectRadiusTiles', {
    group: 'Hit redirect',
    label: 'Look for one within (tiles)',
    default: DEFAULT_RADIUS_TILES,
    min: 1,
    max: MAX_RADIUS_TILES,
    step: 1,
    visibleWhen: { key: 'redirectHits', equals: [true] },
  });

  context.packets.on('PLAYERHIT', (packet, session) => {
    if (!enabled.get() || packet.opaque) return;

    // Auto-nexus runs ahead of every ordinary handler and refuses the hit when
    // it is about to be fatal, escaping in its place. Answering for the shot
    // now would put that hit back on the wire, which is the one outcome that
    // feature exists to prevent.
    if (packet.verdict === Verdict.Drop) return;

    const bulletId = packet.number('bulletId');
    const objectId = packet.number('objectId');
    if (bulletId === undefined || objectId === undefined) return;

    const self = session.self;
    // Negative until `CREATESUCCESS` names us, and every player would then
    // qualify as "not us" — including us.
    if (self.objectId < 0) return;

    const targetId = nearestOtherPlayer(
      self,
      self.objectId,
      session.world.players(),
      radiusTiles.get(),
    );
    if (targetId === undefined) return;

    packet.drop();

    // **The same sixteen bits, not the same number.** `PLAYERHIT` declares its
    // bullet id signed and `OTHERHIT` declares it unsigned, so an id past
    // 0x7fff arrives negative here and would be refused by the encoder on the
    // way out — a shot the server would never see answered for.
    session.sendToServer('OTHERHIT', {
      time: session.world.gameTimeMs,
      bulletId: bulletId & BULLET_ID_MASK,
      objectId,
      targetId,
    });
  });
}
