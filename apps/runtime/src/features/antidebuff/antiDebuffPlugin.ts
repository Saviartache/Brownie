/**
 * Anti-debuffs: stops the game client *drawing* condition effects that are only
 * ever a nuisance on screen.
 *
 * The condition bits in the player's own `NEWTICK` status are masked on the way
 * to the client. **The server still holds the effect and still expires it on
 * its own schedule** — only the rendering changes. That is the whole of what
 * this does, and it is deliberately less than the reference implementation
 * claimed.
 *
 * ## What was removed, and why it is not coming back by accident
 *
 * The reference also *refused* the packets by which the client admits something
 * landed — `PLAYERHIT`, and as this port later added, `AOEACK` and
 * `GROUNDDAMAGE` — on the premise that a server told nothing happened applies
 * no effect. Against the running game, refusal demonstrably **worked as code**:
 * hits carrying Silenced were identified from `objects.xml`, matched to their
 * announcement and dropped, three of them inside a minute. The effect went on
 * appearing on the character anyway.
 *
 * Which of two things that means was never established, and the measurement
 * that would settle it does not exist yet: Silenced lives in the *second*
 * condition stat, and {@link SelfState} carries only the first, so nothing here
 * could see whether a refused hit still applied its effect. Either this build's
 * server applies conditions from its own simulation rather than from the
 * client's word, or something else delivered them.
 *
 * Either way the switches promised something they did not deliver — and they
 * were not free: a refused hit is one the server never subtracts health for, a
 * much larger claim to be making quietly. A switch that lies is worse than a
 * switch that is missing, so they are gone rather than left on with a caveat.
 *
 * Two things are worth keeping from that work if it is picked up again. Some
 * conditions arrive with **nothing for the client to acknowledge at all** — a
 * live session caught `Stunned` landing with no shot announced, no hit, no
 * blast and no ground, which is the game's own server-side aura behaviour and
 * is not refusable by any packet. And what a shot applies has to be read at its
 * *announcement*: the world model drops a shot when its flight ends, and a hit
 * acknowledging it arrives after that by definition.
 */

import { PluginCategory, definePlugin, type Plugin, type SettingHandle } from '@brownie/plugin-api';
import type { FieldValue } from '@brownie/protocol';
import { NO_CONDITIONS, type ConditionMask } from '../../constants/ConditionEffect.js';
import { StatType } from '../../constants/StatType.js';
import { SCREEN_EFFECTS, maskOf, type DebuffOption } from './debuffs.js';

export function createAntiDebuffPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'anti-debuffs',
      name: 'Anti-Debuffs',
      // Purely a rewrite of what the client renders, which is where the overlay
      // files anti-lag too. Nothing here reaches the server or changes what it
      // believes.
      category: PluginCategory.Visuals,
      description: 'Stops the client drawing condition effects that only get in the way.',
    },

    setup(context) {
      const switches: readonly { option: DebuffOption; handle: SettingHandle<boolean> }[] =
        SCREEN_EFFECTS.map((option) => ({
          option,
          handle: context.settings.boolean(option.key, {
            group: 'On-screen effects',
            label: `Ignore ${option.label}`,
            default: true,
          }),
        }));

      // Folded when a switch moves, not per packet: the set of bits to clear
      // only changes when somebody changes it, and a tick is not the place to
      // rediscover that.
      let screen: ConditionMask = NO_CONDITIONS;
      const refresh = (): void => {
        const on: DebuffOption[] = [];
        for (const { option, handle } of switches) {
          if (handle.get()) on.push(option);
        }
        screen = maskOf(on);
      };

      refresh();
      for (const { handle } of switches) context.onDispose(handle.onChange(refresh));

      // Stateless: there is nothing to remember between ticks, so there is no
      // per-session record here and nothing to clean up when one ends.
      context.packets.on('NEWTICK', (packet, session) => {
        if (screen.low === 0 && screen.high === 0) return;
        if (packet.opaque) return;

        // Negative until `CREATESUCCESS` names us — the state layer's "no
        // player yet", and not a value any status carries.
        const selfObjectId = session.self.objectId;
        if (selfObjectId < 0) return;

        const statuses = packet.get('statuses');
        if (!Array.isArray(statuses)) return;

        // A tick only carries stats that changed, so our status is often absent
        // — and then there is nothing to do: the client is still holding the
        // value this already cleaned.
        if (!clearOwnStatus(statuses, selfObjectId, screen.low, screen.high)) return;

        // Editing in place tells the pipeline nothing. Setting the field is
        // what marks the packet for re-encoding.
        packet.set('statuses', statuses);
      });
    },
  });
}

/**
 * A decoded `Status` and its stats, as things this module has decided it may
 * edit.
 *
 * Decoded field values are described as deeply readonly because *reading* a
 * packet should not imply the right to rewrite it. Rewriting is exactly what
 * this does, in place, so that a tick that changed one number is not rebuilt.
 */
interface MutableStatus {
  objectId?: FieldValue;
  data?: FieldValue;
}

interface MutableStat {
  id?: FieldValue;
  value?: FieldValue;
}

/**
 * Clears bits from the player's own status.
 *
 * @returns whether anything actually changed — a packet that would re-encode to
 *   the bytes it arrived as should forward as those bytes instead.
 */
function clearOwnStatus(
  statuses: readonly FieldValue[],
  selfObjectId: number,
  clearLow: number,
  clearHigh: number,
): boolean {
  for (const entry of statuses) {
    if (typeof entry !== 'object' || Array.isArray(entry)) continue;
    const status = entry as unknown as MutableStatus;
    if (status.objectId !== selfObjectId) continue;

    // One status per object per tick, so this is the only one there is.
    const data = status.data;
    if (!Array.isArray(data)) return false;
    return clearStats(data as readonly MutableStat[], clearLow, clearHigh);
  }
  return false;
}

function clearStats(stats: readonly MutableStat[], clearLow: number, clearHigh: number): boolean {
  let changed = false;
  for (const stat of stats) {
    let mask = 0;
    if (stat.id === StatType.Effects) mask = clearLow;
    else if (stat.id === StatType.Effects2) mask = clearHigh;
    if (mask === 0) continue;

    const value = stat.value;
    if (typeof value !== 'number') continue;
    const cleared = value & ~mask;
    if (cleared === value) continue;
    stat.value = cleared;
    changed = true;
  }
  return changed;
}
